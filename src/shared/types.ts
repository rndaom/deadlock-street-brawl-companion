import type { ScreenReaderBridge } from './screen-reading';
/** Normalized application contracts. Proposed draft capabilities are not GEP APIs. */
export type AppMode = 'live';
export type Phase = 'waiting' | 'draft' | 'combat' | 'transition' | 'finished';
export type SourceStatus = 'unavailable' | 'connecting' | 'connected' | 'interrupted';
export type CapabilityName = 'participant_match' | 'street_brawl_round' | 'own_draft_offers' | 'offer_modifiers' | 'own_reroll_state' | 'current_inventories' | 'purchased_items' | 'ability_investment' | 'corruption_decision' | 'source_continuity';
export interface Capability { name: CapabilityName; supported: boolean; verified: boolean; detail: string }
export interface SourceState {
  sessionId?: string | null;
  provider: string; status: SourceStatus; runtimeVersion: string | null;
  capabilities: Capability[]; noImageMethodVerified: boolean;
  sequence: number | null; lastReceivedAt: number | null;
  sequenceKind?: 'upstream' | 'local';
  /** Independently documented maximum upstream delay. Null means unknown. */
  deliveryBoundMs: number | null; continuity: 'unknown' | 'continuous' | 'gap';
  message: string;
}
export interface Observation {
  sessionId?: string | null;
  provider: string; receivedAt: number; observedAt: number | null;
  /** Uncertainty after mapping a game clock to this local clock. */
  clockUncertaintyMs: number | null; sequence: number;
  visibility: 'participant' | 'unknown';
  changedAt?: number | null; confirmedAt?: number | null;
}
export interface ItemInstance {
  id: string; instanceId: string; bonusIds: string[];
  variant: 'base' | 'enhanced' | 'legendary' | 'corrupted' | 'unknown';
  modifierBits: string | null; modifiersDecoded: boolean;
}
export interface AbilityInvestment { id: string; rank: number | null; unlocked: boolean | null }
export interface PurchasedItemHistoryEntry {
  itemId: string; gameTime: number | null; className?: string; name?: string;
  enhanced?: boolean | null; upgradeBits?: string | null;
}
export interface PlayerState {
  seat: number; team: number; heroId: string | null; heroName: string | null;
  playerName: string | null; steamId: string | null; isLocal: boolean;
  inventory: ItemInstance[]; inventoryCompleteness: 'unknown' | 'partial' | 'complete';
  inventoryRevision: number; abilities: AbilityInvestment[];
  abilityCompleteness: 'unknown' | 'partial' | 'complete'; abilityRevision: number;
  observation: Observation | null;
  inventoryObservation?: Observation | null; abilityObservation?: Observation | null;
  purchasedHistory?: PurchasedItemHistoryEntry[];
}
export interface MatchContext {
  id: string; mode: 'street_brawl' | 'normal' | 'unknown'; clientVersion: string | null;
  localSeat: number | null; localTeam: number | null; round: number | null;
  scores: [number, number] | null; phase: Phase; deadlineAt: number | null;
  observation: Observation;
}
export interface DraftOffer { position: number; item: ItemInstance; available: boolean }
export interface DraftState {
  round?: number | null;
  id: string; generation: number; pickStage: number; offers: DraftOffer[];
  rerollsRemaining: number | null; rerollAvailable: boolean | null;
  observation: Observation;
}
export interface MatchState {
  mode: AppMode; source: SourceState; match: MatchContext | null;
  players: PlayerState[]; draft: DraftState | null;
  rosterCompleteness?: 'unknown' | 'partial' | 'complete';
  retiredMatchIds?: string[];
  retiredSourceSessionIds?: string[];
  closedDrafts?: { round: number | null; id: string; generation: number }[];
  revision: number; advice: Advice | null;
  decisionRevision?: number;
  transitions: { label: string; at: number }[];
  counters: { accepted: number; rejected: number; invalidated: number };
}
export interface DecisionKey {
  contextRevision?: number;
  sourceSessionId?: string | null; catalogRevision?: string;
  matchId: string; round: number; draftId: string; generation: number;
  inventoryRevision: number; abilityRevision: number; modelVersion: string;
}
export interface RankedOffer { position: number; itemId: string; score: number; reasons: string[] }
export interface Advice {
  key: DecisionKey; kind: 'pick' | 'withheld'; preferredPosition: number | null;
  title: string; reasons: string[]; limitations: string[];
  ranked: RankedOffer[]; reroll: { kind: 'withheld' | 'keep' | 'reroll'; reason: string };
  evidence: 'synthetic' | 'mechanics'; computedAt: number;
}
export interface CatalogItem {
  numericId?: string;
  id: string; name: string; category: 'weapon' | 'vitality' | 'spirit' | 'unknown';
  tier: number | null; tags: string[]; description: string; imageUrl?: string;
}
export interface CatalogHero { id: string; name: string; role: string; tags: string[]; imageUrl?: string; numericId?: string }
export interface Catalog {
  clientVersion: string; revision: string; source: string; retrievedAt: string;
  items: CatalogItem[]; heroes: CatalogHero[];
  /** False until mode values, modifier evaluators and model are verified. */
  liveModelValidated: boolean; modelVersion: string;
}
export type TelemetryEvent =
  | { type: 'source'; source: SourceState }
  | { type: 'reset'; reason: string; at: number }
  | { type: 'match'; match: MatchContext }
  | { type: 'roster'; matchId: string; players: PlayerState[]; complete: boolean; observation: Observation }
  | { type: 'round'; matchId: string; round: number; phase: Phase; scores: [number, number] | null; deadlineAt: number | null; observation: Observation }
  | { type: 'draft'; matchId: string; draft: DraftState }
  | { type: 'action'; matchId: string; action: 'pick' | 'reroll' | 'draft_closed'; observation: Observation }
  | { type: 'inventory'; matchId: string; seat: number; operation: 'snapshot' | 'add' | 'remove' | 'replace'; items: ItemInstance[]; removeInstanceIds: string[]; complete: boolean; observation: Observation }
  | { type: 'abilities'; matchId: string; seat: number; abilities: AbilityInvestment[]; complete: boolean; observation: Observation }
  | { type: 'purchases'; matchId: string; seat: number; items: PurchasedItemHistoryEntry[]; complete: boolean; observation: Observation };
export interface DisplayInfo { id: string; label: string; width: number; height: number; primary: boolean }
export interface AppSettings { textScale: number; hidePlayerNames: boolean; alwaysOnTop: boolean; displayId: string | null;
  /** Draw the pick (and, on the hotkey, the leveling plan) over the game, for one-monitor play. */
  overlay: boolean;
  /** Keep the latest draft and scoreboard screenshots in the diagnostics folder for troubleshooting (off by default:
   * they show player names and chat, and Documents is often synced to the cloud). */
  saveScreenshots: boolean }
/** In-game overlay status: whether the hotkey info panel is open and which key toggles it (null = key unavailable). */
export interface OverlayStatus { panel: boolean; hotkey: string | null }
export interface CompanionBridge extends ScreenReaderBridge {
  getState(): Promise<MatchState>; getCatalog(): Promise<Catalog>;
  subscribe(listener: (state: MatchState) => void): () => void;
  getSettings(): Promise<AppSettings>; updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  getDisplays(): Promise<DisplayInfo[]>; exportDiagnostics(): Promise<string>;
  /** Only the desktop app has an in-game overlay. */
  getOverlayStatus?(): Promise<OverlayStatus>;
  subscribeOverlay?(listener: (status: OverlayStatus) => void): () => void;
}
