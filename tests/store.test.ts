import { describe, expect, it } from 'vitest';
import {
  acceptAdvice, createInitialState, decisionBlockers, getDecisionKey,
  reduceTelemetry, sameDecisionKey,
} from '../src/core/store';
import type { MatchState, TelemetryEvent } from '../src/shared/types';
import {
  advice, CATALOG_REVISION, draft, fixtureEvents, item, MATCH_ID, match,
  MODEL_VERSION, NOW, observation, player, SESSION, source, testCatalog,
} from './fixtures';

function hydrated(): MatchState {
  return fixtureEvents().reduce(reduceTelemetry, createInitialState('live'));
}

function advised(): MatchState {
  const state = hydrated();
  const key = getDecisionKey(state, MODEL_VERSION, CATALOG_REVISION);
  expect(key).not.toBeNull();
  return acceptAdvice(state, advice(key!, { evidence: 'mechanics' }), MODEL_VERSION, CATALOG_REVISION, NOW);
}

function inventory(state: MatchState, sequence: number, fields: Partial<Extract<TelemetryEvent, { type: 'inventory' }>>): MatchState {
  return reduceTelemetry(state, {
    type: 'inventory', matchId: MATCH_ID, seat: 0, operation: 'snapshot',
    items: [], removeInstanceIds: [], complete: true, observation: observation(sequence), ...fields,
  });
}

