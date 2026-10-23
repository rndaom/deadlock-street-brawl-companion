import type { Catalog } from './types';

/** Visible game-client coordinates, normalized from 0 to 1. Never desktop coordinates. */
export interface CaptureRegion { x: number; y: number; width: number; height: number }
export const DEFAULT_CAPTURE_REGION: Readonly<CaptureRegion> = Object.freeze({ x: 0.02, y: 0.08, width: 0.96, height: 0.84 });
/** A capture must still describe the game when its reply arrives. Real reads on one
 * background core take 0.2-1.5 s while the game runs, so this must exceed a slow read. */
export const SCREEN_CAPTURE_FRESHNESS_MS = 4_000;
/** Read draft cards stay on screen this long without a fresh confirming read. The draft
 * closing (no "Select Items" cue on two reads) clears them sooner. */
export const SCREEN_CARD_HOLD_MS = 10_000;
/** While Deadlock is in the background (the player alt-tabbed to the companion), nothing can be
 * re-read, so the cards from the last look stay up longer. Reads resume when the game is in front. */
export const SCREEN_CARD_BACKGROUND_HOLD_MS = 60_000;
/** How long shown cards stay up without a confirming read in this reader state. */
export function cardHoldMs(state: { gamePresent: boolean; foreground: boolean }): number {
  return state.gamePresent && !state.foreground ? SCREEN_CARD_BACKGROUND_HOLD_MS : SCREEN_CARD_HOLD_MS;
}
/** Recommendation snapshot age, not proof that a hidden loadout has stayed unchanged. */
export const SCREEN_CONTEXT_MAX_AGE_MS = 30_000;
/** Inventory cell mapping epoch, never a player or match identity. */
export function isScreenLayoutId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export interface NativeOcrWord { text: string; bounds: CaptureRegion }
export interface NativeOcrBlock {
  text: string;
  /** Native bounds remain relative to the complete game client, even for a cropped scan. */
  bounds?: CaptureRegion;
  x: number; y: number; width: number; height: number;
  words?: NativeOcrWord[];
}
export interface NativeIconMatch {
  itemId: string; confidence: number; bounds: CaptureRegion;
  role?: 'bonus'; slot?: 0 | 1;
}
export type ScreenCompleteness = 'unknown' | 'partial' | 'complete';
export type ScreenMatchPhase = 'unknown' | 'draft' | 'combat' | 'finished';
export type ScreenViewMode = 'participant' | 'spectator' | 'unknown';
/** Relative visible sides: 0 is allied, 1 is opposing. Never an inferred Valve team ID. */
export type ScreenTeam = 0 | 1;
export interface NativeContextHero {
  heroId: string | null; status: 'recognized' | 'unknown' | 'hidden'; confidence: number; bounds: CaptureRegion;
  seat?: number; team?: ScreenTeam | null; isLocal?: boolean; role: 'roster' | 'local';
}
export interface NativeContextItem {
  itemId: string | null; status: 'recognized' | 'unknown' | 'empty' | 'hidden'; confidence: number; bounds: CaptureRegion;
  seat?: number; slot: number; role: 'local-inventory' | 'player-inventory';
  variant?: ScreenOffer['variant'];
  quantity?: number | null;
}
export interface NativeContextAbility {
  slot: 0 | 1 | 2 | 3; rank: number | null; unlocked: boolean | null; confidence: number; bounds: CaptureRegion;
  nextUpgradeCost?: number | null;
}
export interface NativeContextRegion {
  kind: 'roster' | 'local-hero' | 'inventory' | 'abilities' | 'ability-points' | 'scoreboard'; bounds: CaptureRegion;
  seat?: number; slotCount?: number; complete: boolean;
  /** Reproved mapping changes receive a new opaque epoch; unread geometry omits it. */
  layoutId?: string;
}
export interface NativeScreenContext {
  /** Opaque game-window session, not a match ID, PID, or player identity. */
  sessionId?: string;
  panel: 'hud' | 'scoreboard' | 'draft' | 'post-match' | 'unknown';
  /** Explicit HUD/participant proof; a spectator target is never the local player. */
  viewMode?: ScreenViewMode;
  heroes: NativeContextHero[]; items: NativeContextItem[]; abilities: NativeContextAbility[]; regions: NativeContextRegion[];
  abilityPoints?: { value: number | null; confidence: number; bounds: CaptureRegion };
  /** Street Brawl fixed-layout reads: own inventory, scoreboard items per seat, ability upgrade bars. */
  brawl?: NativeBrawlLayout;
}
export interface NativeBrawlLayout {
  myItems: { slot: number; itemId: string; confidence: number }[];
  /** Own inventory cells that hold an icon (recognized or not, e.g. a cooldown-dimmed active); null when the grid was not read. */
  myOccupied?: number | null;
  /** Seat 0-3 left team, 4-7 right team on the scoreboard. */
  playerItems: { seat: number; slot: number; itemId: string; confidence: number }[];
  /** Purchased upgrade tiers (0-3) per ability slot when the upgrade panel is visible; null for a column
   * covered by the cursor or a tooltip. */
  abilityRanks: (number | null)[] | null;
  hiddenItems: number;
  /** Round wins as filled pips under the "ROUND N" title: [left team, right team]; null when not read. */
  roundPips?: [number, number] | null;
}
export interface NativeReadResult {
  protocol: 1; id: string; status: string;
  gamePresent: boolean; foreground: boolean;
  clientWidth: number; clientHeight: number;
  /** Screen position of the game client in physical pixels; null when no game window is known. */
  clientLeft?: number | null; clientTop?: number | null;
  capturedAt: number | null; elapsedMs: number; hash: string | null;
  blocks: NativeOcrBlock[]; icons?: NativeIconMatch[]; context?: NativeScreenContext;
  crop?: CaptureRegion; ocrAvailable?: boolean; ocrLanguage?: string | null;
  errorCode?: string | null; previewPng?: string | null;
  metrics?: { cpuMs?: number; privateMemoryMb?: number; workingSetMb?: number; captureMs?: number; ocrMs?: number; unchanged?: boolean };
}

