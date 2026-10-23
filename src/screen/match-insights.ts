import type { MatchInsights, MatchupInsight, WishlistInsight } from '../shared/screen-reading';
import { streetBrawlData } from './street-brawl-data';
import { COUNTER_EDGE, counterResidual, streetBrawlFit } from './street-brawl-fit';
import { componentsOf } from './item-bundles';

/**
 * Match-level advice that does not wait for a draft: how your hero fares against each
 * identified enemy, and which items to hope for (or reroll toward) in the next drafts.
 * Pure: everything comes from the Street Brawl statistics and what the reader has seen.
 */

const WISHLIST_PER_TIER = 3;
/** A wishlist item must beat the average item by at least this many scoring points. */
const WISHLIST_MIN_POINTS = 0.6;

export function matchInsights(heroId: string | null, enemyHeroIds: readonly string[], ownedItemIds: readonly string[]): MatchInsights | null {
  if (!heroId) return null;
  const data = streetBrawlData();
  const hero = data.heroes[heroId];
  if (!hero) return null;
  const enemies = [...new Set(enemyHeroIds.filter((id) => id !== heroId && !!data.heroes[id]))];

  const matchups: MatchupInsight[] = [];
  for (const enemyId of enemies) {
    const stat = hero.matchups?.[enemyId];
    if (stat) matchups.push({ heroId: enemyId, winRate: stat.winRate, delta: stat.delta, matches: stat.matches });
  }
  matchups.sort((a, b) => a.delta - b.delta);

  // Owned items and the components they already absorbed are not worth wishing for.
  const owned = new Set(ownedItemIds);
  for (const id of ownedItemIds) for (const component of componentsOf(id)) owned.add(component);
  const scored = Object.keys(data.items).filter((itemId) => !owned.has(itemId))
    .map((itemId) => ({ itemId, tier: data.items[itemId]!.tier, points: streetBrawlFit(itemId, heroId, enemies).points }))
    .filter((entry) => entry.points >= WISHLIST_MIN_POINTS && entry.tier >= 1 && entry.tier <= 4)
    .sort((a, b) => b.points - a.points);
  // Mean win rate barely moves with tier (T1 .498, T2 .500, T3 .496, T4 .499, T5 .505), so tiers
  // are not favoured; each draft offers one tier, so items are ranked within a tier as a draft compares them.
  const wishlist = [1, 2, 3, 4].map((tier) => ({ tier, items: scored.filter((entry) => entry.tier === tier).slice(0, WISHLIST_PER_TIER)
    .map(({ itemId }): WishlistInsight => {
      const stat = hero.itemStats[itemId] ?? data.globalItemStats[itemId] ?? null;
      // A counter wins clearly more against that enemy than the item usually does, not merely a strong item.
      const counters = enemies.filter((enemyId) => (counterResidual(itemId, enemyId, data) ?? 0) >= COUNTER_EDGE);
      return { itemId, tier, winRate: stat?.winRate ?? null, counters, valve: hero.good.includes(itemId) };
    }) })).filter((row) => row.items.length > 0);

  return { heroId, heroWinRate: hero.winRate ?? null, heroGames: hero.matches ?? 0, matchups, wishlist };
}

/** The enemy threat summary lives in a dependency-free module so the interface can use it without the statistics. */
export { enemyThreat } from '../shared/enemy-threat';
export type { DamageKind, EnemyThreat } from '../shared/enemy-threat';
