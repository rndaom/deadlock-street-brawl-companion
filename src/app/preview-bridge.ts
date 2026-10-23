import { createBrowserBridge } from './browser-bridge';
import { sampleState, SAMPLE_STATES } from '../../tests/sample-states';
import type { SampleStateId } from '../../tests/sample-states';
import type { CompanionBridge } from '../shared/types';
import type { ScreenReaderState } from '../shared/screen-reading';

/**
 * Development only (`npm run dev`, then `?sample=pick`): draws the interface from the sample
 * reader states used by the interface tests, so layout work can be checked in a browser.
 * main.tsx loads this behind `import.meta.env.DEV`, so it never ships in the desktop app.
 * The sample is re-stamped once a second, like a running reader, so it never goes stale.
 */
export function createPreviewBridge(id: string, panel = false): CompanionBridge {
  const sampleId = (SAMPLE_STATES.some((sample) => sample.id === id) ? id : 'pick') as SampleStateId;
  let revision = 0;
  const current = (): ScreenReaderState => ({ ...sampleState(sampleId, Date.now()), revision: ++revision, gameBounds: { x: 0, y: 0, width: 1920, height: 1080 } });
  return {
    ...createBrowserBridge(),
    getScreenReaderState: async () => current(),
    previewScreenReader: async () => current(),
    subscribeScreenReader: (listener) => {
      const timer = setInterval(() => listener(current()), 1000);
      return () => clearInterval(timer);
    },
    setScreenReaderEnabled: async () => {},
    setScreenReaderCrop: async () => {},
    retryScreenReader: async () => {},
    getOverlayStatus: async () => ({ panel, hotkey: 'F7' }),
    subscribeOverlay: () => () => {},
  };
}