export interface ScreenContextObservation {
  /** Coordinator epoch and fresh native reply ID prevent mixed-session hydration. */
  sessionId: string; frameId: string; capturedAt: number; receivedAt: number;
  method: 'visible-text' | 'portrait' | 'item-icon' | 'ability-pips' | 'layout-association';
  confidence: number; bounds: CaptureRegion[];
  /** Only an explicitly read round is attached; never the configured schedule. */
  round?: number | null;
  /** First changed/most recent confirmed visible observation, not game-event time. */
  changedAt?: number | null; confirmedAt?: number | null;
  /** Later visible evidence invalidated this snapshot; its original capture remains intact. */
  invalidatedAt?: number | null;
  /** Positive inventory-region mapping proof shared by its aggregate and cells. */
  layoutId?: string;
}
export interface ScreenInventoryItem {
  slot: number; itemId: string | null; variant: ScreenOffer['variant']; bonusIds: string[] | null;
  status?: 'recognized' | 'unknown' | 'empty' | 'hidden';
  observation: ScreenContextObservation;
  quantity?: number | null;
}
export interface ScreenAbilityState {
  slot: 0 | 1 | 2 | 3; abilityId: string | null; rank: number | null; unlocked: boolean | null;
  nextUpgradeCost?: number | null;
  observation: ScreenContextObservation;
}
export interface ScreenObservedPlayer {
  /** One of the eight observed Street Brawl UI columns (0..7), not a server entity index. */
  seat: number; team: ScreenTeam | null; heroId: string | null; isLocal: boolean | null;
  heroObservation: ScreenContextObservation | null; teamObservation: ScreenContextObservation | null;
  localObservation: ScreenContextObservation | null;
  inventory: ScreenInventoryItem[]; inventoryCompleteness: ScreenCompleteness;
  inventorySlotCompleteness?: ScreenCompleteness;
  inventoryObservation: ScreenContextObservation | null; inventoryRevision: number;
  inventoryRetiredLayoutIds?: string[];
}
export interface ScreenMatchFieldObservations {
  viewMode: ScreenContextObservation | null;
  matchId: ScreenContextObservation | null; phase: ScreenContextObservation | null;
  round: ScreenContextObservation | null; scores: ScreenContextObservation | null;
  localSeat: ScreenContextObservation | null; localHeroId: ScreenContextObservation | null; localTeam: ScreenContextObservation | null;
  localAbilityPoints: ScreenContextObservation | null; rerollsRemaining: ScreenContextObservation | null;
  rerollAvailable: ScreenContextObservation | null; pickStage: ScreenContextObservation | null; deadlineAt: ScreenContextObservation | null;
}
export interface ScreenMatchContext {
  revision: number; sessionId: string | null; gameSessionId: string | null;
  retiredSessionIds: string[]; retiredGameSessionIds: string[];
  viewMode: ScreenViewMode;
  /** Explicit visible match identifier only. Unknown IDs remain null. */
  matchId: string | null; phase: ScreenMatchPhase; round: number | null; scores: [number, number] | null;
  localSeat: number | null; localHeroId: string | null; localTeam: ScreenTeam | null;
  localAbilityPoints: number | null; rerollsRemaining: number | null; rerollAvailable: boolean | null;
  pickStage: number | null; deadlineAt: number | null;
  players: ScreenObservedPlayer[]; rosterCompleteness: ScreenCompleteness; rosterObservation: ScreenContextObservation | null;
  /** The own HUD can be observed before its roster position is established. */
  localInventory: ScreenInventoryItem[]; localInventoryCompleteness: ScreenCompleteness;
  localInventorySlotCompleteness?: ScreenCompleteness;
  localInventoryObservation: ScreenContextObservation | null; localInventoryRevision: number;
  localInventoryRetiredLayoutIds?: string[];
  localAbilities: ScreenAbilityState[]; abilityCompleteness: ScreenCompleteness; abilityObservation: ScreenContextObservation | null;
  abilityRevision: number; observations: ScreenMatchFieldObservations; lastObservedAt: number | null;
  /** Evidence behind the round number (only +1 steps, a new draft after combat, the round pips). */
  roundTracking?: ScreenRoundTracking;
}
export interface ScreenRoundTracking {
  /** A round read that skipped ahead (or restarted at 1), waiting for a second agreeing read. */
  candidate: number | null; candidateCount: number;
  /** A lower score read, waiting for repeated agreeing reads before it replaces the shown score. */
  scoreCandidate: [number, number] | null; scoreCandidateCount: number;
  /** Capture time of the latest draft frame, and the round in effect then. */
  lastDraftAt: number | null; roundAtLastDraft: number | null;
  /** Combat was seen well after the latest draft: the next "Choice 1 of 3" opens a new round. */
  combatSinceDraft: boolean;
  /** The round was advanced by a new draft rather than read ("ROUND N" not visible yet). */
  inferredAt: number | null;
}
export interface ScreenPlayerObservation {
  seat: number; team?: ScreenTeam | null; heroId?: string | null; isLocal?: boolean | null;
  heroObservation?: ScreenContextObservation | null; teamObservation?: ScreenContextObservation | null;
  localObservation?: ScreenContextObservation | null;
  inventory?: ScreenInventoryItem[]; inventoryCompleteness?: ScreenCompleteness;
  inventorySlotCompleteness?: ScreenCompleteness;
  inventoryObservation?: ScreenContextObservation | null;
}
export interface ScreenMatchObservation {
  sessionId: string; gameSessionId?: string | null; frameId: string; capturedAt: number; receivedAt: number;
  /** Positive source UI evidence only; absence of a readable crop is never a reset. */
  resetReason?: 'unsupported-layout' | 'outside-match'; resetObservation?: ScreenContextObservation | null;
  viewMode?: ScreenViewMode;
  matchId?: string | null; phase?: ScreenMatchPhase; round?: number | null; scores?: [number, number] | null;
  localSeat?: number | null; localHeroId?: string | null; localTeam?: ScreenTeam | null; fields?: Partial<ScreenMatchFieldObservations>;
  localAbilityPoints?: number | null; rerollsRemaining?: number | null; rerollAvailable?: boolean | null;
  pickStage?: number | null; deadlineAt?: number | null;
  players?: ScreenPlayerObservation[]; rosterCompleteness?: ScreenCompleteness; rosterObservation?: ScreenContextObservation | null;
  localInventory?: ScreenInventoryItem[]; localInventoryCompleteness?: ScreenCompleteness; localInventoryObservation?: ScreenContextObservation | null;
  localInventorySlotCompleteness?: ScreenCompleteness;
  localAbilities?: ScreenAbilityState[]; abilityCompleteness?: ScreenCompleteness; abilityObservation?: ScreenContextObservation | null;
}
export interface ScreenOffer {
  /** Zero-based game order: left, middle, right. */
  position: number; itemId: string; name: string;
  /** Null is unread/unknown bonus coverage; [] is a confirmed no-bonus card. */
  bonusIds: string[] | null;
  variant: 'base' | 'enhanced' | 'legendary' | 'corrupted' | 'unknown';
  /** The card showed "RARE!": a higher tier than this choice normally offers. */
  rare?: boolean;
  /** The card carries a free "Bonus!" item: its marker was read, or the item upgrades from one you own. */
  bonusExpected?: boolean;
  /** Owned items this upgrade absorbs when picked (they leave your inventory). */
  absorbsIds?: string[];
  confidence: number; warning: string | null;
  bounds?: CaptureRegion;
}
export interface ScreenAdvice {
  preferredPosition: number | null; title: string; reasons: string[]; limitations: string[];
  comparisonPosition?: number | null;
  comparisonBasis?: 'main-item-base-effects';
  /** edge: card value minus its tier pool's average, in win-rate points; tierPercentile: 0-100 rank in that pool. */
  ranked: { position: number; score: number; reasons: string[]; edge?: number; tierPercentile?: number }[];
  rerollReason: string;
  /** True when none of the read cards is worth taking and a reroll is available or unread. */
  rerollSuggested?: boolean;
  /** One short, player-facing warning about unread card details. */
  caveat?: string;
  /** For an imbue item: which of your abilities to put it on. */
  imbue?: string;
  factsUsed?: { scope: 'own' | 'ally' | 'enemy' | 'round' | 'catalog'; label: string; observedAt?: number; playerSeat?: number }[];
}
export interface ScreenAbilityAdvice {
  kind: 'upgrade' | 'plan' | 'withheld'; slot: 0 | 1 | 2 | 3 | null; abilityId: string | null;
  title: string; reasons: string[]; limitations: string[]; cost: number | null; availablePoints: number | null;
}
export interface ScreenReaderState {
  revision: number;
  status: 'starting' | 'waiting-game' | 'waiting-draft' | 'reading' | 'ready' | 'paused' | 'interrupted' | 'unavailable';
  enabled: boolean; message: string; engineReady: boolean; gamePresent: boolean; foreground: boolean;
  generation: number; offers: ScreenOffer[]; advice: ScreenAdvice | null;
  abilityAdvice: ScreenAbilityAdvice | null;
  heroId: string | null; observedAt: number | null; readMs: number | null;
  matchContext: ScreenMatchContext;
  crop: CaptureRegion; calibrationRequired: boolean;
  previewDataUrl?: string | null;
  metrics: { reads: number; skipped: number; timeouts: number; cpuPercent: number | null; memoryMb: number | null };
  /** Heroes in the current match from the top bar / scoreboard (see draft-roster.ts). */
  roster?: { seats: (string | null)[]; localHeroId: string | null; localSide: 0 | 1 | null; allies: string[]; enemies: string[];
    /** 'outside' = hideout/menus/queue (the last match stays shown), 'loading'/'match' = in a match, 'unknown' = not yet known. */
    phase?: 'unknown' | 'outside' | 'loading' | 'match';
    /** When the current match's evidence began (ms). */
    since?: number | null } | null;
  /** Rerolls left this round, from the draft text or counted from observed rerolls. */
  rerollsLeft?: number | null;
  /** Next ability upgrade from Street Brawl upgrade-order statistics (see ability-plan.ts). */
  abilityPlan?: { slot: number; ability: string; tier: number; cost: number; winRate: number | null; games: number; then: string[]; path?: number[]; reason: string } | null;
  /** Items and ability ranks read this match (see build-tracker.ts). */
  build?: { myItems: string[]; seatItems: string[][]; abilityRanks: (number | null)[] | null; hiddenEnemyItems: number } | null;
  /** The game client rectangle on screen (physical pixels), for the in-game overlay. */
  gameBounds?: { x: number; y: number; width: number; height: number } | null;
  /** Matchups against the identified enemies and the items to hope for in drafts (see match-insights.ts). */
  insights?: MatchInsights | null;
  /** Unspent ability points last read from the HUD, and when. */
  abilityPoints?: { value: number; at: number } | null;
}
export interface MatchupInsight { heroId: string; winRate: number; delta: number; matches: number }
export interface WishlistInsight { itemId: string; tier: number; winRate: number | null; counters: string[]; valve: boolean }
export interface MatchInsights {
  heroId: string; heroWinRate: number | null; heroGames: number;
  /** One entry per identified enemy that has enough games, toughest first. */
  matchups: MatchupInsight[];
  /** Best items not owned yet for this hero against this enemy team, compared within each shop tier. */
  wishlist: { tier: number; items: WishlistInsight[] }[];
}
export interface ScreenOfferParseResult {
  isDraft: boolean; offers: ScreenOffer[]; heroId: string | null;
  round: number | null; rerolls: number | null;
  pickStage?: number | null;
  message: string | null; signature: string | null; incomplete: boolean;
}
export interface ScreenReaderBridge {
  getScreenReaderState(): Promise<ScreenReaderState>;
  subscribeScreenReader(listener: (state: ScreenReaderState) => void): () => void;
  setScreenReaderEnabled(enabled: boolean): Promise<void>;
  setScreenReaderCrop(crop: CaptureRegion): Promise<void>;
  retryScreenReader(): Promise<void>;
  previewScreenReader(): Promise<ScreenReaderState>;
}

