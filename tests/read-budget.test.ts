import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createReadBudgetGovernor, READ_BUDGET_LIMITS,
  type BackgroundReadDriver, type ReadBudgetOptions, type ReadContext, type ReadJob, type ReadResult,
} from '../src/performance/read-budget';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const outside: ReadContext = { gamePresent: false, phase: 'waiting', ready: false, matchId: null, generation: null };
const draft: ReadContext = { gamePresent: true, phase: 'draft', ready: true, matchId: 'synthetic-match', generation: 'source-a/round-1/draft-a/1' };
type Governor = ReturnType<typeof createReadBudgetGovernor<string>>;
const governors: Governor[] = [];
const flush = () => vi.advanceTimersByTimeAsync(0);

function fixture(options: ReadBudgetOptions = {}) {
  const pending: Array<ReturnType<typeof deferred<ReadResult<string>>> & { context: ReadJob }> = [];
  const driver: BackgroundReadDriver<string> = {
    run: vi.fn((context: ReadJob) => {
      const job = { ...deferred<ReadResult<string>>(), context };
      pending.push(job);
      return job.promise;
    }),
    stop: vi.fn(async () => {}),
  };
  const governor = createReadBudgetGovernor(driver, { now: () => Date.now(), ...options });
  governors.push(governor);
  const initialize = vi.fn(async () => {});
  const warm = async () => {
    await governor.updateContext(outside);
    expect(await governor.prepare(initialize)).toEqual({ kind: 'prepared' });
    await governor.updateContext(draft);
    await governor.setEnabled(true);
  };
  const complete = (index = 0, fields: Partial<ReadResult<string>> = {}) => {
    const job = pending[index]!;
    job.resolve({ ...job.context, value: 'synthetic parsed offers', ...fields });
  };
  return { governor, driver, pending, initialize, warm, complete };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(async () => {
  await Promise.all(governors.splice(0).map((governor) => governor.dispose()));
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('explicit readiness and eligibility', () => {
  it('starts disabled and performs no work or preparation automatically', async () => {
    const work = fixture();
    expect(work.governor.getStatus().enabled).toBe(false);
    expect(work.governor.getStatus().prepared).toBe(false);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'disabled' });
    expect(work.driver.run).not.toHaveBeenCalled();
    expect(work.initialize).not.toHaveBeenCalled();
  });

  it.each([
    { ...outside, gamePresent: null },
    { ...outside, gamePresent: true },
    { ...outside, matchId: 'still-in-a-match' },
  ] satisfies ReadContext[])('requires confirmed game absence and no match before preparation: %j', async (context) => {
    const work = fixture();
    await work.governor.updateContext(context);
    expect(await work.governor.prepare(work.initialize)).toEqual({ kind: 'skipped', reason: 'outside-game-required' });
    expect(work.initialize).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...draft, gamePresent: false }, 'game-absent'],
    [{ ...draft, gamePresent: null }, 'game-absent'],
    [{ ...draft, phase: 'unknown' }, 'not-draft'],
    [{ ...draft, phase: 'combat' }, 'not-draft'],
    [{ ...draft, phase: 'transition' }, 'not-draft'],
    [{ ...draft, phase: 'finished' }, 'not-draft'],
    [{ ...draft, ready: false }, 'not-ready'],
    [{ ...draft, matchId: null }, 'not-ready'],
    [{ ...draft, generation: null }, 'not-ready'],
    [{ ...draft, generation: ' ' }, 'not-ready'],
  ] as const)('withholds reads for an ineligible context: %j', async (context, reason) => {
    const work = fixture();
    await work.warm();
    await work.governor.updateContext(context);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason });
    expect(work.driver.run).not.toHaveBeenCalled();
  });

  it('requires explicit preparation rather than trusting a ready flag to cold-start in a draft', async () => {
    const work = fixture();
    await work.governor.updateContext(draft);
    await work.governor.setEnabled(true);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'not-ready' });
    expect(work.driver.run).not.toHaveBeenCalled();
  });

  it('keeps costly preparation outside the per-read budget and does not queue a first frame', async () => {
    const work = fixture();
    await work.governor.updateContext(outside);
    const load = deferred<void>();
    const preparing = work.governor.prepare(() => load.promise);
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(work.governor.getStatus().active).toBe('prepare');
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'busy' });
    load.resolve();
    expect(await preparing).toEqual({ kind: 'prepared' });
    expect(work.governor.getStatus().cooldownRemainingMs).toBe(0);
    expect(work.driver.run).not.toHaveBeenCalled();
  });
});

