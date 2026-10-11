import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Activity, ArrowRight, Check, ChevronDown, CircleHelp, Crosshair,
  FileDown, FlaskConical, LockKeyhole, Monitor, Plus, Radio, RotateCcw,
  Settings2, ShieldCheck, Sparkles, Swords, Timer, WifiOff,
} from 'lucide-react';
import type {
  AppMode, AppSettings, Catalog, CatalogItem, DemoScenarioId, DisplayInfo,
  DraftOffer, ItemInstance, MatchState, PlayerState,
} from '../shared/types';
import { getDecisionKey, sameDecisionKey } from '../core/store';
import type { CaptureRegion, ScreenReaderState } from '../shared/screen-reading';
import { ScreenReading } from './ScreenReading';

export interface CompanionProps {
  state: MatchState;
  catalog: Catalog;
  settings: AppSettings;
  displays: DisplayInfo[];
  onModeChange: (mode: AppMode) => void;
  onScenario: (id: DemoScenarioId) => void;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  onExportDiagnostics: () => void;
  screenReader?: ScreenReaderState | null;
  onScreenEnabled?: (enabled: boolean) => void;
  onScreenCrop?: (crop: CaptureRegion) => void;
  onScreenRetry?: () => void;
  onScreenPreview?: () => void;
}

const scenarios: { id: DemoScenarioId; label: string }[] = [
  { id: 'draft', label: 'Current draft' },
  { id: 'rerolled', label: 'Offers after reroll' },
  { id: 'combat', label: 'Round in progress' },
  { id: 'interrupted', label: 'Connection interrupted' },
  { id: 'unknown-item', label: 'Unrecognized item' },
  { id: 'unknown-ranks', label: 'Ability ranks unavailable' },
  { id: 'post-match', label: 'Match complete' },
  { id: 'waiting', label: 'Waiting for a match' },
];

const capabilityLabels: Record<string, string> = {
  participant_match: 'Your match & local player',
  street_brawl_round: 'Round, score & phase',
  own_draft_offers: 'Your current draft offers',
  offer_modifiers: 'Complete offer bundles & variants',
  own_reroll_state: 'Actual reroll availability',
  current_inventories: 'Current owned inventories',
  purchased_items: 'Purchased-item history',
  ability_investment: 'Exact ability investment',
  corruption_decision: 'Corruption decisions',
  source_continuity: 'Continuity & delivery timing',
};

function initials(name: string) {
  return name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
}

function heroName(player: PlayerState | undefined | null, catalog: Catalog) {
  if (!player) return 'Hero not observed';
  return catalog.heroes.find((hero) => hero.id === player.heroId)?.name ?? player.heroName ?? 'Hero not observed';
}

function formatReceived(at: number | null) {
  if (at === null) return 'No event received';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(at);
}

function variantLabel(item: ItemInstance) {
  const labels = { base: 'Base', enhanced: 'Enhanced', legendary: 'Legendary', corrupted: 'Corrupted', unknown: 'Variant unknown' };
  return labels[item.variant];
}

function sourceLabel(state: MatchState) {
  if (state.mode === 'demo') return state.source.status === 'interrupted' ? 'Demo interrupted' : 'Synthetic source';
  if (state.source.status === 'connected') return 'Source connected';
  if (state.source.status === 'connecting') return 'Connecting';
  if (state.source.status === 'interrupted') return 'Connection interrupted';
  return 'Live source unavailable';
}

function phaseLabel(state: MatchState) {
  if (state.source.status === 'interrupted') return 'Connection interrupted';
  if (!state.match) return 'Waiting for match';
  return { draft: 'Item draft', combat: 'In combat', transition: 'Between rounds', finished: 'Match complete', waiting: 'Waiting for draft' }[state.match.phase];
}

function ItemMark({ item, compact = false }: { item: CatalogItem | undefined; compact?: boolean }) {
  const category = item?.category ?? 'unknown';
  const Icon = category === 'weapon' ? Crosshair : category === 'vitality' ? ShieldCheck : category === 'spirit' ? Sparkles : CircleHelp;
  return <span className={`item-mark ${category} ${compact ? 'compact' : ''}`} aria-hidden="true"><Icon size={compact ? 12 : 22} strokeWidth={1.6} /></span>;
}

