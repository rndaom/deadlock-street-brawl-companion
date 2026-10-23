import { describe, expect, it } from 'vitest';
import publicCatalog from '../data/public-catalog.json';
import { CONTEXT_CATALOG } from '../src/shared/context-catalog';
import { createInitialScreenMatchContext, SCREEN_CONTEXT_MAX_AGE_MS } from '../src/shared/screen-reading';
import type { ScreenAbilityState, ScreenContextObservation, ScreenInventoryItem, ScreenMatchContext, ScreenObservedPlayer, ScreenOffer } from '../src/shared/screen-reading';
import type { Catalog } from '../src/shared/types';
import { evaluateContextOffers, isContextObservationUsable } from '../src/screen/context-advice';
import { evaluateScreenOffers } from '../src/screen/screen-advice';
import { resetScreenMatchContext } from '../src/screen/match-state';

const catalog = publicCatalog as Catalog;
const now = 1_800_000_000_000;
function observation(patch: Partial<ScreenContextObservation> = {}): ScreenContextObservation {
  return { sessionId: 'context-test', frameId: 'visible-frame', capturedAt: now, receivedAt: now,
    method: 'item-icon', confidence: 1, bounds: [{ x: 0.2, y: 0.2, width: 0.05, height: 0.05 }], round: 3, ...patch };
}
function item(itemId: string, slot: number, patch: Partial<ScreenInventoryItem> = {}): ScreenInventoryItem {
  return { slot, itemId, variant: 'base', bonusIds: [], observation: observation(), ...patch };
}
function ability(slot: 0 | 1 | 2 | 3, rank: number | null, unlocked: boolean | null, patch: Partial<ScreenAbilityState> = {}): ScreenAbilityState {
  return { slot, abilityId: CONTEXT_CATALOG.heroes.find(hero => hero.id === 'hero_haze')!.abilityIds[slot], rank, unlocked, observation: observation({ method: 'ability-pips' }), ...patch };
}
function match(patch: Partial<ScreenMatchContext> = {}): ScreenMatchContext {
  const initial = createInitialScreenMatchContext();
  return { ...initial, sessionId: 'context-test', gameSessionId: 'game-test', viewMode: 'participant', phase: 'draft', round: 3,
    localHeroId: 'hero_haze', localInventoryCompleteness: 'complete', localInventoryObservation: observation(),
    observations: { ...initial.observations, localHeroId: observation({ method: 'portrait' }), viewMode: observation({ method: 'visible-text' }), round: observation({ method: 'visible-text' }) }, ...patch };
}
function player(heroId: string, seat: number, team: 0 | 1, inventory: ScreenInventoryItem[] = []): ScreenObservedPlayer {
  return { seat, team, heroId, isLocal: false, heroObservation: observation({ method: 'portrait' }), teamObservation: observation({ method: 'layout-association' }), localObservation: null,
    inventory, inventoryCompleteness: 'complete', inventoryObservation: observation(), inventoryRevision: 1 };
}
function offer(itemId: string, position: number, patch: Partial<ScreenOffer> = {}): ScreenOffer {
  return { position, itemId, name: catalog.items.find(item => item.id === itemId)?.name ?? itemId,
    bonusIds: [], variant: 'base', confidence: 1, warning: null, ...patch };
}
const offense = () => [offer('upgrade_improved_spirit', 0), offer('upgrade_rapid_rounds', 1), offer('upgrade_non_player_bonus', 2)];
const protection = () => [offer('upgrade_metal_skin', 0), offer('upgrade_magic_shield', 1), offer('upgrade_non_player_bonus', 2)];
function advise(offers: ScreenOffer[], context: ScreenMatchContext) {
  return evaluateScreenOffers(offers, catalog, { heroId: context.localHeroId, round: context.round, rerolls: null, matchContext: context, now })!;
}
type Advice = ReturnType<typeof advise>;
const score = (advice: Advice, position: number) => advice.ranked.find(entry => entry.position === position)!.score;
const reasonsAt = (advice: Advice, position: number) => advice.ranked.find(entry => entry.position === position)!.reasons.join(' ');
/** Metal Skin (bullet resist, position 0) minus Enchanter's Emblem (spirit resist, position 1) in protection(). */
const bulletOverSpirit = (advice: Advice) => score(advice, 0) - score(advice, 1);
/** The named pick's own first reason, which leads advice.reasons. */
const pickReason = (advice: Advice) => advice.ranked.find(entry => entry.position === advice.preferredPosition)?.reasons[0];

