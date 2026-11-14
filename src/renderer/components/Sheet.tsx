import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, Eye, FileDown, Monitor, RotateCcw, X } from 'lucide-react';
import type { AppSettings, Catalog, DisplayInfo } from '../../shared/types';
import type { CaptureRegion, ScreenReaderState } from '../../shared/screen-reading';
import { DEFAULT_CAPTURE_REGION } from '../../shared/screen-reading';

export type SheetTab = 'display' | 'area' | 'reader' | 'about';

const PRESETS: { name: string; crop: CaptureRegion }[] = [
  { name: 'Suggested', crop: { ...DEFAULT_CAPTURE_REGION } },
  { name: 'Wide', crop: { x: 0.02, y: 0.06, width: 0.96, height: 0.86 } },
  { name: 'Whole window', crop: { x: 0, y: 0, width: 1, height: 1 } },
];
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

function ReadingArea({ reader, onCrop, onPreview }: Pick<SheetProps, 'reader' | 'onCrop' | 'onPreview'>) {
  const crop = reader?.crop ?? DEFAULT_CAPTURE_REGION;
  const [draft, setDraft] = useState<CaptureRegion>(crop);
  const [applied, setApplied] = useState(false);
  // The reader echoing the applied area back must not wipe the "Applied" note; adjusting the area clears it.
  useEffect(() => { setDraft(crop); }, [crop.x, crop.y, crop.width, crop.height]);
  const changed = draft.x !== crop.x || draft.y !== crop.y || draft.width !== crop.width || draft.height !== crop.height;
  const adjust = (field: keyof CaptureRegion, value: number) => {
    setApplied(false);
    setDraft((current) => {
      const next = { ...current, [field]: value };
      next.x = Math.min(0.85, Math.max(0, next.x)); next.y = Math.min(0.85, Math.max(0, next.y));
      next.width = Math.min(1 - next.x, Math.max(0.15, next.width)); next.height = Math.min(1 - next.y, Math.max(0.15, next.height));
      return next;
    });
  };
  const region = { left: pct(draft.x), top: pct(draft.y), width: pct(draft.width), height: pct(draft.height) } as CSSProperties;
  return <div className="sheet-section">
    <p className="sheet-intro">The part of the Deadlock window that holds all three draft cards. The reader also checks the heading and buttons to tell when a draft opens and closes.</p>
    {reader?.calibrationRequired && <p className="sheet-callout">The reader asked for an adjustment: include all three cards, and leave out your inventory and other menus.</p>}
    <div className="presets" role="group" aria-label="Reading area presets">
      {PRESETS.map((preset) => <button key={preset.name} type="button" className="btn btn-small" onClick={() => { setDraft(preset.crop); setApplied(false); }}>{preset.name}</button>)}
    </div>
    <div className="crop-diagram" role="img" aria-label={`Selected area: left ${pct(draft.x)}, top ${pct(draft.y)}, width ${pct(draft.width)}, height ${pct(draft.height)}`}>
      <span className="crop-cards" aria-hidden="true"><i /><i /><i /></span>
      <span className="crop-region" style={region}><span>Read area</span></span>
    </div>
    <div className="sliders">
      {([['x', 'Left edge'], ['y', 'Top edge'], ['width', 'Width'], ['height', 'Height']] as const).map(([field, label]) =>
        <label key={field} className="slider"><span>{label}<strong className="num">{pct(draft[field])}</strong></span>
          <input type="range" min={field === 'width' || field === 'height' ? 0.15 : 0} max={field === 'x' || field === 'y' ? 0.85 : 1} step="0.01" value={draft[field]}
            onChange={(event) => adjust(field, Number(event.target.value))} /></label>)}
    </div>
    <div className="sheet-actions">
      <span className="sheet-status" role="status">{applied ? 'Applied. Keep the draft visible.' : changed ? 'Not applied yet.' : 'Current area.'}</span>
      <button type="button" className="btn" disabled={!reader?.gamePresent || changed} onClick={onPreview}><Eye size={14} />Preview</button>
      <button type="button" className="btn btn-primary" disabled={!reader || !changed} onClick={() => { onCrop(draft); setApplied(true); }}><Check size={14} />Apply</button>
    </div>
    {reader?.previewDataUrl && <figure className="crop-preview"><img src={reader.previewDataUrl} alt="Latest capture of the selected card area" /><figcaption>Latest preview. All three cards and the heading should be inside.</figcaption></figure>}
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
              <option value="">Automatic (portrait monitor first)</option>
              {displays.map((display) => <option key={display.id} value={display.id}>{display.label} · {display.width}×{display.height}{display.primary ? ' · primary' : ''}</option>)}
            </select></label>
          <label className="slider"><span>Text size<strong className="num">{Math.round(settings.textScale * 100)}%</strong></span>
            <input type="range" min="0.8" max="1.5" step="0.05" value={settings.textScale} onChange={(event) => onSettings({ textScale: Number(event.target.value) })} /></label>
          <Toggle checked={settings.overlay} onChange={(overlay) => onSettings({ overlay })} label="In-game overlay" help="Marks the pick on the draft screen inside Deadlock, so one monitor is enough. Press F7 in game for your leveling plan. Needs Deadlock in borderless or windowed mode." />
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
