import { useEffect, useMemo, useState } from 'react';
import type { Catalog, CompanionBridge, OverlayStatus } from '../shared/types';
import type { ScreenReaderState } from '../shared/screen-reading';
import { DRAFT_CARD_CENTERS, DRAFT_CARD_RADIUS, OVERLAY_PANEL, REROLL_BUTTON, overlayHasApPrompt, overlayHasDraftCall, overlayStage } from '../shared/overlay';
import { newestScreenReaderState } from './screen-state';
import { useReaderClock } from './clock';
import { capitalise, deriveView, formatEdge } from './view';
import type { CallView, CompanionView, WishView } from './view';
import { ROMAN } from './catalog-index';
import { ItemArt } from './components/Art';

const CATEGORY_NAMES = { weapon: 'Weapon', vitality: 'Vitality', spirit: 'Spirit', unknown: 'Item' } as const;
const MARK_LABELS = { pick: 'Pick', close: 'Lean', consider: 'Consider', reroll: 'If kept' } as const;
const KICKERS = {
  pick: (side: string) => `Take the ${side.toLowerCase()} card`,
  close: (side: string) => `Close call · lean ${side.toLowerCase()}`,
  reroll: () => 'Reroll suggested',
  consider: (side: string) => `Consider the ${side.toLowerCase()} card`,
};
/** Clear of the card circle: the ring sits just outside its coloured rim. */
const RING_RADIUS = DRAFT_CARD_RADIUS + 10;

/** Why there is no leveling plan, and what the player can do about it. */
function noPlanLine(view: CompanionView, heroKnown: boolean): string {
  const ranks = view.me.abilities.map((ability) => ability.rank);
  if (!heroKnown) return 'No leveling plan yet. It appears once your hero and ability ranks are read.';
  if (!view.me.ranksKnown) return 'Hold Tab for a moment so your ability ranks can be read.';
  if (ranks.some((rank) => rank === null)) return 'Hold Tab with the cursor off the panel so every ability can be read.';
  if (ranks.length && ranks.every((rank) => rank === 3)) return 'Every ability is fully upgraded.';
  return 'No leveling plan yet. It appears once your hero and ability ranks are read.';
}

/** Ring around the recommended card (or the Reroll button), drawn in game design pixels. */
export function DraftMarks({ call }: { call: CallView }) {
  const center = DRAFT_CARD_CENTERS[call.position];
  if (!center) return null;
  const reroll = call.kind === 'reroll';
  return <>
    <div className={`ov-ring ${reroll ? 'ov-ring-soft' : ''}`} style={{ left: center.x - RING_RADIUS, top: center.y - RING_RADIUS, width: RING_RADIUS * 2, height: RING_RADIUS * 2 }} />
    <span className={`ov-chip ${reroll ? 'ov-chip-soft' : ''}`} style={{ left: center.x, top: center.y + RING_RADIUS + 8 }}>{MARK_LABELS[call.kind]}</span>
    {reroll && <>
      <div className="ov-ring ov-ring-button" style={{ left: REROLL_BUTTON.x - 8, top: REROLL_BUTTON.y - 8, width: REROLL_BUTTON.width + 16, height: REROLL_BUTTON.height + 16 }} />
      <span className="ov-chip" style={{ left: REROLL_BUTTON.x + REROLL_BUTTON.width / 2, top: REROLL_BUTTON.y + REROLL_BUTTON.height + 50 }}>Reroll</span>
    </>}
  </>;
}

