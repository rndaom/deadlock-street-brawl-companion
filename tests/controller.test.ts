import { describe, expect, it, vi } from 'vitest';
import { createController } from '../src/app/controller';
import { getDecisionKey } from '../src/core/store';
import { DEMO_CATALOG } from '../src/demo/scenarios';
import type { Advice, Catalog, MatchState } from '../src/shared/types';
import { advice, draft, fixtureEvents, item, MATCH_ID, match, NOW, observation, player, source, testCatalog } from './fixtures';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Pending {
  snapshot: MatchState;
  catalog: Catalog;
  at: number;
  resolve: (result: Advice | null) => void;
}

function delayedController() {
  let clock = NOW;
  const pending: Pending[] = [];
  const controller = createController(testCatalog, {
    now: () => clock, autoTick: false,
    score: (snapshot, catalog, at) => new Promise<Advice | null>((resolve) => pending.push({ snapshot, catalog, at, resolve })),
  });
  const complete = (entry: Pending, overrides: Partial<Advice> = {}) => {
    const key = getDecisionKey(entry.snapshot, entry.catalog.modelVersion, entry.catalog.revision);
    expect(key).not.toBeNull();
    entry.resolve(advice(key!, { computedAt: entry.at, evidence: entry.snapshot.mode === 'demo' ? 'synthetic' : 'mechanics', ...overrides }));
  };
  return { controller, pending, complete, setClock: (at: number) => { clock = at; } };
}

