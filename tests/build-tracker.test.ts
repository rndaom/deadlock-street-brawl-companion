import { describe, expect, it } from 'vitest';
import { createBuildTracker } from '../src/screen/build-tracker';
import type { NativeBrawlLayout } from '../src/shared/screen-reading';

const layout = (mine: [number, string][], players: [number, number, string][] = [], abilityRanks: number[] | null = null): NativeBrawlLayout => ({
  myItems: mine.map(([slot, itemId]) => ({ slot, itemId, confidence: 0.95 })),
  playerItems: players.map(([seat, slot, itemId]) => ({ seat, slot, itemId, confidence: 0.95 })),
  abilityRanks, hiddenItems: 0,
});

describe('match build tracker', () => {
  it('needs two reads before showing an item and ignores a one-off misread', () => {
    const build = createBuildTracker();
    build.observe(layout([[0, 'upgrade_burst_fire'], [1, 'upgrade_frostbite_charm']]));
    expect(build.snapshot().myItems).toEqual([]);
    build.observe(layout([[0, 'upgrade_burst_fire']]));
    expect(build.snapshot().myItems).toEqual(['upgrade_burst_fire']);
  });

  it('keeps one entry per item when the game moves it to another slot', () => {
    const build = createBuildTracker();
    for (let read = 0; read < 5; read++) build.observe(layout([[0, 'upgrade_divine_barrier'], [1, 'upgrade_healbane']]));
    for (let read = 0; read < 5; read++) build.observe(layout([[0, 'upgrade_healbane'], [9, 'upgrade_divine_barrier'], [1, 'upgrade_burst_fire']]));
    expect(build.snapshot().myItems).toEqual(['upgrade_healbane', 'upgrade_burst_fire', 'upgrade_divine_barrier']);
  });

  it('keeps an item that is briefly unread, and drops one that stays gone', () => {
    const build = createBuildTracker();
    for (let read = 0; read < 10; read++) build.observe(layout([[0, 'upgrade_active_reload'], [1, 'upgrade_healbane']]));
    build.observe(layout([[1, 'upgrade_healbane']]));
    expect(build.snapshot().myItems).toContain('upgrade_active_reload');
    for (let read = 0; read < 80; read++) build.observe(layout([[1, 'upgrade_healbane']]));
    expect(build.snapshot().myItems).toEqual(['upgrade_healbane']);
  });

  it('does not fade items on reads where the inventory was not visible', () => {
    const build = createBuildTracker();
    for (let read = 0; read < 3; read++) build.observe(layout([[0, 'upgrade_active_reload']], [[4, 0, 'upgrade_toxic_bullets']]));
    for (let read = 0; read < 200; read++) build.observe(layout([]));
    expect(build.snapshot()).toMatchObject({ myItems: ['upgrade_active_reload'] });
    expect(build.snapshot().seatItems[4]).toEqual(['upgrade_toxic_bullets']);
  });

  it('shows ability ranks read twice, rejects unaffordable ones, and clears everything on reset', () => {
    const build = createBuildTracker();
    build.observe(layout([], [], [2, 0, 2, 0]), { round: 2 });
    expect(build.snapshot().abilityRanks).toBeNull();
    build.observe(layout([], [], [2, 0, 2, 0]), { round: 2 });
    expect(build.snapshot().abilityRanks).toEqual([2, 0, 2, 0]);
    // A single misread is not merged in any more (it used to become [2,1,2,1]).
    build.observe(layout([], [], [1, 1, 1, 1]), { round: 2 });
    expect(build.snapshot().abilityRanks).toEqual([2, 0, 2, 0]);
    for (let read = 0; read < 3; read++) build.observe(layout([], [], [3, 1, 3, 3]), { round: 3 });
    expect(build.snapshot().abilityRanks).toEqual([2, 0, 2, 0]);
    build.reset();
    expect(build.snapshot()).toEqual({ myItems: [], seatItems: Array(8).fill([]), abilityRanks: null, hiddenEnemyItems: 0 });
  });

  // Own-inventory reads of real HUD frames (2026-10-11 20:05-20:10Z, native replay). The true
  // inventory held 9 items throughout; actives dimmed on cooldown (Metal Skin, Radiant
  // Regeneration, Reactive Barrier) were only recognized on some reads.
  const real = (ids: string): [number, string][] => ids.split(' ').map(entry => { const [slot, id] = entry.split(':'); return [Number(slot), `upgrade_${id}`]; });
  const reads = [
    real('0:close_range 1:intensifying_clip 2:metal_skin 3:resonant_healing 4:arctic_blast 8:bullet_resist_shredder 9:vex_barrier 10:tech_damage_pulse 11:hollow_point_rounds'),
    real('0:close_range 1:intensifying_clip 4:arctic_blast 8:bullet_resist_shredder 10:tech_damage_pulse 11:hollow_point_rounds'),
    real('0:close_range 1:intensifying_clip 3:resonant_healing 4:arctic_blast 8:bullet_resist_shredder 10:tech_damage_pulse 11:hollow_point_rounds'),
    real('0:close_range 1:intensifying_clip 4:arctic_blast 8:bullet_resist_shredder 9:vex_barrier 10:tech_damage_pulse 11:hollow_point_rounds'),
    real('0:close_range 1:intensifying_clip 4:arctic_blast 8:bullet_resist_shredder 10:tech_damage_pulse 11:hollow_point_rounds'),
    real('0:close_range 1:intensifying_clip 2:metal_skin 4:arctic_blast 8:bullet_resist_shredder 9:vex_barrier 10:tech_damage_pulse 11:hollow_point_rounds'),
  ];
  it('keeps cooldown-dimmed actives shown instead of flickering the item count (real 4→6→4 jumps)', () => {
    const build = createBuildTracker();
    build.observe(layout(reads[0]!)); build.observe(layout(reads[0]!));
    expect(build.snapshot().myItems).toHaveLength(9);
    const counts: number[] = [];
    for (let cycle = 0; cycle < 4; cycle++) for (const read of reads.slice(1)) { build.observe(layout(read)); counts.push(build.snapshot().myItems.length); }
    expect(counts.every(count => count === 9)).toBe(true);
    expect(build.snapshot().myItems).toEqual(expect.arrayContaining(['upgrade_metal_skin', 'upgrade_resonant_healing', 'upgrade_vex_barrier']));
  });

  it('drops a component as soon as its upgrade appears and shows both items of a Bonus! pick', () => {
    const build = createBuildTracker();
    for (let read = 0; read < 20; read++) build.observe(layout([[0, 'upgrade_close_range'], [1, 'upgrade_improved_stamina']]));
    expect(build.snapshot().myItems).toEqual(['upgrade_close_range', 'upgrade_improved_stamina']);
    // Picking Stamina Mastery absorbs Extra Stamina and adds a free bonus item: two new items, one gone.
    const after: [number, string][] = [[0, 'upgrade_close_range'], [1, 'upgrade_improved_spirit'], [8, 'upgrade_superior_stamina']];
    build.observe(layout(after));
    build.observe(layout(after));
    expect(build.snapshot().myItems).toEqual(['upgrade_close_range', 'upgrade_improved_spirit', 'upgrade_superior_stamina']);
  });

  it('restores a component that is still visibly owned next to its upgrade', () => {
    const build = createBuildTracker();
    for (let read = 0; read < 10; read++) build.observe(layout([[1, 'upgrade_improved_stamina']]));
    const both: [number, string][] = [[0, 'upgrade_improved_stamina'], [1, 'upgrade_superior_stamina']];
    for (let read = 0; read < 3; read++) build.observe(layout(both));
    expect(build.snapshot().myItems).toEqual(['upgrade_improved_stamina', 'upgrade_superior_stamina']);
  });

  it('hides stale items when fewer inventory cells hold an icon than items are shown', () => {
    const build = createBuildTracker();
    const occupied = (items: [number, string][], cells: number) => ({ ...layout(items), myOccupied: cells });
    for (let read = 0; read < 20; read++) build.observe(occupied([[0, 'upgrade_close_range'], [1, 'upgrade_healbane'], [2, 'upgrade_burst_fire']], 3));
    // Burst Fire was sold: two cells hold icons from now on.
    for (let read = 0; read < 4; read++) build.observe(occupied([[0, 'upgrade_close_range'], [1, 'upgrade_healbane']], 2));
    expect(build.snapshot().myItems).toEqual(['upgrade_close_range', 'upgrade_healbane']);
  });

  it('shows more than 12 items (no item cap since 2026-03; a real match reached 14)', () => {
    const build = createBuildTracker();
    const ids = ['close_range', 'healbane', 'burst_fire', 'metal_skin', 'arctic_blast', 'hollow_point_rounds', 'tech_damage_pulse', 'resonant_healing',
      'intensifying_clip', 'vex_barrier', 'bullet_resist_shredder', 'active_reload', 'silencer', 'rapid_recharge'];
    const items = ids.map((id, slot): [number, string] => [slot, `upgrade_${id}`]);
    build.observe(layout(items)); build.observe(layout(items));
    expect(build.snapshot().myItems).toHaveLength(14);
  });

  it("keeps the spectated teammate's items and ranks out of your build after death (real 2026-10-16 jump from 8 to 16 items)", () => {
    const build = createBuildTracker();
    const mine: [number, string][] = [[0, 'upgrade_close_range'], [1, 'upgrade_healbane']];
    for (let read = 0; read < 5; read++) build.observe(layout(mine, [], [1, 1, 0, 0]), { round: 1 }, { at: 1_000 + read });
    const theirs: [number, string][] = [[0, 'upgrade_return_fire'], [1, 'upgrade_express_shot'], [2, 'upgrade_magic_shock']];
    for (let read = 0; read < 5; read++) build.observe(layout(theirs, [[4, 0, 'upgrade_toxic_bullets']], [3, 3, 1, 0]), {}, { spectating: true, at: 10_000 + read * 500 });
    // The death screen is gone, but its HUD lingers for a moment.
    for (let read = 0; read < 3; read++) build.observe(layout(theirs, [], [3, 3, 1, 0]), {}, { at: 13_000 + read * 300 });
    expect(build.snapshot().myItems).toEqual(['upgrade_close_range', 'upgrade_healbane']);
    expect(build.snapshot().abilityRanks).toEqual([1, 1, 0, 0]);
    // The scoreboard is the same for everyone.
    expect(build.snapshot().seatItems[4]).toEqual(['upgrade_toxic_bullets']);
    build.observe(layout([[0, 'upgrade_close_range'], [1, 'upgrade_healbane'], [2, 'upgrade_silencer']]), {}, { at: 20_000 });
    build.observe(layout([[0, 'upgrade_close_range'], [1, 'upgrade_healbane'], [2, 'upgrade_silencer']]), {}, { at: 20_500 });
    expect(build.snapshot().myItems).toContain('upgrade_silencer');
  });

  it('ages out old items when the grid is read empty (a missed new match)', () => {
    const build = createBuildTracker();
    for (let read = 0; read < 5; read++) build.observe({ ...layout([[0, 'upgrade_close_range']]), myOccupied: 1 });
    for (let read = 0; read < 4; read++) build.observe({ ...layout([]), myOccupied: 0 });
    expect(build.snapshot().myItems).toEqual([]);
  });

  it('knows when your own inventory grid has been read', () => {
    const build = createBuildTracker();
    expect(build.ownInventoryRead()).toBe(false);
    build.observe({ ...layout([]), myOccupied: 0 });
    expect(build.ownInventoryRead()).toBe(true);
    build.reset();
    expect(build.ownInventoryRead()).toBe(false);
  });
});

