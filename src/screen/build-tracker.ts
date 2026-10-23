import type { NativeBrawlLayout } from '../shared/screen-reading';
import { componentsOf } from './item-bundles';
import { createAbilityRankTracker } from './ability-ranks';
import type { AbilityReadContext } from './ability-ranks';

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
  /** Confirmed rank per ability (null for one not confirmed yet), or null when none is known. */
  abilityRanks: (number | null)[] | null;
  hiddenEnemyItems: number;
}

/** After the death screen (spectating a teammate) ends, its HUD can linger for a moment. */
export const SPECTATOR_GRACE_MS = 4_000;

export interface BuildObservation {
  /** The death screen is up: the HUD shows the spectated teammate's items and ranks, not yours. */
  spectating?: boolean;
  /** Capture time of this read. */
  at?: number;
}

/** An item is shown once it was seen on two reads... */
const MIN_VOTES = 1.9;
/** ...and then stays until its evidence fades below this. A single threshold made items seen
 * only now and then (actives dimmed while on cooldown are not recognized) flicker in and out:
 * a real read went 4→6→4→5→6 items within a minute. */
const KEEP_VOTES = 0.6;
/** Fading per visible read. */
const DECAY = 0.95;
/** No item cap since 2026-03 (the UI expands past 12); the native grid reads 2x8 cells. */
const MAX_ITEMS = 16;
/** Occupied-cell counts of the last few reads bound how many items can be shown. */
const OCCUPANCY_READS = 4;

/** pinned: picked from a draft (the card that lingered as the next choice opened), shown even while
 * the inventory never identifies its slot; removed only when absorbed by an upgrade or proven sold. */
interface Evidence { votes: number; slot: number; shown: boolean; pinned?: boolean }
interface Inventory { items: Map<string, Evidence>; occupancy: number[] }
const emptyInventory = (): Inventory => ({ items: new Map(), occupancy: [] });

/**
 * @param occupied own-inventory cells that hold any icon on this read (null when unknown).
 * @param componentsOf shop components, so an upgrade that absorbed its component drops it at once.
 */
function observeInventory(inventory: Inventory, items: readonly { slot: number; itemId: string }[],
  occupied: number | null = null, componentsOf?: (itemId: string) => readonly string[]) {
  // No icons and no cell count: the grid was not on screen. A grid read with no icons is an empty
  // inventory and ages out what an earlier (possibly missed-match) read left behind.
  if (!items.length && (occupied === null || !Number.isFinite(occupied))) return;
  // Cells that hold icons while none is recognized is not your inventory grid (post-match summary,
  // menus): 2026-10-18 reads with 2-3 such cells and no icon trimmed a 12-item build to 3.
  if (!items.length && occupied !== null && occupied > 0) return;
  const evidence = inventory.items;
  for (const entry of evidence.values()) entry.votes *= DECAY;
  const seen = new Set<string>();
  for (const { slot, itemId } of [...items].sort((a, b) => a.slot - b.slot)) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    const entry = evidence.get(itemId);
    if (entry) { entry.votes += 1; entry.slot = slot; }
    else evidence.set(itemId, { votes: 1, slot, shown: false });
  }
  const added: string[] = [];
  for (const [itemId, entry] of evidence) {
    if (!entry.shown && entry.votes >= MIN_VOTES) { entry.shown = true; added.push(itemId); }
    else if (entry.shown && entry.votes < KEEP_VOTES && !entry.pinned) entry.shown = false;
  }
  // Picking an upgrade of an owned item absorbs that item ("Bonus!" cards). Hide the component
  // as soon as the upgrade is confirmed unless it is visibly still there; one more sighting
  // restores it if it really is.
  if (componentsOf) for (const itemId of added) for (const component of componentsOf(itemId)) {
    const entry = evidence.get(component);
    if (entry && !seen.has(component)) { entry.shown = false; entry.pinned = false; entry.votes = Math.min(entry.votes, 0.9); }
  }
  // More shown items than cells holding an icon: the extra ones were sold or absorbed.
  if (occupied !== null && Number.isFinite(occupied)) {
    inventory.occupancy = [...inventory.occupancy, occupied].slice(-OCCUPANCY_READS);
    const capacity = Math.max(...inventory.occupancy);
    const shown = [...evidence.entries()].filter(([, entry]) => entry.shown);
    if (shown.length > capacity) {
      // Picked items go last: their slot may simply never be identified.
      const stale = shown.filter(([itemId]) => !seen.has(itemId)).sort((a, b) => Number(!!a[1].pinned) - Number(!!b[1].pinned) || a[1].votes - b[1].votes);
      for (const [, entry] of stale.slice(0, shown.length - capacity)) { entry.shown = false; entry.pinned = false; entry.votes = Math.min(entry.votes, 0.9); }
    }
  }
  for (const [itemId, entry] of evidence) if (entry.votes < 0.05 && !entry.pinned) evidence.delete(itemId);
}
/** An item you picked from a draft: shown at once and kept, and the components it absorbs leave. */
function creditInventory(inventory: Inventory, itemId: string, componentsOf?: (itemId: string) => readonly string[]) {
  const entry = inventory.items.get(itemId);
  if (entry) { entry.votes = Math.max(entry.votes, MIN_VOTES); entry.shown = true; entry.pinned = true; }
  else inventory.items.set(itemId, { votes: MIN_VOTES, slot: MAX_ITEMS + inventory.items.size, shown: true, pinned: true });
  if (componentsOf) for (const component of componentsOf(itemId)) {
    const absorbed = inventory.items.get(component);
    if (absorbed && component !== itemId) { absorbed.shown = false; absorbed.pinned = false; absorbed.votes = Math.min(absorbed.votes, 0.9); }
  }
}
function confirmed(inventory: Inventory): string[] {
  return [...inventory.items.entries()].filter(([, evidence]) => evidence.shown)
    .sort((a, b) => b[1].votes - a[1].votes).slice(0, MAX_ITEMS)
    .sort((a, b) => a[1].slot - b[1].slot || a[0].localeCompare(b[0])).map(([itemId]) => itemId);
}

