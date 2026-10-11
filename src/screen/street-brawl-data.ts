import bundled from '../../data/street-brawl-data.json';

/** Smoothed Street Brawl result for one item: delta is win-rate points vs. the group average. */
export interface ItemStat { delta: number; winRate: number; matches: number }
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
}
export interface StreetBrawlData {
  source: string; fetchedAt: string; priorMatches: number;
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
  return !!data && typeof data.fetchedAt === 'string' && !Number.isNaN(Date.parse(data.fetchedAt))
    && !!data.heroes && Object.keys(data.heroes).length >= 20 && !!data.globalItemStats && Object.keys(data.globalItemStats).length >= 100;
}
export function setStreetBrawlData(data: StreetBrawlData): boolean {
  if (!isStreetBrawlData(data)) return false;
  current = data; good = goodSets(data);
  return true;
}
