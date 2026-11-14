import { absorbedComponents } from './item-bundles';
import { synergiesWith } from './item-synergy';
import { isGoodItem, streetBrawlData, type HeroData, type StreetBrawlData } from './street-brawl-data';

/** Points per win-rate point above the average item (a +5% item earns +3). Every value on the fit scale converts back to win-rate points through it. */
export const WIN_RATE_WEIGHT = 60;
const WIN_RATE_CAP = 4;
/**
 * Counter evidence. An item's results against one enemy mostly repeat its general strength
 * (across all enemy × item pairs the two track at correlation 0.87), so only the residual —
 * how much more or less it wins against that enemy than it usually does — is counter evidence.
 * Residuals add up over the enemy team: each enemy's games average over the other enemies.
 */
const COUNTER_WEIGHT = 60;
const COUNTER_CAP = 3;
/** Residuals inside this band are mostly sampling noise (about 0.4 points for a typical sample) and earn nothing. */
const COUNTER_NOISE = 0.005;
/** A residual of at least this many win-rate points makes the item a counter to that enemy (or a weakness, below minus it). */
export const COUNTER_EDGE = 0.015;
/**
 * Synergy with owned items (item-synergy.ts): the shrunk pair lift, summed over the owned items.
 * After shrinking, a pair's estimate still carries about 0.2-0.3 points of noise, so the same
 * band as counters takes 0.5 points off each pair before it scores; across six owned items the
 * summed lift falls between -3 and +2 points for 90% of offers. The cap (2 points, about 3.3
 * win-rate points) keeps a long owned list, whose pairs partly repeat each other, from
 * outweighing the item's own result.
 */
const SYNERGY_WEIGHT = WIN_RATE_WEIGHT;
const SYNERGY_CAP = 2;
const SYNERGY_NOISE = 0.005;
/** A shrunk pair lift of at least this many win-rate points is named in the reasons (or concerns, below minus it). */
export const SYNERGY_EDGE = 0.01;
/** Shrinkage defaults for snapshots without estimated priors (see street-brawl-fetch.ts, which estimates both). */
const DEFAULT_HERO_PRIOR_MATCHES = 1_500;
const DEFAULT_GOOD_PRIOR = 0.01;
/** Enhanced extra (fit points) for snapshots without Enhanced results. */
const DEFAULT_ENHANCED_POINTS = 1;
/**
 * Share of a draft's cards drawn from the hero's Good bucket, per tier (Valve's street_brawl
 * draft config; see research/street-brawl-research.md). The rest come from the other items of the tier.
 */
export const GOOD_DRAW_SHARE: Readonly<Record<number, number>> = { 1: 0.6, 2: 0.4, 3: 0.4, 4: 0.35, 5: 0.2 };

export interface StreetBrawlFit { points: number; reasons: string[]; concerns: string[] }

const percent = (value: number) => `${Math.round(value * 100)}%`;
const games = (value: number) => value >= 10_000 ? `${Math.round(value / 1000)}k` : value.toLocaleString('en-US');
const signedPoints = (value: number) => `${value > 0 ? '+' : ''}${(Math.round(value * 1000) / 10).toFixed(1)}`;
const clamp = (value: number, cap: number) => Math.max(-cap, Math.min(cap, value));
const joinNames = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const positive = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! > 0 ? value! : fallback;

/**
 * Empirical-Bayes estimate (precision-weighted average) of an effect: `observed` from `matches`
 * games is pulled toward `prior`, which counts as `priorMatches` games. With no games it is the prior.
 */
export function shrinkToward(observed: number, matches: number, prior: number, priorMatches: number): number {
  const n = Number.isFinite(matches) && matches > 0 ? matches : 0;
  const k = Number.isFinite(priorMatches) && priorMatches > 0 ? priorMatches : 0;
  return n + k > 0 ? (n * observed + k * prior) / (n + k) : prior;
}

/**
 * Win-rate points (as a fraction) this item adds for this hero, vs. the average item. The hero's
 * own result is shrunk toward the item's all-hero result by sample size; Valve's Good list
 * shifts that starting point by the measured average Good-list advantage, so it only matters
 * while the hero's own sample is thin. Without a hero, the all-hero result. Null without data.
 */
