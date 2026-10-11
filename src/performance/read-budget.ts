/** Scheduling ceilings, not measured CPU/GPU utilization or an FPS guarantee. */
export const READ_BUDGET_LIMITS = Object.freeze({ readsPerSecond: 2, timeoutMs: 250, workerWallShare: 0.2 });

export interface ReadContext {
  gamePresent: boolean | null;
  phase: 'unknown' | 'waiting' | 'draft' | 'combat' | 'transition' | 'finished';
  ready: boolean;
  matchId: string | null;
  /** An opaque token covering source session, round, draft and offer generation. */
  generation: string | null;
}
export interface ReadJob { readonly requestId: number; readonly matchId: string; readonly generation: string }
export interface ReadResult<T> extends ReadJob { value: T }
export interface BackgroundReadDriver<T> {
  /** Dispatch to an already prepared dedicated worker; never perform synchronous/cold startup here. */
  run(context: ReadJob): Promise<ReadResult<T>>;
  /** Resolve only after underlying work is quiescent. An abort flag or a raced Promise is insufficient. */
  stop(): Promise<void>;
  /** Explicitly true only if stop preserves a warm driver without any cold initialization on reuse. */
  stopPreservesReadiness?: boolean;
}
type SkipReason = 'disabled' | 'disposed' | 'faulted' | 'busy' | 'cooldown' | 'pressure'
  | 'game-absent' | 'not-draft' | 'not-ready' | 'outside-game-required';
type CancelReason = 'context-changed' | 'disabled' | 'pressure' | 'disposed' | 'timeout' | 'worker-error';
export type ReadOutcome<T> =
  | { kind: 'accepted'; result: ReadResult<T>; elapsedWallMs: number }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'discarded'; reason: CancelReason | 'mixed-generation'; elapsedWallMs: number }
  | { kind: 'failed'; reason: 'worker-stop-failed'; elapsedWallMs: number };
export type PrepareOutcome =
  | { kind: 'prepared' }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'discarded'; reason: CancelReason }
  | { kind: 'failed'; reason: 'worker-stop-failed' };
export interface ReadBudgetOptions {
  /** Monotonic wall-clock milliseconds; injected for deterministic tests. */
  now?: () => number;
  /** Overrides may tighten the ceilings, never raise them. */
  readsPerSecond?: number;
  timeoutMs?: number;
  workerWallShare?: number;
}
export interface ReadBudgetStatus {
  enabled: boolean; prepared: boolean; pressure: boolean; disposed: boolean;
  active: 'read' | 'prepare' | 'stopping' | null;
  fault: 'worker-stop-failed' | null;
  /** True means termination could not be confirmed; actual worker occupation is unknown. */
  workerTerminationUnknown: boolean;
  cooldownRemainingMs: number; lastReadWallMs: number | null;
  limits: Readonly<{ readsPerSecond: number; timeoutMs: number; workerWallShare: number }>;
  counts: { reads: number; accepted: number; skipped: number; discarded: number; timeouts: number; workerErrors: number; stopFailures: number; preparations: number };
}

