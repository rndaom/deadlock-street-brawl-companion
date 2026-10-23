import { describe, expect, it } from 'vitest';
import { abilityBudget, abilitySpend, createAbilityRankTracker, MATCH_ABILITY_POINTS, rejectAbilityRead } from '../src/screen/ability-ranks';

describe('Street Brawl ability point arithmetic', () => {
  it('prices ranks with the 1/2/5 tier costs', () => {
    expect(abilitySpend([0, 0, 0, 0])).toBe(0);
    expect(abilitySpend([2, 0, 2, 0])).toBe(6);
    expect(abilitySpend([0, 3, 3, 1])).toBe(17);
    expect(abilitySpend([3, 1, 3, 3])).toBe(25);
    expect(abilitySpend([3, 3, 3, 3])).toBe(32);
  });
  it('grants 6/6/5/5/10 points, all 32 by round 5', () => {
    expect([1, 2, 3, 4, 5].map(abilityBudget)).toEqual([6, 12, 17, 22, 32]);
    expect(abilityBudget(null)).toBe(32);
    expect(MATCH_ABILITY_POINTS).toBe(32);
  });
  it('rejects ranks that cost more than the points that exist (real 2026-10-11 match 114924390)', () => {
    // The old tracker showed [3,1,3,3] in round 3: 25 AP where only 17 exist.
    expect(rejectAbilityRead([3, 1, 3, 3], { round: 3 })).toMatch(/25 AP/);
    expect(rejectAbilityRead([2, 0, 2, 0], { round: 2 })).toBeNull();
    // Round 2 HUD after the grant: 6 spent + 6 unspent = 12, all of them.
    expect(rejectAbilityRead([2, 0, 2, 0], { round: 2, points: 6 })).toBeNull();
    expect(rejectAbilityRead([3, 0, 2, 0], { round: 2, points: 6 })).toMatch(/unspent/);
    expect(rejectAbilityRead([4, 0, 0, 0])).toBe('malformed');
    expect(rejectAbilityRead([0, 0, 0])).toBe('malformed');
  });
});

