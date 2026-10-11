import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import publicCatalog from '../data/public-catalog.json';
import {
  blocksForScreenParser, createScreenReader, MATCH_CONTEXT_REGION, normalizeNativeReply, SCREEN_READER_LIMITS,
} from '../electron/screen-reader';
import { parseScreenOffers } from '../src/screen/offer-parser';
import type { Catalog } from '../src/shared/types';
import type { CaptureRegion, NativeScreenContext, ScreenReaderState } from '../src/shared/screen-reading';
import {
  CONTEXT_TEST_START, ContextTestWorker, contextBlock, contextReply, contextWithinCrop,
  hudContext, publicDraftBlocks, scoreboardContext,
  type ContextTestBlock, type ContextTestRequest,
} from './context-fixtures';

const catalog = publicCatalog as Catalog;
const FULL = { ...MATCH_CONTEXT_REGION };
const readers: ReturnType<typeof createScreenReader>[] = [];
const itemIds = ['upgrade_toxic_bullets', 'upgrade_chain_lightning', 'upgrade_tech_overflow'];
const round = () => contextBlock('ROUND 3', .45, .08);
const isFull = (crop: CaptureRegion) => crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
/** Cards are shown with a named pick, but unread bonuses/modifiers are flagged rather than certified. */
function expectCaveatedPickOnShownCard(state: ScreenReaderState) {
  const pick = state.advice?.preferredPosition ?? null;
  expect(pick).not.toBeNull();
  expect(itemIds).toContain(state.offers.find(offer => offer.position === pick)?.itemId);
  expect(state.offers.every(offer => offer.variant === 'unknown' && offer.bonusIds === null)).toBe(true);
  expect(state.advice?.caveat).toMatch(/not read/);
}
const controlsWithoutHeading = () => [round(), ...publicDraftBlocks().filter(block => !/^(SELECT|CHOICE)/i.test(block.text))];

interface Scene {
  context?: NativeScreenContext;
  blocks?: ContextTestBlock[];
  duration?: number;
}

/** Synthetic protocol replay only. No native process or image capture is launched. */
function automatic(scene: (request: ContextTestRequest) => Scene,
  options: { monotonicNow?: () => number } = {}) {
  const publications: ScreenReaderState[] = [];
  const workers: ContextTestWorker[] = [];
  const spawn = vi.fn(() => {
    const worker = new ContextTestWorker();
    worker.respond = request => {
      if (request.op !== 'read') return { reply: contextReply(request), afterMs: 20 };
      const frame = scene(request);
      const duration = frame.duration ?? 20;
      return { reply: contextReply(request, frame.context && contextWithinCrop(frame.context, request.crop), frame.blocks ?? [],
        { elapsedMs: duration }), afterMs: duration };
    };
    workers.push(worker);
    return worker;
  });
  const reader = createScreenReader({
    helperPath: 'mock-process-never-launched.exe', iconDirectory: 'mock-item-assets', contextIconDirectory: 'mock-context-assets',
    catalog, autoStart: true, now: () => Date.now(),
    monotonicNow: options.monotonicNow ?? (() => Date.now() - CONTEXT_TEST_START),
    spawnProcess: spawn, onState: state => publications.push(state),
  });
  readers.push(reader);
  return { reader, publications, workers, spawn };
}

function assertSingleContextWorker(harness: ReturnType<typeof automatic>) {
  expect(harness.spawn).toHaveBeenCalledTimes(1);
  expect(harness.spawn).toHaveBeenCalledWith('mock-process-never-launched.exe',
    ['--icons', 'mock-item-assets', '--context-icons', 'mock-context-assets'],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  expect(harness.workers[0]!.maximumOutstanding).toBe(1);
  expect(harness.workers[0]!.requests.filter(({ request }) => request.op !== 'probe')
    .every(({ request }) => request.context === true)).toBe(true);
  expect(harness.reader.getState().metrics.timeouts).toBe(0);
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CONTEXT_TEST_START); });
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.dispose();
  vi.useRealTimers();
});

