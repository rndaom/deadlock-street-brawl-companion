import { describe, expect, it } from 'vitest';
import publicCatalog from '../data/public-catalog.json';
import { createRosterTracker, currentLocalHero, sameMatchNumber } from '../src/screen/draft-roster';
import type { DraftRoster } from '../src/screen/draft-roster';
import type { CaptureRegion, NativeScreenContext } from '../src/shared/screen-reading';
import type { Catalog } from '../src/shared/types';

const catalog = publicCatalog as unknown as Catalog;
const CENTERS = [550, 638, 726, 814, 1106, 1194, 1282, 1370];
type Block = { text: string; bounds: CaptureRegion };
type Panel = NativeScreenContext['panel'];
/** Top-bar portraits as the native reader reported them in a real Street Brawl match. */
function topBar(heroes: (string | null)[], local: string | null, panel: Panel = 'draft', viewMode?: NativeScreenContext['viewMode']): NativeScreenContext {
  return { panel, viewMode: viewMode ?? 'unknown', items: [], abilities: [], regions: [],
    heroes: [...heroes.map((heroId, seat) => ({ heroId, status: heroId ? 'recognized' as const : 'unknown' as const, confidence: heroId ? 0.96 : 0,
      role: 'roster' as const, seat, bounds: { x: (CENTERS[seat]! - 40) / 1920, y: 0, width: 80 / 1920, height: 100 / 1080 } })),
    ...(local ? [{ heroId: local, status: 'recognized' as const, confidence: 0.97, role: 'local' as const, bounds: { x: 0.4, y: 0.85, width: 0.2, height: 0.1 } }] : [])] };
}
/** A read with no top bar: only the bottom HUD (ability icons) or nothing recognized. */
const bottom = (local: string | null, panel: Panel = 'hud', viewMode?: NativeScreenContext['viewMode']) => topBar(Array(8).fill(null), local, panel, viewMode);
const none = (panel: Panel = 'unknown') => bottom(null, panel);
/** Hero-name text under the player names, as OCR read it (including its misreads). */
function names(entries: [string, number][], match = 'MATCH: 111221552') {
  return [...entries.map(([text, seat]) => ({ text, bounds: { x: (CENTERS[seat]! - 25) / 1920, y: 0.135, width: 50 / 1920, height: 0.007 } })),
    { text: match, bounds: { x: 0.94, y: 0.97, width: 0.05, height: 0.01 } }];
}
/** Player names above the top bar (scoreboard / draft drop-down). */
const players = (entries: [string, number][]): Block[] => entries.map(([text, seat]) => ({ text, bounds: { x: (CENTERS[seat]! - 25) / 1920, y: 0.118, width: 50 / 1920, height: 0.01 } }));
const heroNames = (entries: [string, number][]): Block[] => names(entries, '').slice(0, -1);
/** Text somewhere on screen that is neither the top bar nor the footer. */
const text = (...lines: string[]): Block[] => lines.map((line, index) => ({ text: line, bounds: { x: 0.02, y: 0.3 + index * 0.03, width: 0.2, height: 0.02 } }));
const footer = (number: string): Block[] => [{ text: `MATCH: ${number}`, bounds: { x: 0.86, y: 0.975, width: 0.08, height: 0.01 } }];
const round = (value: number): Block[] => [{ text: `ROUND ${value}`, bounds: { x: 0.47, y: 0.035, width: 0.06, height: 0.02 } }];
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

  it('starts over when a clearly different match number is read twice', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), names([], 'MATCH: 111221552'), read);
    roster.observe(topBar(Array(8).fill(null), null), names([], 'MATCH: 222334001'), 10);
    expect(roster.snapshot().localHeroId).toBe('hero_necro');
    roster.observe(topBar(Array(8).fill(null), null), names([], 'MATCH: 222334001'), 11);
    expect(roster.snapshot()).toMatchObject({ localHeroId: null, enemies: [], allies: [], matchId: '222334001' });
  });

  it('does not trust a single stray top-bar portrait', () => {
    const roster = createRosterTracker(catalog);
    roster.observe(topBar(lineUp, null), names([]), 1);
    expect(roster.snapshot().seats.every(seat => seat === null)).toBe(true);
  });

  it('places you by your Steam name above the top bar when your own portrait is unread', () => {
    const roster = createRosterTracker(catalog, { localPlayerNames: ['rndaom'] });
    const unreadOwn = ['hero_viscous', null, 'hero_vampirebat', 'hero_dynamo', 'hero_forge', 'hero_priest', 'hero_bebop', 'hero_lash'];
    for (let read = 0; read < 3; read++) roster.observe(topBar(unreadOwn, 'hero_ratking'), [...players([['Rollo', 0], ['rndaom', 1]]), ...names([])], read);
    const known = roster.snapshot();
    expect(known).toMatchObject({ localSeat: 1, localSide: 0, localHeroId: 'hero_ratking' });
    expect(known.seats[1]).toBe('hero_ratking');
    expect(known.enemies).toEqual(['hero_forge', 'hero_priest', 'hero_bebop', 'hero_lash']);
  });

  it('places you by a Steam name that contains spaces', () => {
    const roster = createRosterTracker(catalog, { localPlayerNames: ['Big Bad Wolf'] });
    const unreadOwn = ['hero_viscous', null, 'hero_vampirebat', 'hero_dynamo', 'hero_forge', 'hero_priest', 'hero_bebop', 'hero_lash'];
    for (let read = 0; read < 3; read++) roster.observe(topBar(unreadOwn, 'hero_ratking'), [...players([['Rollo', 0], ['Big Bad Wolf', 1]]), ...names([])], read);
    expect(roster.snapshot()).toMatchObject({ localSeat: 1, localSide: 0, localHeroId: 'hero_ratking' });
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

  it('reads the bare footer match number; a long gap keeps the match unless your hero changed', () => {
    const roster = createRosterTracker(catalog);
    const bare = (value: string) => [{ text: value, bounds: { x: 0.94, y: 0.97, width: 0.05, height: 0.01 } }];
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), bare('111230189'), read);
    expect(roster.snapshot().matchId).toBe('111230189');
    const epoch = roster.snapshot().epoch;
    roster.observe(topBar(lineUp.map(() => null), null), bare('111236976'), 10);
    roster.observe(topBar(lineUp.map(() => null), null), bare('111236976'), 11);
    expect(roster.snapshot().epoch).toBe(epoch + 1);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), [], 20 + read);
    // Alt-tabbed for four minutes in the same match: nothing is lost.
    roster.observe(topBar(lineUp, 'hero_necro'), [], 20 + 4 * 60_000);
    expect(roster.snapshot()).toMatchObject({ epoch: epoch + 1, localHeroId: 'hero_necro' });
    // Back after another long gap on a different hero: a new match at once.
    roster.observe(topBar(Array(8).fill(null), 'hero_haze'), [], 20 + 9 * 60_000);
    expect(roster.snapshot()).toMatchObject({ epoch: epoch + 2, localHeroId: 'hero_haze' });
  });

  it('places top-bar seats on an ultrawide 2560x1080 screen, where the bar stays centred', () => {
    const roster = createRosterTracker(catalog);
    const wide = topBar(lineUp, 'hero_necro');
    wide.heroes = wide.heroes.map(hero => hero.role !== 'roster' ? hero
      : { ...hero, bounds: { ...hero.bounds, x: (CENTERS[hero.seat!]! - 960 + 1280 - 40) / 2560, width: 80 / 2560 } });
    for (let read = 0; read < 3; read++) roster.observe(wide, [], read, 2560 / 1080);
    expect(roster.snapshot()).toMatchObject({ localSide: 0, allies: ['hero_bookworm', 'hero_ratking'], enemies: ['hero_magician', 'hero_krill', 'hero_gigawatt', 'hero_frank'] });
  });

  it('treats the post-match summary as outside the match, even though it shows the match number (real 2026-10-13 23:48)', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), [...round(3), ...footer('116318980')], read);
    expect(roster.snapshot().phase).toBe('match');
    roster.observe(none(), [...text('Defeated', 'Key Player', 'PLAY AGAIN', 'REPLAY NOT YET READY'), ...footer('116318980')], 100);
    expect(roster.snapshot()).toMatchObject({ phase: 'outside', localHeroId: 'hero_necro' });
    // The main menu with only a match number does not start a loading phase.
    roster.observe(none(), [...text('PRESS TO SELECT A GAME MODE'), ...footer('116318980')], 200);
    expect(roster.snapshot().phase).toBe('outside');
  });

  it('treats the awards and vote screens before the summary as outside the match (real 2026-10-18)', () => {
    for (const screen of [['THE VOTES ARE IN...'], ["WINNER'S BONUS"], ['SECOND MOST', 'DAMAGE'], ['THIRD MOST', 'HEALING'], ['3 players commended'], ['1 player commended']]) {
      const roster = createRosterTracker(catalog);
      for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), [...round(5), ...footer('116318980')], read);
      roster.observe(bottom('hero_necro'), text(...screen), 100);
      expect(roster.snapshot()).toMatchObject({ phase: 'outside', localHeroId: 'hero_necro' });
    }
    // "RECOMMENDED" (in-match build text) does not end a match.
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), [...round(2), ...footer('116318980')], read);
    roster.observe(bottom('hero_necro'), text('RECOMMENDED'), 100);
    expect(roster.snapshot().phase).toBe('match');
  });
});

