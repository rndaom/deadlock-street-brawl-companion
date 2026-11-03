import {
  createInitialScreenMatchContext, SCREEN_CAPTURE_FRESHNESS_MS, SCREEN_CONTEXT_MAX_AGE_MS,
  type ScreenAbilityState, type ScreenCompleteness, type ScreenContextObservation, type ScreenInventoryItem,
  type ScreenMatchContext, type ScreenMatchFieldObservations, type ScreenMatchObservation,
  type ScreenObservedPlayer, type ScreenPlayerObservation, type ScreenRoundTracking,
} from '../shared/screen-reading';
import { CONTEXT_CATALOG } from '../shared/context-catalog';

const fields = ['viewMode', 'matchId', 'phase', 'round', 'scores', 'localSeat', 'localHeroId', 'localTeam',
  'localAbilityPoints', 'rerollsRemaining', 'rerollAvailable', 'pickStage', 'deadlineAt'] as const;
const has = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Age is measured from captured pixels, never callback receipt. */
export function screenObservationAge(observation: ScreenContextObservation | null | undefined, now: number): number | null {
  if (!observation || !Number.isFinite(now) || !Number.isFinite(observation.capturedAt)) return null;
  const age = now - observation.capturedAt;
  return age >= 0 ? age : null;
}

/** This permits an explicitly aged snapshot; it does not certify unseen changes. */
export function isScreenObservationUsable(observation: ScreenContextObservation | null | undefined,
  context: ScreenMatchContext, now: number, maximumAgeMs = SCREEN_CONTEXT_MAX_AGE_MS): boolean {
  const age = screenObservationAge(observation, now);
  return !!observation && context.phase !== 'finished' && observation.sessionId === context.sessionId
    && observation.invalidatedAt == null && observation.confidence >= 0.85 && observation.receivedAt >= observation.capturedAt
    && age !== null && age <= maximumAgeMs;
}

/** Reset keeps revision monotonic and retires the old source, but carries no build data. */
export function resetScreenMatchContext(state: ScreenMatchContext): ScreenMatchContext {
  return { ...createInitialScreenMatchContext(), revision: state.revision + 1,
    retiredSessionIds: retire(state.retiredSessionIds, state.sessionId),
    retiredGameSessionIds: retire(state.retiredGameSessionIds, state.gameSessionId) };
}
/**
 * A death cam shows "SPECTATING" on every frame. Once frames stop showing it (respawn,
 * draft, own HUD), the spectator verdict ends; other frames never write "not spectating".
 */
