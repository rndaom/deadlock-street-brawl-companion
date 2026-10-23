import { streetBrawlData } from './street-brawl-data';
import { CONTEXT_CATALOG } from '../shared/context-catalog';
import { ABILITY_TIER_COSTS } from './ability-ranks';

type OrderRow = { order: string; wins: number; matches: number };
/** Games of evidence that count as much as the average when smoothing a next-step win rate. */
const PRIOR_GAMES = 60;
/** A next step must be this common among matching games to be suggested over the popular one. */
const MIN_SHARE = 0.1;
/** A less common next step is suggested only when its smoothed win rate is at least this much higher. */
const TIE_MARGIN = 0.01;
/** A less common next step also needs this many games of its own before its win rate counts. */
const MIN_STEP_GAMES = 30;
/** Matching games needed before the next step is read from the data at all (else the usual order). */
const MIN_TOTAL_GAMES = 30;

export interface AbilityPlan {
  slot: number; ability: string; tier: number; cost: number;
  /** Win rate of games that took this upgrade next from the same levels, and how many games. */
  winRate: number | null; games: number;
  /** The next upgrades after this one (best-winning well-sampled step, else the most common), by ability name. */
  then: string[];
  /** Every remaining upgrade in order, as ability slots, starting with this one. */
  path: number[];
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

type Step = { wins: number; matches: number };
/**
 * The next step from one set of levels: the most common open step, unless a step taken by at
 * least MIN_SHARE of the matching games and MIN_STEP_GAMES games wins clearly more (smoothed
 * toward the average of all next steps). Null when too few games reach these levels.
 */
function chooseStep(steps: Map<number, Step>, open: (slot: number) => boolean) {
  const total = [...steps.values()].reduce((sum, step) => sum + step.matches, 0);
  if (total < MIN_TOTAL_GAMES) return null;
  const base = [...steps.values()].reduce((sum, step) => sum + step.wins, 0) / total;
  const candidates = [...steps.entries()].filter(([candidate, step]) => open(candidate) && step.matches / total >= MIN_SHARE)
    .map(([candidate, step]) => ({ candidate, step, smoothed: (step.wins + PRIOR_GAMES * base) / (step.matches + PRIOR_GAMES) }));
  if (!candidates.length) return null;
  const popular = [...candidates].sort((a, b) => b.step.matches - a.step.matches || a.candidate - b.candidate)[0]!;
  const best = candidates.filter(entry => entry.step.matches >= MIN_STEP_GAMES).sort((a, b) => b.smoothed - a.smoothed || a.candidate - b.candidate)[0];
  // A less common step must win clearly; a fraction of a point is noise and read as "71% beats 71%".
  const chosen = best && best.smoothed - popular.smoothed >= TIE_MARGIN ? best : popular;
  return { chosen, popular };
}

/** The suggested next ability upgrade for this hero at these levels (0-3 per ability). */
export function abilityPlan(heroId: string | null, input: readonly (number | null)[] | null): AbilityPlan | null {
  if (!heroId || !input || input.length !== 4 || input.some(rank => rank === null || !Number.isInteger(rank) || rank < 0 || rank > 3)) return null;
  const ranks = input as readonly number[];
  const rows = streetBrawlData().heroes[heroId]?.abilityOrders ?? [];
  const names = abilityNames(heroId);
  if (names.length !== 4 || ranks.every(rank => rank >= 3)) return null;
  const open = [0, 1, 2, 3].filter(slot => ranks[slot]! < 3);
  let slot: number; let winRate: number | null = null; let games = 0; let reason: string;
  const first = chooseStep(nextSteps(rows, [...ranks]), candidate => open.includes(candidate));
  if (first) {
    const { chosen: best, popular } = first;
    slot = best.candidate; games = best.step.matches; winRate = best.step.wins / best.step.matches;
    reason = popular === best ? `the most common next upgrade from your levels, and it wins ${Math.round(winRate * 100)}%`
      : `wins ${Math.round(winRate * 100)}% when taken next, more than the popular ${names[popular.candidate]} (${Math.round(popular.step.wins / popular.step.matches * 100)}%)`;
  } else {
    // Unusual levels: follow the order in which players generally raise each ability.
    slot = usualNext(rows, ranks);
    reason = rows.length ? 'players usually raise this one next' : 'next in ability order; there are no Street Brawl upgrade statistics for this hero yet';
  }
  // The rest of the match, step by step with the same rule (a clearly better-winning, well-sampled
  // step over the most common one), then the usual order once the data runs out.
  const path = [slot]; const simulated = [...ranks]; simulated[slot]!++;
  while (simulated.some(rank => rank < 3)) {
    const next = chooseStep(nextSteps(rows, simulated), candidate => simulated[candidate]! < 3)?.chosen.candidate ?? usualNext(rows, simulated);
    path.push(next); simulated[next]!++;
  }
  const then = path.slice(1, 4).map(next => names[next]!);
  const tier = ranks[slot]! + 1;
  return { slot, ability: names[slot]!, tier, cost: ABILITY_TIER_COSTS[tier - 1]!, winRate, games, then, path, reason };
}

/** The open ability whose next tier players usually take earliest (slot order covers missing data). */
function usualNext(rows: OrderRow[], ranks: readonly number[]): number {
  const position = [0, 0, 0, 0]; const weight = [0, 0, 0, 0];
  for (const row of rows) {
    const seen = [0, 0, 0, 0];
    [...row.order].forEach((character, index) => {
      const candidate = Number(character); seen[candidate]!++;
      if (seen[candidate] === ranks[candidate]! + 1) { position[candidate]! += index * row.matches; weight[candidate]! += row.matches; }
    });
  }
  const average = (slot: number) => weight[slot] ? position[slot]! / weight[slot]! : 99;
  return [0, 1, 2, 3].filter(slot => ranks[slot]! < 3).sort((a, b) => average(a) - average(b) || a - b)[0]!;
}
