import type {
  Advice, AppMode, CapabilityName, Catalog, DecisionKey, DraftState, ItemInstance,
  MatchState, Observation, PlayerState, PurchasedItemHistoryEntry, SourceState, TelemetryEvent,
} from '../shared/types';
import { parseTelemetryEvent } from './validation';

/** A true-age upper bound, including clock uncertainty or documented delivery delay. */
export const MAX_SOURCE_AGE_MS = 1_000;
const HISTORY_LIMIT = 48;
const REQUIRED_CAPABILITIES: CapabilityName[] = [
  'participant_match', 'street_brawl_round', 'own_draft_offers', 'offer_modifiers',
  'own_reroll_state', 'current_inventories', 'ability_investment', 'source_continuity',
];
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const synthetic = (provider: string) => /(^|[\s_:-])(synthetic|demo)([\s_:-]|$)/i.test(provider);
const session = (value: { sessionId?: string | null }) => value.sessionId ?? null;
const decisionRevision = (state: MatchState) => state.decisionRevision ?? state.revision;

export function createInitialState(mode: AppMode = 'live'): MatchState {
  return {
    mode,
    source: {
      sessionId: null,
      provider: 'unavailable',
      status: 'unavailable', runtimeVersion: null, capabilities: [], noImageMethodVerified: false,
      sequence: null, lastReceivedAt: null, deliveryBoundMs: null, continuity: 'unknown',
      message: 'Automatic participant telemetry has not been verified.',
    },
    match: null, players: [], draft: null, rosterCompleteness: 'unknown',
    retiredMatchIds: [], retiredSourceSessionIds: [], closedDrafts: [], revision: 0, decisionRevision: 0, advice: null,
    transitions: [], counters: { accepted: 0, rejected: 0, invalidated: 0 },
  };
}

function reject(state: MatchState): MatchState {
  return { ...state, counters: { ...state.counters, rejected: state.counters.rejected + 1 } };
}

function finish(previous: MatchState, next: MatchState, changed: boolean, label: string, at: number): MatchState {
  return {
    ...next,
    revision: previous.revision + 1,
    decisionRevision: decisionRevision(previous) + (changed ? 1 : 0),
    advice: changed ? null : next.advice,
    counters: {
      ...previous.counters, accepted: previous.counters.accepted + 1,
      invalidated: previous.counters.invalidated + (changed && previous.advice !== null ? 1 : 0),
    },
    transitions: label ? [...previous.transitions, { label, at }].slice(-HISTORY_LIMIT) : previous.transitions,
  };
}

function provenanceMatches(source: SourceState, observation: Observation | null | undefined): observation is Observation {
  return observation != null && observation.provider === source.provider && session(observation) === session(source);
}

/** Return a conservative upper bound, never merely the time since a packet arrived. */
function ageBound(source: SourceState, observation: Observation, now: number): number | null {
  const origin = observation.confirmedAt ?? observation.observedAt;
  if (origin !== null && observation.clockUncertaintyMs !== null) {
    if (origin - observation.clockUncertaintyMs > now || observation.receivedAt > now) return null;
    return Math.max(0, now - origin + observation.clockUncertaintyMs);
  }
  if (source.deliveryBoundMs !== null && observation.receivedAt <= now) {
    return now - observation.receivedAt + source.deliveryBoundMs;
  }
  return null;
}

function trackObservation(previous: Observation | null | undefined, incoming: Observation, changed: boolean): Observation {
  const incomingChangedAt = incoming.changedAt === undefined ? incoming.observedAt : incoming.changedAt;
  const previousChangedAt = previous ? (previous.changedAt === undefined ? previous.observedAt : previous.changedAt) : incomingChangedAt;
  return {
    ...incoming,
    changedAt: changed ? incomingChangedAt : previousChangedAt,
    confirmedAt: incoming.confirmedAt === undefined ? incoming.observedAt : incoming.confirmedAt,
  };
}

function sameProvenance(left: Observation | null | undefined, right: Observation | null | undefined): boolean {
  return (left?.provider ?? null) === (right?.provider ?? null)
    && (left?.sessionId ?? null) === (right?.sessionId ?? null)
    && (left?.visibility ?? null) === (right?.visibility ?? null);
}

function inventoryObservation(player: PlayerState): Observation | null {
  return player.inventoryObservation === undefined ? player.observation : player.inventoryObservation;
}
function abilityObservation(player: PlayerState): Observation | null {
  return player.abilityObservation === undefined ? player.observation : player.abilityObservation;
}

