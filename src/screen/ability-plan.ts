import { streetBrawlData } from './street-brawl-data';
import { CONTEXT_CATALOG } from '../shared/context-catalog';

type OrderRow = { order: string; wins: number; matches: number };
/** Tier costs shown on the upgrade panel (bottom to top): 1, 2 and 5 ability points. */
const TIER_COST = [1, 2, 5];
/** Games of evidence that count as much as the average when smoothing a next-step win rate. */
const PRIOR_GAMES = 60;
/** A next step must be this common among matching games to be suggested over the popular one. */
const MIN_SHARE = 0.1;

export interface AbilityPlan {
  slot: number; ability: string; tier: number; cost: number;
  /** Win rate of games that took this upgrade next from the same levels, and how many games. */
  winRate: number | null; games: number;
  /** The most common upgrades after this one, by ability name. */
  then: string[];
  reason: string;
}

function abilityNames(heroId: string): string[] {
  return (CONTEXT_CATALOG.abilities as unknown as { heroId: string; slot: number; name: string }[])
    .filter(ability => ability.heroId === heroId).sort((a, b) => a.slot - b.slot).map(ability => ability.name);
}
function counts(order: string, length: number): number[] {
  const result = [0, 0, 0, 0];
  for (let index = 0; index < length; index++) result[Number(order[index])]!++;
  return result;
}
/** Next-step statistics for games whose first upgrades reached exactly these levels. */
function nextSteps(rows: OrderRow[], ranks: number[]) {
  const done = ranks.reduce((sum, rank) => sum + rank, 0);
  const steps = new Map<number, { wins: number; matches: number }>();
  for (const row of rows) {
    if (row.order.length <= done) continue;
    const reached = counts(row.order, done);
    if (reached.some((value, slot) => value !== ranks[slot])) continue;
    const slot = Number(row.order[done]);
    const step = steps.get(slot) ?? { wins: 0, matches: 0 };
    step.wins += row.wins; step.matches += row.matches; steps.set(slot, step);
  }
  return steps;
}

/** The suggested next ability upgrade for this hero at these levels (0-3 per ability). */
export function abilityPlan(heroId: string | null, ranks: readonly number[] | null): AbilityPlan | null {
  if (!heroId || !ranks || ranks.length !== 4) return null;
  const rows = streetBrawlData().heroes[heroId]?.abilityOrders ?? [];
  const names = abilityNames(heroId);
  if (names.length !== 4 || ranks.every(rank => rank >= 3)) return null;
  const open = [0, 1, 2, 3].filter(slot => ranks[slot]! < 3);
  const steps = nextSteps(rows, [...ranks]);
  const total = [...steps.values()].reduce((sum, step) => sum + step.matches, 0);
  let slot: number; let winRate: number | null = null; let games = 0; let reason: string;
  if (total >= 30) {
    const base = [...steps.values()].reduce((sum, step) => sum + step.wins, 0) / total;
    const ranked = [...steps.entries()].filter(([candidate, step]) => open.includes(candidate) && step.matches / total >= MIN_SHARE)
      .map(([candidate, step]) => ({ candidate, step, smoothed: (step.wins + PRIOR_GAMES * base) / (step.matches + PRIOR_GAMES) }))
      .sort((a, b) => b.smoothed - a.smoothed);
    const best = ranked[0]!;
    const popular = [...steps.entries()].sort((a, b) => b[1].matches - a[1].matches)[0]!;
    slot = best.candidate; games = best.step.matches; winRate = best.step.wins / best.step.matches;
    reason = popular[0] === slot ? `the most common next upgrade from your levels, and it wins ${Math.round(winRate * 100)}%`
      : `wins ${Math.round(winRate * 100)}% when taken next, more than the popular ${names[popular[0]]} (${Math.round(popular[1].wins / popular[1].matches * 100)}%)`;
  } else {
    // Unusual levels: follow the order in which players generally raise each ability.
    const position = [0, 0, 0, 0]; const weight = [0, 0, 0, 0];
    for (const row of rows) {
      const seen = [0, 0, 0, 0];
      [...row.order].forEach((character, index) => {
        const candidate = Number(character); seen[candidate]!++;
        if (seen[candidate] === ranks[candidate]! + 1) { position[candidate]! += index * row.matches; weight[candidate]! += row.matches; }
      });
    }
    slot = open.sort((a, b) => (weight[a] ? position[a]! / weight[a]! : 99) - (weight[b] ? position[b]! / weight[b]! : 99))[0]!;
    reason = 'players usually raise this one next';
  }
  // Most common continuation after the suggested upgrade.
  const then: string[] = []; const simulated = [...ranks]; simulated[slot]!++;
  for (let step = 0; step < 3 && simulated.some(rank => rank < 3); step++) {
    const options = [...nextSteps(rows, simulated).entries()].filter(([candidate]) => simulated[candidate]! < 3).sort((a, b) => b[1].matches - a[1].matches);
    if (!options.length) break;
    then.push(names[options[0]![0]]!); simulated[options[0]![0]]!++;
  }
  const tier = ranks[slot]! + 1;
  return { slot, ability: names[slot]!, tier, cost: TIER_COST[tier - 1]!, winRate, games, then, reason };
}
