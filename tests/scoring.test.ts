import { describe, expect, it } from 'vitest';
import { evaluateDecision } from '../src/core/scoring';
import { createInitialState, reduceTelemetry } from '../src/core/store';
import { DEMO_CATALOG, getDemoEvents } from '../src/demo/scenarios';
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

function demoObservation(sequence: number) {
  return observation(sequence, { provider: 'synthetic-demo' });
}
function fixturePlayer(seat: number, overrides: Partial<PlayerState> = {}): PlayerState {
  return player(seat, {
    heroId: seat === 0 ? 'mystic' : seat < 4 ? 'gunner' : 'neutral',
    heroName: null, observation: demoObservation(2),
    inventoryObservation: demoObservation(2), abilityObservation: demoObservation(2),
    inventory: seat === 0 ? [item('spirit', 'owned-spirit')] : [], ...overrides,
  });
}
function fixture(): MatchState {
  return {
    mode: 'demo', source: source({ provider: 'synthetic-demo', sequence: 3 }),
    match: match({ observation: demoObservation(1) }),
    players: Array.from({ length: 8 }, (_, seat) => fixturePlayer(seat)),
    draft: draft({
      observation: demoObservation(3),
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
  it('evaluates the shipped demonstration through the actual telemetry reducer', () => {
    const state = getDemoEvents('draft', NOW).reduce(reduceTelemetry, createInitialState('demo'));
    const result = evaluateDecision(state, DEMO_CATALOG, NOW);
    expect(result?.kind).toBe('pick');
    expect(result?.preferredPosition).toBe(0);
    expect(result?.reasons.join(' ')).toContain('Extra Spirit');
    expect(result?.reasons).toHaveLength(2);
    expect(result?.reasons.every(reason => reason.length <= 150)).toBe(true);
    expect(result?.reasons.join(' ')).not.toMatch(/tags|synthetic profile|measured effectiveness/);
    expect(result?.evidence).toBe('synthetic');
    expect(DEMO_CATALOG.liveModelValidated).toBe(false);

    const rerolled = getDemoEvents('rerolled', NOW).reduce(reduceTelemetry, createInitialState('demo'));
    const afterReroll = evaluateDecision(rerolled, DEMO_CATALOG, NOW);
    expect(afterReroll?.key.generation).toBe(2);
    expect(afterReroll?.reroll.reason).toContain('Zero rerolls remain');
    expect(afterReroll?.reroll.kind).toBe('withheld');
  });

  it.each(['waiting', 'combat', 'interrupted', 'unknown-item', 'unknown-ranks', 'post-match'] as const)
    ('produces no pick for the shipped %s demonstration', scenario => {
      const state = getDemoEvents(scenario, NOW).reduce(reduceTelemetry, createInitialState('demo'));
      expect(evaluateDecision(state, DEMO_CATALOG, NOW)?.kind).not.toBe('pick');
    });

  it('uses the observed hero and confirmed loadout, preserves positions, and leaves the snapshot unchanged', () => {
    const state = fixture();
    const before = structuredClone(state);
    const result = evaluateDecision(state, catalog, NOW);

    expect(result?.kind).toBe('pick');
    expect(result?.preferredPosition).toBe(1);
    expect(result?.evidence).toBe('synthetic');
    expect(result?.ranked.map(offer => offer.position)).toEqual([2, 0, 1]);
    expect(result?.reasons).toHaveLength(2);
    expect(result?.reasons.join(' ')).toContain('Observed Mystic');
    expect(result?.reasons.join(' ')).toContain('confirmed Spirit Amplifier');
    expect(result?.limitations.join(' ')).toContain('not win probabilities');
    expect(result?.key.catalogRevision).toBe(catalog.revision);
    expect(state).toEqual(before);

    state.players[0]!.heroId = 'gunner';
    state.players[0]!.inventory = [item('weapon', 'owned-weapon')];
    expect(evaluateDecision(state, catalog, NOW)?.preferredPosition).toBe(0);
  });

  it('evaluates bonus items against observed enemy healing instead of scoring only the main item', () => {
    const state = fixture();
    state.players[0] = fixturePlayer(0, { heroId: 'neutral', inventory: [] });
    state.players[4] = fixturePlayer(4, { heroId: 'healer', inventory: [item('healing', 'enemy-healing')] });
    const beforeBonus = evaluateDecision(state, catalog, NOW);
    expect(beforeBonus?.preferredPosition).toBe(0);

    replaceOffer(state, 2, { bonusIds: ['antiheal'] });
    const result = evaluateDecision(state, catalog, NOW);
    expect(result?.kind).toBe('pick');
    expect(result?.preferredPosition).toBe(2);
    expect(result?.reasons.join(' ')).toContain('Observed Healer with Observed Regeneration');
    expect(result?.reasons.join(' ')).toContain('includes Healing Suppression');
    expect(result?.ranked.find(offer => offer.position === 2)!.score)
      .toBeGreaterThan(beforeBonus!.ranked.find(offer => offer.position === 2)!.score);
  });

  it('uses team contribution only from observed profiles', () => {
    const state = fixture();
    state.players[0] = fixturePlayer(0, { heroId: 'neutral', inventory: [] });
    replaceOffer(state, 1, { id: 'support' });
    const withDamageTeam = evaluateDecision(state, catalog, NOW);
    expect(withDamageTeam?.preferredPosition).toBe(1);
    expect(withDamageTeam?.reasons.join(' ')).toContain('teammates Observed Gunner');

    for (const teammate of state.players.filter(candidate => candidate.team === 0 && !candidate.isLocal)) {
      teammate.heroId = 'neutral';
    }
    const withoutDamageTeam = evaluateDecision(state, catalog, NOW);
    expect(withoutDamageTeam?.ranked.find(offer => offer.position === 1)!.score)
      .toBeLessThan(withDamageTeam!.ranked.find(offer => offer.position === 1)!.score);
  });

  it('withholds reroll comparison despite observing one available reroll', () => {
    const result = evaluateDecision(fixture(), catalog, NOW);
    expect(result?.kind).toBe('pick');
    expect(result?.reroll.kind).toBe('withheld');
    expect(result?.reroll.reason).toContain('1 reroll observed');
    expect(result?.reroll.reason).toContain('verified replacement');
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
