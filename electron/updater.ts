import { app, Notification } from 'electron';
import electronUpdater from 'electron-updater';

/**
 * Updates from the GitHub releases of rndaom/deadlock-street-brawl-companion (the publish entry in package.json,
 * written into the package as app-update.yml). Only the installed builds can replace themselves: the Windows
 * installer build and the Linux AppImage. A dev run, a portable folder or an unpacked Linux build never checks.
 * A found update downloads in the background and installs the next time the companion quits; the tray offers to
 * restart now instead.
 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15 * 1000;

export type UpdateState = { readyVersion: string | null };

export function canSelfUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE);
  return process.platform === 'win32';
}

export function startUpdater(onChange: (state: UpdateState) => void): { installNow: () => void } {
  const { autoUpdater } = electronUpdater;
  let readyVersion: string | null = null;
  if (!canSelfUpdate()) return { installNow: () => undefined };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  autoUpdater.on('error', error => console.warn(`Update check failed: ${error instanceof Error ? error.message : String(error)}`));
  autoUpdater.on('update-downloaded', info => {
    if (readyVersion === info.version) return;
    readyVersion = info.version;
    onChange({ readyVersion });
    if (!Notification.isSupported()) return;
    const notice = new Notification({
      title: `Street Brawl Companion ${info.version} is ready`,
      body: 'It installs when you quit the companion. Click to restart and update now.',
    });
    notice.on('click', () => installNow());
    notice.show();
  });

  const check = (): void => { autoUpdater.checkForUpdates().catch(() => { /* reported through the error event */ }); };
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref();
  setInterval(check, CHECK_INTERVAL_MS).unref();

  function installNow(): void {
    if (!readyVersion) return;
    // Silent install on Windows (the one-click installer shows no pages anyway), then start the new version.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }
  return { installNow };
}
