import { beforeEach, describe, expect, it } from 'vitest';
import publicCatalogJson from '../data/public-catalog.json';
import { evaluateScreenOffers, resetDraftMemory, type ScreenOfferContext, type StreetBrawlAdvice } from '../src/screen/screen-advice';
import type { ScreenOffer } from '../src/shared/screen-reading';
import type { Catalog } from '../src/shared/types';

const catalog = publicCatalogJson as Catalog;
function offer(itemId: string, position: number, overrides: Partial<ScreenOffer> = {}): ScreenOffer {
  const item = catalog.items.find(candidate => candidate.id === itemId);
  if (!item) throw new Error(`Missing fixture item ${itemId}`);
  return { position, itemId, name: item.name, bonusIds: [], variant: 'base', confidence: 1, warning: null, ...overrides };
}
const base: ScreenOfferContext = { heroId: 'hero_necro', round: 3, rerolls: 0, choice: 1 };
const evaluate = (offers: ScreenOffer[], context: Partial<ScreenOfferContext> = {}, using: Catalog = catalog) =>
  evaluateScreenOffers(offers, using, { ...base, ...context })!;
const scoreAt = (advice: StreetBrawlAdvice, position: number) => advice.ranked.find(entry => entry.position === position)!.score;

// Active (a button to press) in the pinned item facts: Heroic Aura, Alchemical Fire, Decay and the four owned below.
// Not active: Burst Fire, Mystic Slow (upgrade_magic_slow). Express Shot has no pinned facts, so it counts as not active.
const OWNED_ACTIVE = ['upgrade_arctic_blast', 'upgrade_blood_tribute', 'upgrade_capacitor', 'upgrade_cold_front'];
const mixed = () => [offer('upgrade_dps_aura', 0), offer('upgrade_bulletshredimbue', 1), offer('upgrade_burst_fire', 2)];
const allActive = () => [offer('upgrade_dps_aura', 0), offer('upgrade_thermal_detonator', 1), offer('upgrade_rupture', 2)];

beforeEach(() => resetDraftMemory());