export const SPECTATOR_HOLD_MS = 4_000;
/** Historical pixels remain inspectable; an expired ownership proof is not a current participant claim. */
export function expireScreenMatchContext(state: ScreenMatchContext, now: number): ScreenMatchContext {
  if (state.viewMode === 'spectator') {
    const age = screenObservationAge(state.observations.viewMode, now);
    return age !== null && age <= SPECTATOR_HOLD_MS ? state : { ...state, viewMode: 'unknown', revision: state.revision + 1 };
  }
  if (state.viewMode !== 'participant') return state;
  const age = screenObservationAge(state.observations.viewMode, now);
  if (age !== null && age <= SCREEN_CONTEXT_MAX_AGE_MS) return state;
  return { ...state, viewMode: 'unknown', revision: state.revision + 1 };
}
function retire(list: string[], value: string | null): string[] {
  return value === null || list.includes(value) ? [...list] : [...list, value].slice(-32);
}
function validObservation(value: ScreenContextObservation | null | undefined, frame: ScreenMatchObservation): boolean {
  if (value == null) return true;
  return value.sessionId === frame.sessionId && value.frameId === frame.frameId && value.capturedAt === frame.capturedAt
    && value.receivedAt === frame.receivedAt && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && Array.isArray(value.bounds) && value.bounds.length <= 64 && value.bounds.every(bound =>
      [bound.x, bound.y, bound.width, bound.height].every(Number.isFinite) && bound.x >= 0 && bound.y >= 0
      && bound.width >= 0 && bound.height >= 0 && bound.x + bound.width <= 1.00001 && bound.y + bound.height <= 1.00001);
}
function frameValid(frame: ScreenMatchObservation, now: number): boolean {
  if (!frame.sessionId || !frame.frameId || !Number.isFinite(frame.capturedAt) || !Number.isFinite(frame.receivedAt)
    || frame.receivedAt < frame.capturedAt || now < frame.receivedAt || now - frame.capturedAt >= SCREEN_CAPTURE_FRESHNESS_MS) return false;
  const observations = [...Object.values(frame.fields ?? {}), frame.resetObservation, frame.rosterObservation, frame.localInventoryObservation, frame.abilityObservation,
    ...(frame.localInventory ?? []).map(item => item.observation), ...(frame.localAbilities ?? []).map(ability => ability.observation)];
  for (const player of frame.players ?? []) observations.push(player.heroObservation, player.teamObservation, player.localObservation,
    player.inventoryObservation, ...(player.inventory ?? []).map(item => item.observation));
  if (!observations.every(value => validObservation(value, frame))) return false;
  const seats = (frame.players ?? []).map(player => player.seat);
  if (seats.length > 8 || new Set(seats).size !== seats.length || seats.some(seat => !Number.isInteger(seat) || seat < 0 || seat > 7)) return false;
  const validSlots = (items: ScreenInventoryItem[] | undefined) => !items || (items.length <= 256
    && new Set(items.map(item => item.slot)).size === items.length && items.every(item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 256));
  if (!validSlots(frame.localInventory) || (frame.players ?? []).some(player => !validSlots(player.inventory))) return false;
  return !frame.localAbilities || (frame.localAbilities.length <= 4 && new Set(frame.localAbilities.map(ability => ability.slot)).size === frame.localAbilities.length
    && frame.localAbilities.every(ability => [0, 1, 2, 3].includes(ability.slot)
      && (ability.rank === null || (Number.isInteger(ability.rank) && ability.rank >= 0 && ability.rank <= 3))));
}
function confirmed(next: ScreenContextObservation, old: ScreenContextObservation | null | undefined, changed: boolean): ScreenContextObservation {
  return { ...next, bounds: next.bounds.map(bound => ({ ...bound })),
    changedAt: has(next, 'changedAt') ? next.changedAt : changed ? next.capturedAt
      : old && has(old, 'changedAt') ? old.changedAt : old?.capturedAt ?? next.capturedAt,
    confirmedAt: has(next, 'confirmedAt') ? next.confirmedAt : next.capturedAt };
}
function itemIdentity(item: ScreenInventoryItem) {
  return [item.slot, item.itemId, item.status ?? (item.itemId ? 'recognized' : 'unknown'), item.variant,
    item.bonusIds === null ? null : [...item.bonusIds].sort(), item.quantity ?? null];
}
function usableItem(item: ScreenInventoryItem): boolean {
  return item.observation.confidence >= 0.85 && (item.itemId !== null || item.status === 'empty' && item.observation.confidence >= 0.94);
}
function mergeInventory(old: ScreenInventoryItem[], incoming: ScreenInventoryItem[], coverage: ScreenCompleteness,
  observation: ScreenContextObservation | null | undefined): ScreenInventoryItem[] {
  const result = new Map<number, ScreenInventoryItem>(coverage === 'complete' && observation ? [] : old.map(item => [item.slot, item]));
  for (const item of incoming) {
    if (!usableItem(item)) continue; // An unread slot does not overwrite an older positive fact.
    if (item.status === 'empty') { result.delete(item.slot); continue; }
    const previous = old.find(value => value.slot === item.slot);
    result.set(item.slot, { ...item, bonusIds: item.bonusIds === null ? null : [...item.bonusIds],
      observation: confirmed(item.observation, previous?.observation, !previous || !equal(itemIdentity(previous), itemIdentity(item))) });
  }
  return [...result.values()].sort((a, b) => a.slot - b.slot);
}
function inventoryCoverage(items: ScreenInventoryItem[], requested: ScreenCompleteness, observation: ScreenContextObservation | null | undefined) {
  if (!observation || observation.confidence < 0.85) return 'unknown' as const;
  if (requested !== 'complete') return requested;
  return items.every(item => usableItem(item) && (item.status === 'empty' || item.itemId !== null && item.variant !== 'unknown'
    && item.bonusIds !== null && typeof item.quantity === 'number' && item.quantity > 0)) ? 'complete' as const : 'partial' as const;
}
function mergeAbilities(old: ScreenAbilityState[], incoming: ScreenAbilityState[], coverage: ScreenCompleteness,
  observation: ScreenContextObservation | null | undefined): ScreenAbilityState[] {
  const result = new Map<number, ScreenAbilityState>(coverage === 'complete' && observation ? [] : old.map(ability => [ability.slot, ability]));
  for (const ability of incoming) {
    if (ability.observation.confidence < 0.85 || ability.rank === null && ability.unlocked === null && ability.nextUpgradeCost == null) continue;
    const previous = old.find(value => value.slot === ability.slot);
    const identity = (value: ScreenAbilityState) => [value.slot, value.abilityId, value.rank, value.unlocked, value.nextUpgradeCost ?? null];
    result.set(ability.slot, { ...ability, observation: confirmed(ability.observation, previous?.observation,
      !previous || !equal(identity(previous), identity(ability))) });
  }
  return [...result.values()].sort((a, b) => a.slot - b.slot);
}
function playerBase(seat: number): ScreenObservedPlayer {
  return { seat, team: null, heroId: null, isLocal: null, heroObservation: null, teamObservation: null, localObservation: null,
    inventory: [], inventoryCompleteness: 'unknown', inventorySlotCompleteness: 'unknown', inventoryObservation: null, inventoryRevision: 0 };
}
function mergePlayer(previous: ScreenObservedPlayer | undefined, incoming: ScreenPlayerObservation): ScreenObservedPlayer {
  let result = { ...(previous ?? playerBase(incoming.seat)) };
  const identifiedHero = incoming.heroId != null && !!incoming.heroObservation && incoming.heroObservation.confidence >= .85
    && incoming.heroObservation.invalidatedAt == null;
  const identifiedTeam = incoming.team != null && !!incoming.teamObservation && incoming.teamObservation.confidence >= .85
    && incoming.teamObservation.invalidatedAt == null;
  const heroChanged = identifiedHero && incoming.heroId !== result.heroId;
  const teamChanged = identifiedTeam && result.team !== null && incoming.team !== result.team;
  if (heroChanged || teamChanged) result = { ...playerBase(incoming.seat), inventoryRevision: result.inventoryRevision + 1 };
  for (const [field, observationField] of [['heroId', 'heroObservation'], ['team', 'teamObservation'], ['isLocal', 'localObservation']] as const) {
    const observation = incoming[observationField];
    if (!has(incoming, field) || !observation || observation.confidence < 0.85) continue;
    const value = incoming[field] ?? null;
    Object.assign(result, { [field]: value, [observationField]: confirmed(observation, result[observationField], !equal(value, result[field])) });
  }
  // UI columns are not stable player IDs. A newly read build must be paired with
  // a positively identified portrait/text hero in this same frame, never an old seat assumption.
  if (identifiedHero && incoming.inventory !== undefined && incoming.inventoryObservation && incoming.inventoryCompleteness !== 'unknown') {
    const coverage = inventoryCoverage(incoming.inventory, incoming.inventoryCompleteness ?? 'partial', incoming.inventoryObservation);
    const requestedSlots = incoming.inventorySlotCompleteness ?? coverage;
    const slotCoverage = requestedSlots === 'complete' && !incoming.inventory.every(usableItem) ? 'partial' : requestedSlots;
    const inventory = mergeInventory(result.inventory, incoming.inventory, slotCoverage, incoming.inventoryObservation);
    const changed = !equal(result.inventory.map(itemIdentity), inventory.map(itemIdentity)) || coverage !== result.inventoryCompleteness
      || slotCoverage !== result.inventorySlotCompleteness;
    result = { ...result, inventory, inventoryCompleteness: coverage, inventorySlotCompleteness: slotCoverage,
      inventoryObservation: confirmed(incoming.inventoryObservation, result.inventoryObservation, changed),
      inventoryRevision: result.inventoryRevision + (changed ? 1 : 0) };
  }
  return result;
}
/** Semantic comparison excludes timestamps: repeated confirmation refreshes age without changing the build revision. */
function semantics(context: ScreenMatchContext): unknown {
  return { ...Object.fromEntries(fields.map(field => [field, context[field]])), sessionId: context.sessionId, gameSessionId: context.gameSessionId,
    players: context.players.map(player => [player.seat, player.team, player.heroId, player.isLocal,
      player.inventory.map(itemIdentity), player.inventoryCompleteness, player.inventorySlotCompleteness]), rosterCompleteness: context.rosterCompleteness,
    inventory: context.localInventory.map(itemIdentity), inventoryCompleteness: context.localInventoryCompleteness, slotCompleteness: context.localInventorySlotCompleteness,
    abilities: context.localAbilities.map(ability => [ability.slot, ability.abilityId, ability.rank, ability.unlocked,
      ability.nextUpgradeCost ?? null, ability.observation.invalidatedAt == null]), abilityCompleteness: context.abilityCompleteness };
}
function clearOwn(context: ScreenMatchContext): ScreenMatchContext {
  return { ...context, localSeat: null, localHeroId: null, localTeam: null, localAbilityPoints: null,
    localInventory: [], localInventoryCompleteness: 'unknown', localInventorySlotCompleteness: 'unknown', localInventoryObservation: null, localInventoryRevision: context.localInventoryRevision + 1,
    localAbilities: [], abilityCompleteness: 'unknown', abilityObservation: null, abilityRevision: context.abilityRevision + 1,
    players: context.players.map(player => ({ ...player, isLocal: null, localObservation: null })),
    observations: { ...context.observations, localSeat: null, localHeroId: null, localTeam: null, localAbilityPoints: null } };
}

