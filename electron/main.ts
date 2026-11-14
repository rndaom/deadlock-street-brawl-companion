import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, screen, session, Tray,
  type Display, type IpcMainInvokeEvent, type Rectangle,
} from 'electron';
import { appendFile, readdir, readFile, mkdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../src/app/controller';
import { APP_CATALOG } from '../src/app/catalog';
import { DEFAULT_SETTINGS, readStoredSettings, validateSettingsPatch } from '../src/shared/settings';
import type { AppSettings, DisplayInfo } from '../src/shared/types';
import { startOverwolfProvider } from './overwolf-provider';
import { createScreenReader } from './screen-reader';
import { createOverlay } from './overlay';
import { hyprlandDeviceScale } from './hyprland';
import { DEFAULT_CAPTURE_REGION, validateCaptureRegion, type CaptureRegion, type ScreenReaderState } from '../src/shared/screen-reading';
import { loadLocalPlayerNames } from './local-identity';
import { coversCurrentWindow, isStreetBrawlData, setStreetBrawlData, streetBrawlData } from '../src/screen/street-brawl-data';
import { fetchStreetBrawlData } from '../src/screen/street-brawl-fetch';
import { CONTEXT_CATALOG } from '../src/shared/context-catalog';

// The companion UI is static paint with only one-shot transitions, so software compositing
// costs almost nothing and keeps the GPU (and its memory) entirely for Deadlock.
app.disableHardwareAcceleration();

const APP_ORIGIN = 'companion://app';
const APP_DOCUMENT = `${APP_ORIGIN}/index.html`;
const OVERLAY_DOCUMENT = `${APP_DOCUMENT}?view=overlay`;
const mainDirectory = dirname(fileURLToPath(import.meta.url));
const controller = createController(APP_CATALOG, { applicationVersion: app.getVersion() });
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let stopProvider: (() => void) | null = null;
let settingsWrites: Promise<void> = Promise.resolve();
let unsubscribeController: (() => void) | null = null;
let quitting = false;
let screenReader: ReturnType<typeof createScreenReader> | null = null;
let overlay: ReturnType<typeof createOverlay> | null = null;
let readerPreferences = { enabled: true, crop: { ...DEFAULT_CAPTURE_REGION } as CaptureRegion };
let readerPreferenceWrites: Promise<void> = Promise.resolve();

async function loadReaderPreferences(): Promise<void> {
  try {
    const path = join(app.getPath('userData'), 'reader-settings.json');
    if ((await stat(path)).size > 4096) return;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    // A bad saved area falls back on its own; it must not also undo a saved pause.
    let crop = { ...DEFAULT_CAPTURE_REGION } as CaptureRegion;
    try { crop = validateCaptureRegion(record.crop ?? DEFAULT_CAPTURE_REGION); } catch { /* default area */ }
    readerPreferences = { enabled: typeof record.enabled === 'boolean' ? record.enabled : true, crop };
  } catch { /* Safe defaults; image pixels and match readings are never loaded from disk. */ }
}

function saveReaderPreferences(): Promise<void> {
  const snapshot = structuredClone(readerPreferences);
  const operation = readerPreferenceWrites.then(async () => {
    const directory = app.getPath('userData');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'reader-settings.json');
    await writeFile(`${file}.tmp`, JSON.stringify(snapshot), 'utf8');
    await rename(`${file}.tmp`, file);
  });
  readerPreferenceWrites = operation.then(() => undefined, () => undefined);
  return operation;
}

function readerPaths(): { helperPath: string; iconDirectory: string; contextIconDirectory: string } {
  const helper = process.platform === 'win32' ? 'ScreenReader.exe' : 'ScreenReader';
  return app.isPackaged
    ? { helperPath: join(process.resourcesPath, 'screen-reader', helper), iconDirectory: join(process.resourcesPath, 'reader-icons'), contextIconDirectory: join(process.resourcesPath, 'context-icons') }
    : { helperPath: resolve(mainDirectory, '../native/ScreenReader/publish', helper), iconDirectory: resolve(mainDirectory, '../assets/reader-icons'), contextIconDirectory: resolve(mainDirectory, '../assets/context-icons') };
}

