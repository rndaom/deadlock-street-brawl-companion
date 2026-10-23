import { describe, expect, it } from 'vitest';
import { evaluateDecision } from '../src/core/scoring';
import type { Catalog, ItemInstance, MatchState, PlayerState } from '../src/shared/types';
import { draft, item, match, NOW, observation, player, source } from './fixtures';

const catalog: Catalog = {
  clientVersion: 'fixture-build', revision: 'synthetic-scoring-fixture-v1',
  source: 'Synthetic scoring fixtures only', retrievedAt: '2026-10-03T00:00:00Z',
  modelVersion: 'synthetic-tags-test-v1', liveModelValidated: false,
  heroes: [
    { id: 'mystic', name: 'Observed Mystic', role: 'test', tags: ['spirit'] },
    { id: 'gunner', name: 'Observed Gunner', role: 'test', tags: ['weapon'] },
    { id: 'healer', name: 'Observed Healer', role: 'test', tags: ['healing'] },
    { id: 'neutral', name: 'Observed Neutral', role: 'test', tags: [] },
  ],
  items: [
    { id: 'spirit', name: 'Spirit Amplifier', category: 'spirit', tier: 1, tags: ['spirit'], description: 'Synthetic fixture.' },
    { id: 'weapon', name: 'Rapid Rifle', category: 'weapon', tier: 1, tags: ['weapon'], description: 'Synthetic fixture.' },
    { id: 'antiheal', name: 'Healing Suppression', category: 'spirit', tier: 1, tags: ['anti-heal'], description: 'Synthetic fixture.' },
    { id: 'healing', name: 'Observed Regeneration', category: 'vitality', tier: 1, tags: ['healing'], description: 'Synthetic fixture.' },
    { id: 'support', name: 'Team Support', category: 'vitality', tier: 1, tags: ['support'], description: 'Synthetic fixture.' },
    { id: 'neutral', name: 'Neutral Package', category: 'vitality', tier: 1, tags: [], description: 'Synthetic fixture.' },
  ],
};


function fixturePlayer(seat: number, overrides: Partial<PlayerState> = {}): PlayerState {
  return player(seat, {
    heroId: seat === 0 ? 'mystic' : seat < 4 ? 'gunner' : 'neutral',
    heroName: null, observation: observation(2),
    inventoryObservation: observation(2), abilityObservation: observation(2),
    inventory: seat === 0 ? [item('spirit', 'owned-spirit')] : [], ...overrides,
  });
}
function fixture(): MatchState {
  return {
    mode: 'live', source: source({ sequence: 3 }),
    match: match({ observation: observation(1) }),
    players: Array.from({ length: 8 }, (_, seat) => fixturePlayer(seat)),
    draft: draft({
      observation: observation(3),
      // Deliberately shuffled: a preference must never reorder game positions.
      offers: [
        { position: 2, item: item('neutral', 'offer-neutral'), available: true },
        { position: 0, item: item('weapon', 'offer-weapon'), available: true },
        { position: 1, item: item('spirit', 'offer-spirit'), available: true },
      ],
    }),
    rosterCompleteness: 'complete', revision: 3, advice: null,
    transitions: [], counters: { accepted: 3, rejected: 0, invalidated: 0 },
  };
}
function replaceOffer(state: MatchState, position: number, overrides: Partial<ItemInstance>): void {
  const offer = state.draft!.offers.find(candidate => candidate.position === position)!;
  offer.item = { ...offer.item, ...overrides };
}

