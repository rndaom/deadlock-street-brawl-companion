import type { Catalog, CatalogItem } from '../shared/types';
import type { CaptureRegion, NativeIconMatch, NativeOcrBlock, ScreenOffer, ScreenOfferParseResult } from '../shared/screen-reading';
import { absorbedComponents } from './item-bundles';

export type { ScreenOfferParseResult } from '../shared/screen-reading';
export interface ScreenOfferParserOptions {
  /** The coordinator may supply only a separate draft hint captured within one second. */
  draftConfirmed?: boolean;
  /** Bonus candidates must include failed visible slots, not only successful matches. Matches with the
   * role "card" name a card's own item by its icon; they fill an unread name and never open a draft. */
  iconMatches?: readonly NativeIconMatch[];
  /** Real captures cannot prove missing small modifier/bonus labels are absent. */
  conservativeUnmarkedDetails?: boolean;
  /** Items read in your own inventory. A card whose item upgrades from one of them carries a
   * "Bonus!" item; a card that absorbs none of them carries no bonus. Omit when unknown. */
  ownedItemIds?: readonly string[];
  maxBlocks?: number;
  /** The game client's width / height. The draft panel is laid out for 16:9 and kept centred and
   * scaled by height, so on an ultrawide screen the cards sit closer together as a share of the width. */
  aspect?: number;
  /** Where the blocks' capture area sits in the game client (block coordinates are relative to it);
   * used to check card heights when only one or two cards are readable. Default: the whole client. */
  crop?: CaptureRegion;
}

type Variant = ScreenOffer['variant'];
interface TextLine extends CaptureRegion { text: string; key: string; sources: number[] }
interface NameMatch { item: CatalogItem; confidence: number; corrected: boolean }
interface ItemHit extends NameMatch { line: TextLine; bonus: boolean; variants: Variant[]; segment: number }
interface CatalogIndex {
  exact: Map<string, CatalogItem[]>;
  compact: Map<string, CatalogItem[]>;
  glyphs: Map<string, CatalogItem[]>;
  candidates: { item: CatalogItem; key: string }[];
  cache: Map<string, NameMatch | null>;
}
interface Column { center: number; seeds: TextLine[] }
const indices = new WeakMap<Catalog, CatalogIndex>();
const MAX_BLOCKS = 512;
/** Parser message when the game shows its draft-closed label. */
export const SELECTIONS_COMPLETE_MESSAGE = 'Item selections are complete.';
const MAX_CATALOG_ITEMS = 512;
const MIN_COLUMN_SEPARATION = 0.14;
/** Horizontal distances are tuned for 16:9; set per parse from ScreenOfferParserOptions.aspect. */
let squeeze = 1;
const CLOSED = /\b(?:selects? complete|selections? complete|draft complete|no (?:items|drafts) available)\b/;
// The actual Street Brawl panel uses "Select Items". Instruction prose in
// inventory/build menus is not a title, even when it contains the same words.
const TITLE = /^select\s*items\s*:?$/;
const CHOICE = /^choice\s*(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})$/;
const USE_REROLL = /^use\s+re\s*roll$/;
const RE_ROLL = /\bre\s*rolls?\b/;
const SHOP = /\b(?:inventory|shop items|browse items|recommended build|sell item|purchase items)\b/;
// Windows OCR reads the stylized "BONUS!" card label as "eoNUS!" or "eoNusr" (real Oct 2026 logs).
const BONUS_WORD = '[be8]?[o0]nus[rl1i]?';
const BONUS_LABEL = new RegExp(`^${BONUS_WORD}(?:\\s*(?:x|of)?\\s*[12])?$`);
const CARD_LABEL_EXACT = new RegExp(`^(?:tier\\s*[1-5]|rare|legendary|enhanced|corrupted|${BONUS_WORD}(?:\\s*(?:x|of)?\\s*[12])?|option\\s*[123])$`);
/**
 * The "BONUS!" label as Windows OCR renders it: "eoNUS!", "eoNusr", and on 2026-10-18 also "eoevus!",
 * "eotVUS'", "eoegus!" and "eo.VUS!" (the stylized B reads as e, the N as ev/tV/eg). The whole line
 * must be one short token (an optional "x2" aside) that starts like B/e/8, ends in -us (plus a stray
 * r/l/1/i), and is at most two edits from "bonus" or its usual "eonus" form; ordinary words such as
 * "focus", "venus" or "minus" fail the first letter, and the caller also requires the label above the card name.
 */
export function isBonusLabel(key: string): boolean {
  const token = key.replace(/\s*(?:x|of)?\s*[12]$/, '').replace(/\s+/g, '');
  if (token.length < 4 || token.length > 7 || !/^[be8]/.test(token) || !/us[rl1i]?$/.test(token)) return false;
  const core = token.replace(/(us)[rl1i]$/, '$1');
  return boundedDistance(core, 'bonus', 2) <= 2 || boundedDistance(core, 'eonus', 2) <= 2;
}
const CARD_LABEL = { test: (key: string) => CARD_LABEL_EXACT.test(key) || isBonusLabel(key) };
// A hovered card opens a tooltip over its neighbour: its title and "UPGRADES FROM:" component
// are catalogue names that must never be read as that neighbour's card (real 17:31Z and 19:58Z
// reads showed Headshot Booster and a second Stamina Mastery in the middle card; 2026-10-18 12:03:10Z
// read "UPGRADES TO : Crippling Headshot" as the middle card).
const TOOLTIP_MARKER = /^(?:passive|active|upgrades (?:from|to)\s*:?|see details|hold to view modified stats|components?\s*:?)$/;
const UPGRADE_LINK = /^upgrades (?:from|to)\s*:?$/;
const UNKNOWN_MODIFIER = /^(?:enchanted|empowered|upgraded|cursed|mutated|modified)(?:\s+item)?$|^(?:enhancement|modifier)\s*:/;
/** The native reader marks each end of a card name that the expanded scoreboard covers with this character. */
const CLIPPED = '\u2026';