/** First to `scoreToWin` round wins: at most 2 * 3 - 1 = 5 rounds. */
export const MAX_STREET_BRAWL_ROUNDS = Math.max(1, 2 * (CONTEXT_CATALOG.streetBrawl.scoreToWin || 3) - 1);
/** A draft that opens this long after the previous draft frame, with combat in between, is the next round's. */
export const ROUND_DRAFT_GAP_MS = 20_000;
/** The round is advanced by a new draft only when the previous draft was this recent (a round is a few minutes). */
export const ROUND_DRAFT_MAX_GAP_MS = 300_000;
/** A lower score replaces the kept one only after this many agreeing reads (a past misread stays correctable). */
const SCORE_LOWER_READS = 3;
/** A lower round (not 1) replaces the kept one after this many agreeing reads: a one-off "ROUND N+1" misread
 * would otherwise stick for the whole round, since a read one above is accepted at once. */
const ROUND_LOWER_READS = 3;
const initialTracking = (): ScreenRoundTracking => ({ candidate: null, candidateCount: 0, scoreCandidate: null, scoreCandidateCount: 0,
  lastDraftAt: null, roundAtLastDraft: null, combatSinceDraft: false, inferredAt: null });
/** Round wins on the HUD pips (left + right) are N-1 during round N, or N once it has been decided. */
function pipsFitRound(scores: readonly [number, number], round: number): boolean {
  return scores[0] + scores[1] >= round - 1 && scores[0] + scores[1] <= round;
}
function validScores(scores: unknown): scores is [number, number] {
  return Array.isArray(scores) && scores.length === 2 && scores.every(value => Number.isInteger(value) && value >= 0
    && value <= (CONTEXT_CATALOG.streetBrawl.scoreToWin || 3));
}
interface RoundDecision { round: number | undefined; inferred: boolean; restart: boolean; lowered: boolean; scores: [number, number] | undefined; tracking: ScreenRoundTracking }
/**
 * The round only moves forward one step at a time (real 2026-10-18 logs: a misread "ROUND 13" was
 * taken in round 3, and a round-3 draft ran as round 2 for 40 s until "ROUND 3" was read):
 *  - a read above the maximum, or contradicting the round pips on the same frame, is ignored;
 *  - the same round or the next one is accepted; a larger jump needs a second agreeing read or the pips;
 *  - a lower round is a new match only when "ROUND 1" is read twice (or with empty pips); another lower round
 *    replaces the kept one after three agreeing reads (a one-off "ROUND N+1" misread does not stick);
 *  - a new "Choice 1 of 3" draft after combat advances the round by one when the round has not
 *    advanced since the previous draft, and that draft was within a few minutes;
 *  - a score is kept only when left + right is N-1 or N in round N, and never falls on one read.
 */