/**
 * Local troubleshooting record in Documents\Street Brawl Companion\diagnostics (~/Documents/... on Linux):
 * reader-log.jsonl holds one line per screen read (status, timing, read text, decision);
 * frames\ keeps the most recent draft images so misreads can be replayed offline.
 * Nothing leaves this computer.
 */
function createReaderDiagnostics() {
  let documents: string;
  // A Documents folder Windows cannot resolve (a broken OneDrive or folder redirection) must not stop the app.
  try { documents = app.getPath('documents'); } catch { documents = app.getPath('userData'); }
  const directory = join(documents, 'Street Brawl Companion', 'diagnostics');
  const frames = join(directory, 'frames');
  const log = join(directory, 'reader-log.jsonl');
  const MAX_LOG_BYTES = 8_000_000;
  const MAX_FRAMES = 60;
  // With the companion left open, the once-a-second "Waiting for Deadlock" probe filled the log and rotated a
  // whole evening's matches out by the next morning; an unchanged idle read is logged once a minute instead.
  const IDLE_LOG_MS = 60_000;
  let idle: { key: string; at: number } | null = null;
  let writes: Promise<void> = mkdir(directory, { recursive: true }).then(() => undefined, () => undefined);
  const queue = (work: () => Promise<void>) => { writes = writes.then(work).catch(() => undefined); };
  return {
    trace(entry: Record<string, unknown>) {
      const result = entry.result as { status?: unknown } | undefined;
      if (result?.status === 'waiting-game') {
        const key = `${String(entry.op)}:${String(entry.status)}`;
        if (idle?.key === key && Date.now() - idle.at < IDLE_LOG_MS) return;
        idle = { key, at: Date.now() };
      } else idle = null;
      queue(async () => {
        try { if ((await stat(log)).size > MAX_LOG_BYTES) await rename(log, `${log}.old`); } catch { /* No log yet. */ }
        await appendFile(log, `${JSON.stringify(entry)}\n`, 'utf8');
      });
    },
    frame(png: string, entry: Record<string, unknown>) {
      if (!settings.saveScreenshots) return;
      queue(async () => {
        await mkdir(frames, { recursive: true });
        const name = `${entry.snapshot ? "screen" : entry.scoreboard ? "tab" : "draft"}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await writeFile(join(frames, `${name}.png`), Buffer.from(png, 'base64'));
        await writeFile(join(frames, `${name}.json`), JSON.stringify(entry, null, 1), 'utf8');
        const stamp = (file: string) => file.replace(/^[a-z]+-/, '');
        const pngs = (await readdir(frames)).filter(file => file.endsWith('.png')).sort((a, b) => stamp(a).localeCompare(stamp(b)));
        for (const old of pngs.slice(0, Math.max(0, pngs.length - MAX_FRAMES))) {
          await rm(join(frames, old), { force: true }); await rm(join(frames, old.replace(/\.png$/, '.json')), { force: true });
        }
      });
    },
  };
}

const STREET_BRAWL_REFRESH_MS = 24 * 60 * 60 * 1000;
let streetBrawlRefresh: Promise<void> | null = null;
/**
 * Keeps the Street Brawl win rates and upgrade orders current: uses a newer saved download
 * if one exists, and downloads fresh data in the background when it is over a day old.
 * A failed download keeps the data already in use.
 */
function refreshStreetBrawlData(): Promise<void> {
  if (streetBrawlRefresh) return streetBrawlRefresh;
  const file = join(app.getPath('userData'), 'street-brawl-data.json');
  const age = () => Date.now() - Date.parse(streetBrawlData().fetchedAt);
  streetBrawlRefresh = (async () => {
    try {
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
      // A download from before a patch-window change (an app update moved it) does not replace the newer bundled data.
      if (isStreetBrawlData(saved) && Date.parse(saved.fetchedAt) > Date.parse(streetBrawlData().fetchedAt) && coversCurrentWindow(saved)) setStreetBrawlData(saved);
    } catch { /* No saved download yet. */ }
    if (age() < STREET_BRAWL_REFRESH_MS) return;
    try {
      const slots = new Map((CONTEXT_CATALOG.abilities as unknown as { numericId: string | number; slot: number }[]).map(ability => [String(ability.numericId), ability.slot]));
      const fresh = await fetchStreetBrawlData(slots);
      if (!setStreetBrawlData(fresh)) return;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(fresh), 'utf8');
      await rename(`${file}.tmp`, file);
    } catch { /* Offline or the API is down: keep the current data and try again later. */ }
  })().finally(() => { streetBrawlRefresh = null; });
  return streetBrawlRefresh;
}

let pendingReaderState: ScreenReaderState | null = null;
let trayTip = '';
let sentPreview: string | null = null;
/** One read publishes several partial updates in the same tick; send the windows only the last one,
 * so each read costs one IPC message and one render per window instead of five or six. */
function publishScreenReader(state: ScreenReaderState): void {
  const scheduled = pendingReaderState !== null;
  pendingReaderState = state;
  if (!scheduled) setImmediate(flushScreenReader);
}

function flushScreenReader(): void {
  const state = pendingReaderState;
  pendingReaderState = null;
  // Reader updates published while quitting (the reader stopping) must not touch the destroyed tray or overlay.
  if (!state || quitting) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    // The reading-area preview is a large image that stays in the state; send it once, then leave it
    // out (undefined = unchanged, see newestScreenReaderState) so every read is not megabytes of IPC.
    const preview = state.previewDataUrl ?? null;
    mainWindow.webContents.send('companion:screen-reader', preview !== null && preview === sentPreview ? { ...state, previewDataUrl: undefined } : state);
    sentPreview = preview;
  }
  overlay?.update(state);
  const tip = `Street Brawl companion · ${state.status === 'ready' ? 'Offers read' : state.enabled ? 'Screen reading' : 'Paused'}`;
  if (tip !== trayTip) { trayTip = tip; tray?.setToolTip(tip); }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'companion', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

async function loadSettings(): Promise<void> {
  try {
    if ((await stat(settingsFile())).size > 16_384) return;
    const value: unknown = JSON.parse(await readFile(settingsFile(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...readStoredSettings(value) };
  } catch {
    // Missing or invalid preferences use defaults; participant state is never read from disk.
    settings = { ...DEFAULT_SETTINGS };
  }
  if (settings.displayId !== null && !screen.getAllDisplays().some((d) => String(d.id) === settings.displayId)) {
    settings.displayId = null;
  }
}

async function persistSettings(next: AppSettings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  const temporaryFile = `${settingsFile()}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(next, null, 2), 'utf8');
  await rename(temporaryFile, settingsFile());
}

function displays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    id: String(display.id),
    label: `${display.label || `Display ${index + 1}`} · ${Math.round(display.scaleFactor * 100)}%`,
    width: display.workArea.width,
    height: display.workArea.height,
    primary: display.id === primaryId,
  }));
}

