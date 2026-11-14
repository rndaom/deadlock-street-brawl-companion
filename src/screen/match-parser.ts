import type { Catalog } from '../shared/types';
import { CONTEXT_CATALOG, contextCatalogCompatible } from '../shared/context-catalog';
import {
  SCREEN_CAPTURE_FRESHNESS_MS, SCREEN_CONTEXT_MAX_AGE_MS,
  type CaptureRegion, type NativeContextHero, type NativeContextItem, type NativeContextRegion,
  type NativeOcrBlock, type NativeReadResult, type NativeScreenContext,
  type ScreenAbilityState, type ScreenCompleteness, type ScreenContextObservation,
  type ScreenInventoryItem, type ScreenMatchContext, type ScreenMatchObservation, type ScreenPlayerObservation,
} from '../shared/screen-reading';
import { detectDraftHint, normalizeOfferText, parseScreenOffers } from './offer-parser';
import { isOutsideMatchText, isPostMatchText } from './draft-roster';

export interface ScreenMatchParseOptions {
  sessionId: string;
  receivedAt: number;
  /** Automatically read local account aliases. They are supporting evidence, never account IDs. */
  localPlayerNames?: readonly string[];
  /** An aged ownership proof can associate the same current HUD within one window session. */
  previousContext?: Readonly<ScreenMatchContext>;
}

interface Line { text: string; key: string; bounds: CaptureRegion; whole: boolean }
interface Environment { sessionId: string; frameId: string; capturedAt: number; receivedAt: number; round: number | null }
const FULL_CLIENT: CaptureRegion = { x: 0, y: 0, width: 1, height: 1 };
// The five score pips under "ROUND N" (1920x1080 design px 898..1022, 78..90).
const ROUND_PIP_STRIP: CaptureRegion = { x: 0.468, y: 0.072, width: 0.064, height: 0.011 };
const QUALITY = 0.94;
const MAX_ITEMS = 256;
const MAX_TEXT = 512;
const SLOT_LIMIT = 256; // A parser resource bound, not the game's inventory capacity.
const SPECTATOR = /^(?:spectating(?:\s+.*)?|spectator(?:\s+.*)?|watching(?:\s+.*)?|death (?:cam|camera|replay)|replay playback)$/;

function boundsValid(bounds: CaptureRegion | undefined): bounds is CaptureRegion {
  return !!bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
    && bounds.x + bounds.width <= 1.00001 && bounds.y + bounds.height <= 1.00001;
}
function contains(outer: CaptureRegion, inner: CaptureRegion, tolerance = 0.001): boolean {
  return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}
function centerX(bounds: CaptureRegion): number { return bounds.x + bounds.width / 2; }
function centerY(bounds: CaptureRegion): number { return bounds.y + bounds.height / 2; }
function union(bounds: readonly CaptureRegion[]): CaptureRegion {
  const x = Math.min(...bounds.map(value => value.x)); const y = Math.min(...bounds.map(value => value.y));
  return { x, y, width: Math.max(...bounds.map(value => value.x + value.width)) - x,
    height: Math.max(...bounds.map(value => value.y + value.height)) - y };
}
function goodConfidence(value: number): boolean { return Number.isFinite(value) && value >= QUALITY && value <= 1; }
function seatValid(seat: unknown): seat is number { return Number.isInteger(seat) && Number(seat) >= 0 && Number(seat) < 8; }
function slotValid(slot: unknown): slot is number { return Number.isInteger(slot) && Number(slot) >= 0 && Number(slot) < SLOT_LIMIT; }
function evidence(env: Environment, method: ScreenContextObservation['method'], confidence: number, bounds: readonly CaptureRegion[]): ScreenContextObservation {
  // Change/confirmation time is derived by the reducer, which can compare earlier content.
  return { ...env, method, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    bounds: bounds.filter(boundsValid).slice(0, 64).map(value => ({ ...value })) };
}
function playerNameKey(text: string): string { return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); }
function separateBounds(bounds: readonly CaptureRegion[]): boolean {
  return bounds.every((a, index) => bounds.slice(index + 1).every(b => {
    const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return overlap < Math.min(a.width * a.height, b.width * b.height) * 0.5;
  }));
}
function textLines(blocks: readonly NativeOcrBlock[], crop: CaptureRegion): Line[] {
  const lines: Line[] = [];
  function add(text: string, bounds: CaptureRegion, whole: boolean) {
    if (typeof text !== 'string' || !boundsValid(bounds) || !contains(crop, bounds)) return;
    const trimmed = text.slice(0, 180).trim(); if (!trimmed) return;
    if (!lines.some(line => line.text === trimmed && Math.abs(centerX(line.bounds) - centerX(bounds)) < 0.001
      && Math.abs(centerY(line.bounds) - centerY(bounds)) < 0.001)) lines.push({ text: trimmed, key: normalizeOfferText(trimmed), bounds: { ...bounds }, whole });
  }
  for (const block of blocks.slice(0, MAX_TEXT)) {
    if (!block || typeof block.text !== 'string') continue;
    const bounds = boundsValid(block.bounds) ? block.bounds : {
      x: crop.x + block.x * crop.width, y: crop.y + block.y * crop.height,
      width: block.width * crop.width, height: block.height * crop.height,
    };
    add(block.text, bounds, true);
    for (const word of (Array.isArray(block.words) ? block.words : []).slice(0, 64)) {
      if (word) add(word.text, word.bounds, false);
    }
  }
  return lines.slice(0, MAX_TEXT);
}
function scoreboardHeaders(lines: readonly Line[]): CaptureRegion[] {
  const headers = lines.filter(line => /^k\s*d\s*a$/.test(line.key) && line.bounds.width <= 0.09
    && line.bounds.height <= 0.03 && centerY(line.bounds) < 0.35).map(line => line.bounds);
  // A merged OCR line can retain KDA, KD+A, or K+DA as its actual word boxes.
  // Concatenate only neighboring fragments; never divide a word into invented
  // per-letter rectangles or choose one of several competing completions.
  const fragments = lines.filter(line => /^(?:k|d|a|kd|da)$/.test(line.key.replace(/\s/g, ''))
    && line.bounds.width <= 0.035 && line.bounds.height <= 0.03 && centerY(line.bounds) < 0.35)
    .map(line => ({ ...line, key: line.key.replace(/\s/g, '') }));
  for (const start of fragments.filter(line => line.key === 'k' || line.key === 'kd')) {
    const paths: CaptureRegion[] = [];
    function complete(parts: Line[], key: string) {
      if (paths.length > 1) return;
      if (key === 'kda') {
        const bounds = union(parts.map(part => part.bounds)); if (bounds.width <= 0.09) paths.push(bounds);
        return;
      }
      const after = parts.at(-1)!;
      const next = fragments.filter(line => 'kda'.startsWith(key + line.key) && line.bounds.x >= after.bounds.x + after.bounds.width - 0.00001
        && line.bounds.x - (after.bounds.x + after.bounds.width) <= 0.017
        && Math.abs(centerY(line.bounds) - centerY(start.bounds)) <= Math.max(0.006, start.bounds.height * 0.6));
      if (next.length > 4) { paths.push(start.bounds, start.bounds); return; }
      for (const line of next) complete([...parts, line], key + line.key);
    }
    complete([start], start.key);
    if (paths.length === 1) headers.push(paths[0]!);
  }
  const distinct: CaptureRegion[] = [];
  for (const bounds of headers.sort((a, b) => centerX(a) - centerX(b))) {
    if (!distinct.some(prior => Math.abs(centerX(prior) - centerX(bounds)) < 0.017
      && Math.abs(centerY(prior) - centerY(bounds)) <= Math.max(0.006, Math.min(prior.height, bounds.height) * 0.6))) distinct.push(bounds);
  }
  return distinct;
}
function sameHeaderRow(headers: readonly CaptureRegion[]): boolean {
  return headers.length > 0 && Math.max(...headers.map(centerY)) - Math.min(...headers.map(centerY))
    <= Math.max(0.012, Math.max(...headers.map(bounds => bounds.height)) * 0.8);
}