export function validateCaptureRegion(input: unknown): CaptureRegion {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Choose a valid game reading area.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['x', 'y', 'width', 'height'].includes(key))) throw new TypeError('Unknown reading-area option.');
  const { x, y, width, height } = value;
  if ([x, y, width, height].some(number => typeof number !== 'number' || !Number.isFinite(number))) throw new TypeError('Choose a valid game reading area.');
  const region = { x: x as number, y: y as number, width: width as number, height: height as number };
  if (region.x < 0 || region.y < 0 || region.width < 0.15 || region.height < 0.15
    || region.x + region.width > 1.000001 || region.y + region.height > 1.000001) throw new RangeError('The reading area must stay inside the game window.');
  return region;
}

export function createInitialScreenReaderState(crop: CaptureRegion = { ...DEFAULT_CAPTURE_REGION }): ScreenReaderState {
  return {
    revision: 0,
    status: 'starting', enabled: true, message: 'Preparing the screen reader…', engineReady: false,
    gamePresent: false, foreground: false, generation: 0, offers: [], advice: null, abilityAdvice: null, heroId: null,
    observedAt: null, readMs: null, matchContext: createInitialScreenMatchContext(), crop: { ...crop }, calibrationRequired: false, previewDataUrl: null,
    metrics: { reads: 0, skipped: 0, timeouts: 0, cpuPercent: null, memoryMb: null },
  };
}

