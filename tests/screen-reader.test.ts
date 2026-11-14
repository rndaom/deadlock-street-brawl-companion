import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { availableParallelism } from 'node:os';
import publicCatalog from '../data/public-catalog.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blocksForScreenParser, createScreenReader, draftCaptureRegion, DRAFT_FOOTER_REGION, DRAFT_HINT_REGION, HELPER_BLOCKED_MESSAGE, MATCH_CONTEXT_REGION, normalizeNativeReply,
  OCR_NOT_ENGLISH_MESSAGE, OUTSIDE_MESSAGE, SCREEN_READER_LIMITS,
  type ScreenReaderOptions, type ScreenReaderProcess,
} from '../electron/screen-reader';
import { DEFAULT_CAPTURE_REGION, SCREEN_CARD_BACKGROUND_HOLD_MS, type CaptureRegion, type NativeScreenContext } from '../src/shared/screen-reading';
import { testCatalog } from './fixtures';
import type { Catalog } from '../src/shared/types';

interface Request { id: string; op: 'fixture' | 'probe' | 'read'; crop: CaptureRegion; debugPreview?: boolean; context?: boolean }
type RawBlock = { text: string; bounds: CaptureRegion; words: { text: string; bounds: CaptureRegion }[] };
function block(text: string, x: number, y: number, width = 0.18, height = 0.035, crop: CaptureRegion = { ...DEFAULT_CAPTURE_REGION }): RawBlock {
  const bounds = { x: crop.x + x * crop.width, y: crop.y + y * crop.height, width: width * crop.width, height: height * crop.height };
  return { text, bounds, words: [{ text, bounds }] };
}
function cards(crop: CaptureRegion, extra: RawBlock[] = [], names = ['Fixture item a', 'Fixture item b', 'Fixture item c']) {
  return [block('Select Items', 0.08, 0.01, 0.24, 0.035, crop),
    ...names.map((name, index) => block(name, 0.1 + index * 0.3, index === 1 ? 0.37 : 0.43, 0.19, 0.035, crop)), ...extra];
}
function reply(request: Request, overrides: Record<string, unknown> = {}) {
  return { protocol: 1, id: request.id, status: 'ok', gamePresent: true, foreground: true,
    clientWidth: 1920, clientHeight: 1080, capturedAt: Date.now(), elapsedMs: 10, hash: 'fresh-image-hash',
    blocks: request.op === 'probe' ? [] : cards(request.crop), crop: request.crop,
    ocrAvailable: true, ocrLanguage: 'en-US', synthetic: request.op === 'fixture',
    metrics: { cpuMs: 3, workingSetMb: 64 }, ...overrides };
}
/** Declared native contract proof, not a claim that these test rectangles match the game. */
function ownNativeContext(heroId = 'hero-a', itemId = 'a'): NativeScreenContext {
  const hero = { x: .42, y: .86, width: .05, height: .07 };
  const inventory = { x: .2, y: .82, width: .18, height: .1 };
  return { sessionId: 'synthetic-window-a', panel: 'hud', viewMode: 'participant',
    heroes: [{ heroId, role: 'local', isLocal: true, confidence: .98, status: 'recognized', bounds: hero }],
    items: [{ itemId, slot: 0, role: 'local-inventory', confidence: .98, status: 'recognized', variant: 'unknown',
      quantity: null, bounds: { x: .21, y: .84, width: .04, height: .04 } }], abilities: [],
    regions: [{ kind: 'local-hero', bounds: hero, complete: true }, { kind: 'inventory', bounds: inventory, slotCount: 1, complete: true }] };
}
class FakeProcess extends EventEmitter implements ScreenReaderProcess {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null;
  requests: Request[] = [];
  autoExit = true;
  kill = vi.fn((_signal?: NodeJS.Signals) => { if (this.autoExit) this.finish(); return true; });
  onRequest: ((request: Request, process: FakeProcess) => void) | undefined;
  constructor() {
    super();
    this.stdin.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString().trim()) as Request;
      this.requests.push(request); this.onRequest?.(request, this);
    });
  }
  send(request: Request, overrides: Record<string, unknown> = {}) { this.stdout.write(`${JSON.stringify(reply(request, overrides))}\n`); }
  finish() { if (this.exitCode === null) { this.exitCode = 137; this.emit('exit', 137, 'SIGKILL'); this.emit('close', 137, 'SIGKILL'); } }
}
type Reader = ReturnType<typeof createScreenReader>;
type ReaderState = ReturnType<Reader['getState']>;
/** A named pick must point at a shown, recognized card; never at a withdrawn or unread one. */
function expectPickOnShownCard(state: ReaderState) {
  const pick = state.advice?.preferredPosition ?? null;
  expect(pick).not.toBeNull();
  expect(state.offers.find(offer => offer.position === pick)?.itemId).toBeTruthy();
}
/** Unread bonuses/modifiers are flagged on the pick instead of being certified as a plain base offer. */
function expectUnreadEffectsCaveat(state: ReaderState) {
  expect(state.advice?.caveat).toMatch(/not read/);
}
/** Narrow title/footer cue reads; their results decide whether an open draft has closed. */
const isTitleCrop = (crop: CaptureRegion) => [DRAFT_HINT_REGION, DRAFT_FOOTER_REGION].some(value => JSON.stringify(value) === JSON.stringify(crop));
const readers: Reader[] = [];
const processes: FakeProcess[] = [];
function fixture(options: Partial<ScreenReaderOptions> = {}) {
  const spawned: FakeProcess[] = [];
  let behavior: (request: Request, process: FakeProcess) => void = (request, process) => {
    if (request.op === 'fixture') process.send(request, { blocks: [], gamePresent: false, foreground: false });
    else if (request.op === 'probe') process.send(request);
    else if (JSON.stringify(request.crop) === JSON.stringify(DRAFT_HINT_REGION)) process.send(request, { blocks: [block('Select Items', 0.1, 0.15, 0.5, 0.1, request.crop)] });
    else process.send(request);
  };
  const spawnProcess = vi.fn((_path: string, _args: string[], _settings: unknown) => {
    const process = new FakeProcess(); process.onRequest = (request, child) => behavior(request, child);
    spawned.push(process); processes.push(process); return process;
  });
  const reader = createScreenReader({ helperPath: 'C:/synthetic-unit-test/ScreenReader.exe', catalog: testCatalog,
    autoStart: false, now: Date.now, monotonicNow: Date.now, spawnProcess, ...options });
  readers.push(reader);
  const step = async (delay = 500) => { await vi.advanceTimersByTimeAsync(delay); await reader.pollOnce(); };
  const warm = async () => { await reader.pollOnce(); await step(); await step(); };
  const ready = async () => { await warm(); await step(); await step(); expect(reader.getState().status).toBe('ready'); };
  return { reader, spawnProcess, spawned, step, warm, ready,
    behavior(callback: typeof behavior) { behavior = callback; },
    get process() { return spawned.at(-1)!; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(async () => {
  for (const process of processes.splice(0)) process.finish();
  await Promise.all(readers.splice(0).map(reader => reader.dispose()));
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('native boundary and crop coordinates', () => {
  it('converts native full-client coordinates exactly once and preserves word provenance', () => {
    const crop = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };
    const request: Request = { id: 'fixture', op: 'read', crop };
    const raw = reply(request, { blocks: [block('Actual item', 0.25, 0.4, 0.2, 0.03, crop)], previewPngBase64: 'iVBORw0KGgo=', unchanged: true });
    const result = normalizeNativeReply(raw, crop);
    for (const [key, expected] of Object.entries({ x: 0.25, y: 0.4, width: 0.2, height: 0.03 })) {
      expect(result.blocks[0]![key as keyof CaptureRegion]).toBeCloseTo(expected);
    }
    expect(result.blocks[0]!.bounds).toEqual((raw.blocks as RawBlock[])[0]!.bounds);
    expect(result.blocks[0]!.words).toEqual((raw.blocks as RawBlock[])[0]!.words);
    expect(result.previewPng).toBe('iVBORw0KGgo='); expect(result.metrics?.unchanged).toBe(true);
  });
  it('carries the game client position for the overlay, and tolerates older helpers without it', () => {
    const request: Request = { id: 'fixture', op: 'read', crop: { ...DEFAULT_CAPTURE_REGION } };
    expect(normalizeNativeReply(reply(request, { clientLeft: -1920, clientTop: 40 }))).toMatchObject({ clientLeft: -1920, clientTop: 40 });
    expect(normalizeNativeReply(reply(request))).toMatchObject({ clientLeft: null, clientTop: null });
    expect(() => normalizeNativeReply(reply(request, { clientLeft: 'left' }))).toThrow();
  });
  it('publishes where the game window is, and forgets it when the game closes', async () => {
    const work = fixture();
    work.behavior((request, process) => process.send(request, request.op === 'fixture' ? { blocks: [], gamePresent: false, foreground: false } : { clientLeft: 2560, clientTop: 0 }));
    await work.warm();
    expect(work.reader.getState().gameBounds).toEqual({ x: 2560, y: 0, width: 1920, height: 1080 });
    work.behavior((request, process) => process.send(request, { status: 'not_found', gamePresent: false, foreground: false, clientWidth: 0, clientHeight: 0, blocks: [] }));
    await work.step(1_000);
    expect(work.reader.getState().gameBounds).toBeNull();
  });
  it('accepts native omitted-null fields on normal unavailable-window replies', () => {
    const raw = reply({ id: 'fixture', op: 'probe', crop: { ...DRAFT_HINT_REGION } }, { status: 'not_found', gamePresent: false, foreground: false });
    delete (raw as Record<string, unknown>).capturedAt; delete (raw as Record<string, unknown>).hash;
    expect(normalizeNativeReply(raw)).toMatchObject({ capturedAt: null, hash: null, status: 'not_found' });
  });
  it('retains failed visible bonus candidates instead of pretending no bonus exists', () => {
    const request: Request = { id: 'fixture', op: 'read', crop: { ...DEFAULT_CAPTURE_REGION } };
    const result = normalizeNativeReply(reply(request, { icons: [{ itemId: '', confidence: 0, role: 'bonus', slot: 1, bounds: { x: 0.3, y: 0.4, width: 0.02, height: 0.02 } }] }));
    expect(result.icons).toEqual([{ itemId: '', confidence: 0, role: 'bonus', slot: 1, bounds: { x: 0.3, y: 0.4, width: 0.02, height: 0.02 } }]);
  });
  it('preserves bounded unknown/empty context records and omitted nullable next-tier prices', () => {
    const context = ownNativeContext();
    context.viewMode = 'unknown';
    context.items = [{ ...context.items[0]!, itemId: null, status: 'empty' }];
    context.abilities = [{ slot: 0, rank: null, unlocked: null, confidence: 0, bounds: context.heroes[0]!.bounds }];
    const result = normalizeNativeReply(reply({ id: 'test-context', op: 'read', crop: MATCH_CONTEXT_REGION }, { context }));
    expect(result.context).toMatchObject({ viewMode: 'unknown', items: [{ itemId: null, status: 'empty', quantity: null }],
      abilities: [{ rank: null, unlocked: null, nextUpgradeCost: null }] });
    expect(result.context!.items[0]!.bounds).toEqual(context.items[0]!.bounds);
  });
  it.each(['heroes', 'items', 'abilities', 'regions'])('rejects unbounded native context %s arrays', key => {
    const context = { ...ownNativeContext(), [key]: Array.from({ length: 257 }, () => ({})) };
    expect(() => normalizeNativeReply(reply({ id: 'test-context', op: 'read', crop: MATCH_CONTEXT_REGION }, { context }))).toThrow(TypeError);
  });
  it('splits a native line spanning multiple cards using its individual word bounds', () => {
    const crop = { ...DEFAULT_CAPTURE_REGION };
    const left = block('Fixture item a', 0.1, 0.4, 0.19, 0.035, crop);
    const right = block('Fixture item c', 0.7, 0.4, 0.19, 0.035, crop);
    const raw = reply({ id: 'fixture', op: 'read', crop }, { blocks: [{ text: 'Fixture item a Fixture item c',
      bounds: { x: left.bounds.x, y: left.bounds.y, width: right.bounds.x + right.bounds.width - left.bounds.x, height: left.bounds.height },
      words: [...left.words, ...right.words] }] });
    const result = blocksForScreenParser(normalizeNativeReply(raw, crop));
    expect(result.map(value => value.text)).toEqual(['Fixture item a', 'Fixture item c']);
    expect(result[0]!.x).toBeCloseTo(0.1); expect(result[1]!.x).toBeCloseTo(0.7);
  });
  it.each([
    { protocol: 2 }, { blocks: Array.from({ length: 257 }, () => ({})) }, { capturedAt: NaN },
    { clientWidth: -1 }, { foreground: 'yes' }, { previewPngBase64: 'not-a-png' },
  ])('rejects malformed or unbounded native replies: %j', fields => {
    expect(() => normalizeNativeReply(reply({ id: 'fixture', op: 'read', crop: { ...DEFAULT_CAPTURE_REGION } }, fields))).toThrow(TypeError);
  });
});

describe('bounded real-reader lifecycle', () => {
  it('reschedules an early monotonic timer wake without requiring a manual poll', async () => {
    let clockOffset = 0;
    const work = fixture({ autoStart: true, monotonicNow: () => Date.now() + clockOffset });
    await vi.advanceTimersByTimeAsync(0);
    expect(work.process.requests.map(request => request.op)).toEqual(['fixture']);
    // Native timers can wake just before a fractional performance.now deadline.
    clockOffset = -0.25;
    await vi.advanceTimersByTimeAsync(500);
    expect(work.process.requests).toHaveLength(1);
    clockOffset = 0;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(work.process.requests.some(request => request.op === 'probe')).toBe(true);
    expect(work.process.requests.filter(request => request.op === 'read').length).toBeGreaterThanOrEqual(3);
    expect(work.reader.getState().status).toBe('ready');
    expect(work.spawnProcess).toHaveBeenCalledOnce();
  });
  it('replaces a waiting scan with periodic context discovery when all narrow cues are unread', async () => {
    const starts: number[] = [];
    const work = fixture({ autoStart: true });
    work.behavior((request, process) => {
      if (request.op === 'read') starts.push(Date.now());
      const full = request.op === 'read' && JSON.stringify(request.crop) === JSON.stringify(MATCH_CONTEXT_REGION);
      process.send(request, { gamePresent: request.op !== 'fixture', foreground: request.op !== 'fixture',
        blocks: full ? [block('ROUND 3', .45, .08, .1, .025, request.crop)] : [],
        ...(full ? { context: ownNativeContext() } : {}) });
    });
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.contextDiscoverySpacingMs + 1_000);
    const reads = work.process.requests.filter(request => request.op === 'read');
    expect(reads.some(request => JSON.stringify(request.crop) === JSON.stringify(MATCH_CONTEXT_REGION))).toBe(true);
    expect(reads.filter(request => JSON.stringify(request.crop) === JSON.stringify(MATCH_CONTEXT_REGION))).toHaveLength(1);
    expect(work.reader.getState().matchContext.localHeroId).toBe('hero-a');
    expect(work.reader.getState().offers).toEqual([]);
    for (let index = 1; index < starts.length; index++) expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(SCREEN_READER_LIMITS.phaseSpacingMs);
    expect(work.spawnProcess).toHaveBeenCalledOnce();
  });
  it('warms the same context worker and forwards context assets without spawning another helper', async () => {
    const work = fixture({ iconDirectory: 'C:/test/items', contextIconDirectory: 'C:/test/portraits' });
    await work.reader.pollOnce();
    expect(work.spawnProcess).toHaveBeenCalledWith('C:/synthetic-unit-test/ScreenReader.exe',
      ['--icons', 'C:/test/items', '--context-icons', 'C:/test/portraits'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: expect.objectContaining({ DOTNET_GCgen0size: '0x1000000' }) });
    expect(work.process.requests[0]).toMatchObject({ op: 'fixture', context: true });
    expect(work.reader.getState().matchContext.localHeroId).toBeNull();
  });
  it('requests full scoreboard context only after a positive visible-panel cue', async () => {
    const work = fixture(); await work.reader.pollOnce(); await work.step();
    work.behavior((request, process) => process.send(request, { blocks: [], context: { sessionId: 'test-window', panel: 'scoreboard',
      viewMode: 'unknown', heroes: [], items: [], abilities: [], regions: [] } }));
    await work.step(); expect(work.process.requests.at(-1)).toMatchObject({ context: true, crop: DRAFT_HINT_REGION });
    // Tab was just pressed: the whole-window read follows at the draft pace.
    await work.step(500); expect(work.process.requests.at(-1)).toMatchObject({ context: true, crop: MATCH_CONTEXT_REGION });
    expect(work.spawnProcess).toHaveBeenCalledOnce();
  });
  it('does no work until requested with autoStart:false and passes only an explicit executable/argv', async () => {
    const work = fixture({ iconDirectory: 'C:/synthetic-unit-test/icons' });
    expect(work.spawnProcess).not.toHaveBeenCalled();
    await work.reader.pollOnce();
    expect(work.spawnProcess).toHaveBeenCalledWith('C:/synthetic-unit-test/ScreenReader.exe', ['--icons', 'C:/synthetic-unit-test/icons'],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: expect.objectContaining({ DOTNET_GCgen0size: '0x1000000' }) });
    expect(work.process.requests).toHaveLength(1); expect(work.process.requests[0]!.op).toBe('fixture');
    expect(work.reader.getState()).toMatchObject({ engineReady: true, gamePresent: false, offers: [], advice: null });
  });
  it('discards all warmup fixture names and does not fabricate game/hero evidence', async () => {
    const work = fixture();
    work.behavior((request, process) => process.send(request, { blocks: cards(request.crop), gamePresent: false, foreground: false }));
    await work.reader.pollOnce();
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, heroId: null, observedAt: null, engineReady: true, gamePresent: false });
  });
  it('rejects synthetic fixture output as a reply to an actual live capture', async () => {
    const work = fixture(); await work.reader.pollOnce();
    work.behavior((request, process) => process.send(request, { synthetic: true }));
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'unavailable', offers: [], advice: null });
    expect(work.process.kill).toHaveBeenCalledOnce();
  });
  it('limits waiting-phase scans to a small title crop and at most once per second', async () => {
    const work = fixture(); await work.reader.pollOnce(); await work.step();
    work.behavior((request, process) => process.send(request, { blocks: [] }));
    await work.step();
    expect(work.process.requests.at(-1)!.crop).toEqual(DRAFT_HINT_REGION);
    await work.step(500); expect(work.process.requests).toHaveLength(3);
    await work.step(500); expect(work.process.requests).toHaveLength(4);
    expect(work.process.requests[2]!.crop).toEqual(DRAFT_HINT_REGION);
    expect(work.process.requests[3]!.crop).toEqual(DRAFT_FOOTER_REGION);
  });
  it('uses one budgeted footer fallback when the heading is unread instead of scanning the whole combat scene', async () => {
    const work = fixture(); await work.reader.pollOnce(); await work.step();
    work.behavior((request, process) => process.send(request, { blocks: [] }));
    await work.step(); await work.step(1_000); await work.step(1_000);
    expect(work.process.requests.slice(2).map(request => request.crop)).toEqual([DRAFT_HINT_REGION, DRAFT_FOOTER_REGION, DRAFT_HINT_REGION]);
    expect(work.reader.getState().status).toBe('waiting-draft');
  });
  it('finds the actual lower re-roll button when the heading is absent, then reads the selected cards', async () => {
    const work = fixture(); await work.reader.pollOnce(); await work.step();
    work.behavior((request, process) => {
      if (JSON.stringify(request.crop) === JSON.stringify(DRAFT_HINT_REGION)) process.send(request, { blocks: [] });
      else if (JSON.stringify(request.crop) === JSON.stringify(DRAFT_FOOTER_REGION)) {
        const bounds = { x: 0.4627777777777778, y: 0.6531620553359684, width: 0.07444444444444448, height: 0.01976284584980237 };
        process.send(request, { blocks: [{ text: 'Use Re-Roll', bounds, words: [{ text: 'Use Re-Roll', bounds }] }] });
      } else process.send(request);
    });
    await work.step(); await work.step(1_000); await work.step(); await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', offers: expect.any(Array) });
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
    expectPickOnShownCard(work.reader.getState()); expectUnreadEffectsCaveat(work.reader.getState());
  });
  it('the actual Choice label is fully inside the heading strip and bottom controls are inside draft captures', () => {
    expect(DRAFT_HINT_REGION.y + DRAFT_HINT_REGION.height).toBeGreaterThan(0.26778656126482214 + 0.02371541501976282);
    const crop = draftCaptureRegion({ x: 0.1, y: 0.2, width: 0.8, height: 0.55 });
    expect(crop.y).toBeLessThanOrEqual(0.6531620553359684);
    expect(crop.y + crop.height).toBe(1);
  });
  it('runs the actual autoStart loop at at most one waiting scan per second without a manual poll', async () => {
    const starts: number[] = []; const kinds: string[] = [];
    const work = fixture({ autoStart: true });
    work.behavior((request, process) => {
      if (request.op === 'read') { starts.push(Date.now()); kinds.push(JSON.stringify(request.crop)); }
      process.send(request, { blocks: [], gamePresent: request.op !== 'fixture', foreground: request.op !== 'fixture' });
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts.length).toBeGreaterThan(2);
    expect(starts.slice(1).every((value, index) => value - starts[index]! >= 1_000)).toBe(true);
    expect(kinds.every(value => [JSON.stringify(DRAFT_HINT_REGION), JSON.stringify(DRAFT_FOOTER_REGION)].includes(value))).toBe(true);
    expect(work.reader.getState().status).toBe('waiting-draft');
  });
  it('never starts a queued frame backlog while one worker request is active', async () => {
    const work = fixture(); work.behavior(() => {});
    const first = work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(0);
    await Promise.all(Array.from({ length: 25 }, () => work.reader.pollOnce()));
    expect(work.process.requests).toHaveLength(1);
    work.process.send(work.process.requests[0]!, { gamePresent: false, foreground: false }); await first;
    expect(work.process.requests).toHaveLength(1);
  });
  it('cancels before native dispatch if Demo/off is selected synchronously', async () => {
    const work = fixture();
    const pending = work.reader.pollOnce(); const disable = work.reader.setEnabled(false);
    await pending; await disable;
    expect(work.spawnProcess).not.toHaveBeenCalled();
    expect(work.reader.getState()).toMatchObject({ enabled: false, status: 'paused', offers: [], advice: null });
  });
  it('does no native work at all when constructed disabled for Demo', async () => {
    const work = fixture({ enabled: false });
    await work.reader.pollOnce(); await work.reader.preview(); await work.reader.retry();
    expect(work.spawnProcess).not.toHaveBeenCalled();
  });
  it('defers preview until game foreground and coalesces repeated clicks into one pending capture', async () => {
    const work = fixture(); await work.reader.pollOnce();
    work.behavior((request, process) => process.send(request, { status: 'not_foreground', gamePresent: true, foreground: false, blocks: [] }));
    await work.step();
    await work.reader.preview(); await work.reader.preview();
    expect(work.process.requests.filter(request => request.debugPreview)).toHaveLength(0);
    work.behavior((request, process) => process.send(request, { blocks: [], previewPngBase64: request.debugPreview ? 'iVBORw0KGgo=' : undefined }));
    await work.step(1_000); await work.step();
    expect(work.process.requests.filter(request => request.debugPreview)).toHaveLength(1);
    expect(work.reader.getState().previewDataUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
  });
});

