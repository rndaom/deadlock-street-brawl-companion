import { describe, expect, it } from 'vitest';
import { streetBrawlData, type StreetBrawlData } from '../src/screen/street-brawl-data';
import { bestOfThree, COUNTER_EDGE, counterResidual, draftPool, enhancedPoints, expectedBest, GOOD_DRAW_SHARE, itemDelta, poolMean, poolPercentile, rerollPlan,
  shrinkToward, streetBrawlFit } from '../src/screen/street-brawl-fit';
import { matchInsights } from '../src/screen/match-insights';

const data = streetBrawlData();
/** Every enemy × item pair with Street Brawl data, with its raw per-enemy delta and its residual. */
const pairs = Object.keys(data.heroes).flatMap(enemyId => Object.entries(data.heroes[enemyId]!.versusItemStats ?? {})
  .filter(([itemId]) => !!data.globalItemStats[itemId])
  .map(([itemId, stat]) => ({ enemyId, itemId, raw: stat.delta, residual: counterResidual(itemId, enemyId)! })));
const counterLine = (itemId: string, enemyId: string) => streetBrawlFit(itemId, null, [enemyId]).reasons.find(reason => reason.startsWith('Counters '));

describe('Street Brawl counter evidence', () => {
  it('measures the residual over the general delta, shrunk to the per-enemy sample size', () => {
    const { enemyId, itemId } = pairs[0]!;
    const versus = data.heroes[enemyId]!.versusItemStats![itemId]!, general = data.globalItemStats[itemId]!;
    const shrink = (matches: number) => matches / (matches + data.priorMatches);
    expect(counterResidual(itemId, enemyId)).toBeCloseTo(versus.delta - general.delta * shrink(versus.matches) / shrink(general.matches), 10);
    expect(counterResidual(itemId, 'hero_not_real')).toBeNull();
    expect(counterResidual('upgrade_not_real', enemyId)).toBeNull();
  });

  it('does not call a generally strong item a counter when it does no better than usual against that enemy', () => {
    // The old rule labelled every per-enemy delta of +1.5 points a counter; most are just strong items.
    const generic = pairs.filter(pair => pair.raw >= COUNTER_EDGE && Math.abs(pair.residual) < 0.005);
    expect(generic.length).toBeGreaterThan(20);
    for (const pair of generic.slice(0, 40)) {
      expect(counterLine(pair.itemId, pair.enemyId)).toBeUndefined();
      // Inside the noise band the enemy adds no points either.
      expect(streetBrawlFit(pair.itemId, null, [pair.enemyId]).points).toBe(streetBrawlFit(pair.itemId, null).points);
    }
    const labelled = pairs.filter(pair => counterLine(pair.itemId, pair.enemyId));
    expect(labelled.every(pair => pair.residual >= COUNTER_EDGE)).toBe(true);
    expect(labelled.length).toBeLessThan(pairs.filter(pair => pair.raw >= COUNTER_EDGE).length / 2);
  });

  it('names a genuine counter and a genuine weakness, and scores them', () => {
    const best = pairs.reduce((a, b) => b.residual > a.residual ? b : a);
    const worst = pairs.reduce((a, b) => b.residual < a.residual ? b : a);
    expect(best.residual).toBeGreaterThanOrEqual(COUNTER_EDGE);
    expect(worst.residual).toBeLessThanOrEqual(-COUNTER_EDGE);
    const strong = streetBrawlFit(best.itemId, null, [best.enemyId]);
    expect(strong.reasons.join(' ')).toContain(`Counters ${data.heroes[best.enemyId]!.name} (+`);
    expect(strong.points).toBeGreaterThan(streetBrawlFit(best.itemId, null).points);
    const weak = streetBrawlFit(worst.itemId, null, [worst.enemyId]);
    expect(weak.concerns[0]).toMatch(new RegExp(`^Weak against ${data.heroes[worst.enemyId]!.name} \\(-\\d`));
    expect(weak.points).toBeLessThan(streetBrawlFit(worst.itemId, null).points);
  });

  it('leads with a counter when it outweighs an about-average general result', () => {
    const pair = pairs.find(entry => entry.residual >= 0.03 && Math.abs(data.globalItemStats[entry.itemId]!.delta) < 0.005);
    expect(pair).toBeDefined();
    expect(streetBrawlFit(pair!.itemId, null, [pair!.enemyId]).reasons[0]).toMatch(/^Counters /);
  });

  it('ignores the own hero and duplicates in the enemy list', () => {
    const { enemyId, itemId } = pairs.find(pair => pair.residual >= COUNTER_EDGE)!;
    expect(streetBrawlFit(itemId, enemyId, [enemyId])).toEqual(streetBrawlFit(itemId, enemyId));
    expect(streetBrawlFit(itemId, null, [enemyId, enemyId])).toEqual(streetBrawlFit(itemId, null, [enemyId]));
  });

  it('lists only genuine counters on the wishlist', () => {
    const enemies = ['hero_atlas', 'hero_wraith', 'hero_ghost', 'hero_kelvin'];
    const insights = matchInsights('hero_haze', enemies, [])!;
    const entries = insights.wishlist.flatMap(row => row.items);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      for (const enemyId of entry.counters) expect(counterResidual(entry.itemId, enemyId)!).toBeGreaterThanOrEqual(COUNTER_EDGE);
      for (const enemyId of enemies.filter(id => !entry.counters.includes(id))) expect(counterResidual(entry.itemId, enemyId) ?? 0).toBeLessThan(COUNTER_EDGE);
    }
  });
});

