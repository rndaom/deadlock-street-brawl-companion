import { describe, expect, it } from 'vitest';
import { enhancedStats, estimatePriorGames, fetchStreetBrawlData, STREET_BRAWL_PATCH_START, streetBrawlWindow } from '../src/screen/street-brawl-fetch';

const DAY = 86_400;
const NOW = STREET_BRAWL_PATCH_START + 20 * DAY;

/** A small deterministic API: two heroes (one thin), 30 items, ability ids 11-14 / 21-24. */
function mockApi() {
  const urls: string[] = [];
  const items = Array.from({ length: 30 }, (_, index) => ({ id: 100 + index, class_name: `upgrade_${index}`, name: `Item ${index}`, type: 'upgrade', shopable: true,
    item_tier: 1 + index % 4, item_slot_type: 'weapon' }));
  const heroes = [
    { id: 1, class_name: 'hero_a', name: 'A', item_draft_bucketing: { upgrade_0: { bucket: 'Good' }, upgrade_1: { bucket: 'Normal' } } },
    { id: 2, class_name: 'hero_b', name: 'B', item_draft_bucketing: {} },
  ];
  // Item i wins (45 + i % 10)% of its games; hero rows differ per hero.
  const rows = (scale: number, bucket?: number) => items.map((item, index) => ({ item_id: item.id, ...(bucket ? { bucket } : {}),
    matches: scale * (10 + index), wins: Math.round(scale * (10 + index) * (0.45 + (index % 10) / 100)) }));
  const fetchJson = async (url: string): Promise<unknown> => {
    urls.push(url);
    const path = url.replace('https://api.deadlock-api.com', '');
    if (path.startsWith('/v1/assets/items')) return items;
    if (path.startsWith('/v1/assets/heroes')) return heroes;
    if (path.startsWith('/v1/analytics/hero-stats')) return [{ hero_id: 1, wins: 6000, matches: 12_000 }, { hero_id: 2, wins: 900, matches: 2_000 }];
    if (path.startsWith('/v1/analytics/hero-counter-stats')) return [{ hero_id: 1, enemy_hero_id: 2, wins: 300, matches_played: 500 }];
    if (path.startsWith('/v1/analytics/ability-order-stats')) {
      const base = path.includes('hero_id=1') ? 10 : 20;
      // One empty order (the API returns these) and one with an unknown ability id.
      return [{ abilities: [], wins: 50, matches: 90 }, { abilities: [base + 1, base + 2, base + 1, base + 3], wins: 300, matches: 500 },
        { abilities: [base + 1, 999], wins: 10, matches: 20 }];
    }
    if (path.includes('enhanced_items=only')) return rows(5).map(row => ({ ...row, wins: Math.round(row.matches * 0.53) }));
    if (path.includes('enhanced_items=exclude')) return rows(40);
    if (path.includes('bucket=hero')) return [...rows(30, 1), ...rows(3, 2)];
    if (path.includes('hero_id=2')) return rows(9).map(row => ({ ...row, bucket: 2 }));
    if (path.includes('enemy_hero_ids=')) return rows(20);
    if (path.startsWith('/v1/analytics/item-stats')) return rows(100);
    throw new Error(`unexpected ${path}`);
  };
  return { urls, fetchJson };
}
const slots = new Map([11, 12, 13, 14, 21, 22, 23, 24].map(id => [String(id), (id % 10) - 1]));

