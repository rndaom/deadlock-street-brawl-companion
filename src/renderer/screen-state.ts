import type { ScreenReaderState } from '../shared/screen-reading';

/** A late RPC response cannot replace a newer reader publication. */
export function newestScreenReaderState(current: ScreenReaderState | null, incoming: ScreenReaderState): ScreenReaderState | null {
  if (!Number.isSafeInteger(incoming.revision) || incoming.revision < 0) return current;
  if (current && incoming.revision <= current.revision) return current;
  // The main process sends the reading-area preview once and then omits it (undefined) while it is unchanged.
  if (incoming.previewDataUrl === undefined && current?.previewDataUrl) return { ...incoming, previewDataUrl: current.previewDataUrl };
  return incoming;
}
