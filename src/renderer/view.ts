import type { Catalog, CatalogHero, CatalogItem } from '../shared/types';
import type { ScreenAdvice, ScreenOffer, ScreenReaderState } from '../shared/screen-reading';
import { cardHoldMs, SCREEN_CONTEXT_MAX_AGE_MS } from '../shared/screen-reading';
import { draftTierOf, upcomingDraftTiers } from '../shared/draft-tiers';
import { enemyThreat } from '../shared/enemy-threat';
import type { EnemyThreat } from '../shared/enemy-threat';
import { indexCatalog, POSITION_NAMES, ROMAN } from './catalog-index';
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
/**
 * Where a card stands in its tier pool for your hero and these enemies: its edge in win-rate points
 * over the average card of the tier, and its rank in that pool (0-100, higher is better).
 */
export interface Standing { edge: number; percentile: number | null; tier: number | null }
/** A counter line on a card: it beats (up) or suffers against (down) the named enemies. */
export interface CounterMark { tone: 'up' | 'down'; enemies: string[]; text: string }
export interface Notice { kind: NoticeKind; title: string; body: string; actions: NoticeAction[]; tip?: 'tab' }

export interface CardView {
  position: number;
  label: string;
  offer: ScreenOffer | null;
  item: CatalogItem | undefined;
  name: string;
  category: CatalogItem['category'];
  tier: number | null;
  /** 1–5 fit: from the card's rank in its tier pool, or relative to the visible cards without one; null when unscored. */
  fit: number | null;
  standing: Standing | null;
  counter: CounterMark | null;
  isPick: boolean;
  isConsider: boolean;
  /** The card to take if you decide not to reroll. */
  isFallback: boolean;
  stat: WinStat | null;
  note: string | null;
  identified: boolean;
  tags: string[];
  /** Free "Bonus!" items bundled on the card; `pending` when the card has one that was not identified. */
  bonus: BonusView;
}
export interface BonusView { items: { id: string; item: CatalogItem | undefined }[]; pending: boolean; absorbs: string[] }

export function bonusView(offer: ScreenOffer | null, index: CatalogIndex): BonusView {
  const items = (offer?.bonusIds ?? []).map((id) => ({ id, item: index.item(id) }));
  return { items, pending: !!offer?.bonusExpected && offer.bonusIds === null,
    absorbs: (offer?.absorbsIds ?? []).map((id) => index.item(id)?.name ?? id) };
}

export interface CallView {
  kind: CallKind;
  position: number;
  positionLabel: string;
  item: CatalogItem;
  offer: ScreenOffer;
  stat: WinStat | null;
  standing: Standing | null;
  counter: CounterMark | null;
  reasons: Reason[];
  moreReasons: Reason[];
  imbue: { ability: AbilityLabel | null; abilityName: string; why: string } | null;
  caveat: string | null;
  reroll: { suggested: boolean; text: string; left: number | null };
  facts: NonNullable<ScreenAdvice['factsUsed']>;
  limitations: string[];
  bonus: BonusView;
}

export type MatchupTone = 'hard' | 'even' | 'good';
export interface MatchupView { winRate: number; delta: number; games: number; tone: MatchupTone }
export interface SeatView { seat: number; hero: CatalogHero | undefined; heroId: string | null; items: ItemRef[]; isLocal: boolean; matchup?: MatchupView | null }
export interface ItemRef { id: string; item: CatalogItem | undefined }
/** One upgrade tier of an ability: bought, the next one to take, or its place in the plan (step 2 = the one after next). */
export interface LevelCell { tier: number; cost: number; state: 'owned' | 'next' | 'planned' | 'open'; step: number | null; affordable: boolean }
export interface AbilityView { slot: number; label: AbilityLabel | null; name: string; rank: number | null; isNext: boolean; cells: LevelCell[] }
/** `spend`: the unspent points buy the next step now; `title` is the one-line prompt, `detail` the steps after it. */
export interface AbilityStep { spend: boolean; points: number | null; title: string; detail: string | null }
export interface PlanView { slot: number; ability: string; tier: number; cost: number | null; reason: string; then: string[]; winRate: number | null; games: number; path?: number[] }
export interface WishView { id: string; item: CatalogItem | undefined; winRate: number | null; counters: string[]; valve: boolean }
export interface InsightsView {
  heroWinRate: number | null;
  /** Toughest identified matchup when it is clearly below your average. */
  toughest: { hero: CatalogHero | undefined; winRate: number } | null;
  /** The tier of the draft on screen (or the next draft) and the tier after it; `label` says which. */
  wishlist: { tier: number; items: WishView[]; current: boolean; label: string }[];
  /** The best items of the tier on screen that this draft did not offer: what a reroll can bring. */
  hopes: WishView[];
}

