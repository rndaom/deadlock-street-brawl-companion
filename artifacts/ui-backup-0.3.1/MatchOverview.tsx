import { ChevronDown, CircleHelp, Crosshair, Eye, ShieldCheck, Sparkles, Users } from 'lucide-react';
import type { Catalog, CatalogHero, CatalogItem } from '../shared/types';
import type {
  ScreenAbilityAdvice, ScreenAbilityState, ScreenCompleteness, ScreenContextObservation,
  ScreenInventoryItem, ScreenMatchContext, ScreenObservedPlayer,
} from '../shared/screen-reading';
import { SCREEN_CAPTURE_FRESHNESS_MS, SCREEN_CONTEXT_MAX_AGE_MS } from '../shared/screen-reading';
import { isScreenObservationUsable } from '../screen/match-state';
import abilityLabels from './ability-labels.json';

const abilityNames = new Map(abilityLabels.abilities.map((ability) => [`${ability.heroId}:${ability.slot}`, ability]));

export function participantIdentityCurrent(context: ScreenMatchContext | null, now: number) {
  const proof = context?.observations.viewMode;
  return !!context && context.viewMode === 'participant' && !!proof && context.sessionId !== null
    && !context.retiredSessionIds.includes(context.sessionId)
    && (context.gameSessionId === null || !context.retiredGameSessionIds.includes(context.gameSessionId))
    && proof.receivedAt <= now && proof.confidence <= 1
    && isScreenObservationUsable(proof, context, now, SCREEN_CONTEXT_MAX_AGE_MS);
}

function matchFactCurrent(observation: ScreenContextObservation | null | undefined, context: ScreenMatchContext | null, now: number) {
  return !!context && !!observation && context.sessionId !== null && observation.sessionId === context.sessionId
    && !context.retiredSessionIds.includes(context.sessionId)
    && (context.gameSessionId === null || !context.retiredGameSessionIds.includes(context.gameSessionId))
    && observation.invalidatedAt == null && observation.confidence >= .85 && observation.confidence <= 1
    && Number.isFinite(observation.capturedAt) && Number.isFinite(observation.receivedAt)
    && observation.receivedAt >= observation.capturedAt && observation.receivedAt <= now
    && observation.capturedAt <= now && now - observation.capturedAt <= SCREEN_CONTEXT_MAX_AGE_MS;
}

export function matchPhaseCurrent(context: ScreenMatchContext | null, now: number) {
  return !!context && context.phase !== 'unknown' && matchFactCurrent(context.observations.phase, context, now);
}

function abilityName(catalog: Catalog, heroId: string | null | undefined, slot: number, abilityId: string | null | undefined) {
  if (catalog.clientVersion !== abilityLabels.clientVersion || catalog.revision !== abilityLabels.revision || heroId == null) return null;
  const hero = resolveHero(catalog, heroId);
  const ability = hero ? abilityNames.get(`${hero.id}:${slot}`) : undefined;
  return ability && (abilityId == null || ability.id === abilityId || ability.numericId === abilityId) ? ability.name : null;
}

export interface MatchOverviewProps {
  context: ScreenMatchContext | null;
  catalog: Catalog;
  now?: number;
  useLocalAssets?: boolean;
  abilityAdvice?: ScreenAbilityAdvice | null;
}

export function observationAge(capturedAt: number | null | undefined, now: number) {
  if (capturedAt == null || !Number.isFinite(capturedAt) || capturedAt > now) return 'Age unknown';
  const age = Math.max(0, now - capturedAt);
  if (age < 5_000) return 'Just read';
  if (age < 60_000) return `${Math.floor(age / 1_000)}s ago`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  return `${Math.floor(age / 3_600_000)}h ago`;
}

function fresh(observation: ScreenContextObservation | null | undefined, context: ScreenMatchContext | null, now: number, maximumAge = SCREEN_CONTEXT_MAX_AGE_MS) {
  return !!context && !!observation && observation.receivedAt <= now && observation.confidence <= 1
    && isScreenObservationUsable(observation, context, now, maximumAge) && now - observation.capturedAt < maximumAge;
}

function resolveHero(catalog: Catalog, id: string | null | undefined) {
  return id == null ? undefined : catalog.heroes.find((hero) => hero.id === id || hero.numericId === id);
}