/** Source scoreboard cue: repeated per-player K/D/A columns, not a generic menu title.
 * Bounds can be native full-client bounds or crop-relative flat OCR coordinates. */
export function detectScoreboardHint(blocks: readonly NativeOcrBlock[], crop: CaptureRegion = FULL_CLIENT): boolean {
  if (!Array.isArray(blocks) || !boundsValid(crop)) return false;
  const headers = scoreboardHeaders(textLines(blocks, crop));
  return headers.length >= 4 && headers.length <= 12 && sameHeaderRow(headers)
    && centerX(headers.at(-1)!) - centerX(headers[0]!) >= 0.25
    && headers.some(bounds => centerX(bounds) < 0.48) && headers.some(bounds => centerX(bounds) > 0.52);
}

function sourceColumns(lines: readonly Line[], count = 8): CaptureRegion[] {
  const headers = scoreboardHeaders(lines);
  if (headers.length !== count || !sameHeaderRow(headers) || headers.filter(bounds => centerX(bounds) < 0.48).length !== count / 2
    || headers.filter(bounds => centerX(bounds) > 0.52).length !== count / 2) return [];
  if (headers.some((bounds, index) => index > 0 && centerX(bounds) - centerX(headers[index - 1]!) < 0.025)) return [];
  return headers;
}
/** The installed Windows OCR can read the tiny source D as O. This recovery is
 * an eight-column panel observation with portrait corroboration, not a spelling
 * substitution for player names or arbitrary text. Native must already publish
 * the corrected eight-slot layout so twelve-slot inventories cannot be relabeled. */
function misreadEightColumns(reply: NativeReadResult, crop: CaptureRegion, knownHeroIds: ReadonlySet<string>, lines: readonly Line[]): CaptureRegion[] {
  const context = reply.context;
  if (!context || !Array.isArray(context.regions) || !Array.isArray(context.heroes)
    || scoreboardHeaders(lines).length > 0 || reply.blocks.length >= MAX_TEXT
    || !context.regions.some(region => region && region.kind === 'roster' && region.slotCount === 8)
    || context.regions.some(region => !region || region.kind === 'roster' && Number.isInteger(region.slotCount) && region.slotCount !== 8)
    || context.heroes.some(hero => !hero || hero.role === 'roster' && !seatValid(hero.seat))
    || reply.blocks.some(block => !block || typeof block.text !== 'string' || block.text.length >= 1024 || (block.words?.length ?? 0) >= 64)) return [];
  const words = reply.blocks.flatMap(block => Array.isArray(block.words) && block.words.length > 0 ? block.words : [{ text: block.text,
    bounds: boundsValid(block.bounds) ? block.bounds : { x: crop.x + block.x * crop.width, y: crop.y + block.y * crop.height,
      width: block.width * crop.width, height: block.height * crop.height } }]);
  const candidates = words.filter(word => word && typeof word.text === 'string' && word.text.trim().toLowerCase() === 'koa'
    && boundsValid(word.bounds) && contains(crop, word.bounds, 0) && word.bounds.y > 0.075 && word.bounds.y < 0.25
    && word.bounds.width > 0.009 && word.bounds.width < 0.035 && word.bounds.height > 0.004 && word.bounds.height < 0.03)
    .map(word => word.bounds).sort((a, b) => centerX(a) - centerX(b));
  if (candidates.length !== 8 || Math.max(...candidates.map(centerY)) - Math.min(...candidates.map(centerY)) > 0.006
    || candidates.filter(bounds => centerX(bounds) < 0.48).length !== 4 || candidates.filter(bounds => centerX(bounds) > 0.52).length !== 4) return [];
  const scale = reply.clientHeight / 1080;
  const design = (x: number, y: number, width: number, height: number): CaptureRegion => ({
    x: (reply.clientWidth / 2 + (x - 960) * scale) / reply.clientWidth, y: y / 1080,
    width: width * scale / reply.clientWidth, height: height / 1080,
  });
  let portraits = 0;
  for (let seat = 0; seat < 8; seat++) {
    const center = seat < 4 ? 550 + 88 * seat : 1106 + 88 * (seat - 4);
    // PlayerName and HeroName precede KDA in the source's downward flow. The
    // earlier 105..175 field overlapped names and clipped normal KDA ink.
    const header = design(center - 42, 155, 84, 70); const portrait = design(center - 40, 0, 80, 100);
    if (!boundsValid(header) || !contains(crop, header, 0) || !contains(header, candidates[seat]!, 0)) return [];
    const matches = context.heroes.filter(hero => hero.role === 'roster' && hero.seat === seat && hero.status === 'recognized'
      && typeof hero.heroId === 'string' && knownHeroIds.has(hero.heroId) && goodConfidence(hero.confidence)
      && boundsValid(hero.bounds) && contains(crop, portrait, 0) && contains(portrait, hero.bounds, 0));
    if (matches.length > 0 && new Set(matches.map(hero => hero.heroId)).size === 1) portraits++;
  }
  return portraits >= 4 ? candidates.map(bounds => ({ ...bounds })) : [];
}
interface PlayerNameRow { seat: number; text: string; bounds: CaptureRegion; complete: boolean }
/** Windows OCR can merge all eight PlayerName labels into one line. Use the
 * complete word list, never a matching word inside that line. The pinned source
 * centers PlayerNameNWContainer at 95% of each player column; the large gap
 * between teams is not part of either inner player's name field. */