export function createBuildTracker() {
  let mine: Inventory = emptyInventory();
  let seats: Inventory[] = Array.from({ length: 8 }, emptyInventory);
  const abilityRanks = createAbilityRankTracker();
  let hidden = 0;
  let inventoryRead = false;
  let spectatedAt = -Infinity;

  return {
    /**
     * @param abilityContext round and unspent AP read on the same frame, to reject impossible ability ranks.
     * @param observation whether you are dead and watching a teammate, whose HUD must not become your build.
     */
    observe(layout: NativeBrawlLayout | undefined, abilityContext: AbilityReadContext = {}, observation: BuildObservation = {}) {
      if (!layout) return;
      const at = observation.at ?? Date.now();
      if (observation.spectating) spectatedAt = at;
      // The scoreboard is the same for everyone; your own inventory and upgrade panel are not.
      const own = !observation.spectating && !(at >= spectatedAt && at - spectatedAt < SPECTATOR_GRACE_MS);
      if (own) {
        if (layout.myItems.length || (layout.myOccupied !== undefined && layout.myOccupied !== null)) inventoryRead = true;
        observeInventory(mine, layout.myItems, layout.myOccupied ?? null, componentsOf);
        // Ranks change only after repeated, affordable reads (see ability-ranks.ts).
        abilityRanks.observe(layout.abilityRanks, abilityContext);
      }
      for (let seat = 0; seat < 8; seat++) observeInventory(seats[seat]!, layout.playerItems.filter(item => item.seat === seat), null, componentsOf);
      if (layout.playerItems.length || layout.hiddenItems) hidden = layout.hiddenItems;
    },
    snapshot(): MatchBuild {
      return { myItems: confirmed(mine), seatItems: seats.map(confirmed), abilityRanks: abilityRanks.ranks(), hiddenEnemyItems: hidden };
    },
    /**
     * Credit an item you picked from a draft card (the native inventory read can miss its slot for
     * the rest of the match, as Spirit Resilience did in match B on 2026-10-18).
     */
    creditPick(itemId: string) { if (itemId) creditInventory(mine, itemId, componentsOf); },
    /** True once your own inventory grid was read this match, so an empty item list means "owns nothing". */
    ownInventoryRead() { return inventoryRead; },
    /** Why the latest ability panel read was not used (null if it was), for diagnostics. */
    abilityRejection(): string | null { return abilityRanks.lastRejection(); },
    reset() { inventoryRead = false; mine = emptyInventory(); seats = Array.from({ length: 8 }, emptyInventory); abilityRanks.reset(); hidden = 0; spectatedAt = -Infinity; },
  };
}
