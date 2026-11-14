import { beforeEach, describe, expect, it } from 'vitest';
import publicCatalogJson from '../data/public-catalog.json';
import { evaluateScreenOffers, resetDraftMemory, type ScreenOfferContext, type StreetBrawlAdvice } from '../src/screen/screen-advice';
import { CLOSE_CALL_MARGIN, holdShownPick, type PickCandidate } from '../src/screen/pick-hold';
import type { ScreenOffer } from '../src/shared/screen-reading';
import type { Catalog } from '../src/shared/types';

const catalog = publicCatalogJson as Catalog;
function offer(itemId: string, position: number, overrides: Partial<ScreenOffer> = {}): ScreenOffer {
  const item = catalog.items.find(candidate => candidate.id === itemId);
  if (!item) throw new Error(`Missing fixture item ${itemId}`);
  return { position, itemId, name: item.name, bonusIds: [], variant: 'base', confidence: 1, warning: null, ...overrides };
}
const unread = (position: number): ScreenOffer => ({ position, itemId: '', name: 'Unread item choice', bonusIds: null, variant: 'unknown', confidence: 0,
  warning: 'This card is not readable yet (still dealing in, or under a tooltip).' });
const scoreAt = (advice: StreetBrawlAdvice, position: number) => advice.ranked.find(entry => entry.position === position)!.score;
/** What the reader shows after an evaluation: those cards and that pick (the coordinator passes it to the next evaluation). */
const shownAfter = (offers: ScreenOffer[], advice: StreetBrawlAdvice) => ({ offers, position: advice.preferredPosition });
const evaluate = (offers: ScreenOffer[], context: ScreenOfferContext) => evaluateScreenOffers(offers, catalog, context)!;

beforeEach(() => resetDraftMemory());

describe('holdShownPick', () => {
  const cards = [offer('upgrade_warp_stone', 0), offer('upgrade_headhunter', 1), offer('upgrade_express_shot', 2)];
  const order = (scores: [number, number, number], offers = cards): PickCandidate[] =>
    offers.map((entry, index) => ({ position: entry.position, score: scores[index]!, offer: entry })).sort((a, b) => b.score - a.score);

  it('keeps the shown pick while another card leads it by less than the close-call margin', () => {
    const result = holdShownPick(order([1, 2.24, 2]), cards, { offers: cards, position: 2 });
    expect(result.pick?.position).toBe(2);
    expect(result.kept).toBe('close');
    expect(result.challenger?.position).toBe(1);
  });
  it('lets a card that leads by the margin or more take over', () => {
    expect(CLOSE_CALL_MARGIN).toBe(0.25);
    const result = holdShownPick(order([1, 2.25, 2]), cards, { offers: cards, position: 2 });
    expect(result.pick?.position).toBe(1);
    expect(result.kept).toBeNull();
  });
  it('starts afresh for other cards, a card moved to another place, or no shown pick', () => {
    const rerolled = [offer('upgrade_warp_stone', 0), offer('upgrade_headhunter', 1), offer('upgrade_bulletshredimbue', 2)];
    expect(holdShownPick(order([1, 2.1, 2], rerolled), rerolled, { offers: cards, position: 2 }).pick?.position).toBe(1);
    const swapped = [offer('upgrade_warp_stone', 0), offer('upgrade_express_shot', 1), offer('upgrade_headhunter', 2)];
    expect(holdShownPick(order([1, 2, 2.1], swapped), swapped, { offers: cards, position: 2 }).pick?.position).toBe(2);
    expect(holdShownPick(order([1, 2.1, 2]), cards, { offers: cards, position: null }).pick?.position).toBe(1);
    expect(holdShownPick(order([1, 2.1, 2]), cards, null).pick?.position).toBe(1);
    // The shown pick is no longer a candidate (for example a likely misread now): the best candidate leads.
    expect(holdShownPick(order([1, 2.1, 2]).filter(entry => entry.position !== 2), cards, { offers: cards, position: 2 }).pick?.position).toBe(1);
  });
  it('does not let a lead that rests on newly unconfirmed card details move the pick', () => {
    const tooltip = cards.map(entry => entry.position === 1 ? { ...entry, bonusIds: null, bonusExpected: true } : entry);
    const result = holdShownPick(order([1, 3, 2], tooltip), tooltip, { offers: cards, position: 2 });
    expect(result.pick?.position).toBe(2);
    expect(result.kept).toBe('unconfirmed');
    // The shown pick's own details turning unreadable does not hand the pick away either.
    const heldUnread = cards.map(entry => entry.position === 2 ? { ...entry, variant: 'unknown' as const } : entry);
    expect(holdShownPick(order([1, 3, 2], heldUnread), heldUnread, { offers: cards, position: 2 }).kept).toBe('unconfirmed');
  });
  it('applies only the margin to details that were already unconfirmed when the pick was shown', () => {
    const bonusCard = cards.map(entry => entry.position === 1 ? { ...entry, bonusIds: null, bonusExpected: true } : entry);
    expect(holdShownPick(order([1, 3, 2], bonusCard), bonusCard, { offers: bonusCard, position: 2 }).pick?.position).toBe(1);
    // A detail that changed and is read clearly is new information like any other.
    const confirmed = cards.map(entry => entry.position === 1 ? { ...entry, bonusIds: ['upgrade_headshot_booster'], bonusExpected: true } : entry);
    expect(holdShownPick(order([1, 3, 2], confirmed), confirmed, { offers: cards, position: 2 }).pick?.position).toBe(1);
  });
});

