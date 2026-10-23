import { BrowserWindow, globalShortcut, screen, type Session, type WebContents } from 'electron';
import type { ScreenReaderState } from '../src/shared/screen-reading';
import type { OverlayStatus } from '../src/shared/types';
import { overlayShouldShow } from '../src/shared/overlay';

/** Toggles the in-game info panel (leveling plan, reader status). Not bound by Deadlock by default. */
export const OVERLAY_HOTKEY = 'F7';

/**
 * The in-game overlay for one-monitor play: a transparent window over the game client that
 * marks the recommended draft card. It never takes focus or mouse input (the game keeps both),
 * and it is excluded from screen capture, so the reader still sees the game underneath it
 * (and the reader's occlusion check skips click-through windows).
 */
export function createOverlay(options: { session: Session; preload: string; url: string }) {
  let window: BrowserWindow | null = null;
  let enabled = false;
  let state: ScreenReaderState | null = null;
  let panel = false;
  let hotkeyRegistered = false;
  let hotkeyUnavailable = false;
  let lastBounds = '';

  const status = (): OverlayStatus => ({ panel, hotkey: hotkeyUnavailable ? null : OVERLAY_HOTKEY });
  const alive = (target: BrowserWindow | null): target is BrowserWindow => !!target && !target.isDestroyed();

  function send(): void {
    if (alive(window) && !window.webContents.isDestroyed()) window.webContents.send('companion:overlay', status());
  }

  function ensureWindow(): BrowserWindow {
    if (alive(window)) return window;
    const created = new BrowserWindow({
      show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, title: 'Street Brawl overlay',
      webPreferences: {
        preload: options.preload, session: options.session,
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
        backgroundThrottling: false,
      },
    });
    created.setAlwaysOnTop(true, 'screen-saver');
    created.setIgnoreMouseEvents(true);
    // WDA_EXCLUDEFROMCAPTURE: the reader's screen capture sees the game, not these marks.
    created.setContentProtection(true);
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    created.webContents.on('will-navigate', (event, url) => { if (url !== options.url) event.preventDefault(); });
    created.webContents.on('will-attach-webview', (event) => event.preventDefault());
    created.webContents.on('did-finish-load', () => { send(); if (state) created.webContents.send('companion:screen-reader', state); });
    created.on('closed', () => { if (window === created) { window = null; lastBounds = ''; } });
    void created.loadURL(options.url).catch(() => { /* A failed overlay never affects the companion window. */ });
    window = created;
    return created;
  }

  function syncHotkey(): void {
    const wanted = enabled && !!state?.gamePresent;
    if (wanted && !hotkeyRegistered && !hotkeyUnavailable) {
      try {
        hotkeyRegistered = globalShortcut.register(OVERLAY_HOTKEY, () => { panel = !panel; send(); update(state); });
      } catch { hotkeyRegistered = false; }
      // Another program owns the key: say so in the panel instead of retrying on every read.
      if (!hotkeyRegistered) { hotkeyUnavailable = true; send(); }
    } else if (!wanted && hotkeyRegistered) {
      globalShortcut.unregister(OVERLAY_HOTKEY);
      hotkeyRegistered = false;
    }
  }

  function sendState(): void {
    if (alive(window) && state && !window.webContents.isDestroyed()) window.webContents.send('companion:screen-reader', state);
  }

  function update(next: ScreenReaderState | null): void {
    state = next;
    syncHotkey();
    const show = overlayShouldShow({ enabled, state, panel, now: Date.now() });
    // A hidden overlay is not redrawn on every read: it gets one last state as it hides (so it holds
    // nothing stale) and the current one before it shows again.
    if (!show) {
      if (alive(window) && window.isVisible()) { sendState(); window.hide(); }
      return;
    }
    const target = ensureWindow();
    sendState();
    const bounds = screen.screenToDipRect(null, state!.gameBounds!);
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (key !== lastBounds) { target.setBounds(bounds, false); lastBounds = key; }
    if (!target.isVisible()) {
      target.showInactive();
      // Windows can drop the topmost band when a borderless game takes the foreground.
      target.setAlwaysOnTop(true, 'screen-saver');
    }
  }

  return {
    status,
    contents(): WebContents | null { return alive(window) && !window.webContents.isDestroyed() ? window.webContents : null; },
    setEnabled(value: boolean): void {
      enabled = value;
      if (!enabled) {
        panel = false;
        if (alive(window)) window.destroy();
        window = null; lastBounds = '';
      }
      update(state);
    },
    update,
    dispose(): void {
      if (hotkeyRegistered) globalShortcut.unregister(OVERLAY_HOTKEY);
      hotkeyRegistered = false;
      if (alive(window)) window.destroy();
      window = null;
    },
  };
}