describe('source identity and event ordering', () => {
  it('starts Live without a synthetic match or recommendation', () => {
    const state = createInitialState();
    expect(state.mode).toBe('live');
    expect(state.match).toBeNull();
    expect(state.players).toEqual([]);
    expect(state.draft).toBeNull();
    expect(state.advice).toBeNull();
    expect(state.source.status).not.toBe('connected');
  });

  it('keeps eight seat identities when bot Steam IDs are blank or repeated', () => {
    const state = hydrated();
    expect(state.players).toHaveLength(8);
    expect(new Set(state.players.map((entry) => entry.seat)).size).toBe(8);
    expect(state.players.filter((entry) => entry.steamId === '')).toHaveLength(2);
    expect(state.players.every((entry) => entry.steamId === null || typeof entry.steamId === 'string')).toBe(true);
  });

  it('rejects duplicate and older observations without mutating ownership twice', () => {
    const first = inventory(hydrated(), 4, { operation: 'add', items: [item('a')], complete: false });
    for (const sequence of [4, 3]) {
      const next = inventory(first, sequence, { operation: 'add', items: [item('b')], complete: false });
      expect(next.players[0]!.inventory).toEqual([item('a')]);
      expect(next.players[0]!.inventoryRevision).toBe(first.players[0]!.inventoryRevision);
      expect(next.counters.rejected).toBeGreaterThan(first.counters.rejected);
    }
  });

  it('gates affected guidance on a sequence gap and removes the old directive atomically', () => {
    const previous = advised();
    expect(previous.advice?.kind).toBe('pick');
    const next = inventory(previous, 6, { operation: 'add', items: [item('d')], complete: false });
    expect(next.advice).toBeNull();
    expect(next.source.continuity).toBe('gap');
    expect(decisionBlockers(next, testCatalog, NOW).length).toBeGreaterThan(0);
  });

  it('accepts a lower sequence after a provider epoch restart and rejects the retired epoch', () => {
    let state = reduceTelemetry(advised(), { type: 'source', source: source({ sessionId: 'next-session', sequence: null }) });
    expect(state.match).toBeNull();
    expect(state.players).toEqual([]);
    expect(state.advice).toBeNull();
    state = reduceTelemetry(state, { type: 'match', match: match({ observation: observation(1, { sessionId: 'next-session' }) }) });
    expect(state.match?.id).toBe(MATCH_ID);
    const stale = reduceTelemetry(state, {
      type: 'round', matchId: MATCH_ID, round: 99, phase: 'finished', scores: [99, 99], deadlineAt: null,
      observation: observation(999, { sessionId: SESSION }),
    });
    expect(stale.match?.round).toBe(1);
    expect(stale.source.sessionId).toBe('next-session');
    expect(stale.counters.rejected).toBeGreaterThan(state.counters.rejected);
  });

  it('does not allow a delayed old source registration to resurrect its epoch', () => {
    const next = reduceTelemetry(hydrated(), { type: 'source', source: source({ sessionId: 'next-session' }) });
    const stale = reduceTelemetry(next, { type: 'source', source: source({ sessionId: SESSION, sequence: 100 }) });
    expect(stale.source.sessionId).toBe('next-session');
    expect(stale.match).toBeNull();
  });

  it('rejects fields from a different provider even when the match and sequence look current', () => {
    const state = hydrated();
    const stale = inventory(state, 4, { observation: observation(4, { provider: 'other-provider' }), items: [item('a')] });
    expect(stale.players[0]!.inventory).toEqual([]);
    expect(stale.counters.rejected).toBeGreaterThan(state.counters.rejected);
  });

  it('clears dependent state for a new match and rejects late events from the previous match', () => {
    const pending = advised();
    const next = reduceTelemetry(pending, { type: 'match', match: match({ id: 'match-b', observation: observation(4) }) });
    expect(next.match?.id).toBe('match-b');
    expect(next.players).toEqual([]);
    expect(next.draft).toBeNull();
    expect(next.advice).toBeNull();
    const stale = inventory(next, 5, { items: [item('a')] });
    expect(stale.match?.id).toBe('match-b');
    expect(stale.players).toEqual([]);
    const lateMatch = reduceTelemetry(stale, { type: 'match', match: match({ observation: observation(6) }) });
    expect(lateMatch.match?.id).toBe('match-b');
  });

  it('clears roster, offers, and advice on a changed local-seat identity', () => {
    const next = reduceTelemetry(advised(), {
      type: 'match', match: match({ localSeat: 1, observation: observation(4) }),
    });
    expect(next.match?.localSeat).toBe(1);
    expect(next.players).toEqual([]);
    expect(next.draft).toBeNull();
    expect(next.advice).toBeNull();
  });

  it('preserves independent draft and roster on compatible same-match hydration', () => {
    const previous = hydrated();
    const next = reduceTelemetry(previous, { type: 'match', match: match({ observation: observation(4) }) });
    const contents = (state: MatchState) => state.players.map(({ observation: _observation, inventoryObservation: _inventory, abilityObservation: _abilities, ...values }) => values);
    expect(contents(next)).toEqual(contents(previous));
    expect(next.draft?.offers).toEqual(previous.draft?.offers);
    expect(next.draft?.generation).toBe(previous.draft?.generation);
    expect(next.draft?.observation.changedAt).toBe(previous.draft?.observation.changedAt);
    expect(next.players[0]!.inventoryObservation?.changedAt).toBe(previous.players[0]!.inventoryObservation?.changedAt);
    expect(getDecisionKey(next, MODEL_VERSION, CATALOG_REVISION)).toEqual(getDecisionKey(previous, MODEL_VERSION, CATALOG_REVISION));
    expect(next.match?.observation.sequence).toBe(4);
  });

  it('requires compatible hydration after a gap before current fields become complete again', () => {
    let state = inventory(hydrated(), 6, { operation: 'add', items: [item('d')], complete: false });
    expect(state.source.continuity).toBe('gap');
    expect(state.draft).toBeNull();
    expect(state.players[0]!.inventoryCompleteness).toBe('unknown');
    state = reduceTelemetry(state, { type: 'source', source: source({ sequence: 6 }) });
    expect(decisionBlockers(state, testCatalog, NOW).length).toBeGreaterThan(0);
    state = reduceTelemetry(state, { type: 'match', match: match({ observation: observation(7) }) });
    state = reduceTelemetry(state, { type: 'roster', matchId: MATCH_ID, complete: true, players: Array.from({ length: 8 }, (_, seat) => player(seat, { observation: observation(8), inventoryObservation: observation(8), abilityObservation: observation(8) })), observation: observation(8) });
    state = reduceTelemetry(state, { type: 'draft', matchId: MATCH_ID, draft: draft({ generation: 2, observation: observation(9) }) });
    expect(decisionBlockers(state, testCatalog, NOW)).toEqual([]);
  });

  it('uses a reset to clear synthetic state before returning to Live', () => {
    const synthetic = { ...advised(), mode: 'demo' as const };
    const reset = reduceTelemetry(synthetic, { type: 'reset', reason: 'Exit Demo', at: NOW });
    const live = { ...reset, mode: 'live' as const };
    expect(live.match).toBeNull();
    expect(live.players).toEqual([]);
    expect(live.draft).toBeNull();
    expect(live.advice).toBeNull();
  });
});