describe('single slot, rate and elapsed walltime accounting', () => {
  it('drops busy requests instead of buffering frames or starting work after completion', async () => {
    const work = fixture();
    await work.warm();
    const first = work.governor.requestRead();
    const skipped = await Promise.all(Array.from({ length: 40 }, () => work.governor.requestRead()));
    expect(skipped.every((result) => result.kind === 'skipped' && result.reason === 'busy')).toBe(true);
    await flush();
    expect(work.driver.run).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(work.pending[0]!.context)).toBe(true);
    work.complete();
    expect((await first).kind).toBe('accepted');
    await vi.advanceTimersByTimeAsync(5000);
    expect(work.driver.run).toHaveBeenCalledTimes(1);
  });

  it('allows at most two starts per second by default', async () => {
    const work = fixture();
    await work.warm();
    const first = work.governor.requestRead();
    await flush(); work.complete(); await first;
    await vi.advanceTimersByTimeAsync(499);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'cooldown' });
    await vi.advanceTimersByTimeAsync(1);
    const second = work.governor.requestRead();
    await flush();
    expect(work.driver.run).toHaveBeenCalledTimes(2);
    work.complete(1);
    expect((await second).kind).toBe('accepted');
  });

  it('adds 800 ms idle after a 200 ms read to target a 20% worker walltime share', async () => {
    const work = fixture();
    await work.warm();
    const result = work.governor.requestRead();
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    work.complete();
    expect(await result).toMatchObject({ kind: 'accepted', elapsedWallMs: 200 });
    expect(work.governor.getStatus()).toMatchObject({ lastReadWallMs: 200, cooldownRemainingMs: 800 });
    await vi.advanceTimersByTimeAsync(799);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'cooldown' });
    await vi.advanceTimersByTimeAsync(1);
    const next = work.governor.requestRead();
    await flush(); work.complete(1); await next;
  });

  it.each([
    { readsPerSecond: 2.01 }, { readsPerSecond: 0 }, { timeoutMs: 251 }, { timeoutMs: NaN },
    { workerWallShare: 0.21 }, { workerWallShare: Infinity }, { workerWallShare: -1 },
  ])('cannot raise or invalidate the scheduling ceilings: %j', (options) => {
    expect(() => fixture(options)).toThrow(RangeError);
  });

  it('supports stricter limits and reports walltime labels without frame contents', async () => {
    const work = fixture({ readsPerSecond: 1, timeoutMs: 100, workerWallShare: 0.1 });
    await work.warm();
    const read = work.governor.requestRead();
    await flush(); await vi.advanceTimersByTimeAsync(80); work.complete(); await read;
    const status = work.governor.getStatus();
    expect(status.limits).toEqual({ readsPerSecond: 1, timeoutMs: 100, workerWallShare: 0.1 });
    expect(status.cooldownRemainingMs).toBe(920);
    expect(JSON.stringify(status)).not.toContain('synthetic parsed offers');
    expect(JSON.stringify(status)).not.toContain(draft.matchId);
    status.counts.reads = 999;
    expect(work.governor.getStatus().counts.reads).toBe(1);
    expect(READ_BUDGET_LIMITS).toEqual({ readsPerSecond: 2, timeoutMs: 250, workerWallShare: 0.2 });
  });
});

