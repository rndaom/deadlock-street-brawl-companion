import bundled from '../../data/street-brawl-data.json';

/**
 * Street Brawl result for one item: delta is win-rate points (as a fraction) vs. the group average.
 * All-hero and per-enemy deltas are smoothed toward that average; per-hero deltas (HeroData.itemStats)
 * are raw, and streetBrawlFit shrinks them toward the item's all-hero delta by sample size.
 */
export interface ItemStat { delta: number; winRate: number; matches: number }
/** Enhanced version of one item: uplift is its win rate minus the plain item's, shrunk toward the mean uplift. */
export interface EnhancedStat { uplift: number; winRate: number; matches: number }
/** This hero's Street Brawl result against one enemy hero; delta is smoothed win-rate points vs. this hero's own average. */
export interface MatchupStat { delta: number; winRate: number; matches: number }
/** Street Brawl upgrade order: each character is the ability slot (0-3) of one tier bought. */
export interface AbilityOrder { order: string; wins: number; matches: number }
export interface HeroData {
  id: number; name: string; type: string | null; gun: string | null;
  /** Valve's per-hero "Good" draft bucket (items the game biases toward this hero). */
  good: string[];
  itemStats: Record<string, ItemStat>;
  /** Item results in games where this hero was on the ENEMY team. */
  versusItemStats?: Record<string, ItemStat>;
  abilityOrders?: AbilityOrder[];
  /** The hero's own Street Brawl win rate and games. */
  winRate?: number; matches?: number;
  /** Results against each enemy hero (by class name). */
  matchups?: Record<string, MatchupStat>;
  /** This hero's own rows come from the wider fallback window (too few games in the patch window). */
  wideWindow?: boolean;
}
export interface StreetBrawlData {
  /** Download format; 2 = raw per-hero deltas with estimated shrinkage (see street-brawl-fetch.ts). */
  schemaVersion?: number;
  source: string; fetchedAt: string; priorMatches: number;
  /** Games used: since the current balance patch, and the wider window for thin heroes (ISO dates). */
  window?: { since: string; wideSince: string };
  /** Prior strength (games) pulling one hero's item result toward the item's all-hero result. */
  heroPriorMatches?: number;
  /** Prior shift (win-rate fraction) of the all-hero result for items on Valve's Good list for that hero; fades with the hero's own sample. */
  goodPrior?: number;
  /** Enhanced-card results; share is the fraction of drafted copies that were Enhanced. */
  enhanced?: { share: number; meanUplift: number; priorMatches: number; items: Record<string, EnhancedStat> };
  items: Record<string, { id: number; name: string; tier: number; slot: string; active: boolean }>;
  globalItemStats: Record<string, ItemStat>;
  heroes: Record<string, HeroData>;
}

/** The bundled snapshot until a newer download (see street-brawl-fetch.ts) replaces it. */
let current = bundled as unknown as StreetBrawlData;
let good = goodSets(current);

function goodSets(data: StreetBrawlData) { return new Map(Object.entries(data.heroes).map(([heroId, hero]) => [heroId, new Set(hero.good)])); }

export function streetBrawlData(): StreetBrawlData { return current; }
export function isGoodItem(heroId: string, itemId: string): boolean { return good.get(heroId)?.has(itemId) ?? false; }

/** A plausible, complete download only; anything else keeps the current data. */
export function isStreetBrawlData(value: unknown): value is StreetBrawlData {
  const data = value as Partial<StreetBrawlData> | null;
  // Older saved downloads smoothed per-hero results toward the hero's own average; they are replaced.
  if (!data || !(Number(data.schemaVersion) >= 2) || typeof data.fetchedAt !== 'string' || Number.isNaN(Date.parse(data.fetchedAt))
    || !data.heroes || Object.keys(data.heroes).length < 20 || !data.globalItemStats || Object.keys(data.globalItemStats).length < 100) return false;
  // The API sometimes answers the per-hero requests with empty lists; such a download would replace
  // good upgrade orders and enemy-item results with nothing. Most heroes must have both.
  const heroes = Object.values(data.heroes);
  // The same holds for each hero's own item results and win rate (a failed hero-stats request is
  // caught as an empty list), and for matchups once the counter request answered at all.
  const most = (has: (hero: HeroData) => boolean) => heroes.filter(has).length >= 0.8 * heroes.length;
  return most(hero => (hero.abilityOrders?.length ?? 0) > 0 && Object.keys(hero.versusItemStats ?? {}).length > 0)
    && most(hero => Object.keys(hero.itemStats ?? {}).length > 0)
    && most(hero => Number.isFinite(hero.winRate) && (hero.matches ?? 0) > 0)
    && (!heroes.some(hero => Object.keys(hero.matchups ?? {}).length > 0) || most(hero => Object.keys(hero.matchups ?? {}).length > 0));
}
export function setStreetBrawlData(data: StreetBrawlData): boolean {
  if (!isStreetBrawlData(data)) return false;
  current = data; good = goodSets(data);
  return true;
}