describe('fresh draft generations and readable uncertainty', () => {
  it('uses explicit draft text before HUD phase and reaches ready with actual partial build observations', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { context: ownNativeContext() }));
    await work.step(); await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', matchContext: { phase: 'draft', viewMode: 'participant',
      localHeroId: 'hero-a', localInventory: [expect.objectContaining({ itemId: 'a', variant: 'unknown' })], localInventoryCompleteness: 'partial' } });
    expectPickOnShownCard(work.reader.getState()); expectUnreadEffectsCaveat(work.reader.getState());
  });
  it('keeps a visible draft and its pick when a spectator verdict arrives, but drops the own build', async () => {
    // Only a player in the match is offered items. A false spectator verdict blanked a whole real match.
    const work = fixture(); await work.ready();
    const shown = work.reader.getState();
    work.behavior((request, process) => process.send(request, { context: { ...ownNativeContext(), viewMode: 'spectator' } }));
    await work.step();
    const state = work.reader.getState();
    expect(state.offers.map(offer => offer.name)).toEqual(shown.offers.map(offer => offer.name));
    expect(state.advice?.preferredPosition).not.toBeNull();
    expect(state).toMatchObject({ abilityAdvice: null, matchContext: { viewMode: 'spectator', localHeroId: null, localInventory: [] } });
  });
  it('withdraws cards when a spectator view shows no draft', async () => {
    const work = fixture(); await work.ready();
    work.behavior((request, process) => process.send(request, { blocks: [], context: { ...ownNativeContext(), viewMode: 'spectator' } }));
    for (let i = 0; i < 4; i++) await work.step(1_000);
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, abilityAdvice: null, matchContext: { viewMode: 'spectator' } });
  });
  it('expires original ownership without removing its historical observed build', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { context: ownNativeContext() }));
    await work.step(); const proof = work.reader.getState().matchContext.observations.viewMode!;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(work.reader.getState().matchContext).toMatchObject({ viewMode: 'unknown', localHeroId: 'hero-a', localInventory: [expect.objectContaining({ itemId: 'a' })] });
    expect(work.reader.getState().matchContext.observations.viewMode!.capturedAt).toBe(proof.capturedAt);
    expect(work.reader.getState().abilityAdvice).toBeNull();
  });
  it('keeps fresh price/AP upgrades independent of cards and downgrades at the capture-freshness limit with no further callback', async () => {
    const work = fixture({ catalog: publicCatalog as Catalog }); await work.warm();
    const context = ownNativeContext('hero_haze', 'upgrade_health');
    context.items = [];
    const region = { x: .35, y: .76, width: .32, height: .16 };
    context.abilities = [0, 1, 2, 3].map(slot => ({ slot: slot as 0 | 1 | 2 | 3, rank: 0, unlocked: true, nextUpgradeCost: 1,
      confidence: .98, bounds: { x: .36 + slot * .065, y: .79, width: .05, height: .04 } }));
    context.regions.push({ kind: 'abilities', bounds: region, complete: true, slotCount: 4 });
    const points = { x: .5, y: .93, width: .025, height: .02 };
    context.abilityPoints = { value: 3, confidence: .98, bounds: points };
    context.regions.push({ kind: 'ability-points', bounds: points, complete: true });
    const round = { x: .4765, y: .041, width: .046, height: .0124 };
    work.behavior((request, process) => process.send(request, { context, blocks: [{ text: 'ROUND 2', bounds: round,
      words: [{ text: 'ROUND 2', bounds: round }] }] }));
    await work.step();
    expect(work.reader.getState()).toMatchObject({ offers: [], abilityAdvice: { kind: 'upgrade', availablePoints: 3, cost: 1 } });
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.captureFreshnessMs - 1_000);
    expect(work.reader.getState().abilityAdvice?.kind).toBe('upgrade');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(work.reader.getState().abilityAdvice?.kind).toBe('plan');
  });
  it('shows the actual draft names on the first frame and keeps them when the observed reroll counter disappears', async () => {
    const work = fixture({ catalog: publicCatalog as Catalog }); await work.warm(); let frame = 0;
    // Public item/UI text and geometry from the real October 3 draft captures.
    // No player names, match identifier, image data or other personal HUD text.
    const sourceLine = (text: string, bounds: CaptureRegion): RawBlock => ({ text, bounds, words: [] });
    const observed = [
      sourceLine('SELECT ITEMS', { x: 0.03833333333333333, y: 0.18181818181818182, width: 0.24444444444444446, height: 0.05237154150197629 }),
      sourceLine('CHOICE 1 OF 3', { x: 0.04, y: 0.26778656126482214, width: 0.09777777777777777, height: 0.02371541501976282 }),
      sourceLine('Toxic Bullets', { x: 0.22111111111111112, y: 0.6768774703557312, width: 0.11444444444444443, height: 0.029644268774703608 }),
      sourceLine('Tesla Bullets', { x: 0.4438888888888889, y: 0.44762845849802374, width: 0.11166666666666669, height: 0.030632411067193666 }),
      sourceLine('Spiritual Ouerflow', { x: 0.6388888888888888, y: 0.6739130434782609, width: 0.16555555555555568, height: 0.03952569169960474 }),
      sourceLine('Use Re-Roll', { x: 0.4627777777777778, y: 0.6531620553359684, width: 0.07444444444444448, height: 0.01976284584980237 }),
    ];
    work.behavior((request, process) => {
      frame++;
      process.send(request, { crop: { x: 0, y: 0, width: 1, height: 1 }, elapsedMs: frame === 1 ? 101.84 : 105.66,
        blocks: [...observed, ...(frame === 1 ? [sourceLine('1 Re-Roll Remaining', { x: 0.46, y: 0.7134387351778656, width: 0.07944444444444448, height: 0.015810276679841917 })] : [])] });
    });
    await work.step();
    expect(work.reader.getState().status).toBe('ready');
    expect(work.reader.getState().offers.map(offer => offer.name)).toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
    const generation = work.reader.getState().generation; const observedAt = work.reader.getState().observedAt;
    await work.step();
    expect(frame).toBe(2);
    expect(work.reader.getState()).toMatchObject({ status: 'ready', generation });
    expect(work.reader.getState().observedAt).toBeGreaterThan(observedAt!);
    expect(work.reader.getState().offers.map(offer => offer.name)).toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
    expect(work.reader.getState().offers.every(offer => offer.variant === 'base' && offer.bonusIds === null)).toBe(true);
    expectPickOnShownCard(work.reader.getState()); expectUnreadEffectsCaveat(work.reader.getState());
  });
  it('never certifies a missing small bonus label as a card without a bonus', async () => {
    const work = fixture(); await work.ready();
    expect(work.reader.getState().offers.every(offer => offer.variant === 'base' && offer.bonusIds === null)).toBe(true);
    expectPickOnShownCard(work.reader.getState()); expectUnreadEffectsCaveat(work.reader.getState());
  });
  it('keeps confirmed main names visible when modifier details alternate between known and unread', async () => {
    const statuses: string[] = []; const work = fixture({ onState: value => statuses.push(value.status) }); await work.warm(); let frame = 0;
    work.behavior((request, process) => {
      frame++; process.send(request, { blocks: cards(request.crop, frame % 2 ? [block('Enhanced', 0.1, 0.32, 0.15, 0.035, request.crop)] : []) });
    });
    await work.step(); await work.step(); expect(work.reader.getState().status).toBe('ready'); statuses.length = 0;
    const generation = work.reader.getState().generation;
    for (let index = 0; index < 5; index++) {
      await work.step(); expect(work.reader.getState()).toMatchObject({ status: 'ready', generation });
      expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
      expectPickOnShownCard(work.reader.getState()); expectUnreadEffectsCaveat(work.reader.getState());
    }
    expect(statuses).not.toContain('reading');
  });
  it('reads completion below the selected card area and withdraws the displayed choices within the card hold', async () => {
    const work = fixture(); await work.ready();
    const lastReadable = work.reader.getState().observedAt!;
    // The title strip still shows the heading; only the full card capture sees the completion label.
    work.behavior((request, process) => process.send(request, { blocks: cards(request.crop, [{ text: 'Selections Complete',
      bounds: { x: 0.43, y: 0.955, width: 0.16, height: 0.025 }, words: [] }]) }));
    await work.step();
    expect(work.process.requests.at(-1)!.crop.y + work.process.requests.at(-1)!.crop.height).toBe(1);
    while (work.reader.getState().offers.length && Date.now() <= lastReadable + SCREEN_READER_LIMITS.cardHoldMs) {
      // A completion frame never confirms or refreshes the shown cards.
      expect(work.reader.getState().observedAt).toBe(lastReadable);
      await work.step();
    }
    expect(work.reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [], advice: null, observedAt: null });
    expect(Date.now()).toBeLessThanOrEqual(lastReadable + SCREEN_READER_LIMITS.cardHoldMs + 500);
    for (let index = 0; index < 6; index++) { await work.step(); expect(work.reader.getState()).toMatchObject({ offers: [], advice: null }); }
  });
  it('confirms the same canonical cards despite alternating exact and corrected OCR quality', async () => {
    const work = fixture(); await work.warm(); let frame = 0;
    work.behavior((request, process) => {
      frame++;
      process.send(request, { blocks: cards(request.crop, [], [frame % 2 ? 'Fixture item a' : 'Fixture ltem a', 'Fixture item b', 'Fixture item c']) });
    });
    await work.step(); await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', offers: expect.arrayContaining([expect.objectContaining({ itemId: 'a' })]) });
    expectPickOnShownCard(work.reader.getState());
    expect(work.reader.getState().offers[0]!.warning).toMatch(/OCR correction/);
    const generation = work.reader.getState().generation; await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', generation });
  });
  it('keeps card confirmation separate from optional hero/round/reroll labels becoming unread', async () => {
    const work = fixture(); await work.warm(); let frame = 0;
    work.behavior((request, process) => {
      frame++;
      process.send(request, { blocks: cards(request.crop, frame % 2 ? [
        block('Playing as Fixture Hero', 0.1, 0.72, 0.32, 0.035, request.crop),
        block('Round 1', 0.05, 0.82, 0.12, 0.035, request.crop),
        block('Re-Rolls: 2', 0.3, 0.82, 0.19, 0.035, request.crop),
      ] : []) });
    });
    await work.step(); await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', heroId: null, offers: expect.any(Array) });
    expect(work.reader.getState().offers).toHaveLength(3);
    await work.step(); expect(work.reader.getState()).toMatchObject({ status: 'ready', heroId: 'hero-a' });
  });
  it('shows the first readable capture and expires it after the card hold when no later worker output arrives', async () => {
    const work = fixture(); await work.warm(); await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', observedAt: Date.now() });
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.cardHoldMs - 1);
    expect(work.reader.getState().offers).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [], advice: null, observedAt: null });
    await vi.advanceTimersByTimeAsync(600_000); expect(work.reader.getState().status).toBe('waiting-draft');
  });
  it('never republishes expired cards and shows cards again only from a newer capture', async () => {
    const work = fixture(); await work.warm(); await work.step();
    const first = work.reader.getState().observedAt!;
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.cardHoldMs);
    expect(work.reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [], observedAt: null });
    const expiredGeneration = work.reader.getState().generation;
    // The next scan is the periodic full-frame discovery read; its own current cards may be shown.
    await work.reader.pollOnce();
    expect(work.process.requests.at(-1)!.crop).toEqual(MATCH_CONTEXT_REGION);
    expect(work.reader.getState()).toMatchObject({ status: 'ready', offers: expect.any(Array), observedAt: Date.now() });
    expect(work.reader.getState().observedAt).toBeGreaterThan(first);
    expect(work.reader.getState().generation).toBeGreaterThan(expiredGeneration);
  });
  it('keeps the shown cards when one card reads differently on single reads, and replaces it after two agreeing reads', async () => {
    // 2026-10-18: a hover tooltip over one card read as another item for one frame and flipped the pick.
    const work = fixture(); await work.warm(); let cardReads = 0; let steady = false;
    work.behavior((request, process) => {
      if (!isTitleCrop(request.crop)) cardReads++;
      const names = [steady || cardReads % 2 === 0 ? 'Fixture item d' : 'Fixture item a', 'Fixture item b', 'Fixture item c'];
      process.send(request, { blocks: cards(request.crop, [], names) });
    });
    await work.step();
    const first = work.reader.getState();
    expect(first.offers.map(offer => offer.name)).toEqual(['Fixture item a', 'Fixture item b', 'Fixture item c']);
    for (let index = 0; index < 8; index++) {
      await work.step();
      const state = work.reader.getState();
      expect(state.status).toBe('ready');
      expect(state.offers.map(offer => offer.name)).toEqual(['Fixture item a', 'Fixture item b', 'Fixture item c']);
      expect(state.generation).toBe(first.generation);
      expectPickOnShownCard(state);
    }
    steady = true;
    for (let index = 0; index < 4 && work.reader.getState().offers[0]!.itemId !== 'd'; index++) await work.step();
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['d', 'b', 'c']);
    expect(work.reader.getState().generation).toBeGreaterThan(first.generation);
    expectPickOnShownCard(work.reader.getState());
  });
  it('withdraws cards against real combat-frame structure after consecutive title misses and remains waiting for ten minutes', async () => {
    const work = fixture(); await work.warm(); await work.step();
    expect(work.reader.getState().status).toBe('ready');
    // Sanitized geometry from the October 3 foreground review. Empty full crop
    // and this exact ROUND 2 heading contain no draft cue or personal HUD text.
    const roundBounds = { x: 0.47652314814814817, y: 0.040992313067784766, width: 0.045886574074074093, height: 0.012309573724668066 };
    let titleMisses = 0;
    work.behavior((request, process) => {
      const title = isTitleCrop(request.crop);
      if (title) titleMisses++;
      process.send(request, { elapsedMs: title ? 43.45 : 180.52, blocks: title ? [{ text: 'ROUND 2', bounds: roundBounds, words: [
        { text: 'ROUND', bounds: { ...roundBounds, width: 0.03681597222222222 } },
        { text: '2', bounds: { ...roundBounds, x: 0.5160069444444445, width: 0.006402777777777778 } },
      ] }] : [] });
    });
    const lastReadable = work.reader.getState().observedAt!;
    while (work.reader.getState().offers.length && titleMisses < SCREEN_READER_LIMITS.draftCueMissesToClose) {
      await work.step();
      // One missed title read is not a closed draft.
      if (titleMisses < SCREEN_READER_LIMITS.draftCueMissesToClose) expect(work.reader.getState()).toMatchObject({ status: 'ready', observedAt: lastReadable });
    }
    expect(work.reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [], advice: null, observedAt: null });
    expect(titleMisses).toBe(SCREEN_READER_LIMITS.draftCueMissesToClose);
    expect(Date.now() - lastReadable).toBeLessThan(SCREEN_READER_LIMITS.cardHoldMs);
    for (let minute = 0; minute < 10; minute++) {
      await work.step(60_000); expect(work.reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [] });
    }
  });
  it('publishes increasing revisions so older IPC snapshots cannot replace later states', async () => {
    const revisions: number[] = [];
    const work = fixture({ onState: value => revisions.push(value.revision) });
    const first = work.reader.getState().revision; await work.ready();
    expect(revisions.every((value, index) => value > (index === 0 ? first : revisions[index - 1]!))).toBe(true);
  });
  it('shows cards on the first readable capture and preserves ready status during ordinary refreshes', async () => {
    const work = fixture(); await work.warm(); await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', offers: expect.arrayContaining([expect.objectContaining({ itemId: 'a' })]), heroId: null });
    expectPickOnShownCard(work.reader.getState());
    const generation = work.reader.getState().generation; const observedAt = work.reader.getState().observedAt!;
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', generation });
    expect(work.reader.getState().observedAt).toBeGreaterThan(observedAt);
  });
  it('uses the current title in a card capture to sustain two-per-second refreshes without title-only scans', async () => {
    const work = fixture(); await work.ready();
    await work.step(); await work.step();
    expect(work.process.requests.slice(3).every(request => [draftCaptureRegion({ ...DEFAULT_CAPTURE_REGION }), MATCH_CONTEXT_REGION]
      .some(crop => JSON.stringify(request.crop) === JSON.stringify(crop)))).toBe(true);
    expect(work.reader.getState().status).toBe('ready');
  });
  it('replaces an older preference once a second read confirms a changed card', async () => {
    const work = fixture(); await work.ready(); const previous = work.reader.getState().generation;
    work.behavior((request, process) => process.send(request, { blocks: cards(request.crop, [], ['Fixture item d', 'Fixture item b', 'Fixture item c']) }));
    await work.step();
    // One read is not enough: a tooltip over one card reads as another item for a frame.
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', observedAt: Date.now() });
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['d', 'b', 'c']);
    expect(work.reader.getState().generation).toBeGreaterThan(previous);
    expectPickOnShownCard(work.reader.getState());
    expect(work.reader.getState().advice!.title).not.toMatch(/Fixture item a/);
  });
  it('withdraws the old cards and pick at once when a changed card set is not yet readable', async () => {
    const work = fixture(); await work.ready(); const previous = work.reader.getState().generation;
    // Mid-reroll: the first card already shows a new name while two names overlap in each other column.
    work.behavior((request, process) => process.send(request, { blocks: cards(request.crop, [
      block('Fixture item e', 0.4, 0.45, 0.19, 0.035, request.crop), block('Fixture item a', 0.7, 0.51, 0.19, 0.035, request.crop),
    ], ['Fixture item d', 'Fixture item b', 'Fixture item c']) }));
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'reading', offers: [], advice: null, observedAt: null });
    expect(work.reader.getState().generation).toBeGreaterThan(previous);
    work.behavior((request, process) => process.send(request, { blocks: cards(request.crop, [], ['Fixture item d', 'Fixture item b', 'Fixture item c']) }));
    for (let index = 0; index < 4 && work.reader.getState().status !== 'ready'; index++) {
      await work.step(); expect(work.reader.getState().offers.map(offer => offer.itemId)).not.toContain('a');
    }
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['d', 'b', 'c']);
  });
  it('shows stable Enhanced cards with a pick flagged by an unread-effects caveat', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { blocks: cards(request.crop, [block('Enhanced', 0.1, 0.32, 0.15, 0.035, request.crop)]) }));
    await work.step(); await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', offers: expect.arrayContaining([expect.objectContaining({ variant: 'enhanced' })]) });
    expectPickOnShownCard(work.reader.getState()); expectUnreadEffectsCaveat(work.reader.getState());
    expect(work.reader.getState().advice!.limitations.join(' ')).toMatch(/enhanced effects are not fully read/);
  });
  it('shows a stable unread bonus as unknown instead of zero and flags the pick with a caveat', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { blocks: cards(request.crop, [block('Bonus!', 0.1, 0.32, 0.14, 0.035, request.crop)]) }));
    await work.step(); await work.step();
    expect(work.reader.getState().offers[0]!.bonusIds).toBeNull();
    expectPickOnShownCard(work.reader.getState()); expectUnreadEffectsCaveat(work.reader.getState());
  });
  it('withdraws cards once consecutive title reads confirm a closed draft with missing columns', async () => {
    const work = fixture(); await work.ready();
    const lastReadable = work.reader.getState().observedAt!;
    let titleMisses = 0;
    work.behavior((request, process) => {
      if (isTitleCrop(request.crop)) titleMisses++;
      process.send(request, { blocks: [block('Draft complete', 0.1, 0.3, 0.3, 0.04, request.crop)] });
    });
    while (work.reader.getState().offers.length && titleMisses < SCREEN_READER_LIMITS.draftCueMissesToClose) await work.step();
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, observedAt: null, status: 'waiting-draft' });
    expect(Date.now() - lastReadable).toBeLessThan(SCREEN_READER_LIMITS.cardHoldMs);
    for (let index = 0; index < 4; index++) { await work.step(); expect(work.reader.getState().offers).toEqual([]); }
  });
  it('expires visible advice at the card hold independently of the next capture or timer cadence', async () => {
    const work = fixture(); await work.ready();
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.cardHoldMs - 1);
    expect(work.reader.getState()).toMatchObject({ status: 'ready', offers: expect.any(Array) });
    await vi.advanceTimersByTimeAsync(1);
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, observedAt: null, status: 'waiting-draft' });
  });
  it('cannot extend already-visible advice when the system epoch clock moves backward', async () => {
    const work = fixture(); await work.ready();
    vi.setSystemTime(Date.now() - 60_000); await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.cardHoldMs);
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, observedAt: null });
  });
  it.each([-SCREEN_READER_LIMITS.captureFreshnessMs, 10])('rejects stale or future capture timestamps (offset %i)', async offset => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { capturedAt: Date.now() + offset }));
    await work.step(); await work.step();
    expect(work.reader.getState().advice).toBeNull(); expect(work.reader.getState().offers).toEqual([]);
  });
  it('a replayed capture timestamp can neither extend nor resurrect shown cards', async () => {
    const work = fixture(); await work.warm();
    const timestamp = Date.now();
    work.behavior((request, process) => process.send(request, { capturedAt: timestamp }));
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', observedAt: timestamp });
    while (Date.now() < timestamp + 2 * SCREEN_READER_LIMITS.cardHoldMs) {
      await work.step();
      const state = work.reader.getState();
      if (Date.now() < timestamp + SCREEN_READER_LIMITS.cardHoldMs) expect(state.observedAt).toBe(timestamp);
      else expect(state).toMatchObject({ offers: [], advice: null, observedAt: null });
    }
  });
  it('keeps shown cards through focus loss, including unchanged cached blocks, until the background card hold expires', async () => {
    const work = fixture(); await work.ready();
    const shown = work.reader.getState();
    work.behavior((request, process) => process.send(request, { status: 'not_foreground', foreground: false, unchanged: true }));
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', foreground: false, observedAt: shown.observedAt, offers: shown.offers, advice: shown.advice });
    await work.step(1_000);
    expect(work.process.requests.at(-1)!.op).toBe('probe');
    expect(work.reader.getState()).toMatchObject({ status: 'ready', offers: shown.offers });
    // Alt-tabbed to the companion (one monitor): the cards outlive the normal hold, since nothing can re-read them.
    await vi.advanceTimersByTimeAsync(shown.observedAt! + SCREEN_READER_LIMITS.cardHoldMs + 5_000 - Date.now());
    expect(work.reader.getState()).toMatchObject({ status: 'ready', offers: shown.offers, advice: shown.advice });
    await vi.advanceTimersByTimeAsync(shown.observedAt! + SCREEN_CARD_BACKGROUND_HOLD_MS - Date.now());
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, observedAt: null });
    // With nothing shown, focus loss reports the interruption.
    await work.step(1_000);
    expect(work.reader.getState()).toMatchObject({ status: 'interrupted', foreground: false, offers: [], advice: null });
  });
  it.each(['occluded', 'minimized', 'blank_capture', 'offscreen'])('keeps shown cards through a transient %s capture failure', async status => {
    const work = fixture(); await work.ready();
    const shown = work.reader.getState();
    work.behavior((request, process) => process.send(request, { status, blocks: [] }));
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', observedAt: shown.observedAt, offers: shown.offers });
    await vi.advanceTimersByTimeAsync(shown.observedAt! + SCREEN_READER_LIMITS.cardHoldMs - Date.now());
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, observedAt: null });
  });
  it('withdraws shown cards and stops when Windows OCR becomes unavailable', async () => {
    const work = fixture(); await work.ready();
    work.behavior((request, process) => process.send(request, { status: 'ocr_unavailable', blocks: [] }));
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'unavailable', offers: [], advice: null, observedAt: null });
    const count = work.process.requests.length; await work.step(5_000);
    expect(work.process.requests).toHaveLength(count);
  });
  it('counts a native unchanged frame only after actual fresh capture proof', async () => {
    const work = fixture(); await work.ready();
    work.behavior((request, process) => process.send(request, { status: 'unchanged', unchanged: true }));
    await work.step();
    expect(work.reader.getState()).toMatchObject({ status: 'ready', observedAt: Date.now(), metrics: { skipped: 1 } });
  });
  it('fences pending results when the calibrated crop changes', async () => {
    const work = fixture(); await work.warm(); work.behavior(() => {});
    await vi.advanceTimersByTimeAsync(500); const read = work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(0);
    const old = work.process.requests.at(-1)!;
    await work.reader.setCrop({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    work.process.send(old); await read;
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } });
  });
});