describe('timeout and real worker stop barriers', () => {
  it('requests termination at 250 ms and holds the slot until stop confirms quiescence', async () => {
    const work = fixture();
    work.driver.stopPreservesReadiness = true;
    await work.warm();
    const termination = deferred<void>();
    vi.mocked(work.driver.stop).mockImplementationOnce(() => termination.promise);
    const read = work.governor.requestRead();
    let settled = false;
    void read.then(() => { settled = true; });
    await flush();
    await vi.advanceTimersByTimeAsync(249);
    expect(work.driver.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(work.driver.stop).toHaveBeenCalledTimes(1);
    expect(work.governor.getStatus().active).toBe('stopping');
    expect(settled).toBe(false);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'busy' });
    await vi.advanceTimersByTimeAsync(50);
    termination.resolve();
    expect(await read).toEqual({ kind: 'discarded', reason: 'timeout', elapsedWallMs: 300 });
    expect(work.governor.getStatus().cooldownRemainingMs).toBe(1200);
    await vi.advanceTimersByTimeAsync(1200);
    const next = work.governor.requestRead();
    await flush();
    work.complete(0, { value: 'late old result' });
    await flush();
    expect(work.governor.getStatus().counts.accepted).toBe(0);
    expect(work.governor.getStatus().active).toBe('read');
    work.complete(1, { value: 'current result' });
    expect(await next).toMatchObject({ kind: 'accepted', result: { value: 'current result' } });
  });

  it('requires outside-game preparation after stop unless warm reuse is explicit', async () => {
    const work = fixture();
    await work.warm();
    const read = work.governor.requestRead();
    await vi.advanceTimersByTimeAsync(250);
    expect((await read).kind).toBe('discarded');
    expect(work.governor.getStatus().prepared).toBe(false);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'not-ready' });
    expect(await work.governor.prepare(work.initialize)).toEqual({ kind: 'skipped', reason: 'outside-game-required' });
    await vi.advanceTimersByTimeAsync(1000);
    await work.warm();
    const next = work.governor.requestRead();
    await flush(); work.complete(1); expect((await next).kind).toBe('accepted');
  });

  it('rejects an overdue result even when its promise wins before the timer callback', async () => {
    let clock = 0;
    const work = fixture({ now: () => clock });
    await work.warm();
    vi.mocked(work.driver.run).mockImplementation(async (job) => { clock = 300; return { ...job, value: 'late' }; });
    expect(await work.governor.requestRead()).toEqual({ kind: 'discarded', reason: 'timeout', elapsedWallMs: 300 });
    expect(work.driver.stop).toHaveBeenCalledTimes(1);
    expect(work.governor.getStatus().counts.timeouts).toBe(1);
  });

  it('fails closed if termination rejects and never silently restarts the worker', async () => {
    const work = fixture();
    await work.warm();
    vi.mocked(work.driver.stop).mockRejectedValueOnce(new Error('synthetic stop failure'));
    const read = work.governor.requestRead();
    await vi.advanceTimersByTimeAsync(250);
    expect(await read).toMatchObject({ kind: 'failed', reason: 'worker-stop-failed' });
    expect(work.governor.getStatus()).toMatchObject({ enabled: false, prepared: false, fault: 'worker-stop-failed', workerTerminationUnknown: true });
    expect(await work.governor.setEnabled(true)).toBe(false);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'faulted' });
    expect(await work.governor.prepare(work.initialize)).toEqual({ kind: 'skipped', reason: 'faulted' });
    work.complete(); await flush();
    expect(work.governor.getStatus().counts.accepted).toBe(0);
    expect(work.driver.run).toHaveBeenCalledTimes(1);
  });

  it('cleans up worker rejection before permitting reuse', async () => {
    const work = fixture();
    await work.warm();
    const read = work.governor.requestRead();
    await flush();
    work.pending[0]!.reject(new Error('synthetic worker error'));
    expect(await read).toMatchObject({ kind: 'discarded', reason: 'worker-error' });
    expect(work.driver.stop).toHaveBeenCalledTimes(1);
    expect(work.governor.getStatus().counts.workerErrors).toBe(1);
    expect(work.governor.getStatus().prepared).toBe(false);
  });
});

