import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import catalogData from '../data/public-catalog.json';
import {
  blocksForScreenParser, createScreenReader, draftCaptureRegion, DRAFT_FOOTER_REGION, MATCH_CONTEXT_REGION, normalizeNativeReply, SCREEN_READER_LIMITS,
  type ScreenReaderProcess, type SpawnScreenReader,
} from '../electron/screen-reader';
import { parseScreenOffers } from '../src/screen/offer-parser';
import { parseScreenMatchObservation } from '../src/screen/match-parser';
import { evaluateScreenOffers } from '../src/screen/screen-advice';
import { DEFAULT_CAPTURE_REGION, SCREEN_CARD_BACKGROUND_HOLD_MS, validateCaptureRegion, type CaptureRegion } from '../src/shared/screen-reading';
import { newestScreenReaderState } from '../src/renderer/screen-state';
import type { Catalog } from '../src/shared/types';

const catalog = catalogData as Catalog;
const START = 1_800_000_000_000;
/** Two cue-less hint reads at the phase spacing, plus native read time; far below the card hold. */
const CLOSURE_BOUND_MS = SCREEN_READER_LIMITS.draftCueMissesToClose * SCREEN_READER_LIMITS.phaseSpacingMs + 1_000;
const names = ['Active Reload', 'Bullet Lifesteal', 'Spirit Resilience'];
type NativeRequest = { id: string; op: 'fixture' | 'probe' | 'read'; crop: CaptureRegion; debugPreview?: boolean };
type NativeBlock = { text: string; bounds: CaptureRegion; words?: { text: string; bounds: CaptureRegion }[] };
type Reader = ReturnType<typeof createScreenReader>;

/** These frames are synthetic protocol fixtures, not participant screenshots. */
function block(text: string, x: number, y: number, width = 0.18, height = 0.032): NativeBlock {
  return { text, bounds: { x, y, width, height } };
}
function draftFrame(itemNames = names): NativeBlock[] {
  return [block('SELECT ITEMS', 0.08, 0.14, 0.26, 0.045), block('Choice 1 of 3', 0.08, 0.20, 0.15),
    block('Use Re-Roll', 0.43, 0.78, 0.15), block('1 Re-Roll Remaining', 0.39, 0.84, 0.23),
    ...itemNames.flatMap((name, position) => {
      const x = [0.17, 0.41, 0.65][position]!; const y = position === 1 ? 0.43 : 0.68;
      return [block(name, x, y), block('Tier 2', x + 0.05, y + 0.055, 0.08, 0.023)];
    })];
}
/** Authorized local combat frame geometry; all personal/unknown text is replaced. */
function anonymizedCombatFrame(): NativeBlock[] {
  return [block('ROUND 2', 0.47652314814814817, 0.040992313067784766, 0.045886574074074093, 0.012309573724668066),
    ...[
      [0.46638541666666666, 0.32539921411253236, 0.017607638888888888, 0.010438090460663796],
      [0.4786574074074074, 0.4269333667753533, 0.044819444444444356, 0.011387007775269575],
      [0.4402407407407407, 0.5408034445280496, 0.02134259259259258, 0.012335925089875466],
      [0.030462962962962963, 0.6224103335841485, 0.012805555555555556, 0.011387007775269575],
      [0.019791666666666666, 0.7486163364267202, 0.016540509259259262, 0.018029428977510253],
      [0.07101388888888889, 0.7600033442019898, 0.012805555555555556, 0.017080511662904474],
      [0.12010185185185186, 0.5218250982359335, 0.009604166666666678, 0.009489173146058016],
      [0.12010185185185186, 0.5882493102583396, 0.012805555555555556, 0.010438090460663796],
      [0.1078298611111111, 0.7476674191121143, 0.034148148148148136, 0.03605885795502051],
      [0.25189236111111113, 0.6736518685728619, 0.045886574074074093, 0.037956692584232066],
      [0.2721678240740741, 0.7343825767076331, 0.02561111111111114, 0.018978346292116144],
    ].map(([x, y, width, height]) => block('HUD', x!, y!, width!, height!))];
}
/** Public card/cue labels and word geometry only, from authorized local draft observations. */
function observedDraftFrame(revealed = true, rerollCountVisible = true): NativeBlock[] {
  const word = (text: string, x: number, y: number, width: number, height: number) => ({ text, bounds: { x, y, width, height } });
  const values: NativeBlock[] = [
    { ...block('SELECT ITEMS', 0.03833333333333333, 0.18181818181818182, 0.24444444444444446, 0.05237154150197629), words: [
      word('SELECT', 0.03833333333333333, 0.18181818181818182, 0.12777777777777777, 0.05237154150197629),
      word('ITEMS', 0.17666666666666667, 0.18280632411067194, 0.10611111111111111, 0.05138339920948617),
    ] },
    { ...block('CHOICE 1 OF 3', 0.04, 0.26778656126482214, 0.09777777777777777, 0.02371541501976282), words: [
      word('CHOICE', 0.04, 0.26877470355731226, 0.051666666666666666, 0.022727272727272728),
      word('1', 0.0961111111111111, 0.26877470355731226, 0.005555555555555556, 0.021739130434782608),
      word('OF', 0.10722222222222222, 0.26778656126482214, 0.018333333333333333, 0.023715415019762844),
      word('3', 0.13, 0.26877470355731226, 0.0077777777777777776, 0.022727272727272728),
    ] },
    { ...block('Toxic Bullets', 0.22111111111111112, 0.6768774703557312, 0.11444444444444443, 0.029644268774703608), words: [
      word('Toxic', 0.22111111111111112, 0.6778656126482213, 0.04722222222222222, 0.02865612648221344),
      word('Bullets', 0.2727777777777778, 0.6768774703557312, 0.06277777777777778, 0.0266798418972332),
    ] },
    { ...block('Tesla Bullets', 0.4438888888888889, 0.44762845849802374, 0.11166666666666669, 0.030632411067193666), words: [
      word('Tesla', 0.4438888888888889, 0.4505928853754941, 0.04388888888888889, 0.02766798418972332),
      word('Bullets', 0.49333333333333335, 0.44762845849802374, 0.06222222222222222, 0.02766798418972332),
    ] },
    { ...block('Use Re-Roll', 0.4627777777777778, 0.6531620553359684, 0.07444444444444448, 0.01976284584980237), words: [
      word('Use', 0.4627777777777778, 0.6531620553359684, 0.023333333333333334, 0.019762845849802372),
      word('Re-Roll', 0.4905555555555556, 0.6531620553359684, 0.04666666666666667, 0.019762845849802372),
    ] },
    { ...block(rerollCountVisible ? '1 Re-Roll Remaining' : 'Re-Roll Remaining', 0.46, 0.7134387351778656, 0.07944444444444448, 0.015810276679841917), words: [
      ...(rerollCountVisible ? [word('1', 0.46, 0.7144268774703557, 0.0022222222222222222, 0.011857707509881422)] : []),
      word('Re-Roll', 0.46444444444444444, 0.7134387351778656, 0.028888888888888888, 0.012845849802371542),
      word('Remaining', 0.4955555555555556, 0.7144268774703557, 0.04388888888888889, 0.014822134387351778),
    ] },
  ];
  if (revealed) values.push({ ...block('Spiritual Ouerflow', 0.6388888888888888, 0.6739130434782609, 0.16555555555555568, 0.03952569169960474), words: [
    word('Spiritual', 0.6388888888888888, 0.6788537549407114, 0.07722222222222222, 0.03458498023715415),
    word('Ouerflow', 0.7216666666666667, 0.6739130434782609, 0.08277777777777778, 0.029644268774703556),
  ] });
  return values;
}
function isCardRead(request: NativeRequest): boolean { return request.op === 'read' && request.crop.height > 0.5; }
function roundedNativeCrop(crop: CaptureRegion): CaptureRegion {
  const x = Math.floor(crop.x * 1920), y = Math.floor(crop.y * 1080);
  return { x: x / 1920, y: y / 1080, width: (Math.ceil((crop.x + crop.width) * 1920) - x) / 1920,
    height: (Math.ceil((crop.y + crop.height) * 1080) - y) / 1080 };
}
function insideCrop(value: NativeBlock, crop: CaptureRegion): boolean {
  const b = value.bounds;
  return b.x >= crop.x && b.y >= crop.y && b.x + b.width <= crop.x + crop.width + 0.00001
    && b.y + b.height <= crop.y + crop.height + 0.00001;
}
function nativeReply(request: NativeRequest, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const synthetic = request.op === 'fixture';
  return {
    protocol: 1, id: request.id, status: 'ok', gamePresent: !synthetic, foreground: !synthetic,
    clientWidth: 1920, clientHeight: 1080, capturedAt: Date.now(), elapsedMs: 20,
    hash: request.op === 'probe' ? 'probe-hash' : 'draft-hash', crop: request.crop,
    blocks: request.op === 'probe' ? [] : draftFrame().filter(value => insideCrop(value, request.crop)),
    ocrAvailable: true, ocrLanguage: 'en-US', synthetic,
    metrics: { cpuMs: 1, workingSetMb: 100 }, ...overrides,
  };
}

