import { describe, expect, it } from 'vitest';
import { isStreetBrawlData, streetBrawlData, type HeroData } from '../src/screen/street-brawl-data';

describe('daily Street Brawl data refresh guard', () => {
  it('accepts the bundled snapshot', () => {
    expect(isStreetBrawlData(streetBrawlData())).toBe(true);
  });
  it('rejects a download whose per-hero answers came back empty, keeping the current data', () => {
    const current = streetBrawlData();
    const hollow = { ...current, heroes: Object.fromEntries(Object.entries(current.heroes)
      .map(([id, hero], index) => [id, index % 3 === 0 ? hero : { ...hero, abilityOrders: [], versusItemStats: {} }])) };
    expect(isStreetBrawlData(hollow)).toBe(false);
  });
  it("rejects a download missing most heroes' own item results, win rates or matchups", () => {
    const current = streetBrawlData();
    const strip = (patch: (hero: HeroData) => Partial<HeroData>) => ({ ...current, heroes: Object.fromEntries(Object.entries(current.heroes)
      .map(([id, hero], index) => [id, index % 3 === 0 ? hero : { ...hero, ...patch(hero) }])) });
    expect(isStreetBrawlData(strip(() => ({ itemStats: {} })))).toBe(false);
    expect(isStreetBrawlData(strip(() => ({ winRate: undefined, matches: undefined })))).toBe(false);
    expect(isStreetBrawlData(strip(() => ({ matchups: {} })))).toBe(false);
    // A counter request that failed outright leaves every hero without matchups: still usable.
    expect(isStreetBrawlData({ ...current, heroes: Object.fromEntries(Object.entries(current.heroes).map(([id, hero]) => [id, { ...hero, matchups: {} }])) })).toBe(true);
  });
  it('rejects a saved download in the old format, whose per-hero results were smoothed toward the hero average', () => {
    const { schemaVersion: _omitted, ...old } = streetBrawlData();
    expect(isStreetBrawlData(old)).toBe(false);
    expect(isStreetBrawlData({ ...old, schemaVersion: 1 })).toBe(false);
  });
});
