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

  it('only raises ability ranks and clears everything on reset', () => {
    const build = createBuildTracker();
    build.observe(layout([], [], [2, 0, 3, 0]));
    build.observe(layout([], [], [1, 0, 3, 1]));
    expect(build.snapshot().abilityRanks).toEqual([2, 0, 3, 1]);
    build.reset();
    expect(build.snapshot()).toEqual({ myItems: [], seatItems: Array(8).fill([]), abilityRanks: null, hiddenEnemyItems: 0 });
  });
});
