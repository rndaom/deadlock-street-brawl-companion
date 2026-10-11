import type { Catalog, CatalogHero, CatalogItem } from '../shared/types';
import type { ScreenAdvice, ScreenOffer, ScreenReaderState } from '../shared/screen-reading';
import { SCREEN_CARD_HOLD_MS, SCREEN_CONTEXT_MAX_AGE_MS } from '../shared/screen-reading';
import { indexCatalog, POSITION_NAMES } from './catalog-index';
import type { AbilityLabel, CatalogIndex } from './catalog-index';

/*
 * Everything the companion shows is derived here from one reader publication, so the
 * components stay simple and the rules (what is fresh, what may be recommended) are testable.
 */

/** A tentative "reading" status that never confirms is reported after this long. */
export const READING_CONFIRM_TIMEOUT_MS = 8_000;
/** No completed game reading for this long while the reader should be reading. */
export const READ_PROGRESS_TIMEOUT_MS = 8_000;

export interface ReaderClock {
  now: number;
  /** When the current uninterrupted "reading" status began. */
  readingSince: number | null;
  /** Last time completed reads advanced (or reading became expected). */
  lastProgressAt: number | null;
}

export type Tone = 'live' | 'ready' | 'idle' | 'warn' | 'off';
export type NoticeAction = 'resume' | 'retry' | 'read-again' | 'reading-area';
export type NoticeKind = 'unavailable' | 'paused' | 'auto-paused' | 'starting' | 'waiting-game' | 'background'
  | 'stalled' | 'reading' | 'unconfirmed' | 'stale' | 'spectator' | 'finished' | 'between' | 'source' | 'idle';
export type CallKind = 'pick' | 'close' | 'reroll' | 'consider';
export type ReasonKind = 'stat' | 'counter' | 'concern' | 'enhanced' | 'imbue' | 'build' | 'text';

export interface WinStat { winRate: number; games: string; hero: string | null; delta: string; positive: boolean; valve: boolean }
export interface Reason { kind: ReasonKind; text: string }
export interface Notice { kind: NoticeKind; title: string; body: string; actions: NoticeAction[]; tip?: 'tab' }

export interface CardView {
  position: number;
  label: string;
  offer: ScreenOffer | null;
  item: CatalogItem | undefined;
  name: string;
  category: CatalogItem['category'];
  tier: number | null;
  /** 1–5 relative fit among the visible cards, null when unscored. */
  fit: number | null;
  isPick: boolean;
  isConsider: boolean;
  /** The card to take if you decide not to reroll. */
  isFallback: boolean;
  stat: WinStat | null;
  note: string | null;
  identified: boolean;
  tags: string[];
}

export interface CallView {
  kind: CallKind;
  position: number;
  positionLabel: string;
  item: CatalogItem;
  offer: ScreenOffer;
  stat: WinStat | null;
  reasons: Reason[];
  moreReasons: Reason[];
  imbue: { ability: AbilityLabel | null; abilityName: string; why: string } | null;
  caveat: string | null;
  reroll: { suggested: boolean; text: string; left: number | null };
  facts: NonNullable<ScreenAdvice['factsUsed']>;
  limitations: string[];
}

export interface SeatView { seat: number; hero: CatalogHero | undefined; heroId: string | null; items: ItemRef[]; isLocal: boolean }
export interface ItemRef { id: string; item: CatalogItem | undefined }
export interface AbilityView { slot: number; label: AbilityLabel | null; name: string; rank: number | null; isNext: boolean }
export interface PlanView { slot: number; ability: string; tier: number; cost: number | null; reason: string; then: string[]; winRate: number | null; games: number }

