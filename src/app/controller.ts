import type { Advice, Catalog, MatchState, TelemetryEvent } from '../shared/types';
import { acceptAdvice, createInitialState, decisionBlockers, getDecisionKey, reduceTelemetry, sameDecisionKey } from '../core/store';
import { parseTelemetryEvent } from '../core/validation';
import { evaluateDecision } from '../core/scoring';

export interface ControllerOptions {
  now?: () => number;
  autoTick?: boolean;
  /** Reported in exported diagnostics. */
  applicationVersion?: string;
  score?: (state: MatchState, catalog: Catalog, now: number) => Promise<Advice | null>;
}

export function createController(publicCatalog: Catalog, options: ControllerOptions = {}) {
  const now = options.now ?? Date.now;
  const score = options.score ?? ((snapshot, catalog, at) => Promise.resolve(evaluateDecision(snapshot, catalog, at)));
  let state = createInitialState('live');
  let lastRequestedKey = '';
  let disposed = false;
  let evaluationEpoch = 0;
  let malformedUpdates = 0;
  let discardedResults = 0;
  let scorerFailures = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(snapshot: MatchState) => void>();
  const catalog = () => publicCatalog;
  const notify = () => { syncTimer(); for (const listener of listeners) listener(state); };

  function syncTimer() {
    // Only an open draft needs clock-based freshness/expiry checks. Provider events
    // wake the controller directly; waiting and combat need no polling interval.
    const deadline = state.match?.deadlineAt;
    const active = !disposed && options.autoTick !== false
      && state.match?.phase === 'draft' && state.draft !== null
      && state.source.status === 'connected' && state.source.continuity === 'continuous'
      && deadline != null && deadline > now();
    if (!active && timer !== null) { clearInterval(timer); timer = null; }
    if (active && timer === null) {
      timer = setInterval(tick, 250);
      // A diagnostics controller must not keep an otherwise closed process alive.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    }
  }

  function scheduleScore() {
    const currentCatalog = catalog();
    const key = getDecisionKey(state, currentCatalog.modelVersion, currentCatalog.revision);
    if (!key) { lastRequestedKey = ''; return; }
    const blockers = decisionBlockers(state, currentCatalog, now());
    const requestKey = JSON.stringify({ key, blockers });
    if (lastRequestedKey === requestKey) return;
    lastRequestedKey = requestKey;
    const snapshot = structuredClone(state);
    const epoch = evaluationEpoch;
    void score(snapshot, currentCatalog, now()).then(advice => {
      if (disposed || !advice) return;
      const presentCatalog = catalog();
      const currentKey = getDecisionKey(state, presentCatalog.modelVersion, presentCatalog.revision);
      if (epoch !== evaluationEpoch || !currentKey || !sameDecisionKey(advice.key, currentKey)) { discardedResults++; return; }
      // A matching generation still cannot revive advice after a deadline or a stale source.
      if (advice.kind === 'pick' && decisionBlockers(state, presentCatalog, now()).length > 0) { discardedResults++; return; }
      const next = acceptAdvice(state, advice, presentCatalog.modelVersion, presentCatalog.revision, now());
      if (next !== state) { state = next; notify(); }
    }).catch(() => { scorerFailures++; });
  }

  function apply(event: TelemetryEvent) {
    const next = reduceTelemetry(state, event);
    if (next !== state) { state = next; notify(); }
    scheduleScore();
  }

  function ingest(input: unknown) {
    if (disposed) return;
    try { apply(parseTelemetryEvent(input)); }
    catch {
      malformedUpdates++;
      apply({ type: 'source', source: { ...state.source, status: 'interrupted', continuity: 'gap', message: 'A provider update could not be validated. Advice is unavailable until state is restored.' } });
    }
  }

  function tick() {
    if (disposed) return;
    if (state.advice?.kind === 'pick' && decisionBlockers(state, catalog(), now()).length > 0) {
      state = { ...state, advice: null, counters: { ...state.counters, invalidated: state.counters.invalidated + 1 } };
      notify();
    }
    scheduleScore();
    syncTimer();
  }

  return {
    getState: () => state,
    getCatalog: catalog,
    subscribe(listener: (snapshot: MatchState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ingest, tick,
    exportDiagnostics() {
      return JSON.stringify({
        schemaVersion: 1, applicationVersion: options.applicationVersion ?? 'development', generatedAt: new Date(now()).toISOString(),
        mode: state.mode, provider: state.source.provider, status: state.source.status,
        runtimeVersion: state.source.runtimeVersion,
        capabilities: state.source.capabilities.map(({ name, supported, verified }) => ({ name, supported, verified })),
        noImageMethodVerified: state.source.noImageMethodVerified,
        continuity: state.source.continuity, sourceDeliveryBoundMs: state.source.deliveryBoundMs,
        sourceAgeProven: state.source.status === 'connected'
          && state.source.continuity === 'continuous'
          && state.source.capabilities.some(capability => capability.name === 'source_continuity' && capability.verified && capability.supported)
          && (state.source.deliveryBoundMs !== null || (state.draft?.observation.observedAt != null && state.draft?.observation.clockUncertaintyMs != null)),
        matchPresent: state.match !== null, rosterSeatCount: state.players.length,
        draftPresent: state.draft !== null, draftFeasibilityPassed: false, fullTrackingPassed: false,
        catalog: { clientVersion: publicCatalog.clientVersion, revision: publicCatalog.revision, liveModelValidated: publicCatalog.liveModelValidated },
        counts: { ...state.counters, malformedUpdates, discardedResults, scorerFailures },
        timing: { gameToAdviceP95Ms: null, receiptToRenderP95Ms: null, note: 'Not measured. Receive time alone does not establish source age.' },
        privacy: 'Aggregate operational diagnostics only. No game payloads, match IDs, seat IDs, hero/item choices, or player identifiers.',
      }, null, 2);
    },
    dispose() { disposed = true; evaluationEpoch++; syncTimer(); listeners.clear(); },
  };
}
