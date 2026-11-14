import { describe, expect, it } from 'vitest';
import { coversCurrentWindow, isStreetBrawlData, streetBrawlData, type HeroData } from '../src/screen/street-brawl-data';
import { readStoredSettings } from '../src/shared/settings';

describe('daily Street Brawl data refresh guard', () => {
  it('accepts the bundled snapshot', () => {
    expect(isStreetBrawlData(streetBrawlData())).toBe(true);
  });
  it('rejects a damaged file whose Enhanced numbers or Good lists are missing', () => {
    const current = streetBrawlData();
    expect(isStreetBrawlData({ ...current, enhanced: { ...current.enhanced!, meanUplift: undefined } })).toBe(false);
    const [firstId, first] = Object.entries(current.heroes)[0]!;
    expect(isStreetBrawlData({ ...current, heroes: { ...current.heroes, [firstId]: { ...first, good: undefined } } })).toBe(false);
  });
  it('does not let a saved download from an older patch window replace the data in use', () => {
    const current = streetBrawlData();
    const window = current.window!;
    const older = { ...current, window: { ...window, since: new Date(Date.parse(window.since) - 20 * 86_400_000).toISOString() } };
    expect(coversCurrentWindow(older, current)).toBe(false);
    expect(coversCurrentWindow(current, current)).toBe(true);
  });
  it("keeps the valid saved settings when one entry is unknown or invalid", () => {
    expect(readStoredSettings({ overlay: false, textScale: 9, fromANewerVersion: true, alwaysOnTop: true })).toEqual({ overlay: false, alwaysOnTop: true });
    expect(readStoredSettings('nonsense')).toEqual({});
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
  it('loads a saved download from before item pairs were fetched, and rejects a damaged pair table', () => {
    const { itemPairs, ...withoutPairs } = streetBrawlData();
    expect(itemPairs).toBeDefined();
    expect(isStreetBrawlData(withoutPairs)).toBe(true);
    expect(coversCurrentWindow(withoutPairs as never)).toBe(true);
    expect(isStreetBrawlData({ ...withoutPairs, itemPairs: { ...itemPairs!, rows: itemPairs!.rows.slice(1) } })).toBe(false);
    expect(isStreetBrawlData({ ...withoutPairs, itemPairs: { ...itemPairs!, priorMatches: Number.NaN } })).toBe(false);
    expect(isStreetBrawlData({ ...withoutPairs, itemPairs: null as never })).toBe(false);
  });
  it('rejects a saved download in the old format, whose per-hero results were smoothed toward the hero average', () => {
    const { schemaVersion: _omitted, ...old } = streetBrawlData();
    expect(isStreetBrawlData(old)).toBe(false);
    expect(isStreetBrawlData({ ...old, schemaVersion: 1 })).toBe(false);
  });
});
