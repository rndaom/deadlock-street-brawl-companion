import type { NativeBrawlLayout } from '../shared/screen-reading';

/**
 * Items and ability upgrades read during the current match. The game reorders inventories
 * (an item can move from slot 1 to slot 9), so evidence is kept per item, not per slot: an
 * item shows once it was seen on two reads, and fades after it has been missing from many
 * reads where that inventory was visible (sold or replaced). One misread icon on one read
 * never appears, and a cooldown-dimmed item that is unread for a moment does not vanish.
 */
export interface MatchBuild {
  myItems: string[];
  /** Scoreboard items per top-bar seat (0-3 left team, 4-7 right team). */
  seatItems: string[][];
  abilityRanks: number[] | null;
  hiddenEnemyItems: number;
}

const MIN_VOTES = 1.9;
/** Fading per visible read: an item missing from ~45 reads in a row is dropped. */
const DECAY = 0.95;
/** Street Brawl inventories hold at most this many items. */
const MAX_ITEMS = 12;

interface Evidence { votes: number; slot: number }
type Inventory = Map<string, Evidence>;

function observeInventory(inventory: Inventory, items: readonly { slot: number; itemId: string }[]) {
  if (!items.length) return;
  for (const evidence of inventory.values()) evidence.votes *= DECAY;
  const seen = new Set<string>();
  for (const { slot, itemId } of [...items].sort((a, b) => a.slot - b.slot)) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    const evidence = inventory.get(itemId);
    if (evidence) { evidence.votes += 1; evidence.slot = slot; }
    else inventory.set(itemId, { votes: 1, slot });
  }
  for (const [itemId, evidence] of inventory) if (evidence.votes < 0.05) inventory.delete(itemId);
}
function confirmed(inventory: Inventory): string[] {
  return [...inventory.entries()].filter(([, evidence]) => evidence.votes >= MIN_VOTES)
    .sort((a, b) => b[1].votes - a[1].votes).slice(0, MAX_ITEMS)
    .sort((a, b) => a[1].slot - b[1].slot || a[0].localeCompare(b[0])).map(([itemId]) => itemId);
}

export function createBuildTracker() {
  let mine: Inventory = new Map();
  let seats: Inventory[] = Array.from({ length: 8 }, () => new Map());
  let abilityRanks: number[] | null = null;
  let hidden = 0;

  return {
    observe(layout: NativeBrawlLayout | undefined) {
      if (!layout) return;
      observeInventory(mine, layout.myItems);
      for (let seat = 0; seat < 8; seat++) observeInventory(seats[seat]!, layout.playerItems.filter(item => item.seat === seat));
      // Ranks only rise during a match; a lower read is a partly hidden panel.
      if (layout.abilityRanks) abilityRanks = abilityRanks ? layout.abilityRanks.map((rank, slot) => Math.max(rank, abilityRanks![slot] ?? 0)) : [...layout.abilityRanks];
      if (layout.playerItems.length || layout.hiddenItems) hidden = layout.hiddenItems;
    },
    snapshot(): MatchBuild {
      return { myItems: confirmed(mine), seatItems: seats.map(confirmed), abilityRanks: abilityRanks ? [...abilityRanks] : null, hiddenEnemyItems: hidden };
    },
    reset() { mine = new Map(); seats = Array.from({ length: 8 }, () => new Map()); abilityRanks = null; hidden = 0; },
  };
}