export function itemDelta(itemId: string, heroId: string | null, data: StreetBrawlData = streetBrawlData()): number | null {
  const general = data.globalItemStats[itemId];
  const hero = heroId ? data.heroes[heroId] : undefined;
  if (!hero) return general ? general.delta : null;
  const heroStat = hero.itemStats[itemId];
  const good = hero.good.includes(itemId);
  if (!heroStat && !general && !good) return null;
  const prior = (general?.delta ?? 0) + (good ? data.goodPrior ?? DEFAULT_GOOD_PRIOR : 0);
  return heroStat ? shrinkToward(heroStat.delta, heroStat.matches, prior, positive(data.heroPriorMatches, DEFAULT_HERO_PRIOR_MATCHES)) : prior;
}

/**
 * How many more win-rate points (as a fraction) an item wins in games against one enemy hero
 * than its general result predicts; null without data. Both deltas are smoothed toward their
 * group average with the same prior, and the smaller per-enemy sample is pulled in further,
 * so the general delta is shrunk to that sample size before comparing.
 */
export function counterResidual(itemId: string, enemyHeroId: string, data: StreetBrawlData = streetBrawlData()): number | null {
  const versus = data.heroes[enemyHeroId]?.versusItemStats?.[itemId];
  const general = data.globalItemStats[itemId];
  if (!versus || !general) return null;
  const prior = Number.isFinite(data.priorMatches) && data.priorMatches > 0 ? data.priorMatches : 0;
  const shrink = (matches: number) => matches > 0 ? matches / (matches + prior) : 0;
  const expected = prior && shrink(general.matches) > 0 ? general.delta * shrink(versus.matches) / shrink(general.matches) : general.delta;
  return versus.delta - expected;
}

/** Shrunk pair lift of an item with each owned item, and its fit points (0 with nothing owned or no pair data). */
export function ownedSynergy(itemId: string, ownedItemIds: readonly string[], data: StreetBrawlData = streetBrawlData()):
  { synergies: { itemId: string; synergy: number }[]; points: number } {
  if (!ownedItemIds.length || !data.itemPairs) return { synergies: [], points: 0 };
  // Owned items this pick would absorb are gone once it is taken, so they cannot pair with it.
  const absorbed = new Set(absorbedComponents(itemId, ownedItemIds));
  const synergies = synergiesWith(itemId, ownedItemIds.filter(id => !absorbed.has(id)), data);
  const points = clamp(synergies.reduce((sum, entry) => sum + Math.sign(entry.synergy) * Math.max(0, Math.abs(entry.synergy) - SYNERGY_NOISE), 0) * SYNERGY_WEIGHT, SYNERGY_CAP);
  return { synergies, points };
}

/**
 * Street Brawl evidence for one item: its win rate in real Street Brawl matches (this hero's
 * result shrunk toward the all-hero result, with Valve's per-hero Good list as part of the prior),
 * genuine counters to the identified enemies, and how it wins beside the items already owned
 * (`ownedItemIds`; none, or no pair data, leaves the result unchanged). The strongest measured
 * evidence leads `reasons`; a real weakness against an enemy leads `concerns`.
 */