function chosenDisplay(): Display {
  const connected = screen.getAllDisplays();
  return connected.find((display) => String(display.id) === settings.displayId)
    ?? connected.find((display) => display.workArea.height > display.workArea.width && display.id !== screen.getPrimaryDisplay().id)
    ?? connected.find((display) => display.workArea.height > display.workArea.width)
    ?? screen.getPrimaryDisplay();
}

function initialBounds(display: Display): Rectangle {
  const area = display.workArea;
  const width = Math.min(760, area.width);
  const height = Math.min(1280, area.height);
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
}

/** 600x720 DIP, but never more than the work area: a 1080p laptop at 150% scaling has about 670 DIP above the taskbar. */
function minimumSize(display: Display): { minWidth: number; minHeight: number } {
  return { minWidth: Math.min(600, display.workArea.width), minHeight: Math.min(720, display.workArea.height) };
}

function moveToSelectedDisplay(force = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const old = mainWindow.getBounds();
  const occupyingDisplay = screen.getDisplayMatching(old);
  // With no display chosen, the window stays where the user put it: a display change (taskbar, DPI,
  // the game switching mode) must not pull it back to the automatic pick.
  const display = settings.displayId === null && !force ? occupyingDisplay : chosenDisplay();
  const minimum = minimumSize(display);
  mainWindow.setMinimumSize(minimum.minWidth, minimum.minHeight);
  const area = display.workArea;
  if (force || occupyingDisplay.id !== display.id) {
    mainWindow.setBounds(initialBounds(display), false);
    return;
  }
  // Electron screen bounds and BrowserWindow bounds are both device-independent units.
  const width = Math.min(old.width, area.width);
  const height = Math.min(old.height, area.height);
  const next = {
    x: Math.max(area.x, Math.min(old.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(old.y, area.y + area.height - height)),
    width, height,
  };
  if (Object.keys(next).some((key) => next[key as keyof Rectangle] !== old[key as keyof Rectangle])) {
    mainWindow.setBounds(next, false);
  }
}

function updateSettings(input: unknown): Promise<AppSettings> {
  const operation = settingsWrites.then(async () => {
    const patch = validateSettingsPatch(input);
    if (patch.displayId !== undefined && patch.displayId !== null
      && !screen.getAllDisplays().some((display) => String(display.id) === patch.displayId)) {
      throw new Error('The selected display is no longer connected.');
    }
    const next = { ...settings, ...patch };
    await persistSettings(next);
    const monitorChanged = next.displayId !== settings.displayId;
    settings = next;
    mainWindow?.setAlwaysOnTop(settings.alwaysOnTop);
    overlay?.setEnabled(settings.overlay);
    if (patch.maxActiveItems !== undefined) screenReader?.refreshAdvice();
    moveToSelectedDisplay(monitorChanged);
    return { ...settings };
  });
  settingsWrites = operation.then(() => undefined, () => undefined);
  return operation;
}

/** The overlay may only read state; every request that changes something must come from the companion window. */
function trustedSender(event: IpcMainInvokeEvent, allowOverlay = false): void {
  const window = mainWindow;
  const fromMain = !!window && !window.isDestroyed() && event.sender === window.webContents;
  const overlayContents = allowOverlay ? overlay?.contents() ?? null : null;
  const fromOverlay = !fromMain && overlayContents !== null && event.sender === overlayContents;
  if ((!fromMain && !fromOverlay) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('This request is not from the companion window.');
  }
  const document = new URL(event.senderFrame.url);
  if (document.protocol !== 'companion:' || document.hostname !== 'app'
    || document.pathname !== '/index.html' || document.username || document.password || document.port
    || (fromOverlay && document.search !== '?view=overlay')) {
    throw new Error('This request is not from the local companion document.');
  }
}

function handle(channel: string, callback: (event: IpcMainInvokeEvent, argument: unknown) => unknown, allowOverlay = false): void {
  ipcMain.handle(channel, (event, argument) => {
    trustedSender(event, allowOverlay);
    return callback(event, argument);
  });
}

/** The companion always reads the live game. */
function startLive(): void {
  void screenReader?.setEnabled(readerPreferences.enabled).catch(() => {
    // The reader reports its own actionable startup/error status without game payload logs.
  });
  const provider = startOverwolfProvider(app, (event) => controller.ingest(event));
  stopProvider = () => provider.stop();
}

function registerBridge(): void {
  handle('companion:get-state', () => controller.getState());
  handle('companion:get-catalog', () => controller.getCatalog(), true);
  handle('companion:get-settings', () => ({ ...settings }), true);
  handle('companion:get-overlay', () => overlay?.status() ?? { panel: false, hotkey: null }, true);
  handle('companion:update-settings', (_event, value) => updateSettings(value));
  handle('companion:get-displays', () => displays());
  handle('companion:get-screen-reader', () => screenReader!.getState(), true);
  handle('companion:screen-enabled', async (_event, value) => {
    if (typeof value !== 'boolean') throw new TypeError('Choose pause or resume.');
    readerPreferences = { ...readerPreferences, enabled: value };
    await screenReader!.setEnabled(value);
    await saveReaderPreferences();
  });
  handle('companion:screen-crop', async (_event, value) => {
    const crop = validateCaptureRegion(value);
    await screenReader!.setCrop(crop);
    readerPreferences = { ...readerPreferences, crop };
    await saveReaderPreferences();
  });
  handle('companion:screen-retry', async () => {
    readerPreferences = { ...readerPreferences, enabled: true };
    await screenReader!.setEnabled(true);
    await screenReader!.retry();
    await saveReaderPreferences();
  });
  handle('companion:screen-preview', async () => {
    return screenReader!.preview();
  });
  handle('companion:export-diagnostics', async () => {
    const target = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save aggregate diagnostics',
      defaultPath: `deadlock-companion-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (target.canceled || !target.filePath) return '';
    // Controller output is allowlisted operational aggregates; no match IDs or player data.
    const aggregate = JSON.parse(controller.exportDiagnostics()) as Record<string, unknown>;
    const reader = screenReader?.getState();
    if (reader) aggregate.screenReading = {
      status: reader.status, enabled: reader.enabled, engineReady: reader.engineReady,
      gamePresent: reader.gamePresent, foreground: reader.foreground,
      readMs: reader.readMs, metrics: reader.metrics,
      context: {
        observedSeatCount: reader.matchContext.players.length,
        rosterCompleteness: reader.matchContext.rosterCompleteness,
        localHeroObserved: reader.matchContext.localHeroId !== null,
        localSeatObserved: reader.matchContext.localSeat !== null,
        localInventoryCompleteness: reader.matchContext.localInventoryCompleteness,
        abilityCompleteness: reader.matchContext.abilityCompleteness,
        observedInventorySeatCount: reader.matchContext.players.filter(player => player.inventoryObservation !== null).length,
        contextAgeMs: reader.matchContext.lastObservedAt === null ? null : Math.max(0, Date.now() - reader.matchContext.lastObservedAt),
      },
      privacy: 'No game images, OCR text, offers, hero IDs or player information included.',
    };
    await writeFile(target.filePath, JSON.stringify(aggregate, null, 2), 'utf8');
    return target.filePath;
  });
}

function publicImageOrigins(): string[] {
  const urls = [...APP_CATALOG.heroes, ...APP_CATALOG.items].map((entry) => entry.imageUrl);
  return [...new Set(urls.flatMap((value) => {
    try {
      const url = new URL(value ?? '');
      return url.protocol === 'https:' && !url.username && !url.password ? [url.origin] : [];
    } catch { return []; }
  }))];
}

async function prepareLocalSession(): Promise<Electron.Session> {
  // No persist: prefix: cookies/storage/cache for this renderer are in memory.
  const localSession = session.fromPartition('companion-memory');
  const uiDirectory = resolve(mainDirectory, '../dist');
  const imageOrigins = publicImageOrigins();
  const contentSecurityPolicy = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${imageOrigins.join(' ')}`, "font-src 'self' data:",
    "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  };
  localSession.protocol.handle('companion', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || url.username || url.password || url.port
        || (request.method !== 'GET' && request.method !== 'HEAD')) return new Response('', { status: 403 });
      const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      if (requested.includes('\0') || requested.includes('\\')) return new Response('', { status: 400 });
      let assetDirectory = uiDirectory;
      let assetPath = `.${requested}`;
      if (requested.startsWith('/context-icons/')) {
        if (!/^\/context-icons\/(?:heroes\/[A-Za-z0-9_-]+--(?:small|card|vertical)|abilities\/[A-Za-z0-9_-]+|glyphs\/[a-z-]+)\.png$/.test(requested)) return new Response('', { status: 403 });
        assetDirectory = readerPaths().contextIconDirectory;
        assetPath = requested.slice('/context-icons/'.length);
      } else if (requested.startsWith('/item-icons/')) {
        if (!/^\/item-icons\/upgrade_[A-Za-z0-9_]+\.png$/.test(requested)) return new Response('', { status: 403 });
        assetDirectory = join(readerPaths().iconDirectory, 'icons');
        assetPath = requested.slice('/item-icons/'.length);
      }
      const file = resolve(assetDirectory, assetPath);
      const within = relative(assetDirectory, file);
      if (!within || within.startsWith('..') || isAbsolute(within)) return new Response('', { status: 403 });
      const type = mimeTypes[extname(file).toLowerCase()];
      if (!type) return new Response('', { status: 404 });
      const bytes = request.method === 'HEAD' ? null : new Uint8Array(await readFile(file));
      return new Response(bytes, {
        headers: { 'Content-Type': type, 'Content-Security-Policy': contentSecurityPolicy,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
      });
    } catch { return new Response('', { status: 404 }); }
  });
  localSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  localSession.setPermissionCheckHandler(() => false);
  localSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = (url.protocol === 'companion:' && url.hostname === 'app')
        || (url.protocol === 'data:' && details.resourceType === 'image')
        || (details.resourceType === 'image' && imageOrigins.includes(url.origin));
    } catch { /* Deny unknown requests. */ }
    callback({ cancel: !allowed });
  });
  return localSession;
}

