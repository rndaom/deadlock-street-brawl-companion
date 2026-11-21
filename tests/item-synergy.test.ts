import { afterEach, describe, expect, it } from 'vitest';
import { buildItemPairs, DEFAULT_PAIR_PRIOR_MATCHES, MIN_PAIR_GAMES, pairStat, pairSynergy, synergiesWith } from '../src/screen/item-synergy';
import { isStreetBrawlData, setStreetBrawlData, streetBrawlData, type ItemPairs, type StreetBrawlData } from '../src/screen/street-brawl-data';
import { estimatePriorGames } from '../src/screen/street-brawl-fetch';
import { draftPool, ownedSynergy, streetBrawlFit, SYNERGY_EDGE } from '../src/screen/street-brawl-fit';

const bundled = streetBrawlData();
afterEach(() => { setStreetBrawlData(bundled); });

const logit = (p: number) => Math.log(p / (1 - p));
const expit = (x: number) => 1 / (1 + Math.exp(-x));
const className = (id: number) => id < 100 ? `item_${id}` : undefined;

/** Eight items at 46-53%; every pair wins exactly what its two items predict, except the ones given. */
function synthetic(extra: (a: number, b: number) => number, matches = 50_000) {
  const items = Array.from({ length: 8 }, (_, id) => ({ item_id: id, wins: Math.round((0.46 + id / 100) * 100_000), matches: 100_000 }));
  const base = items.reduce((sum, row) => sum + row.wins, 0) / items.reduce((sum, row) => sum + row.matches, 0);
  const pairs = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    const p = expit(logit(items[a]!.wins / 100_000) + logit(items[b]!.wins / 100_000) - logit(base) + extra(a, b));
    pairs.push({ item_ids: [a, b], wins: Math.round(p * matches), matches });
  }
  return { items, pairs };
}
const liftOf = (table: ItemPairs, a: string, b: string) => {
  for (let at = 0; at < table.rows.length; at += 4) {
    const x = table.items[table.rows[at]!], y = table.items[table.rows[at + 1]!];
    if ((x === a && y === b) || (x === b && y === a)) return table.rows[at + 2]! / 10_000;
  }
  return null;
};

describe('item-pair lift', () => {
  it('is zero for a pair that wins what its two items predict, and measures a real synergy in win-rate points', () => {
    const { items, pairs } = synthetic((a, b) => a === 1 && b === 2 ? 0.16 : 0);
    const table = buildItemPairs(pairs, items, className, estimatePriorGames)!;
    expect(table.rows.length).toBe(28 * 4);
    // +0.16 log-odds is about +4 win-rate points; with only seven partners per item the per-item part
    // soaks up a share of it (about 1/170 with the real item list).
    expect(liftOf(table, 'item_1', 'item_2')!).toBeGreaterThan(0.025);
    expect(liftOf(table, 'item_1', 'item_2')!).toBeLessThan(0.045);
    expect(Math.abs(liftOf(table, 'item_5', 'item_6')!)).toBeLessThan(0.006);
  });

  it('removes the part an item wins beside anything (long or won games), keeping only the pair\'s own part', () => {
    // Item 3 wins 3 points more in every pair than its own rate predicts: selection, not synergy.
    const { items, pairs } = synthetic((a, b) => a === 3 || b === 3 ? 0.12 : 0);
    const table = buildItemPairs(pairs, items, className, estimatePriorGames)!;
    for (let other = 0; other < 8; other++) if (other !== 3) expect(Math.abs(liftOf(table, 'item_3', `item_${other}`)!)).toBeLessThan(0.0005);
  });

  it('drops small pairs, unknown items and malformed rows, and gives null without usable pairs', () => {
    const { items, pairs } = synthetic(() => 0);
    const mixed = [...pairs.slice(0, 5), { item_ids: [0, 1], wins: 10, matches: MIN_PAIR_GAMES - 1 }, { item_ids: [0, 500], wins: 600, matches: 2_000 },
      { item_ids: [0], wins: 600, matches: 2_000 }, null as never, { item_ids: [4, 4], wins: 600, matches: 2_000 }];
    expect(buildItemPairs(mixed, items, className, estimatePriorGames)!.rows.length).toBe(5 * 4);
    expect(buildItemPairs([], items, className, estimatePriorGames)).toBeNull();
    expect(buildItemPairs(pairs, [], className, estimatePriorGames)).toBeNull();
  });

  it('estimates its shrinkage prior from the spread beyond noise, within bounds', () => {
    const { items, pairs } = synthetic(() => 0);
    // No synergy anywhere: all spread is noise, so the prior is as strong as allowed.
    expect(buildItemPairs(pairs, items, className, estimatePriorGames)!.priorMatches).toBe(20_000);
    expect(buildItemPairs(pairs, items, className, () => 5)!.priorMatches).toBe(100);
    expect(buildItemPairs(pairs.slice(0, 3), items, className, (_samples, fallback) => fallback)!.priorMatches).toBe(DEFAULT_PAIR_PRIOR_MATCHES);
  });
});

