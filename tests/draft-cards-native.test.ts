import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import catalogJson from '../data/public-catalog.json';
import { blocksForScreenParser, normalizeNativeReply } from '../electron/screen-reader';
import { detectDraftHint, parseScreenOffers } from '../src/screen/offer-parser';
import type { Catalog } from '../src/shared/types';

const catalog = catalogJson as unknown as Catalog;
const nativePath = resolve('native/ScreenReader/publish', process.platform === 'win32' ? 'ScreenReader.exe' : 'ScreenReader');
const runnable = (process.platform === 'win32' || process.platform === 'linux') && existsSync(nativePath);
const directory = resolve('tests/fixtures/draft-cards');

interface Truth { cards: string[]; variants: string[]; choice: number }
const cases = readdirSync(directory).filter(name => name.endsWith('.png')).map(name => ({
  name, file: resolve(directory, name), truth: (JSON.parse(readFileSync(resolve(directory, name.replace(/\.png$/, '.json')), 'utf8')) as { truth: Truth }).truth,
}));

/**
 * Real 2026-10-26 and 2026-11-01 Street Brawl draft frames from Linux matches, cropped to the draft labels and the
 * three card names. Full-frame Tesseract dropped a clearly visible card name (Extra Charge), merged OCR noise
 * into the SELECT ITEMS title so the draft was not recognized, or lost the cards under the Tab scoreboard. On
 * 2026-11-01 the open scoreboard covered both ends of the middle card's name, a tooltip's stat captions joined the
 * right card's name, and a too-tall title read removed the CHOICE label. Each fixture's .json says which.
 */
const replies = new Map<string, ReturnType<typeof normalizeNativeReply>>();
/** One replay of a fixture through the native reader, shared by the tests below. */
function review(file: string) {
  const known = replies.get(file); if (known) return known;
  const run = spawnSync(nativePath, ['--icons', resolve('assets/reader-icons'), '--context-icons', resolve('assets/context-icons'),
    '--review-image', file], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const line = run.stdout.split(/\r?\n/).find(Boolean);
  expect(line).toBeTruthy();
  const raw = JSON.parse(line!);
  const reply = normalizeNativeReply(raw, raw.crop);
  replies.set(file, reply); return reply;
}
const idOf = (name: string) => catalog.items.find(item => item.name === name)!.id;

describe.skipIf(!runnable)('native draft card reader on real frames', () => {
  it.each(cases)('$name reads all three cards', ({ file, truth }) => {
    const reply = review(file);
    expect(reply.blocks.map(block => block.text)).toContain(`CHOICE ${truth.choice} OF 3`);
    // The live draft read covers the whole client; place the cropped fixture's words where that read would see them.
    const blocks = blocksForScreenParser(reply).map(block => block.bounds ? { ...block, ...block.bounds } : block);
    // As the app does, a visible draft cue (here the CHOICE label) confirms the draft: on pick-1 frames a player banner
    // or the scoreboard can hide the SELECT ITEMS title.
    const parsed = parseScreenOffers(blocks, catalog, { draftConfirmed: detectDraftHint(blocks), conservativeUnmarkedDetails: true });
    expect(parsed.isDraft).toBe(true);
    expect(parsed.offers.map(offer => offer.name)).toEqual(truth.cards);
    expect(parsed.offers.map(offer => offer.variant)).toEqual(truth.variants);
  }, 90_000);
});

/**
 * The same frames, with each card identified by its main icon instead of its name (IconMatcher.FindCardIcons). The
 * icons are compared in colour; the three Enhanced cards here are re-tinted teal, so they are proven by their blue
 * Enhanced arrow and matched by brightness pattern. With the text on every card's name row removed, the icons alone
 * still give the three cards.
 */
describe.skipIf(!runnable)('native draft card icons on real frames', () => {
  it.each(cases)('$name identifies all three cards by their icons', ({ file, truth }) => {
    const cards = (review(file).icons ?? []).filter(icon => icon.role === 'card');
    expect([0, 1, 2].map(slot => cards.find(icon => icon.slot === slot)?.itemId)).toEqual(truth.cards.map(idOf));
    expect([0, 1, 2].map(slot => cards.find(icon => icon.slot === slot)?.enhanced === true)).toEqual(truth.variants.map(variant => variant === 'enhanced'));
    for (const card of cards) expect(card.confidence).toBeGreaterThanOrEqual(0.89);
  }, 90_000);
  it.each(cases)('$name still reads its cards when no card name is read', ({ file, truth }) => {
    const reply = review(file);
    // Everything read on a card's name row is dropped (exact names, OCR-corrected ones and scoreboard-clipped ones alike).
    const onNameRow = (block: { x: number; y: number; width: number; height: number }) => [0, 1, 2].some(slot => {
      const x = block.x + block.width / 2; const y = block.y + block.height / 2;
      return Math.abs(x - (0.5 + (slot - 1) * 0.2217)) <= 0.11 && (slot === 1 ? y >= 0.38 && y <= 0.56 : y >= 0.6 && y <= 0.8);
    });
    // Words and icons are both placed in the whole client here, as in the test above.
    const blocks = blocksForScreenParser(reply).map(block => block.bounds ? { ...block, ...block.bounds } : block)
      .filter(block => !onNameRow(block));
    const parsed = parseScreenOffers(blocks, catalog, { draftConfirmed: true, iconMatches: reply.icons ?? [], conservativeUnmarkedDetails: true });
    expect(parsed.offers.map(offer => offer.name)).toEqual(truth.cards);
    expect(parsed.offers.every(offer => offer.byIcon === true)).toBe(true);
  }, 90_000);
});