describe('ability rank tracker', () => {
  it('needs the same ranks twice before showing them; reads without the panel do not break the run', () => {
    const ranks = createAbilityRankTracker();
    ranks.observe([2, 0, 2, 0], { round: 2 });
    expect(ranks.ranks()).toBeNull();
    ranks.observe(null, { round: 2 });
    ranks.observe([2, 0, 2, 0], { round: 2 });
    expect(ranks.ranks()).toEqual([2, 0, 2, 0]);
  });

  it('ignores a one-off banner misread instead of keeping it for the match (real sequence)', () => {
    const ranks = createAbilityRankTracker();
    // Round 1 draft, all open.
    ranks.observe([0, 0, 0, 0], { round: 1 }); ranks.observe([0, 0, 0, 0], { round: 1 });
    expect(ranks.ranks()).toEqual([0, 0, 0, 0]);
    // "HOLD TAB TO UPGRADE" fading in read as one bought tier everywhere.
    ranks.observe([1, 1, 1, 1], { round: 1 });
    expect(ranks.ranks()).toEqual([0, 0, 0, 0]);
    // Round 2 draft: truth [2,0,2,0]; the old max-merge showed [2,1,2,1] here.
    ranks.observe([2, 0, 2, 0], { round: 2 }); ranks.observe([2, 0, 2, 0], { round: 2 });
    expect(ranks.ranks()).toEqual([2, 0, 2, 0]);
    ranks.observe([2, 2, 2, 2], { round: 2 });
    expect(ranks.ranks()).toEqual([2, 0, 2, 0]);
    // Impossible however often it is read.
    for (let read = 0; read < 5; read++) ranks.observe([3, 1, 3, 3], { round: 3 });
    expect(ranks.ranks()).toEqual([2, 0, 2, 0]);
    expect(ranks.lastRejection()).toMatch(/only 17/);
  });

  it('corrects a wrong level downward after three consistent reads', () => {
    const ranks = createAbilityRankTracker();
    ranks.observe([2, 1, 2, 1]); ranks.observe([2, 1, 2, 1]);
    expect(ranks.ranks()).toEqual([2, 1, 2, 1]);
    ranks.observe([2, 0, 2, 0]); ranks.observe([2, 0, 2, 0]);
    expect(ranks.ranks()).toEqual([2, 1, 2, 1]);
    ranks.observe([2, 0, 2, 0]);
    expect(ranks.ranks()).toEqual([2, 0, 2, 0]);
  });

  it('never lowers a rank from the item-draft screen, where the game dims a column (real Infernus match, 2026-10-16)', () => {
    const ranks = createAbilityRankTracker();
    ranks.observe([1, 3, 3, 0], { round: 4 }); ranks.observe([1, 3, 3, 0], { round: 4 });
    // Flame Dash's bought tiers read as open on every draft frame; this used to win after three reads.
    for (let read = 0; read < 10; read++) ranks.observe([1, 0, 3, 0], { round: 4, draft: true });
    expect(ranks.ranks()).toEqual([1, 3, 3, 0]);
    // The same draft frames still raise the columns that were bought.
    ranks.observe([2, 0, 3, 2], { round: 5, draft: true }); ranks.observe([2, 0, 3, 2], { round: 5, draft: true });
    expect(ranks.ranks()).toEqual([2, 3, 3, 2]);
  });

  it('confirms each column on its own, so the last upgrade of a Tab hold is not lost (real 2026-10-13 sequence)', () => {
    const ranks = createAbilityRankTracker();
    ranks.observe([2, 0, 3, 0], { round: 3 }); ranks.observe([2, 0, 3, 0], { round: 3 });
    // Two upgrades bought while Tab is held; no two whole-panel reads were ever identical.
    ranks.observe([2, 1, 3, 0], { round: 3 });
    ranks.observe([3, 1, 3, 0], { round: 3 });
    // The cursor covers the second column while the next tier is bought.
    ranks.observe([3, null, 3, 0], { round: 3 });
    expect(ranks.ranks()).toEqual([3, 1, 3, 0]);
  });

  it('shows a column read under a tooltip as unknown instead of discarding the whole panel', () => {
    const ranks = createAbilityRankTracker();
    ranks.observe([0, 0, 2, null], { round: 1 }); ranks.observe([0, 0, 2, null], { round: 1 });
    expect(ranks.ranks()).toEqual([0, 0, 2, null]);
    expect(rejectAbilityRead([null, null, null, null])).toBe('malformed');
  });

  it('shows at once a read that accounts for every point granted so far, and rejects the banner by the counter', () => {
    const ranks = createAbilityRankTracker();
    ranks.observe([0, 3, 3, 1], { round: 3, points: 0 });
    expect(ranks.ranks()).toEqual([0, 3, 3, 1]);
    const fresh = createAbilityRankTracker();
    // Round 2 HUD: 6 spent, 6 unspent. The banner read [2,2,2,2] costs exactly 12 but the counter rules it out.
    fresh.observe([2, 2, 2, 2], { round: 2, points: 6 });
    expect(fresh.ranks()).toBeNull();
    expect(fresh.lastRejection()).toMatch(/unspent/);
    fresh.observe([2, 0, 2, 0], { round: 2, points: 6 });
    expect(fresh.ranks()).toEqual([2, 0, 2, 0]);
  });

  it('follows real purchases upward and clears on reset', () => {
    const ranks = createAbilityRankTracker();
    for (const read of [[0, 2, 3, 1], [0, 2, 3, 1], [0, 3, 3, 1], [0, 3, 3, 1]]) ranks.observe(read, { round: 3 });
    expect(ranks.ranks()).toEqual([0, 3, 3, 1]);
    ranks.reset();
    expect(ranks.ranks()).toBeNull();
  });
});

