import { describe, expect, it } from 'vitest';
import { createInitialScreenMatchContext, type ScreenAbilityState, type ScreenContextObservation,
  type ScreenInventoryItem, type ScreenMatchObservation } from '../src/shared/screen-reading';
import { expireScreenMatchContext, forgetMatchRound, isScreenObservationUsable, reduceScreenMatchContext, resetScreenMatchContext, screenObservationAge, SPECTATOR_HOLD_MS } from '../src/screen/match-state';

let ordinal = 0;
const START = 1_000_000;
function frame(patch: Partial<ScreenMatchObservation> = {}): ScreenMatchObservation {
  const capturedAt = START + ++ordinal * 100;
  return { sessionId: 'test-reader-a', gameSessionId: 'test-window-a', frameId: `test-frame-${ordinal}`,
    capturedAt, receivedAt: capturedAt + 10, ...patch };
}
function observation(value: ScreenMatchObservation, confidence = .98): ScreenContextObservation {
  return { sessionId: value.sessionId, frameId: value.frameId, capturedAt: value.capturedAt, receivedAt: value.receivedAt,
    method: 'layout-association', confidence, bounds: [{ x: .1, y: .1, width: .1, height: .1 }], round: value.round ?? null };
}
function item(value: ScreenMatchObservation, slot = 0, itemId = 'item-a', patch: Partial<ScreenInventoryItem> = {}): ScreenInventoryItem {
  return { slot, itemId, status: 'recognized', variant: 'base', bonusIds: [], quantity: 1, observation: observation(value), ...patch };
}
function ability(value: ScreenMatchObservation, slot: 0 | 1 | 2 | 3, rank: number | null = 0): ScreenAbilityState {
  return { slot, abilityId: `ability-${slot}`, rank, unlocked: rank === null ? null : true, nextUpgradeCost: rank === null ? null : 2, observation: observation(value) };
}
function own(patch: Partial<ScreenMatchObservation> = {}): ScreenMatchObservation {
  const value = frame({ viewMode: 'participant', phase: 'combat', round: 1, localHeroId: 'hero-a', ...patch });
  value.fields = { viewMode: observation(value), phase: observation(value), round: observation(value), localHeroId: observation(value), ...patch.fields };
  return value;
}
function reduce(state: ReturnType<typeof createInitialScreenMatchContext>, value: ScreenMatchObservation) {
  return reduceScreenMatchContext(state, value, value.receivedAt);
}
function inventory(value: ScreenMatchObservation, items: ScreenInventoryItem[], complete = true) {
  value.localInventory = items; value.localInventoryCompleteness = complete ? 'complete' : 'partial';
  value.localInventorySlotCompleteness = complete ? 'complete' : 'partial'; value.localInventoryObservation = observation(value);
  return value;
}

