import { useEffect, useRef, useState } from 'react';
import type { AppSettings, Catalog, CompanionBridge, DisplayInfo, MatchState } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { createBrowserBridge } from '../app/browser-bridge';
import { Companion } from './Companion';
import type { ScreenReaderState } from '../shared/screen-reading';
import { newestScreenReaderState } from './screen-state';

declare global { interface Window { companion?: CompanionBridge } }
const bridge = window.companion ?? createBrowserBridge();

export function App() {
  const [state, setState] = useState<MatchState | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [screenReader, setScreenReader] = useState<ScreenReaderState | null>(null);
  const previousMode = useRef<MatchState['mode'] | null>(null);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = bridge.subscribe(next => {
      if (!mounted) return;
      setState(next);
      if (previousMode.current !== next.mode) {
        previousMode.current = next.mode;
        setCatalog(null);
        void bridge.getCatalog().then(nextCatalog => {
          if (mounted && previousMode.current === next.mode) setCatalog(nextCatalog);
        });
      }
    });
    const unsubscribeReader = bridge.subscribeScreenReader(next => { if (mounted) setScreenReader(current => newestScreenReaderState(current, next)); });
    void bridge.getScreenReaderState().then(next => { if (mounted) setScreenReader(current => newestScreenReaderState(current, next)); })
      .catch(() => { if (mounted) setError('The screen reader could not initialize. Restart the application.'); });
    void Promise.all([bridge.getState(), bridge.getCatalog(), bridge.getSettings(), bridge.getDisplays()]).then(([next, nextCatalog, nextSettings, nextDisplays]) => {
      if (!mounted) return;
      previousMode.current = next.mode;
      setState(next); setCatalog(nextCatalog); setSettings(nextSettings); setDisplays(nextDisplays);
    }).catch(() => { if (mounted) setError('The companion could not initialize. Restart the application.'); });
    return () => { mounted = false; unsubscribe(); unsubscribeReader(); };
  }, []);

  function action(work: Promise<unknown>) {
    setError(null);
    void work.catch(() => setError('The action could not be completed. Please try again.'));
  }
  function exportDiagnostics() {
    if (window.companion) { action(bridge.exportDiagnostics()); return; }
    action(bridge.exportDiagnostics().then(text => {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'street-brawl-diagnostics.json'; link.click();
      URL.revokeObjectURL(url);
    }));
  }
  if (!state || !catalog) return <main className="boot-state" role="status">{error ?? 'Opening Street Brawl Companion…'}</main>;
  return <>
    {error && <div className="app-error" role="alert">{error}<button onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
    <Companion state={state} catalog={catalog} settings={settings} displays={displays}
      onModeChange={mode => action(bridge.setMode(mode))}
      onScenario={id => action(bridge.runDemoScenario(id))}
      onSettingsChange={patch => action(bridge.updateSettings(patch).then(setSettings))}
      onExportDiagnostics={exportDiagnostics} screenReader={screenReader}
      onScreenEnabled={enabled => action(bridge.setScreenReaderEnabled(enabled))}
      onScreenCrop={crop => action(bridge.setScreenReaderCrop(crop))}
      onScreenRetry={() => action(bridge.retryScreenReader())}
      onScreenPreview={() => action(bridge.previewScreenReader().then(next => setScreenReader(current => newestScreenReaderState(current, next))))} />
  </>;
}