describe('single trustworthy reads (real 2026-10-18 matches: players open the panel once per purchase)', () => {
  /** Replays [round, ranks, draft?] reads in order and returns what was shown after each. */
  const replay = (reads: [number, (number | null)[], boolean?][]) => {
    const ranks = createAbilityRankTracker();
    return reads.map(([round, read, draft]) => { ranks.observe(read, { round, draft: !!draft }); return ranks.ranks(); });
  };
  it('shows the last upgrade of match C at once ([2,3,3,2] = 22 AP in round 4 at 18:30:59)', () => {
    const shown = replay([[3, [1, 3, 3, 0], true], [3, [1, 3, 3, 0], true], [4, [1, 3, 3, 0], true], [4, [1, 3, 3, 0]], [4, [2, 3, 3, 2]]]);
    expect(shown.at(-1)).toEqual([2, 3, 3, 2]);
  });
  it('follows match C round by round without waiting for the next draft', () => {
    const shown = replay([
      [1, [0, 0, 0, 0], true], [1, [0, 0, 0, 0], true],
      // 18:22:40-44: the third column is bought, then the second; the cursor covers the ult.
      [1, [0, 0, 2, null]], [1, [0, 0, 2, null]], [1, [0, 2, 2, null]],
      [2, [0, 2, 2, 0], true],
      // 18:24:46.9 and 18:24:47.9: two purchases on consecutive reads.
      [2, [0, 2, 3, 0]], [2, [1, 2, 3, 0]],
      [3, [1, 2, 3, 0], true], [3, [1, 3, 3, 0]]]);
    expect(shown[4]).toEqual([0, 2, 2, 0]); // 18:22:44, not 18:24:24
    expect(shown[6]).toEqual([0, 2, 3, 0]);
    expect(shown[7]).toEqual([1, 2, 3, 0]); // 18:24:47.9, not 18:26:49
    expect(shown[9]).toEqual([1, 3, 3, 0]);
  });
  it('accepts match B partly covered reads that spend every point ([2,1,3,·] and [3,1,·,·])', () => {
    const shown = replay([[1, [0, 0, 0, 0], true], [1, [0, 0, 0, 0], true], [2, [2, 0, 2, 0], true],
      [2, [2, 1, 3, null]], [3, [2, 1, 3, 0], true], [3, [3, 1, null, null]]]);
    expect(shown[2]).toEqual([2, 0, 2, 0]);
    expect(shown[3]).toEqual([2, 1, 3, 0]);
    expect(shown[5]).toEqual([3, 1, 3, 0]);
  });
  it('still needs two reads for a banner-shaped rise, even one that costs exactly the round budget', () => {
    expect(replay([[2, [2, 0, 2, 0], true], [2, [2, 0, 2, 0], true], [2, [2, 2, 2, 2]]]).at(-1)).toEqual([2, 0, 2, 0]);
    expect(replay([[1, [0, 0, 0, 0], true], [1, [0, 0, 0, 0], true], [1, [1, 1, 1, 1]]]).at(-1)).toEqual([0, 0, 0, 0]);
  });
  it('does not trust a single partial read that leaves points unspent, or a first read of the match', () => {
    expect(replay([[1, [0, 0, 0, 0], true], [1, [0, 0, 0, 0], true], [1, [0, 0, 2, null]]]).at(-1)).toEqual([0, 0, 0, 0]);
    expect(replay([[3, [2, 1, 3, 0]]]).at(-1)).toBeNull();
  });
  it('a draft read with a dimmed column can still prove a rise when it spends every point', () => {
    // Round 3 draft after [2,1,3,0]: the second column is dimmed (reads 0), the first rose to 3 (17 AP).
    expect(replay([[2, [2, 1, 3, 0]], [2, [2, 1, 3, 0]], [3, [3, 0, 3, 0], true]]).at(-1)).toEqual([3, 1, 3, 0]);
  });
});
