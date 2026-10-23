import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { availableParallelism } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { Catalog } from '../src/shared/types';
import {
  cardHoldMs, createInitialScreenReaderState, DEFAULT_CAPTURE_REGION, SCREEN_CAPTURE_FRESHNESS_MS, SCREEN_CARD_HOLD_MS, SCREEN_CONTEXT_MAX_AGE_MS, validateCaptureRegion, isScreenLayoutId,
  type CaptureRegion, type NativeOcrBlock, type NativeReadResult, type NativeScreenContext,
  type ScreenOffer, type ScreenOfferParseResult, type ScreenReaderState,
} from '../src/shared/screen-reading';
import { detectDraftClosed, detectDraftHint, cardSlotAt, draftChoiceStage, namedItemCenters, parseScreenOffers, SELECTIONS_COMPLETE_MESSAGE } from '../src/screen/offer-parser';
import { evaluateScreenOffers } from '../src/screen/screen-advice';
import { detectScoreboardHint, parseScreenMatchObservation } from '../src/screen/match-parser';
import { expireScreenMatchContext, forgetMatchRound, reduceScreenMatchContext, resetScreenMatchContext, SPECTATOR_HOLD_MS } from '../src/screen/match-state';
import { evaluateAbilityUpgrade } from '../src/screen/ability-advice';
import { createRosterTracker, currentLocalHero } from '../src/screen/draft-roster';
import { createBuildTracker } from '../src/screen/build-tracker';
import { abilityPlan } from '../src/screen/ability-plan';
import { matchInsights } from '../src/screen/match-insights';
import { streetBrawlData } from '../src/screen/street-brawl-data';

/** These are scheduling/cancellation limits, not a CPU, GPU or FPS guarantee. */
export const SCREEN_READER_LIMITS = Object.freeze({
  // A full-window OCR read on one below-normal core competes with the running game.
  // A 250 ms deadline killed and restarted the helper in the middle of real drafts.
  startupTimeoutMs: 8_000, readTimeoutMs: 3_000, probeTimeoutMs: 2_000,
  captureFreshnessMs: SCREEN_CAPTURE_FRESHNESS_MS, cardHoldMs: SCREEN_CARD_HOLD_MS, readSpacingMs: 500, phaseSpacingMs: 1_000,
  contextDiscoverySpacingMs: 10_000,
  maxWorkerWallShare: 0.3, textBufferBytes: 500_000, previewBufferBytes: 12_000_000,
  // While a draft is on screen the player is waiting on every read: read twice as often for those
  // 10-25 seconds (about half of one below-normal core), and at the usual pace otherwise.
  draftReadSpacingMs: 250, draftWorkerWallShare: 0.5,
  /** No diagnostic screenshot this soon after a draft appears, so it never delays the first cards. */
  draftFrameQuietMs: 3_000,
  stopTimeoutMs: 5_000, maxTimeoutsBeforeRetry: 5, cpuPressurePercent: 75,
  /** Consecutive reads without a draft cue before shown cards are withdrawn. */
  draftCueMissesToClose: 2,
  /** Minimum spacing between saved diagnostic draft frames. */
  frameCaptureSpacingMs: 15_000,
  /** Most idle time a slow read can add before the next one (2026-10-18: a 2.8 s read was followed by a 9.3 s pause). */
  maxIdleAfterReadMs: 2_000, draftMaxIdleAfterReadMs: 1_000,
  /** Read spacing outside a match (hideout, menus, queue, post-match): the next match's loading screen lasts far longer. */
  outsideReadSpacingMs: 3_000,
  /** One full-window diagnostic snapshot (HUD, scoreboard or draft) at most this often. */
  snapshotSpacingMs: 45_000,
});
/** Shown between matches; the last match's build and roster stay on screen until the next match starts. */
export const OUTSIDE_MESSAGE = 'Not in a match. The last match stays shown until the next one starts.';
/** A missing game window resets the match only after this long (a fullscreen toggle or a crash and rejoin keeps it). */
export const GAME_GONE_MS = 15_000;

/**
 * The death screen: the HUD belongs to the teammate being watched. The native reader's spectator
 * verdict missed 25 of 41 real death-screen reads, which show "Respawn in: NN" and "Next player"
 * (OCR: "Next plyer"). A visible item draft is always your own.
 */
export function deathScreen(reply: Pick<NativeReadResult, 'blocks' | 'context'>, draftCue: boolean): boolean {
  if (draftCue) return false;
  if (reply.context?.viewMode === 'spectator') return true;
  return reply.blocks.some(block => {
    const key = block.text.toUpperCase().replace(/[^A-Z]/g, '');
    if (key.includes('SPECTATING')) return true;
    const middle = !block.bounds || (block.bounds.y > 0.3 && block.bounds.y < 0.95);
    return middle && (key.includes('RESPAWNIN') || /(?:NEXT|PREVIOUS)PL[A-Z]{0,2}YER/.test(key));
  });
}

/** One reader decision, written to the local diagnostics log for troubleshooting. */
export type ScreenReaderTrace = Record<string, unknown>;
export const DRAFT_HINT_REGION: Readonly<CaptureRegion> = Object.freeze({ x: 0, y: 0, width: 1, height: 0.35 });
export const DRAFT_FOOTER_REGION: Readonly<CaptureRegion> = Object.freeze({ x: 0, y: 0.6, width: 1, height: 0.4 });
export const MATCH_CONTEXT_REGION: Readonly<CaptureRegion> = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
/** Include closing draft controls, even when the selected card area excludes them. */
export function draftCaptureRegion(cards: CaptureRegion): CaptureRegion {
  const x = Math.min(cards.x, DRAFT_FOOTER_REGION.x);
  const y = Math.min(cards.y, DRAFT_FOOTER_REGION.y);
  return { x, y, width: Math.max(cards.x + cards.width, DRAFT_FOOTER_REGION.x + DRAFT_FOOTER_REGION.width) - x,
    height: Math.max(cards.y + cards.height, DRAFT_FOOTER_REGION.y + DRAFT_FOOTER_REGION.height) - y };
}

export interface ScreenReaderProcess extends Pick<EventEmitter, 'on' | 'once' | 'off'> {
  stdin: Pick<Writable, 'write' | 'end' | 'on' | 'off'>;
  stdout: Pick<Readable, 'on' | 'off'>;
  stderr: Pick<Readable, 'on' | 'off'>;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SpawnScreenReader = (path: string, args: string[], options: {
  windowsHide: true; shell: false; stdio: ['pipe', 'pipe', 'pipe']; env?: NodeJS.ProcessEnv;
}) => ScreenReaderProcess;
export interface ScreenReaderOptions {
  helperPath: string; iconDirectory?: string; contextIconDirectory?: string; catalog: Catalog; initialCrop?: CaptureRegion;
  /** Exact local aliases are correlated by the parser; never a guessed server identity. */
  localPlayerNames?: string[];
  onState?: (state: ScreenReaderState) => void;
  now?: () => number;
  /** Inject a monotonic clock for deterministic tests; production uses performance.now(). */
  monotonicNow?: () => number;
  spawnProcess?: SpawnScreenReader;
  autoStart?: boolean; enabled?: boolean; hintCrop?: CaptureRegion;
  /** Receives one summary per read (status, timing, read text, decision) for the local log. */
  onTrace?: (entry: ScreenReaderTrace) => void;
  /** Receives an occasional PNG of a draft read so misreads can be replayed offline. */
  onDraftFrame?: (png: string, entry: ScreenReaderTrace) => void;
}
export interface NormalizedNativeReply extends NativeReadResult { synthetic: boolean; unchanged: boolean }

const statuses = new Set(['ok', 'unchanged', 'not_found', 'no_window', 'not_foreground', 'minimized',
  'occluded', 'offscreen', 'blank_capture', 'ocr_unavailable', 'capture_failed', 'invalid_request', 'stopped']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid screen-reader reply.');
  return value as Record<string, unknown>;
}
function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new TypeError('Invalid screen-reader number.');
  return value;
}
function text(value: unknown, maximum = 1_024): string {
  if (typeof value !== 'string' || value.length > maximum) throw new TypeError('Invalid screen-reader text.');
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Invalid screen-reader flag.');
  return value;
}
function nativeRegion(value: unknown, allowEmpty = false): CaptureRegion {
  const data = object(value);
  const result = { x: number(data.x, 0, 1), y: number(data.y, 0, 1), width: number(data.width, 0, 1), height: number(data.height, 0, 1) };
  if ((!allowEmpty && (!result.width || !result.height)) || result.x + result.width > 1.00001 || result.y + result.height > 1.00001) {
    throw new TypeError('Invalid screen-reader bounds.');
  }
  return result;
}
function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new TypeError('Invalid screen-reader context role.');
  return value as T;
}
function integer(value: unknown, maximum: number): number {
  const result = number(value, 0, maximum);
  if (!Number.isInteger(result)) throw new TypeError('Invalid screen-reader context slot.');
  return result;
}
function normalizeNativeContext(value: unknown): NativeScreenContext {
  const context = object(value);
  function list(key: string, limit: number): Record<string, unknown>[] {
    const values = context[key];
    if (!Array.isArray(values) || values.length > limit) throw new TypeError('Too much screen-reader context.');
    return values.map(object);
  }
  const seat = (record: Record<string, unknown>) => record.seat === undefined && record.playerSeat === undefined ? {}
    // Native can report an unsupported twelve-column surface. The Brawl parser
    // must withhold it; it is not a broken worker protocol.
    : { seat: integer(record.seat ?? record.playerSeat, 11) };
  const confidence = (record: Record<string, unknown>) => number(record.confidence, 0, 1);
  const nullableNumber = (value: unknown, max: number) => value === undefined || value === null ? null : integer(value, max);
  const layout = (record: Record<string, unknown>) => {
    if (record.layoutId === undefined) return {};
    if (!isScreenLayoutId(record.layoutId)) throw new TypeError('Invalid inventory layout epoch.');
    return { layoutId: record.layoutId };
  };
  return {
    ...(context.sessionId === undefined ? {} : { sessionId: text(context.sessionId, 128) }),
    panel: choice(context.panel, ['hud', 'scoreboard', 'draft', 'post-match', 'unknown']),
    viewMode: context.viewMode === undefined ? 'unknown' : choice(context.viewMode, ['participant', 'spectator', 'unknown']),
    heroes: list('heroes', 16).map(hero => ({ heroId: hero.heroId === undefined || hero.heroId === null ? null : text(hero.heroId, 128),
      status: choice(hero.status, ['recognized', 'unknown', 'hidden']), confidence: confidence(hero), bounds: nativeRegion(hero.bounds),
      role: choice(hero.role, ['roster', 'local']), ...seat(hero),
      ...(hero.team === undefined ? {} : { team: hero.team === null ? null : integer(hero.team, 1) as 0 | 1 }),
      ...(hero.isLocal === undefined ? {} : { isLocal: bool(hero.isLocal) }) })),
    items: list('items', 256).map(item => ({ itemId: item.itemId === undefined || item.itemId === null ? null : text(item.itemId, 128),
      status: choice(item.status, ['recognized', 'unknown', 'empty', 'hidden']), confidence: confidence(item), bounds: nativeRegion(item.bounds),
      role: choice(item.role, ['local-inventory', 'player-inventory']), ...seat(item), slot: integer(item.slot, 255),
      ...(item.variant === undefined ? {} : { variant: choice(item.variant, ['base', 'enhanced', 'legendary', 'corrupted', 'unknown']) }),
      ...(item.quantity === undefined ? {} : { quantity: nullableNumber(item.quantity, 1_000_000) }) })),
    abilities: list('abilities', 4).map(ability => ({ slot: integer(ability.slot, 3) as 0 | 1 | 2 | 3,
      rank: nullableNumber(ability.rank, 3), unlocked: ability.unlocked === undefined || ability.unlocked === null ? null : bool(ability.unlocked),
      nextUpgradeCost: nullableNumber(ability.nextUpgradeCost, 1_000), confidence: confidence(ability), bounds: nativeRegion(ability.bounds) })),
    regions: list('regions', 64).map(region => ({ kind: choice(region.kind, ['roster', 'local-hero', 'inventory', 'abilities', 'ability-points', 'scoreboard']),
      bounds: nativeRegion(region.bounds), complete: bool(region.complete), ...seat(region), ...layout(region),
      ...(region.slotCount === undefined ? {} : { slotCount: integer(region.slotCount, 256) }) })),
    ...(context.brawl === undefined || context.brawl === null ? {} : (() => {
      const brawl = object(context.brawl);
      const entries = (key: string, limit: number) => {
        const values = brawl[key];
        if (!Array.isArray(values) || values.length > limit) throw new TypeError('Too many Street Brawl items.');
        return values.map(object);
      };
      const ranks = brawl.abilityRanks;
      return { brawl: {
        myItems: entries('myItems', 16).map(item => ({ slot: integer(item.slot, 15), itemId: text(item.itemId, 128), confidence: confidence(item) })),
        myOccupied: brawl.myOccupied === undefined || brawl.myOccupied === null ? null : integer(brawl.myOccupied, 16),
        // Late-game seats hold up to 16 items in 8 scoreboard rows.
        playerItems: entries('playerItems', 128).map(item => ({ seat: integer(item.seat, 7), slot: integer(item.slot, 15), itemId: text(item.itemId, 128), confidence: confidence(item) })),
        // A column covered by the cursor or a tooltip is null; the others still count.
        abilityRanks: ranks === undefined || ranks === null ? null : (() => {
          if (!Array.isArray(ranks) || ranks.length !== 4) throw new TypeError('Invalid ability ranks.');
          return ranks.map(rank => rank === null ? null : integer(rank, 3));
        })(),
        hiddenItems: brawl.hiddenItems === undefined ? 0 : integer(brawl.hiddenItems, 128),
        roundPips: brawl.roundPips === undefined || brawl.roundPips === null ? null : (() => {
          const pips = brawl.roundPips;
          if (!Array.isArray(pips) || pips.length !== 2) throw new TypeError('Invalid round pips.');
          return [integer(pips[0], 3), integer(pips[1], 3)] as [number, number];
        })(),
      } };
    })()),
    ...(context.abilityPoints === undefined || context.abilityPoints === null ? {} : (() => {
      const budget = object(context.abilityPoints);
      return { abilityPoints: { value: nullableNumber(budget.value, 1_000), confidence: confidence(budget), bounds: nativeRegion(budget.bounds) } };
    })()),
  };
}