class MockNativeProcess extends EventEmitter implements ScreenReaderProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly requests: NativeRequest[] = [];
  exitCode: number | null = null;
  acknowledgeKill = true;
  respond: (request: NativeRequest) => Record<string, unknown> | undefined = request => nativeReply(request);
  kill = vi.fn((signal?: NodeJS.Signals) => {
    void signal;
    if (this.acknowledgeKill) queueMicrotask(() => this.confirmExit());
    return true;
  });
  constructor() {
    super();
    this.stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk).trim()) as NativeRequest;
      this.requests.push(request);
      const reply = this.respond(request);
      if (reply) queueMicrotask(() => this.output(reply));
    });
  }
  output(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  confirmExit() {
    if (this.exitCode !== null) return;
    this.exitCode = 0; this.emit('exit', 0); this.emit('close', 0);
  }
}

const readers: Reader[] = [];
function setup(overrides: Partial<Parameters<typeof createScreenReader>[0]> = {}) {
  const processes: MockNativeProcess[] = [];
  const spawnProcess = vi.fn<SpawnScreenReader>(() => {
    const process = new MockNativeProcess(); processes.push(process); return process;
  });
  const reader = createScreenReader({ helperPath: 'synthetic-test-helper.exe', catalog,
    now: () => Date.now(), monotonicNow: () => Date.now() - START, spawnProcess, autoStart: false, ...overrides });
  readers.push(reader);
  return { reader, processes, spawnProcess };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function step(reader: Reader, spacing = 500) {
  await reader.pollOnce();
  await vi.advanceTimersByTimeAsync(spacing);
}
async function untilReady(reader: Reader) {
  for (let count = 0; count < 18; count++) {
    await reader.pollOnce();
    if (reader.getState().status === 'ready') return;
    await vi.advanceTimersByTimeAsync(500);
  }
  throw new Error(`Synthetic coordinator did not become ready: ${reader.getState().status}, ${reader.getState().message}`);
}
/** Polls until shown cards are withdrawn; until then only the previously shown cards may remain. */
async function untilWithdrawn(reader: Reader, shown: string[], limitMs: number): Promise<number> {
  const startedAt = Date.now();
  while (reader.getState().offers.length > 0 && Date.now() - startedAt < limitMs) {
    expect(reader.getState().offers.map(value => value.name)).toEqual(shown);
    await vi.advanceTimersByTimeAsync(250); await reader.pollOnce();
  }
  return Date.now() - startedAt;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(START); });
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.dispose();
  vi.useRealTimers();
});

describe('native JSONL boundary and crop coordinates', () => {
  it('accepts native omitted-null visibility replies without promoting them to a capture', () => {
    const raw = nativeReply({ id: 'not-visible', op: 'probe', crop: { ...DEFAULT_CAPTURE_REGION } }, {
      status: 'not_foreground', foreground: false, blocks: [],
    });
    delete raw.capturedAt; delete raw.hash;
    expect(normalizeNativeReply(raw)).toMatchObject({ status: 'not_foreground', foreground: false, capturedAt: null, hash: null });
  });
  it('preserves native full-client provenance while giving the parser crop-relative geometry', () => {
    const crop = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };
    const bounds = { x: 0.3, y: 0.5, width: 0.16, height: 0.06 };
    const reply = normalizeNativeReply(nativeReply({ id: 'crop', op: 'read', crop }, {
      blocks: [{ text: 'Active Reload', bounds, words: [{ text: 'Active', bounds }] }],
    }), crop);
    expect(reply.blocks[0]?.bounds).toEqual(bounds);
    expect(reply.blocks[0]?.words?.[0]?.bounds).toEqual(bounds);
    expect(reply.blocks[0]?.x).toBeCloseTo(0.25);
    expect(reply.blocks[0]?.y).toBeCloseTo(0.5);
    expect(reply.blocks[0]?.width).toBeCloseTo(0.2);
    expect(reply.blocks[0]?.height).toBeCloseTo(0.1);
  });
  it('preserves synthetic provenance and explicit failed bonus slots', () => {
    const request: NativeRequest = { id: 'synthetic', op: 'fixture', crop: { ...DEFAULT_CAPTURE_REGION } };
    const reply = normalizeNativeReply(nativeReply(request, { icons: [{ itemId: '', confidence: 0, role: 'bonus', slot: 1,
      bounds: { x: 0.2, y: 0.5, width: 0.05, height: 0.06 } }] }));
    expect(reply.synthetic).toBe(true);
    expect(reply.icons?.[0]).toMatchObject({ itemId: '', confidence: 0, role: 'bonus', slot: 1 });
  });
  it('keeps a card identified by its icon with its position and Enhanced proof', () => {
    const request: NativeRequest = { id: 'cards', op: 'read', crop: { ...DEFAULT_CAPTURE_REGION } };
    const bounds = { x: 0.69, y: 0.53, width: 0.07, height: 0.12 };
    const reply = normalizeNativeReply(nativeReply(request, { icons: [
      { itemId: 'upgrade_active_reload', confidence: 0.95, role: 'card', slot: 2, enhanced: true, bounds },
      { itemId: 'upgrade_active_reload', confidence: 0.95, role: 'card', slot: 0, bounds },
      { itemId: 'upgrade_active_reload', confidence: 0.95, role: 'bonus', slot: 0, enhanced: true, bounds }] }));
    expect(reply.icons).toEqual([
      { itemId: 'upgrade_active_reload', confidence: 0.95, role: 'card', slot: 2, enhanced: true, bounds },
      { itemId: 'upgrade_active_reload', confidence: 0.95, role: 'card', slot: 0, bounds },
      { itemId: 'upgrade_active_reload', confidence: 0.95, role: 'bonus', slot: 0, bounds }]);
  });
  it('normalizes the native preview field only when it contains bounded PNG base64', () => {
    const request: NativeRequest = { id: 'preview', op: 'read', crop: { ...DEFAULT_CAPTURE_REGION } };
    expect(normalizeNativeReply(nativeReply(request, { previewPngBase64: 'iVBORw0KGgo=' })).previewPng).toBe('iVBORw0KGgo=');
    expect(() => normalizeNativeReply(nativeReply(request, { previewPngBase64: 'data:image/svg+xml,<svg/>' }))).toThrow(TypeError);
  });
  it.each([
    ['wrong protocol', { protocol: 2 }], ['unknown status', { status: 'possibly-ok' }],
    ['numeric visibility', { foreground: 1 }], ['nonfinite time', { elapsedMs: Infinity }],
    ['oversized frame', { clientWidth: 20_000 }], ['fractional dimensions', { clientHeight: 1080.5 }],
    ['invalid geometry', { blocks: [{ text: 'Active Reload', bounds: { x: 1, y: 0, width: 0.1, height: 0.1 } }] }],
    ['too many blocks', { blocks: Array.from({ length: 257 }, () => block('x', 0.1, 0.1)) }],
    ['invalid icon slot', { icons: [{ itemId: 'a', confidence: 1, role: 'bonus', slot: 4, bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }] }],
    ['a third bonus slot', { icons: [{ itemId: 'a', confidence: 1, role: 'bonus', slot: 2, bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }] }],
    ['a fourth card', { icons: [{ itemId: 'a', confidence: 1, role: 'card', slot: 3, bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }] }],
    ['unknown icon role', { icons: [{ itemId: 'a', confidence: 1, role: 'tooltip', slot: 0, bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }] }],
    ['non-boolean icon detail', { icons: [{ itemId: 'a', confidence: 1, role: 'card', slot: 0, enhanced: 'yes', bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }] }],
  ])('rejects %s', (_label, changes) => {
    expect(() => normalizeNativeReply(nativeReply({ id: 'invalid', op: 'read', crop: { ...DEFAULT_CAPTURE_REGION } }, changes))).toThrow(TypeError);
  });
  it('rejects unsafe calibration geometry before any native process is created', () => {
    expect(() => validateCaptureRegion({ x: 0.8, y: 0, width: 0.3, height: 1 })).toThrow();
    expect(() => validateCaptureRegion({ x: 0, y: 0, width: 1, height: 1, file: 'desktop.png' })).toThrow();
  });
});

