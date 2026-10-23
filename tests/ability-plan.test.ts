import { describe, expect, it } from 'vitest';
import { abilityPlan } from '../src/screen/ability-plan';
import { abilitySpend } from '../src/screen/ability-ranks';
import { CONTEXT_CATALOG } from '../src/shared/context-catalog';

const abilityNames = (heroId: string) => (CONTEXT_CATALOG.abilities as unknown as { heroId: string; slot: number; name: string }[])
  .filter(ability => ability.heroId === heroId).sort((a, b) => a.slot - b.slot).map(ability => ability.name);

describe('Street Brawl ability upgrade plan', () => {
  it('suggests an open ability with its next tier, cost and supporting games', () => {
    const plan = abilityPlan('hero_haze', [1, 0, 2, 0])!;
    expect(plan).not.toBeNull();
    expect([0, 1, 2, 3]).toContain(plan.slot);
    expect(plan.tier).toBe([1, 0, 2, 0][plan.slot]! + 1);
    expect(plan.cost).toBe([1, 2, 5][plan.tier - 1]);
    expect(plan.games).toBeGreaterThan(0);
  });
  it('never suggests a maxed ability and stops when everything is maxed', () => {
    for (let slot = 0; slot < 4; slot++) {
      const ranks = [2, 2, 2, 2]; ranks[slot] = 3;
      expect(abilityPlan('hero_necro', ranks)!.slot).not.toBe(slot);
    }
    expect(abilityPlan('hero_necro', [3, 3, 3, 3])).toBeNull();
  });
  it('needs a known hero and readable ranks', () => {
    expect(abilityPlan(null, [0, 0, 0, 0])).toBeNull();
    expect(abilityPlan('hero_haze', null)).toBeNull();
  });
  it('names the read hero’s own abilities for real 2026-10-11 levels', () => {
    const cases: [string, number[]][] = [['hero_ratking', [0, 0, 0, 0]], ['hero_ratking', [2, 0, 2, 0]], ['hero_inferno', [0, 2, 3, 1]], ['hero_inferno', [0, 3, 3, 1]]];
    for (const [heroId, ranks] of cases) {
      const plan = abilityPlan(heroId, ranks)!;
      const names = abilityNames(heroId);
      expect(ranks[plan.slot]).toBeLessThan(3);
      expect(plan.ability).toBe(names[plan.slot]);
      expect(plan.tier).toBe(ranks[plan.slot]! + 1);
      expect(plan.cost).toBe([1, 2, 5][plan.tier - 1]);
      for (const next of plan.then) expect(names).toContain(next);
    }
    // Rat King players at [2,0,2,0] (round 2, 6 points to spend) overwhelmingly finish Scrap Grenade next.
    expect(abilityPlan('hero_ratking', [2, 0, 2, 0])).toMatchObject({ slot: 0, ability: 'Scrap Grenade', tier: 3, cost: 5 });
  });
  it('does not prefer a less common step over a tie it cannot tell apart', () => {
    for (const heroId of ['hero_ratking', 'hero_inferno', 'hero_haze', 'hero_necro']) {
      for (const ranks of [[0, 0, 0, 0], [3, 0, 2, 0], [2, 0, 2, 0], [1, 1, 1, 0]]) {
        const plan = abilityPlan(heroId, ranks);
        const shown = plan?.reason.match(/wins (\d+)% when taken next, more than the popular .* \((\d+)%\)/);
        if (shown) expect(Number(shown[1])).toBeGreaterThan(Number(shown[2]));
      }
    }
  });
  it('walks every hero from nothing to all twelve tiers, spending exactly the 32 points of a match', () => {
    for (const heroId of ['hero_ratking', 'hero_inferno', 'hero_chessmaster', 'hero_haze']) {
      const ranks = [0, 0, 0, 0];
      for (let step = 0; step < 12; step++) {
        const plan = abilityPlan(heroId, ranks)!;
        expect(plan.tier).toBe(ranks[plan.slot]! + 1);
        ranks[plan.slot]!++;
      }
      expect(ranks).toEqual([3, 3, 3, 3]);
      expect(abilitySpend(ranks)).toBe(32);
      expect(abilityPlan(heroId, ranks)).toBeNull();
    }
  });
  it('builds the "Then" chain with the same rule as the next step (win rate over popularity when well sampled)', () => {
    for (const heroId of ['hero_ratking', 'hero_inferno', 'hero_haze', 'hero_necro', 'hero_artist']) {
      for (const start of [[0, 0, 0, 0], [1, 0, 1, 0], [2, 1, 1, 0]]) {
        const plan = abilityPlan(heroId, start)!;
        const ranks = [...start];
        for (const [index, slot] of plan.path.entries()) {
          // Each step of the path is what the plan itself suggests from the levels reached so far.
          expect(abilityPlan(heroId, ranks)!.slot).toBe(slot);
          if (index > 0 && index <= 3) expect(plan.then[index - 1]).toBe(abilityNames(heroId)[slot]);
          ranks[slot]!++;
        }
      }
    }
  });
  it('rejects malformed levels', () => {
    expect(abilityPlan('hero_haze', [4, 0, 0, 0])).toBeNull();
    expect(abilityPlan('hero_haze', [0, 0, 0])).toBeNull();
  });
});
