import { CONTEXT_CATALOG } from '../shared/context-catalog';

/**
 * Own ability upgrade ranks (0-3 per ability) during one Street Brawl match, from the upgrade panel
 * that the game only shows with Tab held and during the draft.
 *
 * The panel reader is strict, but one bad read must never decide the ranks for the rest of a match.
 * Real failures this guards against:
 *  - 2026-10-11: the green "HOLD TAB TO UPGRADE" banner read as one or two bought tiers in every
 *    column, and an "only rises" merge kept [2,0,2,0] as [2,1,2,1] (25 AP in round 3, where 17 exist).
 *  - 2026-10-13/16: during the item draft the game dims one column, its bought tiers read as open,
 *    and three such reads lowered Flame Dash from 3 to 0 for nine minutes.
 *  - The final upgrade of a Tab hold was often read once and never confirmed, because the whole
 *    panel had to read identically twice in a row.
 *  - 2026-10-18: players open the panel once per purchase, so a rise was usually read once and then
 *    not again until the next draft: ranks lagged a round, and the last upgrade of a match
 *    ([2,3,3,2] for 22 AP in round 4) never showed.
 * So:
 *  - a read must be possible: its cost fits the points granted by the current round, also with the
 *    visible unspent points added;
 *  - a read that is exactly consistent (complete, and its cost plus the unspent points on the same
 *    frame is every point granted so far) is shown at once;
 *  - a rise is also shown at once when the read is trustworthy on its own: no column below the shown
 *    rank, affordable in the known round, not shaped like the banner misread (two or more columns
 *    lifted to the same floor), and either complete or costing exactly the round's points (a
 *    covered column then cannot be higher than shown);
 *  - otherwise each column is confirmed on its own: a rank shows once two of that column's last four
 *    reads agree on it, and a column covered by the cursor or a tooltip (null) adds nothing;
 *  - ranks never fall within a match, so a lower rank needs three reads in a row from the Tab panel,
 *    and draft-screen reads never lower anything (a dimmed column counts as covered).
 */

/** Tier costs bottom to top (1, 2 and 5 AP); a rank's cumulative cost is 0, 1, 3 or 8. */
export const ABILITY_TIER_COSTS = [1, 2, 5] as const;
const POINTS_PER_ROUND: readonly number[] = CONTEXT_CATALOG.streetBrawl.abilityPointsPerRound.length
  ? CONTEXT_CATALOG.streetBrawl.abilityPointsPerRound : [6, 6, 5, 5, 10];
/** Every point of a full Street Brawl match (6+6+5+5+10 = 32), exactly all twelve tiers. */
export const MATCH_ABILITY_POINTS = POINTS_PER_ROUND.reduce((sum, points) => sum + points, 0);

/** Reads of one column that must agree on a rank before it shows... */
const RISE_READS = 2;
/** ...among this many of that column's latest reads. */
const COLUMN_HISTORY = 4;
/** Tab-panel reads in a row needed to lower a shown rank (a past misread must still be correctable). */
const LOWER_READS = 3;

/** One panel read: a rank per column, null where that column was covered or unreadable. */
export type AbilityPanelRead = readonly (number | null)[];

/** Ability points spent on these ranks (unknown columns count as nothing bought). */
export function abilitySpend(ranks: readonly (number | null)[]): number {
  return ranks.reduce<number>((sum, rank) => sum + ABILITY_TIER_COSTS.slice(0, rank ?? 0).reduce((tiers, cost) => tiers + cost, 0), 0);
}

const roundKnown = (round: number | null | undefined): round is number => round != null && Number.isInteger(round) && round >= 1;

/** Most ability points a player can have received by this round (granted at its start); unknown round = whole match. */
export function abilityBudget(round: number | null | undefined): number {
  if (!roundKnown(round) || round >= POINTS_PER_ROUND.length) return MATCH_ABILITY_POINTS;
  return POINTS_PER_ROUND.slice(0, round).reduce((sum, points) => sum + points, 0);
}

export interface AbilityReadContext {
  /** The round read from the screen, if known. */
  round?: number | null;
  /** Unspent ability points read from the HUD counter on the same frame, if any. */
  points?: number | null;
  /** The read came from the item-draft screen, where the game dims columns: it may raise ranks, never lower them. */
  draft?: boolean;
}

/** Why a read was not used, for diagnostics; null when it was usable. */
export function rejectAbilityRead(ranks: AbilityPanelRead, context: AbilityReadContext = {}): string | null {
  if (ranks.length !== 4 || ranks.some(rank => rank !== null && (!Number.isInteger(rank) || rank < 0 || rank > 3))
    || ranks.every(rank => rank === null)) return 'malformed';
  const spent = abilitySpend(ranks);
  const budget = abilityBudget(context.round);
  if (spent > budget) return `costs ${spent} AP, only ${budget} exist by round ${context.round}`;
  const points = context.points;
  if (points != null && Number.isInteger(points) && points >= 0 && spent + points > budget)
    return `costs ${spent} AP with ${points} unspent, only ${budget} exist${context.round == null ? '' : ` by round ${context.round}`}`;
  return null;
}

/**
 * A complete read whose cost plus the unspent points on the same frame is every point granted so far.
 * Under-reads (dimmed or covered tiers) spend less, and the banner misreads ([1,1,1,1], [2,2,2,2])
 * only show while points are unspent, so they overshoot. The counter is required: without it,
 * [2,2,2,2] costs exactly round 2's twelve points.
 */
