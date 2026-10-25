import { BrowserWindow, globalShortcut, screen, type Session, type WebContents } from 'electron';
import type { ScreenReaderState } from '../src/shared/screen-reading';
import type { OverlayStatus } from '../src/shared/types';
import { overlayShouldShow } from '../src/shared/overlay';
import { placeOverlay, type ScreenRect } from './hyprland';

/** Toggles the in-game info panel (leveling plan, reader status). Not bound by Deadlock by default. */
export const OVERLAY_HOTKEY = 'F7';
const OVERLAY_TITLE = 'Street Brawl overlay';
/** Linux (Wayland) clients cannot place, raise or unfocus their own windows; the compositor does it by rule. */
const COMPOSITOR_PLACED = process.platform === 'linux';

/**
 * The in-game overlay for one-monitor play: a transparent window over the game client that
 * marks the recommended draft card. It never takes focus or mouse input (the game keeps both),
 * and it is excluded from screen capture, so the reader still sees the game underneath it
 * (and the reader's occlusion check skips click-through windows). On Linux the reader copies the
 * game window's own buffer, so the overlay is never in its image either; Hyprland places the overlay
 * (see hyprland.ts), and on other Linux desktops it stays hidden rather than open as a normal window.
 */
export function createOverlay(options: { session: Session; preload: string; url: string }) {
  let window: BrowserWindow | null = null;
  let enabled = false;
  let state: ScreenReaderState | null = null;
  let panel = false;
  let hotkeyRegistered = false;
  let hotkeyUnavailable = false;
  let lastBounds = '';
  /** Linux: the game bounds the compositor's placement rule was registered for ('' when not placed). */
  let placedBounds = '';

  const status = (): OverlayStatus => ({ panel, hotkey: hotkeyUnavailable ? null : OVERLAY_HOTKEY });
  const alive = (target: BrowserWindow | null): target is BrowserWindow => !!target && !target.isDestroyed();

  function send(): void {
    if (alive(window) && !window.webContents.isDestroyed()) window.webContents.send('companion:overlay', status());
  }

  function ensureWindow(initial?: ScreenRect): BrowserWindow {
    if (alive(window)) return window;
    const created = new BrowserWindow({
      // A non-resizable window advertises its creation size as its fixed size, which the compositor keeps.
      ...(initial ? { x: initial.x, y: initial.y, width: initial.width, height: initial.height } : {}),
      show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, title: OVERLAY_TITLE,
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
    // The compositor's placement rule matches this title, so the page's own title must not replace it.
    if (COMPOSITOR_PLACED) created.on('page-title-updated', event => event.preventDefault());
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
    if (COMPOSITOR_PLACED) { showPlaced(state!.gameBounds!); return; }
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

  /**
   * Linux: the reader reports the game in layout coordinates, which is what the compositor rule uses. A rule
   * applies when a window opens, so new game bounds recreate the overlay window after the rule is updated.
   */
  function showPlaced(bounds: ScreenRect): void {
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (key !== lastBounds) {
      const old = window;
      window = null; lastBounds = key; placedBounds = '';
      if (alive(old)) old.destroy();
      void placeOverlay(OVERLAY_TITLE, bounds).then(placed => {
        if (lastBounds !== key) return;
        placedBounds = placed ? key : '';
        if (placed) update(state);
      });
      return;
    }
    if (placedBounds !== key) return;
    const target = ensureWindow(bounds);
    sendState();
    if (!target.isVisible()) target.showInactive();
  }

  return {
    status,
    contents(): WebContents | null { return alive(window) && !window.webContents.isDestroyed() ? window.webContents : null; },
    setEnabled(value: boolean): void {
      enabled = value;
      if (!enabled) {
        panel = false;
        if (alive(window)) window.destroy();
        window = null; lastBounds = ''; placedBounds = '';
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
