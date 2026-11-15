import { useEffect, useRef } from 'react';
import { Eye, FileDown, Monitor, RotateCcw, X } from 'lucide-react';
import type { AppSettings, Catalog, DisplayInfo } from '../../shared/types';
import type { CaptureRegion, ScreenReaderState } from '../../shared/screen-reading';

export type SheetTab = 'display' | 'area' | 'reader' | 'about';

const pct = (value: number) => `${Math.round(value * 100)}%`;
const time = (at: number | null) => at === null ? 'Not yet' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(at);

export interface SheetProps {
  open: boolean; tab: SheetTab; onTab: (tab: SheetTab) => void; onClose: () => void;
  settings: AppSettings; displays: DisplayInfo[]; catalog: Catalog; reader: ScreenReaderState | null;
  onSettings: (patch: Partial<AppSettings>) => void; onCrop: (crop: CaptureRegion) => void; onPreview: () => void;
  onRetry: () => void; onExport: () => void;
}

function Toggle({ checked, onChange, label, help }: { checked: boolean; onChange: (value: boolean) => void; label: string; help: string }) {
  return <label className="toggle-row">
    <span><strong>{label}</strong><small>{help}</small></span>
    <input type="checkbox" className="toggle" checked={checked} onChange={(event) => onChange(event.target.checked)} />
  </label>;
}

function ReadingArea({ reader, onPreview }: Pick<SheetProps, 'reader' | 'onPreview'>) {
  const game = reader?.gamePresent ? reader.gameBounds ?? null : null;
  const where = !reader?.gamePresent ? 'Waiting for Deadlock to start.'
    : !game ? 'Deadlock is running. Its window size is read with the next capture.'
    : reader.foreground ? 'Deadlock is in front. Draft cards are read as they appear.'
    : reader.gameVisible ? 'Deadlock is visible behind the companion. Reads continue.'
    : 'Deadlock is covered or in the background. Reads resume when it is back in view.';
  return <div className="sheet-section">
    <p className="sheet-intro">The reading area is automatic. The reader finds the Deadlock window on any monitor, follows its size and position, and reads the draft cards, heading and buttons wherever they are on the window. Nothing to set up.</p>
    <dl className="facts-list">
      <div><dt>Game window</dt><dd>{game ? `${game.width}×${game.height}` : 'Not found yet'}</dd></div>
      <div><dt>Status</dt><dd>{where}</dd></div>
    </dl>
    <p className="sheet-note">Keep Deadlock in borderless windowed or windowed mode. On one monitor the in-game overlay marks the pick, and the companion can sit over the game without stopping the reads.</p>
    <div className="sheet-actions">
      <span className="sheet-status" role="status">{reader?.previewDataUrl ? 'Latest capture below.' : 'Check what the reader sees.'}</span>
      <button type="button" className="btn" disabled={!reader?.gamePresent} onClick={onPreview}><Eye size={14} />Preview</button>
    </div>
    {reader?.previewDataUrl && <figure className="crop-preview"><img src={reader.previewDataUrl} alt="Latest capture of the draft area" /><figcaption>Latest preview. During a draft, all three cards should be inside.</figcaption></figure>}
  </div>;
}

function ReaderHealth({ reader, onRetry, onExport }: Pick<SheetProps, 'reader' | 'onRetry' | 'onExport'>) {
  const metrics = reader?.metrics;
  const cpu = metrics?.cpuPercent ?? null;
  const memory = metrics?.memoryMb ?? null;
  const rows: [string, string][] = [
    ['Deadlock window', !reader ? 'Not checked' : reader.gamePresent ? reader.foreground ? 'Found · in front' : 'Found · in background' : 'Not found'],
    ['Text reader', reader?.engineReady ? 'Ready' : 'Preparing'],
    ['Last card reading', time(reader?.observedAt ?? null)],
    ['Reading time', reader?.readMs == null ? '–' : `${Math.round(reader.readMs)} ms`],
    ['Reads · skipped · timeouts', metrics ? `${metrics.reads} · ${metrics.skipped} · ${metrics.timeouts}` : '–'],
  ];
  return <div className="sheet-section">
    <p className="sheet-intro">The reader runs as its own low-priority process and only looks at the visible game window. It never sends input to the game.</p>
    <div className="gauges">
      <div className="gauge"><small>Reader CPU</small><strong className="num">{cpu === null ? '–' : `${cpu.toFixed(1)}%`}</strong><span className="gauge-bar"><i style={{ width: `${Math.min(100, (cpu ?? 0) * 4)}%` }} /></span></div>
      <div className="gauge"><small>Reader memory</small><strong className="num">{memory === null ? '–' : `${Math.round(memory)} MB`}</strong><span className="gauge-bar"><i style={{ width: `${Math.min(100, (memory ?? 0) / 3)}%` }} /></span></div>
    </div>
    <dl className="facts-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {reader?.message && <p className="sheet-message">{reader.message}</p>}
    {reader && reader.offers.length > 0 && <>
      <h3 className="sheet-h3">Card name matching</h3>
      <ul className="match-quality">{reader.offers.slice().sort((a, b) => a.position - b.position).map((offer) =>
        <li key={offer.position}><span>{offer.name}</span><strong className="num">{pct(offer.confidence)}</strong></li>)}</ul>
    </>}
    <div className="sheet-actions">
      <button type="button" className="btn" disabled={!reader || (!reader.enabled && reader.status !== 'unavailable')} onClick={onRetry}><RotateCcw size={14} />Read again</button>
      <button type="button" className="btn" onClick={onExport}><FileDown size={14} />Export diagnostics</button>
    </div>
  </div>;
}

