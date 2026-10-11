import { describe, expect, it } from 'vitest';
import { APP_CATALOG } from '../src/app/catalog';
import { CONTEXT_CATALOG } from '../src/shared/context-catalog';
import { createInitialScreenMatchContext, SCREEN_CAPTURE_FRESHNESS_MS } from '../src/shared/screen-reading';
import type { ScreenContextObservation, ScreenMatchContext } from '../src/shared/screen-reading';
import { evaluateAbilityUpgrade } from '../src/screen/ability-advice';

const now = 50_000;
const haze = CONTEXT_CATALOG.heroes.find(hero => hero.name === 'Haze')!;
function evidence(capturedAt = now): ScreenContextObservation {
  return { sessionId: 'visible-match', frameId: 'observed-panel', capturedAt, receivedAt: capturedAt, method: 'ability-pips', confidence: 1,
    round: 2, bounds: [{ x: .35, y: .75, width: .3, height: .2 }] };
}
function context(): ScreenMatchContext {
  const initial = createInitialScreenMatchContext();
  return { ...initial, sessionId: 'visible-match', viewMode: 'participant', phase: 'draft', round: 2,
    localHeroId: haze.id, localAbilityPoints: 5, abilityCompleteness: 'complete',
    observations: { ...initial.observations, localHeroId: evidence(), localAbilityPoints: evidence(), viewMode: evidence() },
    localAbilities: haze.abilityIds.map((abilityId, slot) => ({ slot: slot as 0 | 1 | 2 | 3, abilityId, rank: slot === 2 ? 2 : 3,
      unlocked: true, nextUpgradeCost: slot === 2 ? 5 : null, observation: evidence() })) };
}

