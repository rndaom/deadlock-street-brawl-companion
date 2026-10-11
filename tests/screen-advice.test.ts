import { describe, expect, it } from 'vitest';
import publicCatalogJson from '../data/public-catalog.json';
import { evaluateScreenOffers } from '../src/screen/screen-advice';
import type { ScreenOfferContext } from '../src/screen/screen-advice';
import { createInitialScreenMatchContext, type ScreenOffer } from '../src/shared/screen-reading';
import type { Catalog } from '../src/shared/types';

const catalog = publicCatalogJson as Catalog;
const unknownContext: ScreenOfferContext = { heroId: null, round: null, rerolls: null };
function offer(itemId: string, position: number, overrides: Partial<ScreenOffer> = {}): ScreenOffer {
  const item = catalog.items.find(candidate => candidate.id === itemId);
  if (!item) throw new Error(`Missing pinned fixture item ${itemId}`);
  return { position, itemId, name: item.name, bonusIds: [], variant: 'base', confidence: 1, warning: null, ...overrides };
}
/** The first reason of the named pick's own ranked entry, which now leads advice.reasons. */
function pickReason(advice: ReturnType<typeof evaluateScreenOffers>): string | undefined {
  return advice?.ranked.find(entry => entry.position === advice.preferredPosition)?.reasons[0];
}
function baseOffers(): ScreenOffer[] {
  return [
    offer('upgrade_improved_spirit', 2),
    offer('upgrade_damage_recycler', 0),
    offer('upgrade_active_reload', 1),
  ];
}