describe('2026-10-18 build reads', () => {
  const twelve = ['upgrade_close_range', 'upgrade_healbane', 'upgrade_burst_fire', 'upgrade_active_reload', 'upgrade_divine_barrier',
    'upgrade_toxic_bullets', 'upgrade_headshot_booster', 'upgrade_clip_size', 'upgrade_berserker', 'upgrade_capacitor', 'upgrade_glitch', 'upgrade_infuser'];
  it('keeps a 12-item build when a post-match screen shows icons it cannot name (it was trimmed to 3)', () => {
    const build = createBuildTracker();
    for (let read = 0; read < 6; read++) build.observe({ ...layout(twelve.map((itemId, slot) => [slot, itemId])), myOccupied: 12 });
    expect(build.snapshot().myItems).toHaveLength(12);
    // The awards screen: no own item recognized, but 2-3 cells looked occupied.
    for (let read = 0; read < 20; read++) build.observe({ ...layout([]), myOccupied: read % 2 ? 2 : 3 });
    expect(build.snapshot().myItems).toHaveLength(12);
  });
  it('credits a picked card whose inventory slot is never read, and keeps it through capacity trimming', () => {
    const build = createBuildTracker();
    for (let read = 0; read < 6; read++) build.observe({ ...layout([[0, 'upgrade_close_range'], [1, 'upgrade_healbane']]), myOccupied: 3 });
    build.creditPick('upgrade_battle_vest');
    expect(build.snapshot().myItems).toContain('upgrade_battle_vest');
    // The grid shows three occupied cells but the vest icon is never recognized: it stays.
    for (let read = 0; read < 100; read++) build.observe({ ...layout([[0, 'upgrade_close_range'], [1, 'upgrade_healbane']]), myOccupied: 3 });
    expect(build.snapshot().myItems).toEqual(expect.arrayContaining(['upgrade_close_range', 'upgrade_healbane', 'upgrade_battle_vest']));
  });
});
