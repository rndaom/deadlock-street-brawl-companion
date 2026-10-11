import { describe, expect, it } from 'vitest';
import { abilityPlan } from '../src/screen/ability-plan';

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
});
