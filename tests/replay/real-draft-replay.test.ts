import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import publicCatalog from '../../data/public-catalog.json';
import { createScreenReader, type ScreenReaderProcess } from '../../electron/screen-reader';
import type { CaptureRegion, ScreenReaderState } from '../../src/shared/screen-reading';
import type { Catalog } from '../../src/shared/types';

/** OCR replies recorded from a real Street Brawl round-4 draft (frame 1 is mid-reveal). */
/** The captures are local evidence (gitignored); without them the suite is skipped, not failed. */
const hasCaptures = existsSync('optimization/captures/draft-review/frame-1.json') && existsSync('optimization/captures/live-review/frame-3.json');
const draftFrames = hasCaptures ? [1, 2, 3, 4].map(i => JSON.parse(readFileSync(`optimization/captures/draft-review/frame-${i}.json`, 'utf8')).raw) : [];
/** A real in-combat capture: HUD numbers only, no draft panel. */
const combatFrame = hasCaptures ? JSON.parse(readFileSync('optimization/captures/live-review/frame-3.json', 'utf8')).raw : { blocks: [] };
type Req = { id: string; op: string; crop: CaptureRegion };
type Block = { bounds: CaptureRegion };
function inside(bounds: CaptureRegion, crop: CaptureRegion) {
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  return cx >= crop.x && cx <= crop.x + crop.width && cy >= crop.y && cy <= crop.y + crop.height;
}

/** Serves recorded OCR for whatever crop the coordinator asks for, with a chosen native read time. */
class RecordedGame extends EventEmitter implements ScreenReaderProcess {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); exitCode: number | null = null;
  frame: { blocks: Block[] } = draftFrames[0]; elapsed = 150; foreground = true; requests = 0;
  kill = () => { this.exitCode = 1; this.emit('exit', 1); this.emit('close', 1); return true; };
  constructor() { super(); this.stdin.on('data', (d: Buffer) => this.handle(JSON.parse(d.toString().trim()))); }
  handle(r: Req) {
    this.requests++;
    const fixture = r.op === 'fixture';
    const elapsed = fixture ? 50 : r.op === 'probe' ? 5 : this.elapsed;
    const blocks = r.op === 'read' && this.foreground ? this.frame.blocks.filter(b => inside(b.bounds, r.crop)) : [];
    const status = fixture || this.foreground ? 'ok' : 'not_foreground';
    setTimeout(() => this.stdout.write(JSON.stringify({ protocol: 1, id: r.id, status, gamePresent: !fixture, foreground: !fixture && this.foreground,
      clientWidth: 1920, clientHeight: 1080, capturedAt: Date.now() - elapsed, elapsedMs: elapsed, hash: `h${Math.random()}`, blocks, crop: r.crop,
      ocrAvailable: true, ocrLanguage: 'en-US', synthetic: fixture, metrics: { cpuMs: elapsed / 3, workingSetMb: 100 } }) + '\n'), elapsed);
  }
}

let reader: ReturnType<typeof createScreenReader> | null = null;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(2_000_000); });
afterEach(async () => { await reader?.dispose(); reader = null; vi.useRealTimers(); });

function start(elapsed: number) {
  let game!: RecordedGame;
  const timeline: { at: number; state: ScreenReaderState }[] = [];
  reader = createScreenReader({ helperPath: 'recorded.exe', catalog: publicCatalog as unknown as Catalog, now: Date.now, monotonicNow: Date.now,
    spawnProcess: () => { game = new RecordedGame(); game.elapsed = elapsed; return game; },
    onState: state => timeline.push({ at: Date.now(), state }) });
  return { get game() { return game; }, timeline, run: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
}
const shown = (state: ScreenReaderState) => state.status === 'ready' && state.offers.length === 3;

describe.skipIf(!hasCaptures)('recorded Street Brawl draft replay', () => {
  it.each([60, 250, 500, 900])('shows the three real cards with a pick and keeps them stable at %ims native reads', async elapsed => {
    const run = start(elapsed);
    await run.run(2_000);
    run.game.frame = draftFrames[0]; await run.run(1_500); // reveal animation: third card not drawn yet
    for (let i = 0; i < 20; i++) { run.game.frame = draftFrames[1 + (i % 3)]; await run.run(1_000); }
    const state = reader!.getState();
    expect(state.offers.map(offer => offer.name)).toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
    expect(state.advice?.preferredPosition).not.toBeNull();
    const firstShown = run.timeline.findIndex(entry => shown(entry.state));
    expect(firstShown).toBeGreaterThan(-1);
    // Once shown, the cards never drop out while the draft stays open.
    expect(run.timeline.slice(firstShown).every(entry => shown(entry.state))).toBe(true);
    expect(state.metrics.timeouts).toBe(0);
  });

  it('keeps the cards while the companion has focus, then clears them once combat resumes', async () => {
    const run = start(300);
    await run.run(2_000);
    for (let i = 0; i < 6; i++) { run.game.frame = draftFrames[1 + (i % 3)]; await run.run(1_000); }
    expect(shown(reader!.getState())).toBe(true);
    run.game.foreground = false; await run.run(4_000);
    expect(shown(reader!.getState())).toBe(true);
    run.game.foreground = true; run.game.frame = combatFrame; await run.run(8_000);
    expect(reader!.getState().offers).toEqual([]);
    expect(reader!.getState().status).toBe('waiting-draft');
  });

  it('replaces the shown pick when the cards change', async () => {
    const run = start(250);
    await run.run(2_000);
    for (let i = 0; i < 4; i++) { run.game.frame = draftFrames[1 + (i % 3)]; await run.run(1_000); }
    const renamed = structuredClone(draftFrames[2]);
    for (const block of renamed.blocks) {
      if (block.text === 'Toxic Bullets') { block.text = 'Extra Health'; block.words = [{ text: 'Extra Health', bounds: block.bounds }]; }
    }
    run.game.frame = renamed; await run.run(4_000);
    expect(reader!.getState().offers.map(offer => offer.name)).toEqual(['Extra Health', 'Tesla Bullets', 'Spiritual Overflow']);
  });
});