export interface CompanionView {
  status: { tone: Tone; label: string };
  stage: 'call' | 'cards' | 'notice';
  cards: CardView[] | null;
  call: CallView | null;
  notice: Notice | null;
  /** True while shown cards are being held although the game is not in front. */
  holding: boolean;
  match: { round: number | null; scores: { ours: number; theirs: number; labels: [string, string] } | null; rerollsLeft: number | null };
  me: { hero: CatalogHero | undefined; items: ItemRef[]; abilities: AbilityView[]; ranksKnown: boolean; plan: PlanView | null };
  teams: { known: boolean; ours: SeatView[]; theirs: SeatView[]; hiddenEnemyItems: number };
  /** Anything from a match (heroes, items, ranks, score) has been read. */
  hasMatchData: boolean;
  lastReadAt: number | null;
  calibrationRequired: boolean;
  readerRunning: boolean;
  canPause: boolean;
  automaticallyPaused: boolean;
}

const ROUTINE_WAIT_MESSAGES = new Set(['Waiting for the item-choice screen.', 'Waiting for a fresh view of the item choices.',
  'The item choices have not been confirmed. Waiting for a fresh draft view.', 'Confirming that the item-choice screen is open.',
  'Preparing the screen reader…', 'Item choices read from the game screen.', 'Waiting for Deadlock.']);

export function expectsGameReads(state: ScreenReaderState | null) {
  return !!state && state.enabled && state.engineReady && state.gamePresent && state.foreground
    && (state.status === 'waiting-draft' || state.status === 'reading' || state.status === 'ready');
}

/** Local receipt timing identifies missing progress, without diagnosing the native reader. */
export function readProgressTimedOut(state: ScreenReaderState | null, lastProgressAt: number | null, now: number) {
  return expectsGameReads(state) && lastProgressAt !== null && Number.isFinite(lastProgressAt)
    && Number.isFinite(now) && now - lastProgressAt >= READ_PROGRESS_TIMEOUT_MS;
}

/** Cards are held for the hold window after their last confirming read, never from the future. */
export function cardsFresh(state: ScreenReaderState | null, now: number) {
  const at = state?.observedAt ?? null;
  return !!state && state.enabled && (state.status === 'ready' || state.status === 'reading')
    && at !== null && at <= now && now - at < SCREEN_CARD_HOLD_MS;
}