describe('visible screen-offer guidance', () => {
  it('gives a useful real base-offer preference without a roster, ranks or validated legacy model', () => {
    const offers = baseOffers();
    const before = structuredClone({ offers, catalog });
    const advice = evaluateScreenOffers(offers, catalog, unknownContext);
    expect(catalog.liveModelValidated).toBe(false);
    expect(advice?.preferredPosition).toBe(0);
    expect(advice?.title).toBe('Pick Leech');
    expect(advice?.caveat).toBeUndefined();
    // Measured Street Brawl results lead, followed by the item mechanics.
    expect(advice?.reasons[0]).toMatch(/^Wins \d+% of /);
    expect(advice?.reasons.join(' ')).toContain('Bullet and spirit lifesteal');
    expect(advice?.reasons.join(' ')).toContain('+180 base health');
    expect(advice?.reasons.join(' ')).toContain('+12 spirit power');
    expect(advice?.ranked.map(entry => entry.position)).toEqual([2, 0, 1]);
    expect(advice?.limitations.join(' ')).toContain('Hero not identified');
    expect(advice?.limitations.join(' ')).toContain('not win odds');
    expect(advice?.limitations.join(' ')).toContain('teammate items and enemy needs are not read');
    expect({ offers, catalog }).toEqual(before);
  });

  it('changes the comparison from the hero actually identified, without making up ability investment', () => {
    const offers = [offer('upgrade_active_reload', 0), offer('upgrade_improved_spirit', 1), offer('upgrade_improved_bullet_armor', 2)];
    const haze = evaluateScreenOffers(offers, catalog, { ...unknownContext, heroId: 'hero_haze' });
    const seven = evaluateScreenOffers(offers, catalog, { ...unknownContext, heroId: 'hero_gigawatt' });
    expect(haze?.preferredPosition).not.toBe(1);
    expect(haze?.preferredPosition).not.toBeNull();
    expect(seven?.preferredPosition).toBe(1);
    expect(seven?.reasons.join(' ')).toContain('Seven');
    expect(seven?.reasons.join(' ')).toContain('spirit');
    expect(seven?.limitations.join(' ')).toContain('ability investment');
    const unknownHero = evaluateScreenOffers(offers, catalog, { ...unknownContext, heroId: 'not-a-known-hero' });
    expect(unknownHero?.limitations.join(' ')).toContain('Hero not identified');
  });

  it('includes actually identified bonuses and their quantities in the full bundle', () => {
    const offers = [offer('upgrade_active_reload', 0), offer('upgrade_improved_spirit', 1), offer('upgrade_kinetic_sash', 2)];
    const context = { ...unknownContext, heroId: 'hero_gigawatt' };
    const before = evaluateScreenOffers(offers, catalog, context)!;
    offers[0]!.bonusIds = ['upgrade_improved_spirit', 'upgrade_improved_spirit'];
    const after = evaluateScreenOffers(offers, catalog, context)!;
    expect(after.preferredPosition).toBe(0);
    expect(after.ranked.find(entry => entry.position === 0)!.score)
      .toBeGreaterThan(before.ranked.find(entry => entry.position === 0)!.score);
    expect(after.ranked.find(entry => entry.position === 0)!.reasons.join(' ')).toContain('2× Extra Spirit');
    expect(after.reasons.join(' ')).toContain('2× Extra Spirit');
    expect(after.limitations.join(' ')).toContain('stacking rules');
  });

  it('still picks the best known card when bonus coverage is unread, with a caveat', () => {
    const offers = baseOffers();
    offers[1]!.bonusIds = null;
    const advice = evaluateScreenOffers(offers, catalog, unknownContext);
    expect(advice).not.toBeNull();
    expect(advice?.preferredPosition).toBe(0);
    expect(advice?.title).toBe('Pick Leech');
    expect(advice?.caveat).toContain('not read');
    expect(advice?.ranked).toHaveLength(3);
    expect(advice?.reasons.join(' ')).toContain('Leech base effects');
    expect(advice?.limitations.join(' ')).toContain('bonus coverage is unread');
    expect(advice?.comparisonPosition).toBe(0);
    expect(advice?.reasons.join(' ')).toContain('Offer-only guidance');
  });

  it.each(['unknown', 'enhanced', 'legendary', 'corrupted'] as const)('picks the best known base card and flags unread %s modifiers', variant => {
    const offers = baseOffers();
    offers[1]!.variant = variant;
    const advice = evaluateScreenOffers(offers, catalog, unknownContext);
    expect(advice?.preferredPosition).toBe(0);
    expect(advice?.title).toBe('Pick Leech');
    expect(advice?.caveat).toContain('not read');
    expect(advice?.reasons.join(' ')).toContain('base effects');
    expect(advice?.comparisonPosition).toBe(0);
    expect(advice?.comparisonBasis).toBe('main-item-base-effects');
    // The pick's own reason leads; the unread-modifier qualifier is still stated.
    expect(advice?.reasons[0]).toBe(pickReason(advice));
    expect(advice?.reasons.join(' ')).toContain('special effects are unread and could change');
  });

  it('keeps all three live-read card comparisons and a stable pick when every bundle has unresolved enhancement details', () => {
    const offers = baseOffers().map(entry => ({
      ...entry, variant: 'enhanced' as const, bonusIds: null,
      confidence: 0.946, warning: 'Enhanced effects and bonus icons are not fully read.',
    }));
    const advice = evaluateScreenOffers(offers, catalog, unknownContext);
    expect(advice).not.toBeNull();
    expect(advice?.preferredPosition).toBe(0);
    expect(advice?.title).toBe('Pick Leech');
    expect(advice?.caveat).toContain('not read');
    expect(advice?.ranked.map(entry => entry.position)).toEqual([2, 0, 1]);
    expect(advice?.comparisonPosition).toBe(0);
    expect(advice?.limitations.join(' ')).toContain('every bonus and special modifier is excluded');
    expect(advice?.reasons.join(' ')).toContain('Leech base effects');

    // Recognition quality can vary between images without removing comparison
    // rows or flipping the named pick.
    for (const entry of offers) entry.confidence = 0.927;
    const next = evaluateScreenOffers(offers, catalog, unknownContext);
    expect(next?.ranked.map(entry => entry.position)).toEqual([2, 0, 1]);
    expect(next?.preferredPosition).toBe(0);
    expect(next?.title).toBe('Pick Leech');
  });

  it('retains an unidentified card row and never picks it when the catalogue recognizes the other two names', () => {
    const offers = baseOffers();
    offers[0] = { ...offers[0]!, itemId: '', name: 'Unread item choice', variant: 'unknown', bonusIds: null, confidence: 0 };
    const advice = evaluateScreenOffers(offers, catalog, unknownContext);
    expect(advice).not.toBeNull();
    expect(advice?.preferredPosition).toBe(0);
    expect(advice?.title).toBe('Pick Leech');
    expect(advice?.caveat).toContain('not read');
    expect(advice?.ranked).toHaveLength(3);
    expect(advice?.ranked.find(entry => entry.position === 2)!.reasons.join(' ')).toContain('Item name is not identified');
    expect(advice?.ranked.find(entry => entry.position === 2)!.score).toBe(0);
    expect(advice?.ranked.find(entry => entry.position === 0)!.reasons.join(' ')).toContain('lifesteal');
  });

  it.each(['upgrade_health', 'upgrade_non_player_bonus'])('never picks an unresolved card and names no pick only when no offered item resolves (%s)', resolvedId => {
    // Unresolved cards keep a zero score. Without pinned base facts the resolved tier-1
    // card scores only its Street Brawl data, which can be at or below zero (Monster Rounds
    // has a below-average win rate); neither score order nor the earlier-position tiebreak
    // may hand the pick to an unresolved card.
    const unpinned = { ...catalog, revision: 'unpinned-revision' };
    const offers = [{ ...offer('upgrade_improved_spirit', 0), itemId: 'unread-a' }, { ...offer('upgrade_improved_spirit', 1), itemId: 'unread-b' }, offer(resolvedId, 2)];
    const one = evaluateScreenOffers(offers, unpinned, { ...unknownContext, rerolls: 0 })!;
    expect(one.ranked.map(entry => entry.position)).toEqual([0, 1, 2]);
    expect(one.ranked.slice(0, 2).map(entry => entry.score)).toEqual([0, 0]);
    expect(one.ranked.slice(0, 2).every(entry => entry.reasons.join(' ').includes('Item name is not identified'))).toBe(true);
    if (resolvedId === 'upgrade_non_player_bonus') expect(one.ranked[2]!.score).toBeLessThan(0);
    expect(one.preferredPosition).toBe(2);
    expect(one.title).toBe(`Pick ${offers[2]!.name}`);
    expect(one.rerollReason).toBe('No rerolls left — take the best card.');
    offers[2]!.itemId = 'unread-c';
    const none = evaluateScreenOffers(offers, unpinned, { ...unknownContext, rerolls: 2 })!;
    expect(none.preferredPosition).toBeNull();
    expect(none.title).not.toMatch(/^Pick|^Slight edge|^Reroll/);
    expect(none.reasons[0]).toContain('No offered item can be resolved');
    expect(none.rerollSuggested).toBe(false);
    expect(none.ranked).toHaveLength(3);
  });

  it.each(['item', 'bonus', 'quality', 'warning'] as const)('still picks the best known card when %s evidence on another card is uncertain', failure => {
    const offers = baseOffers();
    if (failure === 'item') offers[2]!.itemId = 'unidentified-item';
    if (failure === 'bonus') offers[2]!.bonusIds = ['unidentified-bonus'];
    if (failure === 'quality') offers[2]!.confidence = 0.84;
    if (failure === 'warning') offers[2]!.warning = 'Bonus icon is ambiguous.';
    const advice = evaluateScreenOffers(offers, catalog, unknownContext);
    expect(advice?.preferredPosition).toBe(0);
    expect(advice?.title).toBe('Pick Leech');
    expect(advice?.ranked).toHaveLength(3);
    // The pick's own reason leads; the comparison qualifiers follow it.
    expect(advice?.reasons[0]).toBe(pickReason(advice));
    if (failure === 'item' || failure === 'quality') {
      // An unreliable main-item read still blocks the base-item fallback comparison.
      expect(advice?.comparisonPosition ?? null).toBeNull();
      expect(advice?.reasons.join(' ')).toContain('Comparison only');
      expect(advice?.caveat).toContain('not read clearly');
    } else {
      expect(advice?.comparisonPosition).toBe(0);
      expect(advice?.reasons.join(' ')).toContain('Offer-only guidance');
      expect(advice?.caveat).toContain('not read');
    }
  });

  it('distinguishes fixed own protection from an enemy resistance debuff and guards its pinned values', () => {
    const offers = [offer('upgrade_escalating_exposure', 0), offer('upgrade_improved_spirit', 1), offer('upgrade_active_reload', 2)];
    const current = evaluateScreenOffers(offers, catalog, unknownContext)!;
    const updated = evaluateScreenOffers(offers, { ...catalog, revision: 'different-source-revision' }, unknownContext)!;
    expect(current.ranked[0]!.score).toBeGreaterThan(updated.ranked[0]!.score);
    expect(current.ranked[0]!.reasons.join(' ')).toContain('stacking Spirit Amp');
    expect(current.ranked[0]!.reasons.join(' ')).not.toContain('8% spirit resist');
    const leechOtherBuild = evaluateScreenOffers(baseOffers(), { ...catalog, clientVersion: 'different-build' }, unknownContext)!;
    expect(leechOtherBuild.reasons.join(' ')).not.toContain('+180 base health');
    expect(leechOtherBuild.reasons.join(' ')).not.toContain('+12 spirit power');
  });

  it('explains timed execution instead of assuming conditional effects are always available', () => {
    const advice = evaluateScreenOffers(baseOffers(), catalog, unknownContext)!;
    const reload = advice.ranked.find(entry => entry.position === 1)!;
    expect(reload.reasons.join(' ')).toContain('Requires a timed reload');
  });

  it('does not reward NPC-only damage as a hero-fight build direction', () => {
    const offers = [offer('upgrade_non_player_bonus', 0), offer('upgrade_rapid_rounds', 1), offer('upgrade_improved_spirit', 2)];
    const advice = evaluateScreenOffers(offers, catalog, { ...unknownContext, heroId: 'hero_haze' });
    expect(advice?.preferredPosition).toBe(1);
    expect(advice?.ranked.find(entry => entry.position === 0)!.reasons.join(' ')).toContain('against NPCs');
  });

  it.each([
    [1, '1 reroll left.'], [2, '2 rerolls left.'], [null, 'Reroll count not read.'], [-1, 'Reroll count not read.'],
  ] as const)('keeps rerolls when the best card is strong, for budget %s', (rerolls, prefix) => {
    const advice = evaluateScreenOffers(baseOffers(), catalog, { ...unknownContext, rerolls })!;
    expect(advice.rerollSuggested).toBe(false);
    expect(advice.title).toBe('Pick Leech');
    expect(advice.rerollReason.startsWith(prefix)).toBe(true);
    expect(advice.rerollReason).toContain('keep your rerolls');
  });

  it.each([1, 2, null, -1] as const)('suggests a reroll when every card is weak and the budget is %s', rerolls => {
    // Three tier-1 Extra Spirit cards score 0.6 (0.35 × 1.5 offer-only points + 0.08
    // Street Brawl win-rate points), below the keep threshold of 1 (1.5 with two rerolls).
    const offers = [0, 1, 2].map(position => offer('upgrade_improved_spirit', position));
    const advice = evaluateScreenOffers(offers, catalog, { ...unknownContext, rerolls })!;
    expect(advice.rerollSuggested).toBe(true);
    expect(advice.title).toBe('Reroll — or take Extra Spirit');
    expect(advice.preferredPosition).not.toBeNull();
    expect(advice.rerollReason).toContain('a reroll is likely to offer something better');
  });

  it('raises the keep threshold when two or more rerolls remain', () => {
    // Lifestrike scores 1.25 (tier-3 points, offer-only heuristic and Street Brawl data): enough
    // to keep at one reroll (threshold 1), not with two left (threshold 1.5).
    const offers = [offer('upgrade_boxing_glove', 0), offer('upgrade_improved_spirit', 1), offer('upgrade_improved_spirit', 2)];
    const one = evaluateScreenOffers(offers, catalog, { ...unknownContext, rerolls: 1 })!;
    const best = one.ranked.find(entry => entry.position === 0)!.score;
    expect(best).toBeGreaterThanOrEqual(1);
    expect(best).toBeLessThan(1.5);
    expect(one.rerollSuggested).toBe(false);
    expect(one.title).toBe('Pick Lifestrike');
    expect(one.rerollReason.startsWith('1 reroll left.')).toBe(true);
    const two = evaluateScreenOffers(offers, catalog, { ...unknownContext, rerolls: 2 })!;
    expect(two.ranked.map(entry => entry.score)).toEqual(one.ranked.map(entry => entry.score));
    expect(two.rerollSuggested).toBe(true);
    expect(two.title).toBe('Reroll — or take Lifestrike');
    expect(two.preferredPosition).toBe(0);
    expect(two.rerollReason.startsWith('2 rerolls left.')).toBe(true);
  });

  it('tells the player to take the best card at zero rerolls and does not infer budget from the round', () => {
    const advice = evaluateScreenOffers(baseOffers(), catalog, { heroId: null, round: 5, rerolls: 0 })!;
    expect(advice.rerollReason).toBe('No rerolls left — take the best card.');
    expect(advice.rerollSuggested).toBe(false);
    expect(advice.title).toBe('Pick Leech');
    const weak = evaluateScreenOffers([0, 1, 2].map(position => offer('upgrade_improved_spirit', position)), catalog, { heroId: null, round: 5, rerolls: 0 })!;
    expect(weak.rerollSuggested).toBe(false);
    expect(weak.title).not.toContain('Reroll');
    expect(weak.rerollReason).toBe('No rerolls left — take the best card.');
    const unknown = evaluateScreenOffers(baseOffers(), catalog, { heroId: null, round: 5, rerolls: null })!;
    expect(unknown.rerollReason).toContain('Reroll count not read');
  });

  it('names the best known card when only two positions are read', () => {
    const advice = evaluateScreenOffers(baseOffers().slice(0, 2), catalog, unknownContext)!;
    expect(advice.preferredPosition).toBe(0);
    expect(advice.title).toBe('Pick Leech');
    expect(advice.limitations.join(' ')).toContain('All three distinct offer positions have not been identified');
    expect(evaluateScreenOffers([], catalog, unknownContext)).toBeNull();
  });

  it('names the item whose score won when two cards share a read position', () => {
    // Extra Spirit (1.5) and Leech (7.65) are both read at position 0.
    const duplicate = baseOffers();
    duplicate[0]!.position = duplicate[1]!.position;
    const advice = evaluateScreenOffers(duplicate, catalog, unknownContext)!;
    expect(advice.limitations.join(' ')).toContain('All three distinct offer positions have not been identified');
    expect(advice.preferredPosition).toBe(0);
    expect(advice.title).toBe('Pick Leech');
  });

  it('flags a close call between equivalent offers and keeps a deterministic pick', () => {
    const offers = [0, 1, 2].map(position => offer('upgrade_improved_spirit', position));
    const advice = evaluateScreenOffers(offers, catalog, { ...unknownContext, rerolls: 0 })!;
    expect(advice.preferredPosition).toBe(0);
    expect(advice.title).toBe('Slight edge: Extra Spirit');
    expect(advice.reasons[0]).toContain('Close call');
    expect(advice.reasons.join(' ')).toContain('similar general value');
    const strong = evaluateScreenOffers([0, 1, 2].map(position => offer('upgrade_damage_recycler', position)), catalog, { ...unknownContext, rerolls: 1 })!;
    expect(strong.title).toBe('Slight edge: Leech');
    expect(strong.rerollSuggested).toBe(false);
  });

  it('gives an explicitly offer-only main-item pick when the real match context is unavailable', () => {
    const offers = baseOffers().map(entry => ({ ...entry, variant: 'unknown' as const, bonusIds: null }));
    const advice = evaluateScreenOffers(offers, catalog, { ...unknownContext, heroId: 'hero_haze',
      matchContext: createInitialScreenMatchContext(), now: 10_000 })!;
    expect(advice.preferredPosition).toBe(0); expect(advice.comparisonPosition).toBe(0);
    expect(advice.title).toBe('Pick Leech');
    expect(advice.caveat).toContain('not read');
    // The pick's own reasons lead, followed by the offer-only base comparison and its qualifier;
    // no line describes one of the other cards.
    expect(advice.reasons[0]).toBe(pickReason(advice));
    expect(advice.reasons.some(reason => reason.includes('Leech base effects'))).toBe(true);
    expect(advice.reasons.at(-1)).toContain('your build and teams are unverified');
    const others = offers.filter(entry => entry.position !== advice.preferredPosition).map(entry => catalog.items.find(item => item.id === entry.itemId)?.name)
      .filter((name): name is string => !!name && name !== 'Leech');
    expect(advice.reasons.every(reason => others.every(name => !reason.includes(name)))).toBe(true);
    // No observed match facts are used, but the supplied hero (from the roster tracker) is.
    expect(advice.reasons.join(' ')).toContain('Haze'); expect(advice.factsUsed).toEqual([]);
  });

  it('labels unverified ownership and incompatible catalogue mechanics while still naming a pick', () => {
    const advice = evaluateScreenOffers(baseOffers(), catalog, { ...unknownContext, matchContext: createInitialScreenMatchContext() })!;
    expect(advice.preferredPosition).toBe(0); expect(advice.comparisonPosition).toBe(0);
    expect(advice.title).toBe('Pick Leech');
    expect(advice.caveat).toBeUndefined();
    expect(advice.factsUsed).toEqual([]);
    expect(advice.reasons[0]).toBe(pickReason(advice));
    const qualifier = advice.reasons.find(reason => reason.includes('Only the main item is compared'));
    expect(qualifier).toBeDefined();
    expect(qualifier).not.toContain('unread');
    expect(advice.limitations.join(' ')).toContain('Own build and team context are unverified');
    const incompatible = evaluateScreenOffers(baseOffers(), { ...catalog, revision: 'unknown' }, unknownContext)!;
    expect(incompatible.preferredPosition).toBe(0); expect(incompatible.comparisonPosition ?? null).toBeNull();
    expect(incompatible.title).toBe('Pick Leech');
    expect(incompatible.reasons.join(' ')).not.toContain('+180 base health');
    expect(incompatible.limitations.join(' ')).toContain('does not match the supported base mechanics');
  });

  it('excludes every bonus equally from an offer-only pick when special effects are unread', () => {
    const offers = baseOffers().map(entry => ({ ...entry, variant: 'unknown' as const, bonusIds: null as string[] | null }));
    const before = evaluateScreenOffers(offers, catalog, unknownContext)!;
    offers[0]!.bonusIds = Array(8).fill('upgrade_damage_recycler');
    const after = evaluateScreenOffers(offers, catalog, unknownContext)!;
    expect(before.preferredPosition).toBe(0);
    expect(after.preferredPosition).toBe(before.preferredPosition); expect(after.comparisonPosition).toBe(before.comparisonPosition);
    expect(after.title).toBe(before.title);
    expect(after.ranked.map(entry => entry.score)).toEqual(before.ranked.map(entry => entry.score));
    expect(after.reasons.join(' ')).not.toContain('Included');
  });

  it('does not offer the base-item fallback comparison in an explicitly spectated or ended view', () => {
    const offers = baseOffers().map(entry => ({ ...entry, variant: 'unknown' as const, bonusIds: null }));
    for (const patch of [{ viewMode: 'spectator' as const }, { phase: 'finished' as const }]) {
      const advice = evaluateScreenOffers(offers, catalog, { ...unknownContext, matchContext: { ...createInitialScreenMatchContext(), ...patch } })!;
      expect(advice.comparisonPosition ?? null).toBeNull();
      expect(advice.comparisonBasis).toBeUndefined();
      expect(advice.reasons.join(' ')).toContain('Comparison only');
      if (patch.phase === 'finished') {
        // An ended match has no pick to make.
        expect(advice.preferredPosition).toBeNull();
        expect(advice.title).not.toMatch(/^Pick|^Slight edge|^Reroll/);
        expect(advice.reasons[0]).toContain('Comparison only');
      } else {
        // Drafts are only shown to players, so a spectator-tagged draft still names the best card.
        expect(advice.preferredPosition).toBe(0);
        expect(advice.title).toBe('Pick Leech');
        expect(advice.reasons[0]).toBe(pickReason(advice));
      }
    }
  });

  it('adds 0.6 general-value points per item tier above 1, capped at tier 5', () => {
    // Only Leech's catalogue tier changes: same offers, same mechanics, same Street Brawl data.
    const withLeechTier = (tier: number) => ({ ...catalog, items: catalog.items.map(item => item.id === 'upgrade_damage_recycler' ? { ...item, tier } : item) });
    const ranked = (tier: number) => evaluateScreenOffers(baseOffers(), withLeechTier(tier), unknownContext)!.ranked;
    const leechScore = (tier: number) => ranked(tier).find(entry => entry.position === 0)!.score;
    const tier1 = leechScore(1);
    for (const tier of [2, 3, 4, 5]) expect(leechScore(tier)).toBeCloseTo(tier1 + 0.6 * (tier - 1), 5);
    expect(leechScore(6)).toBe(leechScore(5));
    expect(leechScore(9)).toBe(leechScore(5));
    // The other cards are untouched by Leech's tier.
    const others = (tier: number) => ranked(tier).filter(entry => entry.position !== 0).map(entry => entry.score);
    expect(others(1)).toEqual(others(5));
  });
});