function publishState(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('companion:state', controller.getState());
  }
  if (screenReader) publishScreenReader(screenReader.getState());
}

function showFromUserAction(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  try {
    // A small code-generated icon; no file/capture dependencies.
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const index = (y * 16 + x) * 4;
      const border = x === 2 || x === 13 || y === 2 || y === 13;
      pixels[index] = border ? 73 : 32;
      pixels[index + 1] = border ? 174 : 28;
      pixels[index + 2] = border ? 244 : 24;
      pixels[index + 3] = 255;
    }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show companion', click: showFromUserAction },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('double-click', showFromUserAction);
    // Windows users expect one click on a tray icon to open the app.
    if (process.platform === 'win32') tray.on('click', showFromUserAction);
    // The reader usually reports before the tray exists; without this the tooltip stayed empty until the status changed.
    tray.setToolTip(trayTip || 'Street Brawl companion');
    publishState();
  } catch { tray = null; }
}

async function createWindow(): Promise<void> {
  const localSession = await prepareLocalSession();
  mainWindow = new BrowserWindow({
    ...initialBounds(chosenDisplay()), ...minimumSize(chosenDisplay()), show: false,
    title: 'Deadlock Street Brawl companion', backgroundColor: '#111318',
    alwaysOnTop: settings.alwaysOnTop, autoHideMenuBar: true,
    webPreferences: {
      preload: join(mainDirectory, 'preload.cjs'), session: localSession,
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      spellcheck: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_DOCUMENT) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.showInactive());
  // Wayland paints nothing for a window that was never mapped, so ready-to-show may never fire there.
  if (process.platform === 'linux') mainWindow.webContents.once('did-finish-load', () => { if (mainWindow && !mainWindow.isVisible()) mainWindow.showInactive(); });
  mainWindow.webContents.on('did-finish-load', () => { sentPreview = null; publishState(); if (screenReader) publishScreenReader(screenReader.getState()); });
  // The hidden overlay window must not keep the app running once the companion is closed.
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  overlay =createOverlay({ session: localSession, preload: join(mainDirectory, 'preload.cjs'), url: OVERLAY_DOCUMENT });
  overlay.setEnabled(settings.overlay);
  await mainWindow.loadURL(APP_DOCUMENT);
}

function onDisplayChange(): void {
  if (settings.displayId !== null && !screen.getAllDisplays().some((display) => String(display.id) === settings.displayId)) {
    void updateSettings({ displayId: null }).catch(() => moveToSelectedDisplay(true));
  } else {
    moveToSelectedDisplay();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Hyprland: keep the desktop's text scaling out of Chromium's device scale, or the overlay draws shrunk (see hyprland.ts).
  if (process.platform === 'linux' && !app.commandLine.hasSwitch('force-device-scale-factor')) {
    const scale = hyprlandDeviceScale();
    if (scale) app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
  }
  app.on('second-instance', () => showFromUserAction());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopProvider?.();
    unsubscribeController?.();
    controller.dispose();
    overlay?.dispose();
    tray?.destroy();
    tray = null;
    void Promise.allSettled([screenReader?.dispose(), readerPreferenceWrites, settingsWrites]).then(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(async () => {
    // Logout and `kill` send SIGTERM on Linux. Chromium's own handler (installed before ready, so replaced
    // here) stops the message loop without the cleanup above, leaving the reader unreaped and the app hung;
    // signals take the same quit path as the tray's Quit instead.
    if (process.platform !== 'win32') for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => app.quit());
    const [, , localPlayerNames] = await Promise.all([loadSettings(), loadReaderPreferences(), loadLocalPlayerNames()]);
    void refreshStreetBrawlData();
    setInterval(() => { void refreshStreetBrawlData(); }, 6 * 60 * 60 * 1000).unref();
    const diagnostics = createReaderDiagnostics();
    screenReader = createScreenReader({ ...readerPaths(), localPlayerNames, catalog: APP_CATALOG, initialCrop: readerPreferences.crop, autoStart: false, onState: publishScreenReader,
      onTrace: diagnostics.trace, onDraftFrame: diagnostics.frame, wantsFrames: () => settings.saveScreenshots, maxActiveItems: () => settings.maxActiveItems });
    registerBridge();
    unsubscribeController = controller.subscribe(publishState);
    startLive();
    await createWindow();
    createTray();
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
  }).catch(() => {
    dialog.showErrorBox('Companion could not start', 'The local desktop build could not load. Run the build again before launching.');
    app.quit();
  });
}