describe('automatic reader discovery under imperfect native scene classification', () => {
  it('confirms actual card controls despite a generic native HUD label, then clears genuine combat', async () => {
    // Native currently recognizes draft from Select/Choice. Offer recognition
    // also accepts the exact visible reroll control when those headings are lost.
    const raw = contextReply({ id: 'valid-reroll-frame', op: 'read', crop: FULL }, hudContext(), controlsWithoutHeading());
    const parsed = parseScreenOffers(blocksForScreenParser(normalizeNativeReply(raw, FULL)), catalog,
      { conservativeUnmarkedDetails: true });
    expect(parsed.isDraft).toBe(true);
    expect(parsed.offers.map(offer => offer.itemId)).toEqual(itemIds);

    let draft = true;
    const harness = automatic(() => ({ context: hudContext(), blocks: draft ? controlsWithoutHeading() : [round()] }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(harness.publications.some(state => state.status === 'ready' && state.offers.length === 3)).toBe(true);
    const ready = harness.reader.getState();
    expect(ready.offers.map(offer => offer.itemId)).toEqual(itemIds);
    expectCaveatedPickOnShownCard(ready);
    expect(ready.matchContext.phase).toBe('draft');
    const lastReadyAt = Date.now();

    // Actual combat has no draft controls or columns. No completion title is
    // needed to withdraw the prior frame, including after the scoreboard closes.
    draft = false;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(harness.reader.getState()).toMatchObject({ offers: [], advice: null, observedAt: null });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.reader.getState().status).toBe('waiting-draft');
    expect(harness.publications.filter(state => state.observedAt !== null && state.observedAt > lastReadyAt)
      .every(state => state.offers.length === 0)).toBe(true);
    assertSingleContextWorker(harness);
  });

  it('does not let repeated scoreboard metadata consume every current draft capture as another hint', async () => {
    // A metadata cue is not an instruction to discard the visible card content
    // in the full reply. This reproduces the old scoreboardReadDue priority loop.
    const harness = automatic(() => ({ context: scoreboardContext(), blocks: [round(), ...publicDraftBlocks()] }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.publications.some(state => state.status === 'ready' && state.offers.length === 3)).toBe(true);
    expect(harness.reader.getState().offers.map(offer => offer.itemId)).toEqual(itemIds);
    expect(harness.reader.getState().matchContext.players).toHaveLength(8);
    expectCaveatedPickOnShownCard(harness.reader.getState());
    const reads = harness.workers[0]!.requests.filter(({ request }) => request.op === 'read');
    expect(reads.some(({ request }) => isFull(request.crop))).toBe(true);
    expect(reads.length).toBeLessThanOrEqual(10);
    assertSingleContextWorker(harness);
  });

  it('recovers an eight-player context without a successful narrow draft or scoreboard hint', async () => {
    const harness = automatic(request => isFull(request.crop)
      ? { context: { ...scoreboardContext(), panel: 'hud' }, blocks: [round()] }
      : { context: hudContext(), blocks: [] });
    // Only the full frame proves the eight-slot mode and includes the owned grid.
    // Top/footer OCR remains unread, so a positive cheap cue never rescues this test.
    await vi.advanceTimersByTimeAsync(12_500);
    const state = harness.reader.getState();
    expect(state.matchContext.players.map(player => [player.seat, player.team])).toEqual([
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 1], [5, 1], [6, 1], [7, 1],
    ]);
    expect(state.matchContext.localInventory.map(item => item.itemId)).toEqual(['upgrade_health', 'upgrade_vampire']);
    expect(state.offers).toEqual([]);
    expect(state.advice).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    const reads = harness.workers[0]!.requests.filter(({ request }) => request.op === 'read');
    const surveys = reads.filter(({ request }) => isFull(request.crop));
    expect(surveys.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < reads.length; index++) {
      expect(reads[index]!.startedAt - reads[index - 1]!.startedAt).toBeGreaterThanOrEqual(SCREEN_READER_LIMITS.phaseSpacingMs);
    }
    for (let index = 1; index < surveys.length; index++) {
      expect(surveys[index]!.startedAt - surveys[index - 1]!.startedAt).toBeGreaterThanOrEqual(10_000);
    }
    assertSingleContextWorker(harness);
  });

  it('a slow scoreboard-to-draft handoff still confirms choices without bypassing the wall duty limit', async () => {
    const harness = automatic(() => ({ context: scoreboardContext(), blocks: [round(), ...publicDraftBlocks()], duration: 210 }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.publications.some(state => state.status === 'ready' && state.offers.length === 3)).toBe(true);
    const reads = harness.workers[0]!.requests.filter(({ request }) => request.op === 'read');
    expect(reads.length).toBeGreaterThan(5);
    for (let index = 1; index < reads.length; index++) {
      expect(reads[index]!.startedAt - reads[index - 1]!.startedAt)
        .toBeGreaterThanOrEqual(210 / SCREEN_READER_LIMITS.maxWorkerWallShare);
    }
    assertSingleContextWorker(harness);
  });

  it('survives a sub-millisecond early wake for an established loop and continues acquiring current frames', async () => {
    let lagAtNextWake = false;
    let earlyWakeSeen = false;
    const harness = automatic(() => ({ context: { ...hudContext(), panel: 'draft' }, blocks: [round(), ...publicDraftBlocks()] }), {
      monotonicNow: () => {
        const elapsed = Date.now() - CONTEXT_TEST_START;
        // Model a timer callback preceding a fractional monotonic deadline. This
        // affects an established loop, not only the synthetic startup request.
        if (lagAtNextWake && elapsed === 3_000) { earlyWakeSeen = true; return elapsed - .25; }
        return elapsed;
      },
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(harness.reader.getState().offers).toHaveLength(3);
    lagAtNextWake = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(earlyWakeSeen).toBe(true);
    const lateReads = harness.workers[0]!.requests.filter(({ request, startedAt }) => request.op === 'read'
      && startedAt > CONTEXT_TEST_START + 4_000);
    expect(lateReads.length).toBeGreaterThan(5);
    expect(harness.reader.getState().observedAt).toBeGreaterThan(CONTEXT_TEST_START + 11_000);
    assertSingleContextWorker(harness);
  });
});