function decideRound(state: ScreenMatchContext, frame: ScreenMatchObservation): RoundDecision {
  const tracking = { ...(state.roundTracking ?? initialTracking()) };
  const previous = state.round;
  const usable = (field: 'round' | 'scores' | 'phase' | 'pickStage') => has(frame, field) && !!frame.fields?.[field] && frame.fields[field]!.confidence >= 0.85;
  const pips = usable('scores') && validScores(frame.scores) ? frame.scores : null;
  let round: number | undefined; let inferred = false; let restart = false; let lowered = false;
  const read = usable('round') && Number.isInteger(frame.round) ? frame.round! : null;
  if (read !== null && read >= 1 && read <= MAX_STREET_BRAWL_ROUNDS && !(pips && !pipsFitRound(pips, read))) {
    if (previous === null || read === previous || read === previous + 1) { round = read; tracking.candidate = null; tracking.candidateCount = 0; }
    // A HUD read one below a round that was only inferred from a draft corrects it at once.
    else if (read === previous - 1 && tracking.inferredAt !== null) { round = read; lowered = true; tracking.candidate = null; tracking.candidateCount = 0; }
    else {
      tracking.candidateCount = tracking.candidate === read ? tracking.candidateCount + 1 : 1; tracking.candidate = read;
      if (read > previous && (tracking.candidateCount >= 2 || pips)) round = read;
      else if (read === 1 && (tracking.candidateCount >= 2 || !!pips && pips[0] + pips[1] === 0)) restart = true;
      else if (read > 1 && read < previous && tracking.candidateCount >= ROUND_LOWER_READS) { round = read; lowered = true; }
      if (round !== undefined || restart) { tracking.candidate = null; tracking.candidateCount = 0; }
    }
  }
  const phase = usable('phase') ? frame.phase : undefined;
  if (phase === 'draft') {
    const stage = usable('pickStage') ? frame.pickStage ?? null : null;
    // A new match's first draft, before any combat or round title, is round 1's (real 2026-11-01 match: 53 s without a round).
    if (tracking.matchStart && stage !== null && read === null && previous === null) { round = 1; inferred = true; }
    if (tracking.combatSinceDraft && stage !== null) {
      if (stage === 1 && read === null && previous !== null && tracking.roundAtLastDraft === previous && previous < MAX_STREET_BRAWL_ROUNDS
        && tracking.lastDraftAt !== null && frame.capturedAt - tracking.lastDraftAt <= ROUND_DRAFT_MAX_GAP_MS) {
        round = previous + 1; inferred = true;
      }
      tracking.combatSinceDraft = false;
    }
    // A draft's first frames can come before its "Choice N of 3" label is read (real 2026-11-01 logs): the
    // previous draft's time and round are kept until the label decides whether this draft opens a new round.
    if (!tracking.combatSinceDraft) { tracking.lastDraftAt = frame.capturedAt; tracking.roundAtLastDraft = round ?? previous; }
  } else if (phase === 'combat' && (tracking.lastDraftAt === null || frame.capturedAt - tracking.lastDraftAt >= ROUND_DRAFT_GAP_MS)) {
    tracking.combatSinceDraft = true;
  }
  if (phase === 'combat' || previous !== null || round !== undefined || restart) tracking.matchStart = false;
  // A lowered round also lowers the round of the last draft, so the next round's draft still advances it.
  if (lowered && round !== undefined && tracking.roundAtLastDraft !== null && tracking.roundAtLastDraft > round) tracking.roundAtLastDraft = round;
  if (round !== undefined && round !== previous) tracking.inferredAt = inferred ? frame.capturedAt : null;
  let scores: [number, number] | undefined;
  const current = round ?? previous;
  if (pips && current !== null && pipsFitRound(pips, current)) {
    const old = state.scores;
    if (!old || pips[0] >= old[0] && pips[1] >= old[1]) { scores = [pips[0], pips[1]]; tracking.scoreCandidate = null; tracking.scoreCandidateCount = 0; }
    else {
      tracking.scoreCandidateCount = equal(tracking.scoreCandidate, pips) ? tracking.scoreCandidateCount + 1 : 1;
      tracking.scoreCandidate = [pips[0], pips[1]];
      if (tracking.scoreCandidateCount >= SCORE_LOWER_READS) { scores = [pips[0], pips[1]]; tracking.scoreCandidate = null; tracking.scoreCandidateCount = 0; }
    }
  }
  return { round, inferred, restart, lowered, scores, tracking };
}

