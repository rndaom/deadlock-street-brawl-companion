import { describe, expect, it } from 'vitest';
import catalogData from '../data/public-catalog.json';
import type { Catalog } from '../src/shared/types';
import {
  createInitialScreenMatchContext, SCREEN_CAPTURE_FRESHNESS_MS, type CaptureRegion, type NativeContextAbility,
  type NativeContextHero, type NativeContextItem, type NativeOcrBlock, type NativeReadResult,
  type NativeScreenContext, type ScreenMatchContext,
} from '../src/shared/screen-reading';
import { CONTEXT_CATALOG } from '../src/shared/context-catalog';
import { detectScoreboardHint, parseScreenMatchObservation } from '../src/screen/match-parser';
import { reduceScreenMatchContext } from '../src/screen/match-state';

const catalog = catalogData as Catalog;
const full: CaptureRegion = { x: 0, y: 0, width: 1, height: 1 };
const heroIds = catalog.heroes.slice(0, 8).map(hero => hero.id);
const ownHero = heroIds[2]!;
const itemId = catalog.items[0]!.id;
const secondItemId = catalog.items[1]!.id;
const centers = [0, 1, 2, 3].map(index => (550 + 88 * index) / 1920)
  .concat([0, 1, 2, 3].map(index => (1106 + 88 * index) / 1920));
// Synthetic labels and layout fixtures from the pinned topbar PlayerName,
// HeroName, K/D/A columns and lower HUD. No real player labels or game images.
function block(text: string, x: number, y: number, width = 0.06, height = 0.015): NativeOcrBlock {
  return { text, x, y, width, height, bounds: { x, y, width, height } };
}
function headers(split = false): NativeOcrBlock[] {
  return centers.flatMap(center => split
    ? ['K', 'D', 'A'].map((text, index) => block(text, center - 0.014 + index * 0.012, 0.145, 0.006, 0.009))
    : [block('K D A', center - 0.016, 0.145, 0.032, 0.009)]);
}
function mergedHeaders(headerCenters = centers, patterns = [['KDA'], ['KD', 'A'], ['K', 'DA'], ['K', 'D', 'A']]): NativeOcrBlock {
  const words = headerCenters.flatMap((center, seat) => {
    const chunks = patterns[seat % patterns.length]!; const width = 0.018 + (chunks.length - 1) * 0.002;
    let x = center - width / 2;
    return chunks.map(text => {
      const bounds = { x, y: 0.145, width: text.length * 0.006, height: 0.009 }; x += bounds.width + 0.002;
      return { text, bounds };
    });
  });
  const x = words[0]!.bounds.x; const right = words.at(-1)!.bounds.x + words.at(-1)!.bounds.width;
  return { ...block(words.map(word => word.text).join(' '), x, 0.145, right - x, 0.009), words };
}
function scoreboardLabels(aliasSeat = 2, alias = 'Local Test Alias'): NativeOcrBlock[] {
  return [...headers(), ...centers.flatMap((center, seat) => [
    block(seat === aliasSeat ? alias : `Fixture Player ${seat}`, center - 0.020, 0.089, 0.040, 0.015),
    block(catalog.heroes.find(hero => hero.id === heroIds[seat])!.name, center - 0.020, 0.121, 0.040, 0.010),
  ])];
}
function sourceKoaHeaders(headerCenters = centers): NativeOcrBlock {
  const merged = mergedHeaders(headerCenters, [['KOA']]);
  const y = 167 / 1080; const height = 14 / 1080;
  merged.y = y; merged.height = height; merged.bounds = { ...merged.bounds!, y, height };
  merged.words!.forEach(word => { word.bounds = { ...word.bounds, y, height }; });
  return merged;
}
function sourceKoaNames(): NativeOcrBlock[] {
  return scoreboardLabels().filter(value => value.text !== 'K D A').map(value => {
    const name = value.y === 0.089;
    const y = (name ? 128 : 150) / 1080; const height = (name ? 16 : 12) / 1080;
    return { ...value, y, height, bounds: { ...value.bounds!, y, height } };
  });
}
function mergedScoreboardNames(names = centers.map((_, seat) => seat === 2 ? 'Local Test Alias' : `Fixture Player ${seat}`)): NativeOcrBlock[] {
  const words = names.flatMap((name, seat) => {
    const tokens = name.split(' '); const letters = tokens.reduce((sum, token) => sum + token.length, 0);
    const available = 0.036 - (tokens.length - 1) * 0.001;
    let x = centers[seat]! - 0.018;
    return tokens.map(text => {
      const width = available * text.length / letters;
      const result = { text, bounds: { x, y: 0.089, width, height: 0.015 } }; x += width + 0.001;
      return result;
    });
  });
  const x = words[0]!.bounds.x; const right = words.at(-1)!.bounds.x + words.at(-1)!.bounds.width;
  const merged = { ...block(names.join(' '), x, 0.089, right - x, 0.015), words };
  return [...scoreboardLabels().filter(value => value.y !== 0.089), merged];
}
function unknownOwnContext(): NativeScreenContext {
  const value = ownContext({ viewMode: 'unknown' });
  value.heroes.forEach(hero => { delete hero.isLocal; hero.team = null; });
  return value;
}
function rosterHero(seat: number, overrides: Partial<NativeContextHero> = {}): NativeContextHero {
  return { heroId: heroIds[seat]!, status: 'recognized', confidence: 0.98, seat, team: seat < 4 ? 0 : 1,
    role: 'roster', bounds: { x: centers[seat]! - 0.020, y: 0.004, width: 0.040, height: 0.080 }, ...overrides };
}
function localHero(overrides: Partial<NativeContextHero> = {}): NativeContextHero {
  return { heroId: ownHero, status: 'recognized', confidence: 0.98, role: 'local',
    bounds: { x: 0.40, y: 0.845, width: 0.20, height: 0.09 }, ...overrides };
}
function context(overrides: Partial<NativeScreenContext> = {}): NativeScreenContext {
  return { sessionId: 'window-session-a', panel: 'hud', viewMode: 'unknown',
    heroes: Array.from({ length: 8 }, (_, seat) => rosterHero(seat)), items: [], abilities: [],
    regions: [{ kind: 'roster', bounds: { x: 0.26, y: 0, width: 0.48, height: 0.09 }, slotCount: 8, complete: true }], ...overrides };
}
function ownContext(overrides: Partial<NativeScreenContext> = {}): NativeScreenContext {
  const value = context();
  return { ...value, viewMode: 'participant', heroes: [...value.heroes.map(hero => ({ ...hero, isLocal: hero.seat === 2 })), localHero({ isLocal: true })],
    regions: [...value.regions, { kind: 'local-hero', bounds: { x: 0.36, y: 0.77, width: 0.28, height: 0.22 }, complete: true }], ...overrides };
}
function reply(ctx?: NativeScreenContext, overrides: Partial<NativeReadResult> = {}): NativeReadResult {
  return { protocol: 1, id: 'frame-1', status: 'ok', gamePresent: true, foreground: true,
    clientWidth: 1920, clientHeight: 1080, capturedAt: 10_000, elapsedMs: 12, hash: 'frame-hash', blocks: [], crop: full,
    ...(ctx ? { context: ctx } : {}), ...overrides };
}
function parse(frame: NativeReadResult, options: { localPlayerNames?: string[]; previousContext?: ScreenMatchContext; receivedAt?: number } = {}) {
  return parseScreenMatchObservation(frame, catalog, { sessionId: 'coordinator-a', receivedAt: frame.capturedAt! + 50, ...options });
}
function localItem(slot: number, overrides: Partial<NativeContextItem> = {}): NativeContextItem {
  return { role: 'local-inventory', slot, itemId, status: 'recognized', confidence: 0.98,
    bounds: { x: 0.015 + (slot % 8) * 0.031, y: 0.845 + Math.floor(slot / 8) * 0.063, width: 0.027, height: 0.052 }, ...overrides };
}
function withItems(items: NativeContextItem[], complete = false, slotCount = items.length): NativeScreenContext {
  const value = ownContext();
  return { ...value, items, regions: [...value.regions,
    { kind: 'inventory', bounds: { x: 0.009, y: 0.83, width: 0.28, height: 0.15 }, complete, slotCount }] };
}
function ability(slot: 0 | 1 | 2 | 3, overrides: Partial<NativeContextAbility> = {}): NativeContextAbility {
  return { slot, rank: 1, unlocked: true, confidence: 0.98,
    bounds: { x: 0.395 + slot * 0.055, y: 0.855, width: 0.045, height: 0.085 }, ...overrides };
}
function withAbilities(abilities: NativeContextAbility[], complete = true): NativeScreenContext {
  const value = ownContext();
  return { ...value, abilities, regions: [...value.regions,
    { kind: 'abilities', bounds: { x: 0.37, y: 0.77, width: 0.28, height: 0.23 }, slotCount: 4, complete }] };
}