describe('Street Brawl download', () => {
  it('reads only the current patch window: since the patch, at least 14 and at most 45 days back', () => {
    expect(streetBrawlWindow(NOW).since).toBe(STREET_BRAWL_PATCH_START);
    expect(streetBrawlWindow(STREET_BRAWL_PATCH_START + 3 * DAY).since).toBe(STREET_BRAWL_PATCH_START + 3 * DAY - 14 * DAY);
    expect(streetBrawlWindow(STREET_BRAWL_PATCH_START + 100 * DAY).since).toBe(STREET_BRAWL_PATCH_START + 55 * DAY);
    // Whole UTC days, so the API can answer every refresh of the day from its cache.
    expect(streetBrawlWindow(STREET_BRAWL_PATCH_START + 3 * DAY + 12_345).since).toBe(STREET_BRAWL_PATCH_START + 3 * DAY - 14 * DAY);
    expect(streetBrawlWindow(STREET_BRAWL_PATCH_START + 3 * DAY + 12_345).since % DAY).toBe(0);
    expect(streetBrawlWindow(NOW, NOW - 12_345).since).toBe(NOW - 12_345);
    expect(streetBrawlWindow(NOW).wideSince).toBe(NOW - 90 * DAY);
    expect(streetBrawlWindow(NOW, 12345).since).toBe(12345);
  });

  it('puts the window on every analytics request and gives a thin hero the wide window', async () => {
    const { urls, fetchJson } = mockApi();
    const data = await fetchStreetBrawlData(slots, fetchJson, { now: NOW });
    const { since, wideSince } = streetBrawlWindow(NOW);
    const analytics = urls.filter(url => url.includes('/analytics/'));
    expect(analytics.length).toBeGreaterThan(8);
    for (const url of analytics) expect(url).toMatch(new RegExp(`min_unix_timestamp=(${since}|${wideSince})\\b`));
    // Hero B (2,000 games) re-reads its own rows over the wide window; hero A keeps the patch window.
    expect(analytics.filter(url => url.includes(`min_unix_timestamp=${wideSince}`)).every(url => /hero_id=2/.test(url))).toBe(true);
    // Its per-enemy rows stay in the patch window, like the all-hero result they are compared with.
    expect(analytics.filter(url => url.includes('enemy_hero_ids=')).every(url => url.includes(`min_unix_timestamp=${since}`))).toBe(true);
    expect(analytics.some(url => url.includes('hero_id=2') && url.includes(`min_unix_timestamp=${wideSince}`))).toBe(true);
    expect(data.heroes.hero_b!.wideWindow).toBe(true);
    expect(data.heroes.hero_a!.wideWindow).toBeUndefined();
    expect(data.window).toEqual({ since: new Date(since * 1000).toISOString(), wideSince: new Date(wideSince * 1000).toISOString() });
    expect(data.schemaVersion).toBe(2);
  });

  it('drops empty and unreadable ability orders', async () => {
    const { fetchJson } = mockApi();
    const data = await fetchStreetBrawlData(slots, fetchJson, { now: NOW });
    expect(data.heroes.hero_a!.abilityOrders).toEqual([{ order: '0102', wins: 300, matches: 500 }]);
    expect(data.heroes.hero_b!.abilityOrders).toEqual([{ order: '0102', wins: 300, matches: 500 }]);
  });

  it('keeps per-hero results raw (relative to the hero\'s own average) with an estimated shrinkage prior', async () => {
    const { fetchJson } = mockApi();
    const data = await fetchStreetBrawlData(slots, fetchJson, { now: NOW });
    const stats = data.heroes.hero_a!.itemStats;
    const weighted = Object.values(stats).reduce((sum, stat) => sum + stat.delta * stat.matches, 0);
    expect(Math.abs(weighted)).toBeLessThan(Object.keys(stats).length); // raw deltas average out around the hero's base
    expect(stats.upgrade_9!.delta).toBeCloseTo(stats.upgrade_9!.winRate - (stats.upgrade_0!.winRate - stats.upgrade_0!.delta), 2);
    expect(data.heroPriorMatches).toBeGreaterThanOrEqual(100);
    expect(data.heroes.hero_a!.good).toEqual(['upgrade_0']);
    expect(data.enhanced!.meanUplift).toBeGreaterThan(0);
  });

  it('estimates a prior from the spread of effects beyond sampling noise', () => {
    // True effects ±0.02 (variance 0.0004) with negligible noise: about 0.25 / 0.0004 = 625 games.
    const samples = Array.from({ length: 200 }, (_, index) => ({ effect: index % 2 ? 0.02 : -0.02, noise: 0 }));
    expect(estimatePriorGames(samples, 1)).toBeGreaterThan(600);
    expect(estimatePriorGames(samples, 1)).toBeLessThan(650);
    // All spread explained by noise: maximum shrinkage.
    expect(estimatePriorGames(samples.map(sample => ({ ...sample, noise: 0.001 })), 1)).toBe(20_000);
    expect(estimatePriorGames(samples.slice(0, 5), 777)).toBe(777);
  });

  it('shrinks each item\'s Enhanced uplift toward the mean uplift', () => {
    const only = Array.from({ length: 30 }, (_, index) => ({ item_id: index, wins: index === 0 ? 30 : 5_300, matches: index === 0 ? 40 : 10_000 }));
    const none = Array.from({ length: 30 }, (_, index) => ({ item_id: index, wins: 50_000, matches: 100_000 }));
    const result = enhancedStats(only, none, id => `item_${id}`)!;
    expect(result.meanUplift).toBeCloseTo(0.03, 2);
    // A 40-game item at +25 points is pulled most of the way back to the mean.
    expect(result.items.item_0!.uplift).toBeLessThan(0.1);
    expect(result.items.item_0!.uplift).toBeGreaterThan(result.meanUplift);
    expect(result.share).toBeCloseTo(290_040 / (290_040 + 3_000_000), 3);
  });
});