/** The helper sends full-client bounds. Only these flat fields are crop-relative. */
export function normalizeNativeReply(input: unknown, requestedCrop: CaptureRegion = { ...DEFAULT_CAPTURE_REGION }): NormalizedNativeReply {
  const data = object(input);
  if (data.protocol !== 1 || !statuses.has(text(data.status, 40))) throw new TypeError('Unsupported screen-reader protocol.');
  const crop = data.crop === undefined ? { ...requestedCrop } : nativeRegion(data.crop);
  const clientWidth = number(data.clientWidth, 0, 16_384);
  const clientHeight = number(data.clientHeight, 0, 16_384);
  if (!Number.isInteger(clientWidth) || !Number.isInteger(clientHeight)) throw new TypeError('Invalid game-client size.');
  if (!Array.isArray(data.blocks) || data.blocks.length > 256) throw new TypeError('Too many screen-reader blocks.');
  const blocks = data.blocks.map(value => {
    const block = object(value);
    const bounds = nativeRegion(block.bounds, true);
    const words = block.words === undefined ? undefined : (() => {
      if (!Array.isArray(block.words) || block.words.length > 64) throw new TypeError('Too many screen-reader words.');
      return block.words.map(value => { const word = object(value); return { text: text(word.text), bounds: nativeRegion(word.bounds, true) }; });
    })();
    return { text: text(block.text), bounds, words,
      x: (bounds.x - crop.x) / crop.width, y: (bounds.y - crop.y) / crop.height,
      width: bounds.width / crop.width, height: bounds.height / crop.height };
  });
  let icons: NativeReadResult['icons'];
  if (data.icons !== undefined) {
    if (!Array.isArray(data.icons) || data.icons.length > 32) throw new TypeError('Too many screen-reader icons.');
    icons = data.icons.map(value => {
      const icon = object(value);
      if (icon.role !== undefined && icon.role !== 'bonus') throw new TypeError('Invalid icon role.');
      if (icon.slot !== undefined && icon.slot !== 0 && icon.slot !== 1) throw new TypeError('Invalid icon slot.');
      return { itemId: text(icon.itemId, 128), confidence: number(icon.confidence, 0, 1), bounds: nativeRegion(icon.bounds),
        ...(icon.role === 'bonus' ? { role: 'bonus' as const } : {}),
        ...(icon.slot === 0 || icon.slot === 1 ? { slot: icon.slot } : {}) };
    });
  }
  const metricsData = data.metrics === undefined || data.metrics === null ? null : object(data.metrics);
  const metrics: NativeReadResult['metrics'] = metricsData ? {} : undefined;
  for (const key of ['cpuMs', 'workingSetMb', 'privateMemoryMb', 'captureMs', 'ocrMs'] as const) {
    if (metricsData?.[key] !== undefined) metrics![key] = number(metricsData[key], 0, 1_000_000);
  }
  const unchanged = data.unchanged === undefined ? data.status === 'unchanged' : bool(data.unchanged);
  if (metrics) metrics.unchanged = unchanged;
  const preview = data.previewPng ?? data.previewPngBase64;
  const previewPng = preview === undefined || preview === null ? null : text(preview, SCREEN_READER_LIMITS.previewBufferBytes);
  // A base64 round trip checks the alphabet and padding in a few milliseconds; a regex over a 5 MB
  // screenshot took 16.
  if (previewPng && (!previewPng.startsWith('iVBORw0KGgo') || previewPng.length % 4 !== 0
    || Buffer.from(previewPng, 'base64').toString('base64') !== previewPng)) throw new TypeError('Invalid screen preview.');
  return {
    protocol: 1, id: text(data.id, 128), status: data.status as string,
    gamePresent: bool(data.gamePresent), foreground: bool(data.foreground), clientWidth, clientHeight,
    clientLeft: data.clientLeft === undefined || data.clientLeft === null ? null : number(data.clientLeft, -65_536, 65_536),
    clientTop: data.clientTop === undefined || data.clientTop === null ? null : number(data.clientTop, -65_536, 65_536),
    capturedAt: data.capturedAt === undefined || data.capturedAt === null ? null : number(data.capturedAt), elapsedMs: number(data.elapsedMs, 0, 120_000),
    hash: data.hash === undefined || data.hash === null ? null : text(data.hash, 128), blocks, icons, crop, metrics,
    ...(data.context === undefined || data.context === null ? {} : { context: normalizeNativeContext(data.context) }),
    ocrAvailable: data.ocrAvailable === undefined ? undefined : bool(data.ocrAvailable),
    ocrLanguage: data.ocrLanguage === undefined || data.ocrLanguage === null ? null : text(data.ocrLanguage, 40),
    errorCode: data.errorCode === undefined || data.errorCode === null ? null : text(data.errorCode, 128), previewPng,
    synthetic: data.synthetic === undefined ? false : bool(data.synthetic), unchanged,
  };
}

/** Windows OCR may join different cards in one line. Word geometry keeps them separate. */
export function blocksForScreenParser(reply: NativeReadResult): NativeOcrBlock[] {
  const crop = reply.crop ?? { ...DEFAULT_CAPTURE_REGION };
  const blocks: NativeOcrBlock[] = [];
  for (const block of reply.blocks) {
    if (!block.words?.length) blocks.push(block);
    else for (const word of block.words) {
      blocks.push({ text: word.text, bounds: word.bounds,
        x: (word.bounds.x - crop.x) / crop.width, y: (word.bounds.y - crop.y) / crop.height,
        width: word.bounds.width / crop.width, height: word.bounds.height / crop.height });
      if (blocks.length > 512) return blocks; // The parser explicitly marks truncated frames incomplete.
    }
    if (blocks.length > 512) return blocks;
  }
  return blocks;
}

class ReaderFailure extends Error {
  constructor(readonly kind: 'timeout' | 'interrupted' | 'protocol' | 'process') { super(kind); }
}
type Operation = 'probe' | 'read' | 'fixture';
interface PendingRequest {
  id: string; operation: Operation; crop: CaptureRegion; debug: boolean;
  startedAt: number; deadlineMs: number; timer: ReturnType<typeof setTimeout>;
  resolve: (reply: NormalizedNativeReply) => void; reject: (failure: ReaderFailure) => void;
}
interface Helper {
  process: ScreenReaderProcess; exit: Promise<void>; resolveExit: () => void;
  exited: boolean; buffer: string; bufferedBytes: number; decoder: StringDecoder;
}

