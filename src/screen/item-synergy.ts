import type { ItemPairs, StreetBrawlData } from './street-brawl-data';

/**
 * Item-pair synergy: how much more (or less) a player wins holding two items together than the
 * two items' own win rates predict. Measured on the 2026-11-14 pair table (Street Brawl since
 * 2026-10-30, all heroes, 14.5k pairs of 1,000+ player-matches):
 *
 * - Expected: log-odds of item A plus log-odds of item B minus the average item's. Each item's
 *   own win rate already carries the games it is bought in (long ones, won ones).
 * - Selection guard: what is left is split into a per-item part (an item that wins more beside
 *   anything, because it shows up in long or won games) and the pair's own part; only the pair's
 *   own part counts. Per-item parts span -0.25 to +0.45 points (5th-95th percentile); by tier
 *   pair (two late items, say) the kept part averages within ±0.25 points.
 * - Real, not noise: splitting the window in two (games before and after 2026-11-07) the kept
 *   part correlates 0.54 between halves for pairs of 1,000-3,000 games, 0.67 at 3k-10k, 0.78 at
 *   10k-30k and 0.88 above; 0.27 below 1,000, so smaller pairs are not stored. Its true spread is
 *   about 0.8 win-rate points; the sampling noise is 1.1 points at 1,000 games, 0.4 at 20,000.
 * - Per-hero pairs add nothing measurable at today's sizes (hero 10: no hero-specific spread
 *   beyond noise below 3,000 games, which is all but 424 of its pairs), so all heroes are pooled.
 */
export const MIN_PAIR_GAMES = 1_000;
/** Shrinkage fallback (games) when the spread cannot be estimated; the 2026-11-14 estimate was about 4,150. */
export const DEFAULT_PAIR_PRIOR_MATCHES = 4_000;
const PRIOR_BOUNDS = [100, 20_000] as const;

export interface PairRow { item_ids: number[]; wins: number; matches: number }
export interface ItemRateRow { item_id: number; wins: number; matches: number }

const logit = (p: number) => Math.log(p / (1 - p));
const clampRate = (p: number) => Math.min(0.99, Math.max(0.01, p));

/**
 * Builds the compact pair table from the API's pair rows and all-hero item rows. `className`
 * maps draftable item ids to class names (others are skipped). Null without usable pairs.
 * The prior strength is estimated like the other priors: observed spread minus sampling noise.
 */
export function buildItemPairs(pairRows: readonly PairRow[], itemRows: readonly ItemRateRow[], className: (id: number) => string | undefined,
  estimatePrior: (samples: { effect: number; noise: number }[], fallback: number) => number): ItemPairs | null {
  const rates = new Map<number, number>();
  let wins = 0, matches = 0;
  for (const row of itemRows) {
    if (!(row.matches > 0) || !(row.wins >= 0) || !className(row.item_id)) continue;
    rates.set(row.item_id, clampRate(row.wins / row.matches));
    wins += row.wins; matches += row.matches;
  }
  if (!matches) return null;
  const base = wins / matches;
  const scale = base * (1 - base);
  const pairs: { a: number; b: number; n: number; raw: number; weight: number }[] = [];
  for (const row of pairRows) {
    if (!Array.isArray(row?.item_ids) || row.item_ids.length !== 2 || !(row.matches >= MIN_PAIR_GAMES) || !(row.wins >= 0)) continue;
    const [a, b] = row.item_ids as [number, number];
    const pa = rates.get(a), pb = rates.get(b);
    if (a === b || pa === undefined || pb === undefined) continue;
    const p = clampRate(row.wins / row.matches);
    pairs.push({ a, b, n: row.matches, raw: logit(p) - (logit(pa) + logit(pb) - logit(base)), weight: row.matches * p * (1 - p) });
  }
  if (!pairs.length) return null;
  // Lift = mean + item part (a) + item part (b) + the pair's own part, fitted by precision-weighted
  // alternating least squares (converges in a few rounds; 30 is plenty).
  let mean = 0;
  const part = new Map<number, number>();
  for (let round = 0; round < 30; round++) {
    let sum = 0, weight = 0;
    for (const pair of pairs) { sum += pair.weight * (pair.raw - (part.get(pair.a) ?? 0) - (part.get(pair.b) ?? 0)); weight += pair.weight; }
    mean = sum / weight;
    const totals = new Map<number, { sum: number; weight: number }>();
    for (const pair of pairs) {
      for (const [own, other] of [[pair.a, pair.b], [pair.b, pair.a]] as const) {
        const total = totals.get(own) ?? { sum: 0, weight: 0 };
        total.sum += pair.weight * (pair.raw - mean - (part.get(other) ?? 0)); total.weight += pair.weight;
        totals.set(own, total);
      }
    }
    for (const [id, total] of totals) part.set(id, total.sum / total.weight);
  }
  const names: string[] = [];
  const index = new Map<number, number>();
  const slot = (id: number) => {
    if (!index.has(id)) { index.set(id, names.length); names.push(className(id)!); }
    return index.get(id)!;
  };
  const rows: number[] = [];
  const samples: { effect: number; noise: number }[] = [];
  for (const pair of pairs) {
    // Log-odds to win-rate points around the average item's win rate.
    const lift = (pair.raw - mean - part.get(pair.a)! - part.get(pair.b)!) * scale;
    samples.push({ effect: lift, noise: scale * scale / pair.weight });
    rows.push(slot(pair.a), slot(pair.b), Math.round(lift * 10_000), pair.n);
  }
  const priorMatches = Math.round(Math.max(PRIOR_BOUNDS[0], Math.min(PRIOR_BOUNDS[1], estimatePrior(samples, DEFAULT_PAIR_PRIOR_MATCHES))));
  return { priorMatches, minMatches: MIN_PAIR_GAMES, items: names, rows };
}