describe('roster tracker: hideout to match (2026-10-11 diagnostics)', () => {
  // Real line-up of match 114924390: rndaom (Rat King) in seat 1.
  const match = [null, 'hero_ratking', 'hero_bookworm', 'hero_necro', 'hero_magician', 'hero_drifter', 'hero_punkgoat', 'hero_haze'];
  // The hideout shows a top bar of party/bot heroes at the same positions, with "600" health.
  const hideoutBar = [null, null, null, 'hero_inferno', 'hero_haze', 'hero_inferno', 'hero_atlas', null];

  it('never shows the hideout hero and names the match hero from the draft name row (19:53-19:58)', () => {
    const roster = createRosterTracker(catalog, { localPlayerNames: ['rndaom'] });
    const shown: (string | null)[] = []; const seatsShown: (string | null)[] = [];
    const feed = (context: NativeScreenContext, blocks: Block[], at: number) => {
      roster.observe(context, blocks, at);
      const known = roster.snapshot(); shown.push(known.localHeroId); seatsShown.push(...known.seats);
      return known;
    };
    // 19:53:40 main menu, then the hideout with Infernus; some HUD strips carry no hideout text at all.
    expect(feed(none(), text('MENU BUILDS', 'CITY NEVER SLEEPS', 'READ ALL ABOUT IT'), 0).phase).toBe('outside');
    feed(topBar(hideoutBar, null, 'hud'), text('600', '600', '600'), 16_000);
    feed(bottom('hero_inferno'), text('830-'), 17_000);
    feed(bottom('hero_inferno'), text('830', '0 830-', 'AEDASH', 'SERVER cpu: 5% (peak:'), 21_000);
    feed(none(), text('Vote', 'PRESS TO SHOP', 'MENU BUILDS'), 22_000);
    feed(bottom('hero_inferno'), text('830', 'ITEM VALUE', 'MATCH: -'), 68_000);
    // 19:54:53 swapped to Solomon in the hideout, then queued (your own name shows above the party bar).
    for (let read = 0; read < 3; read++) feed(bottom('hero_chessmaster'), text('180', "'o", 'ITEM VALUE', '0090'), 73_000 + read * 2_000);
    feed(bottom('hero_chessmaster'), text('180', '780-', '$0', '0090', 'SERVER cpu: 5% (peak:'), 79_000);
    for (let read = 0; read < 20; read++) {
      feed(topBar([null, null, null, 'hero_chessmaster', 'hero_haze', 'hero_inferno', 'hero_atlas', null], null, 'hud'),
        [...text('600', 'FINDING STREET BRAWL', 'TO CANCEL SEARCH'), ...players([['RNDAOM', 3]])], 80_000 + read * 4_000);
      feed(bottom('hero_chessmaster'), text('180', '780-', '0090'), 81_000 + read * 4_000);
    }
    expect(roster.snapshot()).toMatchObject({ phase: 'outside', localHeroId: null, localSeat: null });
    // 19:56:55 the match is found: footer number, then the loading screen.
    expect(feed(none(), footer('114924390'), 195_000).phase).toBe('loading');
    feed(none(), text('PLAYERS CONNECTING', '1:57', 'JOINING THE FIGHT AS...'), 196_000);
    feed(none(), [...text('FINISHING LOADING', 'JOINING THE FIGHT AS...', '0000'), ...footer('114924390')], 203_000);
    feed(none(), footer('1149714390'), 209_000);
    const loaded = feed(topBar(match.map((hero, seat) => seat === 6 ? null : hero), null, 'hud'), [], 210_000);
    expect(loaded).toMatchObject({ localHeroId: null, matchId: '114924390' });
    feed(topBar(match, null, 'hud'), round(1), 212_000);
    // 19:57:17 round-1 draft: locked (dim) ability icons are never matched, the top bar is.
    for (let read = 0; read < 3; read++) feed(topBar(match, null, 'draft'), text('SELECT ITEMS', 'CHOICE 1 OF 3'), 217_000 + read * 1_000);
    expect(roster.snapshot().localHeroId).toBeNull();
    // 19:57:21 the drop-down shows the names: "upperdeki | rndaom | RAT KNG | ohstoasty | Artgail | GRAVES".
    const dropDown = [...players([['upperdeki', 0], ['rndaom', 1], ['ohstoasty', 2], ['Artgail', 3]]), ...heroNames([['RAT KNG', 1], ['GRAVES', 3]]), ...footer('114924390')];
    const named = feed(bottom(null, 'draft'), dropDown, 221_000);
    expect(named).toMatchObject({ phase: 'match', localHeroId: 'hero_ratking', localSide: 0 });
    feed(bottom(null, 'draft'), dropDown, 222_000);
    const known = roster.snapshot();
    expect(known).toMatchObject({ localHeroId: 'hero_ratking', localSeat: 1, localSide: 0, matchId: '114924390' });
    expect(known.seats).toEqual([null, 'hero_ratking', 'hero_bookworm', 'hero_necro', 'hero_magician', 'hero_drifter', 'hero_punkgoat', 'hero_haze']);
    expect(known.allies).toEqual(['hero_bookworm', 'hero_necro']);
    // The old tracker showed Infernus, then Solomon, until 19:58:13, and kept them in seats 1 and 3.
    expect(shown.filter(hero => hero !== null && hero !== 'hero_ratking')).toEqual([]);
    expect(seatsShown).not.toContain('hero_chessmaster');
    expect(seatsShown).not.toContain('hero_inferno');
    expect(seatsShown).not.toContain('hero_atlas');
  });

  it('names your hero within seconds after a mid-match restart, from the Tab scoreboard (17:24:41)', () => {
    const roster = createRosterTracker(catalog, { localPlayerNames: ['rndaom'] });
    const bar = ['hero_chessmaster', 'hero_necro', 'hero_priest', 'hero_inferno', 'hero_frank', 'hero_doorman', 'hero_ratking', 'hero_haze'];
    // Dead: the HUD shows the spectated player's (DrBomb, Solomon) abilities.
    roster.observe(topBar([bar[0]!, bar[1]!, null, null, null, null, bar[6]!, null], 'hero_chessmaster', 'hud'), text('Respawn in:', '19'), 0);
    expect(roster.snapshot()).toMatchObject({ phase: 'unknown', localHeroId: null });
    roster.observe(topBar([bar[0]!, bar[1]!, null, null, null, null, bar[6]!, null], null, 'hud'), [...text('PROTECTED'), ...round(2)], 3_000);
    expect(roster.snapshot().phase).toBe('match');
    // 17:24:47 Tab: "DrBomb | Maros Boons | rndaom | VENATOR | StaticJewel | ...", still spectating DrBomb.
    const tab = (hero: string) => [...players([['DrBomb', 0], ['Maros Boons', 1], ['rndaom', 2], ['StaticJewel', 3], ['steegs2', 4]]),
      ...heroNames([['SOLOMON', 0], ['GRAVES', 1], [hero, 2]]), ...text('SPECTATING', 'Next player', 'Previous Player'),
      // The kill feed repeats your name far left, under the top bar: no seat.
      { text: 'RNDAOM', bounds: { x: 0.1, y: 0.27, width: 0.05, height: 0.02 } }];
    roster.observe(bottom('hero_chessmaster', 'scoreboard', 'spectator'), tab('VENATOR'), 5_000);
    expect(roster.snapshot().localHeroId).toBe('hero_priest');
    roster.observe(bottom(null, 'scoreboard', 'spectator'), tab('WN.ATOR'), 10_000);
    expect(roster.snapshot()).toMatchObject({ localHeroId: 'hero_priest', localSeat: 2, localSide: 0 });
  });

  it('never takes the spectated hero as yours while dead, even when SPECTATING is outside the strip', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_ratking'), round(3), read);
    const epoch = roster.snapshot().epoch;
    // 20:18:19: a bottom strip with "Respawn in:" and the spectated Haze's abilities, view not flagged.
    for (let read = 0; read < 6; read++) roster.observe(bottom('hero_haze'), [...text('Respawn in:', '13'), ...footer('114937335')], 10 + read);
    roster.observe(bottom('hero_haze', 'hud', 'spectator'), text('SPECTATING', 'upperdeki'), 20);
    expect(roster.snapshot()).toMatchObject({ localHeroId: 'hero_ratking', epoch });
  });

  it('takes one confident read of your own ability icons', () => {
    const roster = createRosterTracker(catalog);
    roster.observe(topBar(Array(8).fill(null), null, 'hud'), round(2), 0);
    roster.observe(bottom('hero_priest'), footer('114818933'), 1_000);
    expect(roster.snapshot().localHeroId).toBe('hero_priest');
  });

  it('keeps sequential match numbers apart but tolerates footer misreads', () => {
    expect(sameMatchNumber('114833840', '114839384')).toBe(false);
    for (const misread of ['1149714390', '114931390', '115924390', '1149211390', '114924380']) expect(sameMatchNumber(misread, '114924390')).toBe(true);
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_viscous'), [...round(1), ...footer('114833840')], read);
    const epoch = roster.snapshot().epoch;
    // Real misreads, some twice in a row, plus truncated numbers ("MATCH 114839", "1148393").
    for (const [index, misread] of ['114833800', '114833800', '1148338401', '1148338401', '114971139', '114833', '1148338'].entries()) {
      roster.observe(bottom(null), footer(misread), 10 + index);
    }
    expect(roster.snapshot()).toMatchObject({ epoch, localHeroId: 'hero_viscous', matchId: '114833840' });
    // The next match, 114839384, is only two edits away from 114833840 (the old tracker missed it).
    roster.observe(bottom(null), footer('114839384'), 100);
    expect(roster.snapshot().epoch).toBe(epoch);
    roster.observe(bottom(null), footer('114839384'), 102);
    expect(roster.snapshot()).toMatchObject({ epoch: epoch + 1, localHeroId: null, matchId: '114839384' });
  });

  it('keeps the last match on show in the hideout and starts the next one at its loading screen (18:10-18:11)', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_ratking'), [...round(5), ...footer('114839384')], read);
    const epoch = roster.snapshot().epoch;
    // 18:10:33 post-match summary with the queue button, then the hideout with Infernus.
    roster.observe(none(), text('Round 2', 'Total Round Time 14:25', 'FINDING STREET BRAWL'), 100);
    roster.observe(bottom('hero_inferno'), text('830-'), 101);
    roster.observe(none(), text('STREET BRAWL', 'CREATE ROSTER'), 102);
    expect(roster.snapshot()).toMatchObject({ phase: 'outside', localHeroId: 'hero_ratking', epoch });
    roster.observe(none(), text('PLAYERS CONNECTING', 'JOINING THE FIGHT AS...'), 200);
    expect(roster.snapshot()).toMatchObject({ phase: 'loading', localHeroId: null, epoch: epoch + 1 });
    // 18:11:11 the loading screen names your hero.
    roster.observe(none(), [{ text: 'JOINING THE FIGHT AS...', bounds: { x: 0.4, y: 0.3, width: 0.2, height: 0.03 } },
      { text: 'INFERNUS', bounds: { x: 0.44, y: 0.34, width: 0.12, height: 0.05 } }, ...footer('')], 209);
    expect(roster.snapshot()).toMatchObject({ phase: 'loading', localHeroId: 'hero_inferno', epoch: epoch + 1 });
    roster.observe(topBar(Array(8).fill(null), 'hero_inferno', 'hud'), round(1), 230);
    expect(roster.snapshot()).toMatchObject({ phase: 'match', localHeroId: 'hero_inferno', epoch: epoch + 1 });
  });

  it('a new match with a different hero replaces the old one at once, even without the hideout being read', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_viscous'), [...round(4), ...footer('114833840')], read);
    roster.observe(none(), text('FINISHING LOADING', 'JOINING THE FIGHT AS...'), 60_000);
    expect(roster.snapshot().localHeroId).toBeNull();
    roster.observe(topBar(Array(8).fill(null), 'hero_ratking', 'hud'), round(1), 70_000);
    expect(roster.snapshot().localHeroId).toBe('hero_ratking');
  });

  it('an Esc menu over a running match does not end it', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), [...round(2), ...footer('114818933')], read);
    const before = roster.snapshot();
    roster.observe(bottom('hero_werewolf'), text('READ ALL ABOUT IT', 'MENU BUILDS'), 10);
    roster.observe(topBar(lineUp, null, 'hud'), round(2), 11);
    expect(roster.snapshot()).toMatchObject({ phase: 'match', epoch: before.epoch, localHeroId: 'hero_necro' });
  });

  it('a stray hideout cue mid-match resumes the same match when its number is read again', () => {
    const roster = createRosterTracker(catalog);
    for (let read = 0; read < 3; read++) roster.observe(topBar(lineUp, 'hero_necro'), [...round(2), ...footer('114818933')], read);
    const before = roster.snapshot();
    roster.observe(none(), text('ITEM VALUE'), 10);
    roster.observe(bottom(null), [...round(2), ...footer('114818933')], 11);
    expect(roster.snapshot()).toMatchObject({ phase: 'match', epoch: before.epoch, localHeroId: 'hero_necro' });
  });
});

describe('currentLocalHero', () => {
  const roster = (patch: Partial<DraftRoster>) => ({ localHeroId: null, phase: 'match' as const, since: 1_000, ...patch });
  it('trusts the roster, and the context hero only when it was seen during the current match', () => {
    expect(currentLocalHero(roster({ localHeroId: 'hero_ratking' }), 'hero_chessmaster', 2_000)).toBe('hero_ratking');
    expect(currentLocalHero(roster({}), 'hero_ratking', 2_000)).toBe('hero_ratking');
    expect(currentLocalHero(roster({}), 'hero_chessmaster', 500)).toBeNull();
    expect(currentLocalHero(roster({ phase: 'outside' }), 'hero_chessmaster', 2_000)).toBeNull();
    expect(currentLocalHero(roster({ phase: 'outside' }), 'hero_chessmaster', 2_000, 'hero_chessmaster')).toBeNull();
    // A hero label on the current draft screen fills in while nothing better is known.
    expect(currentLocalHero(roster({}), 'hero_chessmaster', 500, 'hero_ratking')).toBe('hero_ratking');
    expect(currentLocalHero(null, 'hero_haze', null, 'hero_atlas')).toBe('hero_haze');
  });
});
