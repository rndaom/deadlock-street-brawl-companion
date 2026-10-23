import { describe, expect, it } from 'vitest';
import { abilityPlan } from '../src/screen/ability-plan';
import { enemyThreat, matchInsights } from '../src/screen/match-insights';
import { APP_CATALOG } from '../src/app/catalog';
import { streetBrawlData } from '../src/screen/street-brawl-data';
import { componentsOf } from '../src/screen/item-bundles';
import { levelCells, matchupTone } from '../src/renderer/view';

describe('full ability upgrade path', () => {
  it('lists every remaining tier exactly once, starting with the suggested upgrade', () => {
    for (const heroId of ['hero_haze', 'hero_ratking', 'hero_artist', 'hero_deadpack', 'hero_baba']) {
      for (const ranks of [[0, 0, 0, 0], [1, 1, 0, 1], [3, 0, 2, 0], [3, 3, 3, 2]]) {
        const plan = abilityPlan(heroId, ranks)!;
        expect(plan.path[0]).toBe(plan.slot);
        const remaining = ranks.map((rank) => 3 - rank);
        expect(plan.path).toHaveLength(remaining.reduce((sum, value) => sum + value, 0));
        for (let slot = 0; slot < 4; slot++) expect(plan.path.filter((step) => step === slot)).toHaveLength(remaining[slot]!);
      }
    }
  });
  it('has a plan for the newest hero, Violet', () => {
    const plan = abilityPlan('hero_artist', [0, 0, 0, 0])!;
    expect(plan).not.toBeNull();
    expect(plan.games).toBeGreaterThan(0);
    expect(['Living Ink', 'Flow State', 'Still Life', 'Abstract Landscape']).toContain(plan.ability);
  });
});

describe('upgrade grid cells', () => {
  it('marks bought tiers, the next tier and the plan order', () => {
    const { cells } = levelCells([2, 1, 1, 1], [0, 1, 2, 3, 1, 2, 3], null);
    expect(cells[0]!.map((cell) => cell.state)).toEqual(['owned', 'owned', 'next']);
    expect(cells[1]!.map((cell) => [cell.state, cell.step])).toEqual([['owned', null], ['planned', 2], ['planned', 5]]);
    expect(cells[3]!.map((cell) => cell.step)).toEqual([null, 4, 7]);
  });
  it('marks the planned upgrades the unspent points pay for, in order, stopping at the first it cannot afford', () => {
    // Next is a 5-point tier, then a 2-point tier: 6 points buy only the first.
    const six = levelCells([2, 1, 1, 1], [0, 1, 2, 3, 1, 2, 3], 6);
    expect(six.affordableSteps).toBe(1);
    expect(six.cells[0]![2]!.affordable).toBe(true);
    expect(six.cells[1]![1]!.affordable).toBe(false);
    const nine = levelCells([2, 1, 1, 1], [0, 1, 2, 3, 1, 2, 3], 9);
    expect(nine.affordableSteps).toBe(3);
    expect(levelCells([0, 0, 0, 0], [0, 1], 0).affordableSteps).toBe(0);
  });
  it('treats unread ranks as nothing bought', () => {
    const { cells } = levelCells([null, null, null, null], [2], null);
    expect(cells[2]![0]!.state).toBe('next');
    expect(cells.flat().filter((cell) => cell.state === 'owned')).toHaveLength(0);
  });
});