describe('visible match provenance and immutable context', () => {
  it('begins unknown, independently from card state', () => {
    expect(createInitialScreenMatchContext()).toMatchObject({ sessionId: null, viewMode: 'unknown', round: null, scores: null,
      localAbilityPoints: null, localInventory: [], localInventoryCompleteness: 'unknown', localAbilities: [], abilityCompleteness: 'unknown' });
  });
  it('merges a proven local HUD before its roster position is known', () => {
    const value = inventory(own(), [item(own())]);
    value.localInventory![0]!.observation = observation(value);
    const state = reduce(createInitialScreenMatchContext(), value);
    expect(state).toMatchObject({ viewMode: 'participant', localSeat: null, localHeroId: 'hero-a', localInventoryCompleteness: 'complete' });
    expect(state.localInventory[0]!.itemId).toBe('item-a');
  });
  it('does not mutate an earlier snapshot or external input', () => {
    const initial = createInitialScreenMatchContext(); const value = inventory(own(), []);
    const previous = structuredClone(initial), input = structuredClone(value);
    reduce(initial, value); expect(initial).toEqual(previous); expect(value).toEqual(input);
  });
  it.each(['sessionId', 'frameId', 'capturedAt', 'receivedAt'] as const)('rejects mixed nested %s provenance atomically', key => {
    const value = inventory(own(), []);
    Object.assign(value.localInventoryObservation!, { [key]: typeof value.localInventoryObservation![key] === 'string' ? 'retired' : value.capturedAt - 5 });
    const state = createInitialScreenMatchContext(); expect(reduce(state, value)).toBe(state);
  });
  it.each([-1, 1_000])('rejects future/stale captured pixels despite a fresh callback (%ims)', age => {
    const value = own(); const state = createInitialScreenMatchContext();
    expect(reduceScreenMatchContext(state, { ...value, receivedAt: value.capturedAt }, value.capturedAt + age)).toBe(state);
  });
  it('does not treat repeated timestamps or older frames as new confirmation', () => {
    const value = own(); const state = reduce(createInitialScreenMatchContext(), value);
    expect(reduce(state, value)).toBe(state);
    const old = { ...value, capturedAt: value.capturedAt - 100, receivedAt: value.capturedAt - 90, fields: {} };
    expect(reduceScreenMatchContext(state, old, value.receivedAt)).toBe(state);
  });
  it('refreshes confirmed time without changing semantic revision or changed time', () => {
    const first = own(); inventory(first, [item(first)]);
    const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, [item(next)]);
    const updated = reduce(state, next);
    expect(updated.revision).toBe(state.revision); expect(updated.localInventoryRevision).toBe(state.localInventoryRevision);
    expect(updated.localInventory[0]!.observation.changedAt).toBe(first.capturedAt);
    expect(updated.localInventory[0]!.observation.confirmedAt).toBe(next.capturedAt);
    expect(updated.observations.localHeroId!.changedAt).toBe(first.capturedAt);
  });
  it('retains explicit unknown changed time through identical confirmations', () => {
    const first = own(); inventory(first, [item(first, 0, 'item-a', { observation: { ...observation(first), changedAt: null } })]);
    const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, [item(next)]);
    expect(reduce(state, next).localInventory[0]!.observation.changedAt).toBeNull();
  });
});