describe('application controller transactions', () => {
  it('leaves background timers asleep while waiting, in combat, or after returning to Live', async () => {
    vi.useFakeTimers({ now: NOW });
    const score = vi.fn(async () => null);
    const controller = createController(testCatalog, { score });
    try {
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(score).not.toHaveBeenCalled();
      controller.setMode('demo');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(score).toHaveBeenCalledTimes(1);
      controller.runDemoScenario('combat');
      expect(vi.getTimerCount()).toBe(0);
      controller.runDemoScenario('waiting');
      expect(vi.getTimerCount()).toBe(0);
      controller.runDemoScenario('draft');
      expect(vi.getTimerCount()).toBe(1);
      controller.setMode('live');
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.dispose(); vi.useRealTimers(); }
  });

  it('automatically expires draft advice and stops checking the closed deadline', async () => {
    vi.useFakeTimers({ now: NOW });
    const controller = createController(testCatalog);
    try {
      controller.setMode('demo');
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.getState().advice?.kind).toBe('pick');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(controller.getState().advice).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.getState().advice).toBeNull();
    } finally { controller.dispose(); vi.useRealTimers(); }
  });

  it('stops automatic checks after source interruption and disposal', () => {
    vi.useFakeTimers({ now: NOW });
    const controller = createController(testCatalog);
    try {
      for (const event of fixtureEvents()) controller.ingest(event);
      expect(vi.getTimerCount()).toBe(1);
      controller.ingest({ type: 'source', source: source({ status: 'interrupted', continuity: 'gap' }) });
      expect(vi.getTimerCount()).toBe(0);
      controller.setMode('demo');
      expect(vi.getTimerCount()).toBe(1);
      controller.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.dispose(); vi.useRealTimers(); }
  });

  it('publishes only complete fixture snapshots after entering Demo', async () => {
    const controller = createController(testCatalog, { now: () => NOW, autoTick: false });
    const published: MatchState[] = [];
    controller.subscribe((state) => published.push(state));
    try {
      controller.setMode('demo');
      await flush();
      const hydrated = published.filter((state) => state.match !== null);
      expect(hydrated.length).toBeGreaterThan(0);
      expect(hydrated.every((state) => state.mode === 'demo' && state.players.length === 8 && state.draft !== null)).toBe(true);
      expect(controller.getState().advice?.kind).toBe('pick');
      expect(controller.getCatalog().revision).toBe(DEMO_CATALOG.revision);
    } finally { controller.dispose(); }
  });

  it('clears all synthetic state on Demo to Live and restores the public catalogue', async () => {
    const controller = createController(testCatalog, { now: () => NOW, autoTick: false });
    try {
      controller.setMode('demo');
      await flush();
      expect(controller.getState().match).not.toBeNull();
      controller.setMode('live');
      const live = controller.getState();
      expect(live.mode).toBe('live');
      expect(live.match).toBeNull();
      expect(live.players).toEqual([]);
      expect(live.draft).toBeNull();
      expect(live.advice).toBeNull();
      expect(live.source.status).not.toBe('connected');
      expect(controller.getCatalog().revision).toBe(testCatalog.revision);
    } finally { controller.dispose(); }
  });

  it('ignores stopped Live-provider callbacks while Demo is active', async () => {
    const controller = createController(testCatalog, { now: () => NOW, autoTick: false });
    try {
      controller.setMode('demo');
      await flush();
      const before = structuredClone(controller.getState());
      for (const event of fixtureEvents()) controller.ingest(event);
      expect(controller.getState()).toEqual(before);
    } finally { controller.dispose(); }
  });

  it('requires Demo mode for a fixture transaction', () => {
    const controller = createController(testCatalog, { autoTick: false });
    try {
      expect(() => controller.runDemoScenario('draft')).toThrow();
      expect(controller.getState().match).toBeNull();
    } finally { controller.dispose(); }
  });

  it('keeps the Demo identity through every phase and explicit missing-data scenario', async () => {
    const controller = createController(testCatalog, { now: () => NOW, autoTick: false });
    try {
      controller.setMode('demo');
      for (const id of ['draft', 'rerolled', 'combat', 'interrupted', 'unknown-item', 'unknown-ranks', 'post-match', 'waiting'] as const) {
        controller.runDemoScenario(id);
        await flush();
        expect(controller.getState().mode).toBe('demo');
        expect(controller.getState().source.provider).toContain('Synthetic');
        if (['combat', 'interrupted', 'post-match', 'waiting'].includes(id)) {
          expect(controller.getState().advice?.kind).not.toBe('pick');
        }
      }
    } finally { controller.dispose(); }
  });

  it('uses the injected clock when accepting a current result', async () => {
    const work = delayedController();
    try {
      for (const event of fixtureEvents()) work.controller.ingest(event);
      expect(work.pending).toHaveLength(1);
      work.complete(work.pending[0]!);
      await flush();
      expect(work.controller.getState().advice?.kind).toBe('pick');
    } finally { work.controller.dispose(); }
  });

  it('does not let a pending Demo result populate the new Live epoch', async () => {
    const work = delayedController();
    try {
      work.controller.setMode('demo');
      const old = work.pending[0]!;
      work.controller.setMode('live');
      work.complete(old);
      await flush();
      expect(work.controller.getState().mode).toBe('live');
      expect(work.controller.getState().advice).toBeNull();
      expect(work.controller.getState().match).toBeNull();
    } finally { work.controller.dispose(); }
  });

  it('rejects an older offer generation and publishes its invalidation before new work completes', async () => {
    const work = delayedController();
    const published: MatchState[] = [];
    work.controller.subscribe((state) => published.push(state));
    try {
      for (const event of fixtureEvents()) work.controller.ingest(event);
      const old = work.pending[0]!;
      work.complete(old);
      await flush();
      expect(work.controller.getState().advice?.kind).toBe('pick');
      work.controller.ingest({ type: 'draft', matchId: MATCH_ID, draft: draft({ generation: 2, observation: observation(4) }) });
      expect(published.filter((state) => state.draft?.generation === 2).every((state) => state.advice === null)).toBe(true);
      expect(work.controller.getState().advice).toBeNull();
      expect(work.pending).toHaveLength(2);
      const newer = work.pending[1]!;
      work.complete(newer);
      await flush();
      expect(work.controller.getState().advice?.key.generation).toBe(2);
    } finally { work.controller.dispose(); }
  });

  it('rejects an unresolved old generation after newer offers have arrived', async () => {
    const work = delayedController();
    try {
      for (const event of fixtureEvents()) work.controller.ingest(event);
      const old = work.pending[0]!;
      work.controller.ingest({ type: 'draft', matchId: MATCH_ID, draft: draft({ generation: 2, observation: observation(4) }) });
      work.complete(old);
      await flush();
      expect(work.controller.getState().draft?.generation).toBe(2);
      expect(work.controller.getState().advice).toBeNull();
      expect(JSON.parse(work.controller.exportDiagnostics()).counts.discardedResults).toBe(1);
    } finally { work.controller.dispose(); }
  });

  it('does not restart a closed generation when a cached draft arrives after a pick', async () => {
    const work = delayedController();
    try {
      for (const event of fixtureEvents()) work.controller.ingest(event);
      const pending = work.pending[0]!;
      work.controller.ingest({ type: 'action', matchId: MATCH_ID, action: 'pick', observation: observation(4) });
      work.controller.ingest({ type: 'draft', matchId: MATCH_ID, draft: draft({ observation: observation(5) }) });
      work.complete(pending);
      await flush();
      expect(work.controller.getState().draft).toBeNull();
      expect(work.controller.getState().advice).toBeNull();
      expect(work.pending).toHaveLength(1);
    } finally { work.controller.dispose(); }
  });

  it('rejects a previous match result when the same seat index is reused', async () => {
    const work = delayedController();
    try {
      for (const event of fixtureEvents()) work.controller.ingest(event);
      const old = work.pending[0]!;
      work.controller.ingest({ type: 'match', match: match({ id: 'match-b', observation: observation(4) }) });
      work.controller.ingest({ type: 'roster', matchId: 'match-b', complete: true, players: Array.from({ length: 8 }, (_, seat) => player(seat, { observation: observation(5), inventoryObservation: observation(5), abilityObservation: observation(5) })), observation: observation(5) });
      work.controller.ingest({ type: 'draft', matchId: 'match-b', draft: draft({ observation: observation(6) }) });
      work.complete(old);
      await flush();
      expect(work.controller.getState().match?.id).toBe('match-b');
      expect(work.controller.getState().advice).toBeNull();
    } finally { work.controller.dispose(); }
  });

  it('rejects a matching pending result once the confirmed draft deadline has passed', async () => {
    const work = delayedController();
    try {
      work.controller.setMode('demo');
      const pending = work.pending[0]!;
      const deadline = work.controller.getState().match!.deadlineAt!;
      work.setClock(deadline + 1);
      work.complete(pending);
      await flush();
      expect(work.controller.getState().advice).toBeNull();
    } finally { work.controller.dispose(); }
  });

  it('expires an existing directive without needing a new provider packet', async () => {
    const work = delayedController();
    try {
      work.controller.setMode('demo');
      work.complete(work.pending[0]!);
      await flush();
      expect(work.controller.getState().advice?.kind).toBe('pick');
      work.setClock(work.controller.getState().match!.deadlineAt! + 1);
      work.controller.tick();
      expect(work.controller.getState().advice).toBeNull();
    } finally { work.controller.dispose(); }
  });

  it('isolates scoring input from subsequent source-state mutation', () => {
    const work = delayedController();
    try {
      for (const event of fixtureEvents()) work.controller.ingest(event);
      work.pending[0]!.snapshot.players[0]!.inventory.push(item('a'));
      expect(work.controller.getState().players[0]!.inventory).toEqual([]);
    } finally { work.controller.dispose(); }
  });

  it('invalidates current advice on malformed input without preserving the rejected payload', async () => {
    const work = delayedController();
    try {
      for (const event of fixtureEvents()) work.controller.ingest(event);
      work.complete(work.pending[0]!);
      await flush();
      work.controller.ingest({ type: 'inventory', rawPrivatePayload: 'must-not-be-retained' });
      expect(work.controller.getState().advice).toBeNull();
      expect(work.controller.getState().source.status).toBe('interrupted');
      const diagnostics = work.controller.exportDiagnostics();
      expect(diagnostics).not.toContain('must-not-be-retained');
      expect(JSON.parse(diagnostics).counts.malformedUpdates).toBe(1);
    } finally { work.controller.dispose(); }
  });

  it('exports aggregates without identities, choices, source messages or raw payloads', () => {
    const controller = createController(testCatalog, { now: () => NOW, autoTick: false });
    try {
      controller.ingest({ type: 'source', source: source({ message: 'private-source-message' }) });
      controller.ingest({ type: 'match', match: match({ id: 'private-match-id' }) });
      controller.ingest({
        type: 'roster', matchId: 'private-match-id', complete: false, observation: observation(2),
        players: [player(0, { playerName: 'private-player-name', steamId: '76561190000000999', heroId: 'private-hero-id', inventory: [item('private-item-id')] })],
      });
      const text = controller.exportDiagnostics();
      for (const sensitive of ['private-source-message', 'private-match-id', 'private-player-name', '76561190000000999', 'private-hero-id', 'private-item-id']) {
        expect(text).not.toContain(sensitive);
      }
      const diagnostics = JSON.parse(text);
      expect(diagnostics.matchPresent).toBe(true);
      expect(diagnostics.rosterSeatCount).toBe(1);
      expect(diagnostics.draftFeasibilityPassed).toBe(false);
      expect(diagnostics.fullTrackingPassed).toBe(false);
      expect(diagnostics.timing.gameToAdviceP95Ms).toBeNull();
    } finally { controller.dispose(); }
  });

  it('does not publish a late result after disposal', async () => {
    const work = delayedController();
    for (const event of fixtureEvents()) work.controller.ingest(event);
    work.controller.dispose();
    work.complete(work.pending[0]!);
    await flush();
    expect(work.controller.getState().advice).toBeNull();
  });
});