describe('evaluateScreenOffers keeps the shown pick for the same cards', () => {
  it('a near-tie tipped by a late-read enemy hero does not change the pick', () => {
    // Necro, round 3 (2026-11-06 match): the fourth enemy hero is read after the cards are shown.
    const cards = [offer('upgrade_cardio_calibrator', 0), offer('upgrade_fleetfoot_boots', 1), offer('upgrade_magic_slow', 2)];
    const context: ScreenOfferContext = { heroId: 'hero_necro', round: 3, rerolls: 1, choice: 1, enemyHeroIds: ['hero_hornet', 'hero_ratking', 'hero_deadpack'] };
    const first = evaluate(cards, context);
    const late = { ...context, enemyHeroIds: [...context.enemyHeroIds!, 'hero_drifter'] };
    const unheld = evaluate(cards, late);
    // Without the hold the pick flips on a lead below the close-call margin.
    expect(unheld.preferredPosition).not.toBe(first.preferredPosition);
    expect(scoreAt(unheld, unheld.preferredPosition!) - scoreAt(unheld, first.preferredPosition!)).toBeLessThan(CLOSE_CALL_MARGIN);
    const held = evaluate(cards, { ...late, shownPick: shownAfter(cards, first) });
    expect(held.preferredPosition).toBe(first.preferredPosition);
    expect(held.title).toBe(`Slight edge: ${cards[first.preferredPosition!]!.name}`);
    expect(held.reasons[0]).toMatch(/^Close call: .+ are about even; the pick stays on /);
  });

  it('a card that clearly beats the shown pick after enemy items are read still takes over', () => {
    // Gigawatt, round 4 (2026-11-10 match): seven enemy items, mostly spirit, arrive while the cards are shown.
    const cards = [offer('upgrade_ability_power_shard', 0, { rare: true }), offer('upgrade_magic_storm', 1), offer('upgrade_fury_trance', 2)];
    const context: ScreenOfferContext = { heroId: 'hero_gigawatt', round: 4, rerolls: 1, choice: 1,
      enemyHeroIds: ['hero_artist', 'hero_necro', 'hero_baba', 'hero_punkgoat'],
      ownedItemIds: ['upgrade_bullet_resist_shredder', 'upgrade_health_nova', 'upgrade_imbued_duration_extender', 'upgrade_magic_tempo',
        'upgrade_regenerating_bullet_shield', 'upgrade_spellbreaker', 'upgrade_suppressor', 'upgrade_tech_damage_pulse', 'upgrade_tech_range'] };
    const first = evaluate(cards, context);
    expect(first.preferredPosition).toBe(1);
    const spiritHeavy = { ...context, enemyItemIds: ['upgrade_improved_spirit', 'upgrade_rapid_recharge', 'upgrade_spirit_burn', 'upgrade_mystic_reverb',
      'upgrade_extra_charge', 'upgrade_close_quarter_combat'] };
    const held = evaluate(cards, { ...spiritHeavy, shownPick: shownAfter(cards, first) });
    expect(held.preferredPosition).toBe(0);
    expect(scoreAt(held, 0) - scoreAt(held, 1)).toBeGreaterThanOrEqual(CLOSE_CALL_MARGIN);
    expect(held.title).toBe('Pick Echo Shard');
  });

  it('a bonus misread under a tooltip on one frame does not change the pick, and a clean read keeps it', () => {
    // Paige, round 2, choice 3 (2026-11-14 match): hovering the cards marks Headhunter as a Bonus! card with an unread free item.
    const cards = [offer('upgrade_warp_stone', 0), offer('upgrade_headhunter', 1), offer('upgrade_express_shot', 2)];
    const context: ScreenOfferContext = { heroId: 'hero_bookworm', round: 2, rerolls: 1, choice: 3,
      enemyHeroIds: ['hero_werewolf', 'hero_priest', 'hero_bebop', 'hero_viscous'],
      ownedItemIds: ['upgrade_active_reload', 'upgrade_bullet_resist_shredder', 'upgrade_magic_shield', 'upgrade_magic_storm', 'upgrade_sprint_booster', 'upgrade_weighted_shots'] };
    const first = evaluate(cards, context);
    expect(first.preferredPosition).toBe(2);
    const tooltip = cards.map(entry => entry.position === 1
      ? { ...entry, bonusIds: null, bonusExpected: true, warning: 'Bonus items are not fully recognized; the full bundle remains unconfirmed.' } : entry);
    const unheld = evaluate(tooltip, context);
    expect(unheld.ranked.find(entry => entry.position === 1)!.score).toBeGreaterThan(scoreAt(unheld, 2) + CLOSE_CALL_MARGIN);
    const held = evaluate(tooltip, { ...context, shownPick: shownAfter(cards, first) });
    expect(held.preferredPosition).toBe(2);
    expect(held.reasons[0]).toBe('Headhunter only leads on a read with unconfirmed card details; the pick stays on Express Shot.');
    // The reader keeps the Bonus! flag on the card, but the next clean read has no unread bonus to value.
    const clean = cards.map(entry => entry.position === 1 ? { ...entry, bonusExpected: true } : entry);
    expect(evaluate(clean, { ...context, shownPick: shownAfter(cards, held) }).preferredPosition).toBe(2);
  });

  it('new cards and a card read after the first two are evaluated afresh', () => {
    const context: ScreenOfferContext = { heroId: 'hero_bookworm', round: 2, rerolls: 1, choice: 3 };
    const cards = [offer('upgrade_warp_stone', 0), offer('upgrade_headhunter', 1), offer('upgrade_express_shot', 2)];
    const first = evaluate(cards, context);
    const rerolled = [offer('upgrade_bulletshredimbue', 0), offer('upgrade_health_nova', 1), offer('upgrade_imbued_duration_extender', 2)];
    expect(evaluate(rerolled, { ...context, shownPick: shownAfter(cards, first) }).preferredPosition)
      .toBe(evaluate(rerolled, context).preferredPosition);
    // "Best so far" on two cards does not hold the pick once the third card is read.
    const partial = [offer('upgrade_warp_stone', 0), offer('upgrade_headhunter', 1), unread(2)];
    const best = evaluate(partial, context);
    expect(best.title).toMatch(/Best so far|Reroll/);
    expect(evaluate(cards, { ...context, shownPick: shownAfter(partial, best) }).preferredPosition).toBe(first.preferredPosition);
  });
});