describe('source, match, local hero and visible column resets', () => {
  it('resets build data on a new source epoch and rejects a retired epoch', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own({ sessionId: 'test-reader-b' }); const updated = reduce(state, next);
    expect(updated.localInventory).toEqual([]); expect(updated.retiredSessionIds).toContain(first.sessionId);
    const retired = own({ sessionId: first.sessionId }); expect(reduce(updated, retired)).toBe(updated);
  });
  it('resets when the native window epoch changes, without calling it a match ID', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own({ gameSessionId: 'test-window-b' }); const updated = reduce(state, next);
    expect(updated.matchId).toBeNull(); expect(updated.localInventory).toEqual([]);
    expect(updated.retiredGameSessionIds).toContain('test-window-a');
  });
  it('clears old observations on an explicit match change in the same native process', () => {
    const first = own({ matchId: 'actual-visible-1' }); first.fields!.matchId = observation(first);
    inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own({ matchId: 'actual-visible-2' }); next.fields!.matchId = observation(next);
    expect(reduce(state, next)).toMatchObject({ matchId: 'actual-visible-2', localInventory: [], localAbilities: [] });
  });
  it('round rollback starts an empty context, rather than copying a prior match build', () => {
    const first = own({ round: 5 }); inventory(first, [item(first)]);
    const state = reduce(createInitialScreenMatchContext(), first);
    // A single lower round read is a misread; "ROUND 1" read twice is a new match.
    const once = reduce(state, own({ round: 1 }));
    expect(once).toMatchObject({ round: 5 });
    expect(reduce(once, own({ round: 1 }))).toMatchObject({ round: 1, localInventory: [], players: [] });
  });
  it('clears dependent local data on a hero change and accepts the new same-frame HUD', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own({ localHeroId: 'hero-b' }); inventory(next, [item(next, 1, 'item-b')]);
    expect(reduce(state, next)).toMatchObject({ localHeroId: 'hero-b', localInventory: [expect.objectContaining({ itemId: 'item-b' })] });
  });
  it('does not carry a column inventory to a different observed hero', () => {
    const first = own(); first.players = [{ seat: 0, heroId: 'hero-a', heroObservation: observation(first), inventory: [item(first)],
      inventoryObservation: observation(first), inventoryCompleteness: 'complete' }]; first.rosterCompleteness = 'partial';
    const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); next.players = [{ seat: 0, heroId: 'hero-b', heroObservation: observation(next) }]; next.rosterCompleteness = 'partial';
    expect(reduce(state, next).players[0]).toMatchObject({ heroId: 'hero-b', inventory: [], inventoryCompleteness: 'unknown' });
  });
  it('cannot attach a new build to an unread portrait and replaces it only with a confirmed new hero', () => {
    const first = own(); first.rosterCompleteness = 'partial';
    first.players = [{ seat: 0, heroId: 'hero-a', heroObservation: observation(first), inventory: [item(first, 0, 'item-a')],
      inventoryObservation: observation(first), inventoryCompleteness: 'complete', inventorySlotCompleteness: 'complete' }];
    const state = reduce(createInitialScreenMatchContext(), first); const original = structuredClone(state.players[0]!);
    const unread = own(); unread.rosterCompleteness = 'partial';
    unread.players = [{ seat: 0, heroId: null, heroObservation: observation(unread, 0), inventory: [item(unread, 0, 'item-b')],
      inventoryObservation: observation(unread), inventoryCompleteness: 'complete', inventorySlotCompleteness: 'complete' }];
    const unbound = reduce(state, unread);
    expect(unbound.players[0]).toEqual(original);
    expect(unbound.players[0]!.inventoryObservation!.capturedAt).toBe(first.capturedAt);
    const identified = own(); identified.rosterCompleteness = 'partial';
    identified.players = [{ seat: 0, heroId: 'hero-b', heroObservation: observation(identified), inventory: [item(identified, 0, 'item-b')],
      inventoryObservation: observation(identified), inventoryCompleteness: 'partial', inventorySlotCompleteness: 'partial' }];
    const replaced = reduce(unbound, identified);
    expect(replaced.players[0]).toMatchObject({ heroId: 'hero-b', inventory: [expect.objectContaining({ itemId: 'item-b' })] });
    expect(replaced.players[0]!.inventoryObservation!.capturedAt).toBe(identified.capturedAt);
    expect(replaced.players[0]!.inventory.some(value => value.itemId === 'item-a')).toBe(false);
  });
  it.each(['omitted', 'low-confidence'] as const)('item-only %s portrait observations preserve original seat attribution and age', kind => {
    const first = own(); first.rosterCompleteness = 'partial';
    first.players = [{ seat: 0, heroId: 'hero-a', heroObservation: observation(first), inventory: [item(first)],
      inventoryObservation: observation(first), inventoryCompleteness: 'partial' }];
    const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); next.rosterCompleteness = 'partial';
    next.players = [{ seat: 0, inventory: [item(next, 1, 'item-b')], inventoryObservation: observation(next), inventoryCompleteness: 'partial',
      ...(kind === 'low-confidence' ? { heroId: 'hero-b', heroObservation: observation(next, .5) } : {}) }];
    expect(reduce(state, next).players[0]).toEqual(state.players[0]);
  });
  it('accepts partial inventory reconfirmation with a positively identified same-frame hero', () => {
    const first = own(); first.rosterCompleteness = 'partial';
    first.players = [{ seat: 0, heroId: 'hero-a', heroObservation: observation(first), inventory: [item(first)],
      inventoryObservation: observation(first), inventoryCompleteness: 'partial' }];
    const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); next.rosterCompleteness = 'partial';
    next.players = [{ seat: 0, heroId: 'hero-a', heroObservation: observation(next), inventory: [item(next)],
      inventoryObservation: observation(next), inventoryCompleteness: 'partial' }];
    const confirmed = reduce(state, next);
    expect(confirmed.players[0]!.inventory[0]!.observation.capturedAt).toBe(next.capturedAt);
    expect(confirmed.players[0]!.inventory[0]!.observation.changedAt).toBe(first.capturedAt);
    expect(confirmed.players[0]!.inventoryRevision).toBe(state.players[0]!.inventoryRevision);
  });
  it('resets the next active view after a finished match', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const ended = reduce(state, own({ phase: 'finished' }));
    expect(reduce(ended, own({ phase: 'combat' }))).toMatchObject({ localInventory: [], localAbilities: [], players: [] });
  });
  it('fully resets and retires a source when explicitly disabled', () => {
    const state = reduce(createInitialScreenMatchContext(), own()); const reset = resetScreenMatchContext(state);
    expect(reset).toMatchObject({ sessionId: null, localHeroId: null, viewMode: 'unknown', revision: state.revision + 1 });
    expect(reset.retiredSessionIds).toContain(state.sessionId);
  });
  it('a strongly proven incompatible layout resets match facts without retiring its still-running reader', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = frame({ resetReason: 'unsupported-layout' }); next.resetObservation = observation(next);
    const reset = reduce(state, next);
    expect(reset).toMatchObject({ sessionId: first.sessionId, gameSessionId: first.gameSessionId, localHeroId: null, localInventory: [], players: [] });
    expect(reset.retiredSessionIds).not.toContain(first.sessionId);
  });
  it('an unsupported prediction without positive reset evidence cannot erase a known build', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = frame({ resetReason: 'unsupported-layout' }); next.resetObservation = observation(next, 0);
    expect(reduce(state, next).localInventory).toEqual(state.localInventory);
  });
});