export function streetBrawlFit(itemId: string, heroId: string | null, enemyHeroIds: readonly string[] = [],
  ownedItemIds: readonly string[] = []): StreetBrawlFit {
  const data = streetBrawlData();
  const hero = heroId ? data.heroes[heroId] : undefined;
  const reasons: string[] = [];
  const concerns: string[] = [];
  const good = !!hero && isGoodItem(heroId!, itemId);
  const valve = good ? ` · on Valve's list for ${hero!.name}` : '';
  const heroStat = hero?.itemStats[itemId];
  const stat = heroStat ?? data.globalItemStats[itemId];
  const delta = itemDelta(itemId, hero ? heroId : null, data);
  const statPoints = delta === null ? 0 : clamp(delta * WIN_RATE_WEIGHT, WIN_RATE_CAP);
  let statLine: string | null = null;
  let statConcern: string | null = null;
  if (stat && delta !== null) {
    const change = Math.round(delta * 1000) / 10;
    const versus = Math.abs(change) < 1 ? 'about average' : `${change > 0 ? '+' : ''}${change} vs. average`;
    const line = `Wins ${percent(stat.winRate)} of ${games(stat.matches)} Street Brawl games${heroStat ? ` on ${hero!.name}` : ''} (${versus})${valve}.`;
    if (change <= -1) statConcern = line; else statLine = line;
  } else if (good) statLine = `On Valve's list of good items for ${hero!.name}.`;

  const enemies = [...new Set(enemyHeroIds)].filter(id => id !== heroId);
  const edges = enemies.map(id => ({ hero: data.heroes[id], edge: counterResidual(itemId, id, data) }))
    .filter((entry): entry is { hero: HeroData; edge: number } => !!entry.hero && entry.edge !== null);
  const counterPoints = clamp(edges.reduce((sum, entry) => sum + Math.sign(entry.edge) * Math.max(0, Math.abs(entry.edge) - COUNTER_NOISE), 0) * COUNTER_WEIGHT, COUNTER_CAP);
  const strong = edges.filter(entry => entry.edge >= COUNTER_EDGE).sort((a, b) => b.edge - a.edge).slice(0, 3);
  const weak = edges.filter(entry => entry.edge <= -COUNTER_EDGE).sort((a, b) => a.edge - b.edge).slice(0, 3);
  // Points are the item's win rate against that hero over its usual win rate.
  const describe = (list: { hero: HeroData; edge: number }[]) => joinNames(list.map(entry => `${entry.hero.name} (${signedPoints(entry.edge)})`));
  const counterLine = strong.length ? `Counters ${describe(strong)}.` : null;
  const weakLine = weak.length ? `Weak against ${describe(weak)}.` : null;

  const { synergies, points: synergyPoints } = ownedSynergy(itemId, ownedItemIds, data);
  // Points are the pair's win rate over what the two items' own win rates predict.
  const pairNames = (list: { itemId: string; synergy: number }[]) => joinNames(list.map(entry => `${data.items[entry.itemId]?.name ?? entry.itemId} (${signedPoints(entry.synergy)})`));
  const helps = synergies.filter(entry => entry.synergy >= SYNERGY_EDGE).sort((a, b) => b.synergy - a.synergy).slice(0, 2);
  const clashes = synergies.filter(entry => entry.synergy <= -SYNERGY_EDGE).sort((a, b) => a.synergy - b.synergy).slice(0, 2);
  const synergyLine = helps.length ? `Pairs well with your ${pairNames(helps)}.` : null;
  const clashLine = clashes.length ? `Pairs poorly with your ${pairNames(clashes)}.` : null;

  // A genuine counter leads when it outweighs the general result.
  if (counterLine && (!statLine || counterPoints > statPoints)) reasons.push(counterLine, ...(statLine ? [statLine] : []));
  else reasons.push(...(statLine ? [statLine] : []), ...(counterLine ? [counterLine] : []));
  // So does a synergy that outweighs both.
  if (synergyLine && synergyPoints > Math.max(statPoints, counterPoints)) reasons.unshift(synergyLine);
  else if (synergyLine) reasons.push(synergyLine);
  concerns.push(...(weakLine ? [weakLine] : []), ...(clashLine ? [clashLine] : []), ...(statConcern ? [statConcern] : []));
  return { points: Math.round((statPoints + counterPoints + synergyPoints) * 100) / 100, reasons, concerns };
}

/**
 * Extra value (fit points) of the Enhanced version of an item over the plain item: its measured
 * win-rate uplift, shrunk toward the mean uplift of all items (street-brawl-fetch.ts).
 */
export function enhancedPoints(itemId: string, data: StreetBrawlData = streetBrawlData()): number {
  const enhanced = data.enhanced;
  if (!enhanced) return DEFAULT_ENHANCED_POINTS;
  const uplift = enhanced.items[itemId]?.uplift ?? enhanced.meanUplift;
  if (!Number.isFinite(uplift)) return DEFAULT_ENHANCED_POINTS;
  return Math.round(clamp(uplift * WIN_RATE_WEIGHT, WIN_RATE_CAP) * 100) / 100;
}
/** Share of drafted cards that are Enhanced (0 without data). */
export function enhancedShare(data: StreetBrawlData = streetBrawlData()): number {
  const share = data.enhanced?.share;
  return Number.isFinite(share) && share! > 0 && share! < 1 ? share! : 0;
}
/**
 * Chance that one card of a fresh draft is Enhanced. Only drafted copies are counted, and
 * players take Enhanced cards readily, so this is the rate at which a player who always took an
 * offered Enhanced card would end up with the measured share: 1 - (1 - share)^(1/3). Taking the
 * low end keeps a fresh draft from looking better than it is.
 */
