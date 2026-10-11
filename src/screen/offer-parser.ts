import type { Catalog, CatalogItem } from '../shared/types';
import type { CaptureRegion, NativeIconMatch, NativeOcrBlock, ScreenOffer, ScreenOfferParseResult } from '../shared/screen-reading';

export type { ScreenOfferParseResult } from '../shared/screen-reading';
export interface ScreenOfferParserOptions {
  /** The coordinator may supply only a separate draft hint captured within one second. */
  draftConfirmed?: boolean;
  /** Bonus candidates must include failed visible slots, not only successful matches. */
  iconMatches?: readonly NativeIconMatch[];
  /** Real captures cannot prove missing small modifier/bonus labels are absent. */
  conservativeUnmarkedDetails?: boolean;
  maxBlocks?: number;
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
const CLOSED = /\b(?:selects? complete|selections? complete|draft complete|no (?:items|drafts) available)\b/;
// The actual Street Brawl panel uses "Select Items". Instruction prose in
// inventory/build menus is not a title, even when it contains the same words.
const TITLE = /^select\s*items\s*:?$/;
const CHOICE = /^choice\s*(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})$/;
const USE_REROLL = /^use\s+re\s*roll$/;
const RE_ROLL = /\bre\s*rolls?\b/;
const SHOP = /\b(?:inventory|shop items|browse items|recommended build|sell item|purchase items)\b/;
const CARD_LABEL = /^(?:tier\s*[1-5]|rare|legendary|enhanced|corrupted|bonus(?:\s*(?:x|of)?\s*[12])?|option\s*[123])$/;
const UNKNOWN_MODIFIER = /^(?:enchanted|empowered|upgraded|cursed|mutated|modified)(?:\s+item)?$|^(?:enhancement|modifier)\s*:/;