describe('actual-reading coordinator with an injected native process', () => {
  it('confirms the same item identities when icon similarity drifts slightly between current frames', async () => {
    const { reader, processes } = setup(); await step(reader);
    let cardRead = 0;
    processes[0]!.respond = request => {
      const full = isCardRead(request);
      if (full) cardRead++;
      const confidence = cardRead % 2 ? 0.96 : 0.98;
      return nativeReply(request, { hash: `animated-frame-${cardRead}`,
        blocks: [...draftFrame(), block('Bonus!', 0.22, 0.57, 0.09)].filter(value => insideCrop(value, request.crop)),
        icons: full ? [
          { itemId: 'upgrade_improved_spirit', confidence, role: 'bonus', slot: 0, bounds: { x: 0.20, y: 0.53, width: 0.05, height: 0.06 } },
          { itemId: 'upgrade_health', confidence, role: 'bonus', slot: 1, bounds: { x: 0.20, y: 0.59, width: 0.05, height: 0.06 } },
        ] : [],
      });
    };
    await untilReady(reader);
    expect(reader.getState().offers.map(value => value.name)).toEqual(names);
    expect(reader.getState().offers[0]?.bonusIds).toEqual(['upgrade_improved_spirit', 'upgrade_health']);
  });
  it('shows a card whose name stays unread from the reader\'s match of its icon', async () => {
    const { reader, processes } = setup(); await step(reader);
    const middle = catalog.items.find(item => item.name === names[1])!.id;
    processes[0]!.respond = request => nativeReply(request, { hash: 'middle-name-unread',
      blocks: draftFrame().filter(value => value.text !== names[1] && insideCrop(value, request.crop)),
      icons: isCardRead(request) ? [{ itemId: middle, confidence: 0.95, role: 'card', slot: 1, bounds: { x: 0.465, y: 0.3, width: 0.07, height: 0.125 } }] : [] });
    await untilReady(reader);
    expect(reader.getState().offers.map(value => value.name)).toEqual(names);
    expect(reader.getState().offers.map(value => value.byIcon === true)).toEqual([false, true, false]);
    expect(reader.getState().advice).not.toBeNull();
  });
  it('keeps one card generation and pick across exact and corrected OCR while showing the current warning', async () => {
    const { reader, processes } = setup(); await step(reader);
    let cardRead = 0;
    processes[0]!.respond = request => {
      if (isCardRead(request)) cardRead++;
      const observedNames = cardRead % 2 === 0 ? ['Active Re1oad', ...names.slice(1)] : names;
      return nativeReply(request, { hash: `changing-pixels-${cardRead}`, blocks: draftFrame(observedNames).filter(value => insideCrop(value, request.crop)) });
    };
    await untilReady(reader);
    // The first readable view is exact; it is shown at once without a correction warning.
    expect(reader.getState().offers.map(value => value.name)).toEqual(names);
    expect(reader.getState().offers[0]?.warning ?? '').not.toMatch(/OCR correction/i);
    const generation = reader.getState().generation;
    const pick = reader.getState().advice?.preferredPosition;
    expect(pick).not.toBeNull();
    let correctedSeen = false;
    for (let sample = 0; sample < 8 && !correctedSeen; sample++) {
      await step(reader);
      const current = reader.getState();
      expect(current.status).toBe('ready');
      expect(current.offers.map(value => value.name)).toEqual(names);
      expect(current.generation).toBe(generation);
      expect(current.advice?.preferredPosition).toBe(pick);
      correctedSeen = /OCR correction/i.test(current.offers[0]?.warning ?? '');
    }
    // The corrected view is the same item, carrying its own current warning.
    expect(correctedSeen).toBe(true);
    expect(reader.getState().advice?.caveat).toMatch(/not read|check them in game/i);
  });
  it('shows stable main identities while modifier and bonus observations alternate between known and unknown', async () => {
    const { reader, processes } = setup(); await step(reader);
    let fullFrames = 0;
    processes[0]!.respond = request => {
      if (isCardRead(request)) fullFrames++;
      const marked = fullFrames % 2 === 1;
      return nativeReply(request, { hash: `details-${fullFrames}`,
        blocks: [...draftFrame(), ...(marked ? [block('Enhanced', 0.2, 0.735, 0.12), block('Bonus!', 0.22, 0.57, 0.09)] : [])]
          .filter(value => insideCrop(value, request.crop)),
        icons: marked && isCardRead(request) ? [
          { itemId: 'upgrade_improved_spirit', confidence: 0.98, role: 'bonus', slot: 0, bounds: { x: 0.20, y: 0.53, width: 0.05, height: 0.06 } },
          { itemId: 'upgrade_health', confidence: 0.98, role: 'bonus', slot: 1, bounds: { x: 0.20, y: 0.59, width: 0.05, height: 0.06 } },
        ] : [],
      });
    };
    await untilReady(reader);
    const generation = reader.getState().generation;
    for (let sample = 0; sample < 6; sample++) {
      const current = reader.getState();
      expect(current.status).toBe('ready');
      expect(current.offers.map(value => value.name)).toEqual(names);
      // Detail flicker is not a new draft: the same generation stays on screen.
      expect(current.generation).toBe(generation);
      const pick = current.advice?.preferredPosition;
      expect(pick).not.toBeNull();
      expect(current.advice?.title).toContain(current.offers.find(value => value.position === pick)!.name);
      await step(reader);
    }
  });
  it('shows cards from the first readable observation and withdraws them when no read confirms them for the hold time', async () => {
    const { reader, processes } = setup();
    await untilReady(reader);
    // No second confirming view is needed before cards and a pick appear.
    expect(processes[0]!.requests.filter(isCardRead)).toHaveLength(1);
    expect(reader.getState().offers.map(value => value.name)).toEqual(names);
    expect(reader.getState().advice?.preferredPosition).not.toBeNull();
    const observedAt = reader.getState().observedAt!;
    // Every later capture is unverifiable, so nothing can refresh the shown cards.
    processes[0]!.respond = request => nativeReply(request, { hash: null });
    while (Date.now() < observedAt + SCREEN_READER_LIMITS.cardHoldMs - 1000) {
      await step(reader);
      expect(reader.getState().offers.map(value => value.name)).toEqual(names);
      expect(reader.getState().observedAt).toBe(observedAt);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [], advice: null, observedAt: null });
  });
  it('reaches card reads when a successful hint needs 210 ms and the worker cooldown is respected', async () => {
    const processes: MockNativeProcess[] = [];
    const spawnProcess: SpawnScreenReader = () => {
      const process = new MockNativeProcess(); processes.push(process);
      process.respond = request => {
        if (request.op === 'read' && request.crop.y < 0.1 && request.crop.height < 0.5) {
          const reply = nativeReply(request, { elapsedMs: 210 });
          setTimeout(() => process.output(reply), 210);
          return undefined;
        }
        return nativeReply(request);
      };
      return process;
    };
    const { reader } = setup({ autoStart: true, spawnProcess });
    await vi.advanceTimersByTimeAsync(6500);
    const fullReads = processes.flatMap(process => process.requests).filter(isCardRead);
    expect(fullReads.length).toBeGreaterThanOrEqual(2);
    expect(reader.getState().status).toBe('ready');
    expect(reader.getState().offers.map(value => value.name)).toEqual(names);
  });
  it('keeps the unattended loop live through OCR jitter then clears a default-crop combat transition for ten minutes', async () => {
    const processes: MockNativeProcess[] = [];
    let combat = false;
    let cardRead = 0;
    let activeRequests = 0;
    let maximumOutstanding = 0;
    const published: ReturnType<Reader['getState']>[] = [];
    const spawnProcess: SpawnScreenReader = () => {
      const process = new MockNativeProcess(); processes.push(process);
      process.respond = request => {
        activeRequests++; maximumOutstanding = Math.max(maximumOutstanding, activeRequests);
        const full = isCardRead(request);
        if (full) cardRead++;
        const elapsedMs = request.op === 'fixture' ? 50 : request.op === 'probe' ? 15 : full ? 117.21 : 43.45;
        const crop = roundedNativeCrop(request.crop);
        const values = combat ? anonymizedCombatFrame()
          : draftFrame(cardRead % 2 ? names : ['Active Re1oad', ...names.slice(1)]);
        const reply = nativeReply(request, { elapsedMs, crop, capturedAt: Date.now() + 5,
          hash: `unattended-${combat ? 'combat' : 'draft'}-${cardRead}`,
          blocks: request.op === 'probe' ? [] : values.filter(value => insideCrop(value, crop)),
        });
        setTimeout(() => { activeRequests--; process.output(reply); }, Math.ceil(elapsedMs));
        return undefined;
      };
      return process;
    };
    const { reader } = setup({ autoStart: true, spawnProcess, onState: state => published.push(state) });
    // Only advance time: no manual pollOnce calls can hide a stopped scheduler.
    await vi.advanceTimersByTimeAsync(6000);
    expect(reader.getState().status).toBe('ready');
    expect(reader.getState().offers.map(value => value.name)).toEqual(names);
    combat = true;
    const combatAt = Date.now();
    while (reader.getState().status === 'ready' && Date.now() - combatAt < SCREEN_READER_LIMITS.cardHoldMs) {
      // Until the closure is confirmed, only the same draft may remain visible.
      expect(reader.getState().offers.map(value => value.name)).toEqual(names);
      await vi.advanceTimersByTimeAsync(100);
    }
    // Closure needs consecutive hint reads without the draft cue, well inside the card hold.
    expect(Date.now() - combatAt).toBeLessThanOrEqual(CLOSURE_BOUND_MS);
    expect(reader.getState().status).toBe('waiting-draft');
    expect(reader.getState().offers).toEqual([]);
    expect(reader.getState().advice).toBeNull();
    const clearedIndex = published.length;
    const requestsAtClosure = processes[0]!.requests.length;
    for (let minute = 0; minute < 10; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reader.getState().status).toBe('waiting-draft');
      expect(reader.getState().offers).toEqual([]);
      expect(reader.getState().advice).toBeNull();
    }
    expect(processes[0]!.requests.length).toBeGreaterThan(requestsAtClosure + 100);
    expect(published.slice(clearedIndex).every(state => state.status !== 'reading' && state.offers.length === 0 && state.advice === null)).toBe(true);
    expect(maximumOutstanding).toBe(1);
    expect(processes).toHaveLength(1);
    expect(processes[0]!.requests.every(request => request.debugPreview !== true)).toBe(true);
  });
  it('clears shown cards when real combat geometry replaces them without a visible closure label', async () => {
    const { reader, processes } = setup();
    await untilReady(reader);
    const shownAt = reader.getState().observedAt!;
    processes[0]!.respond = request => nativeReply(request, { hash: 'actual-combat-layout',
      blocks: anonymizedCombatFrame().filter(value => insideCrop(value, request.crop)),
    });
    const elapsed = await untilWithdrawn(reader, names, SCREEN_READER_LIMITS.cardHoldMs);
    expect(elapsed).toBeLessThanOrEqual(CLOSURE_BOUND_MS);
    expect(reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [], advice: null });
    // Withdrawn by the closed draft cue, not merely by the card hold lapsing.
    expect(Date.now()).toBeLessThan(shownAt + SCREEN_READER_LIMITS.cardHoldMs);
  });
  it('shows observed reveal frames with corrected item words and missing counters, names a pick, then clears combat automatically', async () => {
    const processes: MockNativeProcess[] = [];
    const published: ReturnType<Reader['getState']>[] = [];
    let combat = false, fullFrames = 0;
    const spawnProcess: SpawnScreenReader = () => {
      const process = new MockNativeProcess(); processes.push(process);
      process.respond = request => {
        const full = isCardRead(request);
        if (full) fullFrames++;
        const elapsedMs = request.op === 'fixture' ? 50 : request.op === 'probe' ? 15
          : full ? [195.9, 101.84, 105.66, 103.22][Math.min(fullFrames - 1, 3)]! : 43.45;
        const crop = roundedNativeCrop(request.crop);
        const values = combat ? anonymizedCombatFrame() : observedDraftFrame(fullFrames > 1, fullFrames <= 2);
        const reply = nativeReply(request, { crop, elapsedMs, capturedAt: Date.now() + 5,
          blocks: request.op === 'fixture' ? draftFrame() : request.op === 'probe' ? [] : values.filter(value => insideCrop(value, crop)),
          hash: `observed-${combat ? 'combat' : 'selection'}-${fullFrames}`,
        });
        setTimeout(() => process.output(reply), Math.ceil(elapsedMs));
        return undefined;
      };
      return process;
    };
    const { reader } = setup({ autoStart: true, spawnProcess, onState: state => published.push(state) });
    await vi.advanceTimersByTimeAsync(8000);
    expect(fullFrames).toBeGreaterThanOrEqual(3);
    expect(reader.getState()).toMatchObject({ status: 'ready' });
    expect(reader.getState().offers.map(value => value.name)).toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
    expect(reader.getState().offers.map(value => value.itemId)).toEqual(['upgrade_toxic_bullets', 'upgrade_chain_lightning', 'upgrade_tech_overflow']);
    expect(reader.getState().offers[2]?.warning).toMatch(/OCR correction/i);
    expect(reader.getState().offers[2]?.confidence).toBeCloseTo(0.9411764705882353);
    // A pick is named for the corrected read, with the unread-details caveat.
    const pick = reader.getState().advice?.preferredPosition;
    expect(pick).not.toBeNull();
    expect(reader.getState().advice?.title).toContain(reader.getState().offers.find(value => value.position === pick)!.name);
    expect(reader.getState().advice?.caveat).toMatch(/check them in game/i);
    const readyPublications = published.filter(state => state.status === 'ready');
    expect(readyPublications.length).toBeGreaterThan(1);
    expect(new Set(readyPublications.map(state => state.generation)).size).toBe(1);
    combat = true;
    const combatAt = Date.now();
    while (reader.getState().status === 'ready' && Date.now() - combatAt < SCREEN_READER_LIMITS.cardHoldMs) {
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(Date.now() - combatAt).toBeLessThanOrEqual(CLOSURE_BOUND_MS);
    expect(reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [], advice: null });
    expect(processes).toHaveLength(1);
    expect(processes[0]!.requests.every(request => request.debugPreview !== true)).toBe(true);
  });
  it('rejects a late ready RPC snapshot after the coordinator publishes the combat clear', async () => {
    const publications: ReturnType<Reader['getState']>[] = [];
    const { reader, processes } = setup({ onState: state => publications.push(state) });
    await untilReady(reader);
    const delayedRpc = reader.getState();
    processes[0]!.respond = request => nativeReply(request, { hash: 'combat', blocks: anonymizedCombatFrame().filter(value => insideCrop(value, request.crop)) });
    await untilWithdrawn(reader, names, SCREEN_READER_LIMITS.cardHoldMs);
    expect(Date.now()).toBeLessThan(delayedRpc.observedAt! + SCREEN_READER_LIMITS.cardHoldMs);
    const closed = reader.getState();
    expect(closed).toMatchObject({ status: 'waiting-draft', offers: [], advice: null });
    expect(closed.revision).toBeGreaterThan(delayedRpc.revision);
    expect(publications.every((state, index) => index === 0 || state.revision > publications[index - 1]!.revision)).toBe(true);
    expect(newestScreenReaderState(closed, delayedRpc)).toBe(closed);
  });
  it('discovers the observed draft through its real center button when the configured title strip misses the heading', async () => {
    const processes: MockNativeProcess[] = [];
    const spawnProcess: SpawnScreenReader = () => {
      const process = new MockNativeProcess(); processes.push(process);
      process.respond = request => nativeReply(request, { blocks: request.op === 'probe' ? []
        : observedDraftFrame().filter(value => insideCrop(value, request.crop)) });
      return process;
    };
    const { reader } = setup({ autoStart: true, spawnProcess, hintCrop: { x: 0.02, y: 0.03, width: 0.96, height: 0.15 } });
    await vi.advanceTimersByTimeAsync(7000);
    expect(processes[0]!.requests.some(request => request.op === 'read' && JSON.stringify(request.crop) === JSON.stringify(DRAFT_FOOTER_REGION))).toBe(true);
    expect(reader.getState().status).toBe('ready');
    expect(reader.getState().offers.map(value => value.name)).toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
    const fullRequest = processes[0]!.requests.find(isCardRead);
    expect([draftCaptureRegion({ ...DEFAULT_CAPTURE_REGION }), MATCH_CONTEXT_REGION]).toContainEqual(fullRequest?.crop);
  });
  it('creates no worker or capture work while explicitly disabled', async () => {
    const { reader, spawnProcess } = setup({ enabled: false });
    await reader.pollOnce();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(reader.getState()).toMatchObject({ status: 'paused', offers: [], advice: null });
  });
  it('uses hidden pipes, warms with synthetic pixels, then shows cards and a pick from the first current real card view', async () => {
    const { reader, processes, spawnProcess } = setup();
    await reader.pollOnce();
    expect(spawnProcess).toHaveBeenCalledWith('synthetic-test-helper.exe', [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: expect.objectContaining({ DOTNET_GCgen0size: '0x1000000' }) });
    expect(processes[0]?.requests[0]?.op).toBe('fixture');
    // The synthetic warm-up is never shown as game evidence.
    expect(reader.getState()).toMatchObject({ engineReady: true, status: 'waiting-game', offers: [], advice: null });
    await vi.advanceTimersByTimeAsync(500);
    await untilReady(reader);
    expect(reader.getState().offers.map(value => value.name)).toEqual(names);
    expect(reader.getState().offers.map(value => value.position)).toEqual([0, 1, 2]);
    expect(reader.getState().advice?.ranked.map(value => value.position)).toEqual([0, 1, 2]);
    expect(processes[0]!.requests.filter(isCardRead)).toHaveLength(1);
    expect(reader.getState().offers.every(value => value.variant === 'base' && value.bonusIds === null)).toBe(true);
    // Unread bonuses/variants are a caveat, not a reason to withhold the best known card.
    const advice = reader.getState().advice!;
    expect(advice.preferredPosition).not.toBeNull();
    expect(advice.title).toMatch(/^(Pick |Slight edge: |Reroll — or take )/);
    expect(advice.title).toContain(names[advice.preferredPosition!]);
    expect(advice.caveat).toMatch(/not read/i);
    expect(typeof advice.rerollSuggested).toBe('boolean');
    expect(advice.rerollReason).toMatch(/1 reroll left/i);
  });
  it('keeps fresh confirmed cards visible over successive full reads with current draft cues', async () => {
    const { reader } = setup();
    await untilReady(reader);
    for (let count = 0; count < 4; count++) {
      await step(reader);
      expect(reader.getState().status).toBe('ready');
      expect(reader.getState().offers).toHaveLength(3);
      expect(Date.now() - reader.getState().observedAt!).toBeLessThan(SCREEN_READER_LIMITS.captureFreshnessMs);
    }
  });
  it('cannot use a synthetic fixture response as Live offer evidence', async () => {
    const { reader, processes } = setup();
    await step(reader);
    processes[0]!.respond = request => nativeReply(request, { synthetic: true });
    await reader.pollOnce();
    expect(reader.getState().offers).toEqual([]);
    expect(reader.getState().advice).toBeNull();
    expect(reader.getState().status).toBe('unavailable');
    expect(processes[0]!.kill).toHaveBeenCalled();
  });
  it('returns an ordinary absent-game response to waiting without forcing Retry', async () => {
    const { reader, processes } = setup();
    await step(reader);
    processes[0]!.respond = request => {
      const reply = nativeReply(request, { status: 'not_found', gamePresent: false, foreground: false, clientWidth: 0, clientHeight: 0, blocks: [] });
      delete reply.capturedAt; delete reply.hash; return reply;
    };
    await reader.pollOnce();
    expect(reader.getState()).toMatchObject({ status: 'waiting-game', gamePresent: false, offers: [], advice: null });
    expect(processes[0]!.kill).not.toHaveBeenCalled();
  });
  it.each(['not_foreground', 'occluded', 'minimized', 'blank_capture'])('keeps the shown choice through %s, then withdraws it when the card hold lapses', async status => {
    const { reader, processes } = setup();
    await untilReady(reader);
    const shown = reader.getState();
    const background = status === 'not_foreground' || status === 'minimized';
    processes[0]!.respond = request => nativeReply(request, { status, foreground: !background, capturedAt: null, hash: null, blocks: [] });
    // Alt-tabbing to the companion holds the cards longer: nothing can re-read them until the game is back.
    const hold = background ? SCREEN_CARD_BACKGROUND_HOLD_MS : SCREEN_READER_LIMITS.cardHoldMs;
    // Looking at the companion or a covering window does not change the cards in the game.
    while (Date.now() < shown.observedAt! + hold - 1000) {
      await vi.advanceTimersByTimeAsync(500); await reader.pollOnce();
      expect(reader.getState()).toMatchObject({ status: 'ready', generation: shown.generation, observedAt: shown.observedAt });
      expect(reader.getState().offers.map(value => value.name)).toEqual(names);
      expect(reader.getState().advice?.preferredPosition).toBe(shown.advice?.preferredPosition);
    }
    // Interrupted captures never refresh the cards, so they cannot outlive the hold.
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.getState().offers).toEqual([]);
    expect(reader.getState().advice).toBeNull();
  });
  it('clears a previous choice at once when Windows OCR becomes unavailable', async () => {
    const { reader, processes } = setup();
    await untilReady(reader);
    processes[0]!.respond = request => nativeReply(request, { status: 'ocr_unavailable', ocrAvailable: false, capturedAt: null, hash: null, blocks: [] });
    await vi.advanceTimersByTimeAsync(500); await reader.pollOnce();
    expect(reader.getState()).toMatchObject({ status: 'unavailable', offers: [], advice: null });
  });
  it('clears the cards on the first read that shows the game\'s own selections-complete label', async () => {
    const { reader, processes } = setup();
    await untilReady(reader);
    const shown = reader.getState();
    let closedReads = 0;
    processes[0]!.respond = request => {
      if (request.op === 'read') closedReads++;
      return nativeReply(request, { blocks: [block('Selects Complete', 0.2, 0.2, 0.3)] });
    };
    while (closedReads < 1) { await vi.advanceTimersByTimeAsync(250); await reader.pollOnce(); }
    // Unlike a missing title (possibly a transition effect), the label says the picks are done.
    expect(reader.getState()).toMatchObject({ status: 'waiting-draft', offers: [], advice: null });
    expect(reader.getState().generation).toBeGreaterThan(shown.generation);
    expect(Date.now()).toBeLessThan(shown.observedAt! + SCREEN_READER_LIMITS.cardHoldMs);
  });
  it('never shows or refreshes cards from stale or future-dated captured pixels', async () => {
    const { reader, processes } = setup();
    await untilReady(reader);
    const shown = reader.getState();
    for (const offset of [-SCREEN_READER_LIMITS.captureFreshnessMs, 1]) {
      // Different names in out-of-date pixels must never replace or refresh the shown cards.
      processes[0]!.respond = request => nativeReply(request, { capturedAt: Date.now() + offset, hash: `untimely-${offset}`,
        blocks: draftFrame(['Leech', 'Frenzy', 'Spirit Resilience']).filter(value => insideCrop(value, request.crop)) });
      for (let poll = 0; poll < 4; poll++) {
        await vi.advanceTimersByTimeAsync(500); await reader.pollOnce();
        expect(reader.getState().offers.map(value => value.name)).toEqual(names);
        expect(reader.getState()).toMatchObject({ generation: shown.generation, observedAt: shown.observedAt });
      }
    }
    await vi.advanceTimersByTimeAsync(shown.observedAt! + SCREEN_READER_LIMITS.cardHoldMs - Date.now());
    expect(reader.getState()).toMatchObject({ offers: [], advice: null, observedAt: null });
  });
  it('keeps cards through a hung read, then withdraws them when hung workers never confirm them for the hold time', async () => {
    const processes: MockNativeProcess[] = [];
    let hang = false;
    const spawnProcess = vi.fn<SpawnScreenReader>(() => {
      const process = new MockNativeProcess(); processes.push(process);
      process.respond = request => hang && request.op !== 'fixture' ? undefined : nativeReply(request);
      return process;
    });
    const { reader } = setup({ spawnProcess });
    await untilReady(reader);
    const shown = reader.getState();
    hang = true;
    await vi.advanceTimersByTimeAsync(500);
    const work = reader.pollOnce(); await flush();
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.readTimeoutMs);
    await work;
    expect(processes[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    // One slow read restarts the helper but keeps the cards and the pick.
    expect(reader.getState()).toMatchObject({ status: 'ready', generation: shown.generation, observedAt: shown.observedAt });
    expect(reader.getState().advice?.preferredPosition).toBe(shown.advice?.preferredPosition);
    expect(reader.getState().metrics.timeouts).toBe(1);
    // Later restarted helpers hang too; advance time without awaiting their in-flight reads.
    while (Date.now() < shown.observedAt! + SCREEN_READER_LIMITS.cardHoldMs) {
      void reader.pollOnce(); await flush();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(reader.getState().offers).toEqual([]);
    expect(reader.getState().advice).toBeNull();
    expect(reader.getState().metrics.timeouts).toBeLessThan(SCREEN_READER_LIMITS.maxTimeoutsBeforeRetry);
  });
  it('does not extend visible guidance when the system clock moves backwards', async () => {
    const { reader } = setup(); await untilReady(reader);
    vi.setSystemTime(Date.now() - 30_000);
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.cardHoldMs);
    expect(reader.getState().offers).toEqual([]);
    expect(reader.getState().advice).toBeNull();
    expect(reader.getState().status).toBe('waiting-draft');
  });
  it('names a pick for stable enhanced cards while flagging the unread modifier', async () => {
    const { reader, processes } = setup(); await step(reader);
    processes[0]!.respond = request => nativeReply(request, { blocks: [...draftFrame(), block('Enhanced', 0.2, 0.735, 0.12)].filter(value => insideCrop(value, request.crop)) });
    await untilReady(reader);
    expect(reader.getState().offers).toHaveLength(3);
    expect(reader.getState().offers[0]?.variant).toBe('enhanced');
    expect(reader.getState().advice?.preferredPosition).not.toBeNull();
    expect(reader.getState().advice?.caveat).toMatch(/special effects|check them in game/i);
    expect(reader.getState().advice?.limitations.join(' ')).toMatch(/enhanced|modifier/i);
  });
  it('carries an unidentified second bonus slot through to visible comparison limits', async () => {
    const { reader, processes } = setup(); await step(reader);
    processes[0]!.respond = request => nativeReply(request, {
      blocks: [...draftFrame(), block('Bonus!', 0.22, 0.57, 0.09)].filter(value => insideCrop(value, request.crop)),
      icons: isCardRead(request) ? [
        { itemId: 'upgrade_improved_spirit', confidence: 0.98, role: 'bonus', slot: 0, bounds: { x: 0.20, y: 0.53, width: 0.05, height: 0.06 } },
        { itemId: '', confidence: 0, role: 'bonus', slot: 1, bounds: { x: 0.20, y: 0.59, width: 0.05, height: 0.06 } },
      ] : [],
    });
    await untilReady(reader);
    expect(reader.getState().offers[0]?.bonusIds).toBeNull();
    expect(reader.getState().advice?.preferredPosition).not.toBeNull();
    // The read Bonus! marker makes the unidentified second slot a named caveat.
    expect(reader.getState().advice?.caveat).toMatch(/bonus/i);
    expect(reader.getState().advice?.limitations.join(' ')).toMatch(/bonus/i);
  });
  it('replaces the previous generation and its pick as soon as a reroll changes the visible names', async () => {
    const published: ReturnType<Reader['getState']>[] = [];
    const { reader, processes } = setup({ onState: state => published.push(state) }); await untilReady(reader);
    const old = reader.getState();
    const rerolled = ['Leech', 'Frenzy', 'Spirit Resilience'];
    const from = published.length;
    processes[0]!.respond = request => nativeReply(request, { hash: 'changed-card-hash', blocks: draftFrame(rerolled).filter(value => insideCrop(value, request.crop)) });
    let polls = 0;
    while (reader.getState().offers[0]?.name !== 'Leech' && polls++ < 6) { await vi.advanceTimersByTimeAsync(500); await reader.pollOnce(); }
    expect(reader.getState().offers.map(value => value.name)).toEqual(rerolled);
    expect(reader.getState().generation).toBeGreaterThan(old.generation);
    // The very first current read of the rerolled cards replaces them; no second view is awaited.
    expect(polls).toBeLessThanOrEqual(2);
    // No publication ever pairs the new cards with the old advice, or the old cards with new advice.
    for (const state of published.slice(from)) {
      const shownNames = state.offers.map(value => value.name);
      if (state.advice) expect(state.advice.title).toContain(shownNames[state.advice.preferredPosition!]);
      if (shownNames[0] === 'Leech') expect(state.generation).toBeGreaterThan(old.generation);
      else expect(state.generation === old.generation || state.offers.length === 0).toBe(true);
    }
  });
  it('never queues overlapping poll requests', async () => {
    const { reader, processes } = setup(); await step(reader);
    processes[0]!.respond = () => undefined;
    const active = reader.pollOnce(); await flush();
    await Promise.all(Array.from({ length: 40 }, () => reader.pollOnce()));
    expect(processes[0]!.requests).toHaveLength(2);
    const stop = reader.stop(); await flush(); await stop; await active;
    expect(processes[0]!.kill).toHaveBeenCalledTimes(1);
  });
  it('waits for confirmed OS exit before restarting after cancellation', async () => {
    const { reader, processes, spawnProcess } = setup(); await step(reader);
    const process = processes[0]!; process.respond = () => undefined; process.acknowledgeKill = false;
    const active = reader.pollOnce(); await flush();
    let stopped = false, resumed = false;
    const stop = reader.stop().then(() => { stopped = true; }); await flush();
    // Re-enabling uses the same stop barrier: it cannot finish, or spawn, before the OS exit.
    const resume = reader.setEnabled(true).then(() => { resumed = true; }); await flush();
    await reader.pollOnce(); await flush();
    expect(stopped).toBe(false); expect(resumed).toBe(false); expect(spawnProcess).toHaveBeenCalledTimes(1);
    process.confirmExit(); await stop; await active; await resume;
    expect(stopped).toBe(true); expect(resumed).toBe(true);
    await reader.pollOnce();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(processes[1]!.requests[0]?.op).toBe('fixture');
  });
  it('ignores late output after disposal and clears all visible state', async () => {
    const { reader, processes } = setup(); await step(reader);
    processes[0]!.respond = () => undefined;
    const active = reader.pollOnce(); await flush();
    const pendingRequest = processes[0]!.requests.at(-1)!;
    await reader.dispose(); await active;
    processes[0]!.output(nativeReply(pendingRequest)); await flush();
    expect(reader.getState()).toMatchObject({ status: 'paused', enabled: false, offers: [], advice: null, engineReady: false });
    expect(processes[0]!.kill).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch a worker if disabled in the poll dispatch microtask', async () => {
    const { reader, spawnProcess } = setup();
    const poll = reader.pollOnce(); await reader.stop(); await poll;
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it('stops after repeated real-read timeouts even when recovery warmups and probes succeed', async () => {
    const { reader, processes } = setup();
    const limit = SCREEN_READER_LIMITS.maxTimeoutsBeforeRetry;
    for (let count = 0; count < limit; count++) {
      let timedOut = false;
      for (let phase = 0; phase < 16 && !timedOut; phase++) {
        const previousCount = processes.reduce((sum, process) => sum + process.requests.length, 0);
        const work = reader.pollOnce(); await flush();
        const process = processes.at(-1)!;
        process.respond = request => request.op === 'read' ? undefined : nativeReply(request);
        const dispatched = processes.reduce((sum, process) => sum + process.requests.length, 0) > previousCount;
        if (dispatched && process.requests.at(-1)?.op === 'read') {
          await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.readTimeoutMs + 1); await work;
          timedOut = true;
        } else { await work; await vi.advanceTimersByTimeAsync(500); }
      }
      expect(timedOut).toBe(true);
      expect(reader.getState().metrics.timeouts).toBe(count + 1);
      // Single timeouts restart the helper without pausing reading.
      if (count + 1 < limit) expect(reader.getState().status).not.toBe('paused');
      // The restart backoff is at least twice the elapsed (timed-out) read.
      await vi.advanceTimersByTimeAsync(2 * SCREEN_READER_LIMITS.readTimeoutMs + 1000);
    }
    expect(reader.getState().metrics.timeouts).toBe(limit);
    expect(reader.getState().status).toBe('paused');
    expect(processes).toHaveLength(limit);
  });
  it('requests no preview bytes before an explicit deferred preview action', async () => {
    const { reader, processes } = setup(); await untilReady(reader);
    expect(processes[0]!.requests.every(request => request.debugPreview !== true)).toBe(true);
    await reader.preview();
    processes[0]!.respond = request => nativeReply(request, { previewPngBase64: request.debugPreview ? 'iVBORw0KGgo=' : undefined });
    await vi.advanceTimersByTimeAsync(500); await reader.pollOnce();
    expect(processes[0]!.requests.filter(request => request.debugPreview)).toHaveLength(1);
    expect(processes[0]!.requests.find(request => request.debugPreview)?.crop).toEqual({ ...DEFAULT_CAPTURE_REGION });
    expect(reader.getState().previewDataUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
  });
  it('requires a new capture after changing the reading area', async () => {
    const { reader } = setup(); await untilReady(reader);
    await reader.setCrop({ x: 0, y: 0, width: 1, height: 1 });
    expect(reader.getState()).toMatchObject({ offers: [], advice: null, previewDataUrl: null, crop: { x: 0, y: 0, width: 1, height: 1 } });
    await vi.advanceTimersByTimeAsync(500); await untilReady(reader);
    expect(reader.getState().offers.map(value => value.name)).toEqual(names);
  });
});

const nativePath = resolve('native/ScreenReader/publish', process.platform === 'win32' ? 'ScreenReader.exe' : 'ScreenReader');
describe.skipIf(!['win32', 'linux'].includes(process.platform) || !existsSync(nativePath))('published native OCR helper, synthetic pixels only', () => {
  it('recognizes current catalogue offers through actual OCR, crop adapter, parser and limited guidance', async () => {
    vi.useRealTimers();
    const worker = spawn(nativePath, ['--icons', resolve('assets/reader-icons'), '--context-icons', resolve('assets/context-icons')],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: worker.stdout });
    const replies: Record<string, unknown>[] = [];
    let receive: ((reply: Record<string, unknown>) => void) | null = null;
    lines.on('line', line => { const reply = JSON.parse(line) as Record<string, unknown>; replies.push(reply); receive?.(reply); receive = null; });
    worker.stderr.on('data', () => { /* Native diagnostics are not archived. */ });
    let serial = 0;
    const ask = (input: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error('Native synthetic fixture timed out.')), 5000);
      receive = reply => { clearTimeout(timer); resolveReply(reply); };
      worker.stdin.write(`${JSON.stringify({ id: `native-fixture-${++serial}`, ...input })}\n`);
    });
    const expectSyntheticOnly = (reply: ReturnType<typeof normalizeNativeReply>) => {
      expect(reply).toMatchObject({ synthetic: true, gamePresent: false, foreground: false });
      expect(parseScreenMatchObservation(reply, catalog, { sessionId: 'native-fixture-verification', receivedAt: Date.now() })).toBeNull();
    };
    try {
      // Start without a prior draft/round fixture. All native fixtures share an
      // epoch, so warming with a draft first could hide eight-seat bootstrap
      // errors by leaving the matcher in its already recognized Brawl layout.
      const contextFrames: ReturnType<typeof normalizeNativeReply>[] = [];
      for (let frame = 0; frame < 6; frame++) {
        const native = normalizeNativeReply(await ask({ op: 'fixture', fixture: 'scoreboard-no-round', crop: { ...MATCH_CONTEXT_REGION }, context: true }),
          { ...MATCH_CONTEXT_REGION });
        expectSyntheticOnly(native);
        expect(native.context).toBeDefined();
        contextFrames.push(native);
      }
      const nativeContexts = contextFrames.map(frame => frame.context!);
      expect(nativeContexts.some(context => context.panel === 'scoreboard'
        && context.regions.some(region => region.kind === 'roster' && region.slotCount === 8))).toBe(true);
      const recognizedSeats = new Set(nativeContexts.flatMap(context => context.heroes
        .filter(hero => hero.role === 'roster' && hero.status === 'recognized' && hero.heroId && hero.confidence >= .94)
        .map(hero => hero.seat)));
      expect([...recognizedSeats].sort((a, b) => a! - b!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      // Source-shaped fixtures compose badges, name/header rows, scaled own
      // signatures and two-column item grids. No raw 20px/y174 shortcut is used.
      expect(nativeContexts.some(context => context.heroes.some(hero => hero.role === 'local'
        && hero.status === 'recognized' && hero.heroId === 'hero_chrono' && hero.confidence >= .94))).toBe(true);
      expect(nativeContexts.some(context => context.abilities.map(ability => ability.slot).sort().join(',') === '0,1,2,3')).toBe(true);
      // An eight-seat board is Street Brawl's: its item grid is read by the fixed-layout Brawl reader (context.brawl),
      // so the older 6v6 pose search no longer spends its 40-100 ms slice on it and emits no player-inventory items.
      const knownItems = nativeContexts.flatMap(context => context.items.filter(item => item.role === 'player-inventory' && item.status === 'recognized'));
      expect(knownItems).toEqual([]);
      const inventoryRegions = nativeContexts.flatMap(context => context.regions.filter(region => region.kind === 'inventory'));
      expect(inventoryRegions.length).toBeGreaterThan(0);
      expect(inventoryRegions.every(region => region.complete === false)).toBe(true);

      for (const crop of [{ x: 0, y: 0, width: 1, height: 1 }, { ...DEFAULT_CAPTURE_REGION }, { x: 0.02, y: 0.02, width: 0.96, height: 0.90 }]) {
        const raw = await ask({ op: 'fixture', fixture: 'draft', crop, context: true });
        const reply = normalizeNativeReply(raw, crop);
        expect(reply).toMatchObject({ synthetic: true, gamePresent: false, foreground: false, ocrAvailable: true });
        expectSyntheticOnly(reply);
        expect(reply.context).toMatchObject({ sessionId: 'synthetic-fixture' });
        expect(Array.isArray(reply.context!.heroes)).toBe(true);
        expect(Array.isArray(reply.context!.items)).toBe(true);
        expect(Array.isArray(reply.context!.abilities)).toBe(true);
        expect(Array.isArray(reply.context!.regions)).toBe(true);
        // Offline review emits no capture time. Its actual OCR/context shape may
        // normalize for inspection, but it must never become match evidence.
        const offline = normalizeNativeReply({ ...raw, capturedAt: null }, crop);
        expect(offline.capturedAt).toBeNull();
        expectSyntheticOnly(offline);
        expect(reply.ocrLanguage).toBeTruthy();
        const parsed = parseScreenOffers(blocksForScreenParser(reply), catalog);
        expect(parsed.offers.map(value => value.name)).toEqual(names);
        expect(parsed.offers.map(value => value.position)).toEqual([0, 1, 2]);
        expect(parsed.incomplete).toBe(false);
        const advice = evaluateScreenOffers(parsed.offers, catalog, { heroId: parsed.heroId, round: parsed.round, rerolls: parsed.rerolls });
        expect(advice?.ranked).toHaveLength(3);
        expect(advice?.limitations.join(' ')).toMatch(/heuristic|not win odds/i);
        // Unread bonuses keep the best known card named, with a caveat instead of a withheld pick.
        const flagged = evaluateScreenOffers(parsed.offers.map((value, position) => position === 0 ? { ...value, bonusIds: null, warning: 'Bonus items are unread.' } : value), catalog, { heroId: null, round: null, rerolls: null });
        expect(flagged?.preferredPosition).not.toBeNull();
        expect(flagged?.caveat).toMatch(/not read/i);
        const productionParsed = parseScreenOffers(blocksForScreenParser(reply), catalog, { conservativeUnmarkedDetails: true });
        expect(productionParsed.offers.map(value => value.name)).toEqual(names);
        expect(productionParsed.incomplete).toBe(true);
        expect(productionParsed.offers.every(value => value.variant === 'base' && value.bonusIds === null)).toBe(true);
        const production = evaluateScreenOffers(productionParsed.offers, catalog, { heroId: null, round: null, rerolls: null });
        expect(production?.preferredPosition).not.toBeNull();
        expect(production?.caveat).toMatch(/not read/i);
      }
      for (const fixture of ['combat', 'blank']) {
        const reply = normalizeNativeReply(await ask({ op: 'fixture', fixture, crop: { x: 0, y: 0, width: 1, height: 1 }, context: true }),
          { x: 0, y: 0, width: 1, height: 1 });
        expectSyntheticOnly(reply);
        expect(reply.context).toBeDefined();
        expect(parseScreenOffers(blocksForScreenParser(reply), catalog).offers).toEqual([]);
      }
      // The file replay mode is a CLI development command. It is not a JSONL
      // operation or a permitted request field, even on a synthetic fixture.
      expect(await ask({ op: 'review-image' })).toMatchObject({ status: 'invalid_request', gamePresent: false, foreground: false });
      expect(await ask({ op: 'fixture', context: true, reviewImagePath: 'C:/synthetic-fixture/not-read.png' }))
        .toMatchObject({ status: 'invalid_request', gamePresent: false, foreground: false });
      expect(replies.every(reply => reply.previewPngBase64 === undefined && reply.previewPng === undefined)).toBe(true);
      await ask({ op: 'stop' });
    } finally {
      worker.stdin.end();
      if (worker.exitCode === null) worker.kill();
      await new Promise<void>(resolveExit => { if (worker.exitCode !== null) resolveExit(); else worker.once('exit', () => resolveExit()); });
      lines.close();
    }
  }, 15_000);
});