/** The bundled data with a hand-made pair table. */
function withPairs(rows: [string, string, number, number][], priorMatches = 4_000): StreetBrawlData {
  const items = [...new Set(rows.flatMap(([a, b]) => [a, b]))];
  return { ...bundled, itemPairs: { priorMatches, minMatches: 1_000, items, rows: rows.flatMap(([a, b, lift, n]) => [items.indexOf(a), items.indexOf(b), Math.round(lift * 10_000), n]) } };
}
const ids = Object.keys(bundled.items).filter(id => bundled.globalItemStats[id]);
const [offered, ownedA, ownedB, ownedC, ownedD] = ids as [string, string, string, string, string];
const hero = Object.keys(bundled.heroes)[0]!;

describe('item-pair synergy in the pick', () => {
  it('shrinks a pair toward zero by its sample: a pair of prior-many games keeps half its lift', () => {
    const data = withPairs([[offered, ownedA, 0.04, 4_000], [offered, ownedB, 0.04, 36_000]]);
    expect(pairSynergy(offered, ownedA, data)).toBeCloseTo(0.02, 6);
    expect(pairSynergy(ownedA, offered, data)).toBeCloseTo(0.02, 6);
    expect(pairSynergy(offered, ownedB, data)).toBeCloseTo(0.036, 6);
    expect(pairSynergy(offered, ownedC, data)).toBeNull();
  });

  it('scores the shrunk lift (no noise band: the shrinking alone is calibrated), capped at 2 points', () => {
    setStreetBrawlData(withPairs([[offered, ownedA, 0.02, 1_000_000]], 1));
    // 2.0 points shrunk by 1,000,000 / 1,000,001, at 60 per win-rate point.
    expect(ownedSynergy(offered, [ownedA]).points).toBeCloseTo(0.02 * 60, 3);
    expect(streetBrawlFit(offered, hero, [], [ownedA]).points).toBeCloseTo(streetBrawlFit(offered, hero).points + 1.2, 1);
    // A small lift scores in proportion; a pair of `priorMatches` games keeps half of its lift.
    setStreetBrawlData(withPairs([[offered, ownedA, 0.004, 1_000_000]], 1));
    expect(ownedSynergy(offered, [ownedA]).points).toBeCloseTo(0.004 * 60, 3);
    setStreetBrawlData(withPairs([[offered, ownedA, 0.004, 1_000]], 1_000));
    expect(ownedSynergy(offered, [ownedA]).points).toBeCloseTo(0.002 * 60, 3);
    // Four strong partners would add 6.6 points; the cap holds it at 2 (and at -2 the other way).
    setStreetBrawlData(withPairs([ownedA, ownedB, ownedC, ownedD].map(id => [offered, id, 0.033, 1_000_000] as [string, string, number, number]), 1));
    expect(ownedSynergy(offered, [ownedA, ownedB, ownedC, ownedD]).points).toBe(2);
    setStreetBrawlData(withPairs([ownedA, ownedB, ownedC, ownedD].map(id => [offered, id, -0.033, 1_000_000] as [string, string, number, number]), 1));
    expect(ownedSynergy(offered, [ownedA, ownedB, ownedC, ownedD]).points).toBe(-2);
  });

  it('is exactly today\'s result with no owned items, no pair data or no pair for the owned items', () => {
    const plain = streetBrawlFit(offered, hero, []);
    expect(streetBrawlFit(offered, hero, [], [])).toEqual(plain);
    setStreetBrawlData({ ...withPairs([]), itemPairs: undefined });
    expect(streetBrawlFit(offered, hero, [], [ownedA, ownedB])).toEqual(plain);
    setStreetBrawlData(withPairs([[ownedC, ownedD, 0.05, 50_000]]));
    expect(streetBrawlFit(offered, hero, [], [ownedA, ownedB, 'upgrade_not_real'])).toEqual(plain);
    // The item itself in the owned list (a misread) and duplicates count once at most.
    setStreetBrawlData(withPairs([[offered, ownedA, 0.05, 50_000]]));
    expect(streetBrawlFit(offered, hero, [], [offered, ownedA, ownedA])).toEqual(streetBrawlFit(offered, hero, [], [ownedA]));
  });

  it('names the owned item and the measured effect, leading when it outweighs the rest', () => {
    setStreetBrawlData(withPairs([[offered, ownedA, 0.045, 50_000], [offered, ownedB, -0.035, 50_000]]));
    const nameA = bundled.items[ownedA]!.name, nameB = bundled.items[ownedB]!.name;
    const fit = streetBrawlFit(offered, null, [], [ownedA, ownedB]);
    const good = (0.045 * 50_000 / 54_000 * 100).toFixed(1), bad = (0.035 * 50_000 / 54_000 * 100).toFixed(1);
    expect(fit.reasons.join(' ')).toContain(`Pairs well with your ${nameA} (+${good}).`);
    expect(fit.concerns.join(' ')).toContain(`Pairs poorly with your ${nameB} (-${bad}).`);
    setStreetBrawlData(withPairs([[offered, ownedA, 0.045, 50_000]]));
    // +2 synergy points against the item's own result.
    if (streetBrawlFit(offered, null).points < 2) expect(streetBrawlFit(offered, null, [], [ownedA]).reasons[0]).toMatch(/^Pairs well with your /);
    // Below the naming edge: scored, not named.
    setStreetBrawlData(withPairs([[offered, ownedA, SYNERGY_EDGE * 0.9, 1_000_000]], 1));
    const quiet = streetBrawlFit(offered, null, [], [ownedA]);
    expect(quiet.reasons.join(' ')).not.toContain('Pairs');
    expect(quiet.points).toBeGreaterThan(streetBrawlFit(offered, null).points);
  });

  it('ignores an owned item the pick would absorb (it is gone once the card is taken)', () => {
    const upgrade = 'upgrade_arcane_surge', component = 'upgrade_improved_stamina';
    expect(bundled.items[upgrade] && bundled.items[component]).toBeTruthy();
    setStreetBrawlData(withPairs([[upgrade, component, 0.05, 50_000]]));
    expect(ownedSynergy(upgrade, [component]).points).toBe(0);
    expect(ownedSynergy(component, [upgrade]).points).toBeGreaterThan(0);
  });

  it('skips damaged rows and rejects a malformed table in a saved download', () => {
    const data = withPairs([[offered, ownedA, 0.05, 50_000], [offered, ownedB, 0.05, 50_000]]);
    data.itemPairs!.rows[2] = Number.NaN;
    data.itemPairs!.rows[4] = 99;
    expect(pairStat(offered, ownedA, data)).toBeNull();
    expect(synergiesWith(offered, [ownedA, ownedB], data)).toEqual([]);
    expect(isStreetBrawlData({ ...bundled, itemPairs: { ...bundled.itemPairs!, rows: [1, 2, 3] } })).toBe(false);
    expect(isStreetBrawlData({ ...bundled, itemPairs: { items: 'x' } as never })).toBe(false);
  });

  it('adds the same synergy to a fresh draft\'s cards when owned items are given', () => {
    const tier = bundled.items[offered]!.tier;
    const partner = ids.find(id => bundled.items[id]!.tier > tier)!;
    setStreetBrawlData(withPairs([[offered, partner, 0.04, 1_000_000]], 1));
    const plain = draftPool(hero, tier)!, owned = draftPool(hero, tier, [], { owned: [partner] })!;
    const card = (pool: typeof plain) => pool.find(entry => entry.id === offered)!.value;
    expect(card(owned) - card(plain)).toBeCloseTo(2, 6);
    expect(owned.filter(entry => entry.id !== offered).map(entry => entry.value)).toEqual(plain.filter(entry => entry.id !== offered).map(entry => entry.value));
  });
});

describe('bundled pair table', () => {
  it('holds all-hero pairs of 1,000+ games with an estimated prior', () => {
    const table = bundled.itemPairs!;
    expect(table.rows.length / 4).toBeGreaterThan(5_000);
    expect(table.minMatches).toBe(MIN_PAIR_GAMES);
    expect(table.priorMatches).toBeGreaterThanOrEqual(1_000);
    for (let at = 3; at < table.rows.length; at += 4) expect(table.rows[at]!).toBeGreaterThanOrEqual(MIN_PAIR_GAMES);
    // Shrunk, no pair moves more than a few win-rate points.
    let largest = 0;
    for (let at = 0; at < table.rows.length; at += 4) largest = Math.max(largest, Math.abs(pairSynergy(table.items[table.rows[at]!]!, table.items[table.rows[at + 1]!]!, bundled)!));
    expect(largest).toBeLessThan(0.08);
  });
});
