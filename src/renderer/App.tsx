import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings, Catalog, CompanionBridge, DisplayInfo } from '../shared/types';
import type { ScreenReaderState } from '../shared/screen-reading';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { createBrowserBridge } from '../app/browser-bridge';
import { newestScreenReaderState } from './screen-state';
import { useReaderClock } from './clock';
import { deriveView } from './view';
import type { NoticeAction } from './view';
import { Emblem } from './components/Art';
import { TopBar, MatchStrip } from './components/TopBar';
import { Decision } from './components/Decision';
import { Guide, Loadout, Teams } from './components/Loadout';
import { Sheet } from './components/Sheet';
import type { SheetTab } from './components/Sheet';

declare global { interface Window { companion?: CompanionBridge } }
const bridge = window.companion ?? createBrowserBridge();

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [reader, setReader] = useState<ScreenReaderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ open: boolean; tab: SheetTab }>({ open: false, tab: 'display' });
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let mounted = true;
    const unsubscribeReader = bridge.subscribeScreenReader((next) => { if (mounted) setReader((current) => newestScreenReaderState(current, next)); });
    void bridge.getScreenReaderState().then((next) => { if (mounted) setReader((current) => newestScreenReaderState(current, next)); })
      .catch(() => { if (mounted) setError('The screen reader could not start. Restart the companion.'); });
    void Promise.all([bridge.getCatalog(), bridge.getSettings(), bridge.getDisplays()]).then(([nextCatalog, nextSettings, nextDisplays]) => {
      if (!mounted) return;
      setCatalog(nextCatalog); setSettings(nextSettings); setDisplays(nextDisplays);
    }).catch(() => { if (mounted) setError('The companion could not start. Restart it.'); });
    return () => { mounted = false; unsubscribeReader(); };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--text-scale', String(Math.min(1.5, Math.max(0.8, settings.textScale))));
  }, [settings.textScale]);

  const run = useCallback((work: Promise<unknown>) => {
    setError(null);
    void work.catch(() => setError('That did not work. Please try again.'));
  }, []);

  const shown = reader;
  const clock = useReaderClock(shown, retryNonce, true);
  const view = useMemo(() => catalog ? deriveView(shown, catalog, clock) : null, [shown, catalog, clock.now, clock.readingSince, clock.lastProgressAt]);

  const retry = useCallback(() => { setRetryNonce((count) => count + 1); run(bridge.retryScreenReader()); }, [run]);
  const openSheet = useCallback((tab: SheetTab = 'display') => setSheet({ open: true, tab }), []);
  const closeSheet = useCallback(() => setSheet((current) => ({ ...current, open: false })), []);
  const onAction = useCallback((action: NoticeAction) => {
    if (action === 'reading-area') openSheet('area');
    else if (action === 'resume') run(bridge.setScreenReaderEnabled(true));
    else retry();
  }, [openSheet, retry, run]);
  const exportDiagnostics = useCallback(() => {
    if (window.companion) { run(bridge.exportDiagnostics()); return; }
    run(bridge.exportDiagnostics().then((text) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'street-brawl-diagnostics.json'; link.click();
      URL.revokeObjectURL(url);
    }));
  }, [run]);

  if (!catalog || !view) {
    return <main className="boot" role="status"><Emblem size={56} /><span>{error ?? 'Opening the companion…'}</span></main>;
  }

  return <div className="app">
    <a className="skip-link" href="#decision">Skip to the current decision</a>
    <TopBar view={view} readerEnabled={reader?.enabled ?? true} onMenu={() => openSheet()}
      onPause={(enabled) => run(bridge.setScreenReaderEnabled(enabled))} onRetry={retry} />
    {error && <div className="toast" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
    <main className="content">
      <MatchStrip view={view} />
      {view.calibrationRequired && <button type="button" className="callout" onClick={() => openSheet('area')}>
        <strong>Adjust the reading area</strong><span>Include all three draft cards. Leave out your inventory and other menus.</span></button>}
      <Decision view={view} generation={shown?.generation ?? 0} onAction={onAction} />
      <Loadout view={view} />
      <Teams view={view} />
      {!view.hasMatchData && <Guide />}
    </main>
    <footer className="footer">
      <span>{view.lastReadAt ? `Last card reading ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(view.lastReadAt)}` : 'Reads only what is visible on your screen'}</span>
      <button type="button" className="link-btn" onClick={() => openSheet('reader')}>Reader details</button>
    </footer>
    <Sheet open={sheet.open} tab={sheet.tab} onTab={(tab) => setSheet({ open: true, tab })} onClose={closeSheet}
      settings={settings} displays={displays} catalog={catalog} reader={shown}
      onSettings={(patch) => { setSettings((current) => ({ ...current, ...patch })); run(bridge.updateSettings(patch).then(setSettings)); }}
      onCrop={(crop) => run(bridge.setScreenReaderCrop(crop))}
      onPreview={() => run(bridge.previewScreenReader().then((next) => setReader((current) => newestScreenReaderState(current, next))))}
      onRetry={retry} onExport={exportDiagnostics} />
  </div>;
}
