import type { ScreenReaderState } from '../shared/screen-reading';

/** A late RPC response cannot replace a newer reader publication. */
export function newestScreenReaderState(current: ScreenReaderState | null, incoming: ScreenReaderState): ScreenReaderState | null {
  if (!Number.isSafeInteger(incoming.revision) || incoming.revision < 0) return current;
  if (current && incoming.revision <= current.revision) return current;
  return incoming;
}