export interface CompanionView {
  status: { tone: Tone; label: string };
  stage: 'call' | 'cards' | 'notice';
  cards: CardView[] | null;
  call: CallView | null;
  notice: Notice | null;
  /** True while shown cards are being held although the game is not in front. */
  holding: boolean;
  /** `choice`: which of the round's three item choices is open ("Choice N of 3"), only during a draft. */
  match: { round: number | null; scores: { ours: number; theirs: number; labels: [string, string] } | null; rerollsLeft: number | null; choice: number | null };
  me: { hero: CatalogHero | undefined; items: ItemRef[]; abilities: AbilityView[]; ranksKnown: boolean; plan: PlanView | null;
    /** The next ability step in one line ("Spend 6 AP: Sleep Dagger III"), null without a plan. */
    step: AbilityStep | null;
    /** Unspent ability points from the HUD, when recently read; and how many planned upgrades they buy right now. */
    points: number | null; affordableSteps: number;
    /** The three planned upgrades after the next one, in order. */
    upcoming: { step: number; slot: number; name: string; tier: number; label: AbilityLabel | null }[] };
  teams: { known: boolean; ours: SeatView[]; theirs: SeatView[]; hiddenEnemyItems: number;
    /** Enemy damage mix, healing, control and what to prioritise; null until an enemy is identified. */
    threat: EnemyThreat | null };
  insights: InsightsView | null;
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

/** Cards are held for the hold window after their last confirming read (longer while the game is in the background), never from the future. */
export function cardsFresh(state: ScreenReaderState | null, now: number) {
  const at = state?.observedAt ?? null;
  return !!state && state.enabled && (state.status === 'ready' || state.status === 'reading')
    && at !== null && at <= now && now - at < cardHoldMs(state);
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
  if (COUNTER_UP.test(text)) return 'counter';
  if (COUNTER_DOWN.test(text) || /^(Requires manual|Some benefits require)/.test(text)) return 'concern';
  if (/^(Matches observed|Your build|You already own|Complements|Fills)/.test(text)) return 'build';
  return 'text';
}

const COUNTER_UP = /^(?:Counters |Does well against |Wins more against )/;
const COUNTER_DOWN = /^(?:Weak against |Countered by |Does poorly against |Wins less against )/;

/** The enemies named in a counter line ("Counters Lady Geist (+2.1) and Infernus (+1.6)."), null for any other line. */
export function parseCounter(text: string): CounterMark | null {
  const tone = COUNTER_UP.test(text) ? 'up' : COUNTER_DOWN.test(text) ? 'down' : null;
  if (!tone) return null;
  const list = text.replace(tone === 'up' ? COUNTER_UP : COUNTER_DOWN, '').split(/:\s|\.$/)[0]!;
  const enemies = list.split(/,\s*|\s+and\s+/).map((name) => name.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+\d+%$/, '').trim()).filter(Boolean);
  return enemies.length ? { tone, enemies, text } : null;
}