describe('per-hero item results, shrunk toward the all-hero result', () => {
  const synthetic = (heroMatches: number, good: boolean): StreetBrawlData => ({
    ...data, heroPriorMatches: 600, goodPrior: 0.01,
    globalItemStats: { upgrade_x: { delta: 0.02, winRate: 0.52, matches: 100_000 } },
    heroes: { hero_x: { id: 1, name: 'X', type: null, gun: null, good: good ? ['upgrade_x'] : [],
      itemStats: heroMatches ? { upgrade_x: { delta: -0.04, winRate: 0.46, matches: heroMatches } } : {} } },
  });

  it('weights the hero\'s own result by its sample size against the prior', () => {
    expect(shrinkToward(-0.04, 600, 0.02, 600)).toBeCloseTo(-0.01, 10);
    expect(shrinkToward(-0.04, 0, 0.02, 600)).toBe(0.02);
    expect(shrinkToward(-0.04, 1e9, 0.02, 600)).toBeCloseTo(-0.04, 5);
  });

  it('follows the all-hero result for a thin hero sample and the hero\'s own result for a large one', () => {
    expect(itemDelta('upgrade_x', 'hero_x', synthetic(0, false))).toBeCloseTo(0.02, 10);
    expect(itemDelta('upgrade_x', 'hero_x', synthetic(60, false))).toBeCloseTo((60 * -0.04 + 600 * 0.02) / 660, 10);
    expect(itemDelta('upgrade_x', 'hero_x', synthetic(600, false))).toBeCloseTo(-0.01, 10);
    expect(itemDelta('upgrade_x', 'hero_x', synthetic(200_000, false))).toBeCloseTo(-0.04, 3);
    // Without a hero: the all-hero result; unknown item: nothing.
    expect(itemDelta('upgrade_x', null, synthetic(600, false))).toBe(0.02);
    expect(itemDelta('upgrade_y', 'hero_x', synthetic(600, false))).toBeNull();
  });

  it('treats Valve\'s Good list as a prior that fades as the hero\'s own sample grows', () => {
    const lift = (matches: number) => itemDelta('upgrade_x', 'hero_x', synthetic(matches, true))! - itemDelta('upgrade_x', 'hero_x', synthetic(matches, false))!;
    expect(lift(0)).toBeCloseTo(0.01, 10);
    expect(lift(600)).toBeCloseTo(0.005, 10);
    expect(lift(60_000)).toBeLessThan(0.0001);
    expect(lift(0)).toBeGreaterThan(lift(600));
  });

  it('uses the shrunk value in the bundled data, so a well-sampled hero result outweighs the all-hero one', () => {
    const k = data.heroPriorMatches!;
    expect(k).toBeGreaterThanOrEqual(100);
    const heroId = 'hero_haze';
    const [itemId, stat] = Object.entries(data.heroes[heroId]!.itemStats).filter(([id]) => !!data.globalItemStats[id])
      .sort((a, b) => b[1].matches - a[1].matches)[0]!;
    const prior = data.globalItemStats[itemId]!.delta + (data.heroes[heroId]!.good.includes(itemId) ? data.goodPrior ?? 0 : 0);
    expect(itemDelta(itemId, heroId)).toBeCloseTo((stat.matches * stat.delta + k * prior) / (stat.matches + k), 10);
    expect(Math.abs(itemDelta(itemId, heroId)! - stat.delta)).toBeLessThan(Math.abs(itemDelta(itemId, heroId)! - prior) + 1e-12);
  });
});

