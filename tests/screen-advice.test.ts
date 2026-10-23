import { beforeEach, describe, expect, it } from 'vitest';
import publicCatalogJson from '../data/public-catalog.json';
import { evaluateScreenOffers, remainingChoiceTiers, resetDraftMemory } from '../src/screen/screen-advice';
import type { ScreenOfferContext } from '../src/screen/screen-advice';
import { streetBrawlData } from '../src/screen/street-brawl-data';
import { COUNTER_EDGE, counterResidual, streetBrawlFit } from '../src/screen/street-brawl-fit';
import { createInitialScreenMatchContext, type ScreenOffer } from '../src/shared/screen-reading';
import type { Catalog } from '../src/shared/types';

const catalog = publicCatalogJson as Catalog;
/** Hedging that belongs in `caveat` or `limitations`, never in the shown reasons. */
const HEDGE = /\b(?:un)?observed\b|not known|unread|not read|unverified|Comparison only|Offer-only|could change|base effects:/i;
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

const haze: ScreenOfferContext = { ...unknownContext, heroId: 'hero_haze' };
const draftOf = (ids: string[]) => ids.map((id, position) => offer(id, position));
/** Catalogue items of one tier (that Street Brawl drafts) ordered by measured value for a hero, weakest first. */
function tierByValue(heroId: string, tier: number): string[] {
  const data = streetBrawlData();
  return catalog.items.filter(item => item.tier === tier && data.items[item.id]?.tier === tier)
    .map(item => ({ id: item.id, value: streetBrawlFit(item.id, heroId).points }))
    .sort((a, b) => a.value - b.value || a.id.localeCompare(b.id)).map(entry => entry.id);
}
/**
 * Catalogue items of one tier ordered by the advice's own card value for a hero (weakest first).
 * A card's edge is its value minus the tier pool's average, so it does not depend on the other
 * two cards of the draft it is shown in.
 */
function tierByCardValue(heroId: string, tier: number, context: Partial<ScreenOfferContext> = {}): string[] {
  const ids = tierByValue(heroId, tier);
  const edge = new Map<string, number>();
  for (let start = 0; start < ids.length; start += 3) {
    const chunk = [0, 1, 2].map(offset => ids[(start + offset) % ids.length]!);
    const advice = evaluateScreenOffers(draftOf(chunk), catalog, { ...unknownContext, heroId, rerolls: 0, ...context })!;
    chunk.forEach((id, position) => edge.set(id, advice.ranked.find(entry => entry.position === position)!.edge!));
  }
  return [...ids].sort((a, b) => edge.get(a)! - edge.get(b)! || a.localeCompare(b));
}
/** Share of seeded random three-card drafts of one tier on which a reroll is suggested. */
function rerollRate(heroId: string, tier: number, choice: number | null, draws = 250, rerolls = 1): number {
  const pool = tierByValue(heroId, tier);
  let state = 0x2545f491 + tier;
  const next = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296; };
  let suggested = 0;
  for (let draw = 0; draw < draws; draw++) {
    const picks = new Set<string>();
    while (picks.size < 3) picks.add(pool[Math.floor(next() * pool.length)]!);
    if (evaluateScreenOffers(draftOf([...picks]), catalog, { heroId, round: null, rerolls, choice })!.rerollSuggested) suggested++;
  }
  return suggested / draws;
}

