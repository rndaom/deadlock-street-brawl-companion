import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createScreenReader, DRAFT_FOOTER_REGION, DRAFT_HINT_REGION, MATCH_CONTEXT_REGION, normalizeNativeReply, SCREEN_READER_LIMITS,
  type ScreenReaderProcess, type ScreenReaderTrace,
} from '../electron/screen-reader';
import type { CaptureRegion } from '../src/shared/screen-reading';
import { testCatalog } from './fixtures';

interface Request { id: string; op: 'fixture' | 'probe' | 'read' | 'watch'; crop: CaptureRegion }
type Answer = Record<string, unknown>;
const same = (a: CaptureRegion, b: CaptureRegion) => JSON.stringify(a) === JSON.stringify(b);
function block(text: string, x: number, y: number, width: number, height: number) {
  const bounds = { x, y, width, height };
  return { text, bounds, words: [{ text, bounds }] };
}
/** The round title keeps the roster in a match; the watch runs only then. */
const round = block('ROUND 3', .45, .08, .1, .025);
/** A whole-window draft frame: the draft's own labels and three card names, in full-client coordinates. */
const draftFrame = [round, block('Select Items', .05, .2, .15, .03), block('CHOICE 1 OF 3', .05, .27, .12, .025),
  block('Fixture item a', .2, .5, .15, .03), block('Fixture item b', .42, .27, .15, .03), block('Fixture item c', .64, .5, .15, .03)];

class FakeHelper extends EventEmitter implements ScreenReaderProcess {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null;
  requests: (Request & { at: number })[] = [];
  kill = vi.fn(() => { this.finish(); return true; });
  constructor(private answer: (request: Request) => Answer) {
    super();
    this.stdin.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString().trim()) as Request;
      this.requests.push({ ...request, at: Date.now() });
      this.stdout.write(`${JSON.stringify({ protocol: 1, id: request.id, status: 'ok', gamePresent: request.op !== 'fixture', foreground: request.op !== 'fixture',
        clientWidth: 1920, clientHeight: 1080, capturedAt: Date.now(), elapsedMs: 10, hash: `frame-${Date.now()}`, blocks: [], crop: request.crop,
        ocrAvailable: true, ocrLanguage: 'eng', synthetic: request.op === 'fixture', metrics: { cpuMs: 2 }, ...this.answer(request) })}\n`);
    });
  }
  finish() { if (this.exitCode === null) { this.exitCode = 137; this.emit('exit', 137, 'SIGKILL'); this.emit('close', 137, 'SIGKILL'); } }
}