const WIN_STAT = /^Wins (\d+)% of ([\d.,]+k?) Street Brawl games(?: on (.+?))? \(([^)]+)\)(?: · on Valve's list for .+?)?\.?$/;

export function parseWinStat(reason: string | undefined): WinStat | null {
  const match = reason ? WIN_STAT.exec(reason.trim()) : null;
  if (!match) return null;
  const delta = match[4]!;
  return { winRate: Number(match[1]), games: match[2]!, hero: match[3] ?? null,
    delta: delta === 'about average' ? 'about average' : delta.replace(/ vs\. average$/, ' vs avg'),
    positive: delta.startsWith('+'), valve: reason!.includes("Valve's list") };
}

export function classifyReason(text: string): ReasonKind {
  if (WIN_STAT.test(text)) return 'stat';
  if (/^Imbue it on /.test(text)) return 'imbue';
  if (/^Enhanced:/.test(text)) return 'enhanced';
  if (/^(Wins more against|Does well against)/.test(text)) return 'counter';
  if (/^(Wins less against|Does poorly against|Requires manual|Some benefits require)/.test(text)) return 'concern';
  if (/^(Matches observed|Your build|You already own|Complements|Fills)/.test(text)) return 'build';
  return 'text';
}

function parseImbue(text: string | undefined, abilities: AbilityLabel[]) {
  const match = text ? /^Imbue it on (.+?) \((.*)\)\.?$/.exec(text.trim()) : null;
  if (!match) return null;
  const abilityName = match[1]!;
  return { abilityName, why: match[2]!, ability: abilities.find((ability) => ability.name === abilityName) ?? null };
}

function resolveSeat(index: CatalogIndex, seat: number, heroId: string | null, itemIds: (string | null)[], localHeroId: string | null, localSide: 0 | 1 | null): SeatView {
  const side = seat < 4 ? 0 : 1;
  return { seat, heroId, hero: index.hero(heroId),
    items: itemIds.filter((id): id is string => !!id).map((id) => ({ id, item: index.item(id) })),
    isLocal: heroId !== null && heroId === localHeroId && localSide === side };
}

function deriveTeams(state: ScreenReaderState, index: CatalogIndex, localHeroId: string | null) {
  const roster = state.roster;
  const seatItems = state.build?.seatItems ?? [];
  const hiddenEnemyItems = state.build?.hiddenEnemyItems ?? 0;
  if (roster && roster.seats.some((hero) => hero !== null)) {
    const side = roster.localSide;
    const seats = roster.seats.map((heroId, seat) => resolveSeat(index, seat, heroId, seatItems[seat] ?? [], localHeroId, side));
    const left = seats.slice(0, 4), right = seats.slice(4, 8);
    return { known: side !== null, ours: side === 1 ? right : left, theirs: side === 1 ? left : right, hiddenEnemyItems };
  }
  // Older context reader: players with relative sides and per-slot inventories.
  const context = state.matchContext;
  if (context.players.length) {
    const ownTeam = context.localTeam ?? 0;
    const toSeat = (player: typeof context.players[number]): SeatView => ({ seat: player.seat, heroId: player.heroId, hero: index.hero(player.heroId),
      items: player.inventory.slice().sort((a, b) => a.slot - b.slot).filter((entry) => entry.itemId).map((entry) => ({ id: entry.itemId!, item: index.item(entry.itemId) })),
      isLocal: player.isLocal === true || (context.localSeat !== null && player.seat === context.localSeat) });
    const ours = context.players.filter((player) => player.team === ownTeam).sort((a, b) => a.seat - b.seat).map(toSeat);
    const theirs = context.players.filter((player) => player.team !== null && player.team !== ownTeam).sort((a, b) => a.seat - b.seat).map(toSeat);
    return { known: context.viewMode === 'participant' && context.localTeam !== null, ours, theirs, hiddenEnemyItems };
  }
  return { known: false, ours: [], theirs: [], hiddenEnemyItems };
}

function deriveMe(state: ScreenReaderState, index: CatalogIndex, heroId: string | null, teams: ReturnType<typeof deriveTeams>) {
  const context = state.matchContext;
  const hero = index.hero(heroId);
  const fromBuild = state.build?.myItems ?? [];
  const fromHud = context.localInventory.slice().sort((a, b) => a.slot - b.slot).map((entry) => entry.itemId).filter((id): id is string => !!id);
  const fromSeat = teams.ours.find((seat) => seat.isLocal)?.items.map((ref) => ref.id) ?? [];
  const itemIds = fromBuild.length ? fromBuild : fromHud.length ? fromHud : fromSeat;
  const labels = index.abilities(hero?.id);
  const ranks: (number | null)[] = state.build?.abilityRanks
    ? [0, 1, 2, 3].map((slot) => state.build!.abilityRanks![slot] ?? null)
    : [0, 1, 2, 3].map((slot) => context.localAbilities.find((ability) => ability.slot === slot)?.rank ?? null);
  const advice = state.abilityAdvice;
  const plan: PlanView | null = state.abilityPlan
    ? { ...state.abilityPlan }
    : advice && advice.kind !== 'withheld' && advice.slot !== null
      ? { slot: advice.slot, ability: labels[advice.slot]?.name ?? advice.title, tier: (ranks[advice.slot] ?? 0) + 1, cost: advice.cost,
        reason: advice.reasons[0] ?? advice.title, then: [], winRate: null, games: 0 }
      : null;
  const abilities: AbilityView[] = [0, 1, 2, 3].map((slot) => ({ slot, label: labels[slot] ?? null, name: labels[slot]?.name ?? `Ability ${slot + 1}`,
    rank: ranks[slot] ?? null, isNext: plan?.slot === slot }));
  return { hero, items: itemIds.map((id) => ({ id, item: index.item(id) })), abilities, ranksKnown: ranks.some((rank) => rank !== null), plan };
}

function deriveCards(state: ScreenReaderState, index: CatalogIndex, advice: ScreenAdvice | null, call: CallView | null): CardView[] {
  const marked = (kind: 'pick' | 'consider' | 'fallback') => call && (kind === 'pick' ? call.kind === 'pick' || call.kind === 'close' : kind === 'consider' ? call.kind === 'consider' : call.kind === 'reroll') ? call.position : null;
  const pick = marked('pick'), consider = marked('consider'), fallback = marked('fallback');
  const offers = state.offers.slice().sort((a, b) => a.position - b.position);
  const ranked = advice?.ranked ?? [];
  const scored = ranked.filter((entry) => index.item(offers.find((offer) => offer.position === entry.position)?.itemId));
  const scores = scored.map((entry) => entry.score);
  const min = Math.min(...scores), max = Math.max(...scores);
  return [0, 1, 2].map((position) => {
    const offer = offers.find((entry) => entry.position === position) ?? null;
    const item = index.item(offer?.itemId);
    const entry = ranked.find((candidate) => candidate.position === position);
    const fit = !entry || !item || !scores.length ? null : max - min < 1e-6 ? 3 : 1 + Math.round(((entry.score - min) / (max - min)) * 4);
    const stat = parseWinStat(entry?.reasons.find((reason) => WIN_STAT.test(reason)));
    const note = entry?.reasons.find((reason) => !WIN_STAT.test(reason) && !/^Imbue it on /.test(reason)) ?? offer?.warning ?? null;
    const tags: string[] = [];
    if (offer?.rare) tags.push('Rare');
    if (offer && offer.variant !== 'base' && offer.variant !== 'unknown') tags.push(offer.variant[0]!.toUpperCase() + offer.variant.slice(1));
    if (offer && offer.variant === 'unknown') tags.push('Variant not read');
    if (offer && offer.bonusIds === null) tags.push('Bonus details not confirmed');
    return { position, label: POSITION_NAMES[position]!, offer, item, name: offer ? item?.name ?? offer.name : 'Awaiting card',
      category: item?.category ?? 'unknown', tier: item?.tier ?? null, fit, isPick: pick === position, isConsider: consider === position, isFallback: fallback === position,
      stat, note, identified: !!item, tags };
  });
}

function deriveCall(state: ScreenReaderState, index: CatalogIndex, advice: ScreenAdvice, offers: ScreenOffer[], heroId: string | null, rerollsLeft: number | null): CallView | null {
  const preferred = offers.find((offer) => offer.position === advice.preferredPosition && index.item(offer.itemId));
  const comparison = offers.find((offer) => offer.position === advice.comparisonPosition && index.item(offer.itemId));
  const offer = preferred ?? comparison;
  if (!offer) return null;
  const kind: CallKind = !preferred ? 'consider' : advice.rerollSuggested ? 'reroll' : advice.title.startsWith('Slight edge') ? 'close' : 'pick';
  const imbue = parseImbue(advice.imbue, index.abilities(heroId));
  const seen = new Set<string>();
  const all = advice.reasons.filter((text) => {
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed) || /^Close call:/.test(trimmed) || (imbue && /^Imbue it on /.test(trimmed))) return false;
    seen.add(trimmed); return true;
  }).map((text) => ({ kind: classifyReason(text), text }));
  const statReason = all.find((reason) => reason.kind === 'stat');
  const rest = all.filter((reason) => reason !== statReason);
  return { kind, position: offer.position, positionLabel: POSITION_NAMES[offer.position] ?? 'Unknown', item: index.item(offer.itemId)!, offer,
    stat: parseWinStat(statReason?.text), reasons: rest.slice(0, 3), moreReasons: rest.slice(3), imbue,
    caveat: advice.caveat ?? null, reroll: { suggested: !!advice.rerollSuggested, text: advice.rerollReason, left: rerollsLeft },
    facts: advice.factsUsed ?? [], limitations: advice.limitations };
}