export function createInitialScreenMatchContext(): ScreenMatchContext {
  return { revision: 0, sessionId: null, gameSessionId: null, retiredSessionIds: [], retiredGameSessionIds: [], viewMode: 'unknown', matchId: null, phase: 'unknown', round: null, scores: null,
    localSeat: null, localHeroId: null, localTeam: null, localAbilityPoints: null, rerollsRemaining: null,
    rerollAvailable: null, pickStage: null, deadlineAt: null, players: [], rosterCompleteness: 'unknown', rosterObservation: null,
    localInventory: [], localInventoryCompleteness: 'unknown', localInventorySlotCompleteness: 'unknown', localInventoryObservation: null, localInventoryRevision: 0,
    localAbilities: [], abilityCompleteness: 'unknown', abilityObservation: null, abilityRevision: 0, lastObservedAt: null,
    observations: { viewMode: null, matchId: null, phase: null, round: null, scores: null, localSeat: null, localHeroId: null, localTeam: null,
      localAbilityPoints: null, rerollsRemaining: null, rerollAvailable: null, pickStage: null, deadlineAt: null } };
}

/** Browser previews cannot read native game pixels. */
export function unavailableScreenReaderState(catalog?: Catalog): ScreenReaderState {
  void catalog;
  return { ...createInitialScreenReaderState(), status: 'unavailable', enabled: false,
    message: 'Open the Windows application to read your Deadlock item choices.' };
}
