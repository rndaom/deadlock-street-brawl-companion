import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import catalogJson from '../data/public-catalog.json';
import { blocksForScreenParser, normalizeNativeReply } from '../electron/screen-reader';
import { parseScreenOffers } from '../src/screen/offer-parser';
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
 * Real 2026-10-26 Street Brawl draft frames from the first Linux matches, cropped to the draft labels and the
 * three card names. Full-frame Tesseract dropped a clearly visible card name (Extra Charge), merged OCR noise
 * into the SELECT ITEMS title so the draft was not recognized, or lost the cards under the Tab scoreboard.
 */
describe.skipIf(!runnable)('native draft card reader on real frames', () => {
  it.each(cases)('$name reads all three cards', ({ file, truth }) => {
    const run = spawnSync(nativePath, ['--icons', resolve('assets/reader-icons'), '--context-icons', resolve('assets/context-icons'),
      '--review-image', file], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const line = run.stdout.split(/\r?\n/).find(Boolean);
    expect(line).toBeTruthy();
    const raw = JSON.parse(line!);
    const reply = normalizeNativeReply(raw, raw.crop);
    expect(reply.blocks.map(block => block.text)).toContain(`CHOICE ${truth.choice} OF 3`);
    // The live draft read covers the whole client; place the cropped fixture's words where that read would see them.
    const blocks = blocksForScreenParser(reply).map(block => block.bounds ? { ...block, ...block.bounds } : block);
    const parsed = parseScreenOffers(blocks, catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.isDraft).toBe(true);
    expect(parsed.offers.map(offer => offer.name)).toEqual(truth.cards);
    expect(parsed.offers.map(offer => offer.variant)).toEqual(truth.variants);
  }, 90_000);
});
