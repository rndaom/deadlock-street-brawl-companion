import { BrowserWindow, globalShortcut, screen, type Session, type WebContents } from 'electron';
import type { ScreenReaderState } from '../src/shared/screen-reading';
import type { OverlayStatus } from '../src/shared/types';
import { nextApNudgeClock, overlayShouldShow, type ApNudgeClock } from '../src/shared/overlay';
import { placeOverlay, type ScreenRect } from './hyprland';

/** Toggles the in-game info panel (leveling plan, reader status). Not bound by Deadlock by default. */
export const OVERLAY_HOTKEY = 'F7';
const OVERLAY_TITLE = 'Street Brawl overlay';
/** Linux (Wayland) clients cannot place, raise or unfocus their own windows; the compositor does it by rule. */
const COMPOSITOR_PLACED = process.platform === 'linux';

/**
 * The in-game overlay for one-monitor play: a transparent window over the game client that
 * marks the recommended draft card and the ability to put unspent points into. It never takes focus
 * or mouse input (the game keeps both), and it is excluded from screen capture, so the reader still sees the game underneath it
 * (and the reader's occlusion check skips click-through windows). On Linux the reader copies the
 * game window's own buffer, so the overlay is never in its image either; Hyprland places the overlay
 * (see hyprland.ts), and on other Linux desktops it stays hidden rather than open as a normal window.
 */
export function createOverlay(options: {
  session: Session; preload: string; url: string;
  /** Whether the marks may stay up while the game is visible but not focused (Windows: the companion is on another part of the screen). */
  showWhileVisible?: () => boolean;
}) {
  let window: BrowserWindow | null = null;
  let enabled = false;
  let state: ScreenReaderState | null = null;
  let panel = false;
  let hotkeyRegistered = false;
  let hotkeyUnavailable = false;
  let lastBounds = '';
  let disposed = false;
  /** Linux: no new placement attempt before this time (after one failed). */
  let placeRetryAt = 0;
  const PLACE_RETRY_MS = 3000;
  /** Linux: the game bounds the compositor's placement rule was registered for ('' when not placed). */
  let placedBounds = '';
  /** How long the current unspent ability points have stood, so their nudge steps aside after a while. */
  let apClock: ApNudgeClock | null = null;
  /** Windows: when the overlay was last put back on top of the topmost band. */
  let raisedAt = 0;
  /** A fullscreen game made topmost by its window layer (SDL does this for a focused fullscreen window) takes the top of the band when it is activated. */
  const RAISE_MS = 1000;

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
    } else if (!wanted) {
      if (hotkeyRegistered) globalShortcut.unregister(OVERLAY_HOTKEY);
      hotkeyRegistered = false;
      // The other program may have let the key go by the next match: try again when the game is back.
      hotkeyUnavailable = false;
    }
  }

  function sendState(): void {
    if (alive(window) && state && !window.webContents.isDestroyed()) window.webContents.send('companion:screen-reader', state);
  }

  function update(next: ScreenReaderState | null): void {
    if (disposed) return;
    // The overlay never shows the reading-area preview; don't serialise that image for it.
    state = next?.previewDataUrl ? { ...next, previewDataUrl: null } : next;
    syncHotkey();
    const now = Date.now();
    apClock = nextApNudgeClock(apClock, state, now);
    const show = overlayShouldShow({ enabled, state, panel, now, apSince: apClock?.since ?? null, showWhileVisible: !COMPOSITOR_PLACED && (options.showWhileVisible?.() ?? false) });
    // A hidden overlay is not redrawn on every read: it gets one last state as it hides (so it holds
    // nothing stale) and the current one before it shows again.
    if (!show) {
      if (alive(window) && window.isVisible()) { sendState(); window.hide(); }
      return;
    }
    if (COMPOSITOR_PLACED) { showPlaced(state!.gameBounds!); return; }
    const bounds = screen.screenToDipRect(null, state!.gameBounds!);
    // Created at the game's bounds: a first setBounds onto a monitor with another DPI scale can size the window wrongly.
    const target = ensureWindow(bounds);
    sendState();
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (key !== lastBounds) { placeAt(target, bounds); lastBounds = key; }
    if (!target.isVisible()) {
      target.showInactive();
      raise(target, now, true);
    } else raise(target, now, false);
  }

  /**
   * Windows: showing a hidden window keeps its old place in the z-order, and a borderless fullscreen game
   * that is (re)activated goes to the top of the topmost band, above the overlay. Put the overlay back on
   * top when it shows and about once a second while it is up, without activating it.
   */
  function raise(target: BrowserWindow, now: number, force: boolean): void {
    if (!force && now - raisedAt < RAISE_MS) return;
    raisedAt = now;
    target.setAlwaysOnTop(true, 'screen-saver');
    target.moveTop();
  }

  /**
   * Moving a window onto a monitor with another DPI scale can size it by the old monitor's scale
   * (Chromium converts with the scale of the display it leaves). A second setBounds, once the window is
   * on the new monitor, lands on the right size.
   */
  function placeAt(target: BrowserWindow, bounds: ScreenRect): void {
    target.setBounds(bounds, false);
    const actual = target.getBounds();
    if (actual.x !== bounds.x || actual.y !== bounds.y || actual.width !== bounds.width || actual.height !== bounds.height) target.setBounds(bounds, false);
  }

  /**
   * Linux: the reader reports the game in layout coordinates, which is what the compositor rule uses. A rule
   * applies when a window opens, so new game bounds recreate the overlay window after the rule is updated.
   */
  function showPlaced(bounds: ScreenRect): void {
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (key !== lastBounds) {
      if (Date.now() < placeRetryAt) return;
      const old = window;
      window = null; lastBounds = key; placedBounds = '';
      if (alive(old)) old.destroy();
      void placeOverlay(OVERLAY_TITLE, bounds).then(placed => {
        if (disposed || lastBounds !== key) return;
        placedBounds = placed ? key : '';
        if (placed) update(state);
        // A failed placement (compositor busy, monitor change) is tried again on a later update, not never.
        else { lastBounds = ''; placeRetryAt = Date.now() + PLACE_RETRY_MS; }
      }).catch(() => { if (!disposed && lastBounds === key) { lastBounds = ''; placeRetryAt = Date.now() + PLACE_RETRY_MS; } });
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
      // A pending placement or an F7 press during quit must not recreate the window.
      disposed = true; lastBounds = ''; placedBounds = '';
      if (hotkeyRegistered) globalShortcut.unregister(OVERLAY_HOTKEY);
      hotkeyRegistered = false;
      if (alive(window)) window.destroy();
      window = null;
    },
  };
}