describe('observed next ability upgrade', () => {
  it('uses the actual next tier, visible price and own current AP for an affordable suggestion', () => {
    const result = evaluateAbilityUpgrade(context(), APP_CATALOG, now)!;
    expect(result.kind).toBe('upgrade');
    expect(result.slot).toBe(2);
    expect(result.cost).toBe(5);
    expect(result.availablePoints).toBe(5);
    expect(result.title).toContain('tier 3');
    expect(result.reasons[0]).toContain('Scales with Weapon Damage');
  });
  it('offers a conditional priority rather than an affordable claim when the UI price is unread', () => {
    const state = context(); state.localAbilities[2].nextUpgradeCost = null;
    const result = evaluateAbilityUpgrade(state, APP_CATALOG, now)!;
    expect(result.kind).toBe('plan');
    expect(result.cost).toBeNull();
    expect(result.limitations.join(' ')).toContain('actual price is unread');
  });
  it('does not infer unspent AP from round allocation or an older budget', () => {
    const state = context(); state.localAbilityPoints = null;
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.kind).toBe('plan');
    // A budget read within the capture-freshness window is still the current AP...
    state.localAbilityPoints = 5; state.observations.localAbilityPoints = evidence(now - SCREEN_CAPTURE_FRESHNESS_MS + 500);
    const recent = evaluateAbilityUpgrade(state, APP_CATALOG, now)!;
    expect(recent.kind).toBe('upgrade'); expect(recent.availablePoints).toBe(5);
    // ...but one older than that window is never reused as unspent AP.
    state.observations.localAbilityPoints = evidence(now - SCREEN_CAPTURE_FRESHNESS_MS - 1);
    const result = evaluateAbilityUpgrade(state, APP_CATALOG, now)!;
    expect(result.kind).toBe('plan'); expect(result.availablePoints).toBeNull();
    expect(result.limitations.join(' ')).toContain('need a fresh reading');
  });
  it('requires a new rank reading after an observed spend invalidates the old investment', () => {
    const state = context();
    state.localAbilities[2].observation = { ...evidence(now - 100), invalidatedAt: now - 50 };
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.kind).toBe('withheld');
    state.localAbilities[2].observation = evidence();
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.kind).toBe('upgrade');
  });
  it('does not label an unaffordable next tier as an upgrade now', () => {
    const state = context(); state.localAbilityPoints = 2;
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.kind).toBe('plan');
  });
  it('withholds unknown or mismatched ranks instead of substituting a typical hero build', () => {
    const state = context(); state.localAbilities = [{ ...state.localAbilities[2], rank: null }];
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.kind).toBe('withheld');
    state.localAbilities[0] = { ...state.localAbilities[0], rank: 2, abilityId: 'ability_from_another_hero' };
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.kind).toBe('withheld');
  });
  it('does not treat locked abilities or cost labels as purchased tiers', () => {
    const state = context(); state.localAbilities = [{ ...state.localAbilities[2], rank: 0, unlocked: false }];
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.kind).toBe('withheld');
  });
  it('rejects spectator ownership, old-session and old-round snapshots', () => {
    const state = context(); state.viewMode = 'spectator';
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)).toBeNull();
    state.viewMode = 'participant'; state.observations.localHeroId = { ...evidence(), sessionId: 'retired-match' };
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)).toBeNull();
    state.observations.localHeroId = { ...evidence(), round: 1 };
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)).toBeNull();
  });
  it('does not prolong expired ownership with fresh HUD ranks and budget', () => {
    const state = context(); state.observations.viewMode = evidence(now - 30_001);
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)).toBeNull();
  });
  it('does not reuse definitions from another build or extend tier three', () => {
    const state = context();
    expect(evaluateAbilityUpgrade(state, { ...APP_CATALOG, revision: 'another-build' }, now)?.kind).toBe('withheld');
    state.localAbilities[2].rank = 3;
    const result = evaluateAbilityUpgrade(state, APP_CATALOG, now)!;
    expect(result.kind).toBe('withheld'); expect(result.reasons[0]).toContain('fully upgraded');
  });
  it('uses a different source effect when the observed next tier changes', () => {
    const state = context(); state.localAbilities[2].rank = 1; state.localAbilities[2].nextUpgradeCost = 2;
    const result = evaluateAbilityUpgrade(state, APP_CATALOG, now)!;
    expect(result.title).toContain('tier 2');
    expect(result.reasons[0]).toContain('Max Stacks');
    expect(result.reasons[0]).not.toContain('Scales with Weapon Damage');
  });
  it('changes priority with the latest actually identified own roster loadout', () => {
    const state = context(); state.localAbilityPoints = 1; state.localTeam = 0; state.localSeat = 0;
    state.observations.localSeat = evidence();
    state.localAbilities[2] = { ...state.localAbilities[2], rank: 0, nextUpgradeCost: 1 };
    state.localAbilities[3] = { ...state.localAbilities[3], rank: 0, nextUpgradeCost: 1 };
    const spiritItems = CONTEXT_CATALOG.items.filter(item => item.category === 'spirit').slice(0, 4);
    const weaponItems = CONTEXT_CATALOG.items.filter(item => item.category === 'weapon').slice(0, 4);
    const loadout = (items: typeof spiritItems) => items.map((item, slot) => ({ slot, itemId: item.id, variant: 'base' as const, bonusIds: [], observation: evidence() }));
    state.players = [{ seat: 0, heroId: haze.id, team: 0, isLocal: true, heroObservation: evidence(), teamObservation: evidence(), localObservation: evidence(),
      inventory: loadout(spiritItems), inventoryCompleteness: 'partial', inventoryObservation: evidence(), inventoryRevision: 1 }];
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.slot).toBe(2);
    state.players[0].inventory = loadout(weaponItems);
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.slot).toBe(3);
  });
  it('ignores another player’s items when own identity is unresolved', () => {
    const state = context(); state.localAbilityPoints = 1;
    state.localAbilities[2] = { ...state.localAbilities[2], rank: 0, nextUpgradeCost: 1 };
    state.localAbilities[3] = { ...state.localAbilities[3], rank: 0, nextUpgradeCost: 1 };
    const before = evaluateAbilityUpgrade(state, APP_CATALOG, now)?.slot;
    state.players = [{ seat: 1, heroId: haze.id, team: 0, isLocal: false, heroObservation: evidence(), teamObservation: evidence(), localObservation: null,
      inventory: CONTEXT_CATALOG.items.filter(item => item.category === 'spirit').slice(0, 4).map((item, slot) => ({ slot, itemId: item.id, variant: 'base', bonusIds: [], observation: evidence() })),
      inventoryCompleteness: 'partial', inventoryObservation: evidence(), inventoryRevision: 1 }];
    expect(evaluateAbilityUpgrade(state, APP_CATALOG, now)?.slot).toBe(before);
  });
});
