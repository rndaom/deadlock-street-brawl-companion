import { memo } from 'react';
import { AlertTriangle, ChevronDown, Crosshair, Eye, Gamepad2, Loader, PauseCircle, RefreshCw, RotateCcw, ScanSearch, Shield, SlidersHorizontal, Sparkles, Swords, Trophy, TrendingUp, TriangleAlert, Wand2 } from 'lucide-react';
import type { CallView, CardView, CompanionView, Notice, NoticeAction, Reason, ReasonKind, WinStat } from '../view';
import { ROMAN } from '../catalog-index';
import { AbilityArt, CategoryGlyph, Emblem, ItemArt, RerollMark, Sunburst } from './Art';

const CATEGORY_NAMES = { weapon: 'Weapon', vitality: 'Vitality', spirit: 'Spirit', unknown: 'Item' } as const;
const KICKERS = {
  pick: (side: string) => `Take the ${side.toLowerCase()} card`,
  close: (side: string) => `Close call · lean ${side.toLowerCase()}`,
  reroll: () => 'Reroll suggested',
  consider: (side: string) => `Consider the ${side.toLowerCase()} card`,
};
const REASON_ICONS: Record<ReasonKind, typeof Sparkles> = {
  stat: TrendingUp, counter: Swords, concern: TriangleAlert, enhanced: Sparkles, imbue: Wand2, build: Crosshair, text: Sparkles,
};

export function StatChips({ stat, compact = false }: { stat: WinStat; compact?: boolean }) {
  return <span className={`chips ${compact ? 'chips-compact' : ''}`}>
    <span className={`chip chip-wr ${stat.positive ? 'chip-up' : ''}`} title={`Wins ${stat.winRate}% of ${stat.games} Street Brawl games${stat.hero ? ` on ${stat.hero}` : ''}`}>
      <strong className="num">{stat.winRate}%</strong>{compact ? '' : ' win rate'}
    </span>
    {!compact && <span className="chip">{stat.games} games{stat.hero ? ` on ${stat.hero}` : ''}</span>}
    {!compact && stat.delta !== 'about average' && <span className={`chip ${stat.positive ? 'chip-up' : 'chip-down'}`}>{stat.delta}</span>}
    {stat.valve && <span className="chip chip-valve" title="On Valve's own list of good items for this hero">{compact ? 'Valve' : "Valve's list"}</span>}
  </span>;
}

function ReasonLine({ reason }: { reason: Reason }) {
  const Icon = REASON_ICONS[reason.kind];
  return <li className={`reason reason-${reason.kind}`}><Icon size={14} aria-hidden="true" /><span>{reason.text}</span></li>;
}

