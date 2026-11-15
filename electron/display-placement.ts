/**
 * Automatic window placement around the game (Windows). No Electron imports, so the rules are unit-tested.
 * All rectangles here are in one coordinate space (Electron DIP screen coordinates).
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface PlacementDisplay { id: number; bounds: Rect; workArea: Rect }

/** Area shared by two rectangles (0 when they only touch or are apart). */
export function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The display for the companion while the game runs on `gameDisplayId`: another monitor, so the game stays
 * uncovered. A portrait monitor first (the companion is a tall panel), then the largest work area, then the
 * primary one on a tie. Null with a single monitor: there the in-game overlay shows the pick.
 */
export function companionDisplayAwayFrom<T extends PlacementDisplay>(displays: readonly T[], gameDisplayId: number, primaryId: number): T | null {
  const others = displays.filter((display) => display.id !== gameDisplayId && display.workArea.width > 0 && display.workArea.height > 0);
  if (others.length === 0) return null;
  const portrait = (display: T) => display.workArea.height > display.workArea.width ? 1 : 0;
  const area = (display: T) => display.workArea.width * display.workArea.height;
  return [...others].sort((a, b) => portrait(b) - portrait(a) || area(b) - area(a) || Number(b.id === primaryId) - Number(a.id === primaryId))[0];
}