function OfferCard({ offer, item, catalog, preferred, rank, reasons }: {
  offer: DraftOffer | undefined;
  item: CatalogItem | undefined;
  catalog: Catalog;
  preferred: boolean;
  rank: number | null;
  reasons: string[];
}) {
  const known = offer && item;
  const position = offer?.position;
  return (
    <article className={`offer-card ${preferred ? 'preferred' : ''} ${!offer ? 'offer-empty' : ''}`} aria-label={offer ? `Offer ${(position ?? 0) + 1}: ${item?.name ?? 'Unrecognized item'}${preferred ? ', preferred choice' : ''}` : 'Offer not yet observed'}>
      <div className="offer-topline"><span className="offer-position">{position !== undefined ? String(position + 1).padStart(2, '0') : '—'}</span>{preferred ? <span className="best-fit"><Check size={11} /> Best fit</span> : <span className="offer-kind">{item?.category ?? 'Unobserved'}</span>}</div>
      <ItemMark item={item} />
      <h3>{offer ? item?.name ?? 'Unrecognized item' : 'Awaiting offer'}</h3>
      {offer ? <span className={`variant variant-${offer.item.variant}`}>{variantLabel(offer.item)}</span> : <span className="variant">Not observed</span>}
      <div className="offer-bundle">
        {offer?.item.bonusIds.length ? offer.item.bonusIds.map((id, i) => <span key={`${id}-${i}`}><Plus size={10} aria-hidden="true" />{catalog.items.find((entry) => entry.id === id)?.name ?? 'Unknown bonus'}</span>) : <span className="bundle-empty">{offer ? 'No bonus items reported' : 'Full bundle will appear here'}</span>}
      </div>
      <div className="offer-note">{!offer ? 'Automatic draft data required' : !known || !offer.item.modifiersDecoded ? 'Effects are not fully verified' : !offer.available ? 'No longer available' : reasons[0] ?? (rank ? `Fit rank ${rank} · illustrative model` : 'Awaiting compatible evaluation')}</div>
    </article>
  );
}

function Inventory({ player, catalog, compact = false }: { player: PlayerState; catalog: Catalog; compact?: boolean }) {
  if (player.inventory.length === 0) return <p className="empty-inventory">{player.inventoryCompleteness === 'complete' ? 'No owned items observed' : 'Inventory not observed'}</p>;
  return <div className={`inventory ${compact ? 'inventory-compact' : ''}`}>{player.inventory.map((instance) => {
    const item = catalog.items.find((entry) => entry.id === instance.id);
    return <span className={`inventory-item ${!item ? 'inventory-unknown' : ''}`} key={instance.instanceId} title={`${item?.name ?? 'Unrecognized item'} · ${variantLabel(instance)}`}><ItemMark item={item} compact /><span>{item?.name ?? 'Unrecognized item'}</span>{instance.variant !== 'base' && <span className="inventory-variant">{variantLabel(instance)}</span>}{instance.bonusIds.length > 0 && <span className="inventory-bonus">+{instance.bonusIds.length}</span>}</span>;
  })}</div>;
}

function RosterPlayer({ player, catalog, hideNames, number }: { player: PlayerState | null; catalog: Catalog; hideNames: boolean; number: number }) {
  const name = heroName(player, catalog);
  if (!player) return <div className="roster-player roster-empty"><span className="hero-avatar small" aria-hidden="true">?</span><div><span className="roster-name">Awaiting hero</span><span className="roster-subline">Player {number} · not observed</span></div></div>;
  return <details className={`roster-player ${player.isLocal ? 'roster-local' : ''}`}>
    <summary><span className="hero-avatar small" aria-hidden="true">{initials(name)}</span><span className="roster-info"><span className="roster-name">{name}{player.isLocal && <span className="you-tag">You</span>}</span><span className="roster-subline">{!hideNames && player.playerName ? <>{player.playerName} · </> : null}{player.inventoryCompleteness === 'unknown' ? 'Items unavailable' : `${player.inventory.length} ${player.inventoryCompleteness === 'partial' ? 'known' : 'observed'} items`}</span></span><ChevronDown className="roster-chevron" size={12} aria-hidden="true" /></summary>
    <div className="roster-expanded"><Inventory player={player} catalog={catalog} compact /><p className="completeness-note">{player.inventoryCompleteness === 'complete' ? 'Complete observed inventory' : 'Inventory coverage is incomplete'}</p>{player.purchasedHistory?.length ? <div className="purchase-history"><span>Purchased history · not current ownership</span><p>{player.purchasedHistory.map((entry) => catalog.items.find((item) => item.id === entry.itemId || item.numericId === entry.itemId)?.name ?? entry.name ?? 'Unrecognized item').join(' · ')}</p></div> : null}</div>
  </details>;
}