/** "+2.4", "−1.3", "0.0": an edge in win-rate points. */
export function formatEdge(edge: number): string {
  const rounded = Math.round(edge * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)}` : rounded < 0 ? `−${Math.abs(rounded).toFixed(1)}` : '0.0';
}

/** "Top 8% of tier II" or "Bottom 30% of tier II". */
export function percentileLabel(standing: Standing): string | null {
  if (standing.percentile === null) return null;
  const tier = standing.tier ? ` of tier ${ROMAN[standing.tier] ?? standing.tier}` : '';
  return standing.percentile >= 50 ? `Top ${Math.max(1, 100 - standing.percentile)}%${tier}` : `Bottom ${Math.max(1, standing.percentile)}%${tier}`;
}

export const capitalise = (text: string) => text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;

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

/** Matchups of 3 points or more against your average are worth a colour; smaller ones read as even. */
const MATCHUP_TONE_DELTA = 0.03;
export function matchupTone(delta: number): MatchupTone {
  return delta <= -MATCHUP_TONE_DELTA ? 'hard' : delta >= MATCHUP_TONE_DELTA ? 'good' : 'even';
}

function deriveTeams(state: ScreenReaderState, index: CatalogIndex, localHeroId: string | null) {
  const roster = state.roster;
  const seatItems = state.build?.seatItems ?? [];
  const hiddenEnemyItems = state.build?.hiddenEnemyItems ?? 0;
  const insights = state.insights && state.insights.heroId === localHeroId ? state.insights : null;
  const withMatchup = (seat: SeatView): SeatView => {
    const stat = seat.heroId ? insights?.matchups.find((entry) => entry.heroId === seat.heroId) : undefined;
    return stat ? { ...seat, matchup: { winRate: stat.winRate, delta: stat.delta, games: stat.matches, tone: matchupTone(stat.delta) } } : seat;
  };
  if (roster && roster.seats.some((hero) => hero !== null)) {
    const side = roster.localSide;
    const seats = roster.seats.map((heroId, seat) => resolveSeat(index, seat, heroId, seatItems[seat] ?? [], localHeroId, side));
    const left = seats.slice(0, 4), right = seats.slice(4, 8);
    const theirs = side === 1 ? left : right;
    return withThreat({ known: side !== null, ours: side === 1 ? right : left, theirs: side === null ? theirs : theirs.map(withMatchup), hiddenEnemyItems });
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
    return withThreat({ known: context.viewMode === 'participant' && context.localTeam !== null, ours, theirs, hiddenEnemyItems });
  }
  return { known: false, ours: [], theirs: [], hiddenEnemyItems, threat: null };
}

/** The enemy threat summary, once your side is known and an enemy hero is identified. */
function withThreat(teams: Omit<CompanionView['teams'], 'threat'>): CompanionView['teams'] {
  const heroes = teams.known ? teams.theirs.map((seat) => seat.hero).filter((hero): hero is CatalogHero => !!hero) : [];
  const items = teams.theirs.flatMap((seat) => seat.items.map((ref) => ref.item)).filter((item): item is CatalogItem => !!item);
  return { ...teams, threat: heroes.length ? enemyThreat(heroes, items) : null };
}

function deriveMe(state: ScreenReaderState, index: CatalogIndex, heroId: string | null, teams: ReturnType<typeof deriveTeams>, now: number) {
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
  const points = freshAbilityPoints(state, now);
  const { cells, affordableSteps } = levelCells(ranks, plan?.path ?? (plan ? [plan.slot] : []), points);
  const abilities: AbilityView[] = [0, 1, 2, 3].map((slot) => ({ slot, label: labels[slot] ?? null, name: labels[slot]?.name ?? `Ability ${slot + 1}`,
    rank: ranks[slot] ?? null, isNext: plan?.slot === slot, cells: cells[slot]! }));
  // The three upgrades after the next one, with their tiers ("Fixation II").
  const upcoming = abilities.flatMap((ability) => ability.cells.filter((cell) => cell.state === 'planned' && cell.step !== null && cell.step <= 4)
    .map((cell) => ({ step: cell.step!, slot: ability.slot, name: ability.name, tier: cell.tier, label: ability.label }))).sort((a, b) => a.step - b.step);
  return { hero, items: itemIds.map((id) => ({ id, item: index.item(id) })), abilities, ranksKnown: ranks.some((rank) => rank !== null), plan,
    step: abilityStep(plan, abilities, points), points, affordableSteps, upcoming };
}

/**
 * The next ability step in one line. With unspent points that pay for it: "Spend 6 AP: Fixation I,
 * Fixation II, Sleep Dagger II" (every planned step those points buy, in order); otherwise the next
 * upgrade and its cost. `detail` names the planned steps after those.
 */
export function abilityStep(plan: PlanView | null, abilities: AbilityView[], points: number | null): AbilityStep | null {
  if (!plan) return null;
  const steps = abilities.flatMap((ability) => ability.cells.filter((cell) => cell.step !== null && (cell.state === 'next' || cell.state === 'planned'))
    .map((cell) => ({ ...cell, name: `${ability.name} ${ROMAN[cell.tier] ?? cell.tier}` }))).sort((a, b) => a.step! - b.step!);
  const label = `${plan.ability} ${ROMAN[plan.tier] ?? plan.tier}`;
  const bought = steps.filter((cell) => cell.affordable);
  if (points !== null && bought.length) {
    // The affordable steps lead the plan, so the steps named here are its first ones; the AP total covers
    // exactly those, and "Then" continues straight after the last one named.
    const named = bought.slice(0, 3);
    const total = named.reduce((sum, cell) => sum + cell.cost, 0);
    const later = steps.slice(named.length, named.length + 2).map((cell) => cell.name);
    return { spend: true, points: total, title: `Spend ${total} AP: ${named.map((cell) => cell.name).join(', ')}`,
      detail: later.length ? `Then ${later.join(', ')}` : null };
  }
  const later = steps.slice(1, 3).map((cell) => cell.name);
  return { spend: false, points, title: `Next: ${label}${plan.cost !== null ? ` · ${plan.cost} AP` : ''}`, detail: later.length ? `Then ${later.join(', ')}` : null };
}

/** Tier costs bottom to top on the upgrade panel. */
export const TIER_COSTS = [1, 2, 5] as const;
/** The HUD's unspent-points counter is trusted for this long after it was read. */
export const ABILITY_POINTS_MAX_AGE_MS = 45_000;

function freshAbilityPoints(state: ScreenReaderState, now: number): number | null {
  const read = state.abilityPoints;
  return read && Number.isInteger(read.value) && read.value >= 0 && read.at <= now && now - read.at < ABILITY_POINTS_MAX_AGE_MS ? read.value : null;
}

/**
 * The upgrade grid: for each ability its three tiers, marked bought, next, or with their place in
 * the plan. With unspent points known, the planned steps those points pay for right now are marked.
 */
export function levelCells(ranks: readonly (number | null)[], path: readonly number[], points: number | null) {
  const cells: LevelCell[][] = [0, 1, 2, 3].map((slot) => TIER_COSTS.map((cost, index) => ({ tier: index + 1, cost,
    state: ranks[slot] != null && index < ranks[slot]! ? 'owned' as const : 'open' as const, step: null, affordable: false })));
  const reached = ranks.map((rank) => rank ?? 0);
  let budget = points ?? 0; let affordableSteps = 0; let paying = points !== null;
  path.forEach((slot, step) => {
    const tier = reached[slot]!;
    const cell = cells[slot]?.[tier];
    if (!cell || cell.state === 'owned') return;
    cell.state = step === 0 ? 'next' : 'planned'; cell.step = step + 1;
    if (paying && budget >= cell.cost) { budget -= cell.cost; cell.affordable = true; affordableSteps++; } else paying = false;
    reached[slot] = tier + 1;
  });
  return { cells, affordableSteps };
}

/** The tier of the cards on screen, a RARE card counted at its choice's tier (the pick logic's rule). */
function screenDraftTier(offers: readonly ScreenOffer[], index: CatalogIndex): number | null {
  return draftTierOf(offers.map((offer) => ({ tier: index.item(offer.itemId)?.tier ?? null, rare: offer.rare })));
}

type RankedEntry = ScreenAdvice['ranked'][number];
function standingOf(entry: RankedEntry | undefined, tier: number | null): Standing | null {
  return entry && typeof entry.edge === 'number' && Number.isFinite(entry.edge)
    ? { edge: entry.edge, percentile: typeof entry.tierPercentile === 'number' && Number.isFinite(entry.tierPercentile) ? Math.max(0, Math.min(100, entry.tierPercentile)) : null, tier }
    : null;
}
/** A card's strongest counter line: a counter it brings first, else a weakness. */
function counterOf(reasons: readonly string[] | undefined): CounterMark | null {
  const marks = (reasons ?? []).map(parseCounter).filter((mark): mark is CounterMark => !!mark);
  return marks.find((mark) => mark.tone === 'up') ?? marks[0] ?? null;
}

function deriveCards(state: ScreenReaderState, index: CatalogIndex, advice: ScreenAdvice | null, call: CallView | null): CardView[] {
  const marked = (kind: 'pick' | 'consider' | 'fallback') => call && (kind === 'pick' ? call.kind === 'pick' || call.kind === 'close' : kind === 'consider' ? call.kind === 'consider' : call.kind === 'reroll') ? call.position : null;
  const pick = marked('pick'), consider = marked('consider'), fallback = marked('fallback');
  const offers = state.offers.slice().sort((a, b) => a.position - b.position);
  const ranked = advice?.ranked ?? [];
  const tier = screenDraftTier(offers, index);
  const scored = ranked.filter((entry) => index.item(offers.find((offer) => offer.position === entry.position)?.itemId));
  const scores = scored.map((entry) => entry.score);
  const min = Math.min(...scores), max = Math.max(...scores);
  // Fit is absolute (the card's rank in its tier pool) when every scored card has one; otherwise relative to the cards shown.
  const absolute = scored.length > 0 && scored.every((entry) => typeof entry.tierPercentile === 'number' && Number.isFinite(entry.tierPercentile));
  return [0, 1, 2].map((position) => {
    const offer = offers.find((entry) => entry.position === position) ?? null;
    const item = index.item(offer?.itemId);
    const entry = ranked.find((candidate) => candidate.position === position);
    const fit = !entry || !item || !scores.length ? null
      : absolute ? 1 + Math.round(Math.max(0, Math.min(100, entry.tierPercentile!)) / 25)
        : max - min < 1e-6 ? 3 : 1 + Math.round(((entry.score - min) / (max - min)) * 4);
    const stat = parseWinStat(entry?.reasons.find((reason) => WIN_STAT.test(reason)));
    const note = entry?.reasons.find((reason) => !WIN_STAT.test(reason) && !/^Imbue it on /.test(reason)) ?? offer?.warning ?? null;
    const tags: string[] = [];
    if (offer?.rare) tags.push('Rare');
    if (offer && offer.variant !== 'base' && offer.variant !== 'unknown') tags.push(offer.variant[0]!.toUpperCase() + offer.variant.slice(1));
    if (offer && offer.variant === 'unknown') tags.push('Variant not read');
    const bonus = bonusView(offer, index);
    // Until your own items are read, no card can be proven bonus-free; tagging every card said nothing.
    if (offer && (offer.bonusExpected || offer.bonusIds?.length)) tags.push('Bonus');
    // A card whose name is not read yet (an animation or a tooltip over it) is shown as being read,
    // never as "Ambiguous item name" or "Unread item choice".
    return { position, label: POSITION_NAMES[position]!, offer, item, name: offer ? item?.name ?? 'Reading…' : 'Awaiting card',
      category: item?.category ?? 'unknown', tier: item?.tier ?? null, fit, standing: item ? standingOf(entry, tier) : null, counter: item ? counterOf(entry?.reasons) : null,
      isPick: pick === position, isConsider: consider === position, isFallback: fallback === position,
      stat, note, identified: !!item, tags, bonus };
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
  const entry = advice.ranked.find((candidate) => candidate.position === offer.position);
  return { kind, position: offer.position, positionLabel: POSITION_NAMES[offer.position] ?? 'Unknown', item: index.item(offer.itemId)!, offer,
    stat: parseWinStat(statReason?.text), standing: standingOf(entry, screenDraftTier(offers, index)), counter: counterOf(entry?.reasons ?? advice.reasons),
    reasons: rest.slice(0, 3), moreReasons: rest.slice(3), imbue,
    caveat: advice.caveat ?? null, reroll: { suggested: !!advice.rerollSuggested, text: advice.rerollReason, left: rerollsLeft },
    facts: advice.factsUsed ?? [], limitations: advice.limitations, bonus: bonusView(offer, index) };
}

/** A matchup this far below your hero's average is called out as the toughest enemy. */
const TOUGHEST_DELTA = -0.04;

/**
 * The tiers worth hoping for: the draft on screen (or the next draft) and the next different tier
 * after it, from Valve's per-round choice tiers. With the cards on screen their own tier leads.
 * Between drafts the next draft is the next round's first choice. Unknown round: every tier.
 */
export function hopeTiers(context: { round: number | null; phase: string; pickStage: number | null } | null, screenTier: number | null): { tier: number; label: string }[] | null {
  const round = context?.round ?? null;
  const drafting = screenTier !== null || context?.phase === 'draft';
  const upcoming = round === null ? [] : drafting ? upcomingDraftTiers(round, context?.pickStage ?? 1) : upcomingDraftTiers(round + 1, 1);
  const current = screenTier ?? upcoming[0] ?? null;
  if (current === null) return null;
  const next = upcoming.find((tier) => tier !== current) ?? null;
  const here = screenTier !== null ? 'This draft' : 'Next draft';
  return [{ tier: current, label: here }, ...(next !== null ? [{ tier: next, label: 'Later' }] : [])];
}

function deriveInsights(state: ScreenReaderState, index: CatalogIndex, heroId: string | null, cards: CardView[] | null): InsightsView | null {
  const insights = state.insights;
  if (!insights || !heroId || insights.heroId !== heroId) return null;
  // The tier of the cards on screen (a RARE card counted at its choice's tier) marks the row for this draft.
  const draftTier = cards ? screenDraftTier(cards.map((card) => card.offer).filter((offer): offer is ScreenOffer => !!offer), index) : null;
  const tiers = hopeTiers(state.matchContext, draftTier);
  const worst = insights.matchups[0];
  const offered = new Set((cards ?? []).map((card) => card.item?.id).filter((id): id is string => !!id));
  const rows = insights.wishlist.map((row) => ({ tier: row.tier,
    items: row.items.map((entry): WishView => ({ id: entry.itemId, item: index.item(entry.itemId), winRate: entry.winRate, valve: entry.valve,
      counters: entry.counters.map((id) => index.hero(id)?.name ?? id) })) }));
  const wishlist = tiers
    ? tiers.flatMap(({ tier, label }, order) => rows.filter((row) => row.tier === tier).map((row) => ({ ...row, current: order === 0, label })))
    : rows.map((row) => ({ ...row, current: false, label: '' }));
  return {
    heroWinRate: insights.heroWinRate,
    toughest: worst && worst.delta <= TOUGHEST_DELTA ? { hero: index.hero(worst.heroId), winRate: worst.winRate } : null,
    wishlist,
    hopes: draftTier === null ? [] : (wishlist.find((row) => row.current)?.items ?? []).filter((entry) => !offered.has(entry.id)),
  };
}

/**
 * Your hero. The roster tracker is authoritative once it reports: it never takes a hideout hero and
 * starts over for each match, so a hideout or previous-match hero must not stand in for it. The
 * HUD-proven match-context hero is used only while the roster has not named one yet and only when
 * it was observed during the current match, then the hero the shown draft cards were read with
 * (mirrors currentLocalHero in screen/draft-roster.ts).
 */
export function localHeroFor(state: ScreenReaderState | null): string | null {
  const roster = state?.roster; const context = state?.matchContext;
  if (!roster) return state?.heroId ?? context?.localHeroId ?? null;
  if (roster.localHeroId) return roster.localHeroId;
  if (roster.phase === 'outside') return null;
  const since = roster.since ?? null; const seenAt = context?.observations.localHeroId?.capturedAt ?? null;
  const fresh = context?.localHeroId && since !== null && seenAt !== null && seenAt >= since ? context.localHeroId : null;
  // state.heroId belongs to the cards on screen and is cleared with them.
  return fresh ?? state?.heroId ?? null;
}

/** "Choice N of 3" while a draft is open (read with the draft's cards or its phase), else null. */
function draftChoice(context: ScreenReaderState['matchContext'] | null, cardsVisible: boolean): number | null {
  const stage = context?.pickStage ?? null;
  return stage !== null && Number.isInteger(stage) && stage >= 1 && stage <= 3 && (cardsVisible || context?.phase === 'draft') ? stage : null;
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
  const heroId = localHeroFor(state);
  const rerollsLeft = state?.rerollsLeft ?? context?.rerollsRemaining ?? null;
  const call = advice ? deriveCall(state!, index, advice, offers, heroId, rerollsLeft) : null;
  const cards = cardsVisible ? deriveCards(state!, index, advice, call) : null;

  const readerBlocked = !expectsGameReads(state);
  const noProgress = readProgressTimedOut(state, clock.lastProgressAt, now);
  const readingTimedOut = status === 'reading' && enabled && clock.readingSince !== null && now - clock.readingSince >= READING_CONFIRM_TIMEOUT_MS;
  const staleReady = status === 'ready' && !cardsVisible;
  const teams = state ? deriveTeams(state, index, heroId) : { known: false, ours: [], theirs: [], hiddenEnemyItems: 0, threat: null };
  const me = state ? deriveMe(state, index, heroId, teams, now) : { hero: undefined, items: [], abilities: [], ranksKnown: false, plan: null, step: null, points: null, affordableSteps: 0, upcoming: [] };
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
    else if (context?.viewMode === 'spectator') notice = { kind: 'spectator', title: 'Spectating', body: 'You are dead or watching another player. Picks return when your own view is back.', actions: [] };
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
    match: { round: context?.round ?? null, rerollsLeft, choice: draftChoice(context, cardsVisible),
      scores: scores ? { ours: scores[own], theirs: scores[own === 0 ? 1 : 0], labels: sideKnown ? ['You', 'Enemy'] : ['Left', 'Right'] } : null },
    me, teams, insights: state ? deriveInsights(state, index, heroId, cards) : null, hasMatchData: hasMatchData || cardsVisible,
    lastReadAt: state?.observedAt ?? null,
    calibrationRequired: !!state?.calibrationRequired,
    readerRunning: !readerBlocked,
    canPause: !!state && status !== 'unavailable',
    automaticallyPaused: status === 'paused' && enabled,
  };
}