export function deriveView(state: ScreenReaderState | null, catalog: Catalog, clock: ReaderClock): CompanionView {
  const index = indexCatalog(catalog);
  const { now } = clock;
  const status = state?.status ?? 'starting';
  const enabled = state?.enabled ?? true;
  const context = state?.matchContext ?? null;
  const operational = status === 'unavailable' ? 'unavailable' : !enabled ? 'paused' : status === 'paused' || status === 'interrupted' ? status
    : status === 'starting' || !state?.engineReady ? 'starting' : !state.gamePresent ? 'waiting-game' : !state.foreground ? 'interrupted' : status;
  const fresh = cardsFresh(state, now);
  const cardsVisible = fresh && !!state && state.offers.length > 0;
  const confirmed = cardsVisible && status === 'ready';
  const advice = confirmed ? state!.advice : null;
  const offers = cardsVisible ? state!.offers : [];
  const heroId = state?.roster?.localHeroId ?? state?.heroId ?? context?.localHeroId ?? null;
  const rerollsLeft = state?.rerollsLeft ?? context?.rerollsRemaining ?? null;
  const call = advice ? deriveCall(state!, index, advice, offers, heroId, rerollsLeft) : null;
  const cards = cardsVisible ? deriveCards(state!, index, advice, call) : null;

  const readerBlocked = !expectsGameReads(state);
  const noProgress = readProgressTimedOut(state, clock.lastProgressAt, now);
  const readingTimedOut = status === 'reading' && enabled && clock.readingSince !== null && now - clock.readingSince >= READING_CONFIRM_TIMEOUT_MS;
  const staleReady = status === 'ready' && !cardsVisible;
  const teams = state ? deriveTeams(state, index, heroId) : { known: false, ours: [], theirs: [], hiddenEnemyItems: 0 };
  const me = state ? deriveMe(state, index, heroId, teams) : { hero: undefined, items: [], abilities: [], ranksKnown: false, plan: null };
  const hasMatchData = !!state && (teams.ours.some((seat) => seat.heroId) || teams.theirs.some((seat) => seat.heroId) || me.items.length > 0
    || me.ranksKnown || heroId !== null || context?.round != null || context?.scores != null || (context?.phase ?? 'unknown') !== 'unknown');
  const message = state?.message.trim() ?? '';
  const phaseAt = context?.observations.phase?.capturedAt ?? null;
  const finished = context?.phase === 'finished' && phaseAt !== null && phaseAt <= now && now - phaseAt < SCREEN_CONTEXT_MAX_AGE_MS;

  let notice: Notice | null = null;
  if (operational === 'unavailable') notice = { kind: 'unavailable', title: 'Screen reader unavailable', body: message || 'The local reader could not start.', actions: ['retry'] };
  else if (!enabled) notice = { kind: 'paused', title: 'Reading is paused', body: 'Resume when you want the companion to follow your match again.', actions: ['resume'] };
  else if (!cardsVisible) {
    if (operational === 'paused') notice = { kind: 'auto-paused', title: 'Reading paused', body: message || 'Reading paused itself. Retry when the game has settled.', actions: ['retry'] };
    else if (operational === 'starting') notice = { kind: 'starting', title: 'Warming up', body: 'Starting the screen reader. Open Deadlock and keep it in front.', actions: [] };
    else if (operational === 'waiting-game') notice = { kind: 'waiting-game', title: 'Waiting for Deadlock', body: 'Launch the game. The companion starts following your match on its own.', actions: [] };
    else if (operational === 'interrupted') notice = { kind: 'background', title: 'Deadlock is in the background', body: message && !ROUTINE_WAIT_MESSAGES.has(message) && /preview/i.test(message) ? message : 'Click back into the game. Reading resumes once it is in front and uncovered.', actions: [] };
    else if (noProgress) notice = { kind: 'stalled', title: 'No new reading received', body: 'The reader has not finished a reading recently. Read again, or check the reading area if a draft is open.', actions: ['read-again', 'reading-area'] };
    else if (status === 'reading' && readingTimedOut) notice = { kind: 'unconfirmed', title: 'No current draft confirmed', body: 'Some cards could not be read. If a draft is open, read again or check the reading area. Mid-round, no choice is needed.', actions: ['read-again', 'reading-area'] };
    else if (status === 'reading') notice = { kind: 'reading', title: 'Checking for draft cards', body: 'A current draft has not been confirmed yet. Reading all three cards…', actions: [] };
    else if (staleReady) notice = { kind: 'stale', title: 'Waiting for a fresh reading', body: 'The last cards are too old to trust. Keep the draft visible, or read again.', actions: ['read-again', 'reading-area'] };
    else if (context?.viewMode === 'spectator') notice = { kind: 'spectator', title: 'Spectating', body: 'Picks and your build return when your own game view is back.', actions: [] };
    else if (finished) notice = { kind: 'finished', title: 'Match complete', body: 'Builds from the last match stay below until the next one begins.', actions: [] };
    else if (message && !ROUTINE_WAIT_MESSAGES.has(message) && status === 'waiting-draft') notice = { kind: 'source', title: 'Watching for item choices', body: message, actions: [] };
    else if (hasMatchData) notice = { kind: 'between', title: 'Between item choices', body: 'Your next draft appears here the moment it opens.', actions: [], tip: 'tab' };
    else notice = { kind: 'idle', title: 'Watching for your match', body: 'Item choices appear here automatically during a Street Brawl draft.', actions: [], tip: 'tab' };
  } else if (!confirmed) {
    notice = readingTimedOut
      ? { kind: 'unconfirmed', title: 'No current draft confirmed', body: 'Some cards could not be read. Read again or check the reading area.', actions: ['read-again', 'reading-area'] }
      : { kind: 'reading', title: 'Checking for draft cards', body: 'A current draft has not been confirmed yet. Confirming the cards…', actions: [] };
  }

  const holding = cardsVisible && (operational === 'interrupted' || operational === 'starting' || operational === 'waiting-game');
  let tone: Tone; let label: string;
  if (operational === 'unavailable') { tone = 'off'; label = 'Reader offline'; }
  else if (!enabled) { tone = 'off'; label = 'Paused'; }
  else if (operational === 'paused') { tone = 'warn'; label = 'Paused'; }
  else if (operational === 'starting') { tone = 'idle'; label = 'Starting'; }
  else if (operational === 'waiting-game') { tone = 'idle'; label = 'Waiting for game'; }
  else if (operational === 'interrupted') { tone = holding ? 'ready' : 'warn'; label = holding ? 'Holding cards' : 'Game in background'; }
  else if (noProgress) { tone = 'warn'; label = 'No new reading'; }
  else if (call) { tone = 'ready'; label = 'Cards read'; }
  else if (cardsVisible || status === 'reading') { tone = 'live'; label = readingTimedOut ? 'Unconfirmed' : 'Reading cards'; }
  else { tone = 'live'; label = 'Watching'; }

  const scores = context?.scores ?? null;
  const sideKnown = context?.viewMode === 'participant' && context.localTeam !== null;
  const own = sideKnown ? context!.localTeam! : 0;
  return {
    status: { tone, label },
    stage: call ? 'call' : cardsVisible ? 'cards' : 'notice',
    cards, call, notice, holding,
    match: { round: context?.round ?? null, rerollsLeft,
      scores: scores ? { ours: scores[own], theirs: scores[own === 0 ? 1 : 0], labels: sideKnown ? ['You', 'Enemy'] : ['Left', 'Right'] } : null },
    me, teams, hasMatchData: hasMatchData || cardsVisible,
    lastReadAt: state?.observedAt ?? null,
    calibrationRequired: !!state?.calibrationRequired,
    readerRunning: !readerBlocked,
    canPause: !!state && status !== 'unavailable',
    automaticallyPaused: status === 'paused' && enabled,
  };
}
