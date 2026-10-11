import { Menu, Pause, Play, RotateCcw } from 'lucide-react';
import type { CompanionView } from '../view';
import { Emblem, HeroArt } from './Art';

export function TopBar({ view, onMenu, onPause, onRetry, readerEnabled }: {
  view: CompanionView; readerEnabled: boolean;
  onMenu: () => void; onPause: (enabled: boolean) => void; onRetry: () => void;
}) {
  const { status } = view;
  return <header className="topbar">
    <div className="brand">
      <Emblem size={38} />
      <div className="brand-text">
        <span className="brand-kicker">Deadlock companion</span>
        <span className="brand-name">Street Brawl</span>
      </div>
    </div>
    <div className="topbar-controls">
      <span className={`status status-${status.tone}`} role="status" aria-live="polite"><i aria-hidden="true" />{status.label}</span>
      {view.canPause && (view.automaticallyPaused
        ? <button type="button" className="icon-btn" onClick={onRetry} title="Retry reading" aria-label="Retry reading"><RotateCcw size={16} /></button>
        : <button type="button" className="icon-btn" onClick={() => onPause(!readerEnabled)} aria-pressed={!readerEnabled}
          title={readerEnabled ? 'Pause reading' : 'Resume reading'} aria-label={readerEnabled ? 'Pause reading' : 'Resume reading'}>
          {readerEnabled ? <Pause size={16} /> : <Play size={16} />}</button>)}
      <button type="button" className="icon-btn" onClick={onMenu} title="Settings & reader" aria-label="Open settings and reader details"><Menu size={18} /></button>
    </div>
  </header>;
}

export function MatchStrip({ view }: { view: CompanionView }) {
  const { match, me } = view;
  const hasAny = match.round !== null || match.scores !== null || match.rerollsLeft !== null || !!me.hero;
  if (!hasAny) return null;
  return <section className="match-strip" aria-label="Match">
    {me.hero && <div className="strip-cell strip-hero"><HeroArt hero={me.hero} variant="small" /><span><small>Playing</small><strong>{me.hero.name}</strong></span></div>}
    <div className="strip-cell"><small>Round</small><strong className="num">{match.round ?? '–'}</strong></div>
    {match.scores
      ? <div className="strip-cell strip-score" aria-label={`${match.scores.labels[0]} ${match.scores.ours}, ${match.scores.labels[1]} ${match.scores.theirs}`}>
        <span><small>{match.scores.labels[0]}</small><strong className="num ally">{match.scores.ours}</strong></span>
        <i aria-hidden="true" />
        <span><small>{match.scores.labels[1]}</small><strong className="num enemy">{match.scores.theirs}</strong></span>
      </div>
      : <div className="strip-cell"><small>Score</small><strong className="num muted">–</strong></div>}
    <div className="strip-cell"><small>Rerolls</small><strong className="num">{match.rerollsLeft ?? '–'}</strong></div>
  </section>;
}
