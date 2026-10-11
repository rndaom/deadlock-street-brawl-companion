import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Activity, ArrowRight, Check, ChevronDown, CircleHelp, Crosshair,
  Eye, FileDown, Maximize, Monitor, Pause, Play, RotateCcw, ScanLine,
  ShieldCheck, SlidersHorizontal, Sparkles,
} from 'lucide-react';
import type { Catalog } from '../shared/types';
import type { CaptureRegion, ScreenOffer, ScreenReaderState } from '../shared/screen-reading';
import { DEFAULT_CAPTURE_REGION, SCREEN_CAPTURE_FRESHNESS_MS, SCREEN_CARD_HOLD_MS, SCREEN_CONTEXT_MAX_AGE_MS } from '../shared/screen-reading';
import { MatchContextSummary, MatchOverview, matchPhaseCurrent, observationAge, participantIdentityCurrent } from './MatchOverview';

export interface ScreenReadingProps {
  screenReader: ScreenReaderState | null;
  catalog: Catalog;
  onScreenEnabled: (enabled: boolean) => void;
  onScreenCrop: (crop: CaptureRegion) => void;
  onScreenRetry: () => void;
  onScreenPreview?: () => void;
  onExportDiagnostics?: () => void;
}

const suggestedCrop: CaptureRegion = { ...DEFAULT_CAPTURE_REGION };
const UNCONFIRMED_READING_TIMEOUT_MS = 8_000;
const READ_PROGRESS_TIMEOUT_MS = 8_000;
const cropPresets: { name: string; crop: CaptureRegion }[] = [
  { name: 'Suggested draft area', crop: suggestedCrop },
  { name: 'Wide draft area', crop: { x: 0.02, y: 0.06, width: 0.96, height: 0.86 } },
  { name: 'Whole game window', crop: { x: 0, y: 0, width: 1, height: 1 } },
];

const statusText: Record<ScreenReaderState['status'], { title: string; label: string; description: string }> = {
  starting: { title: 'Preparing screen reading', label: 'Starting', description: 'The local reader is getting ready. Open Deadlock and keep the game in the foreground.' },
  'waiting-game': { title: 'Open Deadlock to begin', label: 'Waiting for game', description: 'The companion follows visible heroes, builds and draft cards in your game window.' },
  'waiting-draft': { title: 'Waiting for item choices', label: 'No current choice', description: 'No current item choice has been read.' },
  reading: { title: 'Checking for draft cards', label: 'Checking the game screen', description: 'A current draft has not been confirmed yet. Checking for a complete, readable set of item cards.' },
  ready: { title: 'Your visible offers', label: 'Offers read', description: 'These item names were read from your game window. Check them against the cards before choosing.' },
  paused: { title: 'Screen reading is paused', label: 'Paused', description: 'Resume reading when you want the companion to follow your visible draft again.' },
  interrupted: { title: 'Screen reading interrupted', label: 'Reading interrupted', description: 'Keep Deadlock in the foreground to read its visible heroes and items.' },
  unavailable: { title: 'Screen reading is unavailable', label: 'Reader unavailable', description: 'The local reader could not start. Its status below will explain what needs attention.' },
};

function expectsGameReads(state: ScreenReaderState | null) {
  return !!state && state.enabled && state.engineReady && state.gamePresent && state.foreground
    && (state.status === 'waiting-draft' || state.status === 'reading' || state.status === 'ready');
}