describe('fresh-draft model and reroll decision', () => {
  const card = (id: string, value: number, weight = 1) => ({ id, value, weight });

  it('gives the exact best-of-three distribution for uniform draws without replacement', () => {
    const pool = [0, 1, 2, 3, 4, 5].map(value => card(`c${value}`, value));
    const best = bestOfThree(pool);
    const choose = (n: number, k: number) => k === 2 ? n * (n - 1) / 2 : n * (n - 1) * (n - 2) / 6;
    // The best card is the m-th smallest when the other two come from the m-1 below it.
    expect(best.values).toEqual([2, 3, 4, 5]);
    best.values.forEach((value, index) => expect(best.probs[index]).toBeCloseTo(choose(value, 2) / choose(6, 3), 12));
    expect(expectedBest(best)).toBeCloseTo((2 * 1 + 3 * 3 + 4 * 6 + 5 * 10) / 20, 12);
  });

  it('draws heavier cards more often', () => {
    const light = bestOfThree([card('a', 0), card('b', 1), card('c', 2), card('d', 3)]);
    const heavy = bestOfThree([card('a', 0), card('b', 1), card('c', 2), card('d', 3, 5)]);
    expect(heavy.probs.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 12);
    expect(heavy.probs.at(-1)!).toBeGreaterThan(light.probs.at(-1)!);
  });

  it('solves the round: rerolls only when a fresh draft beats keeping the card and the reroll', () => {
    const coin = { values: [0, 10], probs: [0.5, 0.5] };
    // Last choice, one reroll: reroll below the expected fresh draft (5).
    expect(rerollPlan(4, 1, [coin])).toMatchObject({ reroll: true, keep: 4, refresh: 5 });
    expect(rerollPlan(6, 1, [coin]).reroll).toBe(false);
    // Two choices left, one reroll: keeping the reroll for the next choice is worth E[max(X, 5)] = 7.5,
    // a reroll now is worth 5 + 5 = 10, so reroll only below 2.5.
    expect(rerollPlan(4, 1, [coin, coin])).toMatchObject({ reroll: false, keep: 11.5, refresh: 10 });
    expect(rerollPlan(2, 1, [coin, coin]).reroll).toBe(true);
    // A second reroll (Random Hero) raises the bar: with two left, a 6 is rerolled at the last choice.
    expect(rerollPlan(6, 2, [coin])).toMatchObject({ reroll: true, refresh: 7.5 });
    expect(rerollPlan(-100, 0, [coin]).reroll).toBe(false);
    expect(rerollPlan(-100, -1, [coin]).reroll).toBe(false);
  });

  it('matches a brute-force simulation of the round', () => {
    // Three choices with different value spreads, one or two rerolls.
    const stages = [{ values: [0, 2, 3], probs: [0.3, 0.4, 0.3] }, { values: [1, 4], probs: [0.6, 0.4] }, { values: [0, 6], probs: [0.7, 0.3] }];
    // Brute force: value of optimal play by full recursion over outcomes.
    const solve = (choice: number, left: number, shown: number | null): number => {
      if (choice === stages.length) return 0;
      if (shown === null) return stages[choice]!.values.reduce((sum, value, index) => sum + stages[choice]!.probs[index]! * solve(choice, left, value), 0);
      const keep = shown + solve(choice + 1, left, null);
      return left > 0 ? Math.max(keep, solve(choice, left - 1, null)) : keep;
    };
    for (const rerolls of [1, 2]) for (const shown of [0, 1, 2, 3, 4]) {
      const plan = rerollPlan(shown, rerolls, stages);
      expect(plan.keep).toBeCloseTo(shown + solve(1, rerolls, null), 10);
      expect(plan.refresh).toBeCloseTo(solve(0, rerolls - 1, null), 10);
      expect(Math.max(plan.keep, plan.refresh)).toBeCloseTo(solve(0, rerolls, shown), 10);
    }
  });

  it('weights a real tier pool by Valve\'s Good-bucket share and ranks cards within it', () => {
    const pool = draftPool('hero_haze', 3)!;
    const good = new Set(data.heroes.hero_haze!.good);
    expect(pool.reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(1, 12);
    if (pool.some(entry => good.has(entry.id))) expect(pool.filter(entry => good.has(entry.id)).reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(GOOD_DRAW_SHARE[3]!, 12);
    const values = pool.map(entry => entry.value);
    expect(poolPercentile(Math.min(...values) - 1, pool)).toBe(0);
    expect(poolPercentile(Math.max(...values) + 1, pool)).toBe(100);
    expect(poolMean(pool)).toBeGreaterThan(Math.min(...values));
    expect(draftPool('hero_haze', 3, [], { exclude: new Set(pool.slice(0, 5).map(entry => entry.id)) })!.length).toBe(pool.length - 5);
    expect(draftPool('hero_not_real', 3)).toBeNull();
    expect(draftPool('hero_haze', 9)).toBeNull();
  });

  it('values Enhanced cards by their measured uplift over the plain item', () => {
    const enhanced = data.enhanced!;
    expect(enhanced.share).toBeGreaterThan(0); expect(enhanced.share).toBeLessThan(1);
    const [itemId, stat] = Object.entries(enhanced.items).sort((a, b) => b[1].matches - a[1].matches)[0]!;
    expect(enhancedPoints(itemId)).toBeCloseTo(Math.max(-4, Math.min(4, stat.uplift * 60)), 2);
    expect(enhancedPoints('upgrade_not_real')).toBeCloseTo(enhanced.meanUplift * 60, 2);
    expect(enhancedPoints(itemId, { ...data, enhanced: undefined })).toBe(1);
  });
});