export function Sheet(props: SheetProps) {
  const { open, tab, onTab, onClose, settings, displays, catalog, onSettings } = props;
  const panel = useRef<HTMLDivElement>(null);
  // Keyboard focus goes back to whatever opened the sheet when it closes.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const tabs: [SheetTab, string][] = [['display', 'Display'], ['area', 'Reading area'], ['reader', 'Reader'], ['about', 'About']];
  return <div className="sheet-layer">
    <button type="button" className="sheet-scrim" aria-label="Close settings" onClick={onClose} tabIndex={-1} />
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={panel} tabIndex={-1}>
      <header className="sheet-head">
        <h2 id="sheet-title">Companion</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" id={`sheet-tab-${id}`} aria-controls="sheet-panel" aria-selected={tab === id} onClick={() => onTab(id)}>{label}</button>)}
      </div>
      <div className="sheet-body" id="sheet-panel" role="tabpanel" aria-labelledby={`sheet-tab-${tab}`}>
        {tab === 'display' && <div className="sheet-section">
          <label className="field"><span><Monitor size={14} aria-hidden="true" />Companion display</span>
            <select value={settings.displayId ?? ''} onChange={(event) => onSettings({ displayId: event.target.value || null })}>
              <option value="">Automatic (away from the game's monitor)</option>
              {displays.map((display) => <option key={display.id} value={display.id}>{display.label} · {display.width}×{display.height}{display.primary ? ' · primary' : ''}</option>)}
            </select></label>
          <label className="slider"><span>Text size<strong className="num">{Math.round(settings.textScale * 100)}%</strong></span>
            <input type="range" min="0.8" max="1.5" step="0.05" value={settings.textScale} onChange={(event) => onSettings({ textScale: Number(event.target.value) })} /></label>
          <Toggle checked={settings.overlay} onChange={(overlay) => onSettings({ overlay })} label="In-game overlay" help="Marks the pick on the draft screen inside Deadlock, so one monitor is enough. It follows the game window on any monitor and size. Press F7 in game for your leveling plan. Needs Deadlock in borderless or windowed mode." />
          <label className="slider"><span>Active items: at most<strong className="num">{settings.maxActiveItems === 4 ? '4 (no limit)' : settings.maxActiveItems}</strong></span>
            <input type="range" min="0" max="4" step="1" value={settings.maxActiveItems} onChange={(event) => onSettings({ maxActiveItems: Number(event.target.value) })} />
            <small className="sheet-intro">Active items have a button to press. Once you own this many, the pick skips another active card when a card without a button is on offer. 4 means no limit.</small></label>
          <Toggle checked={settings.alwaysOnTop} onChange={(alwaysOnTop) => onSettings({ alwaysOnTop })} label="Keep on top" help="Stays above other windows. Deadlock keeps the game input." />
          <Toggle checked={settings.saveScreenshots} onChange={(saveScreenshots) => onSettings({ saveScreenshots })} label="Save troubleshooting screenshots" help="Keeps the last 60 draft and scoreboard screenshots in Documents\Street Brawl Companion\diagnostics so misreads can be replayed. They show player names and chat." />
        </div>}
        {tab === 'area' && <ReadingArea {...props} />}
        {tab === 'reader' && <ReaderHealth {...props} />}
        {tab === 'about' && <div className="sheet-section about">
          <p className="sheet-intro">Reads your visible Deadlock screen (draft cards, the top bar, the Tab scoreboard and the ability upgrade view) and suggests a pick from Street Brawl match results, your hero, your build and the enemy team.</p>
          <ul className="about-list">
            <li>Names can be misread. Glance at the card in game before choosing.</li>
            <li>Win rates come from public Street Brawl matches; they describe the item, not your odds.</li>
            <li>Hidden information stays unknown. Builds refresh whenever the scoreboard is open.</li>
          </ul>
          <dl className="facts-list"><div><dt>Item catalogue</dt><dd>Build {catalog.clientVersion} · {catalog.items.length} items · {catalog.heroes.length} heroes</dd></div>
            <div><dt>Companion</dt><dd>Version {__APP_VERSION__}</dd></div></dl>
          <p className="sheet-note">Unofficial fan tool, not affiliated with or endorsed by Valve. Deadlock and its art belong to Valve. Statistics and game data come from the community deadlock-api.com.</p>
        </div>}
      </div>
    </div>
  </div>;
}
