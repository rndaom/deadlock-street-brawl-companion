import { describe, expect, it } from 'vitest';
import publicCatalog from '../data/public-catalog.json';
import { createRosterTracker } from '../src/screen/draft-roster';
import type { NativeScreenContext } from '../src/shared/screen-reading';
import type { Catalog } from '../src/shared/types';

const catalog = publicCatalog as unknown as Catalog;
const CENTERS = [550, 638, 726, 814, 1106, 1194, 1282, 1370];
/** Top-bar portraits as the native reader reported them in a real Street Brawl match. */
function topBar(heroes: (string | null)[], local: string | null): NativeScreenContext {
  return { panel: 'draft', viewMode: 'unknown', items: [], abilities: [], regions: [],
    heroes: [...heroes.map((heroId, seat) => ({ heroId, status: heroId ? 'recognized' as const : 'unknown' as const, confidence: heroId ? 0.96 : 0,
      role: 'roster' as const, seat, bounds: { x: (CENTERS[seat]! - 40) / 1920, y: 0, width: 80 / 1920, height: 100 / 1080 } })),
    ...(local ? [{ heroId: local, status: 'recognized' as const, confidence: 0.97, role: 'local' as const, bounds: { x: 0.4, y: 0.85, width: 0.2, height: 0.1 } }] : [])] };
}
/** Hero-name text under the player names, as OCR read it (including its misreads). */
function names(entries: [string, number][], match = 'MATCH: 111221552') {
  return [...entries.map(([text, seat]) => ({ text, bounds: { x: (CENTERS[seat]! - 25) / 1920, y: 0.135, width: 50 / 1920, height: 0.007 } })),
    { text: match, bounds: { x: 0.94, y: 0.97, width: 0.05, height: 0.01 } }];
}
const lineUp = ['hero_necro', 'hero_bookworm', null, 'hero_ratking', 'hero_magician', 'hero_krill', 'hero_gigawatt', 'hero_frank'];

describe('Street Brawl roster tracker', () => {
  it('places your hero, allies and enemies from repeated top-bar reads', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), names([]), 1_000 + read);
    const known = roster.snapshot();
    expect(known.localHeroId).toBe('hero_necro');
    expect(known.localSide).toBe(0);
    expect(known.allies).toEqual(['hero_bookworm', 'hero_ratking']);
    expect(known.enemies).toEqual(['hero_magician', 'hero_krill', 'hero_gigawatt', 'hero_frank']);
  });

  it('fills a missed portrait from OCR-damaged hero-name text and survives a misread match number', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), names([], 'MATCH: 111221552'), read);
    // Tab/draft scoreboard: "WA mEN" is Warden; "Site:LA IR" is Sinclair; footer digit misread.
    for (let read = 0; read < 2; read++) roster.observe(topBar(Array(8).fill(null), null), names([['WA mEN', 2], ['Site:LA IR', 4], ['MO & KRLL', 5]], 'MATCH: 111221352'), 10 + read);
    const known = roster.snapshot();
    expect(known.seats[2]).toBe('hero_warden');
    expect(known.localHeroId).toBe('hero_necro');
    expect(known.allies).toContain('hero_warden');
    expect(known.enemies).toHaveLength(4);
  });

  it('starts over when a clearly different match number appears', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), names([], 'MATCH: 111221552'), read);
    roster.observe(topBar(Array(8).fill(null), null), names([], 'MATCH: 222334001'), 10);
    expect(roster.snapshot()).toMatchObject({ localHeroId: null, enemies: [], allies: [] });
  });

  it('does not trust a single stray recognition', () => {
    const roster = createRosterTracker(catalog);
    roster.observe(topBar(lineUp, 'hero_necro'), names([]), 1);
    expect(roster.snapshot().localHeroId).toBeNull();
  });

  it('places you by your Steam name above the top bar when your own portrait is unread', () => {
    const roster = createRosterTracker(catalog, { localPlayerNames: ['rndaom'] });
    const unreadOwn = ['hero_viscous', null, 'hero_vampirebat', 'hero_dynamo', 'hero_forge', 'hero_priest', 'hero_bebop', 'hero_lash'];
    const nameRow = [{ text: 'Rollo', seat: 0 }, { text: 'rndaom', seat: 1 }].map(({ text, seat }) => ({ text, bounds: { x: (CENTERS[seat]! - 25) / 1920, y: 0.118, width: 50 / 1920, height: 0.01 } }));
    for (let read = 0; read < 3; read++) roster.observe(topBar(unreadOwn, 'hero_ratking'), [...nameRow, ...names([])], read);
    const known = roster.snapshot();
    expect(known).toMatchObject({ localSeat: 1, localSide: 0, localHeroId: 'hero_ratking' });
    expect(known.seats[1]).toBe('hero_ratking');
    expect(known.enemies).toEqual(['hero_forge', 'hero_priest', 'hero_bebop', 'hero_lash']);
  });

  it('infers your side by elimination when only your portrait is missing', () => {
    const roster = createRosterTracker(catalog);
    const unreadOwn = ['hero_viscous', null, 'hero_vampirebat', 'hero_dynamo', 'hero_forge', 'hero_priest', 'hero_bebop', 'hero_lash'];
    for (let read = 0; read < 3; read++) roster.observe(topBar(unreadOwn, 'hero_ratking'), names([]), read);
    expect(roster.snapshot()).toMatchObject({ localSide: 0, allies: ['hero_viscous', 'hero_vampirebat', 'hero_dynamo'] });
  });

  it('starts a new match when your own hero changes steadily, without a match number', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 5; read++) roster.observe(topBar(lineUp, 'hero_necro'), names([], ''), read);
    const before = roster.snapshot().epoch;
    roster.observe(topBar(Array(8).fill(null), 'hero_haze'), [], 10);
    expect(roster.snapshot().localHeroId).toBe('hero_necro');
    for (let read = 0; read < 4; read++) roster.observe(topBar(Array(8).fill(null), 'hero_haze'), [], 11 + read);
    const after = roster.snapshot();
    expect(after.epoch).toBeGreaterThan(before);
    expect(after).toMatchObject({ localHeroId: 'hero_haze', enemies: [], allies: [] });
    expect(after.seats.every(seat => seat === null)).toBe(true);
  });

  it('reads the bare footer match number and starts over after a long gap', () => {
    const roster = createRosterTracker(catalog);
    const footer = (text: string) => [{ text, bounds: { x: 0.94, y: 0.97, width: 0.05, height: 0.01 } }];
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), footer('111230189'), read);
    expect(roster.snapshot().matchId).toBe('111230189');
    const epoch = roster.snapshot().epoch;
    roster.observe(topBar(lineUp.map(() => null), null), footer('111236976'), 10);
    expect(roster.snapshot().epoch).toBe(epoch + 1);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), [], 20 + read);
    roster.observe(topBar(lineUp, 'hero_necro'), [], 20 + 4 * 60_000);
    expect(roster.snapshot().epoch).toBe(epoch + 2);
  });
});