describe('synthetic decision evaluator', () => {
  it('withholds the tag baseline in the live app (it only ever ran in the removed demo mode)', () => {
    const state = fixture();
    const before = structuredClone(state);
    const result = evaluateDecision(state, catalog, NOW);
    expect(result?.kind).toBe('withheld');
    expect(result?.ranked).toEqual([]);
    expect(state).toEqual(before);
  });

  it('explicitly reports zero rerolls instead of inventing a keep-versus-reroll comparison', () => {
    const state = fixture();
    state.draft!.rerollsRemaining = 0;
    state.draft!.rerollAvailable = false;
    const result = evaluateDecision(state, catalog, NOW);
    expect(result?.reroll.kind).toBe('withheld');
    expect(result?.reroll.reason).toContain('Zero rerolls remain');
  });

  it.each(['offer', 'bonus', 'inventory', 'hero'] as const)('withholds for unknown %s identifiers', target => {
    const state = fixture();
    if (target === 'offer') replaceOffer(state, 0, { id: 'unrecognized' });
    if (target === 'bonus') replaceOffer(state, 0, { bonusIds: ['unrecognized'] });
    if (target === 'inventory') state.players[4]!.inventory = [item('unrecognized')];
    if (target === 'hero') state.players[4]!.heroId = 'unrecognized';
    const result = evaluateDecision(state, catalog, NOW);
    expect(result?.kind).toBe('withheld');
    expect(result?.preferredPosition).toBeNull();
    expect(result?.ranked).toEqual([]);
    expect(result?.reasons.join(' ')).toContain('unknown');
  });

  it.each([
    { modifiersDecoded: false },
    { variant: 'unknown' as const },
    { variant: 'enhanced' as const, modifiersDecoded: true },
    { variant: 'legendary' as const, modifiersDecoded: true },
    { variant: 'corrupted' as const, modifiersDecoded: true },
    { modifierBits: '0x10', modifiersDecoded: true },
  ])('withholds undecoded or unevaluated modifiers: %j', changes => {
    const state = fixture();
    replaceOffer(state, 0, changes);
    expect(evaluateDecision(state, catalog, NOW)?.kind).toBe('withheld');
  });

  it('does not equate a catalogue validation flag with an installed live mechanics evaluator', () => {
    const state = fixture();
    state.mode = 'live';
    state.source.provider = 'fixture-provider';
    for (const observed of [state.match!.observation, state.draft!.observation, ...state.players.flatMap(candidate =>
      [candidate.observation, candidate.inventoryObservation, candidate.abilityObservation])]) {
      if (observed) observed.provider = 'fixture-provider';
    }
    const result = evaluateDecision(state, { ...catalog, liveModelValidated: true }, NOW);
    expect(result?.kind).toBe('withheld');
    expect(result?.reasons.join(' ')).toContain('verified live mechanics evaluator is not installed');
    expect(result?.ranked).toEqual([]);
    expect(result?.reroll.kind).toBe('withheld');
  });

  it.each(['hidden', 'missing', 'provider', 'session'] as const)('withholds an enemy inventory with %s provenance', failure => {
    const state = fixture();
    const enemy = state.players[4]!;
    enemy.inventory = [item('healing', 'enemy-healing')];
    if (failure === 'hidden') enemy.inventoryObservation!.visibility = 'unknown';
    if (failure === 'missing') enemy.inventoryObservation = null;
    if (failure === 'provider') enemy.inventoryObservation!.provider = 'another-provider';
    if (failure === 'session') enemy.inventoryObservation!.sessionId = 'prior-session';
    const result = evaluateDecision(state, catalog, NOW);
    expect(result?.kind).toBe('withheld');
    expect(result?.ranked).toEqual([]);
  });

  it('withholds a build mismatch and expired offers', () => {
    const state = fixture();
    expect(evaluateDecision(state, { ...catalog, clientVersion: 'different-build' }, NOW)?.kind).toBe('withheld');
    state.match!.deadlineAt = NOW;
    expect(evaluateDecision(state, catalog, NOW)?.kind).toBe('withheld');
  });

  it('does not substitute typical ability ranks when observed investment is unknown', () => {
    const state = fixture();
    state.players[0]!.abilities[0]!.rank = null;
    state.players[0]!.abilityCompleteness = 'unknown';
    const result = evaluateDecision(state, catalog, NOW);
    expect(result?.kind).toBe('withheld');
    expect(result?.ranked).toEqual([]);
  });

  it('returns no advice without a draft identity', () => {
    const state = fixture();
    state.draft = null;
    expect(evaluateDecision(state, catalog, NOW)).toBeNull();
  });
});