describe('slot coverage, unknown values, and aged positive evidence', () => {
  it('an omitted inventory preserves its historical positive observation', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = reduce(state, own()); expect(next.localInventory).toEqual(state.localInventory);
    expect(next.localInventoryObservation).toEqual(state.localInventoryObservation);
  });
  it('partial known slots merge; omitted slots are never interpreted as empty', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, [item(next, 1, 'item-b')], false);
    expect(reduce(state, next).localInventory.map(value => value.itemId)).toEqual(['item-a', 'item-b']);
  });
  it('proven full slot coverage removes absent old slots even with unknown modifiers', () => {
    const first = own(); inventory(first, [item(first), item(first, 1, 'item-b')]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, [item(next, 0, 'item-c', { variant: 'unknown', bonusIds: null })]);
    next.localInventoryCompleteness = 'partial'; const updated = reduce(state, next);
    expect(updated.localInventory.map(value => value.itemId)).toEqual(['item-c']); expect(updated.localInventoryCompleteness).toBe('partial');
    expect(updated.localInventorySlotCompleteness).toBe('complete');
  });
  it('positively empty partial slots remove only the observed slot', () => {
    const first = own(); inventory(first, [item(first), item(first, 1, 'item-b')]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, [item(next, 0, 'unused', { itemId: null, status: 'empty', quantity: 0 })], false);
    expect(reduce(state, next).localInventory.map(value => value.itemId)).toEqual(['item-b']);
  });
  it('a confidence-zero unread slot cannot erase a known positive historical slot', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, [item(next, 0, 'unused', { itemId: null, status: 'unknown', observation: observation(next, 0) })], false);
    const updated = reduce(state, next); expect(updated.localInventory[0]!.itemId).toBe('item-a');
    expect(updated.localInventory[0]!.observation.capturedAt).toBe(first.capturedAt); expect(updated.localInventoryCompleteness).toBe('partial');
  });
  it('a proven empty complete grid is distinct from an unread inventory', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, []); expect(reduce(state, next)).toMatchObject({ localInventory: [], localInventoryCompleteness: 'complete' });
  });
  it('retains full material empty coverage when a parser emits explicit empty cells', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, [item(next, 0, 'unused', { itemId: null, status: 'empty', variant: 'unknown', quantity: null })]);
    expect(reduce(state, next)).toMatchObject({ localInventory: [], localInventoryCompleteness: 'complete', localInventorySlotCompleteness: 'complete' });
  });
  it('contradictory complete claims with unread cells cannot delete known ownership', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = own(); inventory(next, [item(next, 0, 'unused', { itemId: null, status: 'unknown', observation: observation(next, 0) })]);
    expect(reduce(state, next)).toMatchObject({ localInventory: [expect.objectContaining({ itemId: 'item-a' })], localInventorySlotCompleteness: 'partial' });
  });
  it('keeps duplicate identities in distinct slots, with the actual quantity remaining unknown', () => {
    const value = own(); inventory(value, [item(value, 0, 'item-a', { quantity: null }), item(value, 1, 'item-a', { quantity: null })]);
    const state = reduce(createInitialScreenMatchContext(), value); expect(state.localInventory).toHaveLength(2);
    expect(state.localInventoryCompleteness).toBe('partial'); expect(state.localInventory[0]!.quantity).toBeNull();
  });
  it('a draft or round transition retains positives but withdraws complete mutable coverage', () => {
    const first = own(); inventory(first, [item(first)]); const state = reduce(createInitialScreenMatchContext(), first);
    const next = reduce(state, own({ phase: 'draft' })); expect(next.localInventory).toEqual(state.localInventory);
    expect(next.localInventoryCompleteness).toBe('partial'); expect(next.localInventorySlotCompleteness).toBe('partial');
  });
  it('retains observed ranks independently from unread slots and never invents rank zero', () => {
    const first = own(); first.localAbilities = [0, 1, 2, 3].map(slot => ability(first, slot as 0 | 1 | 2 | 3, slot === 0 ? 1 : null));
    first.abilityCompleteness = 'partial'; first.abilityObservation = observation(first);
    const state = reduce(createInitialScreenMatchContext(), first); expect(state.localAbilities).toHaveLength(1);
    const next = own(); next.localAbilities = [ability(next, 1, 0)]; next.abilityCompleteness = 'partial'; next.abilityObservation = observation(next);
    expect(reduce(state, next).localAbilities.map(value => [value.slot, value.rank])).toEqual([[0, 1], [1, 0]]);
  });
  it('keeps a visible zero AP budget distinct from an unread budget', () => {
    const value = own({ localAbilityPoints: 0 }); value.fields!.localAbilityPoints = observation(value);
    expect(reduce(createInitialScreenMatchContext(), value).localAbilityPoints).toBe(0);
    expect(createInitialScreenMatchContext().localAbilityPoints).toBeNull();
  });
  it('AP spending invalidates unconfirmed historical ranks instead of guessing the purchased tier', () => {
    const first = own({ localAbilityPoints: 3 }); first.fields!.localAbilityPoints = observation(first);
    first.localAbilities = [ability(first, 0, 0), ability(first, 1, 1)]; first.abilityCompleteness = 'partial'; first.abilityObservation = observation(first);
    const state = reduce(createInitialScreenMatchContext(), first);
    const next = own({ localAbilityPoints: 2 }); next.fields!.localAbilityPoints = observation(next);
    const changed = reduce(state, next);
    expect(changed.localAbilities[0]!.rank).toBe(0);
    expect(changed.localAbilities[0]!.observation.capturedAt).toBe(first.capturedAt);
    expect(changed.localAbilities[0]!.observation.invalidatedAt).toBe(next.capturedAt);
    expect(isScreenObservationUsable(changed.localAbilities[0]!.observation, changed, next.receivedAt)).toBe(false);
    const refreshed = own(); refreshed.localAbilities = [ability(refreshed, 0, 1)]; refreshed.abilityCompleteness = 'partial'; refreshed.abilityObservation = observation(refreshed);
    const confirmed = reduce(changed, refreshed);
    expect(confirmed.localAbilities[0]!.rank).toBe(1); expect(confirmed.localAbilities[0]!.observation.invalidatedAt).toBeUndefined();
    expect(isScreenObservationUsable(confirmed.localAbilities[1]!.observation, confirmed, refreshed.receivedAt)).toBe(false);
  });
  it('does not promote an unknown/spectator active HUD to local ownership', () => {
    const value = own({ viewMode: 'unknown' }); inventory(value, [item(value)]);
    expect(reduce(createInitialScreenMatchContext(), value)).toMatchObject({ localHeroId: null, localInventory: [] });
    const participant = own(); inventory(participant, [item(participant)]); const state = reduce(createInitialScreenMatchContext(), participant);
    expect(reduce(state, own({ viewMode: 'spectator', localHeroId: 'viewed-hero' }))).toMatchObject({ viewMode: 'spectator', localHeroId: null, localInventory: [], localAbilities: [] });
  });
  it('ends a death-cam spectator verdict once frames stop showing SPECTATING (respawn)', () => {
    const dead = frame({ viewMode: 'spectator', phase: 'combat', round: 2 });
    dead.fields = { viewMode: observation(dead), phase: observation(dead), round: observation(dead) };
    const spectating = reduce(createInitialScreenMatchContext(), dead);
    expect(spectating.viewMode).toBe('spectator');
    // Respawned HUD frames carry no view verdict (confidence 0), as in the 2026-10-11 live logs.
    const alive = frame({ viewMode: 'unknown', phase: 'combat', round: 2, capturedAt: dead.capturedAt + SPECTATOR_HOLD_MS + 500, receivedAt: dead.capturedAt + SPECTATOR_HOLD_MS + 510 });
    alive.fields = { viewMode: observation(alive, 0), phase: observation(alive) };
    expect(reduce(spectating, alive).viewMode).toBe('unknown');
    // A frame shortly after the last SPECTATING one keeps the verdict (one frame without the label).
    const blink = frame({ viewMode: 'unknown', phase: 'combat', round: 2, capturedAt: dead.capturedAt + 1_000, receivedAt: dead.capturedAt + 1_010 });
    blink.fields = { viewMode: observation(blink, 0) };
    expect(reduce(spectating, blink).viewMode).toBe('spectator');
    expect(expireScreenMatchContext(spectating, dead.capturedAt + SPECTATOR_HOLD_MS + 1).viewMode).toBe('unknown');
  });
  it('exposes retained snapshot age without allowing receipt-time or clock rollback laundering', () => {
    const value = own(); const state = reduce(createInitialScreenMatchContext(), value); const proof = state.observations.localHeroId!;
    expect(screenObservationAge(proof, proof.capturedAt + 20_000)).toBe(20_000);
    expect(isScreenObservationUsable(proof, state, proof.capturedAt + 30_001)).toBe(false);
    expect(isScreenObservationUsable(proof, state, proof.capturedAt - 1)).toBe(false);
    expect(isScreenObservationUsable({ ...proof, sessionId: 'retired' }, state, proof.receivedAt)).toBe(false);
  });
  it('expires the participant claim independently while retaining historical build provenance', () => {
    const value = own(); inventory(value, [item(value)]); const state = reduce(createInitialScreenMatchContext(), value);
    const expired = expireScreenMatchContext(state, value.capturedAt + 30_001);
    expect(expired).toMatchObject({ viewMode: 'unknown', revision: state.revision + 1, localHeroId: 'hero-a' });
    expect(expired.localInventory).toEqual(state.localInventory); expect(expired.observations.viewMode).toEqual(state.observations.viewMode);
  });
});