function scoreboardPlayerNames(blocks: readonly NativeOcrBlock[], crop: CaptureRegion, columns: readonly CaptureRegion[],
  heroNames: ReadonlySet<string>): PlayerNameRow[] {
  if (columns.length !== 8 || blocks.length >= MAX_TEXT) return [];
  const regions = columns.map((column, seat) => {
    const sideStart = seat < 4 ? 0 : 4;
    const pitch = Math.min(...[0, 1, 2].map(index => centerX(columns[sideStart + index + 1]!) - centerX(columns[sideStart + index]!)));
    // Source PlayerName is a 22px field with 16px type, followed by HeroName
    // (at most 16px, 10px type, 5px bottom margin) and KDA. The previous fixed
    // .03 gap excluded real names ending 15–25 design pixels above KDA.
    // HUD source coordinates scale by client height from its 1080px design.
    return { x: centerX(column) - pitch * 0.475, y: column.y - 70 / 1080,
      width: pitch * 0.95, height: (70 - 13) / 1080 };
  });
  const rows: PlayerNameRow[] = []; const unsafe = new Set<number>();
  const inset = 0.0005; // A word touching a source/capture edge cannot prove its full name.
  const inside = (outer: CaptureRegion, inner: CaptureRegion) => contains({
    x: outer.x + inset, y: outer.y + inset, width: outer.width - inset * 2, height: outer.height - inset * 2,
  }, inner, 0);
  const touchedSeats = (bounds: CaptureRegion) => regions.flatMap((region, seat) => bounds.x < region.x + region.width
    && bounds.x + bounds.width > region.x && bounds.y < region.y + region.height && bounds.y + bounds.height > region.y ? [seat] : []);
  for (const block of blocks) {
    if (!block || typeof block.text !== 'string') continue;
    const bounds = boundsValid(block.bounds) ? block.bounds : {
      x: crop.x + block.x * crop.width, y: crop.y + block.y * crop.height,
      width: block.width * crop.width, height: block.height * crop.height,
    };
    if (!boundsValid(bounds)) continue;
    // A complete known HeroName label cannot establish player ownership. Do
    // not remove a hero-like word from a longer player name or merged name row.
    if (heroNames.has(normalizeOfferText(block.text))) continue;
    const touched = touchedSeats(bounds); if (!touched.length) continue;
    const reject = () => {
      for (const seat of touched) unsafe.add(seat);
      // A conflicting or clipped exact alias must still veto a unique match in
      // another column; dropping that uncertain candidate would hide collisions.
      if (playerNameKey(block.text).length <= 80 && bounds.width <= 0.10) {
        for (const seat of touched) rows.push({ seat, text: playerNameKey(block.text), bounds: { ...bounds }, complete: false });
      }
    };
    // These are source name rows only; hero labels and numbers below the band
    // do not become alternative player names or ownership evidence.
    if (!regions.some(region => centerY(bounds) > region.y && centerY(bounds) < region.y + region.height)) continue;
    if (!inside(crop, bounds) || block.text.length >= 1024 || !playerNameKey(block.text)
      || /[\u0000-\u001f\u007f]/u.test(block.text) || bounds.height > 0.025) { reject(); continue; }
    const words = block.words;
    if (words === undefined) {
      // An independently returned whole OCR line remains usable, provided its
      // entire text fits one fully captured source name field.
      const seats = regions.flatMap((region, seat) => boundsValid(region) && contains(crop, region, 0)
        && inside(region, bounds) ? [seat] : []);
      if (seats.length === 1) rows.push({ seat: seats[0]!, text: playerNameKey(block.text), bounds: { ...bounds }, complete: true });
      else reject();
      continue;
    }
    // The native protocol caps a line at 64 words and 1024 text characters.
    // Reaching either cap leaves completeness unknown even if a prefix agrees.
    if (!Array.isArray(words) || words.length === 0 || words.length >= 64
      || words.some(word => !word || typeof word.text !== 'string' || !playerNameKey(word.text)
        || /[\u0000-\u001f\u007f]/u.test(word.text) || !boundsValid(word.bounds)
        || !contains(bounds, word.bounds, 0.00001) || !inside(crop, word.bounds))
      || playerNameKey(words.map(word => word.text.trim()).join(' ')) !== playerNameKey(block.text)) { reject(); continue; }
    const baseline = words.map(word => centerY(word.bounds));
    const shortestHeight = Math.min(...words.map(word => word.bounds.height));
    if (Math.max(...baseline) - Math.min(...baseline) > Math.max(0.003, shortestHeight * 0.5)
      || words.some((word, index) => index > 0 && word.bounds.x < words[index - 1]!.bounds.x + words[index - 1]!.bounds.width - 0.00001)) {
      reject(); continue;
    }
    const grouped = new Map<number, typeof words>(); let complete = true;
    for (const word of words) {
      const seats = regions.flatMap((region, seat) => boundsValid(region) && contains(crop, region, 0)
        && inside(region, word.bounds) ? [seat] : []);
      if (seats.length !== 1) { complete = false; break; }
      const seat = seats[0]!; grouped.set(seat, [...(grouped.get(seat) ?? []), word]);
    }
    if (!complete) { reject(); continue; }
    for (const [seat, group] of grouped) {
      const name = group.map(word => word.text.trim()).join(' ');
      if (!heroNames.has(normalizeOfferText(name))) rows.push({ seat, text: playerNameKey(name),
        bounds: union(group.map(word => word.bounds)), complete: true });
    }
  }
  return rows.map(row => ({ ...row, complete: row.complete && !unsafe.has(row.seat) && rows.filter(other => other.seat === row.seat)
    .every(other => other.text === row.text && Math.abs(centerY(other.bounds) - centerY(row.bounds)) <= 0.003) }));
}
function uniqueNumber(lines: readonly Line[], pattern: RegExp, maximum: number, minimum = 0): { value: number; bounds: CaptureRegion[] } | null {
  const matches = lines.map(line => ({ line, match: line.key.match(pattern) })).filter(value => value.match);
  const values = new Set(matches.map(value => Number(value.match![1])));
  if (values.size !== 1) return null;
  const value = [...values][0]!;
  return Number.isInteger(value) && value >= minimum && value <= maximum ? { value, bounds: matches.map(value => value.line.bounds) } : null;
}