/** Whole label normalization, not substring extraction from tooltips or descriptions. */
export function normalizeOfferText(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’']/g, '').replace(/[^a-z0-9/:+]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function compact(text: string): string { return text.replace(/\s+/g, ''); }
// Tesseract reads the card font's O as Q ("Spiritual Querflow") and its y and v as u ("Lucku Shot", "Ouerflow").
const GLYPH_GROUPS = ['1il', '0oq', '5s', 'uvy'];
function glyphKey(text: string): string { return compact(text).replace(/[1il]/g, 'l').replace(/[0oq]/g, 'o').replace(/[5s]/g, 's').replace(/[uvy]/g, 'u'); }
function cx(line: CaptureRegion): number { return line.x + line.width / 2; }
function cy(line: CaptureRegion): number { return line.y + line.height / 2; }
function validBounds(value: CaptureRegion): boolean {
  return [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && value.x >= -0.001 && value.y >= -0.001 && value.width > 0 && value.height > 0
    && value.width <= 1 && value.height <= 1 && value.x + value.width <= 1.001 && value.y + value.height <= 1.001;
}
function union(lines: readonly TextLine[], text = lines.map(line => line.text).join(' ')): TextLine {
  const x = Math.min(...lines.map(line => line.x)); const y = Math.min(...lines.map(line => line.y));
  return { text, key: normalizeOfferText(text), x, y,
    width: Math.max(...lines.map(line => line.x + line.width)) - x,
    height: Math.max(...lines.map(line => line.y + line.height)) - y,
    sources: [...new Set(lines.flatMap(line => line.sources))] };
}
function prepareLines(blocks: readonly NativeOcrBlock[], maxBlocks: number): { lines: TextLine[]; truncated: boolean } {
  const parts: TextLine[] = []; let invalid = false;
  for (const [index, block] of blocks.slice(0, maxBlocks).entries()) {
    if (!block || typeof block.text !== 'string' || !validBounds(block)) { invalid = true; continue; }
    const text = block.text.slice(0, 180).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (!text) continue;
    const split = text.split(/[\r\n]+/).filter(Boolean);
    split.forEach((part, line) => parts.push({ text: part, key: normalizeOfferText(part), x: block.x,
      y: block.y + line * block.height / split.length, width: block.width,
      height: block.height / split.length, sources: [index] }));
    if (block.text.length > 180) invalid = true;
  }
  // Windows OCR may return either lines or individual words. Join adjacent words only
  // within one visual line; names from separate offer columns cannot be concatenated.
  const rows: TextLine[][] = [];
  for (const part of parts.sort((a, b) => cy(a) - cy(b) || a.x - b.x)) {
    const row = rows.find(candidate => Math.abs(cy(candidate[0]!) - cy(part)) <= Math.max(0.006, Math.min(candidate[0]!.height, part.height) * 0.6));
    if (row) row.push(part); else rows.push([part]);
  }
  const lines: TextLine[] = [];
  for (const row of rows) {
    let run: TextLine[] = [];
    const emit = () => { if (run.length) lines.push(union(run)); run = []; };
    for (const part of row.sort((a, b) => a.x - b.x)) {
      const last = run.at(-1);
      const gap = last ? part.x - (last.x + last.width) : 0;
      const span = run.length ? part.x + part.width - run[0]!.x : part.width;
      // Text of very different sizes is not one line: a card name beside a tooltip's small stat text on the same row
      // ("Radius" and "Toxic Bullets" on a real 2026-11-01 frame) would otherwise read as one unknown name.
      const sized = !last || Math.min(last.height, part.height) >= Math.max(last.height, part.height) * 0.5;
      // A "…" end is where an overlay covers a card name: what lies beyond it is the overlay, not more of the name.
      const covered = !!last && (last.text.endsWith(CLIPPED) || part.text.startsWith(CLIPPED));
      if (last && (gap > Math.min(0.045, Math.max(0.018, part.height * 1.5)) || gap < -0.01 || span > 0.4 || !sized || covered)) emit();
      run.push(part);
    }
    emit();
  }
  return { lines, truncated: blocks.length > maxBlocks || invalid };
}
function addTo(map: Map<string, CatalogItem[]>, key: string, item: CatalogItem): void { const list = map.get(key) ?? []; list.push(item); map.set(key, list); }
function indexFor(catalog: Catalog): CatalogIndex {
  const cached = indices.get(catalog); if (cached) return cached;
  const index: CatalogIndex = { exact: new Map(), compact: new Map(), glyphs: new Map(), candidates: [], cache: new Map() };
  for (const item of catalog.items.slice(0, MAX_CATALOG_ITEMS)) {
    const key = normalizeOfferText(item.name); if (!key || key.length > 60) continue;
    addTo(index.exact, key, item); addTo(index.compact, compact(key), item); addTo(index.glyphs, glyphKey(key), item);
    index.candidates.push({ item, key: compact(key) });
  }
  indices.set(catalog, index); return index;
}
function boundedDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = Array<number>(b.length + 1).fill(limit + 1); current[0] = row; let minimum = current[0]!;
    for (let column = Math.max(1, row - limit); column <= Math.min(b.length, row + limit); column++) {
      current[column] = Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1));
      minimum = Math.min(minimum, current[column]!);
    }
    if (minimum > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}
function glyphDifference(a: string, b: string): number | null {
  if (a.length !== b.length) return null; let differences = 0;
  for (let index = 0; index < a.length; index++) {
    if (a[index] === b[index]) continue;
    if (!GLYPH_GROUPS.some(group => group.includes(a[index]!) && group.includes(b[index]!))) return null;
    differences++;
  }
  return differences;
}
/** Short names require exact text or a specific OCR glyph confusion. General fuzzy
 * matching needs >=90% similarity and a >=8-point margin over the next catalogue name. */