/** Whole label normalization, not substring extraction from tooltips or descriptions. */
export function normalizeOfferText(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’']/g, '').replace(/[^a-z0-9/:+]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function compact(text: string): string { return text.replace(/\s+/g, ''); }
function glyphKey(text: string): string { return compact(text).replace(/[1il]/g, 'l').replace(/[0o]/g, 'o').replace(/[5s]/g, 's'); }
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
      if (last && (gap > Math.min(0.045, Math.max(0.018, part.height * 1.5)) || gap < -0.01 || span > 0.4)) emit();
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
    if (!['1il', '0o', '5s'].some(group => group.includes(a[index]!) && group.includes(b[index]!))) return null;
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
  for (const line of candidates) {
    if (cy(line) < 0.1 || cy(line) > 0.95 || line.width > 0.43 || line.height > 0.16) continue;
    const segments = line.text.split(/\s*\+\s*/);
    for (const [segmentIndex, segment] of segments.entries()) {
      const parsed = decorated(segment); const bonus = segmentIndex > 0 || parsed.bonus;
      if (!parsed.key || CARD_LABEL.test(parsed.key) || parsed.key.length > 60) continue;
      const match = matchName(parsed.key, index);
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
function columnsFor(seeds: readonly TextLine[]): Column[] {
  const columns: Column[] = [];
  for (const seed of [...seeds].sort((a, b) => cx(a) - cx(b))) {
    const last = columns.at(-1); const center = cx(seed);
    if (last && center - last.center <= 0.095) { last.seeds.push(seed); last.center = last.seeds.reduce((sum, line) => sum + cx(line), 0) / last.seeds.length; }
    else columns.push({ center, seeds: [seed] });
  }
  return columns;
}
function assignedColumn(bounds: CaptureRegion, columns: readonly Column[], strict = false): number | null {
  const distances = columns.map((column, position) => ({ position, distance: Math.abs(cx(bounds) - column.center) })).sort((a, b) => a.distance - b.distance);
  const closest = distances[0]; if (!closest || closest.distance > (strict ? 0.14 : 0.12)) return null;
  if (strict && distances[1] && distances[1].distance - closest.distance < 0.025) return null;
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
    const regex = kind === 'round' ? /^round\s*(\d{1,2})$/ : /(?:^|\s)(\d{1,2}|o|no)\s*re\s*rolls?\s*(?:remaining|left)\b|\bre\s*rolls?\s*(?:remaining|left)?\s*:\s*(\d{1,2})\b/;
    // "1 Re-Roll Remaining" is singular and "0 Re-Rolls Remaining" plural, so a singular
    // label whose small digit was dropped still means one.
    if (kind === 'rerolls' && /^re\s*roll\s*remaining$/.test(line.key)) { values.add(1); continue; }
    const match = line.key.match(regex); if (!match) continue;
    const raw = match[1] ?? match[2]!;
    const value = raw === 'o' || raw === 'no' ? 0 : Number(raw); if (Number.isInteger(value) && value >= (kind === 'round' ? 1 : 0) && value <= (kind === 'round' ? 5 : 20)) values.add(value);
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
function iconBonuses(iconMatches: readonly NativeIconMatch[], columns: readonly Column[], position: number, main: ItemHit, knownIds: Set<string>): { ids: string[]; present: boolean; incomplete: boolean; confidence: number } {
  const slots = new Map<number, string>(); let present = false; let incomplete = false; let confidence = 1;
  for (const icon of iconMatches.slice(0, 18)) {
    if (icon.role !== 'bonus' || !validBounds(icon.bounds)) continue;
    if (assignedColumn(icon.bounds, columns, true) !== position) continue;
    if (cy(icon.bounds) < main.line.y - 0.36 || cy(icon.bounds) > main.line.y + main.line.height + 0.12) continue;
    present = true;
    if ((icon.slot !== 0 && icon.slot !== 1) || !Number.isFinite(icon.confidence) || icon.confidence < 0.94 || !knownIds.has(icon.itemId)) { incomplete = true; continue; }
    confidence = Math.min(confidence, icon.confidence);
    const previous = slots.get(icon.slot); if (previous && previous !== icon.itemId) incomplete = true; else slots.set(icon.slot, icon.itemId);
  }
  // The native matcher reports both source slots, including failed/empty ones.
  // A sibling outside the capture crop must not vanish and certify the other
  // slot as the full bundle. Explicit named OCR bundles are handled separately.
  if (present && (!slots.has(0) || !slots.has(1))) incomplete = true;
  return { ids: [...slots.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]), present, incomplete, confidence };
}

/** Parses visible names in memory. It does not certify capture freshness, game
 * foreground, mode, or stability; the process coordinator verifies those separately.
 * Source UI: SteamTracking commit 4c6431cc, citadel_item_draft_{panel,option}. */
export function parseScreenOffers(blocks: readonly NativeOcrBlock[], catalog: Catalog, options: ScreenOfferParserOptions = {}): ScreenOfferParseResult {
  const empty = (message: string | null, isDraft = false, incomplete = false): ScreenOfferParseResult => ({ isDraft, offers: [], heroId: null, round: null, rerolls: null, message, signature: null, incomplete });
  if (!Array.isArray(blocks) || !catalog || !Array.isArray(catalog.items) || !Array.isArray(catalog.heroes)) return empty('Screen text is unavailable.');
  const maximum = Number.isFinite(options.maxBlocks) ? Math.max(1, Math.min(MAX_BLOCKS, Math.floor(options.maxBlocks!))) : MAX_BLOCKS;
  const prepared = prepareLines(blocks, maximum); const lines = prepared.lines; const flags = cues(lines);
  if (flags.closed) return empty(SELECTIONS_COMPLETE_MESSAGE);
  // Use Re-Roll is an exact source button label. A mere round number, three
  // inventory names, or generic mention of rerolls does not open a draft.
  const ownDraftCue = flags.useReroll || (flags.title && (flags.choice || flags.reroll || flags.skip));
  const confirmed = options.draftConfirmed === true || ownDraftCue;
  if (!confirmed) return empty('Waiting for the item selection screen.');
  const index = indexFor(catalog); const { hits, unresolvedBonusLines } = collectHits(lines, index);
  const mainHits = hits.filter(hit => !hit.bonus);
  const anchors = lines.filter(line => CARD_LABEL.test(line.key) && cy(line) >= 0.1 && cy(line) <= 0.95 && line.width <= 0.3);
  const columns = columnsFor([...mainHits.map(hit => hit.line), ...anchors]);
  if (mainHits.length > 9 || (flags.shop && mainHits.length > 3)) return empty('An inventory or item menu is visible; waiting for draft choices.');
  if (columns.length !== 3 || columns[2]!.center - columns[0]!.center < 0.36
    || columns[1]!.center - columns[0]!.center < MIN_COLUMN_SEPARATION || columns[2]!.center - columns[1]!.center < MIN_COLUMN_SEPARATION) {
    // A hint captured just before a pick must not keep combat/HUD text classified
    // as drafting after the overlay disappears from this later card capture.
    return ownDraftCue ? empty('Draft visible, but three separate item choices have not been read yet.', true, true)
      : empty('The item selection panel is no longer visible.');
  }
  // Layout corroborates a separate title probe when the later card crop has no
  // own cue. Exact labels visible in this capture already establish the panel;
  // rotated/shrunk headings must not erase otherwise readable current choices.
  if (!ownDraftCue && !sourceCardLayout(columns, mainHits)) return empty('The text does not match the item-choice layout. Waiting for the selection screen.');
  const knownIds = new Set(catalog.items.map(item => item.id)); const offers: ScreenOffer[] = []; let incomplete = prepared.truncated;
  for (const [position, column] of columns.entries()) {
    const candidates = mainHits.filter(hit => assignedColumn(hit.line, columns) === position);
    const byId = new Map(candidates.map(hit => [hit.item.id, hit]));
    if (byId.size !== 1) {
      incomplete = true; offers.push({ position, itemId: '', name: byId.size ? 'Ambiguous item name' : 'Unread item choice', bonusIds: null, variant: 'unknown', confidence: 0,
        warning: byId.size ? 'Multiple item names occupy this choice; the main item remains unconfirmed.' : 'The main item name was not recognized.', bounds: union(column.seeds) }); continue;
    }
    const main = [...byId.values()][0]!; const warnings: string[] = [];
    const cardLines = lines.filter(line => assignedColumn(line, columns) === position
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
    const unmarkedModifier = options.conservativeUnmarkedDetails === true && variants.size === 0;
    const variant: Variant = unmarkedModifier ? 'unknown' : variants.size === 0 ? 'base' : variants.size === 1 ? [...variants][0]! : 'unknown';
    if (variant !== 'base') {
      warnings.push(unmarkedModifier ? 'No modifier label was read; item modifiers remain unconfirmed.'
        : variant === 'unknown' ? 'The item modifier label is uncertain.' : `${variant[0]!.toUpperCase()}${variant.slice(1)} modifiers are not fully resolved by screen text.`);
      incomplete = true;
    }
    if (main.corrected) warnings.push('The item name required an OCR correction; check the game card.');
    const bonusHits = hits.filter(hit => hit.bonus && assignedColumn(hit.line, columns) === position);
    if (bonusHits.some(hit => hit.corrected)) warnings.push('A bonus item name required an OCR correction; check the game card.');
    const bonusMarker = cardLines.some(line => /^bonus(?:\s|$)/.test(line.key));
    const unresolvedBonus = unresolvedBonusLines.some(line => assignedColumn(line, columns) === position);
    const icons = iconBonuses(options.iconMatches ?? [], columns, position, main, knownIds);
    // Slots retain multiplicity. Seeing one identity in both OCR and icon matching
    // must not double-count it; two actual slots with the same item still count twice.
    const textIds = bonusHits.map(hit => hit.item.id);
    const bonusIds = icons.present && icons.ids.length ? icons.ids : textIds;
    const textConflict = icons.present && !icons.incomplete && textIds.some(id => textIds.filter(value => value === id).length > icons.ids.filter(value => value === id).length);
    // The source has no "no bonus" label. On real captures an unread small Bonus!
    // marker must stay unknown. Generic/native image matches cannot prove a
    // bundle without the visible marker that attaches it to this card.
    const unmarkedBonus = options.conservativeUnmarkedDetails === true && !bonusMarker && textIds.length === 0;
    const unmarkedNativeBundle = options.conservativeUnmarkedDetails === true && icons.present && !bonusMarker;
    const bundleUnknown = unresolvedBonus || icons.incomplete || textConflict || unmarkedBonus || unmarkedNativeBundle || (bonusMarker && bonusIds.length === 0) || bonusIds.length > 2;
    if (bundleUnknown) {
      warnings.push(unmarkedBonus || unmarkedNativeBundle ? 'Bonus details were not read; the full item bundle remains unconfirmed.' : 'Bonus items are not fully recognized; the full bundle remains unconfirmed.');
      incomplete = true;
    }
    const confidence = Math.min(main.confidence, icons.confidence, ...bonusHits.map(hit => hit.confidence));
    offers.push({ position, itemId: main.item.id, name: main.item.name, bonusIds: bundleUnknown ? null : bonusIds,
      variant, confidence, warning: warnings.length ? warnings.join(' ') : null, ...(rare ? { rare: true } : {}),
      bounds: { x: main.line.x, y: main.line.y, width: main.line.width, height: main.line.height } });
  }
  const heroId = heroFrom(lines, catalog); const round = countField(lines, 'round'); const rerolls = countField(lines, 'rerolls');
  const signature = incomplete ? null : JSON.stringify({ offers: offers.map(offer => [offer.position, offer.itemId, [...(offer.bonusIds ?? [])].sort(), offer.variant]) });
  return { isDraft: true, offers, heroId, round, rerolls, incomplete, signature,
    message: incomplete ? 'Some item details are unconfirmed. Check the visible game cards.' : offers.some(offer => offer.warning) ? 'Item names were corrected by OCR; check the visible cards.' : null };
}
