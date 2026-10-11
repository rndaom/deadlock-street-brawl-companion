import { APP_CATALOG } from './catalog';
import { createController } from './controller';
import { DEFAULT_SETTINGS, validateSettingsPatch } from '../shared/settings';
import type { CompanionBridge } from '../shared/types';
import { unavailableScreenReaderState } from '../shared/screen-reading';

export function createBrowserBridge(): CompanionBridge {
  const controller = createController(APP_CATALOG);
  let settings = { ...DEFAULT_SETTINGS };
  return {
    getState: async () => controller.getState(), getCatalog: async () => controller.getCatalog(),
    subscribe: listener => controller.subscribe(listener),
    getSettings: async () => ({ ...settings }),
    updateSettings: async patch => {
      settings = { ...settings, ...validateSettingsPatch(patch) };
      return { ...settings };
    },
    getDisplays: async () => [],
    exportDiagnostics: async () => controller.exportDiagnostics(),
    getScreenReaderState: async () => unavailableScreenReaderState(),
    subscribeScreenReader: () => () => {},
    setScreenReaderEnabled: async () => { throw new Error('Use the Windows app to read Deadlock.'); },
    setScreenReaderCrop: async () => { throw new Error('Use the Windows app to read Deadlock.'); },
    retryScreenReader: async () => { throw new Error('Use the Windows app to read Deadlock.'); },
    previewScreenReader: async () => unavailableScreenReaderState(),
  };
}