/** One stored pair: lift in win-rate points (as a fraction) and the player-matches holding both. */
export interface PairStat { lift: number; matches: number }

const lookups = new WeakMap<ItemPairs, Map<string, Map<string, PairStat>>>();

function lookup(pairs: ItemPairs): Map<string, Map<string, PairStat>> {
  let table = lookups.get(pairs);
  if (table) return table;
  table = new Map();
  const { items, rows } = pairs;
  for (let at = 0; at + 3 < rows.length; at += 4) {
    const a = items[rows[at]!], b = items[rows[at + 1]!], lift = rows[at + 2]! / 10_000, matches = rows[at + 3]!;
    // A damaged row is skipped rather than turning card values into NaN.
    if (typeof a !== 'string' || typeof b !== 'string' || !Number.isFinite(lift) || !(matches > 0)) continue;
    for (const [own, other] of [[a, b], [b, a]] as const) {
      const row = table.get(own) ?? new Map<string, PairStat>();
      row.set(other, { lift, matches });
      table.set(own, row);
    }
  }
  lookups.set(pairs, table);
  return table;
}

/** The stored (unshrunk) pair result, or null without data. */
export function pairStat(itemId: string, otherId: string, data: StreetBrawlData): PairStat | null {
  return data.itemPairs ? lookup(data.itemPairs).get(itemId)?.get(otherId) ?? null : null;
}

/**
 * Pair lift shrunk toward zero by sample size (a pair of `priorMatches` games keeps half its
 * measured lift), so a small or noisy pair moves little. Null without data.
 */
export function pairSynergy(itemId: string, otherId: string, data: StreetBrawlData): number | null {
  const stat = pairStat(itemId, otherId, data);
  if (!stat) return null;
  const prior = Number.isFinite(data.itemPairs!.priorMatches) && data.itemPairs!.priorMatches > 0 ? data.itemPairs!.priorMatches : DEFAULT_PAIR_PRIOR_MATCHES;
  return stat.lift * stat.matches / (stat.matches + prior);
}

/** Shrunk synergy of `itemId` with each owned item that has pair data (owned list deduplicated, the item itself skipped). */
export function synergiesWith(itemId: string, ownedItemIds: readonly string[], data: StreetBrawlData): { itemId: string; synergy: number }[] {
  if (!data.itemPairs) return [];
  return [...new Set(ownedItemIds)].filter(id => id !== itemId)
    .map(id => ({ itemId: id, synergy: pairSynergy(itemId, id, data) }))
    .filter((entry): entry is { itemId: string; synergy: number } => entry.synergy !== null);
}