export function enhancedOfferRate(data: StreetBrawlData = streetBrawlData()): number {
  return 1 - Math.cbrt(1 - enhancedShare(data));
}

const poolCache = new WeakMap<StreetBrawlData, Map<string, { id: string; value: number }[]>>();
const POOL_CACHE_SIZE = 64;

/**
 * Measured value (streetBrawlFit points) of every draftable item of one tier for this hero and
 * enemy team. Computed lazily, once per data snapshot, hero, tier and enemy team.
 */
function tierValues(heroId: string, tier: number, enemyHeroIds: readonly string[]): { id: string; value: number }[] {
  const data = streetBrawlData();
  let byKey = poolCache.get(data);
  if (!byKey) poolCache.set(data, byKey = new Map());
  const enemies = [...new Set(enemyHeroIds)].filter(id => id !== heroId).sort();
  const key = `${heroId}|${tier}|${enemies.join(',')}`;
  let pool = byKey.get(key);
  if (!pool) {
    if (byKey.size >= POOL_CACHE_SIZE) byKey.clear();
    pool = Object.keys(data.items).filter(id => data.items[id]!.tier === tier).map(id => ({ id, value: streetBrawlFit(id, heroId, enemies).points }));
    byKey.set(key, pool);
  }
  return pool;
}

/** One card a fresh draft of a tier can show: its value on the fit scale and its chance of being drawn (weights sum to 1). */
export interface PoolCard { id: string; value: number; weight: number }

/**
 * Every card a fresh draft of `tier` can show this hero (owned items excluded: a draft never
 * offers them), valued on the streetBrawlFit scale plus `extra` (Bonus!, Enhanced or enemy-build
 * value the caller can predict for that card) and, given `owned`, its synergy with the owned
 * items (as in streetBrawlFit). Weights follow Valve's Good-bucket bias. Null
 * when the hero or tier has no data.
 */
export function draftPool(heroId: string, tier: number, enemyHeroIds: readonly string[] = [],
  options: { exclude?: ReadonlySet<string>; extra?: (itemId: string) => number; owned?: readonly string[] } = {}): PoolCard[] | null {
  if (!streetBrawlData().heroes[heroId]) return null;
  const cards = tierValues(heroId, tier, enemyHeroIds).filter(card => !options.exclude?.has(card.id));
  if (cards.length < 3) return null;
  const good = cards.filter(card => isGoodItem(heroId, card.id)).length;
  const share = GOOD_DRAW_SHARE[tier] ?? 0;
  const biased = good > 0 && good < cards.length && share > 0;
  const goodWeight = biased ? share / good : 1 / cards.length;
  const otherWeight = biased ? (1 - share) / (cards.length - good) : 1 / cards.length;
  // Synergy with the owned items, so the shown cards (scored with it) and a fresh draft stay on one scale.
  const owned = options.owned ?? [];
  return cards.map(card => ({ id: card.id, value: card.value + (options.extra?.(card.id) ?? 0) + (owned.length ? ownedSynergy(card.id, owned).points : 0),
    weight: biased && isGoodItem(heroId, card.id) ? goodWeight : otherWeight }));
}

/** Draw-weighted average card value of a pool. */
export function poolMean(pool: readonly PoolCard[]): number {
  const total = pool.reduce((sum, card) => sum + card.weight, 0);
  return total > 0 ? pool.reduce((sum, card) => sum + card.value * card.weight, 0) / total : 0;
}
/** 0-100: share of the pool (by draw weight) worth less than `value`, ties counted half. */
export function poolPercentile(value: number, pool: readonly PoolCard[]): number {
  const total = pool.reduce((sum, card) => sum + card.weight, 0);
  if (!(total > 0)) return 50;
  const below = pool.reduce((sum, card) => sum + (card.value < value - 1e-9 ? card.weight : Math.abs(card.value - value) <= 1e-9 ? card.weight / 2 : 0), 0);
  return 100 * below / total;
}

