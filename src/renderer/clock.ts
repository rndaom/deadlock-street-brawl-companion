import { useEffect, useReducer, useState } from 'react';
import type { ScreenReaderState } from '../shared/screen-reading';
import { SCREEN_CARD_HOLD_MS, SCREEN_CONTEXT_MAX_AGE_MS } from '../shared/screen-reading';
import { expectsGameReads, READ_PROGRESS_TIMEOUT_MS, READING_CONFIRM_TIMEOUT_MS } from './view';
import type { ReaderClock } from './view';

/**
 * Time inputs for the view. Instead of ticking every second, it schedules one timer for the
 * next moment the view can change (card hold expiry, an unconfirmed read, missing progress),
 * so an idle companion costs nothing between reader publications.
 */
export function useReaderClock(state: ScreenReaderState | null, retryNonce: number, active = true): ReaderClock {
  const [readingSince, setReadingSince] = useState<number | null>(null);
  const [lastProgressAt, setLastProgressAt] = useState<number | null>(null);
  const [, wake] = useReducer((count: number) => count + 1, 0);
  const status = state?.status;
  const enabled = state?.enabled;
  const expecting = active && expectsGameReads(state);
  const reads = state?.metrics.reads ?? 0;

  useEffect(() => { setReadingSince(active && status === 'reading' && enabled ? Date.now() : null); }, [active, status, enabled, retryNonce]);
  useEffect(() => { setLastProgressAt(expecting ? Date.now() : null); }, [expecting, reads, retryNonce]);

  const now = Date.now();
  const phaseAt = state?.matchContext.observations.phase?.capturedAt ?? null;
  const deadlines = active ? [
    readingSince !== null ? readingSince + READING_CONFIRM_TIMEOUT_MS : null,
    lastProgressAt !== null ? lastProgressAt + READ_PROGRESS_TIMEOUT_MS : null,
    state?.observedAt != null ? state.observedAt + SCREEN_CARD_HOLD_MS : null,
    phaseAt !== null ? phaseAt + SCREEN_CONTEXT_MAX_AGE_MS + 1 : null,
  ].filter((at): at is number => at !== null && at > now) : [];
  const next = deadlines.length ? Math.min(...deadlines) : null;
  useEffect(() => {
    if (next === null) return;
    const timer = window.setTimeout(wake, Math.max(1, next - Date.now() + 5));
    return () => window.clearTimeout(timer);
  }, [next]);

  return { now, readingSince, lastProgressAt };
}
