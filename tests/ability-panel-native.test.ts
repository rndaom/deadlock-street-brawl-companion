import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativePath = resolve('native/ScreenReader/publish', process.platform === 'win32' ? 'ScreenReader.exe' : 'ScreenReader');
const runnable = (process.platform === 'win32' || process.platform === 'linux') && existsSync(nativePath);

interface Reply { context?: { abilityPoints?: { value: number | null } | null; brawl?: { abilityRanks?: (number | null)[] | null; roundPips?: number[] | null } } }

/** Sidecar-described crops of real frames (crop, client size, the value read by eye in `truth`). */
function fixtureCases<T>(folder: string) {
  const directory = resolve('tests/fixtures', folder);
  return readdirSync(directory).filter(name => name.endsWith('.png')).map(name => {
    const sidecar = JSON.parse(readFileSync(resolve(directory, name.replace(/\.png$/, '.json')), 'utf8')) as { truth: T; source: string };
    return { name, file: resolve(directory, name), truth: sidecar.truth, source: sidecar.source };
  });
}

/** Every reply the helper prints for one saved frame (it reads each frame four times, like a static screen). */
function review(file: string): Reply[] {
  const run = spawnSync(nativePath, ['--icons', resolve('assets/reader-icons'), '--context-icons', resolve('assets/context-icons'),
    '--review-image', file], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const replies = run.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Reply);
  expect(replies.length).toBeGreaterThan(0);
  return replies;
}

/**
 * Real 2026-10-11 Street Brawl frames, cropped to the ability upgrade panel. The released reader returned [1,1,1,1] and
 * [2,2,2,2] for the "HOLD TAB TO UPGRADE" banner fading in over the panel rows, and nothing for an all-open panel; the
 * tracker then kept those levels for the whole match. The two tooltip-covers-* frames are tab-0331 with a synthetic
 * tooltip body painted over the right-hand columns: a covered column reads null, a partly covered one still reads.
 */
describe.skipIf(!runnable)('native ability panel reader on real frames', () => {
  it.each(fixtureCases<(number | null)[] | null>('ability-panel'))('$name reads $truth', ({ file, truth }) => {
    for (const reply of review(file)) expect(reply.context?.brawl?.abilityRanks ?? null).toEqual(truth);
  }, 90_000);
});

/**
 * The round score pips under "ROUND N" on real 2026-10-18 frames (HUD, Tab and draft): [left, right] wins in screen
 * order, null when the title is not proven (main menu, the round-1 timer box over it) or a circle is ambiguous (a fade
 * of the strip, a white flash behind the centre circle).
 */
describe.skipIf(!runnable)('native round score pips on real frames', () => {
  it.each(fixtureCases<number[] | null>('round-pips'))('$name reads $truth', ({ file, truth }) => {
    for (const reply of review(file)) expect(reply.context?.brawl?.roundPips ?? null).toEqual(truth);
  }, 90_000);
});

/**
 * The teal AP counter at bottom centre on real 2026-10-18 frames (draft, Tab, HUD over a green world, partly crossed by
 * a white object) and on that counter with a synthetic teal amount painted in. "0" is read by its shape; other
 * amounts by digit OCR checked against the digits' shapes.
 */
describe.skipIf(!runnable)('native AP counter on real frames', () => {
  it.each(fixtureCases<number | null>('ap-counter'))('$name reads $truth', ({ file, truth }) => {
    const values = review(file).map(reply => reply.context?.abilityPoints?.value ?? null);
    // A non-zero amount comes from the follow-up digit OCR pass, so the first read of a frame may still lack it.
    if (truth === null || truth === 0) expect(values.every(value => value === truth)).toBe(true);
    else { expect(values.at(-1)).toBe(truth); expect(values.every(value => value === null || value === truth)).toBe(true); }
  }, 90_000);
});
