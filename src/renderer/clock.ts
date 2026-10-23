import { useEffect, useReducer, useState } from 'react';
import type { ScreenReaderState } from '../shared/screen-reading';
import { cardHoldMs, SCREEN_CONTEXT_MAX_AGE_MS } from '../shared/screen-reading';
import { AP_PROMPT_MAX_AGE_MS } from '../shared/overlay';
import { ABILITY_POINTS_MAX_AGE_MS, expectsGameReads, READ_PROGRESS_TIMEOUT_MS, READING_CONFIRM_TIMEOUT_MS } from './view';
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
  const pointsAt = state?.abilityPoints?.at ?? null;
  const deadlines = active ? [
    readingSince !== null ? readingSince + READING_CONFIRM_TIMEOUT_MS : null,
    lastProgressAt !== null ? lastProgressAt + READ_PROGRESS_TIMEOUT_MS : null,
    state?.observedAt != null ? state.observedAt + cardHoldMs(state) : null,
    phaseAt !== null ? phaseAt + SCREEN_CONTEXT_MAX_AGE_MS + 1 : null,
    // The unspent-points counter: the overlay's spend prompt, then the companion's AP display.
    pointsAt !== null ? pointsAt + AP_PROMPT_MAX_AGE_MS : null,
    pointsAt !== null ? pointsAt + ABILITY_POINTS_MAX_AGE_MS : null,
  ].filter((at): at is number => at !== null && at > now) : [];
  const next = deadlines.length ? Math.min(...deadlines) : null;
  useEffect(() => {
    if (next === null) return;
    const timer = window.setTimeout(wake, Math.max(1, next - Date.now() + 5));
    return () => window.clearTimeout(timer);
  }, [next]);

  return { now, readingSince, lastProgressAt };
}