/** Local receipt timing identifies missing progress, without diagnosing the native reader. */
export function readProgressTimedOut(state: ScreenReaderState | null, lastProgressAt: number | null, now: number) {
  return expectsGameReads(state) && lastProgressAt !== null && Number.isFinite(lastProgressAt)
    && Number.isFinite(now) && now - lastProgressAt >= READ_PROGRESS_TIMEOUT_MS;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function timeLabel(at: number | null) {
  return at === null ? 'Not yet read' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(at);
}

function itemName(catalog: Catalog, itemId: string): string {
  return catalog.items.find((item) => item.id === itemId)?.name ?? itemId.replace(/^upgrade_/, '');
}
function heroName(catalog: Catalog, heroId: string | null): string | null {
  return heroId ? catalog.heroes.find((hero) => hero.id === heroId)?.name ?? null : null;
}

function cardPosition(position: number) { return ['Left', 'Middle', 'Right'][position] ?? 'Unknown'; }

function ScreenOfferCard({ offer, catalog, preferred, provisional, reason, position, useLocalAssets }: {
  offer: ScreenOffer | null;
  catalog: Catalog;
  preferred: boolean;
  provisional: boolean;
  reason: string | undefined;
  position: number;
  useLocalAssets: boolean;
}) {
  const item = catalog.items.find((entry) => entry.id === offer?.itemId || entry.numericId === offer?.itemId);
  const category = item?.category ?? 'unknown';
  const Icon = category === 'weapon' ? Crosshair : category === 'vitality' ? ShieldCheck : category === 'spirit' ? Sparkles : CircleHelp;
  const variant = offer?.variant === 'unknown' ? 'Variant not read' : offer?.variant ? offer.variant[0].toUpperCase() + offer.variant.slice(1) : 'Not read';
  return (
    <article className={`screen-offer ${preferred ? 'screen-offer-preferred' : provisional ? 'screen-offer-comparison' : ''} ${!offer ? 'screen-offer-empty' : ''}`} aria-label={`${cardPosition(position)} card: ${offer?.name ?? 'not read'}${preferred ? ', suggested visible item' : provisional ? ', base item to consider' : ''}, ${variant}, ${offer?.bonusIds == null ? 'Bonus details not confirmed' : offer.bonusIds.length ? `${offer.bonusIds.length} bonus items read` : 'No bonus items read'}`} title={offer?.warning ?? reason}>
      <div className="screen-offer-top"><span>{cardPosition(position)}</span>{preferred ? <span className="screen-fit"><Check size={11} />Pick</span> : provisional ? <span className="screen-fit screen-fit-provisional">Main only</span> : null}</div>
      <span className={`item-mark screen-item-mark ${category}`} aria-hidden="true"><Icon size={23} strokeWidth={1.6} />{item && useLocalAssets && <img src={`companion://app/item-icons/${encodeURIComponent(item.id)}.png`} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}</span>
      <h3>{offer?.name ?? 'Awaiting offer'}</h3>
      {offer && (offer.rare || offer.variant !== 'base' && offer.variant !== 'unknown') && <div className="screen-offer-tags">
        {offer.rare && <span className="variant variant-rare">Rare</span>}
        {offer.variant !== 'base' && offer.variant !== 'unknown' && <span className={`variant variant-${offer.variant}`}>{variant}</span>}
      </div>}
    </article>
  );
}

export function ScreenReading({ screenReader, catalog, onScreenEnabled, onScreenCrop, onScreenRetry, onScreenPreview, onExportDiagnostics }: ScreenReadingProps) {
  const status = screenReader?.status ?? 'starting';
  const copy = statusText[status];
  const enabled = screenReader?.enabled ?? true;
  const automaticallyPaused = status === 'paused' && enabled;
  const crop = screenReader?.crop ?? suggestedCrop;
  const [draftCrop, setDraftCrop] = useState<CaptureRegion>(crop);
  const [cropApplied, setCropApplied] = useState(false);
  const [readingTimedOut, setReadingTimedOut] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [expiredObservation, setExpiredObservation] = useState<number | null>(null);
  const [lastReadProgressAt, setLastReadProgressAt] = useState<number | null>(null);
  const [, updateObservationAges] = useState(0);
  const calibrationRef = useRef<HTMLDetailsElement>(null);
  const matchContext = screenReader?.matchContext ?? null;
  const hasMatchObservations = matchContext?.lastObservedAt != null;
  const expectingReads = expectsGameReads(screenReader);
  const completedReads = screenReader?.metrics.reads ?? 0;
  useEffect(() => {
    if (!expectingReads) { setLastReadProgressAt(null); return; }
    setLastReadProgressAt(Date.now());
    const timer = window.setTimeout(() => updateObservationAges((value) => value + 1), READ_PROGRESS_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [expectingReads, completedReads, retryAttempt]);
  useEffect(() => {
    if (!hasMatchObservations) return;
    // Ages keep moving for retained or paused snapshots without an animation loop.
    const timer = window.setInterval(() => updateObservationAges((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [hasMatchObservations]);
  const identityProofAt = matchContext?.observations.viewMode?.capturedAt ?? null;
  useEffect(() => {
    if (matchContext?.viewMode !== 'participant' || identityProofAt === null) return;
    const remaining = identityProofAt + SCREEN_CONTEXT_MAX_AGE_MS + 1 - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => updateObservationAges((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [matchContext?.viewMode, identityProofAt]);
  const phaseProofAt = matchContext?.observations.phase?.capturedAt ?? null;
  useEffect(() => {
    if (phaseProofAt === null) return;
    const remaining = phaseProofAt + SCREEN_CONTEXT_MAX_AGE_MS + 1 - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => updateObservationAges((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [phaseProofAt]);
  const upgradeAdvice = screenReader?.abilityAdvice;
  const upgradeRankAt = matchContext?.localAbilities.find((ability) => ability.slot === upgradeAdvice?.slot)?.observation.capturedAt ?? null;
  const upgradeBudgetAt = matchContext?.observations.localAbilityPoints?.capturedAt ?? null;
  useEffect(() => {
    if (upgradeAdvice?.kind !== 'upgrade' || upgradeRankAt === null || upgradeBudgetAt === null) return;
    const remaining = Math.min(upgradeRankAt, upgradeBudgetAt) + SCREEN_CAPTURE_FRESHNESS_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => updateObservationAges((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [upgradeAdvice?.kind, upgradeRankAt, upgradeBudgetAt]);
  useEffect(() => {
    setDraftCrop(crop);
    setCropApplied(false);
  }, [crop.x, crop.y, crop.width, crop.height]);

  // Continuous tentative scans must not keep claiming that a draft is open.
  // Publication counters and candidate generations deliberately do not reset this timer.
  useEffect(() => {
    setReadingTimedOut(false);
    if (status !== 'reading' || !enabled) return;
    const timer = window.setTimeout(() => setReadingTimedOut(true), UNCONFIRMED_READING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [status, enabled, retryAttempt]);

  const observedAt = screenReader?.observedAt ?? null;
  useEffect(() => {
    if ((status !== 'ready' && status !== 'reading') || observedAt === null || !enabled) return;
    const now = Date.now();
    const remaining = observedAt + SCREEN_CARD_HOLD_MS - now;
    if (observedAt > now || remaining <= 0) { setExpiredObservation(observedAt); return; }
    setExpiredObservation(null);
    const timer = window.setTimeout(() => setExpiredObservation(observedAt), remaining);
    return () => window.clearTimeout(timer);
  }, [status, observedAt, enabled]);

  const observedNow = Date.now();
  const noReadProgress = readProgressTimedOut(screenReader, lastReadProgressAt, observedNow);
  const observationFresh = observedAt !== null && observedAt <= observedNow
    && observedNow - observedAt < SCREEN_CARD_HOLD_MS && expiredObservation !== observedAt;
  // Cards stay visible while you look at the companion (game not focused) or the reader restarts.
  const canShowObservedCards = (status === 'ready' || status === 'reading') && enabled && !!screenReader && observationFresh;
  const readingReady = status === 'ready' && canShowObservedCards && screenReader.offers.length > 0;
  const offers = canShowObservedCards ? screenReader.offers.slice().sort((a, b) => a.position - b.position) : [];
  const advice = readingReady ? screenReader.advice : null;
  const preferredOffer = offers.find((offer) => offer.position === advice?.preferredPosition);
  const comparisonOffer = offers.find((offer) => offer.position === advice?.comparisonPosition
    && catalog.items.some((item) => item.id === offer.itemId || item.numericId === offer.itemId));
  const useLocalAssets = typeof window !== 'undefined' && !!window.companion;
  const currentCards = [0, 1, 2].map((position) => offers.find((offer) => offer.position === position) ?? null);
  const knownCardSet = offers.length === 3 && [0, 1, 2].every((position) => offers.some((offer) => offer.position === position
    && offer.confidence >= .85 && catalog.items.some((item) => item.id === offer.itemId || item.numericId === offer.itemId)));
  const fullCardsRead = knownCardSet && offers.every((offer) => offer.variant !== 'unknown' && offer.warning === null && offer.bonusIds !== null
    && offer.bonusIds.every((id) => catalog.items.some((item) => item.id === id || item.numericId === id)));
  const participantCurrent = participantIdentityCurrent(matchContext, observedNow);
  // Unread bonuses and an unconfirmed own build are caveats on the pick, not reasons to hide it.
  const showRecommendation = preferredOffer !== undefined && advice !== null
    && catalog.items.some((item) => item.id === preferredOffer.itemId || item.numericId === preferredOffer.itemId);
  const offerOnlyComparison = advice?.factsUsed !== undefined && advice.factsUsed.every((fact) => fact.scope === 'catalog');
  const showProvisional = (participantCurrent || offerOnlyComparison) && matchContext?.viewMode !== 'spectator' && matchContext?.phase !== 'finished'
    && !showRecommendation && comparisonOffer !== undefined && advice?.comparisonBasis === 'main-item-base-effects' && knownCardSet;
  const comparisonQualification = !fullCardsRead ? 'Main item only · bonuses or special effects unread'
    : offerOnlyComparison ? 'Main item only · build and teams unverified' : 'Main item only · bonuses and special effects excluded';
  const needsIdentityReading = readingReady && knownCardSet && !participantCurrent;
  const readyUnconfirmed = status === 'ready' && !readingReady;
  const needsFreshReading = readingTimedOut || readyUnconfirmed || noReadProgress;
  const hasObservedBuild = !!matchContext && (matchContext.players.length > 0 || matchContext.localHeroId !== null
    || matchContext.localInventoryObservation !== null || matchContext.abilityObservation !== null);
  const phaseObservedAt = matchContext?.observations.phase?.capturedAt ?? null;
  const draftPhaseFresh = matchContext?.phase === 'draft' && phaseObservedAt !== null && phaseObservedAt <= observedNow
    && observedNow - phaseObservedAt < SCREEN_CAPTURE_FRESHNESS_MS;
  const showBuildFirst = !canShowObservedCards && !draftPhaseFresh && (hasObservedBuild || matchContext?.phase === 'combat' || matchContext?.phase === 'finished');
  // The roster/build trackers (top bar, scoreboard, inventory) replace the older match panels.
  const rosterKnown = !!screenReader?.roster && (screenReader.roster.localHeroId !== null || screenReader.roster.enemies.length > 0)
    || !!screenReader?.build && (screenReader.build.myItems.length > 0 || screenReader.build.abilityRanks !== null);
  const hasActualMatchData = rosterKnown || offers.length > 0 || !!matchContext && (matchContext.localHeroId !== null
    || matchContext.players.some((player) => player.heroId !== null || player.inventory.some((item) => item.itemId !== null))
    || matchContext.localInventory.some((item) => item.itemId !== null)
    || matchContext.localAbilities.some((ability) => ability.rank !== null || ability.unlocked !== null)
    || matchContext.round !== null || matchContext.scores !== null || matchContext.phase !== 'unknown');
  const operationalStatus = status === 'unavailable' ? status : !enabled ? 'paused' : status === 'paused' || status === 'interrupted' ? status
    : status === 'starting' || !screenReader?.engineReady ? 'starting' : !screenReader.gamePresent ? 'waiting-game'
    : !screenReader.foreground ? 'interrupted' : status;
  const readerBlocked = !expectingReads;
  const operationalCopy = statusText[operationalStatus];
  const sourceMessage = screenReader?.message.trim() ?? '';
  const routineWaitMessages = ['Waiting for the item-choice screen.', 'Waiting for a fresh view of the item choices.',
    'The item choices have not been confirmed. Waiting for a fresh draft view.', 'Confirming that the item-choice screen is open.',
    'Preparing the screen reader…'];
  const waitingSourceIssue = status === 'waiting-draft' && sourceMessage !== '' && !routineWaitMessages.includes(sourceMessage);
  const noMatchData = !hasActualMatchData && operationalStatus === 'waiting-draft';
  const followingMatch = showBuildFirst && hasActualMatchData && !readerBlocked && !noReadProgress && !waitingSourceIssue;
  const phaseCurrent = matchPhaseCurrent(matchContext, observedNow);
  const displayLabel = readerBlocked ? operationalCopy.label : noReadProgress ? 'No new reading received' : noMatchData ? 'No match data read yet' : waitingSourceIssue ? 'Reading unconfirmed'
    : followingMatch ? phaseCurrent ? matchContext?.phase === 'finished' ? 'Match complete' : 'Following the match' : 'Last seen match'
    : readingTimedOut ? 'Draft not fully confirmed' : readyUnconfirmed ? 'Waiting for fresh cards' : copy.label;
  const displayTitle = readerBlocked ? operationalCopy.title : noMatchData ? 'No match data read yet' : noReadProgress ? 'No new reading received'
    : followingMatch ? phaseCurrent ? matchContext?.phase === 'finished' ? 'Match complete' : 'Waiting for next item choice' : 'Waiting for match reading'
    : readingTimedOut ? 'No current draft confirmed' : readyUnconfirmed ? 'Waiting for a fresh reading' : copy.title;
  const displayDescription = readerBlocked ? operationalStatus === status && sourceMessage ? sourceMessage : operationalCopy.description
    : noReadProgress ? 'No completed game reading has arrived recently.'
    : waitingSourceIssue ? sourceMessage
    : noMatchData ? 'No heroes, items or draft cards have been read yet.'
    : followingMatch
    ? 'No item choice is confirmed. Last observed builds and ability investment are below. Open the scoreboard in Deadlock to refresh team inventories.'
    : needsIdentityReading ? 'Press Tab in Deadlock to refresh your hero and build.'
    : needsFreshReading
    ? 'Current item choices are not confirmed. During combat, no item choice is needed. If a draft is visible, read again or check the reading area.'
    : status === 'reading' ? copy.description : screenReader?.message || copy.description;
  const cropChanged = draftCrop.x !== crop.x || draftCrop.y !== crop.y || draftCrop.width !== crop.width || draftCrop.height !== crop.height;
  const regionStyle = {
    left: percent(draftCrop.x), top: percent(draftCrop.y),
    width: percent(draftCrop.width), height: percent(draftCrop.height),
  } as CSSProperties;

  function adjustCrop(field: keyof CaptureRegion, value: number) {
    setCropApplied(false);
    setDraftCrop((current) => {
      const next = { ...current, [field]: value };
      next.x = Math.min(0.85, Math.max(0, next.x));
      next.y = Math.min(0.85, Math.max(0, next.y));
      next.width = Math.min(1 - next.x, Math.max(0.15, next.width));
      next.height = Math.min(1 - next.y, Math.max(0.15, next.height));
      return next;
    });
  }

  function applyCrop() {
    onScreenCrop(draftCrop);
    setCropApplied(true);
  }

  function retryReading() {
    setRetryAttempt((attempt) => attempt + 1);
    onScreenRetry();
  }

  function openCalibration() {
    if (!calibrationRef.current) return;
    calibrationRef.current.open = true;
    calibrationRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    calibrationRef.current.querySelector('summary')?.focus();
  }

  return (
    <section className="screen-reading" aria-labelledby="screen-reader-heading">
      <div className="screen-reader-toolbar">
        <div><span className="screen-live-label"><Eye size={13} aria-hidden="true" />From your game screen</span><span className="screen-experimental">Experimental guidance</span></div>
        <button className="screen-pause" type="button" disabled={!screenReader} aria-pressed={automaticallyPaused ? undefined : !enabled} onClick={() => automaticallyPaused ? retryReading() : onScreenEnabled(!enabled)}>{automaticallyPaused ? <RotateCcw size={12} /> : enabled ? <Pause size={12} /> : <Play size={12} />}{automaticallyPaused ? 'Retry reading' : enabled ? 'Pause reading' : 'Resume reading'}</button>
      </div>

      <div className="screen-status-row"><span className={`screen-status screen-status-${needsFreshReading && !readerBlocked ? 'unconfirmed' : operationalStatus}`}><span />{displayLabel}</span><span>{screenReader?.observedAt ? <>Last read <time dateTime={new Date(screenReader.observedAt).toISOString()}>{timeLabel(screenReader.observedAt)}</time></> : 'No draft confirmed yet'}</span></div>

      {!rosterKnown && <MatchContextSummary context={matchContext} now={observedNow} />}

      {(screenReader?.roster?.localHeroId || screenReader?.roster?.enemies.length) ? <div className="screen-roster" aria-label="Heroes in this match">
        <span><strong>You</strong> {heroName(catalog, screenReader.roster.localHeroId) ?? 'not seen yet'}{screenReader.roster.allies.length ? <> · with {screenReader.roster.allies.map((id) => heroName(catalog, id)).join(', ')}</> : null}</span>
        <span><strong>Enemies</strong> {screenReader.roster.enemies.length ? screenReader.roster.enemies.map((id) => heroName(catalog, id)).join(', ') : 'not placed yet'}</span>
        {screenReader.rerollsLeft != null && <span><strong>Rerolls</strong> {screenReader.rerollsLeft} left this round</span>}
        {screenReader.build?.abilityRanks && <span><strong>Abilities</strong> {screenReader.build.abilityRanks.join(' / ')}</span>}
        {screenReader.abilityPlan && <span className="screen-roster-wide screen-ability-plan"><strong>Next upgrade</strong> {screenReader.abilityPlan.ability} to tier {screenReader.abilityPlan.tier} ({screenReader.abilityPlan.cost} AP): {screenReader.abilityPlan.reason}{screenReader.abilityPlan.games ? ` (${screenReader.abilityPlan.games.toLocaleString()} games)` : ''}.{screenReader.abilityPlan.then.length ? <> Then {screenReader.abilityPlan.then.join(', ')}.</> : null}</span>}
        {!!screenReader.build?.myItems.length && <span className="screen-roster-wide"><strong>Your items</strong> {screenReader.build.myItems.map((id) => itemName(catalog, id)).join(', ')}</span>}
        {screenReader.roster.localSide !== null && screenReader.build && (screenReader.roster.localSide === 0 ? [4, 5, 6, 7] : [0, 1, 2, 3])
          .filter((seat) => screenReader.build!.seatItems[seat]?.length)
          .map((seat) => <span key={seat} className="screen-roster-wide"><strong>{heroName(catalog, screenReader.roster!.seats[seat] ?? null) ?? `Enemy ${seat % 4 + 1}`}</strong> {screenReader.build!.seatItems[seat]!.map((id) => itemName(catalog, id)).join(', ')}</span>)}
      </div> : null}

      <section id="screen-decision" tabIndex={-1} className={`decision screen-decision ${showBuildFirst ? 'screen-combat-decision' : ''} ${showRecommendation ? 'decision-ready' : showProvisional ? 'decision-waiting decision-provisional' : 'decision-waiting'}`} aria-labelledby="screen-reader-heading" aria-live="polite" aria-atomic="true">
        <div className="decision-kicker"><span>{showRecommendation ? <><Sparkles size={12} />Suggested · {cardPosition(preferredOffer.position)} card</> : showProvisional ? <><Sparkles size={12} />Consider · {cardPosition(comparisonOffer.position)} card</> : <><ScanLine size={12} />{readerBlocked ? operationalCopy.label : noReadProgress ? 'Reading unconfirmed' : noMatchData ? 'Waiting for match data' : showBuildFirst ? phaseCurrent && matchContext?.phase !== 'finished' ? 'Between choices' : 'Match history' : 'Checking visible cards'}</>}</span><span className="decision-evidence">{showProvisional ? 'Main item only' : showRecommendation ? advice.rerollSuggested ? 'Reroll suggested' : participantCurrent ? 'Situational pick' : 'Best visible card' : null}</span></div>
        <div className="decision-content"><div><h2 id="screen-reader-heading">{showRecommendation ? preferredOffer.name : showProvisional ? comparisonOffer.name : needsIdentityReading ? 'Refresh your build' : readingReady && advice ? 'No clear pick yet' : displayTitle}</h2>{!showRecommendation && !showProvisional && <p className="decision-description">{showBuildFirst && followingMatch ? 'Enemy builds are below.' : displayDescription}</p>}</div><span className="decision-emblem" aria-hidden="true">{showRecommendation || showProvisional ? <ArrowRight size={32} strokeWidth={1.1} /> : <ScanLine size={29} strokeWidth={1.2} />}</span></div>
        {showProvisional && <p className="decision-qualification">{comparisonQualification}</p>}
        {showRecommendation && <p className="decision-qualification">{advice.reasons[0]}</p>}
        {showRecommendation && advice.imbue && <p className="decision-qualification decision-imbue"><Sparkles size={11} aria-hidden="true" /> {advice.imbue}</p>}
        {showRecommendation && <p className={`decision-qualification ${advice.rerollSuggested ? 'decision-reroll' : ''}`}><RotateCcw size={11} aria-hidden="true" /> {advice.rerollReason}</p>}
        {showRecommendation && advice.caveat && <p className="decision-qualification">{advice.caveat}</p>}
      </section>

      {((needsFreshReading && !showBuildFirst) || noReadProgress || operationalStatus === 'unavailable') && <div className="screen-confirmation-help"><p>{operationalStatus === 'unavailable' ? 'Retry after resolving the reader status above.' : 'The companion has no confirmed current choice to recommend.'}</p><div><button type="button" className="quiet-button" disabled={!screenReader} onClick={retryReading}><RotateCcw size={12} />Read again</button><button type="button" className="quiet-button" onClick={openCalibration}><SlidersHorizontal size={12} />Check reading area</button></div></div>}

      {showBuildFirst && !rosterKnown && <MatchOverview context={matchContext} catalog={catalog} now={observedNow} useLocalAssets={useLocalAssets} abilityAdvice={screenReader?.abilityAdvice} />}

      {!showBuildFirst && <section className="screen-offers-section" aria-labelledby="screen-offers-heading">
        <h2 id="screen-offers-heading" className="visually-hidden">Visible draft cards</h2>
        <div className="screen-offer-grid">{currentCards.map((offer, position) => <ScreenOfferCard key={`${screenReader?.generation ?? 0}-${position}`} offer={offer} position={position} catalog={catalog} useLocalAssets={useLocalAssets} preferred={showRecommendation && offer?.position === preferredOffer.position} provisional={showProvisional && offer?.position === comparisonOffer.position} reason={advice?.ranked.find((entry) => entry.position === position)?.reasons[0]} />)}</div>
      </section>}

      {!showBuildFirst && !rosterKnown && <MatchOverview context={matchContext} catalog={catalog} now={observedNow} useLocalAssets={useLocalAssets} abilityAdvice={screenReader?.abilityAdvice} />}

      {advice && <details className="detail-panel screen-advice-facts"><summary><span><Eye size={14} />Why this item</span><span className="detail-summary-status">Details<ChevronDown size={14} /></span></summary><div className="detail-content"><h3>{showProvisional ? 'Base item to consider' : showRecommendation ? 'Situational preference' : 'Visible-item comparison'}</h3><ul className="screen-additional-reasons">{advice.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>{showProvisional && <p className="detail-intro">Bonuses or special effects may change this choice.</p>}<h3 className="screen-facts-heading">Facts used for this comparison</h3>{advice.factsUsed?.length ? <ul className="screen-facts-used">{advice.factsUsed.map((fact, index) => <li key={index}><span className={`screen-fact-scope screen-fact-${fact.scope}`}>{fact.scope === 'own' ? 'Own build' : fact.scope === 'ally' ? 'Ally' : fact.scope === 'enemy' ? 'Opponent' : fact.scope === 'round' ? 'Round' : 'Item mechanics'}</span><span>{fact.label}</span><small>{fact.scope === 'catalog' ? 'Known item information' : observationAge(fact.observedAt, observedNow)}</small></li>)}</ul> : <p className="detail-intro">No observed match fact was used. This comparison is limited to visible cards and known item information.</p>}<ul className="screen-additional-reasons">{advice.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></div></details>}

      <details className="detail-panel screen-reroll-details"><summary><span><RotateCcw size={14} />Reroll guidance</span><span className="detail-summary-status">{matchContext?.rerollsRemaining == null ? 'Not read' : `${matchContext.rerollsRemaining} last read`}<ChevronDown size={14} /></span></summary><div className="detail-content">

      <section className="screen-reroll-context" aria-labelledby="screen-reroll-heading"><div><h2 id="screen-reroll-heading"><RotateCcw size={13} aria-hidden="true" />Reroll guidance</h2><span>{matchContext?.rerollsRemaining == null ? 'Count not read' : `${matchContext.rerollsRemaining} last read`} · {observationAge(matchContext?.observations.rerollsRemaining?.capturedAt, observedNow)}</span></div><p>{advice?.rerollReason ?? (matchContext?.rerollsRemaining === 0 ? 'Zero rerolls were observed. Refresh the draft to confirm the current budget.' : 'A future replacement draw has not been verified; these offers do not establish the value of rerolling.')}</p><details><summary>Observed reroll state<ChevronDown size={12} aria-hidden="true" /></summary><dl><div><dt>Availability</dt><dd>{matchContext?.rerollAvailable == null ? 'Not read' : matchContext.rerollAvailable ? 'Available at last read' : 'Unavailable at last read'} · {observationAge(matchContext?.observations.rerollAvailable?.capturedAt, observedNow)}</dd></div><div><dt>Choice stage</dt><dd>{matchContext?.pickStage ?? 'Not read'} · {observationAge(matchContext?.observations.pickStage?.capturedAt, observedNow)}</dd></div><div><dt>Choice timer</dt><dd>{matchContext?.deadlineAt == null ? 'Not read' : matchContext.deadlineAt <= observedNow ? 'Observed timer has expired' : `Observed end ${timeLabel(matchContext.deadlineAt)}`}</dd></div><div><dt>Future draw</dt><dd>Replacement model unverified</dd></div></dl></details></section>
      </div></details>

      {screenReader?.calibrationRequired && <div className="screen-calibration-callout"><SlidersHorizontal size={16} aria-hidden="true" /><div><strong>Adjust the reading area</strong><p>Include all three draft cards. Exclude your inventory, other menus and the companion window.</p></div></div>}

      <details ref={calibrationRef} className="detail-panel screen-calibration" open={screenReader?.calibrationRequired || undefined}>
        <summary><span><SlidersHorizontal size={15} />Adjust reading area</span><span className="detail-summary-status">{cropChanged ? 'Changes not applied' : 'Game window'}<ChevronDown size={15} /></span></summary>
        <div className="detail-content">
          <p className="detail-intro">Choose the part of the Deadlock window that contains all three draft cards. The reader also checks the draft heading and lower buttons to detect when choices open or close. The diagram shows the selected card area; it is not a screenshot.</p>
          <div className="screen-crop-presets" role="group" aria-label="Reading area presets">{cropPresets.map((preset) => <button type="button" key={preset.name} onClick={() => { setDraftCrop(preset.crop); setCropApplied(false); }}>{preset.name}</button>)}</div>
          <div className="screen-calibration-layout"><div className="screen-crop-diagram" role="img" aria-label={`Selected game-window area: left ${percent(draftCrop.x)}, top ${percent(draftCrop.y)}, width ${percent(draftCrop.width)}, height ${percent(draftCrop.height)}`}><span className="screen-crop-window-label"><Monitor size={12} />Game window</span><span className="screen-crop-selection" style={regionStyle}><Maximize size={18} /><span>Read this area</span></span></div><div className="screen-crop-controls">{([['x', 'Left edge'], ['y', 'Top edge'], ['width', 'Width'], ['height', 'Height']] as const).map(([field, label]) => <label className="screen-crop-slider" key={field}><span>{label}<strong>{percent(draftCrop[field])}</strong></span><input type="range" min={field === 'width' || field === 'height' ? 0.15 : 0} max={field === 'x' || field === 'y' ? 0.85 : 1} step="0.01" value={draftCrop[field]} onChange={(event) => adjustCrop(field, Number(event.target.value))} /></label>)}</div></div>
          <div className="screen-crop-actions"><span role="status">{cropApplied ? 'Reading area submitted. Keep the draft visible.' : cropChanged ? 'Apply this area to start a fresh reading.' : 'Changes take effect after you apply the area.'}</span><button type="button" className="screen-apply" onClick={applyCrop} disabled={!screenReader}><Check size={12} />Apply reading area</button></div>
          <div className="screen-preview-controls"><p>Apply changes first. After clicking Preview area, return to Deadlock so the app can check the area.</p><button type="button" className="quiet-button" disabled={!screenReader?.gamePresent || !onScreenPreview || cropChanged} onClick={onScreenPreview}><Eye size={12} />Preview area</button></div>
          {screenReader?.previewDataUrl && <figure className="screen-crop-preview"><img src={screenReader.previewDataUrl} alt="Recent capture of the selected Deadlock card area" /><figcaption>Last requested preview of the selected card area. Check that all three cards and the draft heading are included; lower draft controls are checked separately.</figcaption></figure>}
        </div>
      </details>

      <details className="detail-panel screen-reader-details">
        <summary><span><Activity size={15} />Reading status & limits</span><span className="detail-summary-status">{screenReader?.engineReady ? 'Text reader prepared' : 'Reader preparing'}<ChevronDown size={15} /></span></summary>
        <div className="detail-content">
          <p className="detail-intro">{displayDescription}</p>
          <dl className="source-facts"><div><dt>Deadlock window</dt><dd>{!screenReader ? 'Not checked' : screenReader.gamePresent ? screenReader.foreground ? 'Present and in foreground' : 'Present · not in foreground' : 'Not found'}</dd></div><div><dt>Text reader</dt><dd>{screenReader?.engineReady ? 'Ready' : 'Preparing or unavailable'}</dd></div><div><dt>Last clear reading</dt><dd>{timeLabel(screenReader?.observedAt ?? null)}</dd></div><div><dt>Reading time</dt><dd>{screenReader?.readMs === null || screenReader?.readMs === undefined ? 'Not measured' : `${Math.round(screenReader.readMs)} ms`}</dd></div><div><dt>Completed / skipped reads</dt><dd>{screenReader?.metrics.reads ?? '—'} / {screenReader?.metrics.skipped ?? '—'}</dd></div><div><dt>Reader timeouts</dt><dd>{screenReader?.metrics.timeouts ?? '—'}</dd></div><div><dt>CPU use</dt><dd>{screenReader?.metrics.cpuPercent === null || screenReader?.metrics.cpuPercent === undefined ? 'Not measured' : `${screenReader.metrics.cpuPercent.toFixed(1)}%`}</dd></div><div><dt>Memory use</dt><dd>{screenReader?.metrics.memoryMb === null || screenReader?.metrics.memoryMb === undefined ? 'Not measured' : `${Math.round(screenReader.metrics.memoryMb)} MB`}</dd></div></dl>
          {offers.length > 0 && <div className="screen-read-quality"><h3>Item-name text matching</h3><p>These percentages describe matching to known names. They are not measured reading accuracy, item value, or a chance of winning.</p><ul>{offers.map((offer) => <li key={offer.position}><span>{offer.name}</span><strong>{percent(offer.confidence)}</strong></li>)}</ul></div>}
          <div className="evidence-limitations"><h3>Guidance limits</h3><ul>{advice?.limitations.length ? advice.limitations.map((limitation, index) => <li key={index}>{limitation}</li>) : <><li>Names can be misread. Confirm each visible card in Deadlock before choosing.</li><li>Bonuses, special effects, full inventories, teams and exact ability ranks may not be read.</li><li>Item guidance is experimental. Reroll probabilities and live outcome improvements are not validated.</li></>}</ul></div>
          <div className="screen-retry-row"><span>Readings follow the visible game window. The companion does not select items or send gameplay input.</span><div className="screen-reader-actions"><button type="button" className="quiet-button" disabled={!screenReader || (!enabled && status !== 'unavailable')} onClick={retryReading}><RotateCcw size={12} />Read again</button>{onExportDiagnostics && <button type="button" className="quiet-button" onClick={onExportDiagnostics}><FileDown size={12} />Export safe diagnostics</button>}</div></div>
        </div>
      </details>
    </section>
  );
}
