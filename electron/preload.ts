import { contextBridge, ipcRenderer } from 'electron';
import type { CompanionBridge, MatchState, OverlayStatus } from '../src/shared/types';
import type { ScreenReaderState } from '../src/shared/screen-reading';

// Never expose ipcRenderer, event objects, channel selection, or a generic invoke.
const bridge: CompanionBridge = {
  getState: () => ipcRenderer.invoke('companion:get-state'),
  getCatalog: () => ipcRenderer.invoke('companion:get-catalog'),
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('A state listener is required.');
    const receive = (_event: Electron.IpcRendererEvent, state: MatchState) => listener(state);
    ipcRenderer.on('companion:state', receive);
    return () => ipcRenderer.removeListener('companion:state', receive);
  },
  getSettings: () => ipcRenderer.invoke('companion:get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('companion:update-settings', settings),
  getDisplays: () => ipcRenderer.invoke('companion:get-displays'),
  exportDiagnostics: () => ipcRenderer.invoke('companion:export-diagnostics'),
  getScreenReaderState: () => ipcRenderer.invoke('companion:get-screen-reader'),
  subscribeScreenReader(listener) {
    if (typeof listener !== 'function') throw new TypeError('A screen-reader listener is required.');
    const receive = (_event: Electron.IpcRendererEvent, state: ScreenReaderState) => listener(state);
    ipcRenderer.on('companion:screen-reader', receive);
    return () => ipcRenderer.removeListener('companion:screen-reader', receive);
  },
  setScreenReaderEnabled: enabled => ipcRenderer.invoke('companion:screen-enabled', enabled),
  setScreenReaderCrop: crop => ipcRenderer.invoke('companion:screen-crop', crop),
  retryScreenReader: () => ipcRenderer.invoke('companion:screen-retry'),
  previewScreenReader: () => ipcRenderer.invoke('companion:screen-preview'),
  getOverlayStatus: () => ipcRenderer.invoke('companion:get-overlay'),
  subscribeOverlay(listener) {
    if (typeof listener !== 'function') throw new TypeError('An overlay listener is required.');
    const receive = (_event: Electron.IpcRendererEvent, status: OverlayStatus) => listener(status);
    ipcRenderer.on('companion:overlay', receive);
    return () => ipcRenderer.removeListener('companion:overlay', receive);
  },
};

contextBridge.exposeInMainWorld('companion', Object.freeze(bridge));