const readers: ReturnType<typeof createScreenReader>[] = [];
const helpers: FakeHelper[] = [];
/** A running coordinator over a fake helper; `screen` decides what each request sees. */
function start(screen: { draft: boolean; watches?: boolean; verdict?: boolean; labelWithoutDraft?: boolean; matchCue?: boolean }) {
  const traces: ScreenReaderTrace[] = [];
  const answer = (request: Request): Answer => {
    const matchCue = screen.matchCue ?? true;
    if (request.op === 'fixture') return screen.watches === false ? {} : { draftWatch: true };
    if (request.op === 'watch') return screen.verdict === false ? {} : { draftLabel: screen.draft || !!screen.labelWithoutDraft };
    if (request.op === 'probe') return {};
    // Only a whole-window read holds the cards; a cue strip shows the labels when the draft is open.
    if (same(request.crop, MATCH_CONTEXT_REGION)) return { blocks: screen.draft ? draftFrame : matchCue ? [round] : [] };
    if (same(request.crop, DRAFT_HINT_REGION)) return { blocks: screen.draft ? draftFrame.slice(0, 3) : matchCue ? [round] : [] };
    return { blocks: [] };
  };
  const reader = createScreenReader({ helperPath: '/synthetic-unit-test/ScreenReader', catalog: testCatalog, autoStart: true,
    now: Date.now, monotonicNow: Date.now, onTrace: entry => traces.push(entry),
    spawnProcess: () => { const helper = new FakeHelper(answer); helpers.push(helper); return helper; } });
  readers.push(reader);
  return { reader, traces, get helper() { return helpers.at(-1)!; } };
}
const ops = (helper: FakeHelper, op: Request['op']) => helper.requests.filter(request => request.op === op);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(async () => {
  for (const helper of helpers.splice(0)) helper.finish();
  await Promise.all(readers.splice(0).map(reader => reader.dispose()));
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('draft-label watch', () => {
  it('looks for the label between reads in a match, and a sighting reads the whole window at once', async () => {
    const screen = { draft: false };
    const work = start(screen);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(work.reader.getState().roster?.phase).toBe('match');
    const watches = ops(work.helper, 'watch');
    expect(watches.length).toBeGreaterThan(10);
    for (let index = 1; index < watches.length; index++) expect(watches[index]!.at - watches[index - 1]!.at).toBeGreaterThanOrEqual(SCREEN_READER_LIMITS.draftWatchMs);
    // The usual reads are unchanged: cue strips at most once a second.
    const reads = ops(work.helper, 'read');
    for (let index = 1; index < reads.length; index++) expect(reads[index]!.at - reads[index - 1]!.at).toBeGreaterThanOrEqual(SCREEN_READER_LIMITS.phaseSpacingMs);
    expect(work.reader.getState().status).toBe('waiting-draft');

    // Just after a cue read: before the watch, the draft waited for the next cue scan and the pause after it.
    const opened = reads.at(-1)!.at + 20;
    await vi.advanceTimersByTimeAsync(opened - Date.now());
    screen.draft = true;
    const readsBefore = ops(work.helper, 'read').length;
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.draftWatchMs + SCREEN_READER_LIMITS.draftReadSpacingMs);
    const next = ops(work.helper, 'read')[readsBefore]!;
    expect(next.crop).toEqual(MATCH_CONTEXT_REGION);
    expect(next.at - opened).toBeLessThanOrEqual(SCREEN_READER_LIMITS.draftWatchMs + SCREEN_READER_LIMITS.draftReadSpacingMs);
    expect(work.reader.getState()).toMatchObject({ status: 'ready' });
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
    expect(work.traces.some(trace => trace.op === 'watch' && trace.draftLabel === true)).toBe(true);
    expect(work.traces.some(trace => trace.op === 'read' && typeof trace.watchMs === 'number')).toBe(true);

    // No watching while the draft is open.
    const watchCount = ops(work.helper, 'watch').length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(work.reader.getState().status).toBe('ready');
    expect(ops(work.helper, 'watch')).toHaveLength(watchCount);
  });

  it('never asks a helper that did not offer the watch at warm-up', async () => {
    const work = start({ draft: false, watches: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(work.reader.getState().roster?.phase).toBe('match');
    expect(ops(work.helper, 'watch')).toHaveLength(0);
    expect(ops(work.helper, 'read').length).toBeGreaterThan(2);
  });

  it('does not watch before a match is seen', async () => {
    const work = start({ draft: false, matchCue: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ops(work.helper, 'read').length).toBeGreaterThan(2);
    expect(ops(work.helper, 'watch')).toHaveLength(0);
  });

  it('stops asking when the helper cannot watch here', async () => {
    const work = start({ draft: false, verdict: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ops(work.helper, 'watch')).toHaveLength(1);
    expect(work.reader.getState().status).toBe('waiting-draft');
  });

  it('rests after a sighting whose whole-window read finds no draft', async () => {
    const work = start({ draft: false, labelWithoutDraft: true });
    await vi.advanceTimersByTimeAsync(2_000);
    const firstFull = ops(work.helper, 'read').findIndex(request => same(request.crop, MATCH_CONTEXT_REGION));
    expect(firstFull).toBeGreaterThanOrEqual(0);
    const firedAt = ops(work.helper, 'read')[firstFull]!.at;
    // Within the rest no watch is sent, so no further whole-window read follows a sighting.
    const during = ops(work.helper, 'watch').filter(request => request.at > firedAt && request.at < firedAt + SCREEN_READER_LIMITS.draftWatchBackoffMs);
    await vi.advanceTimersByTimeAsync(firedAt + SCREEN_READER_LIMITS.draftWatchBackoffMs - Date.now() - 1);
    expect(ops(work.helper, 'watch').filter(request => request.at > firedAt && request.at < firedAt + SCREEN_READER_LIMITS.draftWatchBackoffMs)).toEqual(during);
    expect(during).toHaveLength(0);
    expect(work.traces.some(trace => trace.watchMiss === true)).toBe(true);
    expect(work.reader.getState().offers).toEqual([]);
    // The cue strips still alternate as before.
    expect(ops(work.helper, 'read').some(request => same(request.crop, DRAFT_FOOTER_REGION))).toBe(true);
  });

  it('accepts only boolean watch fields from the helper', () => {
    const raw = { protocol: 1, id: 'w', status: 'ok', gamePresent: true, foreground: true, clientWidth: 1920, clientHeight: 1080,
      capturedAt: 1, elapsedMs: 3, hash: null, blocks: [], crop: { x: .036, y: .264, width: .156, height: .037 } };
    expect(normalizeNativeReply({ ...raw, draftLabel: true })).toMatchObject({ draftLabel: true });
    expect(normalizeNativeReply({ ...raw, draftWatch: true })).toMatchObject({ draftWatch: true });
    expect(normalizeNativeReply(raw).draftLabel).toBeUndefined();
    expect(() => normalizeNativeReply({ ...raw, draftLabel: 'yes' })).toThrow(TypeError);
    expect(() => normalizeNativeReply({ ...raw, draftWatch: 1 })).toThrow(TypeError);
  });
});

const nativePath = resolve('native/ScreenReader/publish', process.platform === 'win32' ? 'ScreenReader.exe' : 'ScreenReader');
const runnable = (process.platform === 'win32' || process.platform === 'linux') && existsSync(nativePath);
describe.runIf(runnable)('native draft-label test on real draft frames', () => {
  it('finds the CHOICE label on every draft fixture, by pixels alone', () => {
    const directory = resolve('tests/fixtures/draft-cards');
    const files = readdirSync(directory).filter(name => name.endsWith('.png')).map(name => resolve(directory, name));
    const run = spawnSync(nativePath, ['--draft-watch', ...files], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const results = run.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { draftLabel?: boolean; share?: number; box?: string });
    expect(results).toHaveLength(files.length);
    for (const result of results) {
      expect(result.box).toBe('300x40');
      expect(result.draftLabel).toBe(true);
      expect(result.share).toBeGreaterThan(.12);
    }
  });
});