/** Extracts one fresh visible observation. This parser neither retains old captures
 * nor guesses a server match ID, absent inventory, unshown ranks, or a local player.
 * Source: SteamTracking4c6431cc panorama/{layout,styles}/citadel_hud_top_bar*,
 * hud.xml, hud_abilities*, and citadel_hud_ability_upgrade_pips*. */
export function parseScreenMatchObservation(reply: NativeReadResult, catalog: Catalog, options: ScreenMatchParseOptions): ScreenMatchObservation | null {
  // A capture of a game behind other windows (status ok without focus) is as good as a focused one: the helper
  // only returns ok after it has checked that nothing covers the game.
  if (!reply || reply.protocol !== 1 || !reply.gamePresent || !['ok', 'unchanged'].includes(reply.status)
    || (reply as NativeReadResult & { synthetic?: boolean }).synthetic === true
    || !Array.isArray(reply.blocks) || !catalog || !Array.isArray(catalog.heroes) || !Array.isArray(catalog.items)
    || typeof options?.sessionId !== 'string' || !options.sessionId || options.sessionId.length > 128
    || typeof reply.id !== 'string' || !reply.id || reply.id.length > 128 || !reply.hash
    || !Number.isFinite(reply.capturedAt) || reply.capturedAt === null || !Number.isFinite(options.receivedAt)
    || options.receivedAt < reply.capturedAt || options.receivedAt - reply.capturedAt >= SCREEN_CAPTURE_FRESHNESS_MS
    || !Number.isFinite(reply.clientWidth) || !Number.isFinite(reply.clientHeight) || reply.clientWidth <= 0 || reply.clientHeight <= 0) return null;
  const crop = reply.crop ?? FULL_CLIENT; if (!boundsValid(crop)) return null;
  const lines = textLines(reply.blocks, crop);
  const context = reply.context;
  const heroes = (Array.isArray(context?.heroes) ? context.heroes : []).slice(0, 16);
  const rawItems = (Array.isArray(context?.items) ? context.items : []).slice(0, MAX_ITEMS);
  const regions = (Array.isArray(context?.regions) ? context.regions : []).slice(0, 64)
    .filter(region => region && boundsValid(region.bounds));
  const heroIds = new Set(catalog.heroes.slice(0, 128).map(hero => hero.id));
  const itemIds = new Set(catalog.items.slice(0, 512).map(item => item.id));
  const heroNames = new Map<string, string[]>();
  for (const hero of catalog.heroes.slice(0, 128)) {
    const key = normalizeOfferText(hero.name); heroNames.set(key, [...(heroNames.get(key) ?? []), hero.id]);
  }
  const spectator = (context as NativeScreenContext & { viewMode?: string } | undefined)?.viewMode === 'spectator'
    || lines.some(line => SPECTATOR.test(line.key));
  // The source round title is centered between teams; per-player labels and chat are excluded.
  // Street Brawl has at most 2 * scoreToWin - 1 rounds: a "ROUND 13" misread (2026-10-18) is not a round.
  const round = uniqueNumber(lines.filter(line => line.whole && centerY(line.bounds) < 0.18
    && centerX(line.bounds) >= 0.45 && centerX(line.bounds) <= 0.55 && line.bounds.width <= 0.20
    && line.bounds.height >= 0.01), /^round\s+(\d{1,2})$/, Math.max(1, 2 * (CONTEXT_CATALOG.streetBrawl.scoreToWin || 3) - 1), 1);
  const env: Environment = { sessionId: options.sessionId, frameId: reply.id, capturedAt: reply.capturedAt,
    receivedAt: options.receivedAt, round: round?.value ?? null };
  const result: ScreenMatchObservation = { sessionId: env.sessionId, frameId: env.frameId, capturedAt: env.capturedAt,
    receivedAt: env.receivedAt, fields: {} };
  if (typeof context?.sessionId === 'string' && context.sessionId.length > 0 && context.sessionId.length <= 128) result.gameSessionId = context.sessionId;
  if (round) { result.round = round.value; result.fields!.round = evidence(env, 'visible-text', 1, round.bounds); }
  // Round wins are the filled pips under the round title. The native reader only sends them when it
  // has proven the title from its cream lettering on the same frame (OCR reads the title on few
  // frames), so a menu or replay screen cannot set a score.
  const pips = context?.brawl?.roundPips;
  if (Array.isArray(pips) && pips.length === 2 && pips.every(value => Number.isInteger(value) && value >= 0 && value <= 3)) {
    result.scores = [pips[0], pips[1]];
    result.fields!.scores = evidence(env, 'layout-association', 1, round?.bounds ?? [ROUND_PIP_STRIP]);
  }
  // Brawl can display victory/defeat for a round; those words alone do not end a match.
  const finishTitles = lines.filter(line => line.whole && /^(?:match complete|match finished)$/.test(line.key)
    && line.bounds.width >= 0.12 && line.bounds.height >= 0.03 && centerX(line.bounds) > 0.25
    && centerX(line.bounds) < 0.75 && centerY(line.bounds) > 0.12 && centerY(line.bounds) < 0.65);
  const draftTitles = lines.filter(line => line.whole && /^select\s*items\s*:?$/.test(line.key)
    && line.bounds.width >= 0.08 && line.bounds.height >= 0.026 && line.bounds.height < 0.15 && centerY(line.bounds) < 0.65);
  // The awards/vote/summary screens after the last round (2026-10-18) end the match as well.
  // Only screen text of their size and place: a player named "KeyPlayer" (small scoreboard text) or "play again"
  // in the chat (lower left) is not the end of the match.
  const postMatchText = lines.some(line => isPostMatchText(line.key) && line.bounds.height >= 0.015
    && centerX(line.bounds) > 0.15 && centerX(line.bounds) < 0.85 && !(centerX(line.bounds) < 0.35 && centerY(line.bounds) > 0.5));
  const finished = context?.panel === 'post-match' || finishTitles.length > 0 || postMatchText;
  // A portrait match only establishes a HUD surface, not that a draft has closed.
  // Use the same current source controls and three-card geometry as the offer
  // parser when the large title is unread. No retained hint establishes this phase.
  const offerBlocks: NativeOcrBlock[] = [];
  for (const block of reply.blocks.slice(0, MAX_TEXT)) {
    if (!block || typeof block.text !== 'string') continue;
    if (Array.isArray(block.words) && block.words.length) {
      for (const word of block.words.slice(0, 64)) if (word && typeof word.text === 'string'
        && boundsValid(word.bounds) && contains(crop, word.bounds)) offerBlocks.push({ text: word.text, ...word.bounds });
    } else {
      const bounds = boundsValid(block.bounds) ? block.bounds : {
      x: crop.x + block.x * crop.width, y: crop.y + block.y * crop.height,
      width: block.width * crop.width, height: block.height * crop.height,
      };
      if (boundsValid(bounds) && contains(crop, bounds)) offerBlocks.push({ text: block.text, ...bounds });
    }
  }
  const controlBlocks = offerBlocks.filter(block => block.width <= 0.35 && block.height >= 0.012 && block.height < 0.15
    && (block.x < 0.35 && block.y < 0.4 || centerX(block) > 0.35 && centerX(block) < 0.65 && centerY(block) > 0.45 && centerY(block) < 0.9));
  const currentDraftHint = !finished && detectDraftHint(controlBlocks);
  const currentCards = currentDraftHint ? parseScreenOffers(offerBlocks, catalog,
    { draftConfirmed: true, conservativeUnmarkedDetails: true,
      ...(reply.clientWidth > 0 && reply.clientHeight > 0 ? { aspect: reply.clientWidth / reply.clientHeight } : {}) }) : null;
  const cardDraft = currentCards?.isDraft === true && currentCards.offers.length === 3;
  const draft = context?.panel === 'draft' || draftTitles.length > 0 || cardDraft;
  const standardColumns = sourceColumns(lines);
  const recoveredColumns = !finished && !draft && !round && standardColumns.length === 0
    ? misreadEightColumns(reply, crop, heroIds, lines) : [];
  const columns = standardColumns.length === 8 ? standardColumns : recoveredColumns;
  const scoreboard = context?.panel === 'scoreboard' || recoveredColumns.length === 8 || detectScoreboardHint(reply.blocks, crop);
  if (finished || draft || context?.panel === 'hud' || scoreboard) {
    result.phase = finished ? 'finished' : draft ? 'draft' : 'combat';
    const cues = [...finishTitles, ...draftTitles].map(line => line.bounds);
    if (cardDraft) cues.push(...controlBlocks.map(block => ({ x: block.x, y: block.y, width: block.width, height: block.height })));
    result.fields!.phase = evidence(env, cues.length ? 'visible-text' : 'layout-association', 1,
      cues.length ? cues : regions.filter(region => contains(crop, region.bounds)).map(region => region.bounds));
  }
  // No participant HUD match-ID surface is verified. Arbitrary OCR labels cannot reset a session.
  if (draft && !spectator) {
    const choices = lines.filter(line => line.whole && centerY(line.bounds) < 0.6).map(line => ({ line, match: line.key.match(/^choice\s+(\d{1,2})\s+(?:of|\/)\s+(\d{1,2})$/) }))
      .filter(value => value.match && Number(value.match[1]) >= 1 && Number(value.match[1]) <= Number(value.match[2]) && Number(value.match[2]) <= 20);
    const stages = new Set(choices.map(value => Number(value.match![1])));
    if (stages.size === 1) { result.pickStage = [...stages][0]!; result.fields!.pickStage = evidence(env, 'visible-text', 1, choices.map(value => value.line.bounds)); }
    const rerolls = uniqueNumber(lines.filter(line => line.whole && centerY(line.bounds) > 0.45
      && centerX(line.bounds) > 0.35 && centerX(line.bounds) < 0.65), /^(\d{1,2})\s+re\s*rolls?\s+remaining$/, 20);
    if (rerolls) { result.rerollsRemaining = rerolls.value; result.fields!.rerollsRemaining = evidence(env, 'visible-text', 1, rerolls.bounds); }
    // The count does not prove whether a cooldown/disabled reroll button is usable.
    result.rerollAvailable = null;
  }
  const rosterCounts = regions.filter(region => region.kind === 'roster').map(region => region.slotCount);
  const nativeUnsupported = rosterCounts.some(count => Number.isInteger(count) && count !== 8)
    || heroes.some(hero => hero && hero.role === 'roster' && Number.isInteger(hero.seat) && hero.seat! >= 8);
  const twelveColumns = scoreboardHeaders(lines).length === 12;
  const confirmedTwelve = sourceColumns(lines, 12);
  if (confirmedTwelve.length === 12) {
    result.resetReason = 'unsupported-layout';
    result.resetObservation = evidence(env, 'layout-association', 1, confirmedTwelve);
  }
  const previous = options.previousContext; const priorProof = previous?.observations.viewMode;
  const samePriorWindow = !!previous && previous.sessionId === env.sessionId && previous.gameSessionId != null
    && previous.gameSessionId === result.gameSessionId;
  const priorOwnershipFresh = samePriorWindow && previous.viewMode === 'participant' && previous.phase !== 'finished'
    && !!priorProof && priorProof.sessionId === env.sessionId && priorProof.confidence >= 0.85
    && env.capturedAt >= priorProof.capturedAt && env.capturedAt - priorProof.capturedAt <= SCREEN_CONTEXT_MAX_AGE_MS
    && !(round && previous.round !== null && round.value < previous.round);
  const priorModeEvidence = (observation: ScreenContextObservation | null | undefined) => samePriorWindow && !!observation
    && observation.sessionId === env.sessionId && observation.confidence >= 0.85
    && env.capturedAt >= observation.capturedAt && env.capturedAt - observation.capturedAt <= SCREEN_CONTEXT_MAX_AGE_MS;
  // Mode and ownership are separate proofs. A top-strip round can establish Brawl
  // before a bottom-strip interactive UNLOCK first establishes the participant.
  const priorBrawlMode = !!previous && previous.phase !== 'finished'
    && (previous.round !== null && priorModeEvidence(previous.observations.round)
      || previous.phase === 'draft' && priorModeEvidence(previous.observations.phase));
  // The hideout shows a top bar, your practice hero's HUD and an 8-seat scoreboard: its queue and
  // HUD text ("FINDING STREET BRAWL", "ITEM VALUE") mean no match is running.
  const outsideMatch = reply.blocks.some(block => typeof block.text === 'string' && isOutsideMatchText(block.text));
  const brawl = !twelveColumns && !outsideMatch && (columns.length === 8 || !!round || draft
    || !nativeUnsupported && rosterCounts.includes(8)
    || !nativeUnsupported && priorBrawlMode
    || !nativeUnsupported && priorOwnershipFresh && (previous.players.length === 8 || previous.round !== null || previous.phase === 'draft'));
  if (!brawl) {
    // Normal-mode twelve-seat geometry cannot be truncated into a Brawl roster or own build.
    result.viewMode = spectator ? 'spectator' : 'unknown';
    result.fields!.viewMode = evidence(env, 'layout-association', spectator ? 1 : 0,
      lines.filter(line => SPECTATOR.test(line.key)).map(line => line.bounds));
    return result;
  }
  const nativeRosterAllowed = !nativeUnsupported;
  const regionFor = (kind: NativeContextRegion['kind'], seat?: number) => regions.filter(region => region.kind === kind && region.seat === seat);
  const validHero = (hero: NativeContextHero) => hero && boundsValid(hero.bounds) && contains(crop, hero.bounds)
    && hero.status === 'recognized' && goodConfidence(hero.confidence) && typeof hero.heroId === 'string' && heroIds.has(hero.heroId);
  const players = new Map<number, ScreenPlayerObservation>();
  const conflictingHeroes = new Set<number>(); const conflictingTeams = new Set<number>();
  for (const seat of Array.from({ length: 8 }, (_, index) => index)) {
    const values = nativeRosterAllowed ? heroes.filter(hero => hero && hero.role === 'roster' && hero.seat === seat && boundsValid(hero.bounds)) : [];
    if (!values.length) continue;
    const known = values.filter(validHero); const identities = new Set(known.map(hero => hero.heroId!));
    if (identities.size > 1) conflictingHeroes.add(seat);
    const identity = identities.size === 1 && known.length === values.length ? [...identities][0]! : null;
    const teams = new Set(values.filter(hero => goodConfidence(hero.confidence) && contains(crop, hero.bounds))
      .map(hero => hero.team).filter(team => team === 0 || team === 1));
    if (teams.size > 1) conflictingTeams.add(seat);
    const team = !spectator && teams.size === 1 ? [...teams][0]! : null;
    players.set(seat, { seat, heroId: identity, team,
      heroObservation: evidence(env, 'portrait', identity ? Math.min(...known.map(hero => hero.confidence)) : 0, values.map(hero => hero.bounds)),
      teamObservation: evidence(env, 'layout-association', team === null ? 0 : Math.min(...values.map(hero => hero.confidence)), values.map(hero => hero.bounds)) });
  }
  // Only the source's eight separate K/D/A columns create text-only seat keys.
  // A collection of hero names in chat, a build menu, or a roster cannot do so.
  for (const [seat, column] of columns.entries()) {
    const hits = lines.filter(line => line.bounds.width <= 0.095 && Math.abs(centerX(line.bounds) - centerX(column)) < 0.026
      && line.bounds.height <= 0.02 && centerY(line.bounds) >= column.y - 0.035 && centerY(line.bounds) < column.y)
      .flatMap(line => (heroNames.get(line.key) ?? []).map(heroId => ({ heroId, line })));
    const ids = new Set(hits.map(hit => hit.heroId)); const player = players.get(seat) ?? { seat };
    const id = ids.size === 1 ? [...ids][0]! : null;
    if (hits.length && (conflictingHeroes.has(seat) || player.heroId && player.heroId !== id)) {
      conflictingHeroes.add(seat); player.heroId = null;
      player.heroObservation = evidence(env, 'visible-text', 0, hits.map(hit => hit.line.bounds));
    } else if (hits.length && !player.heroId) {
      player.heroId = id;
      player.heroObservation = evidence(env, 'visible-text', id ? 1 : 0, hits.map(hit => hit.line.bounds));
    } else if (!('heroId' in player)) { player.heroId = null; player.heroObservation = evidence(env, 'visible-text', 0, [column]); }
    if (!('team' in player)) { player.team = null; player.teamObservation = evidence(env, 'layout-association', 0, [column]); }
    players.set(seat, player);
  }
  const viewHeroes = heroes.filter(hero => hero && hero.role === 'local' && validHero(hero)
    && regionFor('local-hero').some(region => contains(region.bounds, hero.bounds) && contains(crop, region.bounds)));
  const viewIds = new Set(viewHeroes.map(hero => hero.heroId!));
  const viewHeroId = viewIds.size === 1 ? [...viewIds][0]! : null;
  const participant = (context as NativeScreenContext & { viewMode?: string } | undefined)?.viewMode === 'participant';
  let ownsView = !spectator && participant && viewHeroId !== null && !viewHeroes.some(hero => hero.isLocal === false);
  let localSeat: number | null = null;
  const directSeats = heroes.filter(hero => nativeRosterAllowed && hero && hero.role === 'roster' && hero.isLocal === true && seatValid(hero.seat)
    && validHero(hero) && hero.heroId === viewHeroId).map(hero => hero.seat!);
  if (ownsView && new Set(directSeats).size === 1) localSeat = directSeats[0]!;
  const aliases = new Set((options.localPlayerNames ?? []).slice(0, 8).filter(value => typeof value === 'string' && value.length <= 80).map(playerNameKey).filter(Boolean));
  let aliasBounds: CaptureRegion[] = [];
  if (!spectator && scoreboard && viewHeroId && aliases.size && columns.length === 8) {
    const matches = scoreboardPlayerNames(reply.blocks, crop, columns, new Set(heroNames.keys())).filter(row => aliases.has(row.text));
    const seats = new Set(matches.map(value => value.seat));
    if (seats.size === 1 && matches.every(value => value.complete)) {
      const seat = [...seats][0]!;
      if (!conflictingHeroes.has(seat) && players.get(seat)?.heroId === viewHeroId
        && !viewHeroes.some(hero => hero.isLocal === false)) {
        localSeat = seat; ownsView = true; aliasBounds = matches.map(value => value.bounds);
      }
    }
  }
  const freshOwnership = ownsView;
  const continuing = !ownsView && !spectator && viewHeroId !== null && !!previous && previous.viewMode === 'participant'
    && priorOwnershipFresh && previous.localHeroId === viewHeroId && !nativeUnsupported
    && !(result.matchId && previous.matchId && result.matchId !== previous.matchId)
    && !viewHeroes.some(hero => hero.isLocal === false);
  if (continuing) ownsView = true;
  if (spectator) {
    result.viewMode = 'spectator'; result.fields!.viewMode = evidence(env, 'layout-association', 1,
      lines.filter(line => SPECTATOR.test(line.key)).map(line => line.bounds));
  } else if (freshOwnership || participant) {
    result.viewMode = 'participant'; result.fields!.viewMode = evidence(env, 'layout-association', QUALITY,
      [...viewHeroes.map(hero => hero.bounds), ...aliasBounds]);
  } else if (!continuing) {
    result.viewMode = 'unknown'; result.fields!.viewMode = evidence(env, 'layout-association', 0, []);
  }
  if (ownsView && columns.length === 8) {
    for (const [seat, player] of players) {
      const sourceTeam = seat < 4 ? 0 : 1;
      if (conflictingTeams.has(seat) || player.team !== null && player.team !== undefined && player.team !== sourceTeam) {
        player.team = null; player.teamObservation = evidence(env, 'layout-association', 0, [columns[seat]!]);
      } else {
        player.team = sourceTeam; player.teamObservation = evidence(env, 'layout-association', 1, [columns[seat]!]);
      }
    }
  }
  if (ownsView && viewHeroId) {
    result.localHeroId = viewHeroId; result.fields!.localHeroId = evidence(env, 'layout-association', Math.min(...viewHeroes.map(hero => hero.confidence)), viewHeroes.map(hero => hero.bounds));
    if (freshOwnership) result.localSeat = localSeat;
    const local = localSeat === null ? null : players.get(localSeat);
    if (freshOwnership) result.localTeam = local?.team ?? null;
    if (local) {
      local.isLocal = true; local.localObservation = evidence(env, 'layout-association', QUALITY, [...(local.heroObservation?.bounds ?? []), ...viewHeroes.map(hero => hero.bounds)]);
      result.fields!.localSeat = local.localObservation; result.fields!.localTeam = local.localObservation;
    }
  } else if (spectator || heroes.some(hero => hero && hero.role === 'local')) {
    result.localHeroId = null; result.localSeat = null; result.localTeam = null;
  }
  function inventory(items: readonly NativeContextItem[], region: NativeContextRegion | undefined): { items: ScreenInventoryItem[]; completeness: ScreenCompleteness; slotCompleteness: ScreenCompleteness; observation: ScreenContextObservation | null } {
    const slots = new Map<number, NativeContextItem[]>();
    for (const item of items) if (item && slotValid(item.slot)) slots.set(item.slot, [...(slots.get(item.slot) ?? []), item]);
    const parsed: ScreenInventoryItem[] = []; const resolved = new Set<number>();
    for (const [slot, values] of slots) {
      const valid = values.filter(item => boundsValid(item.bounds) && contains(crop, item.bounds) && (!region || contains(region.bounds, item.bounds)));
      const identities = new Set(valid.map(item => item.status === 'recognized' && goodConfidence(item.confidence) && item.itemId && itemIds.has(item.itemId) ? item.itemId : null));
      const recognized = valid.length === values.length && identities.size === 1 && !identities.has(null);
      const empty = valid.length === values.length && valid.length > 0 && valid.every(item => item.status === 'empty' && !item.itemId && goodConfidence(item.confidence));
      if (recognized || empty) resolved.add(slot);
      const source = valid[0] ?? values[0]!;
      const variant = recognized && new Set(valid.map(item => item.variant)).size === 1
        && ['base', 'enhanced', 'legendary', 'corrupted'].includes(source.variant ?? '') ? source.variant! : 'unknown';
      const quantity = recognized && new Set(valid.map(item => item.quantity)).size === 1 && Number.isInteger(source.quantity)
        && Number(source.quantity) > 0 && Number(source.quantity) <= 1_000_000 ? source.quantity! : null;
      parsed.push({ slot, itemId: recognized ? [...identities][0]! : null, status: empty ? 'empty' : recognized ? 'recognized' : values.every(item => item.status === 'hidden') ? 'hidden' : 'unknown',
        variant, bonusIds: empty ? [] : null, quantity,
        observation: evidence(env, 'item-icon', recognized || empty ? Math.min(...valid.map(item => item.confidence)) : 0, valid.map(item => item.bounds)) });
    }
    const count = region?.slotCount; const enumerated = Number.isInteger(count) && count! >= 0 && count! <= SLOT_LIMIT
      && slots.size === count! && items.every(item => item && slotValid(item.slot) && item.slot < count!)
      && Array.from({ length: count! }, (_, slot) => slot).every(slot => resolved.has(slot))
      && separateBounds(parsed.map(item => item.observation.bounds[0]).filter(boundsValid));
    const covered = !!region?.complete && contains(crop, region.bounds) && enumerated
      && (!Array.isArray(context?.items) || context.items.length <= MAX_ITEMS);
    // Material modifier, stack and bonus coverage cannot be certified by a base image match.
    const material = parsed.every(item => item.status === 'empty' || item.variant !== 'unknown' && item.quantity !== null && item.bonusIds !== null);
    const completeness: ScreenCompleteness = covered && material ? 'complete' : items.length || region ? 'partial' : 'unknown';
    const slotCompleteness: ScreenCompleteness = covered ? 'complete' : items.length || region ? 'partial' : 'unknown';
    const positiveConfidence = parsed.some(item => item.observation.confidence >= QUALITY) ? QUALITY : 0;
    const observation = region ? evidence(env, 'layout-association', covered ? 1 : positiveConfidence, [region.bounds])
      : parsed.length ? evidence(env, 'item-icon', positiveConfidence, parsed.flatMap(item => item.observation.bounds)) : null;
    return { items: parsed.sort((a, b) => a.slot - b.slot), completeness, slotCompleteness, observation };
  }
  for (const [seat, player] of players) {
    const items = nativeRosterAllowed ? rawItems.filter(item => item && item.role === 'player-inventory' && item.seat === seat) : [];
    const region = nativeRosterAllowed ? regionFor('inventory', seat)[0] : undefined;
    if (items.length || region) {
      const collection = inventory(items, region); player.inventory = collection.items; player.inventoryCompleteness = collection.completeness;
      player.inventorySlotCompleteness = collection.slotCompleteness; player.inventoryObservation = collection.observation;
    }
  }
  if (players.size) {
    result.players = [...players.values()].sort((a, b) => a.seat - b.seat);
    const rosterRegion = regionFor('roster')[0];
    const complete = players.size === 8 && result.players.every(player => player.heroId && (player.team === 0 || player.team === 1))
      && result.players.filter(player => player.team === 0).length === 4 && result.players.filter(player => player.team === 1).length === 4
      && !!rosterRegion?.complete && rosterRegion.slotCount === 8 && contains(crop, rosterRegion.bounds)
      && result.players.every(player => player.heroObservation?.bounds.length && player.heroObservation.bounds.every(bounds => contains(rosterRegion.bounds, bounds)))
      && separateBounds(result.players.map(player => player.heroObservation?.bounds[0]).filter(boundsValid))
      && (!Array.isArray(context?.heroes) || context.heroes.length <= 16);
    result.rosterCompleteness = complete ? 'complete' : 'partial';
    result.rosterObservation = evidence(env, 'layout-association', complete ? 1 : 0, rosterRegion ? [rosterRegion.bounds] : columns);
  }
  if (ownsView) {
    const localItems = rawItems.filter(item => item && item.role === 'local-inventory'); const localRegion = regionFor('inventory')[0];
    if (localItems.length || localRegion) {
      const collection = inventory(localItems, localRegion); result.localInventory = collection.items; result.localInventoryCompleteness = collection.completeness;
      result.localInventorySlotCompleteness = collection.slotCompleteness; result.localInventoryObservation = collection.observation;
    } else if (freshOwnership && localSeat !== null) {
      const local = players.get(localSeat);
      if (local?.inventory !== undefined) {
        result.localInventory = local.inventory; result.localInventoryCompleteness = local.inventoryCompleteness;
        result.localInventorySlotCompleteness = local.inventorySlotCompleteness; result.localInventoryObservation = local.inventoryObservation;
      }
    }
    const abilityRegion = regionFor('abilities')[0];
    const abilityInputs = (Array.isArray(context?.abilities) ? context.abilities : []).slice(0, 8);
    if (abilityInputs.length || abilityRegion) {
      const abilities: ScreenAbilityState[] = [];
      for (const slot of [0, 1, 2, 3] as const) {
        const values = abilityInputs.filter(ability => ability && ability.slot === slot && boundsValid(ability.bounds) && contains(crop, ability.bounds)
          && !!abilityRegion && contains(abilityRegion.bounds, ability.bounds));
        if (!values.length) continue;
        const known = values.every(value => goodConfidence(value.confidence)) && new Set(values.map(value => value.rank)).size === 1
          && new Set(values.map(value => value.unlocked)).size === 1;
        const first = values[0]!; const unlocked = known && typeof first.unlocked === 'boolean' ? first.unlocked : null;
        const rank = known && Number.isInteger(first.rank) && first.rank! >= 0 && first.rank! <= 3 && (first.rank === 0 || unlocked === true) ? first.rank : null;
        const nextUpgradeCost = values.every(value => goodConfidence(value.confidence)) && new Set(values.map(value => value.nextUpgradeCost)).size === 1
          && Number.isInteger(first.nextUpgradeCost) && first.nextUpgradeCost! >= 0 && first.nextUpgradeCost! <= 1000 ? first.nextUpgradeCost! : null;
        const abilityId = contextCatalogCompatible(catalog) ? CONTEXT_CATALOG.abilities.find(ability => ability.heroId === viewHeroId && ability.slot === slot)?.id ?? null : null;
        abilities.push({ slot, abilityId, rank, unlocked, nextUpgradeCost, observation: evidence(env, 'ability-pips',
          rank !== null || unlocked !== null || nextUpgradeCost !== null ? Math.min(...values.map(value => value.confidence)) : 0, values.map(value => value.bounds)) });
      }
      result.localAbilities = abilities; result.abilityCompleteness = abilityRegion?.complete && abilityRegion.slotCount === 4 && contains(crop, abilityRegion.bounds)
        && abilities.length === 4 && abilities.every(ability => ability.rank !== null && ability.unlocked !== null)
        && separateBounds(abilities.map(ability => ability.observation.bounds[0]).filter(boundsValid))
        && (!Array.isArray(context?.abilities) || context.abilities.length <= 8) ? 'complete' : 'partial';
      result.abilityObservation = evidence(env, 'layout-association', result.abilityCompleteness === 'complete' ? 1 : 0, abilityRegion ? [abilityRegion.bounds] : []);
    }
    const budget = context?.abilityPoints; const budgetRegion = regionFor('ability-points')[0];
    if (budget && budgetRegion && boundsValid(budget.bounds) && contains(crop, budget.bounds) && contains(budgetRegion.bounds, budget.bounds)) {
      result.localAbilityPoints = goodConfidence(budget.confidence) && Number.isInteger(budget.value) && budget.value! >= 0 && budget.value! <= 1000 ? budget.value : null;
      result.fields!.localAbilityPoints = evidence(env, 'layout-association', result.localAbilityPoints === null ? 0 : budget.confidence, [budget.bounds]);
    }
  }
  return result;
}