/** A continuous stream can confirm unchanged state; it cannot repair stale initial hydration. */
function confirmContinuous(state: MatchState, observation: Observation): MatchState {
  if (state.source.status !== 'connected' || state.source.continuity !== 'continuous'
    || observation.visibility !== 'participant' || !provenanceMatches(state.source, observation)) return state;
  const confirm = (previous: Observation | null | undefined) => {
    if (!provenanceMatches(state.source, previous) || previous.visibility !== 'participant') return previous ?? null;
    const initialAge = ageBound(state.source, previous, previous.receivedAt);
    if (initialAge === null || initialAge > MAX_SOURCE_AGE_MS) return previous;
    // Game-clock regressions are cached observations, not new confirmations.
    const previousOrigin = previous.confirmedAt ?? previous.observedAt;
    const incomingOrigin = observation.confirmedAt ?? observation.observedAt;
    if (previousOrigin !== null && incomingOrigin !== null && incomingOrigin < previousOrigin) return previous;
    return trackObservation(previous, observation, false);
  };
  return {
    ...state,
    match: state.match ? { ...state.match, observation: confirm(state.match.observation) ?? state.match.observation } : null,
    draft: state.draft ? { ...state.draft, observation: confirm(state.draft.observation) ?? state.draft.observation } : null,
    players: state.players.map((player) => ({
      ...player,
      inventoryObservation: player.inventoryCompleteness === 'complete' ? confirm(inventoryObservation(player)) : inventoryObservation(player),
      abilityObservation: player.abilityCompleteness === 'complete' ? confirm(abilityObservation(player)) : abilityObservation(player),
    })),
  };
}

function loseContinuity(state: MatchState): MatchState {
  return {
    ...state, draft: null, advice: null, rosterCompleteness: 'unknown',
    players: state.players.map((player) => ({
      ...player, inventoryCompleteness: 'unknown', abilityCompleteness: 'unknown',
      inventoryRevision: player.inventoryRevision + (player.inventoryCompleteness === 'unknown' ? 0 : 1),
      abilityRevision: player.abilityRevision + (player.abilityCompleteness === 'unknown' ? 0 : 1),
    })),
  };
}

function closeDraft(state: MatchState, draft = state.draft, round = draft?.round ?? state.match?.round ?? null): MatchState {
  if (!draft) return state;
  const closed = [...(state.closedDrafts ?? [])];
  const index = closed.findIndex((entry) => entry.round === round && entry.id === draft.id);
  const entry = { round, id: draft.id, generation: draft.generation };
  if (index === -1) closed.push(entry);
  else closed[index] = { ...entry, generation: Math.max(closed[index]!.generation, entry.generation) };
  return { ...state, closedDrafts: closed };
}

