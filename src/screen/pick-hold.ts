import type { ScreenOffer } from '../shared/screen-reading';

/**
 * Below this score lead a pick is a "Slight edge". A challenger must lead the shown pick by at least
 * this much to replace it. Real 2026-11-05..14 drafts: the near-ties under a pick that then flipped
 * were 0.02 and 0.20 apart, while the takeovers on newly read enemy items led by 0.32 and 0.60.
 */
export const CLOSE_CALL_MARGIN = 0.25;

/** The cards shown for the current draft and the pick shown with them (from the reader's state). */
export interface ShownPick { offers: readonly ScreenOffer[]; position: number | null }

export interface PickCandidate { position: number; score: number; offer: ScreenOffer }
export interface PickHold<T extends PickCandidate> {
  pick: T | undefined;
  /** Why the shown pick was kept over a card that scores higher on this read; null when it was not. */
  kept: 'close' | 'unconfirmed' | null;
  /** The higher-scoring card the shown pick was kept over. */
  challenger: T | null;
}

/**
 * The pick shown for a set of cards stays while the same cards are on screen, unless another card
 * now leads it by a clear margin on a confirmed read. A near-tie that tips back and forth (a few
 * more enemy items read, a rounding step) and a card whose bonus or modifier reads differently on
 * one frame (a tooltip over the cards) do not move it. New cards, an unread card becoming readable,
 * or a shown pick that is no longer a candidate start afresh.
 */
export function holdShownPick<T extends PickCandidate>(order: readonly T[], offers: readonly ScreenOffer[], shown: ShownPick | null | undefined): PickHold<T> {
  const best = order[0];
  const fresh = { pick: best, kept: null, challenger: null };
  if (!best || !shown || shown.position === null || !sameCards(offers, shown.offers)) return fresh;
  const held = order.find(entry => entry.position === shown.position);
  if (!held || held === best) return fresh;
  if (best.score - held.score < CLOSE_CALL_MARGIN) return { pick: held, kept: 'close', challenger: best };
  // A lead that rests on details this read left unconfirmed, and that changed since the pick was shown, waits for a clean read.
  const shownAt = (position: number) => shown.offers.find(offer => offer.position === position);
  const unsettled = [best, held].some(entry => unconfirmed(entry.offer) && details(entry.offer) !== details(shownAt(entry.position)));
  return unsettled ? { pick: held, kept: 'unconfirmed', challenger: best } : fresh;
}

/** The same three readable cards in the same places; details (variant, bonus, rare) may differ. */
function sameCards(offers: readonly ScreenOffer[], shown: readonly ScreenOffer[]): boolean {
  const ids = (list: readonly ScreenOffer[]) => [0, 1, 2].map(position => {
    const at = list.filter(offer => offer.position === position);
    return at.length === 1 && at[0]!.itemId ? at[0]!.itemId : null;
  });
  const now = ids(offers), before = ids(shown);
  return offers.length === 3 && shown.length === 3 && now.every((id, index) => id !== null && id === before[index]);
}
function unconfirmed(offer: ScreenOffer): boolean { return offer.bonusIds === null || offer.variant === 'unknown'; }
function details(offer: ScreenOffer | undefined): string {
  return offer ? JSON.stringify([offer.variant, !!offer.bonusExpected, offer.bonusIds === null ? null : [...offer.bonusIds].sort()]) : '';
}