describe('generation, pause and preparation races', () => {
  it.each([{ generation: 'wrong-generation' }, { matchId: 'other-match' }, { requestId: 99 }])('discards mixed worker identity: %j', async (fields) => {
    const work = fixture(); await work.warm();
    const read = work.governor.requestRead(); await flush(); work.complete(0, fields);
    expect(await read).toMatchObject({ kind: 'discarded', reason: 'mixed-generation' });
    expect(work.governor.getStatus().counts.accepted).toBe(0);
  });

  it('does not dispatch a read disabled before the dispatch microtask', async () => {
    const work = fixture(); await work.warm();
    const read = work.governor.requestRead();
    await work.governor.setEnabled(false);
    expect(await read).toMatchObject({ kind: 'discarded', reason: 'disabled' });
    expect(work.driver.run).not.toHaveBeenCalled();
  });

  it('does not start costly initialization after the game appears before dispatch', async () => {
    const work = fixture(); await work.governor.updateContext(outside);
    const preparation = work.governor.prepare(work.initialize);
    await work.governor.updateContext(draft);
    expect(await preparation).toEqual({ kind: 'discarded', reason: 'context-changed' });
    expect(work.initialize).not.toHaveBeenCalled();
    expect(work.governor.getStatus().prepared).toBe(false);
  });

  it('never commits a late prepared result after game/context changes', async () => {
    const work = fixture(); await work.governor.updateContext(outside);
    const loading = deferred<void>();
    const termination = deferred<void>();
    vi.mocked(work.driver.stop).mockImplementationOnce(() => termination.promise);
    const preparation = work.governor.prepare(() => loading.promise);
    await flush();
    const changed = work.governor.updateContext(draft);
    loading.resolve(); await flush();
    expect(work.governor.getStatus()).toMatchObject({ active: 'stopping', prepared: false });
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'busy' });
    termination.resolve(); await changed;
    expect(await preparation).toEqual({ kind: 'discarded', reason: 'context-changed' });
    await work.governor.setEnabled(true);
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'not-ready' });
  });

  it('invalidates a read even if context changes away and then back to the same generation', async () => {
    const work = fixture(); await work.warm();
    const read = work.governor.requestRead(); await flush();
    const termination = deferred<void>();
    vi.mocked(work.driver.stop).mockImplementationOnce(() => termination.promise);
    const changed = work.governor.updateContext({ ...draft, generation: 'next' });
    const reverted = work.governor.updateContext(draft);
    work.complete(); await flush();
    expect(work.governor.getStatus().counts.accepted).toBe(0);
    termination.resolve(); await Promise.all([changed, reverted]);
    expect(await read).toMatchObject({ kind: 'discarded', reason: 'context-changed' });
  });

  it('pauses work for reported pressure, with no automatic frame retry when pressure clears', async () => {
    const work = fixture(); await work.warm();
    const read = work.governor.requestRead(); await flush();
    await work.governor.setWorkloadPressure(true);
    expect(await read).toMatchObject({ kind: 'discarded', reason: 'pressure' });
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'pressure' });
    await work.governor.setWorkloadPressure(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(work.driver.run).toHaveBeenCalledTimes(1);
  });

  it('disposes idempotently, waits for termination and cannot be enabled again', async () => {
    const work = fixture(); await work.warm();
    const read = work.governor.requestRead(); await flush();
    const termination = deferred<void>();
    vi.mocked(work.driver.stop).mockImplementationOnce(() => termination.promise);
    const disposing = work.governor.dispose();
    expect(work.governor.dispose()).toBe(disposing);
    expect(work.governor.getStatus()).toMatchObject({ disposed: true, enabled: false, active: 'stopping' });
    expect(await work.governor.requestRead()).toEqual({ kind: 'skipped', reason: 'disposed' });
    termination.resolve(); await disposing;
    expect(await read).toMatchObject({ kind: 'discarded', reason: 'disposed' });
    expect(await work.governor.setEnabled(true)).toBe(false);
    expect(work.driver.stop).toHaveBeenCalledTimes(1);
  });

  it('also closes idle prepared resources and reports an unsuccessful dispose', async () => {
    const work = fixture(); await work.warm();
    vi.mocked(work.driver.stop).mockRejectedValueOnce(new Error('synthetic dispose failure'));
    await work.governor.dispose();
    expect(work.governor.getStatus()).toMatchObject({ disposed: true, prepared: false, fault: 'worker-stop-failed', workerTerminationUnknown: true });
  });
});