describe('round number evidence (real 2026-10-18 matches)', () => {
  /** A frame captured `at` ms after START; only the fields given are observed. */
  function at(ms: number, patch: Partial<ScreenMatchObservation>): ScreenMatchObservation {
    const value: ScreenMatchObservation = { sessionId: 'test-reader-a', gameSessionId: 'test-window-a', frameId: `round-frame-${++ordinal}`,
      capturedAt: START + ms, receivedAt: START + ms + 10, ...patch };
    value.fields = Object.fromEntries((['round', 'phase', 'pickStage', 'scores'] as const).filter(key => key in patch).map(key => [key, observation(value)]));
    return value;
  }
  const run = (frames: ScreenMatchObservation[]) => frames.reduce((state, value) => reduceScreenMatchContext(state, value, value.receivedAt), createInitialScreenMatchContext());

  it('ignores a misread "ROUND 13" in round 3 (match C, 18:29:27) and keeps the match context', () => {
    const state = run([at(0, { round: 3, phase: 'combat' }), at(1_000, { round: 13, phase: 'combat' }), at(2_000, { round: 3, phase: 'combat' })]);
    expect(state.round).toBe(3);
  });
  it('advances the round when a new "Choice 1 of 3" draft opens after combat (match A round 3, 12:05:16)', () => {
    const state = run([
      at(0, { round: 2, phase: 'draft', pickStage: 1 }), at(20_000, { phase: 'draft', pickStage: 3 }),
      at(60_000, { round: 2, phase: 'combat' }), at(120_000, { phase: 'combat' }),
      // The round-3 draft: "ROUND 3" is not read until 40 s later.
      at(130_000, { phase: 'draft', pickStage: 1 })]);
    expect(state.round).toBe(3);
    expect(state.observations.round?.round).toBe(3);
    expect(state.roundTracking?.inferredAt).toBe(START + 130_000);
    // Later picks of the same draft and the "ROUND 3" read change nothing.
    const later = run([at(0, { round: 2, phase: 'draft', pickStage: 1 }), at(60_000, { phase: 'combat' }), at(130_000, { phase: 'draft', pickStage: 1 }),
      at(140_000, { phase: 'draft', pickStage: 2 }), at(170_000, { round: 3, phase: 'combat' })]);
    expect(later.round).toBe(3);
  });
  it('does not advance twice when "ROUND N" was already read before the draft opened (match B 18:09:59)', () => {
    const state = run([at(0, { round: 1, phase: 'draft', pickStage: 1 }), at(60_000, { round: 1, phase: 'combat' }),
      at(100_000, { round: 2, phase: 'combat' }), at(105_000, { phase: 'draft', pickStage: 1 })]);
    expect(state.round).toBe(2);
  });
  it('does not advance when the draft\'s first frame has no "Choice N of 3" read yet (2026-11-01 02:37:41)', () => {
    const state = run([at(0, { round: 2, phase: 'draft', pickStage: 1 }), at(60_000, { round: 2, phase: 'combat' }),
      at(100_000, { round: 3, phase: 'combat' }), at(105_000, { phase: 'draft' }), at(106_000, { phase: 'draft', pickStage: 1 })]);
    expect(state.round).toBe(3);
    // Unread HUD round: the label read on a later frame of the draft still advances it once.
    const unread = run([at(0, { round: 2, phase: 'draft', pickStage: 1 }), at(60_000, { round: 2, phase: 'combat' }),
      at(130_000, { phase: 'draft' }), at(131_000, { phase: 'draft', pickStage: 1 }), at(140_000, { phase: 'draft', pickStage: 2 })]);
    expect(unread.round).toBe(3);
  });
  it('corrects an inferred round on one lower HUD read, and the next round\'s draft still advances it', () => {
    const inferred = [at(0, { round: 2, phase: 'draft', pickStage: 1 }), at(60_000, { phase: 'combat' }), at(130_000, { phase: 'draft', pickStage: 1 })];
    expect(run(inferred).round).toBe(3);
    expect(run([...inferred, at(140_000, { round: 2, phase: 'combat' })]).round).toBe(2);
    // A one-off "ROUND 4" misread during the round-3 draft, lowered by three reads: the round-4 draft still advances.
    const misread = run([at(0, { round: 3, phase: 'draft', pickStage: 1 }), at(5_000, { round: 4, phase: 'draft', pickStage: 1 }),
      ...[60_000, 61_000, 62_000].map(ms => at(ms, { round: 3, phase: 'combat' })), at(200_000, { phase: 'draft', pickStage: 1 })]);
    expect(misread.round).toBe(4);
  });
  it('does not treat the next choice of the same draft as a new round', () => {
    const state = run([at(0, { round: 2, phase: 'draft', pickStage: 1 }), at(5_000, { phase: 'combat' }), at(8_000, { phase: 'draft', pickStage: 1 })]);
    expect(state.round).toBe(2);
  });
  it('accepts a skipped round only on a second agreeing read or matching pips, and never past round 5', () => {
    expect(run([at(0, { round: 2, phase: 'combat' }), at(1_000, { round: 4, phase: 'combat' })]).round).toBe(2);
    expect(run([at(0, { round: 2, phase: 'combat' }), at(1_000, { round: 4, phase: 'combat' }), at(2_000, { round: 4, phase: 'combat' })]).round).toBe(4);
    expect(run([at(0, { round: 2, phase: 'combat' }), at(1_000, { round: 4, phase: 'combat', scores: [2, 1] })]).round).toBe(4);
    expect(run([at(0, { round: 5, phase: 'combat' }), at(1_000, { round: 6, phase: 'combat' }), at(2_000, { round: 6, phase: 'combat' })]).round).toBe(5);
  });
  it('keeps a score only when its pips fit the round, and never lowers it on one read', () => {
    expect(run([at(0, { round: 3, phase: 'combat', scores: [1, 1] })]).scores).toEqual([1, 1]);
    expect(run([at(0, { round: 3, phase: 'combat', scores: [1, 1] }), at(1_000, { round: 3, phase: 'combat', scores: [2, 1] })]).scores).toEqual([2, 1]);
    // 3 pips in round 1 cannot be; the same frame's round read is doubtful too.
    expect(run([at(0, { round: 1, phase: 'combat', scores: [2, 1] })])).toMatchObject({ round: null, scores: null });
    const lowered = [at(0, { round: 3, phase: 'combat', scores: [2, 0] }), at(1_000, { round: 3, phase: 'combat', scores: [1, 1] })];
    expect(run(lowered).scores).toEqual([2, 0]);
    expect(run([...lowered, at(2_000, { round: 3, phase: 'combat', scores: [1, 1] }), at(3_000, { round: 3, phase: 'combat', scores: [1, 1] })]).scores).toEqual([1, 1]);
  });
  it('lowers a round taken from a one-off "ROUND N+1" misread after three agreeing lower reads', () => {
    const misread = [at(0, { round: 2, phase: 'combat' }), at(1_000, { round: 3, phase: 'combat' })];
    expect(run(misread).round).toBe(3);
    expect(run([...misread, at(2_000, { round: 2, phase: 'combat' }), at(3_000, { round: 2, phase: 'combat' })]).round).toBe(3);
    expect(run([...misread, at(2_000, { round: 2, phase: 'combat' }), at(3_000, { round: 2, phase: 'combat' }), at(4_000, { round: 2, phase: 'combat' })]).round).toBe(2);
    // A score the lower round cannot have goes with it.
    const scored = run([at(0, { round: 2, phase: 'combat', scores: [1, 0] }), at(1_000, { round: 3, phase: 'combat', scores: [2, 1] }),
      ...[2_000, 3_000, 4_000].map(ms => at(ms, { round: 2, phase: 'combat' }))]);
    expect(scored).toMatchObject({ round: 2, scores: null });
  });
  it('starts the next match clean when the last one ended without a post-match frame (review repro)', () => {
    const matchA = [at(0, { round: 3, phase: 'draft', pickStage: 1 }), at(30_000, { round: 3, phase: 'combat', scores: [1, 1] }), at(90_000, { phase: 'combat' })];
    // Without the new-match signal, match B's first draft would be round 4 and its "ROUND 2" ignored.
    const carried = run([...matchA, at(200_000, { phase: 'combat' }), at(260_000, { phase: 'draft', pickStage: 1 })]);
    expect(carried.round).toBe(4);
    // The reader saw match B's loading screen (new roster epoch): round, score and stage are forgotten, the session kept.
    const forgotten = forgetMatchRound(run(matchA));
    expect(forgotten).toMatchObject({ round: null, scores: null, pickStage: null, sessionId: 'test-reader-a', retiredSessionIds: [] });
    const matchB = [at(260_000, { phase: 'draft', pickStage: 1 }), at(300_000, { round: 1, phase: 'combat', scores: [0, 0] }),
      at(400_000, { round: 2, phase: 'combat', scores: [1, 0] })].reduce((state, value) => reduceScreenMatchContext(state, value, value.receivedAt), forgotten);
    expect(matchB).toMatchObject({ round: 2, scores: [1, 0] });
  });
  it('takes a new match\'s first draft as round 1 only when the match start was seen and no combat came first', () => {
    const fresh = (frames: ScreenMatchObservation[]) => frames.reduce((state, value) => reduceScreenMatchContext(state, value, value.receivedAt),
      forgetMatchRound(createInitialScreenMatchContext(), true));
    expect(fresh([at(0, { phase: 'draft', pickStage: 1 })]).round).toBe(1);
    expect(fresh([at(0, { phase: 'draft' }), at(1_000, { phase: 'draft', pickStage: 2 })]).round).toBe(1);
    // The app started mid-match, or a new match was told apart without its loading screen: no match start was seen.
    expect(run([at(0, { phase: 'draft', pickStage: 1 })]).round).toBeNull();
    expect(reduceScreenMatchContext(forgetMatchRound(createInitialScreenMatchContext()), at(0, { phase: 'draft', pickStage: 1 }), START + 10).round).toBeNull();
    // Combat before the draft: this is not the opening draft.
    expect(fresh([at(0, { phase: 'combat' }), at(30_000, { phase: 'draft', pickStage: 1 })]).round).toBeNull();
    // The HUD title still decides once read.
    expect(fresh([at(0, { phase: 'draft', pickStage: 1 }), at(60_000, { round: 1, phase: 'combat' }), at(200_000, { round: 2, phase: 'combat' })]).round).toBe(2);
  });
  it('does not advance the round from a draft long after the previous one (a different match)', () => {
    const state = run([at(0, { round: 3, phase: 'draft', pickStage: 1 }), at(60_000, { phase: 'combat' }), at(700_000, { phase: 'draft', pickStage: 1 })]);
    expect(state.round).toBe(3);
  });
});