describe('source scoreboard geometry', () => {
  it('detects repeated whole K/D/A headings and individually bounded letters', () => {
    expect(detectScoreboardHint(headers())).toBe(true);
    expect(detectScoreboardHint(headers(true))).toBe(true);
  });
  it('uses KDA, KD+A, K+DA and K+D+A word boxes from a merged eight-header row', () => {
    const merged = mergedHeaders(); expect(detectScoreboardHint([merged])).toBe(true);
    const blocks = [...scoreboardLabels().filter(value => value.text !== 'K D A'), merged];
    const result = parse(reply(unknownOwnContext(), { blocks }), { localPlayerNames: ['Local Test Alias'] })!;
    expect(result).toMatchObject({ viewMode: 'participant', localHeroId: ownHero, localSeat: 2 });
    expect(result.players?.map(player => player.team)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
  it('recognizes twelve actual merged header groups as an unsupported layout', () => {
    const merged = mergedHeaders(Array.from({ length: 12 }, (_, index) => 0.176 + index * 0.06));
    const result = parse(reply(ownContext(), { blocks: [merged] }))!;
    expect(result.resetReason).toBe('unsupported-layout'); expect(result.resetObservation?.bounds).toHaveLength(12);
    expect(result.players).toBeUndefined(); expect(result.localHeroId).toBeUndefined();
    expect(result.resetObservation?.bounds?.every(bounds => bounds.width <= 0.09)).toBe(true);
  });
  it('recovers eight source-position KOA words only with current eight-slot portrait evidence', () => {
    const merged = sourceKoaHeaders();
    const blocks = [...sourceKoaNames(), merged];
    const value = unknownOwnContext(); value.panel = 'unknown';
    value.items = [localItem(0, { role: 'player-inventory', seat: 2,
      bounds: { x: centers[2]! - 0.01, y: 0.20, width: 0.012, height: 0.02 } })];
    value.regions.push({ kind: 'inventory', seat: 2, complete: false, slotCount: 1,
      bounds: { x: centers[2]! - 0.02, y: 0.17, width: 0.04, height: 0.30 } });
    const result = parse(reply(value, { blocks }), { localPlayerNames: ['Local Test Alias'] })!;
    expect(result).toMatchObject({ phase: 'combat', viewMode: 'participant', localHeroId: ownHero, localSeat: 2, localTeam: 0 });
    expect(result.localInventory?.[0]?.itemId).toBe(itemId);
    expect(result.players?.map(player => player.team)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    // A textual KOA row by itself is not a generic scoreboard or reset cue.
    expect(detectScoreboardHint([merged])).toBe(false); expect(result.resetReason).toBeUndefined();
  });
  it('requires at least four distinct current portraits and supports normal display scaling for KOA', () => {
    const value = unknownOwnContext();
    value.heroes = value.heroes.map(hero => hero.role === 'roster' && hero.seat! >= 4
      ? { ...hero, heroId: null, status: 'unknown' as const, confidence: 0 } : hero);
    const blocks = [...sourceKoaNames(), sourceKoaHeaders()];
    const result = parse(reply(value, { blocks, clientWidth: 1280, clientHeight: 720 }), { localPlayerNames: ['Local Test Alias'] });
    expect(result).toMatchObject({ localHeroId: ownHero, localSeat: 2 });
  });
  it.each(['one', 'partial', 'twelve', 'name', 'out-of-band', 'old-header-field', 'item-row', 'mixed', 'punctuation', 'wrong-row', 'duplicate-column', 'insufficient-portraits', 'conflicting-portrait', 'wrong-portrait-position', 'cropped-field', 'predicted-twelve'] as const)(
    'withholds KOA source-column recovery for %s evidence', failure => {
      const value = unknownOwnContext(); let merged = sourceKoaHeaders();
      let crop = full;
      if (failure === 'one' || failure === 'partial') merged.words = merged.words!.slice(0, failure === 'one' ? 1 : 7);
      if (failure === 'twelve') merged = sourceKoaHeaders(Array.from({ length: 12 }, (_, index) => 0.176 + index * 0.06));
      if (failure === 'name' || failure === 'out-of-band' || failure === 'old-header-field' || failure === 'item-row') {
        const y = failure === 'name' ? 128 / 1080 : failure === 'old-header-field' ? 122 / 1080 : failure === 'item-row' ? 250 / 1080 : 0.40;
        merged.y = y; merged.bounds!.y = y; merged.words!.forEach(word => { word.bounds.y = y; });
      }
      if (failure === 'mixed') merged.words![0]!.text = 'KDA';
      if (failure === 'punctuation') merged.words![0]!.text = 'K-O-A';
      if (failure === 'wrong-row') merged.words![0]!.bounds.y += 0.008;
      if (failure === 'duplicate-column') merged.words![1]!.bounds = { ...merged.words![0]!.bounds };
      if (failure === 'insufficient-portraits' || failure === 'conflicting-portrait' || failure === 'wrong-portrait-position') {
        value.heroes = value.heroes.map(hero => hero.role === 'roster' && hero.seat! >= (failure === 'insufficient-portraits' ? 3 : 4)
          ? { ...hero, heroId: null, status: 'unknown' as const, confidence: 0 } : hero);
        if (failure === 'conflicting-portrait') value.heroes.push(rosterHero(0, { heroId: heroIds[1]! }));
        if (failure === 'wrong-portrait-position') value.heroes[0]!.bounds.x += 0.04;
      }
      if (failure === 'cropped-field') crop = { x: 0, y: 0, width: 0.73, height: 1 };
      if (failure === 'predicted-twelve') value.regions.find(region => region.kind === 'roster')!.slotCount = 12;
      const blocks = [...sourceKoaNames(), merged];
      const result = parse(reply(value, { blocks, crop }), { localPlayerNames: ['Local Test Alias'] })!;
      expect(result.localSeat ?? null).toBeNull(); expect(result.localHeroId ?? null).toBeNull(); expect(result.resetReason).toBeUndefined();
      if (failure === 'predicted-twelve') { expect(result.players).toBeUndefined(); expect(result.localInventory).toBeUndefined(); }
    });
  it.each(['ambiguous', 'wrong-row', 'duplicate-column', 'bottom-chat'] as const)('does not certify eight source columns from %s header fragments', failure => {
    const merged = mergedHeaders(centers, [['KD', 'A']]);
    if (failure === 'ambiguous') {
      const a = merged.words![5]!;
      merged.words!.splice(6, 0, { text: 'A', bounds: { ...a.bounds, x: a.bounds.x + 0.007 } });
    }
    if (failure === 'wrong-row') merged.words![5]!.bounds.y += 0.05;
    if (failure === 'duplicate-column') {
      merged.words![4]!.bounds = { ...merged.words![2]!.bounds }; merged.words![5]!.bounds = { ...merged.words![3]!.bounds };
    }
    if (failure === 'bottom-chat') {
      merged.y = 0.72; merged.bounds!.y = 0.72; merged.words!.forEach(word => { word.bounds.y = 0.72; });
      expect(detectScoreboardHint([merged])).toBe(false);
    }
    const blocks = [...scoreboardLabels().filter(value => value.text !== 'K D A'), merged];
    const result = parse(reply(unknownOwnContext(), { blocks }), { localPlayerNames: ['Local Test Alias'] })!;
    expect(result.localSeat).toBeNull(); expect(result.localHeroId).toBeNull(); expect(result.resetReason).toBeUndefined();
  });
  it('rejects menus, timer-only HUD and headings on only one side', () => {
    expect(detectScoreboardHint([block('SCOREBOARD', 0.4, 0.1), block('9:00', 0.48, 0.025)])).toBe(false);
    expect(detectScoreboardHint(catalog.heroes.slice(0, 8).map((hero, index) => block(hero.name, 0.1 + index * 0.09, 0.2)))).toBe(false);
    expect(detectScoreboardHint(headers().slice(0, 4))).toBe(false);
  });
  it('maps crop-relative OCR without changing the full-client geometry', () => {
    const crop = { x: 0.2, y: 0, width: 0.6, height: 0.3 };
    const relative = headers().map(({ bounds: _bounds, ...value }) => ({ ...value,
      x: (value.x - crop.x) / crop.width, y: value.y / crop.height,
      width: value.width / crop.width, height: value.height / crop.height }));
    expect(detectScoreboardHint(relative, crop)).toBe(true);
  });
  it('retains all eight observed heroes with separate roster completeness', () => {
    const result = parse(reply(context()))!;
    expect(result.players?.map(player => [player.seat, player.heroId, player.team])).toEqual(heroIds.map((id, seat) => [seat, id, seat < 4 ? 0 : 1]));
    expect(result.rosterCompleteness).toBe('complete');
    expect(result.players?.every(player => player.heroObservation?.capturedAt === 10_000)).toBe(true);
    expect(result.localHeroId).toBeUndefined();
  });
  it('does not certify a missing, unread or duplicated-position roster', () => {
    const missing = context(); missing.heroes.pop();
    expect(parse(reply(missing))?.rosterCompleteness).toBe('partial');
    const unread = context(); unread.heroes[3] = rosterHero(3, { heroId: null, status: 'unknown', confidence: 0 });
    expect(parse(reply(unread))?.players?.[3]?.heroId).toBeNull();
    expect(parse(reply(unread))?.rosterCompleteness).toBe('partial');
    const overlap = context(); overlap.heroes[1]!.bounds = { ...overlap.heroes[0]!.bounds };
    expect(parse(reply(overlap))?.rosterCompleteness).toBe('partial');
  });
  it('withholds conflicting portrait IDs even after a agreeing later portrait/name', () => {
    const value = context(); value.heroes.push(rosterHero(2, { heroId: heroIds[3]! }), rosterHero(2));
    const result = parse(reply(value, { blocks: scoreboardLabels() }))!;
    expect(result.players?.[2]?.heroId).toBeNull(); expect(result.rosterCompleteness).toBe('partial');
  });
  it('does not claim full roster coverage when the crop excludes its region', () => {
    expect(parse(reply(context(), { crop: { x: 0, y: 0.02, width: 1, height: 0.98 } }))?.rosterCompleteness).toBe('partial');
  });
  it('allows hero text only inside all eight source player columns', () => {
    const result = parse(reply(ownContext({ heroes: [localHero({ isLocal: true })] }), { blocks: scoreboardLabels() }))!;
    expect(result.players?.map(player => player.heroId)).toEqual(heroIds);
    expect(result.players?.map(player => player.team)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(result.rosterCompleteness).toBe('partial');
    expect(parse(reply(undefined, { blocks: scoreboardLabels().filter(line => line.text !== 'K D A') }))?.players).toBeUndefined();
  });
  it('withholds an entire twelve-seat native roster and own regular-mode build', () => {
    const value = withItems([localItem(0)]);
    value.heroes = [...Array.from({ length: 12 }, (_, seat) => rosterHero(seat % 8, { seat, team: seat < 6 ? 0 : 1 })), localHero({ isLocal: true })];
    value.regions.find(region => region.kind === 'roster')!.slotCount = 12;
    const result = parse(reply(value))!;
    expect(result.players).toBeUndefined(); expect(result.rosterCompleteness).toBeUndefined();
    expect(result.localHeroId).toBeUndefined(); expect(result.localInventory).toBeUndefined(); expect(result.viewMode).toBe('unknown');
    expect(result.resetReason).toBeUndefined(); // Predicted native capacity does not prove a mode change.
  });
  it('does not use malformed eight-seat metadata or a stale layout when twelve columns are visible', () => {
    const value = ownContext(); value.heroes.push(rosterHero(0, { seat: 9 }));
    expect(parse(reply(value))?.players).toBeUndefined(); expect(parse(reply(value))?.localHeroId).toBeUndefined();
    const twelve = Array.from({ length: 12 }, (_, index) => block('K D A', 0.16 + index * 0.06, 0.145, 0.032, 0.009));
    expect(parse(reply(ownContext(), { blocks: twelve }))?.players).toBeUndefined();
    expect(parse(reply(ownContext(), { blocks: twelve }))?.localHeroId).toBeUndefined();
    const barrier = parse(reply(ownContext(), { blocks: twelve }))!;
    expect(barrier.resetReason).toBe('unsupported-layout');
    expect(barrier.resetObservation).toMatchObject({ sessionId: 'coordinator-a', frameId: 'frame-1', capturedAt: 10_000, confidence: 1 });
    expect(barrier.resetObservation?.bounds).toHaveLength(12);
  });
  it('uses actual eight source name columns while ignoring a wrongly predicted twelve-seat native grid', () => {
    const value = ownContext({ viewMode: 'unknown' }); value.heroes.forEach(hero => { delete hero.isLocal; hero.team = null; });
    value.regions.find(region => region.kind === 'roster')!.slotCount = 12;
    value.items = [localItem(0, { role: 'player-inventory', seat: 2, bounds: { x: centers[2]! - 0.01, y: 0.35, width: 0.02, height: 0.03 } })];
    const result = parse(reply(value, { blocks: scoreboardLabels() }), { localPlayerNames: ['Local Test Alias'] })!;
    expect(result).toMatchObject({ localHeroId: ownHero, localSeat: 2, viewMode: 'participant' });
    expect(result.players?.map(player => player.heroId)).toEqual(heroIds); expect(result.localInventory).toBeUndefined();
    expect(result.players?.every(player => player.inventory === undefined)).toBe(true);
  });
  it('does not hydrate a native participant HUD without a proven Brawl surface', () => {
    const value = ownContext(); value.heroes = [localHero({ isLocal: true })];
    value.regions = value.regions.filter(region => region.kind !== 'roster');
    expect(parse(reply(value))?.localHeroId).toBeUndefined();
    expect(parse(reply(value))?.viewMode).toBe('unknown');
  });
});

describe('own-view association', () => {
  it('accepts native participant proof and an independently matched bottom HUD hero', () => {
    const result = parse(reply(ownContext()))!;
    expect(result).toMatchObject({ viewMode: 'participant', localHeroId: ownHero, localSeat: 2, localTeam: 0 });
    expect(result.fields?.viewMode?.method).toBe('layout-association');
  });
  it('never takes the hideout practice hero as yours (queue / hideout HUD text on screen)', () => {
    expect(parse(reply(ownContext(), { blocks: [block('830', 0.05, 0.03, 0.2, 0.03)] }))).toMatchObject({ viewMode: 'participant', localHeroId: ownHero });
    for (const cue of ['FINDING STREET BRAWL', 'ITEM VALUE']) {
      const result = parse(reply(ownContext(), { blocks: [block(cue, 0.05, 0.03, 0.2, 0.03)] }))!;
      expect(result.localHeroId ?? null).toBeNull();
      expect(result.viewMode).not.toBe('participant');
    }
  });
  it('never calls a roster name/hero uniqueness or an active-view candidate own', () => {
    const value = context(); value.heroes.push(localHero());
    value.regions.push({ kind: 'local-hero', bounds: { x: 0.36, y: 0.77, width: 0.28, height: 0.22 }, complete: true });
    expect(parse(reply(value, { blocks: scoreboardLabels() }))).toMatchObject({ viewMode: 'unknown', localHeroId: null, localSeat: null });
    expect(parse(reply(context(), { blocks: scoreboardLabels() }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeUndefined();
  });
  it('corroborates a unique whole alias row with its hero and the bottom signature set', () => {
    const value = ownContext({ viewMode: 'unknown' }); value.heroes.forEach(hero => { delete hero.isLocal; hero.team = null; });
    const result = parse(reply(value, { blocks: scoreboardLabels() }), { localPlayerNames: ['LOCAL TEST ALIAS'] })!;
    expect(result).toMatchObject({ viewMode: 'participant', localHeroId: ownHero, localSeat: 2, localTeam: 0 });
    expect(result.players?.map(player => player.team)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(result.players?.filter(player => player.isLocal === true).map(player => player.seat)).toEqual([2]);
  });
  it('vetoes duplicate aliases, differing HUD heroes and native/visible spectator views', () => {
    const value = ownContext({ viewMode: 'unknown' }); value.heroes.forEach(hero => delete hero.isLocal);
    const duplicate = [...scoreboardLabels(), block('Local Test Alias', centers[6]! - 0.020, 0.089, 0.040, 0.015)];
    expect(parse(reply(value, { blocks: duplicate }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
    value.heroes[value.heroes.length - 1] = localHero({ heroId: heroIds[1]! });
    expect(parse(reply(value, { blocks: scoreboardLabels() }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
    for (const label of ['Spectating Fixture', 'Death Cam', 'Replay Playback']) {
      expect(parse(reply(ownContext(), { blocks: [...scoreboardLabels(), block(label, 0.4, 0.6, 0.2, 0.02)] }))?.viewMode).toBe('spectator');
    }
    expect(parse(reply(ownContext({ viewMode: 'spectator' })))?.localHeroId).toBeNull();
  });
  it('never takes a word inside a longer alias or punctuation-stripped near match', () => {
    const value = ownContext({ viewMode: 'unknown' }); value.heroes.forEach(hero => delete hero.isLocal);
    const lines = scoreboardLabels(2, 'Local Test Alias Extra');
    lines.find(line => line.text === 'Local Test Alias Extra')!.words = [
      { text: 'Local Test Alias', bounds: { x: centers[2]! - 0.03, y: 0.089, width: 0.05, height: 0.015 } },
    ];
    expect(parse(reply(value, { blocks: lines }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
    expect(parse(reply(value, { blocks: scoreboardLabels(2, 'Test Alias') }), { localPlayerNames: ['Test-Alias'] })?.localHeroId).toBeNull();
  });
  it('does not treat a trusted alias printed as HeroName as the player-name row', () => {
    const value = ownContext({ viewMode: 'unknown' }); value.heroes.forEach(hero => delete hero.isLocal);
    const heroName = catalog.heroes.find(hero => hero.id === ownHero)!.name;
    expect(parse(reply(value, { blocks: scoreboardLabels(2, 'Other Fixture Name') }), { localPlayerNames: [heroName] })?.localHeroId).toBeNull();
  });
  it('reconstructs all eight complete player names from one merged Windows OCR row', () => {
    const value = unknownOwnContext(); const blocks = mergedScoreboardNames();
    const before = JSON.stringify(blocks);
    const result = parse(reply(value, { blocks }), { localPlayerNames: ['LOCAL TEST ALIAS'] })!;
    expect(result).toMatchObject({ viewMode: 'participant', localHeroId: ownHero, localSeat: 2, localTeam: 0 });
    expect(result.players?.map(player => player.team)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(result.fields?.viewMode?.bounds?.length).toBe(2);
    expect(JSON.stringify(result)).not.toContain('Local Test Alias');
    expect(JSON.stringify(blocks)).toBe(before);
  });
  it('requires an independent matching bottom hero for a reconstructed name', () => {
    const value = unknownOwnContext(); value.heroes = value.heroes.filter(hero => hero.role !== 'local');
    expect(parse(reply(value, { blocks: mergedScoreboardNames() }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeUndefined();
    value.heroes.push(localHero({ heroId: heroIds[1]! }));
    expect(parse(reply(value, { blocks: mergedScoreboardNames() }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
  });
  it.each(['suffix', 'prefix', 'duplicate', 'punctuation', 'accent'] as const)('rejects a reconstructed %s collision', failure => {
    const names = centers.map((_, seat) => seat === 2 ? 'Local Test Alias' : `Fixture Player ${seat}`);
    if (failure === 'suffix') names[2] = 'Local Test Alias Extra';
    if (failure === 'prefix') names[2] = 'Extra Local Test Alias';
    if (failure === 'duplicate') names[6] = names[2]!;
    if (failure === 'punctuation') names[2] = 'Local Test-Alias';
    if (failure === 'accent') names[2] = 'Local Test Álias';
    const result = parse(reply(unknownOwnContext(), { blocks: mergedScoreboardNames(names) }), { localPlayerNames: ['Local Test Alias'] });
    expect(result).toMatchObject({ viewMode: 'unknown', localHeroId: null, localSeat: null });
  });
  it('rejects conflicting whole/reconstructed names in the same source row', () => {
    const blocks = [...mergedScoreboardNames(), block('Other Fixture Name', centers[2]! - 0.018, 0.089, 0.036, 0.015)];
    expect(parse(reply(unknownOwnContext(), { blocks }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
  });
  it.each(['omitted-word', 'omitted-suffix', 'overlap', 'wrong-row', 'column-edge', 'crop-edge', 'word-cap'] as const)(
    'withholds reconstructed ownership with %s word coverage', failure => {
      const names = centers.map((_, seat) => seat === 2 ? failure === 'omitted-suffix' ? 'Local Test Alias Extra' : 'Local Test Alias' : `Fixture Player ${seat}`);
      const blocks = mergedScoreboardNames(names); const merged = blocks.at(-1)!;
      const words = merged.words!; const aliasStart = words.findIndex(word => word.text === 'Local');
      if (failure === 'omitted-word') words.splice(0, 1);
      if (failure === 'omitted-suffix') words.splice(aliasStart + 3, 1);
      if (failure === 'overlap') words[aliasStart + 1]!.bounds.x = words[aliasStart]!.bounds.x;
      if (failure === 'wrong-row') words[aliasStart + 1]!.bounds.y += 0.012;
      if (failure === 'column-edge') words[aliasStart]!.bounds.x = centers[2]! - (88 / 1920) * 0.475;
      if (failure === 'crop-edge') {
        const crop = { x: merged.bounds!.x, y: 0, width: 1 - merged.bounds!.x, height: 1 };
        expect(parse(reply(unknownOwnContext(), { blocks, crop }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
        return;
      }
      if (failure === 'word-cap') {
        const width = (merged.width - 63 * 0.0001) / 64;
        merged.words = Array.from({ length: 64 }, (_, index) => ({ text: 'Local', bounds: { x: merged.x + index * (width + 0.0001), y: merged.y, width, height: merged.height } }));
        merged.text = merged.words.map(word => word.text).join(' ');
      }
      expect(parse(reply(unknownOwnContext(), { blocks }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
    });
  it('rejects a whole alias whose text or source column is clipped at the capture edge', () => {
    const blocks = scoreboardLabels(); const name = blocks.find(value => value.text === 'Local Test Alias')!;
    name.words = [{ text: 'Local', bounds: { x: name.x, y: name.y, width: 0.01, height: name.height } }];
    expect(parse(reply(unknownOwnContext(), { blocks }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
    delete name.words;
    const crop = { x: 0, y: name.y, width: 1, height: 1 - name.y };
    expect(parse(reply(unknownOwnContext(), { blocks, crop }), { localPlayerNames: ['Local Test Alias'] })?.localHeroId).toBeNull();
  });
  it('continues own HUD association within the original same-window proof age', () => {
    const first = parse(reply(ownContext()))!;
    const previous = reduceScreenMatchContext(createInitialScreenMatchContext(), first, 10_050);
    const value = withItems([localItem(0)]); value.viewMode = 'unknown'; value.heroes = [localHero()];
    const result = parse(reply(value, { id: 'frame-2', capturedAt: 11_000 }), { previousContext: previous })!;
    expect(result.viewMode).toBeUndefined(); expect(result.fields?.viewMode).toBeUndefined();
    expect(result.localInventory?.[0]?.itemId).toBe(itemId);
    const state = reduceScreenMatchContext(previous, result, 11_050);
    expect(state.observations.viewMode?.capturedAt).toBe(10_000);
    expect(state.localInventory[0]?.observation.capturedAt).toBe(11_000);
  });
  it('uses fresh top-strip Brawl mode independently from first bottom-strip participant proof', () => {
    const top = parse(reply(context({ panel: 'unknown', heroes: [], regions: [] }),
      { blocks: [block('Round 3', 0.46, 0.07, 0.08, 0.02)] }))!;
    const previous = reduceScreenMatchContext(createInitialScreenMatchContext(), top, 10_050);
    expect(previous.viewMode).toBe('unknown'); expect(previous.localHeroId).toBeNull();
    const bottom = withItems([localItem(0)]); bottom.heroes = [localHero({ isLocal: true })];
    bottom.regions = bottom.regions.filter(region => region.kind !== 'roster');
    const result = parse(reply(bottom, { capturedAt: 11_000, crop: { x: 0, y: 0.6, width: 1, height: 0.4 } }), { previousContext: previous })!;
    expect(result).toMatchObject({ viewMode: 'participant', localHeroId: ownHero });
    expect(result.localInventory?.[0]?.itemId).toBe(itemId);
    bottom.viewMode = 'unknown'; delete bottom.heroes[0]!.isLocal;
    expect(parse(reply(bottom, { capturedAt: 11_000 }), { previousContext: previous })?.localHeroId).toBeNull();
    bottom.viewMode = 'participant'; bottom.heroes[0]!.isLocal = true;
    expect(parse(reply(bottom, { capturedAt: 40_001 }), { previousContext: previous })?.localHeroId).toBeUndefined();
  });
  it('cannot continue after ownership expires or source/hero/round changes', () => {
    const first = parse(reply(ownContext(), { blocks: [block('Round 3', 0.46, 0.07, 0.08, 0.02)] }))!;
    const previous = reduceScreenMatchContext(createInitialScreenMatchContext(), first, 10_050);
    const value = withItems([localItem(0)]); value.viewMode = 'unknown'; value.heroes = [localHero()];
    expect(parse(reply(value, { capturedAt: 40_001 }), { previousContext: previous })?.localInventory).toBeUndefined();
    expect(parse(reply({ ...value, sessionId: 'window-session-b' }, { capturedAt: 11_000 }), { previousContext: previous })?.localInventory).toBeUndefined();
    expect(parse(reply({ ...value, sessionId: undefined }, { capturedAt: 11_000 }), { previousContext: previous })?.localInventory).toBeUndefined();
    expect(parse(reply({ ...value, heroes: [localHero({ heroId: heroIds[1]! })] }, { capturedAt: 11_000 }), { previousContext: previous })?.localInventory).toBeUndefined();
    expect(parse(reply(value, { capturedAt: 11_000, blocks: [block('Round 1', 0.46, 0.07, 0.08, 0.02)] }), { previousContext: previous })?.localInventory).toBeUndefined();
  });
});

describe('visible inventory coverage', () => {
  it('distinguishes complete slot coverage from unknown modifiers, quantity and bonuses', () => {
    const result = parse(reply(withItems([localItem(0), localItem(1, { itemId: secondItemId })], true)))!;
    expect(result.localInventorySlotCompleteness).toBe('complete'); expect(result.localInventoryCompleteness).toBe('partial');
    expect(result.localInventory?.map(item => [item.slot, item.itemId, item.variant, item.quantity, item.bonusIds]))
      .toEqual([[0, itemId, 'unknown', null, null], [1, secondItemId, 'unknown', null, null]]);
  });
  it('does not infer empty from blank/dark, an unread icon, absence or an incomplete slot list', () => {
    const value = withItems([localItem(0), localItem(1, { itemId: null, status: 'unknown', confidence: 0 })], true);
    expect(parse(reply(value))?.localInventorySlotCompleteness).toBe('partial');
    expect(parse(reply(value))?.localInventory?.[1]).toMatchObject({ itemId: null, status: 'unknown', quantity: null });
    expect(parse(reply(withItems([localItem(0)], true, 2)))?.localInventorySlotCompleteness).toBe('partial');
    expect(parse(reply(withItems([], false, 2)))?.localInventorySlotCompleteness).toBe('partial');
  });
  it('preserves positive empty cells for removal even when the region is partial', () => {
    const result = parse(reply(withItems([localItem(0, { itemId: null, status: 'empty' })], false, 4)))!;
    expect(result.localInventory?.[0]).toMatchObject({ itemId: null, status: 'empty', bonusIds: [], observation: { confidence: 0.98 } });
    expect(result.localInventorySlotCompleteness).toBe('partial');
    const previous = reduceScreenMatchContext(createInitialScreenMatchContext(), parse(reply(withItems([localItem(0)])))!, 10_050);
    const next = parse(reply(withItems([localItem(0, { itemId: null, status: 'empty' })]), { id: 'frame-2', capturedAt: 10_100 }))!;
    expect(reduceScreenMatchContext(previous, next, 10_150).localInventory).toEqual([]);
  });
  it('can certify a source-proven zero-slot region but never a missing region', () => {
    expect(parse(reply(withItems([], true, 0)))).toMatchObject({ localInventory: [], localInventoryCompleteness: 'complete', localInventorySlotCompleteness: 'complete' });
    expect(parse(reply(ownContext()))?.localInventory).toBeUndefined();
  });
  it('keeps stack counts independent and does not cap Brawl inventory at twelve', () => {
    const items = Array.from({ length: 16 }, (_, slot) => localItem(slot, { quantity: slot === 0 ? 3 : null, variant: 'enhanced' }));
    const result = parse(reply(withItems(items, true)))!;
    expect(result.localInventory).toHaveLength(16); expect(result.localInventory?.[0]?.quantity).toBe(3);
    expect(result.localInventory?.[1]?.quantity).toBeNull(); expect(result.localInventorySlotCompleteness).toBe('complete');
    expect(result.localInventoryCompleteness).toBe('partial');
  });
  it('withholds cropped, unknown-ID, conflicting and overlapping slot completeness', () => {
    const crop = { x: 0.02, y: 0, width: 0.98, height: 1 };
    expect(parse(reply(withItems([localItem(0)], true), { crop }))?.localInventorySlotCompleteness).toBe('partial');
    expect(parse(reply(withItems([localItem(0, { itemId: 'not-in-catalog' })], true)))?.localInventory?.[0]?.itemId).toBeNull();
    expect(parse(reply(withItems([localItem(0), localItem(0, { itemId: secondItemId })], true, 1)))?.localInventorySlotCompleteness).toBe('partial');
    expect(parse(reply(withItems([localItem(0), localItem(1, { bounds: localItem(0).bounds })], true)))?.localInventorySlotCompleteness).toBe('partial');
  });
  it('mirrors the same-frame proven own scoreboard row when local HUD inventory is absent', () => {
    const value = ownContext();
    const bounds = { x: centers[2]! - 0.02, y: 0.35, width: 0.04, height: 0.05 };
    value.items = [localItem(0, { role: 'player-inventory', seat: 2, bounds })];
    value.regions.push({ kind: 'inventory', seat: 2, bounds, slotCount: 1, complete: true });
    const result = parse(reply(value))!;
    expect(result.localInventory?.[0]?.itemId).toBe(itemId); expect(result.localInventorySlotCompleteness).toBe('complete');
    expect(result.players?.[2]?.inventory?.[0]?.itemId).toBe(itemId);
    value.heroes = value.heroes.map(hero => ({ ...hero, isLocal: undefined })); value.viewMode = 'unknown';
    expect(parse(reply(value))?.localInventory).toBeUndefined();
  });
});

describe('own ability investment and budget', () => {
  it('preserves paid ranks, independent unlocks and explicitly observed prices', () => {
    const value = withAbilities([ability(0, { rank: 0, nextUpgradeCost: 7 }), ability(1, { rank: 2, nextUpgradeCost: null }),
      ability(2, { rank: null, unlocked: false }), ability(3, { rank: 3 })]);
    const result = parse(reply(value))!;
    expect(result.localAbilities?.map(entry => [entry.rank, entry.unlocked, entry.nextUpgradeCost]))
      .toEqual([[0, true, 7], [2, true, null], [null, false, null], [3, true, null]]);
    expect(result.localAbilities?.[0]?.abilityId).toBe(CONTEXT_CATALOG.abilities.find(entry => entry.heroId === ownHero && entry.slot === 0)?.id ?? null);
    expect(result.abilityCompleteness).toBe('partial');
  });
  it('certifies complete investment only from four distinct readable slots in a complete region', () => {
    expect(parse(reply(withAbilities([ability(0), ability(1), ability(2), ability(3)])))?.abilityCompleteness).toBe('complete');
    expect(parse(reply(withAbilities([ability(0), ability(1), ability(2)])))?.abilityCompleteness).toBe('partial');
    expect(parse(reply(withAbilities([ability(0), ability(1), ability(2), ability(3, { confidence: 0.8 })])))?.abilityCompleteness).toBe('partial');
    expect(parse(reply(withAbilities([ability(0), ability(1), ability(2), ability(3, { bounds: ability(0).bounds })])))?.abilityCompleteness).toBe('partial');
  });
  it('does not turn cost numbers, keybinds or absent dots into ability rank zero', () => {
    const result = parse(reply(withAbilities([ability(0, { rank: null, unlocked: null, nextUpgradeCost: 5 })]),
      { blocks: [block('1', 0.4, 0.83), block('2', 0.45, 0.84), block('5', 0.51, 0.83)] }))!;
    expect(result.localAbilities?.[0]).toMatchObject({ rank: null, unlocked: null, nextUpgradeCost: 5 });
    expect(result.abilityCompleteness).toBe('partial');
    expect(parse(reply(ownContext(), { blocks: [block('1 2 5', 0.4, 0.9)] }))?.localAbilities).toBeUndefined();
  });
  it('does not accept topbar pips or any ranks/AP for an unowned active view', () => {
    const value = withAbilities([ability(0, { bounds: { x: 0.3, y: 0.23, width: 0.03, height: 0.03 } })]);
    expect(parse(reply(value))?.localAbilities).toEqual([]);
    value.viewMode = 'unknown'; value.heroes.forEach(hero => delete hero.isLocal);
    expect(parse(reply(value))?.localAbilities).toBeUndefined();
  });
  it('reads zero/current AP only in the separately identified own AP region', () => {
    const value = ownContext(); const bounds = { x: 0.496, y: 0.965, width: 0.018, height: 0.026 };
    value.abilityPoints = { value: 0, confidence: 0.98, bounds };
    value.regions.push({ kind: 'ability-points', bounds: { x: 0.48, y: 0.955, width: 0.06, height: 0.045 }, complete: true });
    expect(parse(reply(value))?.localAbilityPoints).toBe(0);
    value.regions = value.regions.filter(region => region.kind !== 'ability-points');
    expect(parse(reply(value))?.localAbilityPoints).toBeUndefined();
    expect(parse(reply(ownContext(), { blocks: [block('TEAM AP 25', 0.4, 0.16), block('Ability Points 5', 0.05, 0.6)] }))?.localAbilityPoints).toBeUndefined();
  });
});

describe('explicit round/draft fields and capture provenance', () => {
  it('reads visible round, choice stage and reroll count without inventing button/deadline state', () => {
    const result = parse(reply(undefined, { blocks: [block('Round 4', 0.46, 0.055, 0.08, 0.025),
      block('SELECT ITEMS', 0.05, 0.19, 0.24, 0.055), block('Choice 2 of 3', 0.05, 0.27, 0.15, 0.025),
      block('0 Re-Rolls Remaining', 0.40, 0.74, 0.20, 0.02)] }))!;
    expect(result).toMatchObject({ phase: 'draft', round: 4, pickStage: 2, rerollsRemaining: 0, rerollAvailable: null });
    expect(result.deadlineAt).toBeUndefined(); expect(result.matchId).toBeUndefined();
    expect(result.fields?.round).toMatchObject({ capturedAt: 10_000, receivedAt: 10_050, round: 4 });
  });
  it('takes the native round-win pips as the score, with or without the OCR round title', () => {
    // The native reader sends pips only after proving the title from its lettering; OCR reads the title on few frames.
    const pips = (roundPips: [number, number]) => context({ brawl: { myItems: [], playerItems: [], abilityRanks: null, hiddenItems: 0, roundPips } });
    const scored = parse(reply(pips([2, 0]), { blocks: [block('ROUND 3', 0.46, 0.055, 0.08, 0.025)] }))!;
    expect(scored.scores).toEqual([2, 0]);
    expect(scored.fields?.scores).toMatchObject({ capturedAt: 10_000, confidence: 1 });
    const untitled = parse(reply(pips([1, 1]), { blocks: [] }))!;
    expect(untitled.scores).toEqual([1, 1]);
    expect(untitled.fields?.scores?.bounds.length).toBe(1);
    const impossible = parse(reply(pips([4, 0]), { blocks: [] }))!;
    expect(impossible.scores).toBeUndefined();
  });
  it('rejects a round beyond the last possible Street Brawl round (a "ROUND 13" misread, 2026-10-18 18:29)', () => {
    expect(parse(reply(context(), { blocks: [block('ROUND 13', 0.46, 0.055, 0.08, 0.025)] }))?.round).toBeUndefined();
    expect(parse(reply(context(), { blocks: [block('ROUND 6', 0.46, 0.055, 0.08, 0.025)] }))?.round).toBeUndefined();
    expect(parse(reply(context(), { blocks: [block('ROUND 5', 0.46, 0.055, 0.08, 0.025)] }))?.round).toBe(5);
  });
  it('ends the match on the awards, vote and summary screens (2026-10-18)', () => {
    for (const text of ['THE VOTES ARE IN...', "WINNER'S BONUS", '3 players commended', 'PLAY AGAIN']) {
      expect(parse(reply(context(), { blocks: [block(text, 0.4, 0.2, 0.2, 0.04)] }))?.phase).toBe('finished');
    }
    expect(parse(reply(context(), { blocks: [block('RECOMMENDED', 0.4, 0.2, 0.2, 0.04)] }))?.phase).not.toBe('finished');
    // A player named "KeyPlayer" on the scoreboard, and "play again" typed in the chat, are not the post-match screen.
    expect(parse(reply(context(), { blocks: [block('KeyPlayer', 0.3, 0.12, 0.05, 0.01)] }))?.phase).not.toBe('finished');
    expect(parse(reply(context(), { blocks: [block('[ALL] rndaom: play again?', 0.02, 0.7, 0.2, 0.02)] }))?.phase).not.toBe('finished');
  });
  it('does not infer round/AP/pick budget from the catalog schedule or arbitrary labels', () => {
    const result = parse(reply(context(), { blocks: [block('Round 5', 0.02, 0.6), block('Match ID: 314159', 0.03, 0.7),
      block('Select Items', 0.03, 0.74, 0.08, 0.014), block('Victory', 0.05, 0.09), block('Defeat', 0.1, 0.7)] }))!;
    expect(result.round).toBeUndefined(); expect(result.matchId).toBeUndefined(); expect(result.localAbilityPoints).toBeUndefined();
    expect(result.phase).toBe('combat'); expect(result.pickStage).toBeUndefined();
  });
  it('withholds contradictory counters and spectator draft decisions', () => {
    const blocks = [block('SELECT ITEMS', 0.05, 0.19, 0.24, 0.055), block('Choice 1 of 3', 0.05, 0.27, 0.15),
      block('Choice 2 of 3', 0.05, 0.3, 0.15), block('1 Re-Roll Remaining', 0.4, 0.7, 0.2), block('2 Re-Rolls Remaining', 0.4, 0.74, 0.2)];
    expect(parse(reply(undefined, { blocks }))?.pickStage).toBeUndefined();
    expect(parse(reply(undefined, { blocks }))?.rerollsRemaining).toBeUndefined();
    expect(parse(reply(context({ panel: 'draft', viewMode: 'spectator' }), { blocks }))?.pickStage).toBeUndefined();
  });
  it('rejects absent game, background, failed, stale, future and synthetic frames', () => {
    for (const change of [{ gamePresent: false }, { foreground: false, status: 'not_foreground' }, { status: 'timeout' }, { hash: null },
      { capturedAt: null }, { clientWidth: Number.NaN }]) expect(parse(reply(context(), change))).toBeNull();
    // A reply that arrives a full freshness window after its capture no longer describes the game; one just inside still does.
    expect(parse(reply(context()), { receivedAt: 10_000 + SCREEN_CAPTURE_FRESHNESS_MS })).toBeNull();
    expect(parse(reply(context()), { receivedAt: 10_000 + SCREEN_CAPTURE_FRESHNESS_MS - 1 })).not.toBeNull();
    expect(parse(reply(context()), { receivedAt: 9_999 })).toBeNull();
    expect(parse({ ...reply(context()), synthetic: true } as NativeReadResult)).toBeNull();
    expect(parse(reply(context(), { status: 'unchanged' }))).not.toBeNull();
    // A helper that captured the game behind other windows (nothing covering it) answers ok without focus.
    expect(parse(reply(context(), { foreground: false }))).not.toBeNull();
  });
  it('uses source capture time, leaves change-time derivation to the reducer and never mutates input', () => {
    const input = reply(withItems([localItem(0)])); const before = structuredClone(input);
    const first = parse(input)!;
    expect(input).toEqual(before); expect(first.localInventory?.[0]?.observation.changedAt).toBeUndefined();
    const previous = reduceScreenMatchContext(createInitialScreenMatchContext(), first, 10_050);
    const next = parse(reply(withItems([localItem(0)]), { id: 'frame-2', capturedAt: 10_200 }))!;
    const result = reduceScreenMatchContext(previous, next, 10_250);
    expect(result.localInventory[0]?.observation.changedAt).toBe(10_000);
    expect(result.localInventory[0]?.observation.confirmedAt).toBe(10_200);
    expect(result.localInventoryRevision).toBe(previous.localInventoryRevision);
  });
  it('keeps normalized native positions independent of the capture pixel resolution', () => {
    const one = parse(reply(ownContext()))!;
    const two = parse(reply(ownContext(), { clientWidth: 2560, clientHeight: 1440 }))!;
    expect(two).toEqual(one);
  });
});