describe('visible screen-offer guidance', () => {
  beforeEach(() => resetDraftMemory());
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
    expect(advice?.reasons.join(' ')).toContain('Bullet and spirit lifesteal');
    expect(advice?.limitations.join(' ')).toContain('bonus coverage is unread');
    expect(advice?.comparisonPosition).toBe(0);
    // The unread bonus is the caveat; the reasons stay plain statements.
    expect(advice?.reasons.join(' ')).not.toMatch(HEDGE);
  });

  it.each(['unknown', 'enhanced', 'legendary', 'corrupted'] as const)('picks the best known base card and flags unread %s modifiers', variant => {
    const offers = baseOffers();
    offers[1]!.variant = variant;
    const advice = evaluateScreenOffers(offers, catalog, unknownContext);
    expect(advice?.preferredPosition).toBe(0);
    expect(advice?.title).toBe('Pick Leech');
    expect(advice?.caveat).toContain('not read');
    expect(advice?.comparisonPosition).toBe(0);
    expect(advice?.comparisonBasis).toBe('main-item-base-effects');
    // The pick's own reason leads; the unread modifier is stated once, as the caveat.
    expect(advice?.reasons[0]).toBe(pickReason(advice));
    expect(advice?.reasons.join(' ')).toContain('Bullet and spirit lifesteal');
    expect(advice?.reasons.join(' ')).not.toMatch(HEDGE);
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
    expect(advice?.reasons.join(' ')).toContain('Bullet and spirit lifesteal');
    expect(advice?.reasons.join(' ')).not.toMatch(HEDGE);

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

  it.each(['upgrade_health', 'upgrade_headshot_booster'])('never picks an unresolved card and names no pick only when no offered item resolves (%s)', resolvedId => {
    // Unresolved cards keep a zero score. Without pinned base facts the resolved tier-1
    // card scores only its Street Brawl data, which can be at or below zero (Headshot Booster
    // has a below-average win rate); neither score order nor the earlier-position tiebreak
    // may hand the pick to an unresolved card.
    const unpinned = { ...catalog, revision: 'unpinned-revision' };
    const offers = [{ ...offer('upgrade_improved_spirit', 0), itemId: 'unread-a' }, { ...offer('upgrade_improved_spirit', 1), itemId: 'unread-b' }, offer(resolvedId, 2)];
    const one = evaluateScreenOffers(offers, unpinned, { ...unknownContext, rerolls: 0 })!;
    expect(one.ranked.map(entry => entry.position)).toEqual([0, 1, 2]);
    expect(one.ranked.slice(0, 2).map(entry => entry.score)).toEqual([0, 0]);
    expect(one.ranked.slice(0, 2).every(entry => entry.reasons.join(' ').includes('Item name is not identified'))).toBe(true);
    if (resolvedId === 'upgrade_headshot_booster') expect(one.ranked[2]!.score).toBeLessThan(0);
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
      expect(advice?.caveat).toContain('not read clearly');
    } else {
      expect(advice?.comparisonPosition).toBe(0);
      expect(advice?.caveat).toContain('not read');
    }
    // The uncertainty is the caveat; the reasons stay plain statements.
    expect(advice?.reasons.join(' ')).not.toMatch(HEDGE);
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

  it.each([[1, '1 reroll left. ', 'reroll'], [2, '2 rerolls left. ', 'rerolls'], [null, '', 'reroll'], [-1, '', 'reroll']] as const)('keeps the reroll on a strong draft for a known hero, for budget %s', (rerolls, prefix, noun) => {
    const advice = evaluateScreenOffers(draftOf(tierByCardValue('hero_haze', 3).slice(-3)), catalog, { ...haze, rerolls })!;
    expect(advice.rerollSuggested).toBe(false);
    expect(advice.title).toMatch(/^(Pick|Slight edge:) /);
    expect(advice.rerollReason).toBe(`${prefix}Solid draft — keep your ${noun}.`);
  });

  it.each([1, 2, null, -1] as const)('suggests a reroll on a weak draft for a known hero, for budget %s', rerolls => {
    // The three weakest tier-3 cards for Haze: below almost every fresh tier-3 draft.
    const advice = evaluateScreenOffers(draftOf(tierByCardValue('hero_haze', 3).slice(0, 3)), catalog, { ...haze, rerolls })!;
    expect(advice.rerollSuggested).toBe(true);
    expect(advice.title).toMatch(/^Reroll — or take /);
    expect(advice.preferredPosition).not.toBeNull();
    expect(advice.rerollReason).toContain('Weak draft for Haze: a fresh tier III draft is worth more than these cards. Reroll (lost at round end).');
  });

  it('says nothing about rerolling when the hero is not identified', () => {
    const weak = draftOf(tierByValue('hero_haze', 3).slice(0, 3));
    for (const heroId of [null, 'not-a-known-hero']) {
      for (const rerolls of [1, null]) {
        const advice = evaluateScreenOffers(weak, catalog, { ...unknownContext, heroId, rerolls })!;
        expect(advice.rerollSuggested).toBe(false);
        expect(advice.title).not.toMatch(/Reroll/);
        expect(advice.rerollReason).toBe(rerolls === 1 ? '1 reroll left.' : '');
      }
    }
  });

  it('counts the Random Hero bonus reroll: a second reroll is spent at least as readily as the only one', () => {
    let state = 99;
    const next = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296; };
    let one = 0, two = 0;
    for (const tier of [1, 2, 3, 4]) {
      const pool = tierByValue('hero_haze', tier);
      for (let draw = 0; draw < 60; draw++) {
        const picks = new Set<string>();
        while (picks.size < 3) picks.add(pool[Math.floor(next() * pool.length)]!);
        const offers = draftOf([...picks]);
        for (const choice of [1, 2, 3]) {
          const single = evaluateScreenOffers(offers, catalog, { ...haze, round: null, rerolls: 1, choice })!;
          const double = evaluateScreenOffers(offers, catalog, { ...haze, round: null, rerolls: 2, choice })!;
          // The reroll budget changes only the reroll call, never the card ranking.
          expect(double.ranked).toEqual(single.ranked);
          if (single.rerollSuggested) expect(double.rerollSuggested).toBe(true);
          one += Number(single.rerollSuggested); two += Number(double.rerollSuggested);
        }
      }
    }
    expect(two).toBeGreaterThan(one);
  });

  it('rerolls a sensible share of random drafts in every tier, and never a degenerate all-or-nothing', () => {
    for (const heroId of ['hero_haze', 'hero_inferno', 'hero_artist', 'hero_viper']) {
      for (const tier of [1, 2, 3, 4, 5]) {
        const rate = rerollRate(heroId, tier, null, 150);
        expect(rate).toBeGreaterThanOrEqual(0.08);
        expect(rate).toBeLessThanOrEqual(0.75);
      }
    }
  });

  it('uses the reroll more readily at choice 3, when it would expire unused, and less readily at choice 1', () => {
    const average = (choice: number | null) => [1, 2, 3, 4, 5].reduce((sum, tier) => sum + rerollRate('hero_haze', tier, choice), 0) / 5;
    const first = average(1), unknown = average(null), last = average(3);
    expect(first).toBeLessThan(unknown);
    expect(unknown).toBeLessThan(last);
    expect(first).toBeGreaterThan(0.05);
    expect(last).toBeGreaterThan(0.25);
    // A middling draft: kept at choice 1, rerolled at choice 3.
    const pool = tierByCardValue('hero_haze', 3);
    const middling = pool.slice(2).map(id => [pool[0]!, pool[1]!, id]).find(ids => {
      const at = (choice: number) => evaluateScreenOffers(draftOf(ids), catalog, { ...haze, rerolls: 1, choice })!;
      return !at(1).rerollSuggested && at(3).rerollSuggested;
    });
    expect(middling).toBeDefined();
    const atLast = evaluateScreenOffers(draftOf(middling!), catalog, { ...haze, rerolls: 1, choice: 3 })!;
    expect(atLast.rerollReason).toContain('Reroll — it expires after this choice.');
    const strong = evaluateScreenOffers(draftOf(pool.slice(-3)), catalog, { ...haze, rerolls: 1, choice: 3 })!;
    expect(strong.rerollReason).toBe('1 reroll left. Solid draft — no reroll needed.');
  });

  it('places the draft in the round: choice tiers come from the round table when they agree with the cards', () => {
    expect(remainingChoiceTiers(1, 1, 1)).toEqual([1, 2, 3]);
    expect(remainingChoiceTiers(3, 2, 3)).toEqual([3, 4]);
    expect(remainingChoiceTiers(5, 3, 4)).toEqual([4]);
    // Unread choice: the matching choice closest to the middle.
    expect(remainingChoiceTiers(2, null, 3)).toEqual([3, 3]);
    expect(remainingChoiceTiers(1, null, 3)).toEqual([3]);
    expect(remainingChoiceTiers(4, null, 3)).toEqual([3, 4]);
    // A table that disagrees with the cards (or no round) assumes the later choices share this tier.
    expect(remainingChoiceTiers(1, 1, 4)).toEqual([4, 4, 4]);
    expect(remainingChoiceTiers(null, 3, 2)).toEqual([2]);
    expect(remainingChoiceTiers(null, null, 2)).toEqual([2, 2]);
  });

  it('shows each card\'s edge over its tier pool and its percentile within that pool', () => {
    const ordered = tierByCardValue('hero_haze', 3);
    const weak = evaluateScreenOffers(draftOf(ordered.slice(0, 3)), catalog, haze)!;
    const strong = evaluateScreenOffers(draftOf(ordered.slice(-3)), catalog, haze)!;
    for (const entry of [...weak.ranked, ...strong.ranked]) {
      expect(entry.tierPercentile).toBeGreaterThanOrEqual(0);
      expect(entry.tierPercentile).toBeLessThanOrEqual(100);
    }
    expect(Math.max(...weak.ranked.map(entry => entry.edge!))).toBeLessThan(0);
    expect(Math.min(...strong.ranked.map(entry => entry.edge!))).toBeGreaterThan(0);
    expect(Math.max(...weak.ranked.map(entry => entry.tierPercentile!))).toBeLessThan(15);
    expect(Math.min(...strong.ranked.map(entry => entry.tierPercentile!))).toBeGreaterThan(85);
    // Edge follows the card ranking of the offer-only pick.
    const byScore = [...strong.ranked].sort((a, b) => b.score - a.score);
    expect([...byScore].sort((a, b) => b.edge! - a.edge!).map(entry => entry.position)).toEqual(byScore.map(entry => entry.position));
    // No hero: no tier pool, so neither number.
    const unknown = evaluateScreenOffers(draftOf(ordered.slice(-3)), catalog, unknownContext)!;
    expect(unknown.ranked.every(entry => entry.edge === undefined && entry.tierPercentile === undefined)).toBe(true);
  });

  it('makes no reroll call on a draft that is not fully read or holds an owned item', () => {
    const weak = draftOf(tierByValue('hero_haze', 3).slice(0, 3));
    const partial = evaluateScreenOffers(weak.slice(0, 2), catalog, { ...haze, rerolls: 1 })!;
    expect(partial.rerollSuggested).toBe(false);
    expect(partial.rerollReason).toBe('1 reroll left.');
    const unread = evaluateScreenOffers(weak.map((entry, index) => index === 2 ? { ...entry, itemId: 'unread-item' } : entry), catalog, { ...haze, rerolls: 1 })!;
    expect(unread.rerollSuggested).toBe(false);
    const owned = evaluateScreenOffers(weak, catalog, { ...haze, rerolls: 1, ownedItemIds: [weak[0]!.itemId] })!;
    expect(owned.rerollSuggested).toBe(false);
  });

  it('treats an offered item you already own as a likely misread: it does not drive the pick and adds no warning line', () => {
    const plain = evaluateScreenOffers(baseOffers(), catalog, unknownContext)!;
    expect(plain.preferredPosition).toBe(0);
    // A new draft that already shows an owned item (not one just taken from it).
    resetDraftMemory();
    const advice = evaluateScreenOffers(baseOffers(), catalog, { ...unknownContext, ownedItemIds: ['upgrade_damage_recycler'] })!;
    expect(advice.preferredPosition).not.toBeNull();
    expect(advice.preferredPosition).not.toBe(0);
    expect([...advice.reasons, ...advice.ranked.flatMap(entry => entry.reasons)].join(' ')).not.toContain('already own');
    expect(advice.limitations.join(' ')).toContain('likely misread');
    // When every readable card is owned, the best of them is still named.
    resetDraftMemory();
    const all = evaluateScreenOffers(baseOffers(), catalog, { ...unknownContext, ownedItemIds: baseOffers().map(entry => entry.itemId) })!;
    expect(all.preferredPosition).toBe(0);
  });

  it('keeps the same pick and reroll call after the picked card shows up as owned while the draft is still on screen', () => {
    const offers = draftOf(tierByCardValue('hero_haze', 3).slice(0, 3));
    const context: ScreenOfferContext = { ...haze, round: 2, rerolls: 1, choice: 2, ownedItemIds: ['upgrade_magic_storm'] };
    const before = evaluateScreenOffers(offers, catalog, context)!;
    expect(before.preferredPosition).not.toBeNull();
    const taken = offers.find(entry => entry.position === before.preferredPosition)!.itemId;
    const after = evaluateScreenOffers(offers, catalog, { ...context, ownedItemIds: [...context.ownedItemIds!, taken] })!;
    expect(after.preferredPosition).toBe(before.preferredPosition);
    expect(after.title).toBe(before.title);
    expect(after.rerollSuggested).toBe(before.rerollSuggested);
    expect(after.ranked).toEqual(before.ranked);
    expect(after.limitations.join(' ')).not.toContain('likely misread');
  });

  it('tells the player to take the best card at zero rerolls and does not infer budget from the round', () => {
    const advice = evaluateScreenOffers(baseOffers(), catalog, { heroId: null, round: 5, rerolls: 0 })!;
    expect(advice.rerollReason).toBe('No rerolls left — take the best card.');
    expect(advice.rerollSuggested).toBe(false);
    expect(advice.title).toBe('Pick Leech');
    const weak = evaluateScreenOffers(draftOf(tierByValue('hero_haze', 3).slice(0, 3)), catalog, { heroId: 'hero_haze', round: 5, rerolls: 0 })!;
    expect(weak.rerollSuggested).toBe(false);
    expect(weak.title).not.toContain('Reroll');
    expect(weak.rerollReason).toBe('No rerolls left — take the best card.');
    const unknown = evaluateScreenOffers(baseOffers(), catalog, { heroId: null, round: 5, rerolls: null })!;
    expect(unknown.rerollReason).toBe('');
    expect(unknown.rerollSuggested).toBe(false);
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
    expect(advice.reasons[1]).toBe(pickReason(advice));
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
    // The pick's own reasons are the reasons, without qualifiers about the unverified context;
    // no line describes one of the other cards.
    expect(advice.reasons[0]).toBe(pickReason(advice));
    expect(advice.reasons.some(reason => reason.includes('Bullet and spirit lifesteal'))).toBe(true);
    expect(advice.reasons.join(' ')).not.toMatch(HEDGE);
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
    // The unverified context is a limitation, not a qualifier among the shown reasons.
    expect(advice.reasons.join(' ')).not.toMatch(HEDGE);
    expect(advice.limitations.join(' ')).toContain('Own build and team context are unverified');
    const incompatible = evaluateScreenOffers(baseOffers(), { ...catalog, revision: 'unknown' }, unknownContext)!;
    expect(incompatible.preferredPosition).toBe(0); expect(incompatible.comparisonPosition ?? null).toBeNull();
    expect(incompatible.title).toBe('Pick Leech');
    expect(incompatible.reasons.join(' ')).not.toContain('+180 base health');
    expect(incompatible.limitations.join(' ')).toContain('does not match the supported base mechanics');
  });

  it('credits the free item of a Bonus! card and names it', () => {
    const offers = baseOffers();
    const before = evaluateScreenOffers(offers, catalog, unknownContext)!;
    // Active Reload (position 1) carries a read bonus item.
    const withBonus = offers.map(entry => entry.position === 1 ? { ...entry, bonusIds: ['upgrade_endurance'], bonusExpected: true } : entry);
    const after = evaluateScreenOffers(withBonus, catalog, unknownContext)!;
    const score = (advice: typeof before) => advice.ranked.find(entry => entry.position === 1)!.score;
    expect(score(after)).toBeGreaterThan(score(before) + 0.7);
    expect(after.ranked.find(entry => entry.position === 1)!.reasons.join(' ')).toContain('Bonus! Also gives Extra Regen for free.');
    // Other cards are unchanged.
    expect(after.ranked.find(entry => entry.position === 0)!.score).toBe(before.ranked.find(entry => entry.position === 0)!.score);
  });

  it('credits an expected but unidentified bonus and says which owned item the upgrade absorbs', () => {
    const offers = [offer('upgrade_superior_stamina', 1, { bonusIds: null, bonusExpected: true, absorbsIds: ['upgrade_improved_stamina'] }),
      offer('upgrade_greater_withering_whip', 0), offer('upgrade_magic_storm', 2)];
    const plain = evaluateScreenOffers(offers.map(entry => ({ ...entry, bonusIds: [], bonusExpected: undefined, absorbsIds: undefined })), catalog, unknownContext)!;
    const advice = evaluateScreenOffers(offers, catalog, unknownContext)!;
    const entry = advice.ranked.find(value => value.position === 1)!;
    expect(entry.score).toBeGreaterThan(plain.ranked.find(value => value.position === 1)!.score);
    expect(entry.reasons.join(' ')).toContain('Bonus! card: it also gives a free lower-tier item.');
    expect(entry.reasons.join(' ')).toContain('Upgrades your Extra Stamina, which it absorbs.');
    expect(advice.caveat).toMatch(/Bonus! card's free item was not read/);
  });

  it('does not offer the base-item fallback comparison in an explicitly spectated or ended view', () => {
    const offers = baseOffers().map(entry => ({ ...entry, variant: 'unknown' as const, bonusIds: null }));
    for (const patch of [{ viewMode: 'spectator' as const }, { phase: 'finished' as const }]) {
      const advice = evaluateScreenOffers(offers, catalog, { ...unknownContext, matchContext: { ...createInitialScreenMatchContext(), ...patch } })!;
      expect(advice.comparisonPosition ?? null).toBeNull();
      expect(advice.comparisonBasis).toBeUndefined();
      expect(advice.reasons.join(' ')).not.toMatch(HEDGE);
      if (patch.phase === 'finished') {
        // An ended match has no pick to make.
        expect(advice.preferredPosition).toBeNull();
        expect(advice.title).not.toMatch(/^Pick|^Slight edge|^Reroll/);
        expect(advice.reasons[0]).toBe('The match has ended; there is no pick to make.');
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

  it('states reasons plainly on the common path: no "observed", "not known" or "unread" hedging', () => {
    const enemies = ['hero_atlas', 'hero_wraith', 'hero_ghost', 'hero_kelvin'];
    const contexts: ScreenOfferContext[] = [unknownContext, haze, { ...haze, enemyHeroIds: enemies, rerolls: 1, choice: 2 },
      { ...unknownContext, heroId: 'hero_gigawatt', matchContext: createInitialScreenMatchContext(), now: 10_000 }];
    let state = 7;
    const next = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296; };
    for (const tier of [1, 2, 3, 4]) {
      const pool = tierByValue('hero_haze', tier);
      for (let draw = 0; draw < 12; draw++) {
        const picks = new Set<string>();
        while (picks.size < 3) picks.add(pool[Math.floor(next() * pool.length)]!);
        const plain = draftOf([...picks]);
        // Live reads often leave variants and bonus coverage unread.
        const unreadDetails = plain.map(entry => ({ ...entry, variant: 'unknown' as const, bonusIds: null }));
        for (const offers of [plain, unreadDetails]) for (const context of contexts) {
          const advice = evaluateScreenOffers(offers, catalog, context)!;
          const shown = [...advice.reasons, ...advice.ranked.flatMap(entry => entry.reasons), advice.rerollReason];
          for (const reason of shown) expect(reason).not.toMatch(HEDGE);
          expect(advice.reasons.join(' ')).not.toMatch(/General-purpose|Base mechanics only|Bonus details not read|already own/);
        }
      }
    }
  });

  it('puts a genuine weakness against an identified enemy right after the lead reason', () => {
    const data = streetBrawlData();
    const enemyIds = Object.keys(data.heroes).filter(id => id !== 'hero_haze');
    const weakest = catalog.items.filter(item => data.items[item.id]?.tier === item.tier && item.tier !== null && item.tier <= 4)
      .flatMap(item => enemyIds.map(enemyId => ({ item, enemyId, residual: counterResidual(item.id, enemyId) ?? 0 })))
      .reduce((a, b) => b.residual < a.residual ? b : a);
    expect(weakest.residual).toBeLessThanOrEqual(-COUNTER_EDGE);
    const others = tierByValue('hero_haze', weakest.item.tier!).filter(id => id !== weakest.item.id).slice(-2);
    const advice = evaluateScreenOffers(draftOf([weakest.item.id, ...others]), catalog, { ...haze, enemyHeroIds: [weakest.enemyId] })!;
    const card = advice.ranked.find(entry => entry.position === 0)!;
    expect(card.reasons[1]).toMatch(new RegExp(`^Weak against ${data.heroes[weakest.enemyId]!.name} \\(-\\d`));
  });
});
