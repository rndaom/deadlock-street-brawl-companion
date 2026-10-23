/**
 * Street Brawl draft tiers, shared by the pick logic and the interface so both name the same tier.
 */

/**
 * Tier of each of a round's three choices (Valve's street_brawl draft config, see
 * research/street-brawl-research.md). A RARE card is one tier above its choice.
 */
export const CHOICE_TIERS: Readonly<Record<number, readonly [number, number, number]>> = {
  1: [1, 2, 3], 2: [2, 3, 3], 3: [2, 3, 4], 4: [3, 3, 4], 5: [4, 4, 4],
};

/** The tier this draft offers: the most common card tier, a RARE card counted one tier lower (ties: the lower tier). */
export function draftTierOf(cards: readonly { tier: number | null | undefined; rare?: boolean }[]): number | null {
  const counts = new Map<number, number>();
  for (const card of cards) {
    const tier = card.tier;
    if (tier === null || tier === undefined || !Number.isFinite(tier)) continue;
    const slot = card.rare ? tier - 1 : tier;
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

/**
 * The draft tiers still to come from a place in the match, in order: this round's choices from
 * `choice` (1-3) on, then every later round's. Empty when the round is not in the table.
 */
export function upcomingDraftTiers(round: number, choice: number): number[] {
  const tiers: number[] = [];
  for (let current = round; CHOICE_TIERS[current]; current++) {
    tiers.push(...CHOICE_TIERS[current]!.slice(current === round ? Math.max(0, Math.min(3, choice) - 1) : 0));
  }
  return tiers;
}