function resolveItem(catalog: Catalog, id: string | null) {
  return id === null ? undefined : catalog.items.find((item) => item.id === id || item.numericId === id);
}

function shortName(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function Coverage({ completeness, observation, now }: { completeness: ScreenCompleteness; observation: ScreenContextObservation | null; now: number }) {
  return <span className={`match-coverage match-coverage-${completeness}`}>
    <span>{completeness === 'complete' ? 'Complete view at last read' : completeness === 'partial' ? 'Partial view' : 'Not read'}</span>
    <span>{observationAge(observation?.capturedAt, now)}</span>
  </span>;
}

function HeroPortrait({ hero, large = false, useLocalAssets }: { hero: CatalogHero | undefined; large?: boolean; useLocalAssets: boolean }) {
  return <span className={`match-hero-portrait ${large ? 'match-hero-large' : ''}`} aria-hidden="true">
    <span>{hero ? shortName(hero.name) : '?'}</span>
    {hero && useLocalAssets && <img src={`companion://app/context-icons/heroes/${encodeURIComponent(hero.id)}--${large ? 'card' : 'small'}.png`} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
  </span>;
}

function ItemPortrait({ item, useLocalAssets }: { item: CatalogItem | undefined; useLocalAssets: boolean }) {
  const category = item?.category ?? 'unknown';
  const Icon = category === 'weapon' ? Crosshair : category === 'vitality' ? ShieldCheck : category === 'spirit' ? Sparkles : CircleHelp;
  return <span className={`match-item-image ${category}`} aria-hidden="true">
    <Icon size={13} />
    {item && useLocalAssets && <img src={`companion://app/item-icons/${encodeURIComponent(item.id)}.png`} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
  </span>;
}

function ObservedInventory({ items, completeness, catalog, now, useLocalAssets, preview = false, iconsOnly = false }: {
  items: ScreenInventoryItem[]; completeness: ScreenCompleteness; catalog: Catalog; now: number;
  useLocalAssets: boolean; preview?: boolean; iconsOnly?: boolean;
}) {
  if (items.length === 0) return <span className="match-unread">{completeness === 'complete' ? 'No items in the last complete view' : 'Items not read'}</span>;
  const sorted = items.slice().sort((a, b) => a.slot - b.slot);
  if (iconsOnly) return <span className="match-items-icon-grid">{sorted.map((entry) => {
    const item = resolveItem(catalog, entry.itemId);
    const name = item?.name ?? 'Item not identified';
    const details = `${name} · ${entry.variant === 'unknown' ? 'Variant unread' : entry.variant}${entry.bonusIds === null ? ' · Bonuses unread' : entry.bonusIds.length ? ` · ${entry.bonusIds.map((id) => resolveItem(catalog, id)?.name ?? 'Bonus not identified').join(', ')}` : ''} · ${observationAge(entry.observation.capturedAt, now)}`;
    return <span className={`match-item-icon ${!item ? 'match-item-icon-unread' : ''}`} key={entry.slot} data-item-slot={entry.slot} role="img" tabIndex={0} aria-label={details} title={details}><ItemPortrait item={item} useLocalAssets={useLocalAssets} />{entry.quantity != null && entry.quantity > 1 && <span className="match-icon-quantity" aria-hidden="true">{entry.quantity}</span>}<span className="match-item-tooltip" aria-hidden="true">{name}</span></span>;
  })}</span>;
  const visible = preview ? sorted.slice(0, 2) : sorted;
  return <span className={`match-items ${preview ? 'match-items-preview' : ''}`}>{visible.map((entry) => {
    const item = resolveItem(catalog, entry.itemId);
    const name = item?.name ?? 'Item not identified';
    const specialVariant = entry.variant !== 'base' && entry.variant !== 'unknown';
    const qualifier = entry.variant === 'unknown' ? 'variant not read' : `${entry.variant} variant`;
    const bonusNames = entry.bonusIds?.map((id) => resolveItem(catalog, id)?.name ?? 'Bonus not identified');
    const bonusDetails = entry.bonusIds === null ? ', bonus details not read' : bonusNames?.length ? `, bonuses ${bonusNames.join(', ')}` : ', no bonus items read';
    const age = observationAge(entry.observation.capturedAt, now);
    return <span className={`match-item ${!item ? 'match-item-unread' : ''}`} key={entry.slot} data-item-slot={entry.slot} aria-label={`${name}, ${qualifier}${bonusDetails}, ${age}`} title={`${name} · ${qualifier}${bonusDetails} · ${age}`}>
      <ItemPortrait item={item} useLocalAssets={useLocalAssets} />
      <span className="match-item-label">{name}{!preview && <small>{age}</small>}</span>
      {entry.quantity != null && entry.quantity > 1 && <span className="match-item-quantity">×{entry.quantity}</span>}
      {specialVariant && <span className="match-item-variant">{entry.variant}</span>}
      {entry.bonusIds?.length ? <span className="match-item-bonus">+{entry.bonusIds.length}</span> : null}
    </span>;
  })}{preview && sorted.length > visible.length && <span className="match-more-items">+{sorted.length - visible.length} observed</span>}</span>;
}

function ObservedAbility({ ability, slot, now, name }: { ability: ScreenAbilityState | undefined; slot: number; now: number; name: string | null }) {
  const rank = ability?.rank ?? null;
  const invalidated = ability?.observation.invalidatedAt != null;
  return <div className={`match-ability ${rank === null ? 'match-ability-unread' : ''} ${invalidated ? 'match-ability-invalidated' : ''}`} data-ability-slot={slot}>
    <span className="match-ability-slot">Ability {slot + 1}</span>
    {name && <span className="match-ability-name" title={name}>{name}</span>}
    <strong>{invalidated ? 'Needs reread' : ability?.unlocked === false ? 'Locked' : rank === null ? 'Rank not read' : `Rank ${rank}`}</strong>
    {invalidated && rank !== null && <span className="match-ability-locked-rank">Last observed rank {rank}</span>}
    {!invalidated && ability?.unlocked === false && rank !== null && <span className="match-ability-locked-rank">Observed rank {rank}</span>}
    {ability?.unlocked === null && rank !== null && <span className="match-ability-locked-rank">Unlock state not read</span>}
    {!invalidated && ability?.nextUpgradeCost != null && <span className="match-ability-locked-rank">Next tier {ability.nextUpgradeCost} AP</span>}
    <span className="rank-track" aria-hidden="true">{Array.from({ length: 3 }, (_, index) => <i key={index} className={rank !== null && index < rank ? 'filled' : ''} />)}</span>
    <span className="match-ability-age">{observationAge(ability?.observation.capturedAt, now)}</span>
  </div>;
}

function AbilityUpgrade({ context, advice, now }: { context: ScreenMatchContext | null; advice: ScreenAbilityAdvice | null; now: number }) {
  const participant = participantIdentityCurrent(context, now);
  const ranksFresh = fresh(context?.abilityObservation, context, now);
  const budgetFresh = fresh(context?.observations.localAbilityPoints, context, now, SCREEN_CAPTURE_FRESHNESS_MS);
  const selectedRank = context?.localAbilities.find((ability) => ability.slot === advice?.slot)?.observation;
  const selectedRankFresh = fresh(selectedRank, context, now, SCREEN_CAPTURE_FRESHNESS_MS);
  const selectedPlanFresh = fresh(selectedRank, context, now);
  const adviceCurrent = participant && (advice?.kind === 'withheld' || (ranksFresh
    && (advice?.kind === 'upgrade' ? budgetFresh && selectedRankFresh : advice?.kind === 'plan' ? selectedPlanFresh : false)));
  const current = adviceCurrent ? advice : null;
  const title = current?.title ?? (!participant ? 'Own player identity is not confirmed' : !ranksFresh ? 'Fresh ability ranks are needed' : 'Next tier is not confirmed');
  return <section className={`match-next-upgrade ${current && current.kind !== 'withheld' ? 'match-next-upgrade-ready' : ''}`} aria-labelledby="match-next-upgrade-heading">
    <div className="match-upgrade-heading"><h3 id="match-next-upgrade-heading"><Sparkles size={13} aria-hidden="true" />Next ability upgrade</h3><span>{current?.kind === 'upgrade' ? 'Suggested next tier' : current?.kind === 'plan' ? 'Conditional priority' : 'Not confirmed'}</span></div>
    <strong>{title}</strong>
    {current?.reasons.length ? <ul>{current.reasons.slice(0, 2).map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p>{!participant ? 'Spectating and unidentified HUDs cannot establish your own investment or upgrade budget.' : 'Show your ability upgrade view in Deadlock. Guidance uses readable ranks and confirmed next-tier effects.'}</p>}
    <div className="match-upgrade-budget"><span>Observed AP <strong>{context?.localAbilityPoints ?? 'Not read'}</strong><small>{observationAge(context?.observations.localAbilityPoints?.capturedAt, now)}</small></span><span>Next-tier cost <strong>{current?.cost != null ? `${current.cost} AP` : 'Not confirmed'}</strong></span></div>
    {current?.limitations.length ? <p className="match-upgrade-limit"><CircleHelp size={12} aria-hidden="true" />{current.limitations.join(' ')}</p> : null}
  </section>;
}

function RosterRow({ player, localSeat, participant, slot, catalog, now, useLocalAssets }: {
  player: ScreenObservedPlayer | undefined; localSeat: number | null; participant: boolean; slot: number;
  catalog: Catalog; now: number; useLocalAssets: boolean;
}) {
  const hero = resolveHero(catalog, player?.heroId);
  const local = participant && !!player && (player.isLocal === true || (localSeat !== null && player.seat === localSeat));
  if (!player) return <div className="match-roster-empty" data-unobserved-player="true"><HeroPortrait hero={undefined} useLocalAssets={false} /><div><span>Hero not read</span><small>Player {slot + 1} · not observed</small></div></div>;
  return <details className={`match-roster-player ${local ? 'match-roster-local' : ''}`} data-observed-seat={player.seat}>
    <summary><HeroPortrait hero={hero} useLocalAssets={useLocalAssets} /><span className="match-roster-content">
      <span className="match-roster-name">{hero?.name ?? 'Hero not identified'}{local && <span className="you-tag">You</span>}</span>
      <ObservedInventory items={player.inventory} completeness={player.inventoryCompleteness} catalog={catalog} now={now} useLocalAssets={useLocalAssets} preview />
      <span className="match-roster-age">{player.inventoryCompleteness === 'complete' ? 'Complete view at last read' : player.inventoryCompleteness === 'partial' ? 'Partial items' : 'Items not read'} · {observationAge(player.inventoryObservation?.capturedAt, now)}</span>
    </span><ChevronDown size={12} className="match-roster-chevron" aria-hidden="true" /></summary>
    <div className="match-roster-full"><ObservedInventory items={player.inventory} completeness={player.inventoryCompleteness} catalog={catalog} now={now} useLocalAssets={useLocalAssets} /><Coverage completeness={player.inventoryCompleteness} observation={player.inventoryObservation} now={now} /><p className="match-item-limits">Variants and bonuses are shown only where identified. Hero: {observationAge(player.heroObservation?.capturedAt, now)}.</p></div>
  </details>;
}

function EnemyRow({ player, slot, catalog, now, useLocalAssets }: { player: ScreenObservedPlayer | undefined; slot: number; catalog: Catalog; now: number; useLocalAssets: boolean }) {
  const hero = resolveHero(catalog, player?.heroId);
  return <div className={`match-enemy-player ${!player ? 'match-enemy-player-unread' : ''}`} data-observed-seat={player?.seat} data-unobserved-player={!player ? 'true' : undefined}>
    <HeroPortrait hero={hero} useLocalAssets={useLocalAssets} />
    <div className="match-enemy-identity"><strong>{hero?.name ?? 'Hero not read'}</strong><small>{!player ? `Player ${slot + 1} not observed` : `${player.inventoryCompleteness === 'complete' ? 'Last complete view' : player.inventoryCompleteness === 'partial' ? 'Partial items' : 'Items not read'} · ${observationAge(player.inventoryObservation?.capturedAt, now)}`}</small></div>
    <ObservedInventory items={player?.inventory ?? []} completeness={player?.inventoryCompleteness ?? 'unknown'} catalog={catalog} now={now} useLocalAssets={useLocalAssets} iconsOnly />
  </div>;
}

export function MatchContextSummary({ context, now = Date.now() }: Pick<MatchOverviewProps, 'context' | 'now'>) {
  const phase = context?.phase ?? 'unknown';
  const scores = context?.scores;
  const sideKnown = participantIdentityCurrent(context, now) && context?.localTeam != null;
  const ownSide = sideKnown ? context!.localTeam! : 0;
  const otherSide = ownSide === 0 ? 1 : 0;
  const leftLabel = sideKnown ? 'Your team' : 'Left side';
  const rightLabel = sideKnown ? 'Enemy team' : 'Right side';
  const phaseCurrent = matchPhaseCurrent(context, now);
  const roundHistorical = context?.round != null && (!phaseCurrent || !matchFactCurrent(context.observations.round, context, now));
  const scoreHistorical = scores != null && (!phaseCurrent || !matchFactCurrent(context!.observations.scores, context, now));
  const phaseLabel = phaseCurrent ? phase === 'combat' ? 'Round in progress' : phase === 'draft' ? 'Item choices observed' : 'Match complete'
    : context?.observations.phase != null ? 'Last seen match' : 'Waiting for match reading';
  return <section className="live-match-summary" aria-label="Observed match score and round">
    <div className="live-match-round"><span>{roundHistorical ? 'Last seen round' : 'Observed round'}</span><strong>{context?.round ?? '—'}</strong><small>{observationAge(context?.observations.round?.capturedAt, now)}</small></div>
    <div className="live-match-score" aria-label={scores ? `${leftLabel} ${scores[ownSide]}, ${rightLabel.toLowerCase()} ${scores[otherSide]}` : 'Score not read'}><span><small>{leftLabel}</small><strong>{scores?.[ownSide] ?? '—'}</strong></span><span className="live-match-colon" aria-hidden="true">:</span><span><small>{rightLabel}</small><strong>{scores?.[otherSide] ?? '—'}</strong></span></div>
    <div className="live-match-phase"><span>{phaseLabel}</span>{scoreHistorical && <small className="live-match-history">Last seen score</small>}<small>Score: {observationAge(context?.observations.scores?.capturedAt, now)}</small><small>Phase: {observationAge(context?.observations.phase?.capturedAt, now)}</small></div>
  </section>;
}

export function MatchOverview({ context, catalog, now = Date.now(), useLocalAssets = false, abilityAdvice = null }: MatchOverviewProps) {
  const players = context?.players ?? [];
  const participant = participantIdentityCurrent(context, now);
  const localPlayer = players.find((player) => context?.localSeat != null && player.seat === context.localSeat) ?? players.find((player) => player.isLocal === true);
  const localHero = resolveHero(catalog, context?.localHeroId ?? localPlayer?.heroId);
  const hudInventoryKnown = !!context && (context.localInventoryObservation !== null || context.localInventory.length > 0 || context.localInventoryCompleteness !== 'unknown');
  const rosterInventoryNewer = !!localPlayer?.inventoryObservation && (!context?.localInventoryObservation || localPlayer.inventoryObservation.capturedAt > context.localInventoryObservation.capturedAt);
  const useRosterInventory = !!localPlayer && (!hudInventoryKnown || rosterInventoryNewer);
  const inventory = useRosterInventory ? localPlayer.inventory : context?.localInventory ?? [];
  const inventoryCompleteness = useRosterInventory ? localPlayer.inventoryCompleteness : context?.localInventoryCompleteness ?? 'unknown';
  const inventoryObservation = useRosterInventory ? localPlayer.inventoryObservation : context?.localInventoryObservation ?? null;
  const abilities = context?.localAbilities ?? [];
  const teams = [0, 1].map((team) => players.filter((player) => player.team === team).sort((a, b) => a.seat - b.seat));
  const unassigned = players.filter((player) => player.team === null).sort((a, b) => a.seat - b.seat);
  const localSeat = context?.localSeat ?? localPlayer?.seat ?? null;
  const ownSide = participant && context?.localTeam != null ? context.localTeam : 0;
  const enemySide = ownSide === 0 ? 1 : 0;
  const enemies = teams[enemySide];
  const allies = teams[ownSide];

  return <div className="live-match-overview">
    <section className="match-enemies" aria-label={participant && context?.localTeam != null ? 'Observed enemy heroes and items' : 'Observed right-side heroes and items'}><div className="match-enemies-heading"><h2><Users size={13} aria-hidden="true" />{participant && context?.localTeam != null ? 'Enemy team' : 'Right side'}</h2><span>{enemies.filter((player) => resolveHero(catalog, player.heroId)).length}/4 heroes read</span></div>{Array.from({ length: Math.max(4, enemies.length) }, (_, slot) => <EnemyRow key={enemies[slot]?.seat ?? `unread-${slot}`} player={enemies[slot]} slot={slot} catalog={catalog} now={now} useLocalAssets={useLocalAssets} />)}<p className="match-tab-hint">Press <kbd>Tab</kbd> in Deadlock to refresh visible builds.</p></section>
    <details className="detail-panel match-build-details"><summary><span><Eye size={14} />{participant && context?.localTeam != null ? 'Your build & allies' : 'Build details'}</span><span className="detail-summary-status">Details<ChevronDown size={14} /></span></summary><div className="detail-content">
    <section className="match-own-build panel" data-own-build="true" aria-labelledby="match-own-heading">
      <div className="match-own-header"><HeroPortrait hero={localHero} large useLocalAssets={useLocalAssets} /><div><span className="eyebrow">{participant ? 'Your observed build' : 'Last observed build · identity unconfirmed'}</span><h2 id="match-own-heading">{localHero?.name ?? (participant ? 'Your hero is not read yet' : 'Hero not read')}</h2><span className="match-local-seat">{localSeat === null ? 'Local roster position not read' : `${participant ? 'Local' : 'Observed'} roster position ${localSeat + 1}`} · Hero {observationAge((context?.observations.localHeroId ?? localPlayer?.heroObservation)?.capturedAt, now)}</span></div><span className="match-snapshot-label">Observed view</span></div>
      {!participant && <p className="match-identity-note">{context?.viewMode === 'spectator' ? 'Spectating is visible. This retained view does not identify the spectated player as you.' : 'Your player identity has not been confirmed from the visible game.'}</p>}
      <ObservedInventory items={inventory} completeness={inventoryCompleteness} catalog={catalog} now={now} useLocalAssets={useLocalAssets} />
      <Coverage completeness={inventoryCompleteness} observation={inventoryObservation} now={now} />
      <div className="match-abilities-heading"><h3>{participant ? 'Your ability investment' : 'Observed ability investment'}</h3><span>{context?.abilityCompleteness === 'complete' ? 'Complete view at last read' : context?.abilityCompleteness === 'partial' ? 'Partial view' : 'Not read'}</span></div>
      <div className="match-abilities">{[0, 1, 2, 3].map((slot) => { const ability = abilities.find((entry) => entry.slot === slot); return <ObservedAbility key={slot} slot={slot} ability={ability} now={now} name={abilityName(catalog, localHero?.id, slot, ability?.abilityId)} />; })}</div>
      <AbilityUpgrade context={context} advice={abilityAdvice} now={now} />
    </section>
    <section className="match-teams match-allies" aria-label={participant && context?.localTeam != null ? 'Observed allied heroes and items' : 'Observed left-side heroes and items'}><div className="match-team"><div className="match-team-heading"><h2><Users size={12} aria-hidden="true" />{participant && context?.localTeam != null ? 'Your team' : 'Left side'}</h2><span>{allies.filter((player) => resolveHero(catalog, player.heroId)).length}/4 heroes read</span></div>{Array.from({ length: Math.max(4, allies.length) }, (_, slot) => <RosterRow key={allies[slot]?.seat ?? `unread-${slot}`} player={allies[slot]} localSeat={localSeat} participant={participant} slot={slot} catalog={catalog} now={now} useLocalAssets={useLocalAssets} />)}</div></section>
    {unassigned.length > 0 && <details className="detail-panel match-unassigned"><summary><span><CircleHelp size={14} />Team not identified</span><span className="detail-summary-status">{unassigned.length} observed players<ChevronDown size={14} /></span></summary><div className="detail-content">{unassigned.map((player, slot) => <RosterRow key={player.seat} player={player} localSeat={localSeat} participant={participant} slot={slot} catalog={catalog} now={now} useLocalAssets={useLocalAssets} />)}</div></details>}
    <p className="match-observation-note">{context?.rosterCompleteness === 'complete' ? 'Roster complete at its last reading.' : context?.rosterCompleteness === 'partial' ? 'Roster partly read; missing players remain unknown.' : 'Roster not read yet.'} {observationAge(context?.rosterObservation?.capturedAt, now)}. Item views can change between readings. Open the scoreboard again to refresh them.</p>
    </div></details>
  </div>;
}