function sourceDecisionFields(source: SourceState) {
  return {
    provider: source.provider, sessionId: session(source), status: source.status,
    runtimeVersion: source.runtimeVersion, noImageMethodVerified: source.noImageMethodVerified,
    sequenceKind: source.sequenceKind ?? null,
    continuity: source.continuity, deliveryBoundMs: source.deliveryBoundMs,
    capabilities: source.capabilities.map(({ name, supported, verified }) => ({ name, supported, verified }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function reduceSource(state: MatchState, event: Extract<TelemetryEvent, { type: 'source' }>): MatchState {
  let incoming = event.source;
  const previousSession = session(state.source);
  const incomingSession = session(incoming);
  if (incomingSession !== null && incomingSession !== previousSession
    && (state.retiredSourceSessionIds ?? []).includes(incomingSession)) return reject(state);
  // Removing an established epoch is not a restart protocol.
  if (previousSession !== null && incomingSession === null && incoming.provider === state.source.provider) return reject(state);
  const restarted = incoming.provider !== state.source.provider || incomingSession !== previousSession;
  if (!restarted && incoming.sequence !== null && state.source.sequence !== null
    && incoming.sequence < state.source.sequence) return reject(state);
  if (!restarted) {
    const advanced = incoming.sequence !== null && (state.source.sequence === null || incoming.sequence > state.source.sequence);
    incoming = {
      ...incoming,
      sequence: incoming.sequence ?? state.source.sequence,
      lastReceivedAt: advanced ? incoming.lastReceivedAt : state.source.lastReceivedAt,
    };
    if (state.match && incoming.sequenceKind === 'upstream' && state.source.sequenceKind === 'upstream'
      && advanced && state.source.sequence !== null && incoming.sequence! > state.source.sequence + 1
      && state.source.continuity !== 'gap') incoming = { ...incoming, continuity: 'gap' };
  }
  let next: MatchState = { ...state, source: incoming };
  if (restarted) {
    next = {
      ...next, match: null, players: [], draft: null, closedDrafts: [], rosterCompleteness: 'unknown', retiredMatchIds: [],
      retiredSourceSessionIds: previousSession === null ? (state.retiredSourceSessionIds ?? [])
        : [...new Set([...(state.retiredSourceSessionIds ?? []), previousSession])].slice(-HISTORY_LIMIT),
    };
  } else if (incoming.status !== 'connected' || incoming.continuity !== 'continuous') {
    next = loseContinuity(next);
  }
  const changed = restarted || !equal(sourceDecisionFields(state.source), sourceDecisionFields(incoming))
    || (next.advice?.kind === 'pick' && !usableDecisionContext(next, event.source.lastReceivedAt ?? state.source.lastReceivedAt ?? 0));
  return finish(state, next, changed, changed ? `Source ${incoming.status}${restarted ? ' — new session' : ''}` : '', incoming.lastReceivedAt ?? state.source.lastReceivedAt ?? 0);
}

function eventObservation(event: Exclude<TelemetryEvent, { type: 'source' | 'reset' }>): Observation {
  if (event.type === 'match') return event.match.observation;
  if (event.type === 'draft') return event.draft.observation;
  return event.observation;
}

function rejectContract(state: MatchState, observation: Observation, reason: string): MatchState {
  const next = loseContinuity({
    ...state,
    source: { ...state.source, sequence: observation.sequence, lastReceivedAt: observation.receivedAt, continuity: 'gap' },
  });
  const invalidated = finish(state, next, true, reason, observation.receivedAt);
  return {
    ...invalidated,
    counters: { ...invalidated.counters, accepted: state.counters.accepted, rejected: state.counters.rejected + 1 },
  };
}

function mergeItems(existing: ItemInstance[], additions: ItemInstance[]): ItemInstance[] {
  const merged = new Map(existing.map((item) => [item.instanceId, item]));
  for (const item of additions) merged.set(item.instanceId, item);
  return [...merged.values()];
}

function mergeAbilities(existing: PlayerState['abilities'], additions: PlayerState['abilities']): PlayerState['abilities'] {
  const merged = new Map(existing.map((ability) => [ability.id, ability]));
  for (const ability of additions) merged.set(ability.id, ability);
  return [...merged.values()];
}

function mergePurchases(existing: PurchasedItemHistoryEntry[], additions: PurchasedItemHistoryEntry[]): PurchasedItemHistoryEntry[] {
  // Partial history is a multiset snapshot. Preserve repeated purchases without duplicating hydration.
  const result = [...existing];
  const existingCounts = new Map<string, number>();
  const incomingCounts = new Map<string, number>();
  for (const item of existing) existingCounts.set(JSON.stringify(item), (existingCounts.get(JSON.stringify(item)) ?? 0) + 1);
  for (const item of additions) {
    const key = JSON.stringify(item);
    const count = (incomingCounts.get(key) ?? 0) + 1;
    incomingCounts.set(key, count);
    if (count > (existingCounts.get(key) ?? 0)) result.push(item);
  }
  return result.slice(-2048);
}

function rosterPlayer(previous: PlayerState | undefined, incoming: PlayerState, envelope: Observation): PlayerState {
  const heroChanged = previous !== undefined && previous.heroId !== incoming.heroId;
  const existing = heroChanged ? undefined : previous;
  const incomingInventoryObservation = incoming.inventoryObservation === undefined ? (incoming.observation ?? envelope) : incoming.inventoryObservation;
  const incomingAbilityObservation = incoming.abilityObservation === undefined ? (incoming.observation ?? envelope) : incoming.abilityObservation;
  const inventoryAvailable = incoming.inventoryCompleteness !== 'unknown';
  const abilitiesAvailable = incoming.abilityCompleteness !== 'unknown';
  const inventory = inventoryAvailable
    ? (incoming.inventoryCompleteness === 'complete' ? incoming.inventory : mergeItems(existing?.inventory ?? [], incoming.inventory))
    : (existing?.inventory ?? incoming.inventory);
  const abilities = abilitiesAvailable
    ? (incoming.abilityCompleteness === 'complete' ? incoming.abilities : mergeAbilities(existing?.abilities ?? [], incoming.abilities))
    : (existing?.abilities ?? incoming.abilities);
  // Roster metadata may omit independently acquired field groups. Unknown roster fields
  // never replace a known inventory with a fabricated empty or typical loadout.
  const inventoryCompleteness = inventoryAvailable ? incoming.inventoryCompleteness : (existing?.inventoryCompleteness ?? 'unknown');
  const abilityCompleteness = abilitiesAvailable ? incoming.abilityCompleteness : (existing?.abilityCompleteness ?? 'unknown');
  const invObservation = inventoryAvailable ? incomingInventoryObservation : (existing ? inventoryObservation(existing) : incomingInventoryObservation);
  const abilObservation = abilitiesAvailable ? incomingAbilityObservation : (existing ? abilityObservation(existing) : incomingAbilityObservation);
  const inventoryChanged = !existing || !equal(existing.inventory, inventory) || existing.inventoryCompleteness !== inventoryCompleteness
    || !sameProvenance(inventoryObservation(existing), invObservation);
  const abilityChanged = !existing || !equal(existing.abilities, abilities) || existing.abilityCompleteness !== abilityCompleteness
    || !sameProvenance(abilityObservation(existing), abilObservation);
  return {
    ...incoming, inventory, abilities, inventoryCompleteness, abilityCompleteness,
    inventoryRevision: (previous?.inventoryRevision ?? 0) + (inventoryChanged ? 1 : 0),
    abilityRevision: (previous?.abilityRevision ?? 0) + (abilityChanged ? 1 : 0),
    observation: trackObservation(previous?.observation, envelope, !previous || heroChanged),
    inventoryObservation: invObservation ? trackObservation(existing ? inventoryObservation(existing) : null, invObservation, inventoryChanged) : null,
    abilityObservation: abilObservation ? trackObservation(existing ? abilityObservation(existing) : null, abilObservation, abilityChanged) : null,
    purchasedHistory: incoming.purchasedHistory ?? existing?.purchasedHistory ?? [],
  };
}

function playerDecisionFields(player: PlayerState) {
  return {
    seat: player.seat, team: player.team, heroId: player.heroId, isLocal: player.isLocal,
    inventory: player.inventory, inventoryCompleteness: player.inventoryCompleteness,
    inventoryRevision: player.inventoryRevision, abilities: player.abilities,
    abilityCompleteness: player.abilityCompleteness, abilityRevision: player.abilityRevision,
    purchasedHistory: player.purchasedHistory ?? [],
    visibility: player.observation?.visibility ?? null,
    inventoryProvenance: inventoryObservation(player) ? { provider: inventoryObservation(player)!.provider, sessionId: session(inventoryObservation(player)!), visibility: inventoryObservation(player)!.visibility } : null,
    abilityProvenance: abilityObservation(player) ? { provider: abilityObservation(player)!.provider, sessionId: session(abilityObservation(player)!), visibility: abilityObservation(player)!.visibility } : null,
  };
}

function draftDecisionFields(draft: DraftState) {
  const { observation: _observation, ...fields } = draft;
  return { ...fields, provider: draft.observation.provider, sessionId: session(draft.observation), visibility: draft.observation.visibility };
}

function usableDecisionContext(state: MatchState, now: number): boolean {
  const match = state.match;
  if (!Number.isFinite(now) || !match || !state.draft || match.mode !== 'street_brawl' || match.phase !== 'draft'
    || match.round === null || match.round < 1 || match.deadlineAt === null || match.deadlineAt <= now
    || state.source.status !== 'connected' || state.source.continuity !== 'continuous'
    || state.rosterCompleteness !== 'complete' || state.players.length !== 8) return false;
  const usable = (observation: Observation | null | undefined) => {
    if (!provenanceMatches(state.source, observation) || observation.visibility !== 'participant') return false;
    const age = ageBound(state.source, observation, now);
    return age !== null && age <= MAX_SOURCE_AGE_MS;
  };
  if (!usable(match.observation) || !usable(state.draft.observation)
    || !state.draft.offers.some((offer) => offer.available)
    || state.draft.rerollsRemaining === null || state.draft.rerollAvailable === null
    || (state.draft.rerollAvailable && state.draft.rerollsRemaining === 0)) return false;
  const local = state.players.find((player) => player.seat === match.localSeat);
  if (match.localSeat === null || match.localTeam === null || !local || !local.isLocal || local.team !== match.localTeam
    || state.players.filter((player) => player.isLocal).length !== 1
    || state.players.filter((player) => player.team === 0).length !== 4 || state.players.filter((player) => player.team === 1).length !== 4) return false;
  if (state.mode === 'live' && (state.draft.round !== match.round || session(state.source) === null
    || state.source.sequenceKind !== 'upstream' || state.source.sequence === null || state.source.runtimeVersion === null
    || !state.source.noImageMethodVerified || synthetic(state.source.provider)
    || REQUIRED_CAPABILITIES.some((name) => !state.source.capabilities.some((capability) => capability.name === name && capability.supported && capability.verified)))) return false;
  return state.players.every((player) => player.heroId !== null
    && provenanceMatches(state.source, player.observation) && player.observation.visibility === 'participant'
    && player.inventoryCompleteness === 'complete' && player.abilityCompleteness === 'complete'
    && player.abilities.every((ability) => ability.rank !== null && ability.unlocked !== null)
    && usable(inventoryObservation(player)) && usable(abilityObservation(player)));
}

/** Pure, immutable event application. Invalid traffic never mutates a previously accepted snapshot. */
export function reduceTelemetry(state: MatchState, input: TelemetryEvent): MatchState {
  let event: TelemetryEvent;
  try { event = parseTelemetryEvent(input); } catch { return reject(state); }
  if (event.type === 'source') return reduceSource(state, event);
  if (event.type === 'reset') {
    const retired = state.match ? [...new Set([...(state.retiredMatchIds ?? []), state.match.id])].slice(-HISTORY_LIMIT) : (state.retiredMatchIds ?? []);
    return finish(state, { ...state, match: null, players: [], draft: null, closedDrafts: [], rosterCompleteness: 'unknown', retiredMatchIds: retired }, true, event.reason, event.at);
  }
  const observation = eventObservation(event);
  if (state.source.status !== 'connected' || !provenanceMatches(state.source, observation)
    || (state.source.sequence !== null && observation.sequence <= state.source.sequence)) return reject(state);
  const matchId = event.type === 'match' ? event.match.id : event.matchId;
  if ((state.retiredMatchIds ?? []).includes(matchId)) return reject(state);
  if (event.type !== 'match' && state.match?.id !== matchId) return reject(state);
  if (event.type === 'match' && state.match?.id === matchId && state.match.round !== null
    && event.match.round !== null && event.match.round < state.match.round) return reject(state);
  if (event.type === 'round' && state.match?.round !== null && state.match?.round !== undefined
    && event.round < state.match.round) return reject(state);
  if (event.type === 'draft' && state.draft?.id === event.draft.id && event.draft.generation < state.draft.generation) return reject(state);
  if (event.type === 'draft') {
    const currentRound = state.match?.round ?? null;
    if ((event.draft.round !== undefined && event.draft.round !== currentRound)
      || (state.mode === 'live' && event.draft.round === undefined)) return reject(state);
    if ((state.closedDrafts ?? []).some((draft) => draft.round === currentRound && draft.id === event.draft.id
      && event.draft.generation <= draft.generation)) return reject(state);
  }
  if ((event.type === 'inventory' || event.type === 'abilities' || event.type === 'purchases')
    && !state.players.some((player) => player.seat === event.seat)) return reject(state);
  if (event.type === 'inventory') {
    const player = state.players.find((value) => value.seat === event.seat)!;
    const owned = new Map(player.inventory.map((item) => [item.instanceId, item]));
    if (event.operation === 'add' && event.items.some((item) => owned.has(item.instanceId) && !equal(owned.get(item.instanceId), item))) {
      return rejectContract(state, observation, 'Conflicting additive inventory update — fresh hydration required');
    }
    if (player.inventoryCompleteness === 'complete' && event.removeInstanceIds.some((id) => !owned.has(id))) {
      return rejectContract(state, observation, 'Inventory removal contradicts confirmed ownership — fresh hydration required');
    }
  }

  const gap = state.source.sequenceKind === 'upstream' && state.source.sequence !== null && observation.sequence > state.source.sequence + 1;
  let next = gap ? loseContinuity(state) : confirmContinuous(state, observation);
  next = {
    ...next,
    source: { ...state.source, sequence: observation.sequence, lastReceivedAt: observation.receivedAt, continuity: gap ? 'gap' : state.source.continuity },
  };
  let changed = gap;
  let label = '';
  switch (event.type) {
    case 'match': {
      const old = state.match;
      const crossed = old !== null && old.id !== event.match.id;
      const resetPlayers = !old || crossed || old.mode !== event.match.mode || old.clientVersion !== event.match.clientVersion
        || old.localSeat !== event.match.localSeat || old.localTeam !== event.match.localTeam;
      const incompatible = !old || crossed || old.mode !== event.match.mode || old.clientVersion !== event.match.clientVersion
        || old.localSeat !== event.match.localSeat || old.localTeam !== event.match.localTeam
        || old.round !== event.match.round || old.phase !== event.match.phase;
      const { observation: _oldObservation, ...oldFields } = old ?? { observation: null };
      const { observation: _newObservation, ...newFields } = event.match;
      changed ||= !equal(oldFields, newFields) || !sameProvenance(old?.observation, observation);
      if (incompatible || event.match.phase !== 'draft') next = closeDraft(next, state.draft, state.draft?.round ?? old?.round ?? null);
      next = {
        ...next,
        match: { ...event.match, observation: trackObservation(old?.observation, observation, changed) },
        draft: incompatible || event.match.phase !== 'draft' ? null : next.draft,
        players: resetPlayers ? [] : next.players,
        rosterCompleteness: resetPlayers ? 'unknown' : next.rosterCompleteness,
        closedDrafts: crossed || old === null ? [] : next.closedDrafts,
        retiredMatchIds: crossed ? [...new Set([...(state.retiredMatchIds ?? []), old.id])].slice(-HISTORY_LIMIT) : (state.retiredMatchIds ?? []),
      };
      label = changed ? (crossed ? 'New match — previous match cleared' : 'Match context confirmed') : '';
      break;
    }
    case 'roster': {
      const merged = new Map<number, PlayerState>(event.complete ? [] : next.players.map((player) => [player.seat, player]));
      for (const player of event.players) merged.set(player.seat, rosterPlayer(next.players.find((value) => value.seat === player.seat), player, observation));
      const players = [...merged.values()].sort((left, right) => left.seat - right.seat);
      const rosterCompleteness = event.complete ? 'complete' : (next.rosterCompleteness === 'complete' ? 'complete' : 'partial');
      changed ||= !equal(state.players.map(playerDecisionFields), players.map(playerDecisionFields)) || state.rosterCompleteness !== rosterCompleteness;
      next = { ...next, players, rosterCompleteness };
      label = changed ? (event.complete ? 'Complete roster snapshot' : 'Partial roster update') : '';
      break;
    }
    case 'round': {
      const match = next.match!;
      changed ||= match.round !== event.round || match.phase !== event.phase || !equal(match.scores, event.scores) || match.deadlineAt !== event.deadlineAt
        || !sameProvenance(match.observation, observation);
      const invalidDraft = match.round !== event.round || match.phase !== event.phase || event.phase !== 'draft';
      if (invalidDraft) next = closeDraft(next, state.draft);
      next = {
        ...next, draft: invalidDraft ? null : next.draft,
        match: { ...match, round: event.round, phase: event.phase, scores: event.scores, deadlineAt: event.deadlineAt, observation: trackObservation(state.match?.observation, observation, changed) },
      };
      label = changed ? `Round ${event.round} — ${event.phase}` : '';
      break;
    }
    case 'draft': {
      if (next.match?.phase !== 'draft') return reject(state);
      changed ||= state.draft === null || !equal(draftDecisionFields(state.draft), draftDecisionFields(event.draft));
      if (state.draft && (state.draft.id !== event.draft.id || state.draft.generation < event.draft.generation)) next = closeDraft(next, state.draft);
      next = { ...next, draft: { ...event.draft, round: event.draft.round ?? next.match!.round, observation: trackObservation(state.draft?.observation, observation, changed) } };
      label = changed ? `Draft offers — generation ${event.draft.generation}` : '';
      break;
    }
    case 'action':
      next = closeDraft(next, state.draft);
      next = { ...next, draft: null };
      changed = true;
      label = event.action === 'reroll' ? 'Reroll observed — awaiting replacement offers' : event.action === 'pick' ? 'Pick observed — awaiting confirmed inventory' : 'Draft closed';
      break;
    case 'inventory': {
      const player = next.players.find((value) => value.seat === event.seat)!;
      const removed = new Set(event.removeInstanceIds);
      const inventory = event.operation === 'snapshot' && event.complete ? event.items
        : mergeItems(player.inventory.filter((item) => !removed.has(item.instanceId)), event.items);
      const inventoryCompleteness = event.operation === 'snapshot' ? (event.complete ? 'complete' : 'partial') : player.inventoryCompleteness;
      const playerChanged = !equal(player.inventory, inventory) || player.inventoryCompleteness !== inventoryCompleteness
        || !sameProvenance(inventoryObservation(player), observation);
      changed ||= playerChanged;
      const updated: PlayerState = {
        ...player, inventory, inventoryCompleteness,
        inventoryRevision: player.inventoryRevision + (playerChanged ? 1 : 0),
        inventoryObservation: trackObservation(inventoryObservation(player), observation, playerChanged),
      };
      next = { ...next, players: next.players.map((value) => value.seat === event.seat ? updated : value) };
      label = playerChanged ? `Inventory ${event.operation} confirmed — seat ${event.seat + 1}` : '';
      break;
    }
    case 'abilities': {
      const player = next.players.find((value) => value.seat === event.seat)!;
      const abilities = event.complete ? event.abilities : mergeAbilities(player.abilities, event.abilities);
      const abilityCompleteness = event.complete ? 'complete' : 'partial';
      const playerChanged = !equal(player.abilities, abilities) || player.abilityCompleteness !== abilityCompleteness
        || !sameProvenance(abilityObservation(player), observation);
      changed ||= playerChanged;
      const updated: PlayerState = {
        ...player, abilities, abilityCompleteness,
        abilityRevision: player.abilityRevision + (playerChanged ? 1 : 0),
        abilityObservation: trackObservation(abilityObservation(player), observation, playerChanged),
      };
      next = { ...next, players: next.players.map((value) => value.seat === event.seat ? updated : value) };
      label = playerChanged ? `Ability investment confirmed — seat ${event.seat + 1}` : '';
      break;
    }
    case 'purchases': {
      const player = next.players.find((value) => value.seat === event.seat)!;
      const purchasedHistory = event.complete ? event.items : mergePurchases(player.purchasedHistory ?? [], event.items);
      const playerChanged = !equal(player.purchasedHistory ?? [], purchasedHistory);
      changed ||= playerChanged;
      next = { ...next, players: next.players.map((value) => value.seat === event.seat ? { ...value, purchasedHistory } : value) };
      label = playerChanged ? `Purchase history observed — current inventory unchanged` : '';
      break;
    }
  }
  if (gap) next = { ...next, draft: null };
  // Freshness can become unknown without changing an item's identity. A newly accepted
  // stale/cached confirmation must remove an existing directive in this same transaction.
  if (next.advice?.kind === 'pick' && !usableDecisionContext(next, observation.receivedAt)) changed = true;
  return finish(state, next, changed, gap ? 'Source sequence gap — fresh hydration required' : label, observation.receivedAt);
}

export function getDecisionKey(state: MatchState, modelVersion: string, catalogRevision?: string): DecisionKey | null {
  const match = state.match;
  if (!match || match.mode !== 'street_brawl' || match.phase !== 'draft' || match.round === null || !state.draft) return null;
  return {
    sourceSessionId: session(state.source), catalogRevision, contextRevision: decisionRevision(state),
    matchId: match.id, round: match.round, draftId: state.draft.id, generation: state.draft.generation,
    inventoryRevision: state.players.reduce((sum, player) => sum + player.inventoryRevision, 0),
    abilityRevision: state.players.reduce((sum, player) => sum + player.abilityRevision, 0), modelVersion,
  };
}

export function sameDecisionKey(left: DecisionKey | null | undefined, right: DecisionKey | null | undefined): boolean {
  return left != null && right != null && left.matchId === right.matchId && left.round === right.round
    && left.draftId === right.draftId && left.generation === right.generation
    && left.inventoryRevision === right.inventoryRevision && left.abilityRevision === right.abilityRevision
    && left.modelVersion === right.modelVersion && (left.sourceSessionId ?? null) === (right.sourceSessionId ?? null)
    && left.catalogRevision === right.catalogRevision && left.contextRevision === right.contextRevision;
}

/** Callers first evaluate the pinned catalogue gate; this rejects late or mismatched worker results. */
export function acceptAdvice(state: MatchState, advice: Advice, modelVersion: string, catalogRevision?: string, now = Date.now()): MatchState {
  if (!sameDecisionKey(getDecisionKey(state, modelVersion, catalogRevision), advice.key)
    || state.source.status !== 'connected' || state.source.continuity !== 'continuous'
    || state.match?.deadlineAt === null || (state.match?.deadlineAt ?? 0) <= now
    || !Number.isFinite(advice.computedAt) || advice.computedAt > now
    || (state.mode === 'live' && (advice.evidence === 'synthetic' || synthetic(state.source.provider)))) return reject(state);
  if (advice.kind === 'pick' && !usableDecisionContext(state, now)) return reject(state);
  if (advice.kind === 'pick' && !state.draft?.offers.some((offer) => offer.available && offer.position === advice.preferredPosition)) return reject(state);
  // Clone the trusted worker value so later worker-side mutation cannot affect accepted state.
  return { ...state, advice: structuredClone(advice) };
}

export function decisionBlockers(state: MatchState, catalog: Catalog, now: number): string[] {
  const blockers: string[] = [];
  const add = (reason: string) => { if (!blockers.includes(reason)) blockers.push(reason); };
  if (!Number.isFinite(now)) add('The local clock is unavailable.');
  if (state.source.status !== 'connected') add('The telemetry source is not connected.');
  if (state.source.continuity !== 'continuous') add('Source continuity has not been verified.');
  if (state.mode === 'live') {
    if (synthetic(state.source.provider)) add('Synthetic observations can be scored only in Demo mode.');
    if (session(state.source) === null) add('The provider session identity is unknown.');
    if (state.source.sequenceKind !== 'upstream') add('The source sequence is not an upstream continuity watermark.');
    if (state.source.sequence === null) add('The source continuity watermark is unknown.');
    if (state.source.runtimeVersion === null) add('The provider runtime version is unknown.');
    if (!state.source.noImageMethodVerified) add('The automatic no-image acquisition method has not been verified.');
    for (const name of REQUIRED_CAPABILITIES) {
      if (!state.source.capabilities.some((capability) => capability.name === name && capability.supported && capability.verified)) add(`Required capability is unverified: ${name}.`);
    }
    if (!catalog.liveModelValidated) add('A compatible live mechanics model has not been validated.');
  }
  const match = state.match;
  if (!match) { add('Waiting for the player’s own match.'); return blockers; }
  if (match.mode !== 'street_brawl') add('Street Brawl mode has not been confirmed.');
  if (match.clientVersion === null || match.clientVersion !== catalog.clientVersion) add('The observed game build does not match the pinned catalogue.');
  if (match.phase !== 'draft') add('The match is not in a draft phase.');
  if (match.round === null || match.round < 1) add('The current round is unknown.');
  if (match.deadlineAt === null) add('The draft deadline is unknown.');
  else if (match.deadlineAt <= now) add('The draft deadline has expired.');
  if (match.observation.visibility !== 'participant' || !provenanceMatches(state.source, match.observation)) add('Own-match participant visibility and source identity are unverified.');
  const local = state.players.find((player) => player.seat === match.localSeat);
  if (match.localSeat === null || match.localTeam === null || !local || !local.isLocal || local.team !== match.localTeam
    || state.players.filter((player) => player.isLocal).length !== 1) add('The local player’s seat and team have not been confirmed.');
  if (state.rosterCompleteness !== 'complete' || state.players.length !== 8
    || state.players.filter((player) => player.team === 0).length !== 4 || state.players.filter((player) => player.team === 1).length !== 4) add('A complete four-versus-four roster has not been confirmed.');

  const itemIds = new Set(catalog.items.map((item) => item.id));
  const heroIds = new Set(catalog.heroes.map((hero) => hero.id));
  const checkItem = (item: ItemInstance) => {
    if (!itemIds.has(item.id) || item.bonusIds.some((id) => !itemIds.has(id))) add('An observed item or bonus ID is absent from the pinned catalogue.');
    if (item.variant === 'unknown' || !item.modifiersDecoded) add('Observed item variants or modifier bits have not been decoded.');
  };
  const checkObservation = (observation: Observation | null, label: string) => {
    if (!provenanceMatches(state.source, observation) || observation.visibility !== 'participant') { add(`${label} is not confirmed participant-visible data from this source session.`); return; }
    if (state.mode === 'live') {
      const age = ageBound(state.source, observation, now);
      if (age === null) add(`${label} has no valid game-origin clock mapping or documented delivery bound.`);
      else if (age > MAX_SOURCE_AGE_MS) add(`${label} exceeds the ${MAX_SOURCE_AGE_MS} ms true-age bound.`);
    }
  };
  for (const player of state.players) {
    if (player.heroId === null || !heroIds.has(player.heroId)) add('An observed hero ID is absent from the pinned catalogue.');
    if (!provenanceMatches(state.source, player.observation) || player.observation.visibility !== 'participant') add('The roster contains unverified participant visibility or source identity.');
    if (player.inventoryCompleteness !== 'complete') add('Current inventories are incomplete or unknown.');
    if (player.abilityCompleteness !== 'complete' || player.abilities.some((ability) => ability.rank === null || ability.unlocked === null)) add('Exact ability investment is incomplete or unknown.');
    checkObservation(inventoryObservation(player), 'Inventory state');
    checkObservation(abilityObservation(player), 'Ability investment');
    player.inventory.forEach(checkItem);
  }
  if (!state.draft) { add('Waiting for the local player’s current draft offers.'); return blockers; }
  checkObservation(match.observation, 'Round context');
  checkObservation(state.draft.observation, 'Draft offers');
  if (state.mode === 'live' && state.draft.round !== match.round) add('The draft does not have a confirmed current-round identity.');
  if (state.draft.offers.length === 0 || !state.draft.offers.some((offer) => offer.available)) add('There are no confirmed selectable offers.');
  if (state.draft.rerollsRemaining === null || state.draft.rerollAvailable === null) add('Legal reroll availability and remaining budget are unknown.');
  if (state.draft.rerollAvailable === true && state.draft.rerollsRemaining === 0) add('Reroll availability conflicts with the observed zero budget.');
  state.draft.offers.forEach((offer) => checkItem(offer.item));
  return blockers;
}
