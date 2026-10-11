import { describe, expect, it } from 'vitest';
import { createInitialScreenReaderState } from '../src/shared/screen-reading';
import { newestScreenReaderState } from '../src/renderer/screen-state';

describe('reader publication ordering in the renderer', () => {
  it('does not let an old initial-state response restore a closed draft', () => {
    const closed = { ...createInitialScreenReaderState(), revision: 12, status: 'waiting-draft' as const };
    const old = { ...closed, revision: 11, status: 'reading' as const };
    expect(newestScreenReaderState(closed, old)).toBe(closed);
  });
  it('does not let a delayed preview response replace a newer pause', () => {
    const paused = { ...createInitialScreenReaderState(), revision: 7, status: 'paused' as const, enabled: false };
    expect(newestScreenReaderState(paused, { ...paused, revision: 6, enabled: true, status: 'reading' })).toBe(paused);
  });
  it('accepts an initial snapshot and then a strictly newer publication', () => {
    const first = createInitialScreenReaderState();
    const next = { ...first, revision: 1, status: 'waiting-draft' as const };
    expect(newestScreenReaderState(null, first)).toBe(first);
    expect(newestScreenReaderState(first, next)).toBe(next);
    expect(newestScreenReaderState(next, { ...next, message: 'Duplicate' })).toBe(next);
  });
  it.each([NaN, -1, Infinity, .5])('rejects invalid publication revision %s', revision => {
    const current = createInitialScreenReaderState();
    expect(newestScreenReaderState(current, { ...current, revision })).toBe(current);
  });
});
