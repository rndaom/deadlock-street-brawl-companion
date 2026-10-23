import { CONTEXT_CATALOG } from '../shared/context-catalog';

/**
 * Street Brawl "Bonus!" cards. When a card offers an item that upgrades from an item the
 * player already owns, the upgrade absorbs that component and the game adds a lower-tier
 * item to the card as compensation (wiki: "they will be given another item of a lower tier
 * as a bonus"). The shop recipe (component_items) predicts which cards carry a bonus and
 * which owned item disappears when the card is picked. It cannot predict the bonus identity.
 */
const COMPONENTS = new Map(CONTEXT_CATALOG.items.map(item => [item.id, item.componentIds] as const));
const TIERS = new Map(CONTEXT_CATALOG.items.map(item => [item.id, item.tier] as const));

/** Shop components of an item (empty for unknown or base items). */
export function componentsOf(itemId: string): readonly string[] { return COMPONENTS.get(itemId) ?? []; }

/** Owned items that picking `itemId` would absorb (the reason a card shows "Bonus!"). */
export function absorbedComponents(itemId: string, ownedItemIds: readonly string[]): string[] {
  const owned = new Set(ownedItemIds);
  return componentsOf(itemId).filter(id => owned.has(id));
}

/** Catalogue tier of an item, or null. */
export function itemTier(itemId: string): number | null { return TIERS.get(itemId) ?? null; }