describe('actual cancellation, timeout and workload barriers', () => {
  it('hands a positive slow title scan to the full cards instead of starving on the duty cooldown', async () => {
    const work = fixture(); await work.reader.pollOnce(); await work.step();
    work.behavior((request, process) => {
      if (JSON.stringify(request.crop) === JSON.stringify(DRAFT_HINT_REGION)) {
        setTimeout(() => process.send(request, { elapsedMs: 210, blocks: [block('Select Items', 0.1, 0.15, 0.5, 0.1, request.crop)] }), 210);
      } else process.send(request, { elapsedMs: 180.52 });
    });
    await vi.advanceTimersByTimeAsync(500); const hint = work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(210); await hint;
    // A 210 ms read may occupy at most the draft's duty share of wall time before the next request.
    const cooldown = Math.ceil(210 / SCREEN_READER_LIMITS.draftWorkerWallShare) - 210;
    const count = work.process.requests.length;
    await work.step(cooldown - 1); expect(work.process.requests).toHaveLength(count);
    await work.step(1);
    expect(work.process.requests).toHaveLength(count + 1);
    expect(work.process.requests.at(-1)!.crop).toEqual(MATCH_CONTEXT_REGION);
    expect(work.reader.getState().status).toBe('ready');
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
  });
  it('terminates a timed-out native job and awaits real exit before starting another helper', async () => {
    const work = fixture(); work.behavior(() => {});
    const read = work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(0);
    work.process.autoExit = false;
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.startupTimeoutMs);
    expect(work.process.kill).toHaveBeenCalledWith('SIGKILL');
    await work.reader.pollOnce(); expect(work.spawnProcess).toHaveBeenCalledOnce();
    work.process.finish(); await read;
    expect(work.reader.getState().metrics.timeouts).toBe(1);
  });
  it('stays closed while the OS process cannot be confirmed stopped, then restarts once it exits', async () => {
    const work = fixture(); work.behavior(() => {});
    const read = work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(0); work.process.autoExit = false;
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.startupTimeoutMs + SCREEN_READER_LIMITS.stopTimeoutMs);
    await read; await work.reader.retry(); await work.reader.pollOnce();
    expect(work.reader.getState()).toMatchObject({ status: 'unavailable', offers: [], advice: null });
    expect(work.spawnProcess).toHaveBeenCalledOnce();
    // The late exit proves nothing is left running; the reader starts a fresh helper by itself.
    work.process.finish(); await vi.advanceTimersByTimeAsync(10); void work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(10);
    expect(work.spawnProcess).toHaveBeenCalledTimes(2);
    expect(work.reader.getState().status).not.toBe('unavailable');
  });
  it('rejects over-budget results even if the elapsed timer callback has not run yet', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { elapsedMs: SCREEN_READER_LIMITS.readTimeoutMs }));
    await work.step(); expect(work.reader.getState().metrics.timeouts).toBe(1);
    expect(work.reader.getState()).toMatchObject({ advice: null, offers: [], engineReady: false });
    expect(work.process.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('uses the read timeout for warm reads and never lets late output resurrect cards', async () => {
    const work = fixture(); await work.warm(); work.behavior(() => {});
    await vi.advanceTimersByTimeAsync(500); const read = work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(0);
    const old = work.process.requests.at(-1)!;
    // A slow read on a throttled core is still inside the deadline.
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.readTimeoutMs - 1);
    expect(work.process.kill).not.toHaveBeenCalled(); expect(work.reader.getState().metrics.timeouts).toBe(0);
    await vi.advanceTimersByTimeAsync(1); await read;
    expect(work.process.kill).toHaveBeenCalledWith('SIGKILL');
    work.process.send(old);
    expect(work.reader.getState()).toMatchObject({ offers: [], advice: null, engineReady: false, metrics: { timeouts: 1 } });
  });
  it('restarts the helper after a single slow read but keeps the shown cards and match context', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { context: ownNativeContext() }));
    await work.step(); await work.step();
    const shown = work.reader.getState();
    expect(shown).toMatchObject({ status: 'ready', matchContext: { localHeroId: 'hero-a' } });
    work.behavior(() => {});
    await vi.advanceTimersByTimeAsync(500); const read = work.reader.pollOnce();
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.readTimeoutMs); await read;
    expect(work.reader.getState()).toMatchObject({ status: 'ready', engineReady: false, offers: shown.offers, observedAt: shown.observedAt,
      metrics: { timeouts: 1 }, matchContext: { localHeroId: 'hero-a' } });
    expect(work.process.kill).toHaveBeenCalledWith('SIGKILL');
    // The restarted helper resumes reading without an explicit retry.
    work.behavior((request, process) => process.send(request, request.op === 'fixture' ? { blocks: [], gamePresent: false, foreground: false } : { context: ownNativeContext() }));
    const spawns = work.spawnProcess.mock.calls.length;
    const recovered = () => (work.reader.getState().observedAt ?? 0) > shown.observedAt!;
    for (let index = 0; index < 15 && !recovered(); index++) await work.step(1_000);
    expect(recovered()).toBe(true);
    expect(work.spawnProcess).toHaveBeenCalledTimes(spawns + 1);
    expect(work.reader.getState()).toMatchObject({ status: 'ready', engineReady: true, offers: shown.offers, matchContext: { localHeroId: 'hero-a' } });
  });
  it.each(['retry', 'pause and resume'] as const)('pauses after consecutive timeouts reach the limit until explicit %s', async recovery => {
    const work = fixture(); await work.warm();
    // From here the helper never answers: reads, restart warmups and probes all time out.
    work.behavior(() => {});
    for (let attempt = 0; attempt < SCREEN_READER_LIMITS.maxTimeoutsBeforeRetry; attempt++) {
      expect(work.reader.getState().status).not.toBe('paused');
      await vi.advanceTimersByTimeAsync(2 * SCREEN_READER_LIMITS.startupTimeoutMs + 1_000);
      const read = work.reader.pollOnce();
      await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.startupTimeoutMs); await read;
      expect(work.reader.getState().metrics.timeouts).toBe(attempt + 1);
    }
    expect(work.reader.getState()).toMatchObject({ status: 'paused', offers: [], advice: null });
    const spawns = work.spawnProcess.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000); await work.reader.pollOnce();
    expect(work.spawnProcess).toHaveBeenCalledTimes(spawns);
    work.behavior((request, process) => process.send(request, { blocks: [], gamePresent: request.op === 'probe', foreground: request.op === 'probe' }));
    if (recovery === 'retry') await work.reader.retry();
    else { await work.reader.setEnabled(false); await work.reader.setEnabled(true); }
    await work.reader.pollOnce(); expect(work.spawnProcess).toHaveBeenCalledTimes(spawns + 1);
    expect(work.reader.getState().engineReady).toBe(true);
  });
  it('applies measured elapsed-wall cooldown rather than claiming CPU budget compliance', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { elapsedMs: 300, metrics: { cpuMs: 2, workingSetMb: 80 } }));
    await work.step(); const count = work.process.requests.length;
    // The fixture's draft is on screen: 300 ms of native work allows the next request only after it is
    // the draft's duty share of the elapsed wall time.
    const cooldown = Math.ceil(300 * (1 / SCREEN_READER_LIMITS.draftWorkerWallShare - 1));
    expect(cooldown).toBeGreaterThan(SCREEN_READER_LIMITS.draftReadSpacingMs);
    await work.step(SCREEN_READER_LIMITS.draftReadSpacingMs); expect(work.process.requests).toHaveLength(count);
    await work.step(cooldown - SCREEN_READER_LIMITS.draftReadSpacingMs); expect(work.process.requests).toHaveLength(count + 1);
    expect(work.reader.getState().metrics.memoryMb).toBe(80);
  });
  it('reports measured CPU as a fraction of machine capacity and leaves missing metrics unknown', async () => {
    const work = fixture(); work.behavior((request, process) => process.send(request, { blocks: [], metrics: { cpuMs: 5, workingSetMb: 75 } }));
    await work.reader.pollOnce();
    expect(work.reader.getState().metrics.cpuPercent).toBe(Math.round(10 * 50 / availableParallelism()) / 10);
    expect(work.reader.getState().metrics.memoryMb).toBe(75);
    const unavailable = fixture(); unavailable.behavior((request, process) => process.send(request, { blocks: [], metrics: undefined }));
    await unavailable.reader.pollOnce(); expect(unavailable.reader.getState().metrics).toMatchObject({ cpuPercent: null, memoryMb: null });
  });
  it('holds a workload-pressure pause without more native work until cleared', async () => {
    const work = fixture(); await work.ready(); await work.reader.setWorkloadPressure(true);
    const count = work.process.requests.length; await work.step(1_000);
    expect(work.process.requests).toHaveLength(count); expect(work.reader.getState().status).toBe('paused');
    await work.reader.setWorkloadPressure(false); await work.reader.pollOnce();
    expect(work.process.requests.length).toBeGreaterThan(count);
  });
  it('does not clear an active controller workload-pressure signal through user retry or pause and resume', async () => {
    const work = fixture(); await work.ready(); await work.reader.setWorkloadPressure(true);
    await work.reader.retry(); await work.reader.setEnabled(false); await work.reader.setEnabled(true);
    const spawns = work.spawnProcess.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); await work.reader.pollOnce();
    expect(work.spawnProcess).toHaveBeenCalledTimes(spawns);
    expect(work.reader.getState()).toMatchObject({ enabled: true, status: 'paused' });
    await work.reader.setWorkloadPressure(false); await work.reader.pollOnce();
    expect(work.spawnProcess).toHaveBeenCalledTimes(spawns + 1);
  });
  it('awaits the previous worker exit when a user resumes while pause is still stopping it', async () => {
    const work = fixture(); await work.ready();
    const old = work.process; old.autoExit = false;
    const pause = work.reader.setEnabled(false); await vi.advanceTimersByTimeAsync(0);
    const resume = work.reader.setEnabled(true); await vi.advanceTimersByTimeAsync(0);
    expect(work.spawnProcess).toHaveBeenCalledOnce();
    old.finish(); await pause; await resume; await vi.advanceTimersByTimeAsync(0);
    expect(work.spawnProcess).toHaveBeenCalledTimes(2);
    expect(work.reader.getState()).toMatchObject({ enabled: true, engineReady: true });
    expect(work.process).not.toBe(old);
  });
  it('awaits termination on dispose and cannot restart or accept delayed output afterward', async () => {
    const work = fixture(); work.behavior(() => {});
    const read = work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(0); const old = work.process.requests[0]!;
    work.process.autoExit = false; const disposal = work.reader.dispose(); await vi.advanceTimersByTimeAsync(0);
    let complete = false; void disposal.then(() => { complete = true; }); await vi.advanceTimersByTimeAsync(0);
    expect(complete).toBe(false); work.process.finish(); await disposal; await read;
    work.process.send(old); await work.reader.setEnabled(true); await work.reader.pollOnce();
    expect(work.spawnProcess).toHaveBeenCalledOnce(); expect(work.reader.getState()).toMatchObject({ enabled: false, offers: [], advice: null });
  });
  it('bounds text output and never records the raw native payload', async () => {
    const log = vi.spyOn(console, 'log'); const error = vi.spyOn(console, 'error');
    const work = fixture(); work.behavior((_request, process) => process.stdout.write('x'.repeat(SCREEN_READER_LIMITS.textBufferBytes + 1)));
    await work.reader.pollOnce();
    expect(work.reader.getState().status).toBe('unavailable'); expect(work.process.kill).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); log.mockRestore(); error.mockRestore();
  });
  it('asks for English text recognition when the OCR engine reads another language', async () => {
    const work = fixture();
    work.behavior((request, process) => process.send(request, { blocks: [], gamePresent: false, foreground: false, ocrLanguage: 'de-DE' }));
    await work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(10);
    expect(work.reader.getState()).toMatchObject({ status: 'unavailable', message: OCR_NOT_ENGLISH_MESSAGE, engineReady: false });
    await work.reader.pollOnce(); expect(work.spawnProcess).toHaveBeenCalledOnce();
  });
  it('says the helper is missing or blocked when the OS cannot start it, instead of offering a plain restart', async () => {
    const work = fixture(); work.behavior(() => {});
    const read = work.reader.pollOnce(); await vi.advanceTimersByTimeAsync(0);
    const failure = Object.assign(new Error('spawn ScreenReader.exe ENOENT'), { code: 'ENOENT', syscall: 'spawn ScreenReader.exe' });
    work.process.exitCode = -4058; work.process.emit('error', failure); work.process.emit('close', -4058, null);
    await read;
    expect(work.reader.getState()).toMatchObject({ status: 'unavailable', message: HELPER_BLOCKED_MESSAGE });
  });
  it('reports a helper that cannot even be spawned', async () => {
    const work = fixture({ spawnProcess: () => { throw Object.assign(new Error('blocked'), { code: 'UNKNOWN' }); } });
    await work.reader.pollOnce();
    expect(work.reader.getState()).toMatchObject({ status: 'unavailable', message: HELPER_BLOCKED_MESSAGE });
  });
  it('handles a broken helper input pipe without an uncaught EPIPE or process reuse', async () => {
    const work = fixture(); work.behavior((_request, process) => process.stdin.emit('error', new Error('synthetic-EPIPE')));
    await work.reader.pollOnce();
    expect(work.reader.getState()).toMatchObject({ status: 'unavailable', offers: [], advice: null });
    expect(work.process.kill).toHaveBeenCalledOnce();
  });
});