describe('actual observed-context offer comparisons', () => {
  it('changes identical offers from actual weapon investments rather than counts of build tags', () => {
    const ranks = [ability(0, 0, false), ability(1, 0, false), ability(2, 1, true), ability(3, 0, false)];
    const spirit = match({ localAbilities: ranks, abilityCompleteness: 'complete', abilityObservation: observation() });
    const weapon = match({ ...spirit, localInventory: [item('upgrade_damage_recycler', 0), item('upgrade_titan_round', 1)] });
    const first = advise(offense(), spirit), second = advise(offense(), weapon);
    expect(first.preferredPosition).toBe(0);
    expect(second.preferredPosition).toBe(1);
    expect(second.title).toBe('Pick Rapid Rounds');
    expect(second.reasons.join(' ')).toContain('Leech');
    expect(second.reasons.join(' ')).toContain('9% fire rate');
    expect(second.factsUsed?.some(fact => fact.scope === 'own' && fact.label.includes('Titanic Magazine'))).toBe(true);
  });

  it('uses the actually read Fixation upgrade that adds explicit spirit scaling', () => {
    const before = match({ localAbilities: [ability(0, 0, false), ability(1, 0, false), ability(2, 0, true), ability(3, 0, false)], abilityCompleteness: 'complete', abilityObservation: observation() });
    const after = structuredClone(before); after.localAbilities[2]!.rank = 1;
    expect(advise(offense(), before).preferredPosition).toBe(1);
    const result = advise(offense(), after);
    expect(result.preferredPosition).toBe(0);
    expect(result.reasons.join(' ')).toContain('Fixation rank 1');
    expect(result.reasons.join(' ')).toContain('+8 listed damage per trigger');
    expect(result.reasons.join(' ')).toContain('before modifiers');
    expect(result.factsUsed?.some(fact => fact.label.includes('Fixation') && fact.observedAt === now)).toBe(true);
  });

  it('changes the same protection choices from identified opposing damage kits', () => {
    // Street Brawl data for the own hero (Haze) is identical in both cases; only the enemy kit differs.
    const bullet = advise(protection(), match({ players: [player('hero_haze', 4, 1)] }));
    const spirit = advise(protection(), match({ players: [player('hero_gigawatt', 4, 1)] }));
    // Bullet resist gains on spirit resist against a bullet-damage kit, and each card is
    // worth more against the kit it answers.
    expect(bulletOverSpirit(bullet)).toBeGreaterThan(bulletOverSpirit(spirit));
    expect(score(bullet, 0)).toBeGreaterThan(score(spirit, 0));
    expect(score(spirit, 1)).toBeGreaterThan(score(bullet, 1));
    expect(spirit.preferredPosition).toBe(1);
    // Reasons state the effect without "observed" hedging.
    expect(reasonsAt(bullet, 0)).toContain("12% bullet resist answers Haze's source damage kit");
    expect(spirit.reasons.join(' ')).toContain('Seven');
    expect(spirit.reasons.join(' ')).toContain('18% spirit resist');
    expect(bullet.factsUsed?.some(fact => fact.scope === 'enemy' && fact.playerSeat === 4 && fact.label.includes('Haze'))).toBe(true);
    expect(spirit.factsUsed?.some(fact => fact.scope === 'enemy' && fact.playerSeat === 4 && fact.label.includes('Seven'))).toBe(true);
    expect(spirit.limitations.join(' ')).toContain('Enemy ability unlocks, ranks');
  });

  it('uses an observed enemy spirit investment to change the damage response for the same hero', () => {
    const before = advise(protection(), match({ players: [player('hero_haze', 4, 1)] }));
    const after = advise(protection(), match({ players: [player('hero_haze', 4, 1, [item('upgrade_boundless_spirit', 0)])] }));
    // The enemy's spirit item shifts value from bullet resist toward spirit resist.
    expect(bulletOverSpirit(after)).toBeLessThan(bulletOverSpirit(before));
    expect(score(after, 1)).toBeGreaterThan(score(before, 1));
    expect(after.preferredPosition).toBe(1);
    expect(reasonsAt(after, 1)).toContain('Haze with Boundless Spirit');
    expect(after.reasons.join(' ')).toContain('Boundless Spirit');
    expect(before.reasons.join(' ')).not.toContain('Boundless Spirit');
    expect(after.factsUsed?.some(fact => fact.scope === 'enemy' && fact.playerSeat === 4 && fact.label.includes('Boundless Spirit'))).toBe(true);
  });

  it('gives the recommended card the highest edge and percentile when the observed context decides the pick', () => {
    const sets = [offense(), protection(), [offer('upgrade_healbane', 0), offer('upgrade_rapid_rounds', 1), offer('upgrade_non_player_bonus', 2)]];
    const contexts = [match(), match({ players: [player('hero_haze', 4, 1, [item('upgrade_vampire', 0)])] }), match({ players: [player('hero_wraith', 4, 1), player('hero_atlas', 5, 1)] })];
    let checked = 0;
    for (const offers of sets) for (const context of contexts) {
      const advice = advise(offers, context);
      const chosen = advice.ranked.find(entry => entry.position === advice.preferredPosition)!;
      expect(chosen.edge).toBeDefined();
      for (const entry of advice.ranked) {
        expect(chosen.edge!).toBeGreaterThanOrEqual(entry.edge!);
        expect(chosen.tierPercentile!).toBeGreaterThanOrEqual(entry.tierPercentile!);
      }
      checked++;
    }
    expect(checked).toBe(9);
  });

  it('chooses healing reduction when actual enemy healing gear appears and states the triggering damage', () => {
    const offers = [offer('upgrade_healbane', 0), offer('upgrade_rapid_rounds', 1), offer('upgrade_non_player_bonus', 2)];
    const before = advise(offers, match({ players: [player('hero_haze', 4, 1)] }));
    const after = advise(offers, match({ players: [player('hero_haze', 4, 1, [item('upgrade_vampire', 0)])] }));
    // Healbane already leads on its measured Haze win rate (Rapid Rounds' Valve-list prior fades with
    // its 24k Haze games); the enemy's healing gear adds the observed-context case on top.
    expect(score(after, 0)).toBeGreaterThan(score(before, 0) + 1);
    expect(before.reasons.join(' ')).not.toContain('healing reduction');
    expect(after.preferredPosition).toBe(0);
    expect(after.reasons.join(' ')).toContain('35% listed healing reduction');
    expect(after.reasons.join(' ')).toContain('13% listed bullet lifesteal');
    expect(after.reasons.join(' ')).toContain('Requires your spirit hits');
  });

  it('does not value a spirit-hit counter as applicable when all observed unlocked skills lack that trigger', () => {
    const context = match({ localAbilities: [ability(0, 0, false), ability(1, 0, false), ability(2, 0, true), ability(3, 0, false)], abilityCompleteness: 'complete', abilityObservation: observation(),
      players: [player('hero_dynamo', 4, 1)] });
    const result = advise([offer('upgrade_healbane', 0), offer('upgrade_rapid_rounds', 1), offer('upgrade_non_player_bonus', 2)], context);
    expect(result.preferredPosition).toBe(1);
    expect(result.ranked[0]!.reasons.join(' ')).not.toContain('targets enemy');
  });

  it('changes an offered shared debuff priority for an observed allied spirit investment', () => {
    const offers = [offer('upgrade_tech_defense_shredders', 0), offer('upgrade_rapid_rounds', 1), offer('upgrade_non_player_bonus', 2)];
    const before = match({ localAbilities: [ability(0, 0, true)], abilityCompleteness: 'partial', abilityObservation: observation() });
    const after = match({ ...before, players: [player('hero_gigawatt', 1, 0, [item('upgrade_boundless_spirit', 0)])] });
    // Compare Spirit Shredder's own entry: the final pick also depends on refreshed win rates.
    const shredder = (advice: ReturnType<typeof advise>) => advice.ranked.find(entry => entry.position === 0)!;
    const result = advise(offers, after);
    expect(shredder(result).score).toBeGreaterThan(shredder(advise(offers, before)).score);
    expect(shredder(result).reasons.join(' ')).toContain('allied Seven');
    expect(shredder(result).reasons.join(' ')).toContain('8% spirit-resist reduction');
    expect(shredder(result).reasons.join(' ')).toContain('10% shared spirit-lifesteal');
    expect(result.factsUsed?.some(fact => fact.scope === 'ally' && fact.label.includes('Boundless Spirit'))).toBe(true);
  });

  it('uses partial positive observations without treating unshown slots or players as empty', () => {
    const context = match({ localInventory: [item('upgrade_titan_round', 0)], localInventoryCompleteness: 'partial', rosterCompleteness: 'partial',
      players: [player('hero_haze', 4, 1)] });
    const result = advise(protection(), context);
    expect(result.preferredPosition).not.toBeNull();
    expect(result.limitations.join(' ')).toContain('Own loadout is partial');
    expect(result.limitations.join(' ')).toContain('no unshown ally or opponent is invented');
  });

  it('keeps exact snapshot ages past one second without claiming hidden changes were observed', () => {
    const older = observation({ capturedAt: now - 8_000, receivedAt: now - 8_000 });
    const result = advise(offense(), match({ localInventory: [item('upgrade_titan_round', 0, { observation: older })], localInventoryObservation: older }));
    expect(result.factsUsed?.find(fact => fact.label.includes('Titanic Magazine'))?.observedAt).toBe(now - 8_000);
    expect(result.limitations.join(' ')).toContain('last seen 8s ago');
    expect(result.limitations.join(' ')).toContain('later hidden changes are not confirmed');
  });

  it('cannot launder a stale loadout or rank by rereading the same round', () => {
    const stale = observation({ capturedAt: now - SCREEN_CONTEXT_MAX_AGE_MS - 1, receivedAt: now - SCREEN_CONTEXT_MAX_AGE_MS - 1 });
    const context = match({ localInventory: [item('upgrade_damage_recycler', 0, { observation: stale })], localInventoryObservation: stale,
      localAbilities: [ability(2, 1, true, { observation: stale })], abilityCompleteness: 'complete', abilityObservation: stale });
    const result = advise(offense(), context);
    expect(result.factsUsed?.some(fact => fact.label.includes('Leech') || fact.label.includes('Fixation'))).toBe(false);
    expect(result.reasons.join(' ')).not.toContain('Fixation rank 1');
    expect(isContextObservationUsable(stale, context, now, { allowSameRound: true })).toBe(false);
  });

  it('ignores an independently stale enemy item while preserving a fresh hero identity', () => {
    const stale = observation({ capturedAt: now - 31_000, receivedAt: now - 31_000 });
    const context = match({ players: [player('hero_haze', 4, 1, [item('upgrade_boundless_spirit', 0, { observation: stale })])] });
    const result = advise(protection(), context);
    const fresh = advise(protection(), match({ players: [player('hero_haze', 4, 1)] }));
    const seen = advise(protection(), match({ players: [player('hero_haze', 4, 1, [item('upgrade_boundless_spirit', 0)])] }));
    // The stale item changes nothing relative to an enemy without it, while the same item seen fresh does.
    expect(result.ranked.map(entry => entry.score)).toEqual(fresh.ranked.map(entry => entry.score));
    expect(result.preferredPosition).toBe(fresh.preferredPosition);
    expect(seen.ranked.map(entry => entry.score)).not.toEqual(fresh.ranked.map(entry => entry.score));
    expect(result.reasons.join(' ')).not.toContain('Boundless Spirit');
    expect(result.factsUsed?.some(fact => fact.label.includes('Boundless Spirit'))).toBe(false);
    expect(result.factsUsed?.some(fact => fact.scope === 'enemy' && fact.label.includes('Haze'))).toBe(true);
  });

  it.each(['spectator', 'unknown'] as const)('never assigns visible HUD investments to the player in %s view', viewMode => {
    const context = match({ viewMode, localInventory: [item('upgrade_damage_recycler', 0)], localAbilities: [ability(2, 1, true)] });
    const result = advise(offense(), context);
    expect(result.factsUsed).toEqual([]);
    expect(result.reasons.join(' ')).not.toContain('Fixation rank 1');
    expect(result.limitations.join(' ')).toMatch(/Spectating view|Participant view is not confirmed/);
  });

  it('rejects old epochs, retired game sessions, future clocks and incorrect rounds', () => {
    const context = match();
    expect(isContextObservationUsable(observation({ sessionId: 'old-session' }), context, now)).toBe(false);
    expect(isContextObservationUsable(observation({ capturedAt: now + 1, receivedAt: now + 1 }), context, now)).toBe(false);
    expect(isContextObservationUsable(observation({ round: 2 }), context, now)).toBe(false);
    expect(isContextObservationUsable(observation(), match({ retiredGameSessionIds: ['game-test'] }), now)).toBe(false);
    expect(isContextObservationUsable(observation({ confidence: Number.NaN }), context, now)).toBe(false);
    expect(isContextObservationUsable(observation({ confidence: 1.1 }), context, now)).toBe(false);
  });

  it('drops advice evidence after the actual context reducer reset', () => {
    const before = match({ localInventory: [item('upgrade_damage_recycler', 0)] });
    const reset = resetScreenMatchContext(before);
    const result = evaluateScreenOffers(offense(), catalog, { heroId: 'hero_haze', round: 3, rerolls: null, matchContext: reset, now })!;
    expect(result.factsUsed).toEqual([]);
    expect(result.limitations.join(' ')).toContain('previous game observations are not used');
    // The reset build (Damage Recycler) is gone; the hero supplied by the roster tracker still counts.
    expect(result.reasons.join(' ')).not.toContain('Damage Recycler');
    expect(result.reasons.join(' ')).toContain('Haze');
  });

  it('picks from observed context for enhanced bundles and flags the unread enhancements', () => {
    const offers = protection().map(entry => ({ ...entry, variant: 'enhanced' as const, bonusIds: null }));
    const result = advise(offers, match({ players: [player('hero_gigawatt', 4, 1)] }));
    expect(result.preferredPosition).toBe(1);
    expect(result.title).toBe("Pick Enchanter's Emblem");
    expect(result.caveat).toContain('not read');
    expect(result.ranked).toHaveLength(3);
    expect(result.reasons.join(' ')).toContain('Seven');
    expect(result.limitations.join(' ')).toContain('bonus coverage is unread');
    expect(result.comparisonPosition).toBe(1);
    expect(result.comparisonBasis).toBe('main-item-base-effects');
    // The unread enhancements are the caveat; the reasons stay plain statements.
    expect(result.reasons.join(' ')).not.toMatch(/could change|unread|observed/i);
  });

  it('keeps the main-item base comparison but credits identified bonus items on the pick score', () => {
    const offers = protection().map(entry => ({ ...entry, variant: 'unknown' as const, bonusIds: null as string[] | null }));
    const context = match({ players: [player('hero_gigawatt', 4, 1)] });
    const before = advise(offers, context);
    offers[0]!.bonusIds = ['upgrade_damage_recycler', 'upgrade_boundless_spirit'];
    const after = advise(offers, context);
    expect(before.preferredPosition).toBe(1);
    expect(before.comparisonPosition).toBe(1);
    expect(after.comparisonPosition).toBe(before.comparisonPosition);
    expect(after.caveat).toContain('not read');
    // The free items are real value: only the card that carries them gains.
    expect(after.ranked[0]!.score).toBeGreaterThan(before.ranked[0]!.score);
    expect(after.ranked.slice(1).map(entry => entry.score)).toEqual(before.ranked.slice(1).map(entry => entry.score));
    expect(after.ranked[0]!.reasons.join(' ')).toMatch(/Bonus! Also gives/);
    expect(after.limitations.join(' ')).toContain('every bonus and special modifier is excluded');
  });

  it.each(['identity', 'quality', 'tie'] as const)('picks only a resolved card and offers no base-item fallback with uncertain %s', failure => {
    let offers: ScreenOffer[] = protection().map(entry => ({ ...entry, variant: 'unknown' as const, bonusIds: null }));
    let context = match({ players: [player('hero_gigawatt', 4, 1)] });
    if (failure === 'identity') offers[0]!.itemId = 'unread-main';
    if (failure === 'quality') offers[0]!.confidence = 0.7;
    if (failure === 'tie') offers = [0, 1, 2].map(position => offer('upgrade_magic_shield', position, { variant: 'unknown', bonusIds: null }));
    const result = advise(offers, context);
    expect(result.comparisonPosition ?? null).toBeNull();
    expect(result.caveat).toContain('not read');
    if (failure === 'tie') {
      // Identical contextual scores: a deterministic pick, labelled as a close call.
      expect(result.preferredPosition).toBe(0);
      expect(result.title).toBe("Slight edge: Enchanter's Emblem");
      expect(result.reasons[0]).toContain('Close call');
    } else {
      // The uncertain card (position 0) is never the pick; the best resolved one is.
      expect(result.preferredPosition).toBe(1);
      expect(result.title).toBe("Pick Enchanter's Emblem");
      expect(result.reasons[0]).toBe(pickReason(result));
      expect(result.reasons.join(' ')).not.toMatch(/Comparison only|unread|observed/i);
      expect(result.reasons.join(' ')).toContain('Seven');
    }
  });

  it('does not treat percent-of-current-health spirit scaling as flat damage', () => {
    const shiv = CONTEXT_CATALOG.heroes.find(hero => hero.id === 'hero_shiv')!;
    const knives = CONTEXT_CATALOG.abilities.find(ability => ability.id === shiv.abilityIds[0])!;
    expect(knives.properties.find(property => property.name === 'FullRageCurrentHealthDamagePct')?.unit).toBe('percent');
    const context = match({ localHeroId: shiv.id, localAbilities: [{ slot: 0, abilityId: knives.id, rank: 3, unlocked: true, observation: observation() }], abilityCompleteness: 'partial', abilityObservation: observation() });
    const result = advise(offense(), context);
    expect(result.limitations.join(' ')).toContain('percentage-of-health damage terms are omitted');
    expect(result.ranked[0]!.reasons.join(' ')).not.toMatch(/\+0\.1 listed damage per trigger/);
    expect(result.ranked[0]!.reasons.join(' ')).not.toContain('FullRageCurrentHealthDamagePct');
  });

  it('does not prolong old ownership proof with fresh hero, loadout or ranks', () => {
    const context = match({ localInventory: [item('upgrade_damage_recycler', 0)], localAbilities: [ability(2, 1, true)] });
    context.observations.viewMode = observation({ capturedAt: now - SCREEN_CONTEXT_MAX_AGE_MS - 1, receivedAt: now - SCREEN_CONTEXT_MAX_AGE_MS - 1 });
    const result = advise(offense(), context);
    expect(result.factsUsed).toEqual([]);
    expect(result.limitations.join(' ')).toContain('Participant view is not confirmed');
  });

  it('does not infer repeated item upgrade levels or normal shop consumption rules', () => {
    const context = match({ localInventory: [item('upgrade_improved_spirit', 0), item('upgrade_vampire', 1), item('upgrade_health_stealing_magic', 2)] });
    const offers = [offer('upgrade_improved_spirit', 0), offer('upgrade_damage_recycler', 1), offer('upgrade_rapid_rounds', 2)];
    const before = structuredClone({ context, offers });
    const result = advise(offers, context);
    // The new Leech is picked; the repeated Extra Spirit (position 0) is only flagged.
    expect(result.preferredPosition).toBe(1);
    expect(result.title).toBe('Pick Leech');
    expect(result.limitations.join(' ')).toContain('no decoded Street Brawl upgrade/stacking state');
    expect({ context, offers }).toEqual(before);
    expect(result.limitations.join(' ')).not.toContain('consumes');
  });

  it('retains duplicate bonus quantities while withholding their unknown stacking operator', () => {
    const offers = offense(); offers[1]!.bonusIds = ['upgrade_improved_spirit', 'upgrade_improved_spirit'];
    const result = advise(offers, match());
    expect(result.preferredPosition).toBe(1);
    expect(result.title).toBe('Pick Rapid Rounds');
    expect(result.ranked[1]!.reasons.join(' ')).toContain('2× Extra Spirit');
    expect(result.limitations.join(' ')).toContain('upgrade/stacking state');
  });

  it('names a pick for an owned repeat but keeps the repeat warning and no base-item fallback', () => {
    const seven = CONTEXT_CATALOG.heroes.find(hero => hero.id === 'hero_gigawatt')!;
    const context = match({ localHeroId: seven.id, localInventory: [item('upgrade_improved_spirit', 0)],
      localAbilities: seven.abilityIds.map((abilityId, slot) => ({ slot: slot as 0 | 1 | 2 | 3, abilityId, rank: 3, unlocked: true, observation: observation() })),
      abilityCompleteness: 'complete', abilityObservation: observation() });
    const offers = offense().map(entry => ({ ...entry, variant: 'unknown' as const, bonusIds: null }));
    const result = advise(offers, context);
    expect(result.preferredPosition).toBe(0);
    expect(result.title).toBe('Pick Extra Spirit');
    expect(result.caveat).toContain('not read');
    expect(result.comparisonPosition ?? null).toBeNull();
    expect(result.limitations.join(' ')).toContain('repeated Extra Spirit');
    // The repeat stays a diagnostic limitation; the card's reasons do not hedge about it.
    expect(result.ranked[0]!.reasons.join(' ')).not.toMatch(/upgrade operator|unobserved/);
  });

  it('does not apply fixed source quantities when the catalogue version changes', () => {
    const context = match({ localAbilities: [ability(2, 1, true)] });
    const result = evaluateContextOffers(offense(), { ...catalog, revision: 'other-revision' }, context, now);
    expect(result.hasContext).toBe(false);
    expect(result.factsUsed).toEqual([]);
    expect(result.limitations.join(' ')).toContain('no pinned quantities or rank formulas');
  });

  it('runs a populated local comparison well inside a capture interval without I/O', () => {
    const inventory = ['upgrade_damage_recycler', 'upgrade_titan_round', 'upgrade_boundless_spirit', 'upgrade_fervor', 'upgrade_spellbreaker', 'upgrade_regenerating_bullet_shield', 'upgrade_healbane', 'upgrade_tech_defense_shredders'].map((id, slot) => item(id, slot));
    const context = match({ localInventory: inventory, localAbilities: [ability(0, 1, true), ability(1, 2, true), ability(2, 3, true), ability(3, 3, true)], abilityCompleteness: 'complete', abilityObservation: observation(),
      players: ['hero_haze', 'hero_gigawatt', 'hero_ghost', 'hero_atlas', 'hero_forge', 'hero_inferno', 'hero_dynamo'].map((id, index) => player(id, index + 1, index < 3 ? 0 : 1, inventory)) });
    const started = performance.now();
    for (let index = 0; index < 100; index++) evaluateContextOffers(protection(), catalog, context, now);
    const elapsed = performance.now() - started;
    console.info(`Observed-context benchmark: ${roundBenchmark(elapsed / 100)}ms/decision over 100 evaluations, 8-player fixture.`);
    expect(elapsed / 100).toBeLessThan(50);
  });
});

function roundBenchmark(value: number) { return Math.round(value * 100) / 100; }