describe('the active-item limit', () => {
  it('fixtures: the active card leads when nothing is limited', () => {
    const advice = evaluate(mixed(), { ownedItemIds: OWNED_ACTIVE });
    expect(advice.preferredPosition).toBe(0);
    expect(advice.reasons.some(reason => /active item/.test(reason))).toBe(false);
  });

  it('with the default (4) or no setting nothing changes, however many active items are owned', () => {
    const plain = evaluate(mixed());
    for (const maxActiveItems of [undefined, 4]) {
      const advice = evaluate(mixed(), { ownedItemIds: OWNED_ACTIVE, maxActiveItems });
      expect(advice.preferredPosition).toBe(0);
      expect(advice.reasons).toEqual(plain.reasons);
      expect(advice.title).toBe(plain.title);
    }
  });

  it('keeps the active card while fewer active items are owned than the limit', () => {
    const advice = evaluate(mixed(), { ownedItemIds: OWNED_ACTIVE.slice(0, 2), maxActiveItems: 3 });
    expect(advice.preferredPosition).toBe(0);
  });

  it('picks the best card without a button once the limit is reached, and names the active card passed over', () => {
    const open = evaluate(mixed(), { ownedItemIds: OWNED_ACTIVE });
    const advice = evaluate(mixed(), { ownedItemIds: OWNED_ACTIVE.slice(0, 2), maxActiveItems: 2 });
    expect(advice.preferredPosition).toBe(2);
    expect(advice.title).toBe('Pick Burst Fire');
    expect(advice.reasons[0]).toBe('Heroic Aura is passed over: an active item, and you already own 2 (you want at most 2).');
    // The skipped card keeps its place and score in the ranking, like an already-owned card.
    expect(advice.ranked.map(entry => entry.position)).toEqual(open.ranked.map(entry => entry.position));
    expect(scoreAt(advice, 0)).toBe(scoreAt(open, 0));
    expect(scoreAt(advice, 0)).toBeGreaterThan(scoreAt(advice, 2));
  });

  it('a limit of 0 excludes every active card from the first pick', () => {
    const advice = evaluate(mixed(), { ownedItemIds: [], maxActiveItems: 0 });
    expect(advice.preferredPosition).toBe(2);
    expect(advice.reasons[0]).toMatch(/^Heroic Aura is passed over: an active item, and you already own 0 /);
  });

  it('counts each owned item once and ignores owned items that are not active', () => {
    const owned = ['upgrade_arctic_blast', 'upgrade_arctic_blast', 'upgrade_burst_fire', 'upgrade_express_shot'];
    expect(evaluate(mixed().slice(0, 1).concat(offer('upgrade_bulletshredimbue', 1), offer('upgrade_magic_slow', 2)),
      { ownedItemIds: owned, maxActiveItems: 2 }).preferredPosition).toBe(0);
  });

  it('a card with no pinned facts counts as not active, and so does every card on an unsupported catalogue build', () => {
    const noFacts = [offer('upgrade_dps_aura', 0), offer('upgrade_express_shot', 1), offer('upgrade_thermal_detonator', 2)];
    const advice = evaluate(noFacts, { ownedItemIds: OWNED_ACTIVE, maxActiveItems: 1 });
    expect(advice.preferredPosition).toBe(1);
    expect(advice.reasons[0]).toMatch(/^Heroic Aura is passed over/);
    // Unsupported build: no facts at all, so the limit has nothing to count.
    const other = { ...catalog, revision: 'unsupported' } as Catalog;
    const unlimited = evaluate(mixed(), { ownedItemIds: OWNED_ACTIVE }, other);
    const limited = evaluate(mixed(), { ownedItemIds: OWNED_ACTIVE, maxActiveItems: 1 }, other);
    expect(limited.preferredPosition).toBe(unlimited.preferredPosition);
    expect(limited.reasons.some(reason => /active item/.test(reason))).toBe(false);
  });

  it('all three cards active at the limit: the best one is still picked, with a note', () => {
    const open = evaluate(allActive(), { ownedItemIds: OWNED_ACTIVE });
    const advice = evaluate(allActive(), { ownedItemIds: OWNED_ACTIVE, maxActiveItems: 3 });
    expect(advice.preferredPosition).toBe(open.preferredPosition);
    expect(advice.preferredPosition).not.toBeNull();
    expect(advice.reasons[0]).toBe('Every readable card is an active item and you already own 4 (you want at most 3); this is the best of them.');
    expect(advice.reasons.some(reason => /passed over/.test(reason))).toBe(false);
    // Below the limit there is no note.
    expect(evaluate(allActive(), { ownedItemIds: OWNED_ACTIVE.slice(0, 2), maxActiveItems: 3 }).reasons.some(reason => /active item/.test(reason))).toBe(false);
  });

  it('an unread card does not count as a card without a button, and an owned (misread) card is not a way out', () => {
    const unread: ScreenOffer = { position: 2, itemId: '', name: 'Unread item choice', bonusIds: null, variant: 'unknown', confidence: 0, warning: 'not readable yet' };
    const advice = evaluate([offer('upgrade_dps_aura', 0), offer('upgrade_thermal_detonator', 1), unread], { ownedItemIds: OWNED_ACTIVE, maxActiveItems: 3 });
    expect(advice.preferredPosition).toBe(0);
    // Burst Fire is already owned (a likely misread), so both trusted cards are active and the best of them stays.
    const owned = evaluate([offer('upgrade_dps_aura', 0), offer('upgrade_thermal_detonator', 1), offer('upgrade_burst_fire', 2)],
      { ownedItemIds: [...OWNED_ACTIVE, 'upgrade_burst_fire'], maxActiveItems: 3 });
    expect(owned.preferredPosition).toBe(0);
  });

  it('Bonus! cards are judged by their main item: an active free item does not make the card active', () => {
    const bonusCard = offer('upgrade_burst_fire', 2, { bonusIds: ['upgrade_thermal_detonator'], bonusExpected: true });
    const advice = evaluate([offer('upgrade_dps_aura', 0), offer('upgrade_bulletshredimbue', 1), bonusCard], { ownedItemIds: OWNED_ACTIVE, maxActiveItems: 3 });
    expect(advice.preferredPosition).toBe(2);
    // An active main item with a plain free item is still excluded.
    const activeMain = offer('upgrade_dps_aura', 0, { bonusIds: ['upgrade_burst_fire'], bonusExpected: true });
    const other = evaluate([activeMain, offer('upgrade_bulletshredimbue', 1), offer('upgrade_magic_slow', 2)], { ownedItemIds: OWNED_ACTIVE, maxActiveItems: 3 });
    expect(other.preferredPosition).not.toBe(0);
  });
});

describe('the active-item limit and the pick hold', () => {
  it('a pick shown before the limit was reached does not hold an active card the limit now excludes', () => {
    const cards = mixed();
    const first = evaluate(cards, { ownedItemIds: OWNED_ACTIVE.slice(0, 1), maxActiveItems: 2 });
    expect(first.preferredPosition).toBe(0);
    resetDraftMemory();
    const later = evaluate(cards, { ownedItemIds: OWNED_ACTIVE.slice(0, 2), maxActiveItems: 2, shownPick: { offers: cards, position: first.preferredPosition } });
    expect(later.preferredPosition).toBe(2);
    expect(later.reasons.some(reason => /Close call|unconfirmed/.test(reason))).toBe(false);
  });

  it('the pick shown after the limit stays while the same cards are on screen', () => {
    const cards = mixed();
    const context = { ownedItemIds: OWNED_ACTIVE.slice(0, 2), maxActiveItems: 2 };
    const first = evaluate(cards, context);
    const again = evaluate(cards, { ...context, shownPick: { offers: cards, position: first.preferredPosition } });
    expect(again.preferredPosition).toBe(first.preferredPosition);
    expect(again.preferredPosition).toBe(2);
  });

  it('a held non-active pick never lets a higher-scoring excluded active card in, however clear its lead', () => {
    const cards = mixed();
    const advice = evaluate(cards, { ownedItemIds: OWNED_ACTIVE, maxActiveItems: 1, shownPick: { offers: cards, position: 1 } });
    // Heroic Aura leads by far and is excluded; Burst Fire leads Bullet Shredder by more than the margin.
    expect(advice.preferredPosition).toBe(2);
  });
});