describe('Street Brawl Tab scoreboard', () => {
  it('follows a KILLS label in the title strip with a whole-window read so enemy item rows are captured', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => {
      if (request.op === 'fixture') process.send(request, { blocks: [], gamePresent: false, foreground: false });
      else if (request.op === 'probe') process.send(request);
      // Holding Tab: only the scoreboard header is in the top strip; no draft is open.
      else process.send(request, { blocks: [{ text: 'KILLS', bounds: { x: 0.49, y: 0.155, width: 0.02, height: 0.01 }, words: [{ text: 'KILLS', bounds: { x: 0.49, y: 0.155, width: 0.02, height: 0.01 } }] }] });
    });
    for (let step = 0; step < 6; step++) await work.step(600);
    const reads = work.process.requests.filter(request => request.op === 'read');
    const tabRead = reads.findIndex(request => JSON.stringify(request.crop) === JSON.stringify(DRAFT_HINT_REGION));
    expect(tabRead).toBeGreaterThan(-1);
    expect(reads.slice(tabRead + 1).some(request => JSON.stringify(request.crop) === JSON.stringify(MATCH_CONTEXT_REGION))).toBe(true);
  });
  it('reads the scoreboard at the draft pace when Tab is first seen, before a short hold ends (2026-11-01 matches)', async () => {
    // In a match (the round title is on screen) and not dead.
    const work = fixture(); await work.warm();
    const sent: { crop: string; at: number; tab: boolean }[] = []; let tab = false;
    const kills = { text: 'KILLS', bounds: { x: 0.49, y: 0.155, width: 0.02, height: 0.01 }, words: [{ text: 'KILLS', bounds: { x: 0.49, y: 0.155, width: 0.02, height: 0.01 } }] };
    work.behavior((request, process) => {
      if (request.op === 'fixture') process.send(request, { blocks: [], gamePresent: false, foreground: false });
      else if (request.op === 'probe') process.send(request);
      else { sent.push({ crop: JSON.stringify(request.crop), at: Date.now(), tab }); process.send(request, { blocks: [block('ROUND 3', .45, .08, .1, .025, request.crop), ...(tab ? [kills] : [])] }); }
    });
    for (let step = 0; step < 40; step++) await work.step(50);
    tab = true;
    for (let step = 0; step < 80; step++) await work.step(50);
    const cue = sent.findIndex(entry => entry.tab);
    const full = sent.findIndex((entry, index) => index > cue && entry.crop === JSON.stringify(MATCH_CONTEXT_REGION));
    expect(cue).toBeGreaterThan(-1);
    expect(sent[cue]!.crop).toBe(JSON.stringify(DRAFT_HINT_REGION));
    expect(full).toBeGreaterThan(cue);
    expect(sent[full]!.at - sent[cue]!.at).toBeLessThanOrEqual(500);
    // While Tab stays held, later scoreboard reads keep the usual spacing.
    const later = sent.slice(full + 1).filter(entry => entry.crop === JSON.stringify(MATCH_CONTEXT_REGION));
    expect(later.length).toBeGreaterThan(0);
    for (const [index, entry] of later.entries()) expect(entry.at - (index ? later[index - 1]! : sent[full]!).at).toBeGreaterThanOrEqual(1_000);
  });
});