describe('match insights', () => {
  const data = streetBrawlData();
  it('orders matchups toughest first and uses real Street Brawl games', () => {
    const insights = matchInsights('hero_haze', ['hero_ratking', 'hero_inferno', 'hero_wraith', 'hero_ghost'], [])!;
    expect(insights.matchups.length).toBeGreaterThan(0);
    for (let index = 1; index < insights.matchups.length; index++) expect(insights.matchups[index]!.delta).toBeGreaterThanOrEqual(insights.matchups[index - 1]!.delta);
    for (const matchup of insights.matchups) expect(matchup.matches).toBeGreaterThanOrEqual(200);
    expect(insights.heroGames).toBeGreaterThan(1000);
  });
  it('wishes only for items not owned, never for components already built into owned items, compared within a tier', () => {
    const owned = ['upgrade_rapid_rounds', 'upgrade_headshot_booster', 'upgrade_vampire'];
    const insights = matchInsights('hero_haze', ['hero_inferno'], owned)!;
    const absorbed = new Set(owned.flatMap((id) => componentsOf(id)));
    expect(insights.wishlist.length).toBeGreaterThan(0);
    for (const row of insights.wishlist) {
      expect(row.items.length).toBeLessThanOrEqual(3);
      for (const entry of row.items) {
        expect(owned).not.toContain(entry.itemId);
        expect(absorbed.has(entry.itemId)).toBe(false);
        expect(data.items[entry.itemId]!.tier).toBe(row.tier);
      }
    }
  });
  it('ignores the own hero in the enemy list and unknown heroes', () => {
    const insights = matchInsights('hero_haze', ['hero_haze', 'hero_not_real'], [])!;
    expect(insights.matchups).toEqual([]);
    expect(matchInsights(null, [], [])).toBeNull();
    expect(matchInsights('hero_not_real', [], [])).toBeNull();
  });
  it('covers Violet', () => {
    const insights = matchInsights('hero_artist', ['hero_haze', 'hero_atlas'], [])!;
    expect(insights.heroWinRate).not.toBeNull();
    expect(insights.wishlist.length).toBeGreaterThan(0);
  });
  it('colours only clear matchups', () => {
    expect(matchupTone(-0.05)).toBe('hard');
    expect(matchupTone(0.01)).toBe('even');
    expect(matchupTone(0.04)).toBe('good');
  });
});

describe('enemy threat summary', () => {
  const hero = (id: string) => APP_CATALOG.heroes.find((entry) => entry.id === id)!;
  const item = (id: string) => APP_CATALOG.items.find((entry) => entry.id === id)!;
  it('reads a spirit team and its healing, and says what to take first', () => {
    // Seven and Lady Geist (spirit kits) with spirit damage and healing items.
    const threat = enemyThreat([hero('hero_gigawatt'), hero('hero_ghost')],
      ['upgrade_improved_spirit', 'upgrade_extra_charge', 'upgrade_magic_tempo', 'upgrade_healing_booster', 'upgrade_health_stealing_magic', 'upgrade_healbuff'].map(item))!;
    expect(threat.lead).toBe('spirit');
    expect(threat.damage!.spirit + threat.damage!.gun + threat.damage!.melee).toBe(100);
    expect(threat.damage!.spirit).toBeGreaterThanOrEqual(50);
    expect(threat.heavyHealing).toBe(true);
    expect(threat.priority).toBe('Spirit resist first; anti-heal if offered.');
    expect(threat).toMatchObject({ heroes: 2, items: 6 });
  });
  it('reads a gun team as bullet resist first', () => {
    const threat = enemyThreat([hero('hero_inferno'), hero('hero_wraith')], ['upgrade_clip_size', 'upgrade_high_velocity_mag', 'upgrade_rapid_rounds'].map(item))!;
    expect(threat.lead).toBe('gun');
    expect(threat.priority).toBe('Bullet resist first.');
  });
  it('calls an even team mixed, and flags heavy control items', () => {
    const threat = enemyThreat([hero('hero_gigawatt'), hero('hero_wraith')],
      APP_CATALOG.items.filter((entry) => entry.tags.includes('crowd-control')).slice(0, 3))!;
    expect(threat.control).toBe(3);
    expect(threat.heavyControl).toBe(true);
    expect(threat.priority).toMatch(/debuff remover if offered\.$/);
  });
  it('rounds the damage mix to whole percents that sum to exactly 100', () => {
    // Seven (spirit) + Wraith (gun) + one melee item, each a third after weighting: 33.3% three ways.
    const melee = APP_CATALOG.items.find((entry) => entry.tags.includes('melee'))!;
    const threat = enemyThreat([hero('hero_gigawatt'), hero('hero_wraith')], [melee, melee])!;
    expect(threat.damage!.spirit + threat.damage!.gun + threat.damage!.melee).toBe(100);
    expect(Object.values(threat.damage!).sort()).toEqual([33, 33, 34]);
  });
  it('says nothing before an enemy or item is read', () => {
    expect(enemyThreat([], [])).toBeNull();
  });
});