/**
 * A new match was recognized another way (its loading screen, a new match number or your hero changing): forget
 * the old match's round, score, draft stage and round evidence. Unlike resetScreenMatchContext this keeps the
 * reader session, so the new match's frames still apply. (2026-10-18 review: a match left before its post-match
 * screen gave the next match round 4 from its first draft, ignored its "ROUND 2", and kept the old 1-1 score.)
 */
/** @param loadingSeen the new match's loading screen is on screen, so its first draft will be round 1's. */
export function forgetMatchRound(context: ScreenMatchContext, loadingSeen = false): ScreenMatchContext {
  // A start seen just before (no combat or round since) still holds: the loading screen can name your hero a moment later.
  const matchStart = loadingSeen || !!context.roundTracking?.matchStart;
  if (context.round === null && context.scores === null && context.pickStage === null && !context.roundTracking && !matchStart) return context;
  return { ...context, round: null, scores: null, pickStage: null, roundTracking: { ...initialTracking(), ...(matchStart ? { matchStart } : {}) },
    observations: { ...context.observations, round: null, scores: null, pickStage: null } };
}

/** Atomic merge of one visible frame. Omission is unknown, not an empty inventory or rank zero. */
export function reduceScreenMatchContext(state: ScreenMatchContext, frame: ScreenMatchObservation, now = Date.now()): ScreenMatchContext {
  if (!frameValid(frame, now) || state.retiredSessionIds.includes(frame.sessionId)
    || frame.gameSessionId && state.retiredGameSessionIds.includes(frame.gameSessionId)) return state;
  const sourceChanged = state.sessionId !== null && state.sessionId !== frame.sessionId;
  if (!sourceChanged && state.lastObservedAt !== null && frame.capturedAt <= state.lastObservedAt) return state;
  const gameChanged = frame.gameSessionId != null && state.gameSessionId !== null && state.gameSessionId !== frame.gameSessionId;
  const matchChanged = frame.matchId != null && state.matchId !== null && frame.matchId !== state.matchId;
  const finishedRestart = state.phase === 'finished' && frame.phase !== undefined && frame.phase !== 'finished' && frame.phase !== 'unknown';
  const explicitReset = !!frame.resetReason && !!frame.resetObservation && frame.resetObservation.confidence >= .94;
  const restarted = sourceChanged || gameChanged || matchChanged || finishedRestart || explicitReset;
  let decision = decideRound(restarted ? createInitialScreenMatchContext() : state, frame);
  // "ROUND 1" confirmed below the current round: a new match in the same game window.
  const roundRestart = decision.restart;
  if (roundRestart) decision = decideRound(createInitialScreenMatchContext(), frame);
  let result = restarted || roundRestart ? createInitialScreenMatchContext() : { ...state };
  // Only the round and score this frame proves (see decideRound) reach the generic field merge.
  {
    const fieldsIn = frame.fields ?? {};
    const { round: _round, scores: _scores, ...rest } = frame;
    const { round: roundObservation, scores: scoresObservation, ...otherFields } = fieldsIn;
    const fieldsOut: Partial<ScreenMatchFieldObservations> = { ...otherFields };
    const proved: ScreenMatchObservation = { ...rest, fields: fieldsOut };
    if (decision.round !== undefined) {
      const source = decision.inferred ? fieldsIn.pickStage ?? fieldsIn.phase : roundObservation;
      if (source) { proved.round = decision.round; fieldsOut.round = decision.inferred ? { ...source, method: 'layout-association', round: decision.round } : source; }
    }
    if (decision.scores && scoresObservation) { proved.scores = decision.scores; fieldsOut.scores = scoresObservation; }
    frame = proved;
  }
  result.roundTracking = decision.tracking;
  // A lowered round drops a kept score it cannot have (more wins than rounds played).
  if (decision.lowered && result.scores && result.scores[0] + result.scores[1] > decision.round!) {
    result = { ...result, scores: null, observations: { ...result.observations, scores: null } };
  }
  result = expireScreenMatchContext(result, now);
  result = { ...result, observations: { ...result.observations }, sessionId: frame.sessionId,
    gameSessionId: frame.gameSessionId ?? result.gameSessionId,
    retiredSessionIds: sourceChanged ? retire(state.retiredSessionIds, state.sessionId) : [...state.retiredSessionIds],
    retiredGameSessionIds: gameChanged ? retire(state.retiredGameSessionIds, state.gameSessionId) : [...state.retiredGameSessionIds] };
  const ownChanged = (frame.localHeroId != null && result.localHeroId !== null && frame.localHeroId !== result.localHeroId)
    || (frame.localSeat != null && result.localSeat !== null && frame.localSeat !== result.localSeat)
    || frame.viewMode === 'spectator';
  if (ownChanged) result = clearOwn(result);
  const previousRound = result.round;
  const previousPhase = result.phase;
  for (const field of fields) {
    const observation = frame.fields?.[field];
    if (!has(frame, field) || !observation || observation.confidence < 0.85) continue;
    if (['localSeat', 'localHeroId', 'localTeam', 'localAbilityPoints'].includes(field) && result.viewMode !== 'participant') continue;
    const value = field === 'scores' && frame.scores ? [...frame.scores] : frame[field] ?? null;
    Object.assign(result, { [field]: value });
    result.observations[field] = confirmed(observation, result.observations[field], !equal(state[field], value));
  }
  if (state.localAbilityPoints !== null && result.localAbilityPoints !== null && result.localAbilityPoints < state.localAbilityPoints
    && frame.fields?.localAbilityPoints && result.viewMode === 'participant') {
    // A lower visible own budget proves something was spent, but not which tier.
    // Historical ranks survive for inspection and cannot authorize another spend.
    result.localAbilities = result.localAbilities.map(ability => ({ ...ability,
      observation: { ...ability.observation, invalidatedAt: frame.capturedAt } }));
    if (result.abilityObservation) result.abilityObservation = { ...result.abilityObservation, invalidatedAt: frame.capturedAt };
    if (result.abilityCompleteness === 'complete') result.abilityCompleteness = 'partial';
    result.abilityRevision++;
  }
  // A buy/draft/round transition can change unseen ownership or investment.
  // Keep positive facts and their age; discard claims of complete current absence.
  if (previousRound !== null && result.round !== previousRound || previousPhase !== result.phase && (result.phase === 'draft' || previousPhase === 'draft')) {
    if (result.localInventoryCompleteness === 'complete') result.localInventoryCompleteness = 'partial';
    if (result.localInventorySlotCompleteness === 'complete') result.localInventorySlotCompleteness = 'partial';
    if (result.abilityCompleteness === 'complete') result.abilityCompleteness = 'partial';
    result.players = result.players.map(player => ({ ...player,
      inventoryCompleteness: player.inventoryCompleteness === 'complete' ? 'partial' : player.inventoryCompleteness,
      inventorySlotCompleteness: player.inventorySlotCompleteness === 'complete' ? 'partial' : player.inventorySlotCompleteness }));
  }
  if (frame.players !== undefined && frame.rosterCompleteness !== 'unknown') {
    const complete = frame.rosterCompleteness === 'complete' && frame.rosterObservation && frame.rosterObservation.confidence >= 0.85
      && frame.players.length === 8 && frame.players.filter(player => player.team === 0 && player.teamObservation).length === 4
      && frame.players.filter(player => player.team === 1 && player.teamObservation).length === 4
      && frame.players.every(player => player.heroId && player.heroObservation && player.heroObservation.confidence >= 0.85);
    const oldPlayers = result.players;
    const map = new Map<number, ScreenObservedPlayer>(complete ? [] : oldPlayers.map(player => [player.seat, player]));
    for (const player of frame.players) map.set(player.seat, mergePlayer(oldPlayers.find(value => value.seat === player.seat), player));
    result.players = [...map.values()].sort((a, b) => a.seat - b.seat);
    if (frame.rosterObservation) {
      const coverage = complete ? 'complete' : 'partial';
      result.rosterObservation = confirmed(frame.rosterObservation, result.rosterObservation, coverage !== result.rosterCompleteness
        || !equal(oldPlayers.map(player => [player.seat, player.heroId, player.team]), result.players.map(player => [player.seat, player.heroId, player.team])));
      result.rosterCompleteness = coverage;
    }
  }
  // Own fields require an actual participant proof; spectator/unknown HUD data are not promoted to local ownership.
  if (result.viewMode === 'participant') {
    if (frame.localInventory !== undefined && frame.localInventoryObservation && frame.localInventoryCompleteness !== 'unknown') {
      const coverage = inventoryCoverage(frame.localInventory, frame.localInventoryCompleteness ?? 'partial', frame.localInventoryObservation);
      const requestedSlots = frame.localInventorySlotCompleteness ?? coverage;
      const slotCoverage = requestedSlots === 'complete' && !frame.localInventory.every(usableItem) ? 'partial' : requestedSlots;
      const inventory = mergeInventory(result.localInventory, frame.localInventory, slotCoverage, frame.localInventoryObservation);
      const changed = !equal(result.localInventory.map(itemIdentity), inventory.map(itemIdentity)) || coverage !== result.localInventoryCompleteness
        || slotCoverage !== result.localInventorySlotCompleteness;
      result.localInventoryObservation = confirmed(frame.localInventoryObservation, result.localInventoryObservation, changed);
      result.localInventory = inventory; result.localInventoryCompleteness = coverage; result.localInventorySlotCompleteness = slotCoverage;
      result.localInventoryRevision += changed ? 1 : 0;
    }
    if (frame.localAbilities !== undefined && frame.abilityObservation && frame.abilityCompleteness !== 'unknown') {
      const abilities = mergeAbilities(result.localAbilities, frame.localAbilities, frame.abilityCompleteness ?? 'partial', frame.abilityObservation);
      const coverage = frame.abilityCompleteness === 'complete' && frame.abilityObservation.confidence >= .85 && abilities.length === 4 && frame.localAbilities.length === 4
        && frame.localAbilities.every(ability => ability.rank !== null && ability.unlocked !== null && ability.observation.confidence >= 0.85) ? 'complete' : 'partial';
      const identity = (values: ScreenAbilityState[]) => values.map(ability => [ability.slot, ability.abilityId, ability.rank, ability.unlocked, ability.nextUpgradeCost ?? null]);
      const changed = coverage !== result.abilityCompleteness || !equal(identity(result.localAbilities), identity(abilities));
      result.abilityObservation = confirmed(frame.abilityObservation, result.abilityObservation, changed);
      result.localAbilities = abilities; result.abilityCompleteness = coverage; result.abilityRevision += changed ? 1 : 0;
    }
  } else if (frame.viewMode === 'spectator') result = clearOwn(result);
  if (result.phase === 'finished') {
    result.localInventoryCompleteness = 'unknown'; result.abilityCompleteness = 'unknown';
    result.rerollsRemaining = null; result.rerollAvailable = null; result.pickStage = null; result.deadlineAt = null;
  }
  if (result.phase !== 'draft') {
    for (const field of ['rerollsRemaining', 'rerollAvailable', 'pickStage', 'deadlineAt'] as const) {
      result[field] = null; result.observations[field] = null;
    }
  }
  result.lastObservedAt = frame.capturedAt;
  result.revision = state.revision + (!equal(semantics(state), semantics(result)) ? 1 : 0);
  return result;
}