/** A word at real 1920x1080 draft geometry (client coordinates, the native reader's frame). */
function clientBlock(text: string, centerX: number, centerY: number, width = 0.12, height = 0.03): RawBlock {
  const bounds = { x: centerX - width / 2, y: centerY - height / 2, width, height };
  return { text, bounds, words: [{ text, bounds }] };
}
/** Card name centres of the real panel: 0.5 and 0.5 +- 0.2217 across, about 0.69 (outer) and 0.46 (raised middle) down. */
const SLOT_CENTERS: readonly [number, number][] = [[0.2783, 0.69], [0.5, 0.46], [0.7217, 0.69]];
function liveDraft(crop: CaptureRegion, names: (string | null)[], stage: number | null = null) {
  return [block('Select Items', 0.08, 0.01, 0.24, 0.035, crop), ...(stage === null ? [] : [clientBlock(`CHOICE ${stage} OF 3`, 0.5, 0.17, 0.1, 0.022)]),
    ...names.flatMap((name, slot) => name === null ? [] : [clientBlock(name, SLOT_CENTERS[slot]![0], SLOT_CENTERS[slot]![1])])];
}

describe('2026-10-18 live match reads', () => {
  it('shows cards as they deal in, one or two at a time, and names a pick only once two are readable', async () => {
    const work = fixture(); await work.warm(); let names: (string | null)[] = ['Fixture item a', null, null];
    work.behavior((request, process) => process.send(request, { blocks: liveDraft(request.crop, names) }));
    await work.step(); await work.step();
    let state = work.reader.getState();
    expect(state.status).toBe('ready');
    expect(state.offers.map(offer => offer.itemId)).toEqual(['a', '', '']);
    expect(state.advice?.preferredPosition ?? null).toBeNull();
    const generation = state.generation;
    names = ['Fixture item a', 'Fixture item b', 'Fixture item c'];
    await work.step(); await work.step();
    state = work.reader.getState();
    expect(state.offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
    // Filling the unread places is the same set: no new generation, and the pick is on a shown card.
    expect(state.generation).toBe(generation);
    expectPickOnShownCard(state);
  });
  it('credits the picked card that lingers as the next choice opens, and never shows it as a new card', async () => {
    const work = fixture(); await work.warm(); let names: (string | null)[] = ['Fixture item a', 'Fixture item b', 'Fixture item c']; let stage = 1;
    work.behavior((request, process) => process.send(request, { blocks: liveDraft(request.crop, names, stage) }));
    await work.step(); await work.step();
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
    expect(work.reader.getState().build?.myItems ?? []).not.toContain('b');
    // Choice 2 deals in: the picked "b" still shows in its place while a new card already shows on the left.
    stage = 2; names = ['Fixture item d', 'Fixture item b', null];
    await work.step();
    // One read of it is not enough to credit it (an unpicked card can be misplaced for a frame).
    expect(work.reader.getState().build?.myItems ?? []).not.toContain('b');
    expect(work.reader.getState().offers.map(offer => offer.itemId)).not.toContain('b');
    await work.step();
    expect(work.reader.getState().build?.myItems).toContain('b');
    expect(work.reader.getState().offers.map(offer => offer.itemId)).not.toContain('b');
    expect(work.reader.getState().offers.map(offer => offer.itemId)).not.toContain('a');
    names = ['Fixture item d', 'Fixture item e', 'Fixture item c'];
    await work.step(); await work.step();
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['d', 'e', 'c']);
    expect(work.reader.getState().build?.myItems).toContain('b');
  });
  it('hides the picked card fading in its place even when all three names read as the next choice opens (review repro)', async () => {
    const work = fixture(); await work.warm(); let names: (string | null)[] = ['Fixture item a', 'Fixture item b', 'Fixture item c']; let stage = 1;
    work.behavior((request, process) => process.send(request, { blocks: liveDraft(request.crop, names, stage) }));
    await work.step(); await work.step();
    stage = 2; names = ['Fixture item d', 'Fixture item b', 'Fixture item e'];
    await work.step();
    let state = work.reader.getState();
    expect(state.offers.map(offer => offer.itemId)).not.toContain('b');
    expect(state.offers.find(offer => offer.position === state.advice?.preferredPosition)?.itemId ?? null).not.toBe('b');
    await work.step();
    expect(work.reader.getState().build?.myItems).toContain('b');
    // The new card dealt into that place shows as usual.
    names = ['Fixture item d', 'Fixture item c', 'Fixture item e'];
    await work.step(); await work.step();
    state = work.reader.getState();
    expect(state.offers.map(offer => offer.itemId)).toEqual(['d', 'c', 'e']);
    expectPickOnShownCard(state);
  });
  it('never credits an unpicked card of the last choice read in another place (review repro)', async () => {
    const work = fixture(); await work.warm(); let names: (string | null)[] = ['Fixture item a', 'Fixture item b', 'Fixture item c']; let stage = 1;
    work.behavior((request, process) => process.send(request, { blocks: liveDraft(request.crop, names, stage) }));
    await work.step(); await work.step();
    stage = 2; names = ['Fixture item c', null, null];
    for (let index = 0; index < 4; index++) await work.step();
    expect(work.reader.getState().build?.myItems ?? []).not.toContain('c');
  });
  it('credits the third pick lingering as the draft closes, and does not show it as a new one-card draft', async () => {
    const work = fixture(); await work.warm(); let names: (string | null)[] = ['Fixture item a', 'Fixture item b', 'Fixture item c'];
    let closing = false;
    work.behavior((request, process) => process.send(request, { blocks: closing
      // The panel title fades with the picked card; the other cards are gone.
      ? [block('Select Items', 0.08, 0.01, 0.24, 0.035, request.crop), clientBlock('Fixture item c', SLOT_CENTERS[2]![0], SLOT_CENTERS[2]![1])]
      : liveDraft(request.crop, names, 3) }));
    await work.step(); await work.step();
    expect(work.reader.getState().offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
    // "Selections complete" closes the draft.
    work.behavior((request, process) => process.send(request, { blocks: [block('Selections Complete', 0.4, 0.5, 0.2, 0.04, request.crop),
      clientBlock('Fixture item c', SLOT_CENTERS[2]![0], SLOT_CENTERS[2]![1])] }));
    await work.step();
    closing = true;
    work.behavior((request, process) => process.send(request, { blocks: [block('Select Items', 0.08, 0.01, 0.24, 0.035, request.crop),
      clientBlock('Fixture item c', SLOT_CENTERS[2]![0], SLOT_CENTERS[2]![1])] }));
    for (let index = 0; index < 3; index++) {
      await work.step();
      expect(work.reader.getState().offers.filter(offer => offer.itemId)).toEqual([]);
    }
    expect(work.reader.getState().build?.myItems).toContain('c');
    expect(work.reader.getState().build?.myItems ?? []).not.toContain('a');
  });
  it('reports a failed capture while the game is not in front, instead of asking to return to it', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { foreground: false, status: 'blank_capture', blocks: [] }));
    for (let index = 0; index < 3; index++) await work.step(1_000);
    expect(work.reader.getState().message).toMatch(/black/);
  });
  it('calls a short black image a loading screen, and gives display-mode advice only when it lasts', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { status: 'blank_capture', blocks: [] }));
    await work.step(1_000);
    expect(work.reader.getState().message).toMatch(/loading screen or a transition/);
    for (let index = 0; index < 6; index++) await work.step(1_000);
    expect(work.reader.getState().message).toMatch(/borderless windowed/);
  });
  it('keeps the shown cards through a frame that shows only the choice label (no "panel no longer visible")', async () => {
    const work = fixture(); await work.warm(); let labelOnly = false;
    work.behavior((request, process) => process.send(request, { blocks: labelOnly
      ? [clientBlock('CHOICE 2 OF 3', 0.5, 0.17, 0.1, 0.022)] : liveDraft(request.crop, ['Fixture item a', 'Fixture item b', 'Fixture item c'], 2) }));
    await work.step(); await work.step();
    const shown = work.reader.getState();
    expect(shown.offers.map(offer => offer.itemId)).toEqual(['a', 'b', 'c']);
    labelOnly = true;
    for (let index = 0; index < 3; index++) {
      await work.step();
      expect(work.reader.getState()).toMatchObject({ status: 'ready', generation: shown.generation });
      expectPickOnShownCard(work.reader.getState());
    }
  });
  it('caps the pause after a slow read (a 2.8 s read was followed by a 9.3 s pause)', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { blocks: [], elapsedMs: 2_780 }));
    await work.step(1_000);
    const before = work.process.requests.length;
    await work.step(SCREEN_READER_LIMITS.maxIdleAfterReadMs + 1);
    expect(work.process.requests.length).toBeGreaterThan(before);
  });
  it('outside a match: keeps the last build, saves no diagnostic frames and looks less often', async () => {
    const frames: unknown[] = [];
    const work = fixture({ onDraftFrame: (png: string, trace: unknown) => { frames.push(trace); } });
    await work.warm();
    // The awards screen after the last round (it was read as your HUD and trimmed a 12-item build to 3).
    const awards = { sessionId: 'synthetic-window-a', panel: 'hud', viewMode: 'participant', heroes: [], items: [], abilities: [], regions: [],
      brawl: { myItems: [{ slot: 0, itemId: 'a', confidence: 0.99 }], myOccupied: 3, playerItems: [], abilityRanks: null, hiddenItems: 0 } };
    work.behavior((request, process) => process.send(request, { previewPngBase64: request.debugPreview ? 'iVBORw0KGgo=' : undefined, context: awards,
      blocks: [block('THE VOTES ARE IN...', 0.35, 0.1, 0.3, 0.05, request.crop), block("WINNER'S BONUS", 0.1, 0.5, 0.2, 0.03, request.crop)] }));
    for (let index = 0; index < 4 && work.reader.getState().roster?.phase !== 'outside'; index++) await work.step(1_000);
    expect(work.reader.getState().roster?.phase).toBe('outside');
    expect(work.reader.getState().message).toBe(OUTSIDE_MESSAGE);
    const framesBefore = frames.length; const requestsBefore = work.process.requests.length;
    for (let index = 0; index < 120; index++) await work.step(500);
    expect(frames.length).toBe(framesBefore);
    // 60 s at the outside spacing: about 20 looks instead of about 120.
    expect(work.process.requests.length - requestsBefore).toBeLessThanOrEqual(Math.ceil(60_000 / SCREEN_READER_LIMITS.outsideReadSpacingMs) + 2);
    expect(work.reader.getState().build?.myItems ?? []).toEqual([]);
  });
  it('reads a game behind other windows when the helper can capture it (status ok without focus)', async () => {
    const work = fixture(); await work.warm();
    work.behavior((request, process) => process.send(request, { foreground: false }));
    for (let index = 0; index < 4; index++) await work.step();
    expect(work.process.requests.slice(-2).every(request => request.op === 'read')).toBe(true);
    expect(work.reader.getState().status).toBe('ready');
    // Today's helper answers not_foreground: the reader only probes, as before.
    work.behavior((request, process) => process.send(request, { foreground: false, status: 'not_foreground', blocks: [] }));
    for (let index = 0; index < 4; index++) await work.step(1_000);
    expect(work.process.requests.at(-1)!.op).toBe('probe');
  });
});