function ceiling(value: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new RangeError(`${name} must be positive and at most ${maximum}.`);
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
type StopResult = { ok: boolean; reason: CancelReason };
interface ActiveJob {
  kind: 'read' | 'prepare'; startedAt: number; epoch: number; stopped: ReturnType<typeof deferred<StopResult>>;
  timer: ReturnType<typeof setTimeout> | null; stopping?: Promise<StopResult>;
  finished: boolean; elapsedWallMs: number;
}

/**
 * One slot, no stored frames and no automatic retry/queue. The caller requests a fresh
 * read when useful; busy/cooldown requests are dropped immediately. Preparation is
 * explicit and allowed only with confirmed game absence. Its callback initializes
 * the same dedicated driver and must also be stoppable through driver.stop().
 *
 * Timeout requests worker termination; reuse remains locked until stop resolves.
 * A stop rejection permanently closes the governor. A never-settling stop keeps the
 * slot locked. Unless the driver explicitly promises a reusable warm worker, stop
 * clears readiness and recovery requires preparation outside the game. Preparation
 * is outside the per-read timer because model loading may take longer than a read.
 * JS timers cannot preempt synchronous code, native work or a blocked
 * event loop: the dedicated-worker/verified-stop driver contract is essential.
 */
export function createReadBudgetGovernor<T>(driver: BackgroundReadDriver<T>, options: ReadBudgetOptions = {}) {
  const now = options.now ?? (() => performance.now());
  const limits = Object.freeze({
    readsPerSecond: ceiling(options.readsPerSecond ?? 2, 2, 'readsPerSecond'),
    timeoutMs: ceiling(options.timeoutMs ?? 250, 250, 'timeoutMs'),
    workerWallShare: ceiling(options.workerWallShare ?? 0.2, 0.2, 'workerWallShare'),
  });
  let context: ReadContext = { gamePresent: null, phase: 'unknown', ready: false, matchId: null, generation: null };
  let enabled = false;
  let prepared = false;
  let pressure = false;
  let disposed = false;
  let fault: 'worker-stop-failed' | null = null;
  let active: ActiveJob | null = null;
  let epoch = 0;
  let requestId = 0;
  let nextReadAt = -Infinity;
  let lastReadWallMs: number | null = null;
  let disposal: Promise<void> | null = null;
  const counts = { reads: 0, accepted: 0, skipped: 0, discarded: 0, timeouts: 0, workerErrors: 0, stopFailures: 0, preparations: 0 };

  function unavailable(): SkipReason | null {
    return disposed ? 'disposed' : fault ? 'faulted' : active ? 'busy' : pressure ? 'pressure' : null;
  }
  function eligibility(): SkipReason | null {
    const blocked = unavailable();
    if (blocked) return blocked;
    if (!enabled) return 'disabled';
    if (context.gamePresent !== true) return 'game-absent';
    if (context.phase !== 'draft') return 'not-draft';
    if (!prepared || !context.ready || !context.matchId?.trim() || !context.generation?.trim()) return 'not-ready';
    return now() < nextReadAt ? 'cooldown' : null;
  }
  function finish(job: ActiveJob) {
    if (job.finished) return;
    job.finished = true;
    if (job.timer !== null) clearTimeout(job.timer);
    job.elapsedWallMs = Math.max(0, now() - job.startedAt);
    if (job.kind === 'read') {
      lastReadWallMs = job.elapsedWallMs;
      // A 100 ms occupation needs at least 400 ms idle for a 20% walltime share.
      nextReadAt = Math.max(job.startedAt + 1000 / limits.readsPerSecond,
        now() + job.elapsedWallMs * (1 / limits.workerWallShare - 1));
    }
    if (active === job) active = null;
  }
  function stop(job: ActiveJob, reason: CancelReason): Promise<StopResult> {
    if (job.stopping) return job.stopping;
    if (job.timer !== null) clearTimeout(job.timer);
    if (job.kind === 'prepare' || driver.stopPreservesReadiness !== true) prepared = false;
    if (reason === 'timeout') counts.timeouts++;
    job.stopping = Promise.resolve().then(() => driver.stop()).then(() => ({ ok: true, reason }), () => {
      fault = 'worker-stop-failed'; enabled = false; prepared = false; counts.stopFailures++;
      return { ok: false, reason };
    }).then((result) => {
      finish(job);
      job.stopped.resolve(result);
      return result;
    });
    return job.stopping;
  }
  async function cancel(reason: CancelReason) {
    epoch++;
    if (active) await stop(active, reason);
  }
  function makeJob(kind: ActiveJob['kind']): ActiveJob {
    const job: ActiveJob = { kind, startedAt: now(), epoch, stopped: deferred(), timer: null, finished: false, elapsedWallMs: 0 };
    active = job;
    return job;
  }

  async function requestRead(): Promise<ReadOutcome<T>> {
    const blocked = eligibility();
    if (blocked) { counts.skipped++; return { kind: 'skipped', reason: blocked }; }
    const job = makeJob('read');
    counts.reads++;
    const input: ReadJob = Object.freeze({ requestId: ++requestId, matchId: context.matchId!, generation: context.generation! });
    job.timer = setTimeout(() => { void stop(job, 'timeout'); }, limits.timeoutMs);
    // No cancellation side effects belong in this promise: it may settle after a new job.
    const work = Promise.resolve().then(() => {
      if (job.stopping || job.epoch !== epoch || !enabled || disposed || pressure
        || context.gamePresent !== true || context.phase !== 'draft' || !prepared || !context.ready) return null;
      return driver.run(input);
    }).then(
      (result) => ({ kind: 'result' as const, result }),
      () => ({ kind: 'error' as const }),
    );
    const winner = await Promise.race([work, job.stopped.promise.then((result) => ({ kind: 'stopped' as const, result }))]);
    // A delayed event loop may deliver a result before an overdue timeout callback.
    if (winner.kind === 'result' && !job.stopping && now() - job.startedAt >= limits.timeoutMs) await stop(job, 'timeout');
    if (winner.kind === 'error') { counts.workerErrors++; await stop(job, 'worker-error'); }
    if (job.stopping) {
      const stopped = await job.stopping;
      counts.discarded++;
      return stopped.ok ? { kind: 'discarded', reason: stopped.reason, elapsedWallMs: job.elapsedWallMs }
        : { kind: 'failed', reason: 'worker-stop-failed', elapsedWallMs: job.elapsedWallMs };
    }
    finish(job);
    if (winner.kind !== 'result' || job.epoch !== epoch || !enabled || disposed || pressure
      || winner.result?.requestId !== input.requestId || winner.result?.matchId !== input.matchId || winner.result?.generation !== input.generation) {
      counts.discarded++;
      return { kind: 'discarded', reason: job.epoch !== epoch ? 'context-changed' : 'mixed-generation', elapsedWallMs: job.elapsedWallMs };
    }
    counts.accepted++;
    return { kind: 'accepted', result: winner.result!, elapsedWallMs: job.elapsedWallMs };
  }

  async function prepare(initialize: () => Promise<void>): Promise<PrepareOutcome> {
    const blocked = unavailable();
    if (blocked) return { kind: 'skipped', reason: blocked };
    if (context.gamePresent !== false || context.matchId !== null) return { kind: 'skipped', reason: 'outside-game-required' };
    const job = makeJob('prepare');
    prepared = false;
    counts.preparations++;
    const work = Promise.resolve().then(() => {
      if (job.stopping || job.epoch !== epoch || disposed || pressure || context.gamePresent !== false || context.matchId !== null) return;
      return initialize();
    }).then(() => ({ kind: 'ready' as const }), () => ({ kind: 'error' as const }));
    const winner = await Promise.race([work, job.stopped.promise.then((result) => ({ kind: 'stopped' as const, result }))]);
    if (winner.kind === 'error') { counts.workerErrors++; await stop(job, 'worker-error'); }
    if (job.stopping) {
      const stopped = await job.stopping;
      return stopped.ok ? { kind: 'discarded', reason: stopped.reason } : { kind: 'failed', reason: 'worker-stop-failed' };
    }
    finish(job);
    if (job.epoch !== epoch || disposed || pressure || context.gamePresent !== false || context.matchId !== null) return { kind: 'discarded', reason: 'context-changed' };
    prepared = true;
    return { kind: 'prepared' };
  }

  return {
    requestRead, prepare,
    async setEnabled(value: boolean) {
      if (typeof value !== 'boolean') throw new TypeError('enabled must be a boolean.');
      enabled = value && !disposed && fault === null;
      if (!enabled) await cancel('disabled');
      return enabled;
    },
    async updateContext(next: ReadContext) {
      if (disposed || fault) return;
      if (context.gamePresent === next.gamePresent && context.phase === next.phase && context.ready === next.ready
        && context.matchId === next.matchId && context.generation === next.generation) return;
      context = { gamePresent: next.gamePresent, phase: next.phase, ready: next.ready, matchId: next.matchId, generation: next.generation };
      await cancel('context-changed');
    },
    async setWorkloadPressure(value: boolean) {
      if (typeof value !== 'boolean') throw new TypeError('pressure must be a boolean.');
      pressure = value;
      if (pressure) await cancel('pressure');
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true; enabled = false; prepared = false; epoch++;
      disposal = (async () => {
        if (active) await stop(active, 'disposed');
        else if (!fault) {
          try { await driver.stop(); } catch { fault = 'worker-stop-failed'; counts.stopFailures++; }
        }
      })();
      return disposal;
    },
    getStatus(): ReadBudgetStatus {
      return {
        enabled, prepared, pressure, disposed,
        active: active ? (active.stopping ? 'stopping' : active.kind) : null,
        fault, workerTerminationUnknown: fault !== null,
        cooldownRemainingMs: Math.max(0, nextReadAt - now()), lastReadWallMs,
        limits, counts: { ...counts },
      };
    },
  };
}