describe('inventory and ability semantics', () => {
  it('replaces complete snapshots, preserves additive deltas, and marks incomplete hydration partial', () => {
    let state = inventory(hydrated(), 4, { items: [item('a'), item('b'), item('c')] });
    state = inventory(state, 5, { operation: 'add', items: [item('d')], complete: false });
    expect(state.players[0]!.inventory.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(state.players[0]!.inventoryCompleteness).toBe('complete');
    state = inventory(state, 6, { operation: 'snapshot', items: [item('e')], complete: false });
    expect(state.players[0]!.inventory.some((entry) => entry.id === 'e')).toBe(true);
    expect(state.players[0]!.inventoryCompleteness).toBe('partial');
    state = inventory(state, 7, { items: [item('b')], complete: true });
    expect(state.players[0]!.inventory).toEqual([item('b')]);
    expect(state.players[0]!.inventoryCompleteness).toBe('complete');
  });

  it('removes and upgrades a specific instance while retaining unrelated ownership', () => {
    let state = inventory(hydrated(), 4, { items: [item('a'), item('b'), item('c')] });
    const revision = state.players[0]!.inventoryRevision;
    state = inventory(state, 5, { operation: 'remove', removeInstanceIds: ['instance-a'], complete: false });
    expect(state.players[0]!.inventory.map((entry) => entry.instanceId)).toEqual(['instance-b', 'instance-c']);
    const enhanced = item('b', 'instance-b-plus', { variant: 'enhanced', bonusIds: ['d'], modifierBits: 'fixture-modifier' });
    state = inventory(state, 6, { operation: 'replace', items: [enhanced], removeInstanceIds: ['instance-b'], complete: false });
    expect(state.players[0]!.inventory).toContainEqual(item('c'));
    expect(state.players[0]!.inventory).toContainEqual(enhanced);
    expect(state.players[0]!.inventory).toHaveLength(2);
    expect(state.players[0]!.inventoryRevision).toBeGreaterThan(revision);
  });

  it('does not collapse different instances of the same item ID', () => {
    const state = inventory(hydrated(), 4, { items: [item('a', 'first'), item('a', 'second')] });
    expect(state.players[0]!.inventory).toHaveLength(2);
  });

  it.each([
    { operation: 'add' as const, items: [item('b', 'instance-a')], removeInstanceIds: [] },
    { operation: 'remove' as const, items: [], removeInstanceIds: ['not-owned'] },
    { operation: 'replace' as const, items: [item('b')], removeInstanceIds: ['not-owned'] },
  ])('invalidates a contradictory ownership delta instead of preserving a complete claim: $operation', (delta) => {
    const owned = inventory(hydrated(), 4, { items: [item('a')] });
    const key = getDecisionKey(owned, MODEL_VERSION, CATALOG_REVISION)!;
    const previous = acceptAdvice(owned, advice(key, { evidence: 'mechanics' }), MODEL_VERSION, CATALOG_REVISION, NOW);
    expect(previous.advice?.kind).toBe('pick');
    const next = inventory(previous, 5, { ...delta, complete: false });
    expect(next.advice).toBeNull();
    expect(next.draft).toBeNull();
    expect(next.source.continuity).toBe('gap');
    expect(next.source.sequence).toBe(5);
    expect(next.players[0]!.inventoryCompleteness).toBe('unknown');
    expect(next.players[0]!.inventory).toEqual([item('a')]);
  });

  it('treats an exactly repeated additive instance as an unchanged confirmation', () => {
    const previous = inventory(hydrated(), 4, { items: [item('a')] });
    const next = inventory(previous, 5, { operation: 'add', items: [item('a')], complete: false });
    expect(next.players[0]!.inventory).toEqual([item('a')]);
    expect(next.players[0]!.inventoryRevision).toBe(previous.players[0]!.inventoryRevision);
    expect(next.players[0]!.inventoryCompleteness).toBe('complete');
    expect(next.source.continuity).toBe('continuous');
  });

  it('preserves unknown ownership distinctly from a confirmed empty inventory', () => {
    let state = fixtureEvents().map((event) => event.type === 'roster' ? {
      ...event,
      players: event.players.map((entry) => ({ ...entry, inventoryCompleteness: 'unknown' as const, inventoryObservation: null })),
    } : event).reduce(reduceTelemetry, createInitialState('live'));
    expect(state.players[0]!.inventoryCompleteness).toBe('unknown');
    state = inventory(state, 4, { items: [], complete: true });
    expect(state.players[0]!.inventory).toEqual([]);
    expect(state.players[0]!.inventoryCompleteness).toBe('complete');
  });

  it('does not erase an independently confirmed inventory when roster hydration omits that field', () => {
    const previous = inventory(hydrated(), 4, { items: [item('a')] });
    const next = reduceTelemetry(previous, {
      type: 'roster', matchId: MATCH_ID, complete: false, observation: observation(5),
      players: [player(0, { inventoryCompleteness: 'unknown', inventoryObservation: null, abilityCompleteness: 'unknown', abilityObservation: null })],
    });
    expect(next.players[0]!.inventory).toEqual([item('a')]);
    expect(next.players[0]!.inventoryCompleteness).toBe('complete');
    expect(next.players[0]!.inventoryRevision).toBe(previous.players[0]!.inventoryRevision);
  });

  it('accepts eight distinct sparse source slots with a local player outside slots zero through seven', () => {
    const slots = [0, 1, 2, 3, 6, 7, 8, 9];
    let state = createInitialState('live');
    state = reduceTelemetry(state, { type: 'source', source: source() });
    state = reduceTelemetry(state, { type: 'match', match: match({ localSeat: 9, localTeam: 1 }) });
    state = reduceTelemetry(state, { type: 'roster', matchId: MATCH_ID, complete: true, observation: observation(2), players: slots.map((seat) => player(seat, { isLocal: seat === 9 })) });
    state = reduceTelemetry(state, { type: 'draft', matchId: MATCH_ID, draft: draft() });
    expect(state.players.map((entry) => entry.seat)).toEqual(slots);
    expect(state.match?.localSeat).toBe(9);
    expect(decisionBlockers(state, testCatalog, NOW)).toEqual([]);
  });

  it('advances identical confirmation without changing the inventory revision or original changed time', () => {
    const first = inventory(hydrated(), 4, { items: [item('a')] });
    const next = inventory(first, 5, {
      items: [item('a')],
      observation: observation(5, { receivedAt: NOW + 50, observedAt: NOW + 40, changedAt: NOW + 40, confirmedAt: NOW + 40 }),
    });
    expect(next.players[0]!.inventoryRevision).toBe(first.players[0]!.inventoryRevision);
    expect(next.players[0]!.inventoryObservation?.changedAt).toBe(first.players[0]!.inventoryObservation?.changedAt);
    expect(next.players[0]!.inventoryObservation?.confirmedAt).toBeGreaterThan(first.players[0]!.inventoryObservation?.confirmedAt ?? -1);
  });

  it('preserves explicitly unknown change and confirmation times', () => {
    const first = inventory(hydrated(), 4, {
      items: [item('a')], observation: observation(4, { changedAt: null, confirmedAt: null }),
    });
    expect(first.players[0]!.inventoryObservation?.changedAt).toBeNull();
    expect(first.players[0]!.inventoryObservation?.confirmedAt).toBeNull();
    const unchanged = inventory(first, 5, {
      items: [item('a')], observation: observation(5, { observedAt: NOW + 40, changedAt: null, confirmedAt: null }),
    });
    expect(unchanged.players[0]!.inventoryObservation?.changedAt).toBeNull();
    expect(unchanged.players[0]!.inventoryObservation?.confirmedAt).toBeNull();
  });

  it('does not promote completed purchase history to current ownership', () => {
    const state = reduceTelemetry(hydrated(), {
      type: 'purchases', matchId: MATCH_ID, seat: 0, complete: true,
      items: [{ itemId: 'a', gameTime: 12 }], observation: observation(4),
    });
    expect(state.players[0]!.purchasedHistory).toEqual([{ itemId: 'a', gameTime: 12 }]);
    expect(state.players[0]!.inventory).toEqual([]);
  });

  it('invalidates guidance when actual local ranks change without changing draft generation', () => {
    const old = advised();
    const next = reduceTelemetry(old, {
      type: 'abilities', matchId: MATCH_ID, seat: 0, complete: true,
      abilities: [{ id: 'ability-a', rank: 1, unlocked: true }], observation: observation(4),
    });
    expect(next.draft?.generation).toBe(old.draft?.generation);
    expect(next.players[0]!.abilityRevision).toBeGreaterThan(old.players[0]!.abilityRevision);
    expect(next.advice).toBeNull();
    expect(acceptAdvice(next, old.advice!, MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });

  it('invalidates guidance when local ownership changes without changing draft generation', () => {
    const old = advised();
    const next = inventory(old, 4, { items: [item('d')] });
    expect(next.draft?.generation).toBe(old.draft?.generation);
    expect(next.advice).toBeNull();
    expect(acceptAdvice(next, old.advice!, MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });
});

describe('decision validity and atomic transitions', () => {
  it('has no blockers for the complete, fresh synthetic contract fixture', () => {
    expect(decisionBlockers(hydrated(), testCatalog, NOW)).toEqual([]);
    expect(advised().advice?.kind).toBe('pick');
  });

  it.each(['pick', 'reroll', 'draft_closed'] as const)('clears advice on %s without inventing owned items', (action) => {
    const previous = advised();
    const next = reduceTelemetry(previous, { type: 'action', matchId: MATCH_ID, action, observation: observation(4) });
    expect(next.advice).toBeNull();
    expect(next.players[0]!.inventory).toEqual(previous.players[0]!.inventory);
  });

  it.each(['pick', 'reroll', 'draft_closed'] as const)('does not let a cached draft resurrect the generation closed by %s', (action) => {
    const closed = reduceTelemetry(advised(), { type: 'action', matchId: MATCH_ID, action, observation: observation(4) });
    expect(closed.draft).toBeNull();
    const stale = reduceTelemetry(closed, { type: 'draft', matchId: MATCH_ID, draft: draft({ observation: observation(5) }) });
    expect(stale.draft).toBeNull();
    expect(stale.advice).toBeNull();
    const newGeneration = reduceTelemetry(closed, { type: 'draft', matchId: MATCH_ID, draft: draft({ generation: 2, observation: observation(5) }) });
    expect(newGeneration.draft?.generation).toBe(2);
  });

  it('allows the same draft ID and generation in a newly confirmed round', () => {
    let state = reduceTelemetry(hydrated(), { type: 'action', matchId: MATCH_ID, action: 'draft_closed', observation: observation(4) });
    state = reduceTelemetry(state, { type: 'round', matchId: MATCH_ID, round: 2, phase: 'draft', scores: [1, 0], deadlineAt: NOW + 30_000, observation: observation(5) });
    state = reduceTelemetry(state, { type: 'draft', matchId: MATCH_ID, draft: draft({ round: 2, observation: observation(6) }) });
    expect(state.match?.round).toBe(2);
    expect(state.draft?.round).toBe(2);
    expect(state.draft?.generation).toBe(1);
  });

  it('retains the closed generation when the closing action also exposes a sequence gap', () => {
    let state = reduceTelemetry(hydrated(), { type: 'action', matchId: MATCH_ID, action: 'pick', observation: observation(5) });
    expect(state.source.continuity).toBe('gap');
    expect(state.draft).toBeNull();
    state = reduceTelemetry(state, { type: 'source', source: source({ sequence: 5 }) });
    state = reduceTelemetry(state, { type: 'roster', matchId: MATCH_ID, complete: true, observation: observation(6), players: Array.from({ length: 8 }, (_, seat) => player(seat, { observation: observation(6), inventoryObservation: observation(6), abilityObservation: observation(6) })) });
    const cached = reduceTelemetry(state, { type: 'draft', matchId: MATCH_ID, draft: draft({ observation: observation(7) }) });
    expect(cached.draft).toBeNull();
    expect(cached.advice).toBeNull();
  });

  it('rejects an old-round cached draft despite a larger generation and transport sequence', () => {
    const current = reduceTelemetry(hydrated(), { type: 'round', matchId: MATCH_ID, round: 2, phase: 'draft', scores: [1, 0], deadlineAt: NOW + 30_000, observation: observation(4) });
    const stale = reduceTelemetry(current, { type: 'draft', matchId: MATCH_ID, draft: draft({ round: 1, generation: 99, observation: observation(5) }) });
    expect(stale.match?.round).toBe(2);
    expect(stale.draft).toBeNull();
  });

  it('rejects a live draft without an explicitly observed round association', () => {
    const waiting = fixtureEvents().slice(0, 3).reduce(reduceTelemetry, createInitialState('live'));
    const missing = reduceTelemetry(waiting, { type: 'draft', matchId: MATCH_ID, draft: draft({ round: undefined }) });
    expect(missing.draft).toBeNull();
    expect(missing.counters.rejected).toBeGreaterThan(waiting.counters.rejected);
  });

  it('preserves game positions and rejects a worker from an expired offer generation', () => {
    const previous = advised();
    const next = reduceTelemetry(previous, {
      type: 'draft', matchId: MATCH_ID,
      draft: draft({ generation: 2, observation: observation(4), offers: draft().offers.slice().reverse() }),
    });
    expect(next.advice).toBeNull();
    expect(next.draft?.offers.map((offer) => offer.position)).toEqual([2, 1, 0]);
    expect(acceptAdvice(next, previous.advice!, MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });

  it('rejects a lower draft generation despite a larger transport sequence', () => {
    const current = reduceTelemetry(hydrated(), { type: 'draft', matchId: MATCH_ID, draft: draft({ generation: 4, observation: observation(4) }) });
    const stale = reduceTelemetry(current, { type: 'draft', matchId: MATCH_ID, draft: draft({ generation: 3, observation: observation(5) }) });
    expect(stale.draft?.generation).toBe(4);
  });

  it('clears guidance on combat and cannot restore a pending draft worker', () => {
    const previous = advised();
    const next = reduceTelemetry(previous, {
      type: 'round', matchId: MATCH_ID, round: 1, phase: 'combat', scores: [0, 0], deadlineAt: null,
      observation: observation(4),
    });
    expect(next.advice).toBeNull();
    expect(acceptAdvice(next, previous.advice!, MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });

  it('rejects an otherwise current worker arriving at or after the confirmed deadline', () => {
    const current = hydrated();
    const pending = advice(getDecisionKey(current, MODEL_VERSION, CATALOG_REVISION)!, { evidence: 'mechanics' });
    expect(acceptAdvice(current, pending, MODEL_VERSION, CATALOG_REVISION, NOW + 30_000).advice).toBeNull();
    expect(decisionBlockers(current, testCatalog, NOW + 30_000).length).toBeGreaterThan(0);
  });

  it('clears advice after disconnect and refuses the pending worker', () => {
    const previous = advised();
    const next = reduceTelemetry(previous, { type: 'source', source: source({ status: 'interrupted', sequence: 3, continuity: 'gap' }) });
    expect(next.advice).toBeNull();
    expect(acceptAdvice(next, previous.advice!, MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });

  it('withholds a changed game build and rejects the old worker', () => {
    const previous = advised();
    const next = reduceTelemetry(previous, { type: 'match', match: match({ clientVersion: 'different-build', observation: observation(4) }) });
    expect(next.advice).toBeNull();
    expect(decisionBlockers(next, testCatalog, NOW).length).toBeGreaterThan(0);
    expect(acceptAdvice(next, previous.advice!, MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });

  it('matches the whole worker key including epoch, catalogue revision, model and rank revisions', () => {
    const key = getDecisionKey(hydrated(), MODEL_VERSION, CATALOG_REVISION)!;
    expect(key.sourceSessionId).toBe(SESSION);
    expect(key.catalogRevision).toBe(CATALOG_REVISION);
    expect(sameDecisionKey(key, { ...key })).toBe(true);
    for (const changed of [
      { sourceSessionId: 'other' }, { catalogRevision: 'other' }, { modelVersion: 'other' },
      { matchId: 'other' }, { round: 2 }, { draftId: 'other' }, { generation: 2 },
      { inventoryRevision: 1 }, { abilityRevision: 1 },
      { contextRevision: (key.contextRevision ?? 0) + 1 },
    ]) expect(sameDecisionKey(key, { ...key, ...changed })).toBe(false);
  });

  it('rejects pending work after score context changes without a new offer generation', () => {
    const previous = advised();
    const next = reduceTelemetry(previous, {
      type: 'round', matchId: MATCH_ID, round: 1, phase: 'draft', scores: [1, 0],
      deadlineAt: NOW + 30_000, observation: observation(4),
    });
    expect(next.advice).toBeNull();
    expect(acceptAdvice(next, previous.advice!, MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });

  it('rejects a worker built for a different catalogue or model', () => {
    const state = hydrated();
    const key = getDecisionKey(state, MODEL_VERSION, CATALOG_REVISION)!;
    for (const changed of [{ catalogRevision: 'other' }, { modelVersion: 'other' }]) {
      expect(acceptAdvice(state, advice({ ...key, ...changed }, { evidence: 'mechanics' }), MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
    }
  });

  it('does not mutate a prior reducer snapshot', () => {
    const old = hydrated();
    const saved = structuredClone(old);
    inventory(old, 4, { items: [item('a')] });
    expect(old).toEqual(saved);
  });

  it('refuses to attach a synthetic scorer result to a Live match', () => {
    const state = hydrated();
    const key = getDecisionKey(state, MODEL_VERSION, CATALOG_REVISION)!;
    expect(acceptAdvice(state, advice(key, { evidence: 'synthetic' }), MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });
});

describe('missing evidence and age gates', () => {
  it('clears an existing directive when unchanged inventory is confirmed only by a cached old observation', () => {
    const previous = advised();
    const cached = inventory(previous, 4, {
      items: previous.players[0]!.inventory,
      observation: observation(4, { observedAt: NOW - 90_000, changedAt: NOW - 90_000, confirmedAt: NOW - 90_000 }),
    });
    expect(cached.players[0]!.inventory).toEqual(previous.players[0]!.inventory);
    expect(cached.players[0]!.inventoryRevision).toBe(previous.players[0]!.inventoryRevision);
    expect(cached.players[0]!.inventoryObservation?.confirmedAt).toBe(NOW - 90_000);
    expect(cached.advice).toBeNull();
  });

  it('refuses a worker matching the current key when local inventory confirmation is stale', () => {
    const current = inventory(hydrated(), 4, {
      items: [], observation: observation(4, { observedAt: NOW - 90_000, changedAt: NOW - 90_000, confirmedAt: NOW - 90_000 }),
    });
    const key = getDecisionKey(current, MODEL_VERSION, CATALOG_REVISION);
    expect(key).not.toBeNull();
    const pending = advice(key!, { evidence: 'mechanics', computedAt: NOW });
    expect(acceptAdvice(current, pending, MODEL_VERSION, CATALOG_REVISION, NOW).advice).toBeNull();
  });

  it('does not freshen a 90-second-old game observation when a heartbeat arrives now', () => {
    let state = hydrated();
    state = reduceTelemetry(state, { type: 'draft', matchId: MATCH_ID, draft: draft({ generation: 2, observation: observation(4, { observedAt: NOW - 90_000, changedAt: NOW - 90_000, confirmedAt: NOW - 90_000 }) }) });
    state = reduceTelemetry(state, { type: 'source', source: source({ sequence: 4, lastReceivedAt: NOW, deliveryBoundMs: null }) });
    expect(state.draft?.observation.observedAt).toBe(NOW - 90_000);
    expect(decisionBlockers(state, testCatalog, NOW).length).toBeGreaterThan(0);
  });

  it('keeps live age unknown without a mapped origin clock or documented delivery bound', () => {
    const state = hydrated();
    state.source.deliveryBoundMs = null;
    state.match!.observation.observedAt = null;
    state.match!.observation.clockUncertaintyMs = null;
    state.draft!.observation.observedAt = null;
    state.draft!.observation.clockUncertaintyMs = null;
    expect(state.source.status).toBe('connected');
    expect(state.source.continuity).toBe('continuous');
    expect(decisionBlockers(state, testCatalog, NOW).length).toBeGreaterThan(0);
  });

  it('does not freshen a repeated source watermark while keeping unchanged game observations', () => {
    const first = reduceTelemetry(hydrated(), { type: 'source', source: source({ sequence: 3, lastReceivedAt: NOW }) });
    const next = reduceTelemetry(first, { type: 'source', source: source({ sequence: 3, lastReceivedAt: NOW + 90_000 }) });
    expect(next.source.lastReceivedAt).toBe(first.source.lastReceivedAt);
    expect(next.draft?.observation.observedAt).toBe(first.draft?.observation.observedAt);
  });

  it.each([
    ['own offers unverified', (state: MatchState) => { state.source.capabilities = state.source.capabilities.map((value) => value.name === 'own_draft_offers' ? { ...value, verified: false } : value); }],
    ['round capability unverified', (state: MatchState) => { state.source.capabilities = state.source.capabilities.map((value) => value.name === 'street_brawl_round' ? { ...value, verified: false } : value); }],
    ['acquisition method unverified', (state: MatchState) => { state.source.noImageMethodVerified = false; }],
    ['source session unknown', (state: MatchState) => { state.source.sessionId = null; }],
    ['upstream sequence unproven', (state: MatchState) => { state.source.sequenceKind = 'local'; }],
    ['visibility unknown', (state: MatchState) => { state.draft!.observation.visibility = 'unknown'; }],
    ['draft from old session', (state: MatchState) => { state.draft!.observation.sessionId = 'old-session'; }],
    ['mode unknown', (state: MatchState) => { state.match!.mode = 'unknown'; }],
    ['local identity unknown', (state: MatchState) => { state.match!.localSeat = null; }],
    ['local team unknown', (state: MatchState) => { state.match!.localTeam = null; }],
    ['deadline unknown', (state: MatchState) => { state.match!.deadlineAt = null; }],
    ['empty offers', (state: MatchState) => { state.draft!.offers = []; }],
    ['unknown item ID', (state: MatchState) => { state.draft!.offers[0]!.item.id = 'not-in-catalog'; }],
    ['unknown bonus item ID', (state: MatchState) => { state.draft!.offers[0]!.item.bonusIds = ['not-in-catalog']; }],
    ['unknown modifier bits', (state: MatchState) => { state.draft!.offers[0]!.item.modifierBits = 'opaque'; state.draft!.offers[0]!.item.modifiersDecoded = false; }],
    ['unknown variant', (state: MatchState) => { state.draft!.offers[0]!.item.variant = 'unknown'; }],
  ])('withholds a current comparison with %s', (_label, mutate) => {
    const state = hydrated();
    mutate(state);
    expect(decisionBlockers(state, testCatalog, NOW).length).toBeGreaterThan(0);
  });

  it('gates clock uncertainty that exceeds the declared freshness budget', () => {
    const state = hydrated();
    state.draft!.observation.clockUncertaintyMs = 1_500;
    expect(decisionBlockers(state, testCatalog, NOW).length).toBeGreaterThan(0);
  });

  it('does not treat an unmapped origin clock as a known observation age', () => {
    const state = hydrated();
    state.source.deliveryBoundMs = null;
    state.draft!.observation.clockUncertaintyMs = null;
    expect(decisionBlockers(state, testCatalog, NOW).length).toBeGreaterThan(0);
  });

  it('distinguishes unknown actual rerolls and ranks from explicit zero values', () => {
    const unknown = hydrated();
    unknown.draft!.rerollsRemaining = null;
    unknown.draft!.rerollAvailable = null;
    unknown.players[0]!.abilities = [{ id: 'ability-a', rank: null, unlocked: null }];
    unknown.players[0]!.abilityCompleteness = 'unknown';
    const known = hydrated();
    known.draft!.rerollsRemaining = 0;
    known.draft!.rerollAvailable = false;
    expect(unknown.draft!.rerollsRemaining).not.toBe(known.draft!.rerollsRemaining);
    expect(unknown.players[0]!.abilities[0]!.rank).toBeNull();
    expect(known.players[0]!.abilities[0]!.rank).toBe(0);
  });
});