export const CallPanel = memo(function CallPanel({ call, generation }: { call: CallView; generation: number }) {
  const { item } = call;
  return <section className={`call call-${call.kind} cat-${item.category}`} aria-labelledby="call-item" aria-live="polite" key={generation}>
    <div className="call-inner">
      <div className="call-kicker">
        <span className="call-flag">{call.kind === 'reroll' ? <RefreshCw size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}{KICKERS[call.kind](call.positionLabel)}</span>
        {call.kind === 'close' && <span className="call-note">Either top card is solid</span>}
      </div>
      {call.kind === 'reroll' ? <>
        <div className="call-hero">
          <div className="call-art"><Sunburst /><RerollMark /></div>
          <div className="call-title">
            <h1 id="call-item">Reroll</h1>
            {call.reroll.left !== null && <div className="call-meta"><span className="tier-label">{call.reroll.left} {call.reroll.left === 1 ? 'reroll' : 'rerolls'} left this round</span></div>}
            <p className="call-lede">{call.reroll.text.replace(/^\d+ rerolls? left\.\s*/, '')}</p>
          </div>
        </div>
        <div className="fallback">
          <span className="fallback-label">If you keep these</span>
          <ItemArt id={item.id} item={item} size="sm" />
          <span className="fallback-name"><strong>{item.name}</strong><small>{call.positionLabel} card · {CATEGORY_NAMES[item.category]}{item.tier ? ` · Tier ${ROMAN[item.tier]}` : ''}</small></span>
          {call.stat && <StatChips stat={call.stat} compact />}
        </div>
      </> : <div className="call-hero">
        <div className="call-art"><Sunburst /><ItemArt id={item.id} item={item} size="xl" /></div>
        <div className="call-title">
          <h1 id="call-item">{item.name}</h1>
          <div className="call-meta">
            <span className={`cat-label cat-${item.category}`}><CategoryGlyph category={item.category} />{CATEGORY_NAMES[item.category]}</span>
            {item.tier && <span className="tier-label">Tier {ROMAN[item.tier]}</span>}
            {call.offer.rare && <span className="tag tag-rare">Rare</span>}
            {call.offer.variant !== 'base' && call.offer.variant !== 'unknown' && <span className={`tag tag-${call.offer.variant}`}>{call.offer.variant}</span>}
          </div>
          {call.stat && <StatChips stat={call.stat} />}
        </div>
      </div>}
      {call.reasons.length > 0 && <ul className={`reasons ${call.kind === 'reroll' ? 'reasons-quiet' : ''}`}>{call.reasons.slice(0, call.kind === 'reroll' ? 2 : 3).map((reason, index) => <ReasonLine key={index} reason={reason} />)}</ul>}
      {(call.imbue || call.caveat || (call.reroll.text && call.kind !== 'reroll')) && <div className="call-notes">
        {call.imbue && <div className="note note-imbue">
          <AbilityArt label={call.imbue.ability} size="sm" />
          <span><strong>Imbue on {call.imbue.abilityName}</strong><small>{call.imbue.why}</small></span>
        </div>}
        {call.caveat && <div className="note note-caveat"><AlertTriangle size={15} aria-hidden="true" /><span>{call.caveat}</span></div>}
        {call.reroll.text && call.kind !== 'reroll' && <div className={`note note-reroll ${call.reroll.suggested ? 'note-reroll-go' : ''}`}>
          <RotateCcw size={15} aria-hidden="true" /><span>{call.reroll.text}</span>
        </div>}
      </div>}
      <details className="why">
        <summary><span>{call.kind === 'reroll' ? 'Why reroll' : 'Why this pick'}</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="why-body">
          {call.moreReasons.length > 0 && <ul className="reasons reasons-more">{call.moreReasons.map((reason, index) => <ReasonLine key={index} reason={reason} />)}</ul>}
          {call.facts.length > 0 && <>
            <h3>Match facts used</h3>
            <ul className="facts">{call.facts.map((fact, index) => <li key={index}><span className={`fact-scope fact-${fact.scope}`}>{{ own: 'You', ally: 'Ally', enemy: 'Enemy', round: 'Round', catalog: 'Item' }[fact.scope]}</span>{fact.label}</li>)}</ul>
          </>}
          <h3>Limits</h3>
          <ul className="limits">{call.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>
        </div>
      </details>
    </div>
  </section>;
});

const DraftCard = memo(function DraftCard({ card }: { card: CardView }) {
  const state = card.isPick ? 'pick' : card.isConsider ? 'consider' : card.isFallback ? 'fallback' : '';
  const label = `${card.label} card: ${card.name}${card.isPick ? ', suggested pick' : card.isConsider ? ', base item to consider' : card.isFallback ? ', best card if you keep these' : ''}${card.tags.length ? `, ${card.tags.join(', ')}` : ''}`;
  return <article className={`card cat-${card.category} ${state ? `card-${state}` : ''} ${card.offer ? '' : 'card-empty'} ${card.offer && !card.identified ? 'card-unknown' : ''}`}
    aria-label={label} style={{ ['--i' as string]: card.position }}>
    <header className="card-top">
      <span className="card-side">{card.label}</span>
      {card.isPick ? <span className="card-badge">Pick</span> : card.isConsider ? <span className="card-badge card-badge-soft">Consider</span>
        : card.isFallback ? <span className="card-badge card-badge-soft">If kept</span>
        : card.tier ? <span className="card-tier">{ROMAN[card.tier]}</span> : null}
    </header>
    <div className="card-art"><ItemArt id={card.item?.id ?? null} item={card.item} size="lg" /></div>
    <h3 className="card-name">{card.name}</h3>
    {card.tags.length > 0 && <div className="card-tags">{card.tags.map((tag) => <span key={tag} className={`tag tag-${tag.toLowerCase().split(' ')[0]}`}>{tag}</span>)}</div>}
    {card.offer && !card.identified && <p className="card-note">Not identified. Check this card in game.</p>}
    <footer className="card-foot">
      {card.fit !== null && <span className="fit" aria-label={`Fit ${card.fit} of 5`}>{[1, 2, 3, 4, 5].map((step) => <i key={step} className={step <= card.fit! ? 'on' : ''} />)}</span>}
      {card.stat ? <StatChips stat={card.stat} compact /> : card.note && card.identified ? <span className="card-hint" title={card.note}>{card.note}</span> : null}
    </footer>
  </article>;
});

export function DraftBoard({ cards, generation }: { cards: CardView[]; generation: number }) {
  return <section className="board" aria-label="Visible draft cards, in game order" key={generation}>
    {cards.map((card) => <DraftCard key={card.position} card={card} />)}
  </section>;
}

const NOTICE_ICONS: Record<Notice['kind'], typeof Eye> = {
  unavailable: TriangleAlert, paused: PauseCircle, 'auto-paused': PauseCircle, starting: Loader, 'waiting-game': Gamepad2,
  background: Eye, stalled: TriangleAlert, reading: ScanSearch, unconfirmed: ScanSearch, stale: ScanSearch,
  spectator: Eye, finished: Trophy, between: Shield, source: ScanSearch, idle: ScanSearch,
};
const ACTION_LABELS: Record<NoticeAction, string> = { resume: 'Resume reading', retry: 'Retry reading', 'read-again': 'Read again', 'reading-area': 'Check reading area' };

export function NoticePanel({ notice, compact = false, crest = false, onAction, disabled }: { notice: Notice; compact?: boolean; crest?: boolean; disabled?: boolean; onAction: (action: NoticeAction) => void }) {
  const Icon = NOTICE_ICONS[notice.kind];
  const tone = ['unavailable', 'stalled', 'auto-paused', 'background', 'unconfirmed', 'stale'].includes(notice.kind) ? 'warn' : notice.kind === 'paused' ? 'off' : 'calm';
  return <section className={`notice notice-${tone} ${compact ? 'notice-compact' : ''} ${crest ? 'notice-crest' : ''}`} aria-live="polite" aria-labelledby="notice-title">
    {crest
      ? <span className="crest" aria-hidden="true"><Sunburst /><Emblem size={92} /><span className="crest-badge"><Icon size={15} strokeWidth={1.8} /></span></span>
      : <span className="notice-icon" aria-hidden="true"><Icon size={compact ? 18 : 24} strokeWidth={1.5} /></span>}
    <div className="notice-text">
      <h1 id="notice-title">{notice.title}</h1>
      <p>{notice.body}</p>
      {notice.tip === 'tab' && <p className="notice-tip">At a safe moment, hold <kbd>Tab</kbd> for about 10 seconds to read both teams&apos; builds.</p>}
      {notice.actions.length > 0 && <div className="notice-actions">{notice.actions.map((action) =>
        <button key={action} type="button" className={action === 'resume' || action === 'retry' || action === 'read-again' ? 'btn btn-primary' : 'btn'} disabled={disabled} onClick={() => onAction(action)}>
          {action === 'reading-area' ? <SlidersHorizontal size={14} aria-hidden="true" /> : action === 'resume' ? <Sparkles size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
          {ACTION_LABELS[action]}
        </button>)}</div>}
    </div>
  </section>;
}

export function Decision({ view, generation, onAction }: { view: CompanionView; generation: number; onAction: (action: NoticeAction) => void }) {
  return <div className="decision" id="decision" tabIndex={-1}>
    {view.call ? <CallPanel call={view.call} generation={generation} />
      : view.notice ? <NoticePanel notice={view.notice} compact={!!view.cards} crest={!view.hasMatchData} onAction={onAction} /> : null}
    {view.cards && <DraftBoard cards={view.cards} generation={generation} />}
    {view.holding && <p className="holding-note"><Eye size={13} aria-hidden="true" />Showing the cards from your last look at the game.</p>}
  </div>;
}