function exactRead(ranks: AbilityPanelRead, context: AbilityReadContext): boolean {
  const points = context.points;
  if (!roundKnown(context.round) || ranks.some(rank => rank === null) || points == null || !Number.isInteger(points) || points < 0) return false;
  return abilitySpend(ranks) + points === abilityBudget(context.round);
}

/**
 * The "HOLD TAB TO UPGRADE" banner fading in over the panel reads as the lowest one or two tiers
 * bought in every column: the open columns appear raised to 1 (or 2). A rise that lifts two or
 * more open columns to the same floor while every column is at least that floor could be exactly
 * that, so it is never trusted from one read. (The native reader rejects banner-covered panels
 * since 2026-10-13; this stays as a second guard. A rise from an already bought tier, such as
 * [1,3,3,0] to [2,3,3,2] in match C, is not this shape.)
 */
function bannerShaped(read: readonly number[], before: readonly number[]): boolean {
  const risen = read.map((rank, slot) => rank > before[slot]!);
  if (risen.filter(Boolean).length < 2 || read.some((_, slot) => risen[slot] && before[slot] !== 0)) return false;
  return [1, 2].some(floor => read.every(rank => rank >= floor) && read.every((rank, slot) => !risen[slot] || rank === floor));
}

/**
 * The ranks one read proves on its own, or null when it needs confirmation from another read.
 * @param before the shown ranks (null columns unknown).
 * @param read the panel read, with columns the draft screen dims (lower than shown) already nulled.
 */
function trustedRise(read: AbilityPanelRead, before: readonly (number | null)[] | null, context: AbilityReadContext): number[] | null {
  const base = (before ?? [null, null, null, null]).map(rank => rank ?? 0);
  if (read.some((rank, slot) => rank !== null && rank < base[slot]!)) return null;
  const filled = read.map((rank, slot) => rank ?? base[slot]!);
  if (!filled.some((rank, slot) => rank > base[slot]!) && before !== null) return null;
  const points = context.points;
  const spent = abilitySpend(filled);
  const budget = abilityBudget(context.round);
  if (spent > budget || points != null && Number.isInteger(points) && points >= 0 && spent + points > budget) return null;
  if (bannerShaped(filled, base)) return null;
  const complete = read.every(rank => rank !== null);
  // Every point of the round spent: a covered column cannot hold more than its shown rank either.
  if (roundKnown(context.round) && spent === budget && (complete || before !== null)) return filled;
  // A complete rise over known ranks in a known round: one purchase per panel opening.
  if (complete && before !== null && before.every(rank => rank !== null) && (roundKnown(context.round) || points != null)) return filled;
  return null;
}

export function createAbilityRankTracker() {
  let shown: (number | null)[] | null = null;
  let history: number[][] = [[], [], [], []];
  let lowerRuns = [0, 0, 0, 0];
  let lastRejection: string | null = null;

  return {
    /** One read of the panel (null when it was not on screen). */
    observe(ranks: AbilityPanelRead | null | undefined, context: AbilityReadContext = {}) {
      if (!ranks) return;
      lastRejection = rejectAbilityRead(ranks, context);
      if (lastRejection) return;
      if (exactRead(ranks, context)) {
        shown = ranks.map(rank => rank!);
        history = shown.map(rank => [rank!]); lowerRuns = [0, 0, 0, 0];
        return;
      }
      // The draft screen dims a column so its bought tiers read as open: a lower draft column is covered, not lowered.
      const visible = context.draft && shown ? ranks.map((rank, slot) => rank !== null && shown![slot] != null && rank < shown![slot]! ? null : rank) : ranks;
      const trusted = visible.some(rank => rank !== null) ? trustedRise(visible, shown, context) : null;
      if (trusted) {
        // The new ranks replace the old evidence: older, lower reads must not hold a column back.
        shown = trusted;
        history = trusted.map(rank => [rank]); lowerRuns = [0, 0, 0, 0];
        return;
      }
      const before = shown ? [...shown] : [null, null, null, null];
      const next = [...before];
      ranks.forEach((rank, slot) => {
        if (rank === null) return;
        const current = next[slot]!;
        if (current !== null && rank < current) {
          if (context.draft) return;
          lowerRuns[slot]!++;
          if (lowerRuns[slot]! >= LOWER_READS) { next[slot] = rank; lowerRuns[slot] = 0; history[slot] = [rank]; }
          return;
        }
        lowerRuns[slot] = 0;
        history[slot] = [...history[slot]!, rank].slice(-COLUMN_HISTORY);
        const agreed = [3, 2, 1, 0].find(level => history[slot]!.filter(seen => seen === level).length >= RISE_READS);
        if (agreed !== undefined && (current === null || agreed > current)) {
          next[slot] = agreed;
          // Ranks only rise: older lower reads of this column are stale.
          history[slot] = history[slot]!.filter(seen => seen >= agreed);
        }
      });
      // Columns confirmed from different reads must still be affordable together.
      if (rejectAbilityRead(next.every(rank => rank === null) ? [0, 0, 0, 0] : next, context)) {
        for (let slot = 0; slot < 4; slot++) if ((next[slot] ?? -1) > (before[slot] ?? -1)) next[slot] = before[slot]!;
      }
      shown = next.every(rank => rank === null) ? null : next;
    },
    /** The confirmed rank per ability (null for one not confirmed yet), or null when nothing is known. */
    ranks(): (number | null)[] | null { return shown ? [...shown] : null; },
    /** Why the latest read was not used (null if it was). */
    lastRejection(): string | null { return lastRejection; },
    reset() { shown = null; history = [[], [], [], []]; lowerRuns = [0, 0, 0, 0]; lastRejection = null; },
  };
}
