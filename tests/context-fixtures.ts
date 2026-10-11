import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { ScreenReaderProcess } from '../electron/screen-reader';
import type { CaptureRegion, NativeScreenContext } from '../src/shared/screen-reading';

/** Synthetic protocol records only. These rectangles do not establish native detector accuracy. */
export interface ContextTestBlock { text: string; bounds: CaptureRegion }
export interface ContextTestRequest { id: string; op: string; crop: CaptureRegion; debugPreview?: boolean; [key: string]: unknown }
export interface ContextTestResponse { reply: Record<string, unknown>; afterMs: number }
export const CONTEXT_TEST_START = 1_800_000_000_000;

export function contextBlock(text: string, x: number, y: number, width = 0.18, height = 0.025): ContextTestBlock {
  return { text, bounds: { x, y, width, height } };
}
export function inContextCrop(block: ContextTestBlock, crop: CaptureRegion): boolean {
  const bounds = block.bounds;
  return bounds.x >= crop.x && bounds.y >= crop.y && bounds.x + bounds.width <= crop.x + crop.width + 0.00001
    && bounds.y + bounds.height <= crop.y + crop.height + 0.00001;
}
export function contextWithinCrop(context: NativeScreenContext, crop: CaptureRegion): NativeScreenContext {
  const contains = (bounds: CaptureRegion) => inContextCrop({ text: '', bounds }, crop);
  const intersect = (bounds: CaptureRegion): CaptureRegion | null => {
    const x = Math.max(bounds.x, crop.x), y = Math.max(bounds.y, crop.y);
    const right = Math.min(bounds.x + bounds.width, crop.x + crop.width), bottom = Math.min(bounds.y + bounds.height, crop.y + crop.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  };
  return { ...context,
    heroes: context.heroes.filter(value => contains(value.bounds)), items: context.items.filter(value => contains(value.bounds)),
    abilities: context.abilities.filter(value => contains(value.bounds)),
    regions: context.regions.flatMap(value => {
      const bounds = intersect(value.bounds);
      return bounds ? [{ ...value, bounds, complete: value.complete && contains(value.bounds) }] : [];
    }),
    abilityPoints: context.abilityPoints && contains(context.abilityPoints.bounds) ? context.abilityPoints : undefined,
  };
}
export function contextReply(request: ContextTestRequest, context?: NativeScreenContext, blocks: ContextTestBlock[] = [], patch: Record<string, unknown> = {}): Record<string, unknown> {
  const synthetic = request.op === 'fixture';
  return { protocol: 1, id: request.id, status: 'ok', gamePresent: !synthetic, foreground: !synthetic,
    clientWidth: 1920, clientHeight: 1080, crop: request.crop, capturedAt: Date.now(), elapsedMs: 20,
    hash: `context-${request.id}`, blocks: blocks.filter(block => inContextCrop(block, request.crop)),
    ocrAvailable: true, ocrLanguage: 'en-US', synthetic, context,
    metrics: { cpuMs: 1, workingSetMb: 100 }, ...patch };
}

const heroIds = ['hero_shiv', 'hero_kelvin', 'hero_haze', 'hero_lash', 'hero_gigawatt', 'hero_bebop', 'hero_wraith', 'hero_forge'];
export function hudContext(sessionId = 'synthetic-window-a', heroId = 'hero_haze'): NativeScreenContext {
  const bounds = { x: 0.42, y: 0.88, width: 0.045, height: 0.06 };
  return { sessionId, panel: 'hud', viewMode: 'participant', heroes: [{ heroId, isLocal: true, status: 'recognized', confidence: 0.98, role: 'local', bounds }],
    items: [], abilities: [], regions: [{ kind: 'local-hero', bounds, complete: true }] };
}

/** Explicit native ownership records, not assertions that synthetic rectangles match the live UI. */
export function scoreboardContext(sessionId = 'synthetic-window-a', localItems = ['upgrade_health', 'upgrade_vampire']): NativeScreenContext {
  const context = hudContext(sessionId);
  context.panel = 'scoreboard';
  const xs = [0.09, 0.15, 0.21, 0.27, 0.67, 0.73, 0.79, 0.85];
  context.heroes.push(...heroIds.map((heroId, seat) => ({ heroId, seat, team: seat < 4 ? 0 as const : 1 as const,
    isLocal: seat === 2, status: 'recognized' as const, confidence: 0.98, role: 'roster' as const,
    bounds: { x: xs[seat]!, y: 0.06, width: 0.045, height: 0.075 } })));
  context.regions.push({ kind: 'scoreboard', bounds: { x: 0.07, y: 0.03, width: 0.86, height: 0.65 }, complete: true },
    { kind: 'roster', bounds: { x: 0.07, y: 0.03, width: 0.86, height: 0.30 }, slotCount: 8, complete: true });
  for (let seat = 0; seat < 8; seat++) {
    const owned = seat === 2 ? localItems : seat === 4 ? ['upgrade_improved_spirit', 'upgrade_health_stealing_magic'] : ['upgrade_health'];
    const slotCount = Math.max(2, owned.length);
    const region = { x: xs[seat]!, y: 0.42, width: 0.045, height: 0.18 };
    context.regions.push({ kind: 'inventory', seat, bounds: region, slotCount, complete: true });
    for (let slot = 0; slot < slotCount; slot++) context.items.push({ itemId: owned[slot] ?? null,
      status: owned[slot] ? 'recognized' : 'empty', confidence: 0.98, seat, slot, role: 'player-inventory', variant: 'unknown',
      bounds: { x: xs[seat]! + (slot % 3) * 0.013, y: 0.42 + Math.floor(slot / 3) * 0.02, width: 0.011, height: 0.017 } });
  }
  return context;
}

export function publicDraftBlocks(itemNames = ['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']): ContextTestBlock[] {
  return [contextBlock('SELECT ITEMS', 0.04, 0.182, 0.244, 0.052), contextBlock('CHOICE 1 OF 3', 0.04, 0.268, 0.098, 0.024),
    contextBlock('Use Re-Roll', 0.463, 0.653, 0.074, 0.020), contextBlock('1 Re-Roll Remaining', 0.46, 0.714, 0.08, 0.016),
    contextBlock(itemNames[0]!, 0.221, 0.677, 0.114, 0.030), contextBlock(itemNames[1]!, 0.444, 0.448, 0.112, 0.031),
    contextBlock(itemNames[2]!, 0.639, 0.674, 0.166, 0.040)];
}

/** No child process is launched. Each written JSONL request produces one bounded synthetic response. */
export class ContextTestWorker extends EventEmitter implements ScreenReaderProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly requests: { request: ContextTestRequest; startedAt: number }[] = [];
  exitCode: number | null = null;
  acknowledgeKill = true;
  outstanding = 0;
  maximumOutstanding = 0;
  respond: (request: ContextTestRequest) => ContextTestResponse | undefined = request => ({ reply: contextReply(request), afterMs: 20 });
  private readonly responseTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    void signal;
    if (this.acknowledgeKill) queueMicrotask(() => this.confirmExit());
    return true;
  });
  constructor() {
    super();
    this.stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk).trim()) as ContextTestRequest;
      this.requests.push({ request, startedAt: Date.now() });
      this.outstanding++;
      this.maximumOutstanding = Math.max(this.maximumOutstanding, this.outstanding);
      const response = this.respond(request);
      if (!response) return;
      const timer = setTimeout(() => {
        this.responseTimers.delete(timer);
        this.outstanding--;
        this.output(response.reply);
      }, response.afterMs);
      this.responseTimers.add(timer);
    });
  }
  output(reply: unknown) { this.stdout.write(`${JSON.stringify(reply)}\n`); }
  confirmExit() {
    if (this.exitCode !== null) return;
    for (const timer of this.responseTimers) clearTimeout(timer);
    this.responseTimers.clear();
    this.outstanding = 0;
    this.exitCode = 0;
    this.emit('exit', 0); this.emit('close', 0);
  }
}