function matchName(key: string, index: CatalogIndex): NameMatch | null {
  if (index.cache.has(key)) return index.cache.get(key)!;
  let result: NameMatch | null = null; const exact = index.exact.get(key);
  if (exact?.length === 1) result = { item: exact[0]!, confidence: 1, corrected: false };
  else if (!exact && key.length >= 3 && key.length <= 60 && key.split(' ').length <= 6) {
    const value = compact(key); const joined = index.compact.get(value);
    if (joined?.length === 1) result = { item: joined[0]!, confidence: 0.99, corrected: true };
    else if (!joined && value.length >= 5) {
      const glyphs = index.glyphs.get(glyphKey(key));
      if (glyphs?.length === 1) {
        const difference = glyphDifference(value, compact(normalizeOfferText(glyphs[0]!.name)));
        if (difference !== null && difference > 0 && difference <= 2) result = { item: glyphs[0]!, confidence: 0.96 - difference * 0.015, corrected: true };
      }
      if (!result && value.length >= 8) {
        const maxEdits = value.length >= 16 ? 2 : 1;
        const ranked = index.candidates.filter(candidate => Math.abs(candidate.key.length - value.length) <= maxEdits + 2)
          .map(candidate => ({ ...candidate, distance: boundedDistance(value, candidate.key, maxEdits + 2) }))
          .filter(candidate => candidate.distance <= maxEdits + 2)
          .map(candidate => ({ ...candidate, similarity: 1 - candidate.distance / Math.max(value.length, candidate.key.length) }))
          .sort((a, b) => b.similarity - a.similarity);
        const best = ranked[0]; const next = ranked[1];
        if (best && best.distance <= maxEdits && best.similarity >= 0.9 && best.similarity - (next?.similarity ?? 0) >= 0.08) result = { item: best.item, confidence: best.similarity, corrected: true };
      }
    }
  }
  if (index.cache.size >= 1024) index.cache.clear(); index.cache.set(key, result); return result;
}
/**
 * A card name with one or both ends covered (marked "…" by the native reader), as the visible part of exactly one
 * catalogue name: "…thereal Shif…" is Ethereal Shift, "…apid Rechart…" Rapid Recharge (real 2026-11-01 pick-1 frames,
 * where the open scoreboard hid the middle card's name ends for the whole pick). The glyph at a covered end may be cut
 * and misread, so it may be dropped. At least six letters and half the name must be visible, within one OCR
 * correction for ten or more letters, and no other name may fit as well.
 */