function AbilityStrip({ player }: { player: PlayerState | undefined }) {
  const abilities = player?.abilities ?? [];
  const entries = Array.from({ length: Math.max(4, abilities.length) }, (_, i) => abilities[i] ?? null);
  return <div className="abilities">{entries.map((ability, i) => {
    const rank = ability?.rank ?? null;
    const label = ability && /[a-z]/i.test(ability.id) && !/^[a-z]+[_:-]?\d+$/i.test(ability.id)
      ? ability.id.replace(/^ability[_:-]/, '').replace(/[_-]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
      : `Ability ${i + 1}`;
    return <div className={`ability ${rank === null ? 'ability-unknown' : ''}`} key={ability?.id ?? i}>
      <span className="ability-label">{label}</span>
      <span className="ability-value">{ability?.unlocked === false ? <><LockKeyhole size={10} /> Locked{rank !== null && ` · rank ${rank}`}</> : rank === null ? 'Rank unavailable' : `Rank ${rank}`}</span>
      <span className="rank-track" aria-hidden="true">{Array.from({ length: 3 }, (_, level) => <i key={level} className={rank !== null && level < rank ? 'filled' : ''} />)}</span>
    </div>;
  })}</div>;
}

export function Companion({ state, catalog, settings, displays, onModeChange, onScenario, onSettingsChange, onExportDiagnostics, screenReader, onScreenEnabled, onScreenCrop, onScreenRetry, onScreenPreview }: CompanionProps) {
  const useScreenReading = state.mode === 'live' && screenReader !== undefined;
  const [now, setNow] = useState(Date.now());
  const [scenario, setScenario] = useState<DemoScenarioId>('draft');
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const sourceRef = useRef<HTMLDetailsElement>(null);
  const phase = state.match?.phase ?? 'waiting';
  const interrupted = state.source.status === 'interrupted';
  const deadline = state.match?.deadlineAt;
  const countdownActive = phase === 'draft' && state.draft !== null
    && state.source.status === 'connected' && state.source.continuity === 'continuous';
  useEffect(() => {
    if (!countdownActive || deadline == null) return;
    setNow(Date.now());
    if (deadline <= Date.now()) return;
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdownActive, deadline]);
  useEffect(() => { if (state.mode === 'demo') setScenario('draft'); }, [state.mode]);

  const localPlayer = state.players.find((player) => player.isLocal) ?? state.players.find((player) => player.seat === state.match?.localSeat);
  const ownTeam = state.match?.localTeam ?? localPlayer?.team ?? null;
  const teamTitles = ownTeam === null ? ['Team A', 'Team B'] : ['Your team', 'Opponents'];
  const scores = state.match?.scores;
  const ownScore = scores?.[ownTeam === 1 ? 1 : 0] ?? '—';
  const enemyScore = scores?.[ownTeam === 1 ? 0 : 1] ?? '—';
  const teams = useMemo(() => {
    const firstTeam = ownTeam ?? 0;
    const own = state.players.filter((player) => player.team === firstTeam).sort((a, b) => a.seat - b.seat);
    const enemy = state.players.filter((player) => player.team !== firstTeam).sort((a, b) => a.seat - b.seat);
    return [Array.from({ length: 4 }, (_, i) => own[i] ?? null), Array.from({ length: 4 }, (_, i) => enemy[i] ?? null)];
  }, [ownTeam, state.players]);
  const seconds = deadline == null ? null : Math.max(0, Math.ceil((deadline - Math.max(now, Date.now())) / 1000));
  const expired = seconds === 0 && phase === 'draft';
  const advice = state.advice;
  const adviceCurrent = sameDecisionKey(advice?.key, getDecisionKey(state, catalog.modelVersion, catalog.revision));
  const preferredOffer = state.draft?.offers.find((offer) => offer.position === advice?.preferredPosition);
  const preferredItem = preferredOffer ? catalog.items.find((item) => item.id === preferredOffer.item.id) : undefined;
  const canRecommend = !interrupted && !expired && phase === 'draft' && advice?.kind === 'pick'
    && state.source.status === 'connected' && adviceCurrent && preferredOffer?.available === true
    && preferredItem !== undefined && (state.mode === 'demo' || catalog.liveModelValidated);
  const orderedOffers = state.draft?.offers.slice().sort((a, b) => a.position - b.position) ?? [];
  const displayOffers = orderedOffers.length > 0 ? orderedOffers : Array.from({ length: 3 }, () => undefined);
  const rankings = advice?.ranked.slice().sort((a, b) => b.score - a.score) ?? [];
  const localHero = heroName(localPlayer, catalog);
  const hero = catalog.heroes.find((entry) => entry.id === localPlayer?.heroId);
  const hasDraft = phase === 'draft' && state.draft !== null;
  const statusTitle = interrupted ? 'Connection interrupted'
    : expired ? 'Waiting for the next offer'
      : phase === 'combat' ? 'Round in progress'
        : phase === 'finished' ? 'Match complete'
          : phase === 'transition' ? 'Preparing for the next round'
            : state.match ? 'Waiting for verified draft data' : 'Waiting for your match';
  const statusDescription = interrupted ? 'Pick advice is cleared. The companion will resume after a verified connection returns.'
    : expired ? 'The observed draft deadline has passed. A new confirmed offer set is needed before advice resumes.'
      : phase === 'combat' ? 'Your observed build and both teams stay in view. New draft advice appears when the next offers arrive.'
        : phase === 'finished' ? 'This is the last observed match summary. New match data will replace it automatically.'
          : phase === 'transition' ? 'The next round and its actual offers will appear when confirmed by the source.'
            : hasDraft ? 'This offer set cannot be evaluated with the available item, timing, or ability information.'
              : 'Automatic current-offer coverage is still unverified. No pick or reroll advice is available.';
  const style = { '--text-scale': Math.min(1.5, Math.max(0.8, settings.textScale)) } as CSSProperties;
  const openPanel = (panel: 'settings' | 'source') => {
    const ref = panel === 'settings' ? settingsRef : sourceRef;
    if (ref.current) {
      ref.current.open = true;
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      ref.current.querySelector('summary')?.focus();
    }
  };

  return (
    <div className={`companion ${state.mode === 'demo' ? 'is-demo' : ''} ${useScreenReading ? 'with-screen-reading' : ''}`} style={style}>
      <a className="skip-link" href={useScreenReading ? '#screen-decision' : '#decision'}>Skip to current decision</a>
      <header className="app-header">
        <div className="brand"><span className="brand-seal" aria-hidden="true"><Crosshair size={27} strokeWidth={1.3} /></span><div><span className="brand-caption">Deadlock companion</span><h1>Street Brawl<span className="brand-period">.</span></h1></div></div>
        <div className="header-controls"><div className="mode-control" role="group" aria-label="Data mode"><button type="button" onClick={() => onModeChange('live')} aria-pressed={state.mode === 'live'}>Live</button><button type="button" onClick={() => onModeChange('demo')} aria-pressed={state.mode === 'demo'}><FlaskConical size={12} aria-hidden="true" /> Demo</button></div><button type="button" className="icon-button settings-button" title="Display settings" aria-label="Open display settings" onClick={() => openPanel('settings')}><Settings2 size={18} /></button></div>
      </header>

      {state.mode === 'demo' && <div className="demo-strip"><span><FlaskConical size={13} aria-hidden="true" /><strong>DEMO</strong> Synthetic match · illustrative advice</span><div className="demo-tools"><label className="scenario-picker"><span className="visually-hidden">Demo scenario</span><select value={scenario} onChange={(event) => { const next = event.target.value as DemoScenarioId; setScenario(next); onScenario(next); }}>{scenarios.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select><ChevronDown size={11} aria-hidden="true" /></label><button className="demo-replay" type="button" title="Restart demo scenario" aria-label="Restart demo scenario" onClick={() => onScenario(scenario)}><RotateCcw size={12} /></button></div></div>}

      <main>
        {useScreenReading && <ScreenReading screenReader={screenReader} catalog={catalog} onScreenEnabled={onScreenEnabled ?? (() => undefined)} onScreenCrop={onScreenCrop ?? (() => undefined)} onScreenRetry={onScreenRetry ?? (() => undefined)} onScreenPreview={onScreenPreview} onExportDiagnostics={onExportDiagnostics} />}
        <section className="match-overview" aria-label="Current match status">
          <div className="overview-top"><span className="phase-label"><span className={`status-dot ${state.source.status}`} />{phaseLabel(state)}</span><button className="source-link" type="button" onClick={() => openPanel('source')}>{interrupted ? <WifiOff size={12} /> : <Radio size={12} />}<span>{sourceLabel(state)}</span><ArrowRight size={11} /></button></div>
          <div className="round-score"><div className="round-block"><span className="eyebrow">{phase === 'finished' ? 'Final round' : 'Current round'}</span><span className="round-value">{state.match?.round ?? '—'}<span className="round-total"> / 5</span></span></div><div className="scoreboard" aria-label={scores ? `${teamTitles[0]} ${ownScore}, ${teamTitles[1]} ${enemyScore}` : 'Score not observed'}><span><span className="score-team">{teamTitles[0]}</span><strong>{ownScore}</strong></span><span className="score-separator" aria-hidden="true">:</span><span><span className="score-team">{teamTitles[1]}</span><strong>{enemyScore}</strong></span></div><div className={`draft-clock ${seconds !== null && seconds < 10 ? 'clock-urgent' : ''}`}><span className="eyebrow"><Timer size={11} />{phase === 'draft' ? 'Draft left' : 'Draft timer'}</span><span className="clock-value">{phase === 'draft' && seconds !== null ? `${seconds}s` : '—'}</span><span className="clock-caption">{state.mode === 'demo' && seconds !== null ? 'Demo deadline' : seconds !== null && phase === 'draft' ? 'Observed deadline' : 'Not observed'}</span></div></div>
        </section>

        <section id="decision" tabIndex={-1} className={`decision ${canRecommend && preferredItem ? 'decision-ready' : 'decision-waiting'}`} aria-labelledby="decision-title" aria-live="polite" aria-atomic="true">
          <div className="decision-kicker"><span>{canRecommend ? <><Sparkles size={12} />{state.mode === 'demo' ? 'Illustrative best pick' : 'Suggested pick'}</> : <><Activity size={12} />{phase === 'combat' ? 'Match companion' : 'Advice on hold'}</>}</span><span className="decision-evidence">{state.mode === 'demo' ? 'Synthetic evidence' : 'Live coverage required'}</span></div>
          <div className="decision-content"><div><h2 id="decision-title">{canRecommend && preferredItem ? preferredItem.name : statusTitle}</h2>{canRecommend && preferredItem ? <ul className="decision-reasons">{advice.reasons.slice(0, 2).map((reason, i) => <li key={i}><Check size={13} aria-hidden="true" /><span>{reason}</span></li>)}</ul> : <p className="decision-description">{statusDescription}</p>}</div><span className="decision-emblem" aria-hidden="true">{canRecommend ? <ArrowRight size={32} strokeWidth={1.1} /> : interrupted ? <WifiOff size={28} strokeWidth={1.2} /> : phase === 'combat' ? <Swords size={30} strokeWidth={1.2} /> : <Radio size={30} strokeWidth={1.2} />}</span></div>
          {canRecommend && <div className="decision-qualification"><CircleHelp size={11} />{state.mode === 'demo' ? 'Demonstrates the interface. The scoring model is not validated for live play.' : advice.limitations[0] ?? 'Advice depends on the verified coverage shown in source details.'}</div>}
        </section>

        <section className="draft-section" aria-labelledby="offers-heading">
          <div className="section-heading"><h2 id="offers-heading">{phase === 'combat' || phase === 'finished' ? 'Draft summary' : 'Your current offers'}</h2><span>{state.draft ? `Pick ${state.draft.pickStage} of 3` : 'Awaiting automatic data'}</span></div>
          <div className="offer-grid">{displayOffers.map((offer, i) => { const ranked = rankings.find((entry) => entry.position === offer?.position); return <OfferCard key={offer ? `${state.draft?.id}-${state.draft?.generation}-${offer.position}` : i} offer={offer} item={catalog.items.find((entry) => entry.id === offer?.item.id)} catalog={catalog} preferred={canRecommend && offer?.position === advice.preferredPosition} rank={ranked ? rankings.indexOf(ranked) + 1 : null} reasons={canRecommend ? ranked?.reasons ?? [] : []} />; })}</div>
          <div className="reroll-strip"><span className="reroll-count"><span className="reroll-symbol" aria-hidden="true">↻</span><strong>{state.draft?.rerollsRemaining ?? '—'}</strong> {state.draft?.rerollsRemaining === 1 ? 'reroll' : 'rerolls'} observed</span><span className="reroll-guidance">{canRecommend && advice.reroll.kind !== 'withheld' ? advice.reroll.reason : 'Reroll guidance withheld · draw process unverified'}</span></div>
          {hasDraft && <div className="draft-provenance">Offers remain in game order{state.mode === 'demo' ? ' · synthetic data' : state.source.deliveryBoundMs === null ? ' · source age unknown' : ` · delivery bound ${state.source.deliveryBoundMs} ms`}</div>}
        </section>

        <section className="your-build panel" aria-labelledby="build-heading">
          <div className="build-header"><span className="hero-avatar large" aria-hidden="true">{localPlayer ? initials(localHero) : '?'}</span><div className="build-identity"><span className="eyebrow">Your observed build</span><h2 id="build-heading">{localPlayer ? localHero : 'Your hero will appear here'}</h2><span className="hero-role">{hero?.role ?? (localPlayer ? 'Local player' : 'Automatic local-player detection required')}</span></div><span className="observed-label">{state.mode === 'demo' ? 'Demo data' : localPlayer?.observation ? 'Observed' : 'Unobserved'}</span></div>
          {localPlayer ? <Inventory player={localPlayer} catalog={catalog} /> : <p className="empty-build">Confirmed owned items will appear here. Unobserved items and ranks stay unknown.</p>}
          <div className="ability-heading"><span>Ability investment</span><span>{localPlayer?.abilityCompleteness === 'complete' ? 'Observed ranks' : 'Coverage incomplete'}</span></div>
          <AbilityStrip player={localPlayer} />
          <p className="upgrade-note"><CircleHelp size={11} />Next-upgrade advice requires verified ranks and a validated ability model.</p>
          {localPlayer && localPlayer.inventoryCompleteness !== 'complete' && <p className="completeness-note">Only known items are shown; this is not a complete inventory.</p>}
        </section>

        <section className="rosters" aria-label="Observed match rosters">{teams.map((players, teamIndex) => <div className={`team-panel ${teamIndex === 1 ? 'enemy-team' : ''}`} key={teamIndex}><div className="team-heading"><h2><span className="team-indicator" />{teamTitles[teamIndex]}</h2><span>{players.filter(Boolean).length}/4 observed</span></div>{players.map((player, i) => <RosterPlayer key={player?.seat ?? i} player={player} number={i + 1} catalog={catalog} hideNames={settings.hidePlayerNames} />)}</div>)}</section>

        <div className="details-stack">
          <details ref={sourceRef} className="detail-panel source-details">
            <summary><span><Radio size={15} />Source & evidence</span><span className="detail-summary-status">{state.mode === 'demo' ? 'Synthetic' : 'Coverage unverified'}<ChevronDown size={15} /></span></summary>
            <div className="detail-content">
              <p className="detail-intro">{state.mode === 'demo' ? 'This session uses fabricated match events to review the interface and its failure states. It does not establish automatic telemetry or recommendation quality.' : 'Current own-draft offers and complete ability ranks are not documented in the published Deadlock provider contract. Live recommendations remain gated until supported, timely participant data is verified.'}</p>
              <dl className="source-facts">
                <div><dt>Provider</dt><dd>{state.source.provider}</dd></div>
                <div><dt>Source status</dt><dd>{state.source.status}</dd></div>
                <div><dt>Runtime version</dt><dd>{state.source.runtimeVersion ?? 'Not established'}</dd></div>
                <div><dt>Latest received event</dt><dd>{formatReceived(state.source.lastReceivedAt)}</dd></div>
                <div><dt>Delivery bound</dt><dd>{state.source.deliveryBoundMs === null ? 'Unknown · receipt time is not source age' : `${state.source.deliveryBoundMs} ms`}</dd></div>
                <div><dt>Source continuity</dt><dd>{state.source.continuity === 'unknown' ? 'Unknown · provider continuity is unverified' : state.source.continuity}</dd></div>
                <div><dt>{state.source.sequenceKind === 'local' ? 'Local event ordinal' : 'Source sequence'}</dt><dd>{state.source.sequence ?? 'Unknown'}{state.source.sequenceKind === 'local' ? ' · local receipt order only' : null}</dd></div>
                <div><dt>Game / catalogue build</dt><dd>{state.match?.clientVersion ?? 'Not observed'} / {catalog.clientVersion}</dd></div>
                <div><dt>Model status</dt><dd>{catalog.liveModelValidated ? 'Validated for its documented scope' : 'Live model not validated'}</dd></div>
                <div><dt>Acquisition method</dt><dd>{state.source.noImageMethodVerified ? 'No-image method verified' : 'No-image method not verified with provider'}</dd></div>
              </dl>
              <p className="provider-message">{state.source.message}</p>
              <div className="capability-heading"><h3>Capability coverage</h3><span>Supported ≠ verified</span></div>
              <ul className="capability-list">{state.source.capabilities.map((capability) => <li key={capability.name}><div><strong>{capabilityLabels[capability.name] ?? capability.name}</strong><span className={`capability-status ${capability.supported && capability.verified ? 'verified' : ''}`}>{capability.supported && capability.verified ? 'Verified' : capability.supported ? 'Unverified' : 'Unavailable'}</span></div><p>{capability.detail}</p></li>)}</ul>
              {advice?.limitations.length ? <div className="evidence-limitations"><h3>Decision limitations</h3><ul>{advice.limitations.map((limitation, i) => <li key={i}>{limitation}</li>)}</ul></div> : null}
              <div className="evidence-limitations"><h3>What the evidence establishes</h3><p>Public completed-match statistics provide historical context. They do not identify current offers, prove marginal item value, or validate reroll probabilities. A connected source alone does not establish fresh, complete coverage.</p><div className="research-links"><a href="https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/deadlock/" target="_blank" rel="noreferrer">Provider contract <ArrowRight size={11} /></a><a href="https://api.deadlock-api.com/docs" target="_blank" rel="noreferrer">Public data reference <ArrowRight size={11} /></a></div></div>
              <div className="diagnostic-footer"><span>{state.counters.accepted} accepted · {state.counters.rejected} rejected · {state.counters.invalidated} invalidated</span><button type="button" className="quiet-button" onClick={onExportDiagnostics}><FileDown size={12} />Export safe diagnostics</button></div>
            </div>
          </details>

          <details className="detail-panel changes-details"><summary><span><Activity size={15} />Recent changes</span><span className="detail-summary-status">{state.transitions.length} events<ChevronDown size={15} /></span></summary><div className="detail-content">{state.transitions.length ? <ol className="changes-list">{state.transitions.slice(-6).reverse().map((transition, i) => <li key={`${transition.at}-${i}`}><span>{transition.label}</span><time dateTime={new Date(transition.at).toISOString()}>{formatReceived(transition.at)}</time></li>)}</ol> : <p className="detail-intro">No match transitions observed in this session.</p>}</div></details>

          <details ref={settingsRef} className="detail-panel display-settings"><summary><span><Monitor size={15} />Display settings</span><span className="detail-summary-status">Portrait ready<ChevronDown size={15} /></span></summary><div className="detail-content settings-content"><label className="setting-field"><span>Companion display</span><select value={settings.displayId ?? ''} onChange={(event) => onSettingsChange({ displayId: event.target.value || null })}><option value="">Current display</option>{displays.map((display) => <option key={display.id} value={display.id}>{display.label} · {display.width} × {display.height}{display.primary ? ' · Primary' : ''}</option>)}</select></label><label className="setting-field"><span>Text size <strong>{Math.round(settings.textScale * 100)}%</strong></span><input type="range" min="0.8" max="1.5" step="0.05" value={settings.textScale} onChange={(event) => onSettingsChange({ textScale: Number(event.target.value) })} /></label><label className="checkbox-setting"><input type="checkbox" checked={settings.hidePlayerNames} onChange={(event) => onSettingsChange({ hidePlayerNames: event.target.checked })} /><span>Hide player names<span className="setting-help">Use hero names throughout the roster.</span></span></label><label className="checkbox-setting"><input type="checkbox" checked={settings.alwaysOnTop} onChange={(event) => onSettingsChange({ alwaysOnTop: event.target.checked })} /><span>Keep companion on top<span className="setting-help">Applies to this window. Gameplay stays in Deadlock.</span></span></label></div></details>
        </div>
      </main>

      <footer className="app-footer"><span className="footer-mark"><Crosshair size={13} />Street Brawl companion</span><span>{state.mode === 'demo' ? 'DEMO · No live match data' : useScreenReading ? 'Live screen reading · experimental guidance' : 'Automatic coverage pending verification'}</span></footer>
    </div>
  );
}