/** Distribution of the best card's value in a fresh three-card draft: support ascending, probabilities summing to 1. */
export interface BestOfThree { values: number[]; probs: number[] }
const bestCache = new Map<string, BestOfThree>();
const BEST_CACHE_SIZE = 48;

/**
 * Exact distribution of the best of three distinct cards drawn one after another with
 * probability proportional to their weights (sampling without replacement).
 */
export function bestOfThree(pool: readonly PoolCard[]): BestOfThree {
  const sorted = [...pool].filter(card => card.weight > 0).sort((a, b) => a.value - b.value || a.id.localeCompare(b.id));
  const key = sorted.map(card => `${card.value.toFixed(4)}:${card.weight.toFixed(6)}`).join(',');
  const cached = bestCache.get(key);
  if (cached) return cached;
  const n = sorted.length;
  const mass = new Array<number>(n).fill(0);
  const total = sorted.reduce((sum, card) => sum + card.weight, 0);
  for (let i = 0; i < n; i++) {
    const pi = sorted[i]!.weight / total, restI = total - sorted[i]!.weight;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const pj = pi * sorted[j]!.weight / restI, restJ = restI - sorted[j]!.weight;
      if (!(restJ > 0)) continue;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        mass[Math.max(i, j, k)]! += pj * sorted[k]!.weight / restJ;
      }
    }
  }
  const sum = mass.reduce((a, b) => a + b, 0);
  const result: BestOfThree = { values: [], probs: [] };
  for (let index = 0; index < n; index++) if (mass[index]! > 0) { result.values.push(sorted[index]!.value); result.probs.push(mass[index]! / sum); }
  if (bestCache.size >= BEST_CACHE_SIZE) bestCache.delete(bestCache.keys().next().value!);
  bestCache.set(key, result);
  return result;
}
/** E[max(X + add, floor)] for X distributed as `best`. */
function expectMax(best: BestOfThree, add: number, floor: number): number {
  let total = 0;
  for (let index = 0; index < best.values.length; index++) total += best.probs[index]! * Math.max(best.values[index]! + add, floor);
  return total;
}
/** Expected best card of a fresh draft. */
export function expectedBest(best: BestOfThree): number { return expectMax(best, 0, -Infinity); }

export interface RerollPlan {
  reroll: boolean;
  /** Expected value of the rest of the round (this choice included) when taking the current best card. */
  keep: number;
  /** Expected value of the rest of the round when rerolling now (and playing on optimally). */
  refresh: number;
}
/**
 * Reroll decision as a small dynamic programme over the round's remaining choices and rerolls.
 * `stages[0]` is the best-card distribution of a fresh draft at this choice, `stages[1..]` those
 * of the round's later choices; unused rerolls are lost at round end. U(c, r) is the expected
 * value of choices c.. with r rerolls before seeing the draft at c:
 *   U(c, r) = E[max(X_c + U(c+1, r), U(c, r-1))]   (the second option only when r > 0), U(end, r) = 0.
 * With best card `current` on screen, rerolling is worth U(0, R-1) and keeping is current + U(1, R).
 */
export function rerollPlan(current: number, rerolls: number, stages: readonly BestOfThree[]): RerollPlan {
  const budget = Number.isSafeInteger(rerolls) && rerolls > 0 ? rerolls : 0;
  const count = stages.length;
  const value = Array.from({ length: count + 1 }, () => new Array<number>(budget + 1).fill(0));
  for (let choice = count - 1; choice >= 0; choice--) {
    for (let left = 0; left <= budget; left++) {
      value[choice]![left] = expectMax(stages[choice]!, value[choice + 1]![left]!, left > 0 ? value[choice]![left - 1]! : -Infinity);
    }
  }
  const keep = current + (value[1]?.[budget] ?? 0);
  const refresh = budget > 0 && count > 0 ? value[0]![budget - 1]! : -Infinity;
  return { reroll: refresh > keep + 1e-9, keep, refresh };
}