function clippedName(text: string, index: CatalogIndex): NameMatch | null {
  const trimmed = text.trim(); const left = trimmed.startsWith(CLIPPED); const right = trimmed.endsWith(CLIPPED);
  if (!left && !right) return null;
  const visible = glyphKey(normalizeOfferText(trimmed.split(CLIPPED).join(' ')));
  const tries = new Set([visible, left ? visible.slice(1) : '', right ? visible.slice(0, -1) : '', left && right ? visible.slice(1, -1) : ''].filter(value => value.length >= 6));
  let best: { item: CatalogItem; distance: number; shown: number } | null = null; let tied = false;
  for (const candidate of index.candidates) {
    const name = glyphKey(candidate.key); let distance = Infinity; let shown = 0;
    for (const value of tries) {
      const found = partialDistance(value, name, left, right);
      if (found > (value.length >= 10 ? 1 : 0) || found > distance) continue;
      shown = found < distance ? value.length : Math.max(shown, value.length); distance = found;
    }
    if (distance === Infinity) continue;
    // Every name the visible part fits counts against uniqueness ("…Headshot…" fits three names), however long it is.
    if (!best || distance < best.distance) { best = { item: candidate.item, distance, shown: shown / name.length }; tied = false; }
    else if (distance === best.distance && candidate.item.id !== best.item.id) tied = true;
  }
  return best && !tied && best.shown >= 0.5 ? { item: best.item, confidence: 0.9 - best.distance * 0.03, corrected: true } : null;
}
/** Edits from `part` to `name` when the name may continue past the part on a covered left and/or right end. */
function partialDistance(part: string, name: string, left: boolean, right: boolean): number {
  let previous = Array.from({ length: name.length + 1 }, (_, column) => left ? 0 : column);
  for (let row = 1; row <= part.length; row++) {
    const current = [row];
    for (let column = 1; column <= name.length; column++) {
      current[column] = Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + (part[row - 1] === name[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return right ? Math.min(...previous) : previous[name.length]!;
}
function cues(lines: readonly TextLine[]): { closed: boolean; title: boolean; choice: boolean; reroll: boolean; useReroll: boolean; skip: boolean; shop: boolean } {
  const keys = lines.map(line => line.key);
  const sourceChoice = (key: string) => {
    const match = key.match(CHOICE); if (!match) return false;
    const current = Number(match[1]); const total = Number(match[2]);
    // Pinned Street Brawl generic-data has three draft decisions each round.
    return total === 3 && current >= 1 && current <= total;
  };
  const sourceTitle = (key: string) => TITLE.test(key) || glyphKey(key) === glyphKey('select items');
  return { closed: keys.some(key => CLOSED.test(key)), title: keys.some(sourceTitle), choice: keys.some(sourceChoice),
    reroll: keys.some(key => RE_ROLL.test(key)), useReroll: keys.some(key => USE_REROLL.test(key)), skip: keys.some(key => /^skip items?$/.test(key)), shop: keys.some(key => SHOP.test(key)) };
}
/** True when the game's own draft-closed label ("Selects Complete") is visible. */
export function detectDraftClosed(blocks: readonly NativeOcrBlock[]): boolean {
  return Array.isArray(blocks) && cues(prepareLines(blocks, MAX_BLOCKS).lines).closed;
}
/** Cheap waiting-phase probe. Its result alone never supplies item offers. */
export function detectDraftHint(blocks: readonly NativeOcrBlock[]): boolean {
  if (!Array.isArray(blocks)) return false;
  const flags = cues(prepareLines(blocks, MAX_BLOCKS).lines);
  return !flags.closed && (flags.title || flags.choice || flags.useReroll);
}
/** The "Choice N of 3" number visible in these blocks, or null. */
export function draftChoiceStage(blocks: readonly NativeOcrBlock[]): number | null {
  if (!Array.isArray(blocks)) return null;
  const stages = new Set(prepareLines(blocks, MAX_BLOCKS).lines.map(line => line.key.match(CHOICE)).filter(match => match && match[2] === '3')
    .map(match => Number(match![1])).filter(stage => stage >= 1 && stage <= 3));
  return stages.size === 1 ? [...stages][0]! : null;
}
/**
 * Which of these items are named on screen as a whole line outside any tooltip. When the next
 * "Choice N of 3" opens, the card just picked stays on screen while the new cards deal in (real
 * 2026-10-18 frames: Battle Vest, High-Velocity Rounds and Spirit Resilience each lingered after
 * being picked), so this tells which card was taken even when the inventory slot is never read.
 */
export function namedItems(blocks: readonly NativeOcrBlock[], catalog: Catalog, itemIds: readonly string[]): string[] {
  return [...new Set(namedItemCenters(blocks, catalog, itemIds).map(entry => entry.itemId))];
}
/** As namedItems, with the horizontal centre of each name line (in the blocks' coordinates). */
export function namedItemCenters(blocks: readonly NativeOcrBlock[], catalog: Catalog, itemIds: readonly string[]): { itemId: string; x: number }[] {
  if (!Array.isArray(blocks) || !itemIds.length || !catalog || !Array.isArray(catalog.items)) return [];
  const lines = prepareLines(blocks, MAX_BLOCKS).lines;
  const tooltip = tooltipLines(lines); const index = indexFor(catalog); const found: { itemId: string; x: number }[] = [];
  for (const line of lines) {
    if (tooltip.has(line)) continue;
    const match = matchName(decorated(line.text).key, index);
    if (match && itemIds.includes(match.item.id)) found.push({ itemId: match.item.id, x: cx(line) });
  }
  return found;
}
/** The draft card (0-2) whose name is centred at this horizontal client position, or null between cards. */
export function cardSlotAt(clientX: number, aspect = 16 / 9): number | null {
  const scale = Number.isFinite(aspect) && aspect > 16 / 9 ? (16 / 9) / aspect : 1;
  const best = [0, 1, 2].map(slot => ({ slot, distance: Math.abs(clientX - (0.5 + (slot - 1) * SLOT_OFFSET * scale)) }))
    .sort((a, b) => a.distance - b.distance)[0]!;
  return best.distance <= 0.06 * scale ? best.slot : null;
}
function decorated(text: string): { key: string; bonus: boolean; variants: Variant[] } {
  let key = normalizeOfferText(text); const variants: Variant[] = [];
  const bonus = /^\s*(?:bonus(?:\s*[12])?\s*:?|\+)/.test(key);
  key = key.replace(/^(?:bonus(?:\s*[12])?\s*:?|\+)\s*/, '')
    .replace(/^(?:option|choice)\s*[123]\s*:?\s*/, '').replace(/^[123]\s+/, '');
  for (const label of ['enhanced', 'legendary', 'corrupted'] as const) {
    const pattern = new RegExp(`(?:^|\\s)${label}(?:$|\\s)`, 'g');
    if (pattern.test(key)) { variants.push(label); key = key.replace(pattern, ' ').trim(); }
  }
  key = key.replace(/^rare\s+/, '').replace(/\s+rare$/, '').replace(/^tier\s*[1-5]\s+/, '').replace(/\s+tier\s*[1-5]$/, '').trim();
  return { key, bonus, variants };
}
function collectHits(lines: readonly TextLine[], index: CatalogIndex): { hits: ItemHit[]; unresolvedBonusLines: TextLine[] } {
  const candidates = [...lines];
  // ItemName can wrap. Only adjacent, aligned lines are joined; arbitrary chunks
  // elsewhere in the UI cannot supply the missing half of a catalogue name.
  for (const line of lines) {
    if (line.key.length > 45 || line.key.split(' ').length > 4 || CARD_LABEL.test(line.key)) continue;
    const below = lines.filter(other => other !== line && other.y >= line.y + line.height - 0.005
      && other.y - (line.y + line.height) <= Math.max(0.018, line.height * 0.8)
      && (Math.abs(cx(other) - cx(line)) < 0.07 || Math.abs(other.x - line.x) < 0.025)
      && other.key.length <= 45 && !CARD_LABEL.test(other.key)).sort((a, b) => a.y - b.y);
    if (below[0]) candidates.push(union([line, below[0]]));
  }
  const hits: ItemHit[] = []; const unresolvedBonuses: { line: TextLine; segment: number }[] = [];
  // Tooltip stat lines ("•13% Spirit Lifesteal") contain item-like names. A line that starts with a
  // bullet or a percentage, or sits just right of a lone stat value ("•13%", "+8%") on the same row,
  // is description text, not a card name (two real drafts showed a card that never existed). A bare
  // leading digit is not enough: OCR reads "Leech" as "1eech".
  const statValue = /^(?:[•·+]\s*\d+(?:[.,]\d+)?\s*%?|[-+]?\d+(?:[.,]\d+)?\s*%)$/;
  const statLine = (line: TextLine) => /^\s*[•·]|^\s*[+-]?\d+(?:[.,]\d+)?\s*%/.test(line.text)
    || lines.some(other => other !== line && Math.abs(cy(other) - cy(line)) <= Math.max(0.006, line.height * 0.6)
      && other.x < line.x && line.x - (other.x + other.width) <= 0.04 && other.height >= line.height * 0.5 && other.height <= line.height * 2
      && statValue.test(other.text.trim()));
  for (const line of candidates) {
    if (cy(line) < 0.1 || cy(line) > 0.95 || line.width > 0.43 || line.height > 0.16) continue;
    if (statLine(line)) continue;
    const segments = line.text.split(/\s*\+\s*/);
    for (const [segmentIndex, segment] of segments.entries()) {
      const parsed = decorated(segment); const bonus = segmentIndex > 0 || parsed.bonus;
      if (!parsed.key || CARD_LABEL.test(parsed.key) || parsed.key.length > 60) continue;
      const match = matchName(parsed.key, index) ?? (bonus ? null : clippedName(segment, index));
      if (!match) { if (bonus) unresolvedBonuses.push({ line, segment: segmentIndex }); continue; }
      const hit: ItemHit = { ...match, line, bonus, variants: parsed.variants, segment: segmentIndex };
      const previous = hits.find(existing => existing.item.id === hit.item.id && existing.bonus === hit.bonus && existing.segment === hit.segment
        && existing.line.sources.some(source => hit.line.sources.includes(source)));
      if (!previous) hits.push(hit); else if (hit.confidence > previous.confidence) Object.assign(previous, hit);
    }
  }
  // A repaired multiline bonus supersedes its unread fragment, while an unknown
  // second/third segment in the same text block remains explicitly unresolved.
  const unresolvedBonusLines = unresolvedBonuses.filter(unresolved => !hits.some(hit => hit.bonus && hit.segment === unresolved.segment
    && hit.line.sources.some(source => unresolved.line.sources.includes(source)))).map(unresolved => unresolved.line);
  return { hits, unresolvedBonusLines };
}
/** Text of an item tooltip (title, stats, description, "UPGRADES FROM:" components). Tooltip
 * text is left-aligned under its title; card names are centred on their card. */
function tooltipLines(lines: readonly TextLine[]): Set<TextLine> {
  const result = new Set<TextLine>();
  const markers = lines.filter(line => TOOLTIP_MARKER.test(line.key));
  for (const marker of markers) for (const line of lines) {
    if (Math.abs(line.x - marker.x) <= 0.02 && line.y >= marker.y - 0.4 && line.y <= marker.y + 0.12) result.add(line);
  }
  // "UPGRADES TO:" / "UPGRADES FROM:" lists items next to their icons, so the names start right of
  // the marker: every line just below it, within the tooltip's width, is a component, never a card.
  for (const marker of markers.filter(line => UPGRADE_LINK.test(line.key))) for (const line of lines) {
    if (line !== marker && line.y >= marker.y - 0.005 && line.y <= marker.y + marker.height + 0.07
      && line.x >= marker.x - 0.02 && line.x <= marker.x + 0.25) result.add(line);
  }
  return result;
}
function columnsFor(seeds: readonly TextLine[]): Column[] {
  const columns: Column[] = [];
  for (const seed of [...seeds].sort((a, b) => cx(a) - cx(b))) {
    const last = columns.at(-1); const center = cx(seed);
    if (last && center - last.center <= 0.095 * squeeze) { last.seeds.push(seed); last.center = last.seeds.reduce((sum, line) => sum + cx(line), 0) / last.seeds.length; }
    else columns.push({ center, seeds: [seed] });
  }
  return columns;
}
function assignedColumn(bounds: CaptureRegion, columns: readonly Column[], strict = false): number | null {
  const distances = columns.map((column, position) => ({ position, distance: Math.abs(cx(bounds) - column.center) })).sort((a, b) => a.distance - b.distance);
  const closest = distances[0]; if (!closest || closest.distance > (strict ? 0.14 : 0.12) * squeeze) return null;
  if (strict && distances[1] && distances[1].distance - closest.distance < 0.025 * squeeze) return null;
  return closest.position;
}
function sourceCardLayout(columns: readonly Column[], mainHits: readonly ItemHit[]): boolean {
  const heads = columns.map((column, position) => {
    const candidates = mainHits.filter(hit => assignedColumn(hit.line, columns) === position);
    // A draft item heading is larger than background inventory/HUD labels. For an
    // unread heading, its tier/variant anchor still identifies the visual card.
    if (candidates.length) return candidates.reduce((largest, hit) => hit.line.height > largest.height ? hit.line : largest, candidates[0]!.line);
    return column.seeds.reduce((lowest, seed) => cy(seed) > cy(lowest) ? seed : lowest, column.seeds[0]!);
  });
  if (heads.length !== 3 || heads.some(head => head.height < 0.018)) return false;
  // Source panel CSS has outer options at y=247 and middle at y=0. Allow scaled
  // crops and small hover rotations, while rejecting ordinary inventory rows.
  const left = cy(heads[0]!); const middle = cy(heads[1]!); const right = cy(heads[2]!);
  const stagger = (left + right) / 2 - middle;
  return Math.abs(left - right) <= 0.14 && stagger >= 0.06 && stagger <= 0.55;
}
function countField(lines: readonly TextLine[], kind: 'round' | 'rerolls'): number | null {
  const values = new Set<number>();
  for (const line of lines) {
    // The game's italic "0 Re-Rolls Remaining" is often read as the letter O.
    // "1" is also read as I, l or J (and "Roll" as "ROII"): "I Re-Roll Remaining", "J Re-Roll Remaining".
    const regex = kind === 'round' ? /^round\s*(\d{1,2})$/ : /(?:^|\s)(\d{1,2}|o|no|i|l|j)\s*re\s*ro[il1]{2}s?\s*(?:remaining|left)\b|\bre\s*ro[il1]{2}s?\s*(?:remaining|left)?\s*:\s*(\d{1,2})\b/;
    // "1 Re-Roll Remaining" is singular and "0 Re-Rolls Remaining" plural, so a singular
    // label whose small digit was dropped still means one.
    if (kind === 'rerolls' && /^re\s*ro[il1]{2}\s*remaining$/.test(line.key)) { values.add(1); continue; }
    const match = line.key.match(regex); if (!match) continue;
    const raw = match[1] ?? match[2]!;
    const value = raw === 'o' || raw === 'no' ? 0 : raw === 'i' || raw === 'l' || raw === 'j' ? 1 : Number(raw); if (Number.isInteger(value) && value >= (kind === 'round' ? 1 : 0) && value <= (kind === 'round' ? 5 : 20)) values.add(value);
  }
  return values.size === 1 ? [...values][0]! : null;
}
function heroFrom(lines: readonly TextLine[], catalog: Catalog): string | null {
  const names = new Map(catalog.heroes.map(hero => [normalizeOfferText(hero.name), hero.id])); const found = new Set<string>();
  for (const line of lines) {
    // A roster containing several heroes does not establish the local hero. Names
    // inside player names or prose do not count as an observed hero label.
    const key = line.key.replace(/^(?:hero|playing as|your hero)\s*:?\s*/, '');
    const id = names.get(key); if (id) found.add(id);
  }
  return found.size === 1 ? [...found][0]! : null;
}
function iconBonuses(iconMatches: readonly NativeIconMatch[], columns: readonly Column[], position: number, main: ItemHit, knownIds: Set<string>,
  expectedCount: number | null = null): { ids: string[]; present: boolean; incomplete: boolean; confidence: number } {
  const slots = new Map<number, string>(); let present = false; let incomplete = false; let confidence = 1; let emptySecond = false;
  for (const icon of iconMatches.slice(0, 18)) {
    if (icon.role !== 'bonus' || !validBounds(icon.bounds)) continue;
    if (assignedColumn(icon.bounds, columns, true) !== position) continue;
    if (cy(icon.bounds) < main.line.y - 0.36 || cy(icon.bounds) > main.line.y + main.line.height + 0.12) continue;
    present = true;
    // The game shows the second bonus slot only for a two-item bonus (hasBonus2); the native
    // matcher reports it as an empty identity when nothing matched there.
    if (icon.slot === 1 && icon.itemId === '') { emptySecond = true; incomplete = true; continue; }
    if ((icon.slot !== 0 && icon.slot !== 1) || !Number.isFinite(icon.confidence) || icon.confidence < 0.94 || !knownIds.has(icon.itemId)) { incomplete = true; continue; }
    confidence = Math.min(confidence, icon.confidence);
    const previous = slots.get(icon.slot); if (previous && previous !== icon.itemId) incomplete = true; else slots.set(icon.slot, icon.itemId);
  }
  // The native matcher reports both source slots, including failed/empty ones.
  // A sibling outside the capture crop must not vanish and certify the other
  // slot as the full bundle. Explicit named OCR bundles are handled separately.
  if (present && (!slots.has(0) || !slots.has(1))) incomplete = true;
  // One owned component is absorbed, so one bonus item is expected: an identified first slot
  // with an empty second slot is the whole bundle.
  if (expectedCount === 1 && slots.size === 1 && slots.has(0) && emptySecond
    && !iconMatches.some(icon => icon.role === 'bonus' && icon.slot === 0 && assignedColumn(icon.bounds, columns, true) === position && icon.itemId !== slots.get(0))) incomplete = false;
  return { ids: [...slots.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]), present, incomplete, confidence };
}

/** Card name centres in a 16:9 panel: 0.5 and 0.5 ± 0.2217 of the width (real 1920x1080 drafts), at
 * about 0.69 (outer cards) and 0.46 (raised middle card) of the client height. */
const SLOT_OFFSET = 0.2217;
const SLOT_HEIGHTS: readonly [number, number][] = [[0.6, 0.8], [0.38, 0.56], [0.6, 0.8]];
/**
 * Card positions for one or two readable columns from the panel's fixed layout, or null when a
 * column is not where a card name can be (a stray name, a tooltip line, an inventory label).
 * @param crop the capture area within the client, so the card heights can be checked.
 */
function fixedSlots(columns: readonly Column[], mainHits: readonly ItemHit[], crop: CaptureRegion = { x: 0, y: 0, width: 1, height: 1 }): number[] | null {
  const slots: number[] = [];
  for (const [index, column] of columns.entries()) {
    const best = [0, 1, 2].map(slot => ({ slot, distance: Math.abs(crop.x + column.center * crop.width - (0.5 + (slot - 1) * SLOT_OFFSET * squeeze)) }))
      .sort((a, b) => a.distance - b.distance)[0]!;
    if (best.distance > 0.06 * squeeze || slots.includes(best.slot)) return null;
    const names = mainHits.filter(hit => assignedColumn(hit.line, columns) === index).map(hit => hit.line);
    for (const name of names) {
      const y = crop.y + cy(name) * crop.height; const [top, bottom] = SLOT_HEIGHTS[best.slot]!;
      if (name.height * crop.height < 0.018 || y < top || y > bottom) return null;
    }
    slots.push(best.slot);
  }
  return mainHits.some(hit => columns.some((_, index) => assignedColumn(hit.line, columns) === index)) ? slots : null;
}

/** A card's name row in the client: its centre height on the outer cards and on the raised middle card. */
const NAME_ROW_Y: readonly number[] = [0.688, 0.458, 0.688];
interface CardArt { item: CatalogItem; confidence: number; enhanced: boolean }
/**
 * The cards the native reader identified by their main icons, by position. The reader reports a card only when its
 * own checks passed (2026-11-14: 44 of 44 visible cards on real draft frames, none on 47 gameplay frames), so here
 * only the shape is checked: a known item, a card position, one item per position.
 */
function cardArt(iconMatches: readonly NativeIconMatch[], catalog: Catalog): (CardArt | null)[] {
  const art: (CardArt | null)[] = [null, null, null]; const disputed = new Set<number>();
  for (const icon of iconMatches.slice(0, 32)) {
    if (icon.role !== 'card' || (icon.slot !== 0 && icon.slot !== 1 && icon.slot !== 2)) continue;
    const item = catalog.items.find(candidate => candidate.id === icon.itemId);
    if (!item || !Number.isFinite(icon.confidence) || icon.confidence < 0.85) continue;
    const known = art[icon.slot];
    if (known && known.item.id !== item.id) disputed.add(icon.slot);
    else art[icon.slot] = { item, confidence: Math.min(icon.confidence, known?.confidence ?? 1), enhanced: icon.enhanced === true };
  }
  for (const slot of disputed) art[slot] = null;
  return art;
}
/**
 * Applies the icon-identified cards to the names read by OCR:
 *  - the name agrees: other names in that card's column (a tooltip title, a misread) are dropped;
 *  - the name is unread, an OCR correction, or not on the card's name row: the icon's item takes the card;
 *  - an exactly read name on the name row disagrees: both stay, so the card is reported ambiguous until a read agrees.
 */
function applyCardArt(mainHits: ItemHit[], art: readonly (CardArt | null)[], crop: CaptureRegion): { hits: ItemHit[]; byIcon: Set<ItemHit> } {
  let hits = mainHits; const byIcon = new Set<ItemHit>();
  for (const [slot, card] of art.entries()) {
    if (!card) continue;
    const center = 0.5 + (slot - 1) * SLOT_OFFSET * squeeze; const [top, bottom] = SLOT_HEIGHTS[slot]!;
    const inColumn = (hit: ItemHit) => Math.abs(crop.x + cx(hit.line) * crop.width - center) <= 0.1 * squeeze;
    const onNameRow = (hit: ItemHit) => { const y = crop.y + cy(hit.line) * crop.height; return y >= top && y <= bottom; };
    const named = hits.filter(inColumn);
    const agreeing = named.filter(hit => hit.item.id === card.item.id);
    if (agreeing.length) {
      hits = hits.filter(hit => !inColumn(hit) || hit.item.id === card.item.id);
      if (card.enhanced) for (const hit of agreeing) if (!hit.variants.includes('enhanced')) hit.variants = [...hit.variants, 'enhanced'];
      continue;
    }
    const disputed = named.some(hit => !hit.corrected && onNameRow(hit));
    const width = 0.12 * squeeze / crop.width; const height = 0.03 / crop.height;
    const line: TextLine = { text: card.item.name, key: normalizeOfferText(card.item.name), sources: [],
      x: (center - crop.x) / crop.width - width / 2, y: (NAME_ROW_Y[slot]! - crop.y) / crop.height - height / 2, width, height };
    // A capture that does not hold this card's name row cannot place the card.
    if (!validBounds(line)) continue;
    const hit: ItemHit = { item: card.item, confidence: card.confidence, corrected: false, line, bonus: false, variants: card.enhanced ? ['enhanced'] : [], segment: 0 };
    hits = [...(disputed ? hits : hits.filter(other => !inColumn(other))), hit]; byIcon.add(hit);
  }
  return { hits, byIcon };
}

/** Parses visible names in memory. It does not certify capture freshness, game
 * foreground, mode, or stability; the process coordinator verifies those separately.
 * Source UI: SteamTracking commit 4c6431cc, citadel_item_draft_{panel,option}. */
export function parseScreenOffers(blocks: readonly NativeOcrBlock[], catalog: Catalog, options: ScreenOfferParserOptions = {}): ScreenOfferParseResult {
  const empty = (message: string | null, isDraft = false, incomplete = false): ScreenOfferParseResult => ({ isDraft, offers: [], heroId: null, round: null, rerolls: null, message, signature: null, incomplete });
  if (!Array.isArray(blocks) || !catalog || !Array.isArray(catalog.items) || !Array.isArray(catalog.heroes)) return empty('Screen text is unavailable.');
  const maximum = Number.isFinite(options.maxBlocks) ? Math.max(1, Math.min(MAX_BLOCKS, Math.floor(options.maxBlocks!))) : MAX_BLOCKS;
  squeeze = options.aspect !== undefined && Number.isFinite(options.aspect) && options.aspect > 16 / 9 ? (16 / 9) / options.aspect : 1;
  const prepared = prepareLines(blocks, maximum); const lines = prepared.lines; const flags = cues(lines);
  if (flags.closed) return empty(SELECTIONS_COMPLETE_MESSAGE);
  // Use Re-Roll is an exact source button label. A mere round number, three
  // inventory names, or generic mention of rerolls does not open a draft.
  const ownDraftCue = flags.useReroll || (flags.title && (flags.choice || flags.reroll || flags.skip));
  const confirmed = options.draftConfirmed === true || ownDraftCue;
  if (!confirmed) return empty('Waiting for the item selection screen.');
  const tooltip = tooltipLines(lines); const cardText = lines.filter(line => !tooltip.has(line));
  const index = indexFor(catalog); const { hits, unresolvedBonusLines } = collectHits(cardText, index);
  const applied = applyCardArt(hits.filter(hit => !hit.bonus), cardArt(options.iconMatches ?? [], catalog), options.crop ?? { x: 0, y: 0, width: 1, height: 1 });
  const mainHits = applied.hits;
  const anchors = cardText.filter(line => CARD_LABEL.test(line.key) && cy(line) >= 0.1 && cy(line) <= 0.95 && line.width <= 0.3);
  const columns = columnsFor([...mainHits.map(hit => hit.line), ...anchors]);
  if (mainHits.length > 9 || (flags.shop && mainHits.length > 3)) return empty('An inventory or item menu is visible; waiting for draft choices.');
  const spread = columns.length === 3 && columns[2]!.center - columns[0]!.center >= 0.36 * squeeze
    && columns[1]!.center - columns[0]!.center >= MIN_COLUMN_SEPARATION * squeeze && columns[2]!.center - columns[1]!.center >= MIN_COLUMN_SEPARATION * squeeze;
  // One or two readable cards (the others still dealing in, or under a tooltip) are placed by the
  // panel's fixed card positions, so they can show before the whole set is readable.
  const partialSlots = !spread && columns.length >= 1 && columns.length <= 2 && !flags.shop ? fixedSlots(columns, mainHits, options.crop) : null;
  const draftCueVisible = flags.title || flags.choice || flags.useReroll;
  if (!spread && !partialSlots) {
    // A hint captured just before a pick must not keep combat/HUD text classified
    // as drafting after the overlay disappears from this later card capture.
    // An open item tooltip in a confirmed draft hides a card (and often the Use Re-Roll button).
    // Cards dealing in between choices show the "CHOICE 2 OF 3" label without the title: still the draft.
    return ownDraftCue || draftCueVisible ? empty('Draft visible, but three separate item choices have not been read yet.', true, true)
      : confirmed && tooltip.size ? empty('Draft visible, but an item tooltip covers one of the choices.', true, true)
      : empty('The item selection panel is no longer visible.');
  }
  // Layout corroborates a separate title probe when the later card crop has no
  // own cue. Exact labels visible in this capture already establish the panel;
  // rotated/shrunk headings must not erase otherwise readable current choices.
  if (spread && !ownDraftCue && !sourceCardLayout(columns, mainHits)) return empty('The text does not match the item-choice layout. Waiting for the selection screen.');
  const slotColumn: (number | null)[] = [null, null, null];
  (partialSlots ?? [0, 1, 2]).forEach((position, column) => { slotColumn[position] = column; });
  const knownIds = new Set(catalog.items.map(item => item.id)); const offers: ScreenOffer[] = []; let incomplete = prepared.truncated || !!partialSlots;
  for (let position = 0; position < 3; position++) {
    const columnIndex = slotColumn[position]!;
    if (columnIndex === null) {
      offers.push({ position, itemId: '', name: 'Unread item choice', bonusIds: null, variant: 'unknown', confidence: 0,
        warning: 'This card is not readable yet (still dealing in, or under a tooltip).' }); continue;
    }
    const column = columns[columnIndex]!;
    const candidates = mainHits.filter(hit => assignedColumn(hit.line, columns) === columnIndex);
    const byId = new Map(candidates.map(hit => [hit.item.id, hit]));
    if (byId.size !== 1) {
      incomplete = true; offers.push({ position, itemId: '', name: byId.size ? 'Ambiguous item name' : 'Unread item choice', bonusIds: null, variant: 'unknown', confidence: 0,
        warning: byId.size ? 'Multiple item names occupy this choice; the main item remains unconfirmed.' : 'The main item name was not recognized.', bounds: union(column.seeds) }); continue;
    }
    const main = [...byId.values()][0]!; const warnings: string[] = [];
    const cardLines = cardText.filter(line => assignedColumn(line, columns) === columnIndex
      && cy(line) >= main.line.y - 0.3 && cy(line) <= main.line.y + main.line.height + 0.16);
    const variants = new Set<Variant>(main.variants);
    for (const line of cardLines) {
      if (['enhanced', 'legendary', 'corrupted'].includes(line.key)) variants.add(line.key as Variant);
      else if (UNKNOWN_MODIFIER.test(line.key)) variants.add('unknown');
      // A slightly misread "ENHANCED" label ("ENHANCEO") is still the Enhanced tag.
      else if (line.key.length >= 6 && boundedDistance(line.key, 'enhanced', 2) <= 2) variants.add('enhanced');
    }
    // "RARE!" above a card: the item is one tier above the usual tier for this choice.
    const rare = cardLines.some(line => line.key === 'rare' || line.key.length <= 5 && boundedDistance(line.key, 'rare', 1) <= 1 && line.key.startsWith('r'));
    // A card without a modifier label is a base card. The labels ("ENHANCED", "LEGENDARY") are read
    // on most frames and stay with their card once read (screen-reader.ts), so treating every
    // unlabelled card as unconfirmed only produced a warning on every draft.
    const variant: Variant = variants.size === 0 ? 'base' : variants.size === 1 ? [...variants][0]! : 'unknown';
    if (variant !== 'base') {
      warnings.push(variant === 'unknown' ? 'The item modifier label is uncertain.' : `${variant[0]!.toUpperCase()}${variant.slice(1)} modifiers are not fully resolved by screen text.`);
      incomplete = true;
    }
    if (main.corrected) warnings.push('The item name required an OCR correction; check the game card.');
    const bonusHits = hits.filter(hit => hit.bonus && assignedColumn(hit.line, columns) === columnIndex);
    if (bonusHits.some(hit => hit.corrected)) warnings.push('A bonus item name required an OCR correction; check the game card.');
    // The label sits above the card name; a fuzzy form elsewhere on the card is not trusted.
    const bonusMarker = cardLines.some(line => BONUS_LABEL.test(line.key) || isBonusLabel(line.key) && cy(line) < main.line.y);
    // Catalogue prediction: the game adds a bonus exactly when the offered item upgrades from an
    // item you own. Known ownership turns a missing marker into a confirmed no-bonus card.
    const owned = options.ownedItemIds;
    const absorbs = owned ? absorbedComponents(main.item.id, owned) : [];
    const unresolvedBonus = unresolvedBonusLines.some(line => assignedColumn(line, columns) === columnIndex);
    const icons = iconBonuses(options.iconMatches ?? [], columns, columnIndex, main, knownIds, owned ? absorbs.length : null);
    // Slots retain multiplicity. Seeing one identity in both OCR and icon matching
    // must not double-count it; two actual slots with the same item still count twice.
    const textIds = bonusHits.map(hit => hit.item.id);
    const bonusIds = icons.present && icons.ids.length ? icons.ids : textIds;
    const textConflict = icons.present && !icons.incomplete && textIds.some(id => textIds.filter(value => value === id).length > icons.ids.filter(value => value === id).length);
    const bonusExpected = bonusMarker || absorbs.length > 0 || textIds.length > 0 || (icons.present && icons.ids.length > 0);
    // The source has no "no bonus" label, and the small Bonus! marker is often unread on real
    // captures: without ownership knowledge it stays unknown. Native image matches at the fixed
    // bonus slots prove a bundle only when the visible marker or the owned-item prediction
    // (this card upgrades something you own) attaches them to this card.
    const corroborated = !!owned && absorbs.length > 0 && icons.present && !icons.incomplete && icons.ids.length > 0;
    const predictedNone = !!owned && absorbs.length === 0 && !bonusMarker && textIds.length === 0 && !icons.present && !unresolvedBonus;
    const unmarkedBonus = options.conservativeUnmarkedDetails === true && !bonusMarker && textIds.length === 0 && !predictedNone && !corroborated;
    const unmarkedNativeBundle = options.conservativeUnmarkedDetails === true && icons.present && !bonusMarker && !corroborated;
    const bundleUnknown = unresolvedBonus || icons.incomplete || textConflict || unmarkedBonus || unmarkedNativeBundle || (bonusMarker && bonusIds.length === 0) || bonusIds.length > 2;
    if (bundleUnknown) {
      warnings.push(bonusExpected && absorbs.length && !bonusIds.length ? 'Bonus! card: it also gives a free lower-tier item that was not identified yet.'
        : unmarkedBonus || unmarkedNativeBundle ? 'Bonus details were not read; the full item bundle remains unconfirmed.' : 'Bonus items are not fully recognized; the full bundle remains unconfirmed.');
      incomplete = true;
    }
    const confidence = Math.min(main.confidence, icons.confidence, ...bonusHits.map(hit => hit.confidence));
    offers.push({ position, itemId: main.item.id, name: main.item.name, bonusIds: bundleUnknown ? null : bonusIds,
      variant, confidence, warning: warnings.length ? warnings.join(' ') : null, ...(rare ? { rare: true } : {}), ...(applied.byIcon.has(main) ? { byIcon: true } : {}),
      ...(bonusExpected ? { bonusExpected: true } : {}), ...(absorbs.length ? { absorbsIds: absorbs } : {}),
      bounds: { x: main.line.x, y: main.line.y, width: main.line.width, height: main.line.height } });
  }
  const heroId = heroFrom(lines, catalog); const round = countField(lines, 'round'); const rerolls = countField(lines, 'rerolls');
  const signature = incomplete ? null : JSON.stringify({ offers: offers.map(offer => [offer.position, offer.itemId, [...(offer.bonusIds ?? [])].sort(), offer.variant]) });
  return { isDraft: true, offers, heroId, round, rerolls, incomplete, signature,
    message: partialSlots ? 'Some item choices are not readable yet.' : incomplete ? 'Some item details are unconfirmed. Check the visible game cards.' : offers.some(offer => offer.warning) ? 'Item names were corrected by OCR; check the visible cards.' : null };
}