/** "Choice 2/3 · 1 reroll left": what a reroll decision depends on. */
export function draftHeader(match: CompanionView['match']): string | null {
  const parts = [match.choice !== null ? `Choice ${match.choice}/3` : null,
    match.rerollsLeft !== null ? match.rerollsLeft === 0 ? 'No rerolls left' : `${match.rerollsLeft} ${match.rerollsLeft === 1 ? 'reroll' : 'rerolls'} left` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The short version of the companion's pick panel. */
export function CallSummary({ call, hopes = [], header = null }: { call: CallView; hopes?: WishView[]; header?: string | null }) {
  const { item } = call;
  const bonus = call.bonus.items.length ? `Bonus: also gives ${call.bonus.items.map((entry) => entry.item?.name ?? 'an unknown item').join(' and ')}`
    : call.bonus.pending ? 'Bonus: also gives a free lower-tier item' : null;
  return <section className={`ov-card cat-${item.category}`}>
    {header && <p className="ov-meta">{header}</p>}
    <p className="ov-kicker">{KICKERS[call.kind](call.positionLabel)}</p>
    {call.kind === 'reroll' ? <>
      <h1 className="ov-title">Reroll</h1>
      <p className="ov-line">{call.reroll.text.replace(/^\d+ rerolls? left\.\s*/, '')}</p>
      <p className="ov-sub">If you keep these: <strong>{item.name}</strong> ({call.positionLabel.toLowerCase()})</p>
      {hopes.length > 0 && <p className="ov-line ov-reroll">Reroll for {hopes.map((entry) => entry.item?.name ?? entry.id).join(', ')}</p>}
    </> : <>
      <div className="ov-item">
        <ItemArt id={item.id} item={item} size="sm" />
        <div>
          <h1 className="ov-title">{item.name}</h1>
          <p className="ov-sub"><span className={`cat-label cat-${item.category}`}>{CATEGORY_NAMES[item.category]}</span>{item.tier ? ` · Tier ${ROMAN[item.tier]}` : ''}{call.standing ? ` · ${formatEdge(call.standing.edge)} vs tier avg` : call.stat ? ` · ${call.stat.winRate}% wins` : ''}</p>
        </div>
      </div>
      {bonus && <p className="ov-line ov-bonus">{bonus}</p>}
      {call.reasons.slice(0, 2).map((reason, index) => <p key={index} className="ov-line">{reason.text}</p>)}
      {call.imbue && <p className="ov-line"><strong>Imbue on {call.imbue.abilityName}</strong></p>}
      {call.reroll.text && call.reroll.suggested && <p className="ov-line ov-reroll">{call.reroll.text}</p>}
    </>}
  </section>;
}

/** Opened with the hotkey: what to level next and what the reader currently sees. */
export function InfoPanel({ view, hotkey }: { view: CompanionView; hotkey: string | null }) {
  const { plan, hero, points, affordableSteps } = view.me;
  // The next few upgrades with their tiers, e.g. "Smoke Bomb II, Fixation II".
  const upcoming = view.me.upcoming.map((step) => `${step.name} ${ROMAN[step.tier]}`);
  const toughest = view.insights?.toughest;
  return <section className="ov-card ov-info">
    <p className="ov-kicker">{hero ? hero.name : 'Street Brawl companion'} · {view.status.label}{points !== null ? ` · ${points} AP` : ''}</p>
    {plan ? <>
      <h1 className="ov-title">Level {plan.ability}</h1>
      <p className="ov-sub">To tier {ROMAN[plan.tier] ?? plan.tier}{plan.cost !== null ? ` · ${plan.cost} AP` : ''}{affordableSteps > 0 ? ' · buy now' : ''}</p>
      {plan.reason && <p className="ov-line">{capitalise(plan.reason)}.</p>}
      {upcoming.length > 0 && <p className="ov-line">Then: {upcoming.join(', ')}</p>}
    </> : <p className="ov-line">{noPlanLine(view, !!hero)}</p>}
    {toughest?.hero && <p className="ov-line ov-muted">Toughest enemy: {toughest.hero.name} ({Math.round(toughest.winRate * 100)}% for you)</p>}
    {!view.call && view.notice?.kind === 'between' && view.teams.threat ? <p className="ov-line">Enemy threat: {view.teams.threat.priority}</p>
      : !view.call && view.notice && <p className="ov-line ov-muted">{view.notice.title}</p>}
    <p className="ov-hint">{hotkey ? `${hotkey} hides this panel` : 'The overlay key is taken by another program.'}</p>
  </section>;
}

/** Shown on its own while unspent points buy the next planned upgrade during a draft: no hotkey needed. */
export function ApPrompt({ view }: { view: CompanionView }) {
  const step = view.me.step;
  if (!step?.spend) return null;
  return <section className="ov-card ov-ap">
    <p className="ov-kicker">Ability points</p>
    <h1 className="ov-title ov-ap-title">{step.title}</h1>
    {step.detail && <p className="ov-line ov-muted">{step.detail}</p>}
  </section>;
}

export function Overlay({ bridge }: { bridge: CompanionBridge }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [reader, setReader] = useState<ScreenReaderState | null>(null);
  const [status, setStatus] = useState<OverlayStatus>({ panel: false, hotkey: null });
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    let mounted = true;
    const unsubscribeReader = bridge.subscribeScreenReader((next) => { if (mounted) setReader((current) => newestScreenReaderState(current, next)); });
    const unsubscribeOverlay = bridge.subscribeOverlay?.((next) => { if (mounted) setStatus(next); }) ?? (() => {});
    void bridge.getScreenReaderState().then((next) => { if (mounted) setReader((current) => newestScreenReaderState(current, next)); }).catch(() => {});
    void bridge.getCatalog().then((next) => { if (mounted) setCatalog(next); }).catch(() => {});
    void bridge.getOverlayStatus?.().then((next) => { if (mounted) setStatus(next); }).catch(() => {});
    const resize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => { mounted = false; unsubscribeReader(); unsubscribeOverlay(); window.removeEventListener('resize', resize); };
  }, [bridge]);

  const clock = useReaderClock(reader, 0, true);
  const view = useMemo(() => catalog ? deriveView(reader, catalog, clock) : null, [reader, catalog, clock.now, clock.readingSince, clock.lastProgressAt]);
  if (!view) return null;
  const call = overlayHasDraftCall(reader, clock.now) ? view.call : null;
  // The info panel already leads with the plan, so the spend prompt stands in only while it is closed.
  const spend = !status.panel && overlayHasApPrompt(reader, clock.now) && !!view.me.step?.spend;
  const stage = overlayStage(size.width, size.height);
  return <div className="ov-stage" aria-hidden="true" style={{ transform: `translate(${stage.left}px, ${stage.top}px) scale(${stage.scale})` }}>
    {call && <DraftMarks call={call} />}
    {(call || status.panel || spend) && <div className="ov-panel" style={{ left: OVERLAY_PANEL.x, top: OVERLAY_PANEL.y, width: OVERLAY_PANEL.width }}>
      {call && <CallSummary call={call} hopes={call.kind === 'reroll' ? view.insights?.hopes : undefined} header={draftHeader(view.match)} />}
      {spend && <ApPrompt view={view} />}
      {status.panel && <InfoPanel view={view} hotkey={status.hotkey} />}
    </div>}
  </div>;
}
