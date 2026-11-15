import { describe, expect, it } from 'vitest';
import { companionDisplayAwayFrom, overlapArea, type PlacementDisplay } from '../electron/display-placement';

const display = (id: number, x: number, width: number, height: number): PlacementDisplay =>
  ({ id, bounds: { x, y: 0, width, height }, workArea: { x, y: 0, width, height: height - 40 } });

describe('companion placement around the game', () => {
  it('measures the overlap of the companion and the game client', () => {
    expect(overlapArea({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 })).toBe(2_500);
    expect(overlapArea({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 })).toBe(0);
    expect(overlapArea({ x: 0, y: 0, width: 100, height: 100 }, { x: 300, y: 300, width: 10, height: 10 })).toBe(0);
  });
  it('has nowhere to go on one monitor (the in-game overlay shows the pick there)', () => {
    expect(companionDisplayAwayFrom([display(1, 0, 1920, 1080)], 1, 1)).toBeNull();
  });
  it('moves to the other monitor, whichever one the game is on', () => {
    const displays = [display(1, 0, 1920, 1080), display(2, 1920, 1920, 1080)];
    expect(companionDisplayAwayFrom(displays, 1, 1)?.id).toBe(2);
    expect(companionDisplayAwayFrom(displays, 2, 1)?.id).toBe(1);
  });
  it('prefers a portrait monitor, then the largest one, then the primary one', () => {
    const portrait = display(3, -1080, 1080, 1920);
    expect(companionDisplayAwayFrom([display(1, 0, 2560, 1440), display(2, 2560, 2560, 1440), portrait], 1, 1)?.id).toBe(3);
    expect(companionDisplayAwayFrom([display(1, 0, 2560, 1440), display(2, 2560, 1920, 1080), display(4, 4480, 2560, 1440)], 1, 1)?.id).toBe(4);
    expect(companionDisplayAwayFrom([display(1, 0, 2560, 1440), display(2, 2560, 1920, 1080), display(4, 4480, 1920, 1080)], 1, 4)?.id).toBe(4);
  });
});
