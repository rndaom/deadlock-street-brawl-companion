import { isGoodItem, streetBrawlData, type HeroData, type ItemStat } from './street-brawl-data';

/** Points per win-rate point above the average item (a +5% item earns +3). */
const WIN_RATE_WEIGHT = 60;
const WIN_RATE_CAP = 4;
/** Counter evidence: average win-rate change in games against each identified enemy. */
const ENEMY_WEIGHT = 60;
const ENEMY_CAP = 3;
/** Valve's own per-hero "Good" draft bucket: the items the game biases toward this hero. */
const GOOD_BUCKET_POINTS = 1.5;

export interface StreetBrawlFit { points: number; reasons: string[]; concerns: string[] }

const percent = (value: number) => `${Math.round(value * 100)}%`;
const games = (value: number) => value >= 10_000 ? `${Math.round(value / 1000)}k` : value.toLocaleString('en-US');

/**
 * Street Brawl evidence for one item: its smoothed win rate in real Street Brawl matches
 * (for this hero when known, else all heroes), results against the identified enemies,
 * and Valve's per-hero Good bucket. Measured numbers lead the explanation.
 */
export function streetBrawlFit(itemId: string, heroId: string | null, enemyHeroIds: readonly string[] = []): StreetBrawlFit {
  const data = streetBrawlData();
  const hero = heroId ? data.heroes[heroId] : undefined;
  const reasons: string[] = [];
  const concerns: string[] = [];
  let points = 0;
  const good = !!hero && isGoodItem(heroId!, itemId);
  if (good) points += GOOD_BUCKET_POINTS;
  const valve = good ? ` · on Valve's list for ${hero!.name}` : '';
  const heroStat = hero?.itemStats[itemId];
  const stat = heroStat ?? data.globalItemStats[itemId];
  if (stat) {
    points += Math.max(-WIN_RATE_CAP, Math.min(WIN_RATE_CAP, stat.delta * WIN_RATE_WEIGHT));
    const change = Math.round(stat.delta * 1000) / 10;
    const versus = Math.abs(change) < 1 ? 'about average' : `${change > 0 ? '+' : ''}${change} vs. average`;
    const line = `Wins ${percent(stat.winRate)} of ${games(stat.matches)} Street Brawl games${heroStat ? ` on ${hero!.name}` : ''} (${versus})${valve}.`;
    (change <= -1 ? concerns : reasons).push(line);
  } else if (good) reasons.push(`On Valve's list of good items for ${hero!.name}.`);
  const versus = enemyHeroIds.map(enemyId => ({ hero: data.heroes[enemyId], stat: data.heroes[enemyId]?.versusItemStats?.[itemId] }))
    .filter((entry): entry is { hero: HeroData; stat: ItemStat } => !!entry.hero && !!entry.stat);
  if (versus.length) {
    const mean = versus.reduce((sum, entry) => sum + entry.stat.delta, 0) / versus.length;
    points += Math.max(-ENEMY_CAP, Math.min(ENEMY_CAP, mean * ENEMY_WEIGHT));
    const describe = (entry: { hero: HeroData; stat: ItemStat }) => `${entry.hero.name} ${percent(entry.stat.winRate)}`;
    const strong = versus.filter(entry => entry.stat.delta >= 0.015).sort((a, b) => b.stat.delta - a.stat.delta);
    const weak = versus.filter(entry => entry.stat.delta <= -0.015).sort((a, b) => a.stat.delta - b.stat.delta);
    if (mean > 0 && strong.length) reasons.push(`Wins more against ${strong.slice(0, 3).map(describe).join(', ')}.`);
    if (mean < 0 && weak.length) concerns.push(`Wins less against ${weak.slice(0, 3).map(describe).join(', ')}.`);
  }
  return { points: Math.round(points * 100) / 100, reasons, concerns };
}