export function createScreenReader(options: ScreenReaderOptions) {
  if (!options.helperPath || options.helperPath.includes('\0')) throw new TypeError('A native screen-reader path is required.');
  const epochNow = options.now ?? Date.now;
  const wallNow = options.monotonicNow ?? options.now ?? (() => performance.now());
  let contextEpochAnchor = epochNow();
  let contextWallAnchor = wallNow();
  // An adjusted system clock cannot prolong the lifetime of already captured pixels.
  const contextNow = () => Math.max(epochNow(), contextEpochAnchor + Math.max(0, wallNow() - contextWallAnchor));
  const spawnProcess: SpawnScreenReader = options.spawnProcess ?? ((path, args, settings) => spawn(path, args, settings));
  const hintCrop = validateCaptureRegion(options.hintCrop ?? { ...DRAFT_HINT_REGION });
  let state = createInitialScreenReaderState(validateCaptureRegion(options.initialCrop ?? { ...DEFAULT_CAPTURE_REGION }));
  const readerSessionId = randomUUID();
  state.enabled = options.enabled ?? true;
  if (!state.enabled) { state.status = 'paused'; state.message = 'Screen reading is off.'; }
  const listeners = new Set<(state: ScreenReaderState) => void>();
  if (options.onState) listeners.add(options.onState);
  let disposed = false;
  let epoch = 0;
  let requestId = 0;
  let helper: Helper | null = null;
  let pending: PendingRequest | null = null;
  let stopping: Promise<boolean> | null = null;
  let terminationFailed = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let contextExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let loopStarted = options.autoStart !== false;
  let nextRequestAt = 0;
  let hintAt: number | null = null;
  let lastHintStart = -Infinity;
  let draftHint = false;
  /** When the current draft was first seen (wall clock). */
  let draftSeenAt = -Infinity;
  /** The earliest the next read may start under the draft pace, after the last read. */
  let draftPaceAt = 0;
  let candidate: { signature: string; count: number; lastSeenAt: number;
    context: { heroId: string | null; round: number | null; rerolls: number | null } } | null = null;
  let confirmationStartedAt: number | null = null;
  let mainCandidate: { signature: string; count: number; lastSeenAt: number } | null = null;
  let fullReadDue = false;
  let footerFallbackDue = false;
  let scoreboardReadDue = false;
  let lastFullContextAt = -Infinity;
  let nextContextDiscoveryAt = wallNow() + SCREEN_READER_LIMITS.contextDiscoverySpacingMs;
  let lastCardParse: ScreenOfferParseResult | null = null;
  /** A read that disagrees with shown cards: the cards it read, until a second read agrees (tooltip misreads flip one card). */
  let pendingReplace: Map<number, string> | null = null;
  /** The cards shown for the current "Choice N of 3", and those of the previous choice. When the next choice opens,
   * the picked card stays on screen while the new cards deal in: it is the pick, and never one of the new cards. */
  /** byPosition: the item shown on each card (empty when unread); pick: the card credited as picked from it. */
  type ChoiceSet = { stage: number | null; round: number | null; ids: string[]; byPosition: string[]; credited: boolean; pick?: string };
  let choiceSet: ChoiceSet | null = null;
  let previousChoiceSet: ChoiceSet | null = null;
  /** When the current "Choice N of 3" was first seen (capture time): its first frames still show the leaving pick. */
  let stageOpened: { stage: number; at: number } | null = null;
  /** The last choice's cards when the draft closed: the third pick lingers on screen then too. */
  let closingSet: { set: ChoiceSet; at: number } | null = null;
  /** A card of the leaving set read at its own place, waiting for a second read before it is credited. */
  let lingerCandidate: { set: ChoiceSet; itemId: string; count: number } | null = null;
  /** The game window answered with a capture while not in front (the native reader allows a visible background window). */
  let backgroundReadable = false;
  const roster = createRosterTracker(options.catalog, { localPlayerNames: options.localPlayerNames });
  const build = createBuildTracker();
  /** Enemy seats' items, given which side of the top bar you are on. */
  const enemyItems = () => {
    const known = roster.snapshot(); const seats = build.snapshot().seatItems;
    return known.localSide === 0 ? seats.slice(4).flat() : known.localSide === 1 ? seats.slice(0, 4).flat() : [];
  };
  /** Rerolls left this round: read from "N Re-Roll(s) Remaining", or counted down when the
   * cards change while the same "Choice N of 3" stays open. Reset when the round changes. */
  const rerolls: { count: number | null; stage: string | null; round: number | null } = { count: null, stage: null, round: null };
  let lastClientSize: string | null = null;
  let lastInsightsKey: string | null = null;
  /** The upgrade panel (Tab held) was on the last read: read the bottom strip again soon, since ranks change right then. */
  let panelReadDue = false;
  /** When the game window was first missing; match knowledge survives a brief loss (fullscreen toggle, crash and rejoin). */
  let absentSince: number | null = null;
  let previewPending = false;
  let timeoutsSinceRetry = 0;
  let retryRequired = false;
  let pressurePaused = false;
  let workloadPressured = false;
  let lastCpuAt: number | null = null;
  const cpuSamples: { cpuMs: number; wallMs: number }[] = [];
  let cueMisses = 0;
  let lastFrameCaptureAt = -Infinity;
  let lastSnapshotAt = -Infinity;
  /** Decision notes for the current read; emitted once through onTrace. */
  let trace: ScreenReaderTrace | null = null;
  const note = (key: string, value: unknown) => { if (trace) trace[key] = value; };

  const snapshot = (): ScreenReaderState => structuredClone(state);
  function publish(patch: Partial<ScreenReaderState> = {}) {
    // A patch that repeats the current values (the per-read foreground flag, an unchanged status) is not news.
    const keys = Object.keys(patch) as (keyof ScreenReaderState)[];
    const same = (a: unknown, b: unknown) => Object.is(a, b) || (Array.isArray(a) && Array.isArray(b) && a.length === 0 && b.length === 0);
    if (keys.length > 0 && keys.every(key => same(state[key], patch[key]))) return;
    state = { ...state, ...patch, revision: state.revision + 1 };
    for (const listener of listeners) { try { listener(snapshot()); } catch { /* A UI subscriber must not break acquisition. */ } }
  }
  function clearTimer(timer: 'loop' | 'expiry') {
    if (timer === 'loop') { if (loopTimer !== null) clearTimeout(loopTimer); loopTimer = null; }
    else { if (expiryTimer !== null) clearTimeout(expiryTimer); expiryTimer = null; }
  }
  function clearDecision(message: string, status: ScreenReaderState['status'], clearCandidate = true, extra: Partial<ScreenReaderState> = {}) {
    clearTimer('expiry');
    const changed = state.offers.length > 0 || state.advice !== null || state.observedAt !== null || (clearCandidate && candidate !== null);
    if (clearCandidate) { candidate = null; mainCandidate = null; confirmationStartedAt = null; }
    lastCardParse = null;
    publish({ ...extra, message, status, offers: [], advice: null, heroId: null, observedAt: null,
      generation: state.generation + (changed ? 1 : 0) });
  }
  function fence(message: string, status: ScreenReaderState['status']) {
    epoch++;
    contextEpochAnchor = epochNow(); contextWallAnchor = wallNow();
    draftHint = false; hintAt = null; lastHintStart = -Infinity; lastClientSize = null; fullReadDue = false; footerFallbackDue = false;
    scoreboardReadDue = false; lastFullContextAt = -Infinity; cueMisses = 0;
    nextContextDiscoveryAt = wallNow() + SCREEN_READER_LIMITS.contextDiscoverySpacingMs;
    if (contextExpiryTimer !== null) clearTimeout(contextExpiryTimer); contextExpiryTimer = null;
    // A retired acquisition epoch cannot hydrate a new match context.
    clearDecision(message, status, true, { matchContext: resetScreenMatchContext(state.matchContext), abilityAdvice: null });
  }
  function eligible() { return !disposed && state.enabled && !retryRequired && !pressurePaused && !workloadPressured && !terminationFailed; }
  function schedule() {
    clearTimer('loop');
    if (!loopStarted || !eligible() || stopping || inFlight) return;
    // Node truncates fractional delays. Round upward, and still tolerate an early
    // wake in pollOnce so a single timer cannot permanently end acquisition.
    loopTimer = setTimeout(() => { loopTimer = null; void pollOnce(); }, Math.ceil(Math.max(0, nextRequestAt - wallNow())));
  }
  function rejectPending(kind: ReaderFailure['kind']) {
    if (!pending) return;
    const request = pending; pending = null; clearTimeout(request.timer); request.reject(new ReaderFailure(kind));
  }
  function protocolFailure() { rejectPending('protocol'); void stopHelper(); }
  function launch(): Helper {
    if (helper || stopping || terminationFailed || !eligible()) throw new ReaderFailure('interrupted');
    const args = [...(options.iconDirectory ? ['--icons', options.iconDirectory] : []),
      ...(options.contextIconDirectory ? ['--context-icons', options.contextIconDirectory] : [])];
    // A 16 MB GC nursery halves the helper's peak memory (240 -> 136 MB private) at the same read speed;
    // .NET otherwise sizes it from the CPU cache, which is huge on X3D processors.
    const process = spawnProcess(options.helperPath, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...globalThis.process.env, DOTNET_GCgen0size: '0x1000000' } });
    let resolveExit!: () => void;
    const current: Helper = { process, exit: new Promise<void>(resolve => { resolveExit = resolve; }),
      resolveExit: () => resolveExit(), exited: false, buffer: '', bufferedBytes: 0, decoder: new StringDecoder('utf8') };
    helper = current;
    const onExit = () => {
      if (current.exited) return;
      current.exited = true; current.resolveExit();
      if (helper === current) {
        helper = null; publish({ engineReady: false, gamePresent: false, foreground: false });
        if (!stopping && !disposed && terminationFailed) {
          // A helper that outlived the stop timeout has now exited: nothing is left running, so restart.
          rejectPending('process'); terminationFailed = false; void retry();
        } else if (!stopping && !disposed) {
          rejectPending('process'); retryRequired = true;
          fence('The screen-reader process stopped. Choose Retry to start it again.', 'unavailable');
        }
      }
    };
    process.once('exit', onExit);
    process.once('close', onExit);
    process.once('error', () => {
      rejectPending('process');
      // A failed spawn has no OS process to wait for. A running child still needs termination.
      if (process.exitCode !== null) onExit();
      else void stopHelper();
    });
    process.stdin.on('error', () => { rejectPending('process'); void stopHelper(); });
    process.stdout.on('error', () => { rejectPending('process'); void stopHelper(); });
    process.stderr.on('error', () => { /* Diagnostics are optional; acquisition still uses stdout. */ });
    process.stderr.on('data', () => { /* Drain diagnostics; never record raw frames or OCR text. */ });
    process.stdout.on('data', (chunk: Buffer | string) => {
      if (helper !== current || current.exited) return;
      if (!pending) { current.buffer = ''; current.bufferedBytes = 0; return; }
      current.bufferedBytes += Buffer.byteLength(chunk);
      if (current.bufferedBytes > (pending.debug ? SCREEN_READER_LIMITS.previewBufferBytes : SCREEN_READER_LIMITS.textBufferBytes)) {
        protocolFailure(); return;
      }
      // Search only the new text for a line end: rescanning a multi-megabyte screenshot line on every
      // chunk cost 43 ms of main-thread time per screenshot.
      let searchFrom = current.buffer.length;
      current.buffer += typeof chunk === 'string' ? chunk : current.decoder.write(chunk);
      let newline: number;
      while ((newline = current.buffer.indexOf('\n', searchFrom)) !== -1) {
        searchFrom = 0;
        const line = current.buffer.slice(0, newline).trim();
        current.buffer = current.buffer.slice(newline + 1);
        current.bufferedBytes = Buffer.byteLength(current.buffer);
        if (!line || !pending) continue;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { protocolFailure(); return; }
        // Older IDs can only be delayed output; they cannot satisfy a newer request.
        if (typeof raw !== 'object' || raw === null || (raw as { id?: unknown }).id !== pending.id) continue;
        const request = pending;
        if (wallNow() - request.startedAt >= request.deadlineMs) {
          rejectPending('timeout'); void stopHelper(); return;
        }
        let reply: NormalizedNativeReply;
        try { reply = normalizeNativeReply(raw, request.crop); } catch { protocolFailure(); return; }
        if (Math.max(wallNow() - request.startedAt, reply.elapsedMs) >= request.deadlineMs) {
          rejectPending('timeout'); void stopHelper(); return;
        }
        if (reply.previewPng && !request.debug) { protocolFailure(); return; }
        pending = null; clearTimeout(request.timer); request.resolve(reply);
      }
    });
    return current;
  }

  /** SIGKILL maps to TerminateProcess on Windows. Reuse waits for the OS exit event. */
  function stopHelper(): Promise<boolean> {
    if (stopping) return stopping;
    rejectPending('interrupted');
    const current = helper;
    if (!current || current.exited) return Promise.resolve(true);
    const action = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        current.process.kill('SIGKILL');
        const exited = await Promise.race([
          current.exit.then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), SCREEN_READER_LIMITS.stopTimeoutMs); }),
        ]);
        if (!exited) {
          terminationFailed = true; retryRequired = true;
          fence('The reader could not be stopped safely. Restart the application before reading again.', 'unavailable');
        }
        return exited;
      } catch {
        terminationFailed = true; retryRequired = true;
        fence('The reader could not be stopped safely. Restart the application before reading again.', 'unavailable');
        return false;
      } finally { if (timer !== undefined) clearTimeout(timer); publish({ engineReady: false }); }
    };
    // Install the barrier before kill(), which can synchronously emit exit in test drivers.
    stopping = Promise.resolve().then(action);
    const barrier = stopping;
    void barrier.finally(() => { if (stopping === barrier) stopping = null; schedule(); });
    return barrier;
  }

  function request(operation: Operation, crop: CaptureRegion, debug = false): Promise<NormalizedNativeReply> {
    if (pending || stopping || !eligible()) return Promise.reject(new ReaderFailure('interrupted'));
    const current = helper ?? launch();
    const id = `screen-${epoch}-${++requestId}`;
    const deadlineMs = operation === 'fixture' ? SCREEN_READER_LIMITS.startupTimeoutMs
      : operation === 'probe' ? SCREEN_READER_LIMITS.probeTimeoutMs : SCREEN_READER_LIMITS.readTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rejectPending('timeout'); void stopHelper(); }, deadlineMs);
      pending = { id, operation, crop, debug, startedAt: wallNow(), deadlineMs, timer, resolve, reject };
      current.buffer = ''; current.bufferedBytes = 0;
      try { current.process.stdin.write(`${JSON.stringify({ id, op: operation, crop,
        ...(operation === 'read' || operation === 'fixture' ? { context: true } : {}), ...(debug ? { debugPreview: true } : {}) })}\n`); }
      catch { rejectPending('process'); void stopHelper(); }
    });
  }

  function metrics(reply: NormalizedNativeReply, startedAt: number, operation: Operation) {
    const finishedAt = wallNow();
    const elapsed = Math.max(0, finishedAt - startedAt, reply.elapsedMs);
    const measuredCpu = reply.metrics?.cpuMs;
    if (measuredCpu !== undefined) {
      const wallMs = Math.max(1, elapsed, lastCpuAt === null ? elapsed : finishedAt - lastCpuAt);
      lastCpuAt = finishedAt; cpuSamples.push({ cpuMs: measuredCpu, wallMs });
      if (cpuSamples.length > 8) cpuSamples.shift();
    }
    const oneCoreCpuPercent = cpuSamples.length ? 100 * cpuSamples.reduce((sum, sample) => sum + sample.cpuMs, 0)
      / cpuSamples.reduce((sum, sample) => sum + sample.wallMs, 0) : null;
    const cpuPercent = oneCoreCpuPercent === null ? state.metrics.cpuPercent : Math.round(10 * oneCoreCpuPercent / Math.max(1, availableParallelism())) / 10;
    const memoryMb = reply.metrics?.workingSetMb ?? reply.metrics?.privateMemoryMb ?? state.metrics.memoryMb;
    publish({ readMs: operation === 'read' ? elapsed : state.readMs,
      metrics: { ...state.metrics, reads: state.metrics.reads + (operation === 'read' ? 1 : 0),
        skipped: state.metrics.skipped + (reply.unchanged ? 1 : 0), cpuPercent, memoryMb } });
    // Occupation includes elapsed native work, not its CPU percentage. Idle at least four times that duration.
    const spacing = draftHint ? SCREEN_READER_LIMITS.draftReadSpacingMs : SCREEN_READER_LIMITS.readSpacingMs;
    const share = draftHint ? SCREEN_READER_LIMITS.draftWorkerWallShare : SCREEN_READER_LIMITS.maxWorkerWallShare;
    const idleCap = draftHint ? SCREEN_READER_LIMITS.draftMaxIdleAfterReadMs : SCREEN_READER_LIMITS.maxIdleAfterReadMs;
    nextRequestAt = Math.max(nextRequestAt, startedAt + spacing, finishedAt + Math.min(idleCap, elapsed * (1 / share - 1)));
    draftPaceAt = Math.max(startedAt + SCREEN_READER_LIMITS.draftReadSpacingMs,
      finishedAt + Math.min(SCREEN_READER_LIMITS.draftMaxIdleAfterReadMs, elapsed * (1 / SCREEN_READER_LIMITS.draftWorkerWallShare - 1)));
    const sampleWall = cpuSamples.reduce((sum, sample) => sum + sample.wallMs, 0);
    if (cpuSamples.length >= 5 && sampleWall >= 3_000 && oneCoreCpuPercent !== null && oneCoreCpuPercent > SCREEN_READER_LIMITS.cpuPressurePercent) {
      pressurePaused = true;
      fence('Screen reading paused after sustained helper CPU load. Choose Retry when the game has settled.', 'paused');
    }
  }
  function fresh(reply: NormalizedNativeReply) {
    return reply.capturedAt !== null && epochNow() >= reply.capturedAt && epochNow() - reply.capturedAt < SCREEN_READER_LIMITS.captureFreshnessMs;
  }
  /** Shown cards stay until the draft closes, new cards replace them, or no read confirms them for
   * cardHoldMs (longer while the player has alt-tabbed out of the game, see cardHoldMs()). */
  function armExpiry(observedAt: number) {
    clearTimer('expiry');
    // Cards kept while the game is behind other windows and cannot be read get the longer hold; a game read in the background does not.
    const holdMs = () => state.gamePresent && !state.foreground && !backgroundReadable ? cardHoldMs(state) : SCREEN_READER_LIMITS.cardHoldMs;
    // Age counts only timer time that has passed, so a system clock change can neither extend nor revive the cards.
    let age = Math.max(0, epochNow() - observedAt);
    const schedule = (delay: number) => { expiryTimer = setTimeout(() => { age += delay; check(); }, delay); };
    const check = () => {
      expiryTimer = null;
      if (!state.enabled || disposed || state.observedAt !== observedAt) return;
      const left = holdMs() - age;
      // In the background the deadline shrinks again when the game returns, so check again soon.
      if (left > 0) { schedule(Math.max(1, state.foreground ? left : Math.min(left, 1_000))); return; }
      clearDecision('Waiting for the item-choice screen.', 'waiting-draft');
    };
    schedule(Math.max(1, SCREEN_READER_LIMITS.cardHoldMs - age));
  }
  function adviceFor(parsed: ScreenOfferParseResult, context = state.matchContext) {
    const known = roster.snapshot();
    return evaluateScreenOffers(parsed.offers, options.catalog, {
      heroId: currentLocalHero(known, context.localHeroId, context.observations.localHeroId?.capturedAt, parsed.heroId), round: context.round ?? parsed.round,
      rerolls: rerolls.count ?? parsed.rerolls ?? context.rerollsRemaining, choice: rerolls.stage === null ? null : Number(rerolls.stage),
      enemyHeroIds: known.enemies,
      ownedItemIds: build.snapshot().myItems, enemyItemIds: enemyItems(), matchContext: context, now: contextNow(),
    });
  }
  function currentCardAdvice(context = state.matchContext) {
    if (!lastCardParse || !state.enabled || context.phase === 'finished'
      || state.observedAt === null || epochNow() < state.observedAt
      || epochNow() - state.observedAt >= (state.gamePresent && !state.foreground && !backgroundReadable ? cardHoldMs(state) : SCREEN_READER_LIMITS.cardHoldMs)) return null;
    return adviceFor(lastCardParse, context);
  }
  function trackRerolls(parsed: ScreenOfferParseResult, reply: NormalizedNativeReply, cardsChanged: boolean) {
    const stage = reply.blocks.map(block => block.text.match(/choice\s*(\d)\s*(?:of|\/)\s*3/i)?.[1]).find(Boolean) ?? null;
    // The match state's round (checked and inferred across frames), not this frame's raw title (a "ROUND 13" misread).
    const round = state.matchContext.round ?? parsed.round;
    if (round !== null && rerolls.round !== null && round !== rerolls.round) { rerolls.count = null; rerolls.stage = null; }
    if (round !== null) rerolls.round = round;
    if (parsed.rerolls !== null) rerolls.count = parsed.rerolls;
    // New cards while the same choice is still open means a reroll was spent.
    else if (cardsChanged && stage !== null && stage === rerolls.stage && rerolls.count !== null && rerolls.count > 0) rerolls.count--;
    if (stage !== null) rerolls.stage = stage;
    if (state.rerollsLeft !== rerolls.count) publish({ rerollsLeft: rerolls.count });
  }
  function armContextExpiry() {
    if (contextExpiryTimer !== null) clearTimeout(contextExpiryTimer); contextExpiryTimer = null;
    const context = state.matchContext;
    const observations = [...Object.values(context.observations), context.localInventoryObservation, context.abilityObservation,
      ...context.localInventory.map(item => item.observation), ...context.localAbilities.map(ability => ability.observation),
      ...context.players.flatMap(player => [player.heroObservation, player.teamObservation, player.inventoryObservation,
        ...player.inventory.map(item => item.observation)])].filter(value => value !== null);
    const deadlines = observations.map(value => value.capturedAt + SCREEN_CONTEXT_MAX_AGE_MS);
    if (context.viewMode === 'spectator' && context.observations.viewMode) deadlines.push(context.observations.viewMode.capturedAt + SPECTATOR_HOLD_MS);
    if (state.abilityAdvice?.kind === 'upgrade') {
      deadlines.push(...[context.observations.localAbilityPoints,
        context.localAbilities.find(ability => ability.slot === state.abilityAdvice!.slot)?.observation]
        .filter(value => value != null).map(value => value.capturedAt + SCREEN_CAPTURE_FRESHNESS_MS));
    }
    const deadline = Math.min(...deadlines.filter(value => value >= contextNow()));
    if (!Number.isFinite(deadline) || !eligible()) return;
    contextExpiryTimer = setTimeout(() => {
      contextExpiryTimer = null;
      // Keep historical facts visible with their age, but replace advice in one snapshot.
      const expired = expireScreenMatchContext(state.matchContext, contextNow());
      publish({ matchContext: expired, advice: currentCardAdvice(expired), abilityAdvice: (state.foreground || backgroundReadable)
        ? evaluateAbilityUpgrade(expired, options.catalog, contextNow()) : null });
      armContextExpiry();
    }, Math.max(1, deadline - contextNow() + 1));
  }
  /** Updates match context. Returns false only when the view cannot carry the player's own draft. */
  function consumeMatchReply(reply: NormalizedNativeReply, draftCueVisible: boolean): boolean {
    const observation = parseScreenMatchObservation(reply, options.catalog, {
      sessionId: `${readerSessionId}:${epoch}`, receivedAt: epochNow(), localPlayerNames: options.localPlayerNames,
      previousContext: state.matchContext,
    });
    note('matchPhase', observation?.phase ?? null);
    if (!observation) return true;
    const old = state.matchContext;
    const context = reduceScreenMatchContext(old, observation, contextNow());
    // An unverifiable team/build observation says nothing about the draft cards in
    // this same frame. Keep reading them instead of wiping the current choices.
    if (context === old) {
      // A frame from a game window that was already replaced is not the current game:
      // it must not put cards on screen. Other refusals only mean the team/build view is unverified.
      const retired = old.retiredSessionIds.includes(observation.sessionId)
        || !!observation.gameSessionId && old.retiredGameSessionIds.includes(observation.gameSessionId);
      note('matchContext', retired ? 'retired window' : 'unverified');
      if (retired) clearDecision('Waiting for the current game window.', 'waiting-draft');
      return !retired;
    }
    const boundary = old.sessionId !== null && context.sessionId !== old.sessionId
      || old.gameSessionId !== null && context.gameSessionId !== old.gameSessionId
      || old.matchId !== null && context.matchId !== null && old.matchId !== context.matchId
      || old.round !== null && context.round !== null && context.round < old.round;
    // Only a player in the match gets an item draft: a visible draft overrides a spectator verdict.
    const spectator = context.viewMode === 'spectator' && !draftCueVisible;
    const closed = context.phase === 'finished' || observation.phase === 'combat' && !draftCueVisible;
    const draftAdvanced = old.pickStage !== null && context.pickStage !== null && context.pickStage !== old.pickStage
      || old.rerollsRemaining !== null && context.rerollsRemaining !== null && context.rerollsRemaining < old.rerollsRemaining;
    const withdraw = boundary || spectator || closed || draftAdvanced || !!observation.resetReason;
    if (withdraw) {
      candidate = null; mainCandidate = null; lastCardParse = null; confirmationStartedAt = null;
      clearTimer('expiry');
    }
    publish({ matchContext: context, abilityAdvice: !spectator && context.phase !== 'finished' && (state.foreground || backgroundReadable)
      ? evaluateAbilityUpgrade(context, options.catalog, contextNow()) : null,
      advice: withdraw ? null : currentCardAdvice(context), ...(withdraw ? { offers: [], observedAt: null, heroId: null,
        generation: state.generation + (state.offers.length || state.advice ? 1 : 0), status: 'waiting-draft' as const,
        message: spectator ? 'Spectating (you may be dead). Picks return when your own view is back.' : 'Waiting for the item-choice screen.' } : {}) });
    armContextExpiry();
    return !spectator && context.phase !== 'finished';
  }
  /** The picked card lingers in its place this long after the next choice opens or the draft closes. */
  const LINGER_MS = 3_000;
  function forgetChoices() { choiceSet = null; previousChoiceSet = null; pendingReplace = null; stageOpened = null; closingSet = null; lingerCandidate = null; }
  /** The draft closed: its last shown set may still credit the pick that lingers for a moment. */
  function draftClosing(at: number | null) {
    if (choiceSet && closingSet?.set !== choiceSet && !choiceSet.credited && choiceSet.byPosition.filter(Boolean).length === 3 && at !== null) closingSet = { set: choiceSet, at };
    stageOpened = null;
  }
  /** The shown set of the choice just before this "Choice N of 3", if it was shown this round. */
  function setBefore(stage: number | null) {
    if (stage === null || stage < 2) return null;
    const round = state.matchContext.round;
    for (const set of [choiceSet, previousChoiceSet]) if (set && set.stage === stage - 1 && (set.round === round || set.round === null || round === null)) return set;
    return null;
  }
  const unreadOffer = (position: number): ScreenOffer => ({ position, itemId: '', name: 'Unread item choice', bonusIds: null, variant: 'unknown', confidence: 0,
    warning: 'This card is not readable yet.' });
  /**
   * Shows the readable cards of a draft read:
   *  - nothing shown yet: the readable cards show at once, even one or two of three (cards deal in one by one);
   *  - cards shown: newly readable cards fill the unread places; a read that changes a shown card replaces the set
   *    only when the next read agrees (2026-10-18: one tooltip read put "Crippling Headshot" in place of Battle Vest
   *    and flipped the pick), and a read where no shown card is still there (a reroll or pick) withdraws the old set at once;
   *  - in a new "Choice N of 3", a card of the previous choice is the picked card leaving the screen, not a new card.
   */
  function acceptParsed(parsed: ScreenOfferParseResult, reply: NormalizedNativeReply, stage: number | null) {
    const shown = state.status === 'ready' && state.offers.length === 3 && state.observedAt !== null
      && epochNow() - state.observedAt < SCREEN_READER_LIMITS.cardHoldMs;
    let offers = parsed.offers;
    const readableIds = () => offers.filter(offer => offer.itemId).map(offer => offer.itemId);
    const leaving = setBefore(stage);
    const at = reply.capturedAt ?? epochNow();
    const newChoice = !!leaving && stageOpened !== null && stageOpened.stage === stage && at - stageOpened.at <= LINGER_MS;
    if (parsed.isDraft && offers.length === 3 && leaving) {
      // The first frames of a new choice still show the picked card in its place, even when all three names read
      // (2026-10-18 review: "d, b, e" with the picked b fading out was shown, and b recommended); while cards deal
      // in, no card of the previous choice is a new card yet.
      const partial = readableIds().length < 3;
      // Once the lingering card is known, only it is the pick; another card of the last choice in its old place is offered again.
      const pick = leaving.pick ?? (lingerCandidate?.set === leaving ? lingerCandidate.itemId : null);
      offers = offers.map(offer => offer.itemId && (newChoice && leaving.byPosition[offer.position] === offer.itemId && (pick === null || pick === offer.itemId)
        || partial && (pick === null ? leaving.ids.includes(offer.itemId) : pick === offer.itemId)) ? unreadOffer(offer.position) : offer);
    }
    const closing = closingSet && at - closingSet.at <= LINGER_MS ? closingSet.set : null;
    if (parsed.isDraft && offers.length === 3 && closing && !shown && readableIds().length < 3
      && offers.every(offer => !offer.itemId || closing.byPosition[offer.position] === offer.itemId)) {
      // Right after a draft closes, the lingering pick is not a new draft of one card.
      note('decision', 'leftover card of the closed draft ignored');
      return;
    }
    const ids = readableIds();
    const readable = parsed.isDraft && offers.length === 3 && new Set(offers.map(offer => offer.position)).size === 3
      && offers.every(offer => [0, 1, 2].includes(offer.position)) && ids.length >= 1
      // The same item on two cards is a half-drawn reveal/reroll animation, not a real set.
      && new Set(ids).size === ids.length;
    note('parse', { isDraft: parsed.isDraft, message: parsed.message, offers: offers.map(offer => offer.name), readable });
    if (!readable) {
      // One unreadable frame inside an open draft is not a new draft: keep the shown cards.
      if (shown && parsed.isDraft) { note('decision', 'kept shown cards through unreadable frame'); return; }
      if (shown) { note('decision', 'kept shown cards; awaiting draft-close confirmation'); return; }
      clearDecision(parsed.isDraft ? 'Item choices are visible but not all names could be read yet.' : parsed.message ?? 'Waiting for the item-choice screen.',
        parsed.isDraft ? 'reading' : 'waiting-draft', false);
      publish({ calibrationRequired: false });
      return;
    }
    const previousAt = (position: number) => shown ? state.offers.find(entry => entry.position === position) : undefined;
    const conflicts = offers.filter(offer => offer.itemId && previousAt(offer.position)?.itemId && previousAt(offer.position)!.itemId !== offer.itemId);
    const agreements = offers.filter(offer => offer.itemId && previousAt(offer.position)?.itemId === offer.itemId);
    let generation = state.generation;
    if (!shown) {
      pendingReplace = null; generation++;
      note('decision', ids.length === 3 ? 'new cards shown' : 'new cards shown (' + ids.length + ' of 3 readable)');
    } else if (!conflicts.length) {
      pendingReplace = null;
      // Same set: carry earlier readings into places this frame could not read.
      offers = offers.map(offer => offer.itemId ? offer : previousAt(offer.position) ?? offer);
      note('decision', offers.every(offer => offer.itemId) ? 'same cards' : 'same cards (partly read)');
    } else {
      const pairs = new Map(conflicts.map(offer => [offer.position, offer.itemId] as const));
      const pending = pendingReplace;
      const confirmed = !!pending && [...pairs].some(([position, itemId]) => pending.get(position) === itemId)
        && [...pairs].every(([position, itemId]) => !pending.has(position) || pending.get(position) === itemId);
      if (!confirmed) {
        pendingReplace = pairs;
        if (!agreements.length) {
          // No shown card is still there: a pick or reroll is replacing the cards; never leave the old pick on screen.
          // (A tooltip over one card leaves the other cards readable and agreeing.)
          clearDecision('New item choices appeared. Reading them…', 'reading');
          note('decision', 'cards changed; old cards withdrawn');
        } else note('decision', 'one card read differently; waiting for a second read before replacing it');
        return;
      }
      pendingReplace = null; generation++;
      note('decision', 'changed cards confirmed by a second read');
    }
    // Small "RARE!" / "ENHANCED" / "BONUS!" labels are not read on every frame; once read, they stay with that same card.
    if (shown) offers = offers.map(offer => {
      const previous = state.offers.find(entry => entry.position === offer.position && entry.itemId === offer.itemId && !!offer.itemId);
      if (!previous) return offer;
      return { ...offer, ...(previous.rare && !offer.rare ? { rare: true } : {}),
        ...(previous.variant === 'enhanced' && offer.variant !== 'enhanced' ? { variant: 'enhanced' as const } : {}),
        ...(previous.bonusExpected && !offer.bonusExpected ? { bonusExpected: true } : {}) };
    });
    displayParsed({ ...parsed, offers }, reply, generation, stage);
  }
  function displayParsed(parsed: ScreenOfferParseResult, reply: NormalizedNativeReply, generation = state.generation, stage: number | null = null) {
    const context = state.matchContext;
    // A reroll replaces all three cards; one card finishing its reveal is not a reroll.
    const replaced = parsed.offers.filter(offer => offer.itemId && state.offers.some(previous => previous.position === offer.position && previous.itemId && previous.itemId !== offer.itemId)).length;
    trackRerolls(parsed, reply, generation !== state.generation && replaced >= 2);
    let advice = adviceFor(parsed, context);
    const ids = parsed.offers.filter(offer => offer.itemId).map(offer => offer.itemId);
    // One readable card of three is no basis for a pick: show it, and wait for the others.
    if (advice && ids.length < 2) advice = { ...advice, preferredPosition: null, title: 'Reading the other cards…' };
    lastCardParse = parsed;
    const currentStage = stage ?? (rerolls.stage === null ? null : Number(rerolls.stage));
    if (choiceSet && choiceSet.stage !== null && currentStage !== null && choiceSet.stage !== currentStage) previousChoiceSet = choiceSet;
    const byPosition = [0, 1, 2].map(position => parsed.offers.find(offer => offer.position === position)?.itemId ?? '');
    if (choiceSet && choiceSet.stage === currentStage) { choiceSet.ids = ids; choiceSet.byPosition = byPosition; choiceSet.round = context.round; }
    else choiceSet = { stage: currentStage, round: context.round, ids, byPosition, credited: false };
    closingSet = null;
    note('advice', advice ? { preferred: advice.preferredPosition, title: advice.title, reroll: advice.rerollReason, choice: rerolls.stage } : null);
    const unread = parsed.offers.filter(offer => !offer.itemId).length;
    publish({ generation, status: 'ready', message: unread === 0 ? 'Item choices read from the game screen.'
      : unread === 1 && parsed.offers.some(offer => offer.name === 'Ambiguous item name' || offer.warning === 'The main item name was not recognized.')
        ? 'One card could not be read; check it in game.' : 'Reading the other cards…',
      offers: parsed.offers, advice, heroId: currentLocalHero(roster.snapshot(), context.localHeroId, context.observations.localHeroId?.capturedAt, parsed.heroId), observedAt: reply.capturedAt,
      calibrationRequired: false });
    armExpiry(reply.capturedAt!);
  }
  /**
   * The picked card lingers in its place while the next "Choice N of 3" deals in, and after the last choice while
   * the draft closes (real 2026-10-18 frames): credit it to your build, since the inventory read can miss its slot
   * for the rest of the match. Only a card read in its own place, alone of its set, on two reads counts (an
   * unpicked card is gone at once; a card offered again shows elsewhere or with the other new cards).
   */
  function observeLeaving(set: ChoiceSet | null, blocks: NativeOcrBlock[], reply: NormalizedNativeReply) {
    if (!set || set.credited || set.byPosition.filter(Boolean).length < 3) return;
    const crop = reply.crop ?? { ...DEFAULT_CAPTURE_REGION };
    const aspect = reply.clientWidth / Math.max(1, reply.clientHeight);
    const inPlace = new Set(namedItemCenters(blocks, options.catalog, set.ids)
      .filter(entry => { const slot = cardSlotAt(crop.x + entry.x * crop.width, aspect); return slot !== null && set.byPosition[slot] === entry.itemId; })
      .map(entry => entry.itemId));
    if (inPlace.size !== 1) { if (inPlace.size > 1) lingerCandidate = null; return; }
    const itemId = [...inPlace][0]!;
    lingerCandidate = lingerCandidate && lingerCandidate.set === set && lingerCandidate.itemId === itemId
      ? { ...lingerCandidate, count: lingerCandidate.count + 1 } : { set, itemId, count: 1 };
    if (lingerCandidate.count < 2) return;
    set.credited = true; set.pick = itemId; lingerCandidate = null;
    build.creditPick(itemId);
    publish({ build: build.snapshot() });
    note('pick', itemId);
  }
  function applyGameReply(reply: NormalizedNativeReply, operation: Operation, isHint: boolean, debug: boolean, isFooter: boolean) {
    if (reply.synthetic) throw new ReaderFailure('protocol');
    const bounds = reply.gamePresent && reply.clientLeft != null && reply.clientTop != null && reply.clientWidth > 0 && reply.clientHeight > 0
      ? { x: reply.clientLeft, y: reply.clientTop, width: reply.clientWidth, height: reply.clientHeight } : null;
    const old = state.gameBounds ?? null;
    const boundsChanged = !old !== !bounds || !!old && !!bounds && (old.x !== bounds.x || old.y !== bounds.y || old.width !== bounds.width || old.height !== bounds.height);
    publish({ gamePresent: reply.gamePresent, foreground: reply.foreground, ...(boundsChanged ? { gameBounds: bounds } : {}) });
    if (!reply.gamePresent) {
      absentSince ??= wallNow();
      if (wallNow() - absentSince >= GAME_GONE_MS) {
        roster.reset(); build.reset(); rerolls.count = null; rerolls.stage = null; rerolls.round = null;
        forgetChoices();
        if (state.roster || state.build) publish({ roster: null, rerollsLeft: null, build: null, abilityPlan: null, insights: null, abilityPoints: null });
        lastInsightsKey = null;
      }
      draftHint = false; hintAt = null; fullReadDue = false; panelReadDue = false; backgroundReadable = false;
      if (state.matchContext.sessionId !== null) fence('Waiting for Deadlock.', 'waiting-game');
      else clearDecision('Waiting for Deadlock.', 'waiting-game');
      publish({ abilityAdvice: null });
      nextRequestAt = Math.max(nextRequestAt, wallNow() + SCREEN_READER_LIMITS.phaseSpacingMs);
      return;
    }
    absentSince = null;
    const cardsShown = state.status === 'ready' && state.offers.length > 0;
    // A helper that can capture the game behind other windows (after checking nothing covers it) answers ok
    // without focus: keep reading then. Today's helper answers not_foreground and the reader pauses as before.
    backgroundReadable = !reply.foreground && (reply.status === 'ok' || reply.status === 'unchanged');
    if (!reply.foreground && reply.status === 'not_foreground') {
      fullReadDue = false; panelReadDue = false;
      // Looking at the companion moves focus away from the game. The cards just read
      // are still the cards in the game; keep them until they expire or change.
      if (cardsShown) { note('decision', 'game not in foreground; kept shown cards'); publish({ foreground: false }); }
      else {
        draftHint = false; hintAt = null;
        clearDecision(previewPending ? 'Return to Deadlock to capture the reading-area preview.' : 'Return to Deadlock to read its item choices.', 'interrupted');
      }
      nextRequestAt = Math.max(nextRequestAt, wallNow() + SCREEN_READER_LIMITS.phaseSpacingMs);
      return;
    }
    if (reply.status !== 'ok' && reply.status !== 'unchanged') {
      draftHint = false; hintAt = null; fullReadDue = false;
      const unavailable = reply.status === 'ocr_unavailable' || reply.status === 'invalid_request';
      if (unavailable) retryRequired = true;
      publish({ abilityAdvice: null });
      if (cardsShown && !unavailable) { note('decision', `capture ${reply.status}; kept shown cards`); nextRequestAt = Math.max(nextRequestAt, wallNow() + SCREEN_READER_LIMITS.phaseSpacingMs); return; }
      clearDecision(unavailable ? 'Windows OCR is unavailable. Install an English OCR language and choose Retry.'
        : reply.status === 'occluded' ? 'Another window is covering Deadlock. Move it off the game screen (click-through overlays are fine).'
        : reply.status === 'blank_capture' ? 'The game image is black. Switch Deadlock to borderless windowed mode.'
        : 'The game image is unavailable. Keep the game visible in borderless or windowed mode.', unavailable ? 'unavailable' : 'interrupted');
      nextRequestAt = Math.max(nextRequestAt, wallNow() + SCREEN_READER_LIMITS.phaseSpacingMs);
      return;
    }
    if (!fresh(reply) || reply.clientWidth < 1 || reply.clientHeight < 1 || !reply.hash) {
      note('decision', 'stale or unverifiable capture ignored');
      return;
    }
    const clientSize = `${reply.clientWidth}x${reply.clientHeight}`;
    if (lastClientSize !== null && lastClientSize !== clientSize) {
      draftHint = false; hintAt = null;
      clearDecision('The game window changed size. Confirming the reading area again.', 'waiting-draft');
    }
    lastClientSize = clientSize;
    if (operation === 'probe') {
      if (!cardsShown) publish({ status: 'waiting-draft', message: previewPending ? 'Reading-area preview queued until the next game capture.' : 'Waiting for the item-choice screen.' });
      return;
    }
    if (debug) {
      previewPending = false;
      publish({ previewDataUrl: reply.previewPng ? `data:image/png;base64,${reply.previewPng}` : null,
        message: reply.previewPng ? 'Reading-area preview captured. Return here to adjust the area if needed.' : 'The reader did not return a preview.' });
    }
    // The loading screen names your hero ("JOINING THE FIGHT AS … | INFERNUS") only in the middle of
    // the screen, outside the cheap strips: read the whole window next.
    if (reply.blocks.some(block => /JOININGTHEFIGHT/.test(block.text.toUpperCase().replace(/[^A-Z]/g, '')))) nextContextDiscoveryAt = Math.min(nextContextDiscoveryAt, wallNow());
    const parserBlocks = blocksForScreenParser(reply);
    const currentDraftCue = detectDraftHint(parserBlocks);
    const epochBefore = roster.snapshot().epoch;
    roster.observe(reply.context, reply.blocks.flatMap(block => block.bounds ? [{ text: block.text, bounds: block.bounds }] : []), epochNow(),
      reply.clientWidth / reply.clientHeight);
    const known = roster.snapshot();
    // A new match (new match number, a different own hero, or a long gap) means the old
    // build and reroll count belong to the previous match.
    if (known.epoch !== epochBefore) {
      build.reset(); rerolls.count = null; rerolls.stage = null; rerolls.round = null;
      forgetChoices();
      // The old match's round, score and draft stage too (keeping the reader session: this frame is the new match's).
      const forgotten = forgetMatchRound(state.matchContext);
      if (forgotten !== state.matchContext) publish({ matchContext: forgotten });
    }
    const frameAt = reply.capturedAt ?? epochNow();
    const stage = draftChoiceStage(parserBlocks);
    if (stage !== null && stageOpened?.stage !== stage) stageOpened = { stage, at: frameAt };
    // The third pick lingers in its place for a moment after the draft closes.
    if (closingSet && frameAt - closingSet.at <= LINGER_MS) observeLeaving(closingSet.set, parserBlocks, reply);
    const spectating = deathScreen(reply, currentDraftCue);
    const draftPanel = currentDraftCue || reply.context?.panel === 'draft';
    // The round title of this frame first updates the match state, so your ability budget uses this round.
    if (currentDraftCue) cueMisses = 0;
    const matchReadable = consumeMatchReply(reply, currentDraftCue);
    // After the match (awards, vote, summary, hideout) the HUD on screen is not yours: the last build stays as it was.
    const outside = known.phase === 'outside' && !currentDraftCue;
    if (!outside) {
      build.observe(reply.context?.brawl, { round: state.matchContext.round, points: reply.context?.abilityPoints?.value ?? null, draft: draftPanel },
        { spectating, at: reply.capturedAt ?? epochNow() });
    }
    // While Tab is held the panel is up and upgrades happen: read the bottom strip at the read spacing
    // instead of waiting for the next once-a-second cue scan.
    panelReadDue = !draftPanel && !spectating && (!!reply.context?.brawl?.abilityRanks
      || reply.blocks.some(block => /HOLDTABTOUPGRADE/.test(block.text.toUpperCase().replace(/[^A-Z]/g, ''))));
    const buildView = build.snapshot();
    if (JSON.stringify(buildView) !== JSON.stringify(state.build ?? null)) publish({ build: buildView });
    const plan = abilityPlan(known.localHeroId, buildView.abilityRanks);
    if (JSON.stringify(plan) !== JSON.stringify(state.abilityPlan ?? null)) publish({ abilityPlan: plan });
    note('build', { mine: buildView.myItems.length, enemy: enemyItems().length, abilities: buildView.abilityRanks, spectating,
      ...(build.abilityRejection() ? { abilityRejected: build.abilityRejection() } : {}) });
    const rosterView = { seats: known.seats, localHeroId: known.localHeroId, localSide: known.localSide, allies: known.allies, enemies: known.enemies, phase: known.phase, since: known.since };
    if (JSON.stringify(rosterView) !== JSON.stringify(state.roster ?? null)) publish({ roster: rosterView });
    note('roster', rosterView);
    // Matchups and the draft wishlist only change with the hero, the enemy team, owned items or fresh statistics.
    const insightEnemies = known.localSide === null ? [] : known.enemies;
    const insightsKey = [known.localHeroId, insightEnemies.join(','), buildView.myItems.join(','), streetBrawlData().fetchedAt].join('|');
    if (insightsKey !== lastInsightsKey) {
      lastInsightsKey = insightsKey;
      publish({ insights: matchInsights(known.localHeroId, insightEnemies, buildView.myItems) });
    }
    const unspent = reply.context?.abilityPoints?.value;
    if (!outside && typeof unspent === 'number' && Number.isInteger(unspent) && unspent >= 0 && unspent <= 40 && reply.capturedAt !== null
      && (state.abilityPoints?.value !== unspent || reply.capturedAt - state.abilityPoints.at > 15_000)) {
      publish({ abilityPoints: { value: unspent, at: reply.capturedAt } });
    }
    note('draftCue', currentDraftCue);
    if (outside) {
      // Between matches there are no cards to read: look less often (a new match announces itself with its
      // loading screen, read on the next look) and say so once.
      draftHint = false; hintAt = null; fullReadDue = false; panelReadDue = false; scoreboardReadDue = false;
      nextRequestAt = Math.max(nextRequestAt, wallNow() + SCREEN_READER_LIMITS.outsideReadSpacingMs);
      if (state.message !== OUTSIDE_MESSAGE || state.offers.length) clearDecision(OUTSIDE_MESSAGE, 'waiting-draft');
      return;
    }
    if (!matchReadable) {
      draftHint = false; hintAt = null; fullReadDue = false;
      nextRequestAt = Math.max(nextRequestAt, wallNow() + SCREEN_READER_LIMITS.phaseSpacingMs);
      // A dead player is classified as a spectator, but still holds Tab to see the scoreboard.
      // Withdrawing the draft must not also cancel the full-window read that fills the item grid.
      if (isHint) {
        const killsLabel = reply.blocks.some(block => /^kills$/i.test(block.text.trim()) && !!block.bounds && block.bounds.y < 0.25 && block.bounds.x > 0.4 && block.bounds.x < 0.6);
        scoreboardReadDue = killsLabel || reply.context?.panel === 'scoreboard' || detectScoreboardHint(reply.blocks, reply.crop);
      }
      return;
    }
    if (isHint) {
      // A draft just appeared: read its cards at the draft pace instead of after the usual spacing
      // (still within the draft's duty share, so a slow hint read is not followed straight away).
      if (currentDraftCue && !draftHint) { draftSeenAt = wallNow(); nextRequestAt = Math.min(nextRequestAt, Math.max(wallNow() + 50, draftPaceAt)); }
      draftHint = currentDraftCue;
      hintAt = draftHint ? reply.capturedAt : null;
      fullReadDue = draftHint;
      footerFallbackDue = !draftHint && !isFooter;
      // A scoreboard cue cannot keep rearming a higher-priority hint request
      // while a current draft is already visible in this capture.
      // Street Brawl's scoreboard shows a KILLS label between the teams while Tab is held.
      const killsLabel = reply.blocks.some(block => /^kills$/i.test(block.text.trim()) && !!block.bounds && block.bounds.y < 0.25 && block.bounds.x > 0.4 && block.bounds.x < 0.6);
      scoreboardReadDue = !draftHint && (killsLabel || reply.context?.panel === 'scoreboard' || detectScoreboardHint(reply.blocks, reply.crop));
      if (scoreboardReadDue) nextRequestAt = Math.max(nextRequestAt, lastHintStart + SCREEN_READER_LIMITS.phaseSpacingMs);
      if (!draftHint) {
        cueMisses++;
        // The title can be hidden for a frame by effects; a draft only closes after repeated
        // misses, or at once when the game shows its own "Selects Complete" label.
        if (state.status !== 'ready' || cueMisses >= SCREEN_READER_LIMITS.draftCueMissesToClose || detectDraftClosed(parserBlocks)) {
          if (state.status === 'ready') note('decision', 'draft closed; cards withdrawn');
          draftClosing(frameAt);
          // The next draft is another choice: its own "Choice N of 3" label says which.
          rerolls.stage = null;
          clearDecision('Waiting for the item-choice screen.', 'waiting-draft');
        } else note('decision', 'draft cue missed once; kept shown cards');
        nextRequestAt = Math.max(nextRequestAt, lastHintStart + SCREEN_READER_LIMITS.phaseSpacingMs);
        return;
      }
      // Small cue strips supply no cards. A full discovery/scoreboard frame can
      // already contain the three choices and must not discard that evidence.
      if (reply.crop!.x !== 0 || reply.crop!.y !== 0 || reply.crop!.width !== 1 || reply.crop!.height !== 1) return;
    }
    // The default card crop includes the source labels. A current cue avoids an
    // unnecessary separate title scan, and cannot turn inventory names into a draft.
    if (currentDraftCue) {
      scoreboardReadDue = false;
      if (!draftHint) draftSeenAt = wallNow();
      draftHint = true; hintAt = reply.capturedAt; lastHintStart = wallNow();
    }
    if (!draftHint || hintAt === null || epochNow() - hintAt >= SCREEN_READER_LIMITS.captureFreshnessMs) {
      // The next title check decides whether the draft has closed.
      draftHint = false;
      if (!cardsShown) clearDecision('Waiting for the item-choice screen.', 'waiting-draft');
      return;
    }
    const icons = reply.icons?.map(icon => ({ ...icon, bounds: {
      x: (icon.bounds.x - reply.crop!.x) / reply.crop!.width, y: (icon.bounds.y - reply.crop!.y) / reply.crop!.height,
      width: icon.bounds.width / reply.crop!.width, height: icon.bounds.height / reply.crop!.height,
    } }));
    // Owned items predict which cards carry a "Bonus!" item (an upgrade of something you own).
    let parsed = parseScreenOffers(parserBlocks, options.catalog, { draftConfirmed: true, iconMatches: icons, conservativeUnmarkedDetails: true,
      aspect: reply.clientWidth / Math.max(1, reply.clientHeight), ...(reply.crop ? { crop: reply.crop } : {}),
      ...(build.ownInventoryRead() ? { ownedItemIds: build.snapshot().myItems } : {}) });
    // A frame with the draft's own labels ("CHOICE 2 OF 3", reroll button) but no readable card layout is still the
    // draft (2026-10-18: such a frame said "panel no longer visible" for one read): wait for the next read.
    if (!parsed.isDraft && currentDraftCue) parsed = { ...parsed, isDraft: true };
    if (!parsed.isDraft) { draftHint = false; hintAt = null; fullReadDue = false; }
    if (parsed.message === SELECTIONS_COMPLETE_MESSAGE) {
      // The game says the picks are done: the shown pick is no longer actionable.
      note('decision', 'selections complete; cards withdrawn');
      draftClosing(frameAt);
      observeLeaving(choiceSet, parserBlocks, reply);
      clearDecision('Waiting for the item-choice screen.', 'waiting-draft');
      return;
    }
    if (parsed.isDraft && stage !== null && stageOpened?.stage === stage
      && (frameAt - stageOpened.at <= LINGER_MS || parsed.offers.filter(offer => offer.itemId).length < 3)) {
      observeLeaving(setBefore(stage), parserBlocks, reply);
    }
    acceptParsed(parsed, reply, stage);
  }

  async function cycle() {
    if (!eligible() || stopping || pending || wallNow() < nextRequestAt) return;
    const contextEpoch = epoch;
    let operation: Operation;
    let crop: CaptureRegion;
    let isHint = false;
    let isFooter = false;
    let debug = false;
    let scoreboardRead = false;
    let panelRead = false;
    if (!state.engineReady) { operation = 'fixture'; crop = { ...DEFAULT_CAPTURE_REGION }; }
    else if (!state.gamePresent || !state.foreground && !backgroundReadable) { operation = 'probe'; crop = hintCrop; }
    else if (previewPending) { operation = 'read'; crop = state.crop; debug = true; }
    // A slower title read may consume its hint lifetime through cooldown. Hand
    // off one full capture before scoreboard work; its current cue is rechecked.
    else if (fullReadDue) { operation = 'read'; crop = draftCaptureRegion(state.crop); fullReadDue = false; }
    else if (scoreboardReadDue) {
      operation = 'read'; crop = { ...MATCH_CONTEXT_REGION }; scoreboardReadDue = false;
      isHint = true; isFooter = true; lastHintStart = wallNow(); scoreboardRead = true;
    }
    else if (panelReadDue && !draftHint && wallNow() - lastHintStart < SCREEN_READER_LIMITS.phaseSpacingMs) {
      operation = 'read'; crop = { ...DRAFT_FOOTER_REGION }; panelReadDue = false; panelRead = true;
    }
    else if (!draftHint || hintAt === null || wallNow() - lastHintStart >= SCREEN_READER_LIMITS.phaseSpacingMs) {
      if (wallNow() - lastHintStart < SCREEN_READER_LIMITS.phaseSpacingMs) { nextRequestAt = lastHintStart + SCREEN_READER_LIMITS.phaseSpacingMs; return; }
      operation = 'read'; crop = footerFallbackDue ? { ...DRAFT_FOOTER_REGION } : hintCrop;
      isHint = true; isFooter = footerFallbackDue; footerFallbackDue = false; lastHintStart = wallNow();
    } else { operation = 'read'; crop = draftCaptureRegion(state.crop); }
    // A once-per-second context refresh replaces a card read. The helper still
    // captures only this area, and keeps its two-megapixel acquisition bound.
    if (operation === 'read' && !isHint && !debug && !panelRead && wallNow() - lastFullContextAt >= SCREEN_READER_LIMITS.phaseSpacingMs) {
      crop = { ...MATCH_CONTEXT_REGION };
    }
    // Recovery cannot depend on recognizing a cue in the cheap crops. Replace
    // one existing waiting scan occasionally; never add another worker or read.
    if (operation === 'read' && isHint && !debug && wallNow() >= nextContextDiscoveryAt) {
      crop = { ...MATCH_CONTEXT_REGION }; isFooter = true;
    }
    const startedAt = wallNow();
    // Control changes can happen between pollOnce() and this dispatch microtask.
    if (contextEpoch !== epoch || !eligible() || stopping) return;
    // Occasionally keep a draft image so a misread can be replayed and fixed offline.
    // Draft card reads and full scoreboard (Tab) reads are the frames worth replaying.
    // None between matches (2026-10-18: post-match and hideout screens filled the frames folder).
    const inMatch = draftHint || roster.snapshot().phase !== 'outside';
    let captureFrame = !!options.onDraftFrame && operation === 'read' && !debug && inMatch
      && (draftHint && !isHint && wallNow() - draftSeenAt >= SCREEN_READER_LIMITS.draftFrameQuietMs || scoreboardRead)
      && wallNow() - lastFrameCaptureAt >= SCREEN_READER_LIMITS.frameCaptureSpacingMs;
    // Also keep an occasional whole-window image so HUD, hero and item recognition can be checked offline.
    const snapshot = !captureFrame && !!options.onDraftFrame && operation === 'read' && !debug && isHint && inMatch
      && wallNow() - lastSnapshotAt >= SCREEN_READER_LIMITS.snapshotSpacingMs;
    if (snapshot) { crop = { ...MATCH_CONTEXT_REGION }; isFooter = true; captureFrame = true; lastSnapshotAt = wallNow(); }
    // Saved images are whole-window so they replay with true screen positions.
    if (captureFrame) { lastFrameCaptureAt = wallNow(); crop = { ...MATCH_CONTEXT_REGION }; }
    trace = { at: new Date(epochNow()).toISOString(), op: operation, crop, hint: isHint, footer: isFooter, draftHint, scoreboard: scoreboardRead,
      ...(panelRead ? { panelRead: true } : {}), frame: captureFrame, round: state.matchContext.round };
    try {
      const reply = await request(operation, crop, debug || captureFrame);
      if (contextEpoch !== epoch || !eligible() || stopping) return;
      // Only a real game read proves recovery; the warm-up after each restart does not.
      if (operation === 'read' && !reply.synthetic && (reply.status === 'ok' || reply.status === 'unchanged')) timeoutsSinceRetry = 0;
      metrics(reply, startedAt, operation);
      Object.assign(trace, { status: reply.status, foreground: reply.foreground, nativeMs: reply.elapsedMs, wallMs: Math.round(wallNow() - startedAt),
        client: `${reply.clientWidth}x${reply.clientHeight}`, panel: reply.context?.panel ?? null, snapshot,
        seen: reply.context ? { view: reply.context.viewMode,
          heroes: reply.context.heroes.filter(hero => hero.heroId).map(hero => `${hero.role === 'local' ? 'me' : hero.seat}:${hero.heroId}`),
          heroSlots: reply.context.heroes.length,
          items: reply.context.items.filter(item => item.itemId).map(item => `${item.role === 'local-inventory' ? 'me' : item.seat}:${item.itemId}`),
          // The fixed-layout own inventory that feeds the build tracker (the list above is the older generic reader).
          mine: reply.context.brawl?.myItems.map(item => `${item.slot}:${item.itemId}`) ?? null, occupied: reply.context.brawl?.myOccupied ?? null,
          itemSlots: reply.context.items.length,
          abilities: reply.context.abilities.map(ability => ability.rank), ap: reply.context.abilityPoints?.value ?? null,
          panelRanks: reply.context.brawl?.abilityRanks ?? null } : null,
        text: reply.blocks.map(block => block.text).join(' | ').slice(0, 1_500) });
      if (pressurePaused) return;
      if (operation === 'read' && crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1
        && reply.gamePresent && fresh(reply) && ['ok', 'unchanged'].includes(reply.status)) {
        lastFullContextAt = startedAt;
        nextContextDiscoveryAt = wallNow() + SCREEN_READER_LIMITS.contextDiscoverySpacingMs;
      }
      if (operation === 'fixture') {
        // Warm the OS engine with helper-generated text only. It is never game evidence.
        if (!reply.synthetic || (reply.status !== 'ok' && reply.status !== 'unchanged') || reply.ocrAvailable !== true) {
          retryRequired = true; clearDecision('Windows OCR could not be prepared. Choose Retry after checking installed OCR languages.', 'unavailable');
          await stopHelper(); return;
        }
        publish({ engineReady: true, status: 'waiting-game', message: 'Waiting for Deadlock.' });
        return;
      }
      applyGameReply(reply, operation, isHint, debug, isFooter);
      if (captureFrame && reply.previewPng && reply.status !== 'not_foreground') {
        try { options.onDraftFrame!(reply.previewPng, { ...trace }); } catch { /* Diagnostics never break reading. */ }
      }
      emitTrace();
    } catch (error) {
      if (trace) { trace.error = error instanceof ReaderFailure ? error.kind : String(error); emitTrace(); }
      if (contextEpoch !== epoch || disposed || !state.enabled) return;
      if (!(error instanceof ReaderFailure) || error.kind !== 'interrupted') {
        const timeout = error instanceof ReaderFailure && error.kind === 'timeout';
        if (timeout) {
          timeoutsSinceRetry++;
          publish({ metrics: { ...state.metrics, timeouts: state.metrics.timeouts + 1 } });
          retryRequired = timeoutsSinceRetry >= SCREEN_READER_LIMITS.maxTimeoutsBeforeRetry;
        } else retryRequired = true;
        // A single slow read restarts the helper but keeps the observed match and cards.
        if (timeout && !retryRequired) publish({ message: 'A screen read was slow; the reader is restarting.' });
        else fence(timeout ? 'Screen reading paused after repeated timeouts. Choose Retry to try again.'
          : 'The screen reader returned an invalid response or stopped. Choose Retry.', timeout ? 'paused' : 'unavailable');
        await stopHelper();
        // Restart promptly so cards kept through one slow read can be confirmed again.
        nextRequestAt = Math.max(nextRequestAt, wallNow() + 1_000);
      }
    }
  }
  function emitTrace() {
    const entry = trace; trace = null;
    if (!entry || !options.onTrace) return;
    entry.result = { status: state.status, message: state.message, offers: state.offers.map(offer => offer.name),
      preferred: state.advice?.preferredPosition ?? null };
    try { options.onTrace(entry); } catch { /* Diagnostics never break reading. */ }
  }
  function pollOnce(): Promise<void> {
    if (inFlight || stopping || !eligible()) return Promise.resolve();
    if (wallNow() < nextRequestAt) { schedule(); return Promise.resolve(); }
    const dispatchedEpoch = epoch;
    const work = Promise.resolve().then(() => { if (dispatchedEpoch === epoch && eligible() && !stopping) return cycle(); });
    inFlight = work.finally(() => { inFlight = null; schedule(); });
    return inFlight;
  }
  async function setEnabled(enabled: boolean): Promise<void> {
    if (disposed) return;
    loopStarted = true;
    if (!enabled) {
      state.enabled = false; previewPending = false; clearTimer('loop');
      fence('Screen reading is off.', 'paused'); publish({ enabled: false, previewDataUrl: null });
      await stopHelper(); return;
    }
    if (!state.enabled) {
      if (terminationFailed) {
        publish({ status: 'unavailable', message: 'The reader could not be stopped safely. Restart the application before reading again.' });
        return;
      }
      // This is a deliberate user restart. Use the same stop barrier and retry
      // reset as the Retry control; a timeout pause must not leave Resume inert.
      publish({ enabled: true });
      await retry();
      return;
    }
    schedule();
  }
  async function setCrop(input: CaptureRegion): Promise<void> {
    if (disposed) return;
    const crop = validateCaptureRegion(input);
    if (JSON.stringify(crop) === JSON.stringify(state.crop)) return;
    fence('Reading area updated. Waiting for fresh item choices.', state.enabled ? 'waiting-draft' : 'paused');
    publish({ crop, previewDataUrl: null, calibrationRequired: false });
    previewPending = false;
    if (pending) await stopHelper();
    nextRequestAt = Math.max(nextRequestAt, wallNow()); schedule();
  }
  async function retry(): Promise<void> {
    if (terminationFailed && (!helper || helper.exited)) terminationFailed = false;
    if (disposed || terminationFailed) return;
    clearTimer('loop'); fence(workloadPressured ? 'Screen reading paused while the game is under load.' : 'Preparing the screen reader again…',
      state.enabled && !workloadPressured ? 'starting' : 'paused');
    await stopHelper();
    if (terminationFailed || disposed) return;
    retryRequired = false; pressurePaused = false; timeoutsSinceRetry = 0;
    cpuSamples.length = 0; lastCpuAt = null;
    previewPending = false; nextRequestAt = wallNow();
    publish({ engineReady: false }); schedule();
  }
  async function preview(): Promise<ScreenReaderState> {
    if (!eligible()) return snapshot();
    previewPending = true;
    publish({ previewDataUrl: null, message: 'Return to Deadlock to capture the reading-area preview.' });
    schedule(); return snapshot();
  }
  async function setWorkloadPressure(pressured: boolean): Promise<void> {
    if (disposed) return;
    workloadPressured = pressured;
    if (pressured) {
      clearTimer('loop'); fence('Screen reading paused while the game is under load.', 'paused');
      if (pending) await stopHelper();
    } else { nextRequestAt = Math.max(nextRequestAt, wallNow()); schedule(); }
  }
  async function stop(): Promise<void> { await setEnabled(false); }
  async function dispose(): Promise<void> {
    if (disposed) { if (stopping) await stopping; return; }
    disposed = true; state.enabled = false; previewPending = false;
    clearTimer('loop'); fence('Screen reader stopped.', 'paused'); publish({ enabled: false, previewDataUrl: null });
    await stopHelper(); listeners.clear();
  }
  if (loopStarted && state.enabled) schedule();
  return {
    getState: snapshot, setEnabled, setCrop, retry, preview, pollOnce, setWorkloadPressure, stop, dispose,
    subscribe(listener: (value: ScreenReaderState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
