import { describe, expect, it } from 'vitest';
import catalogData from '../data/public-catalog.json';
import type { Catalog } from '../src/shared/types';
import type { NativeIconMatch, NativeOcrBlock } from '../src/shared/screen-reading';
import { detectDraftHint, draftChoiceStage, isBonusLabel, namedItems, normalizeOfferText, parseScreenOffers } from '../src/screen/offer-parser';

const catalog = catalogData as Catalog;
const centers = [0.26, 0.5, 0.74];
const itemNames = ['Active Reload', 'Bullet Lifesteal', 'Spirit Resilience'];
function block(text: string, x: number, y: number, width = 0.18, height = 0.032): NativeOcrBlock { return { text, x, y, width, height }; }
function frame(names = itemNames): NativeOcrBlock[] {
  return [block('SELECT ITEMS', 0.28, 0.06, 0.44, 0.075), block('Choice 1 of 3', 0.4, 0.17, 0.2),
    block('Use Re-Roll', 0.43, 0.78, 0.14), block('1 Re-Roll Remaining', 0.39, 0.84, 0.22),
    ...names.flatMap((name, position) => {
      const x = centers[position]!; const y = position === 1 ? 0.42 : 0.68;
      return [block(name, x - 0.09, y), block('Tier 2', x - 0.04, y + 0.055, 0.08, 0.023)];
    })];
}
function marker(text: string, position = 0): NativeOcrBlock { const x = centers[position]!; return block(text, x - 0.045, position === 1 ? 0.31 : 0.56, 0.09, 0.027); }
function bonusIcon(position: number, slot: 0 | 1 = 0, overrides: Partial<NativeIconMatch> = {}): NativeIconMatch {
  return { role: 'bonus', slot, itemId: 'upgrade_improved_spirit', confidence: 0.98,
    bounds: { x: centers[position]! - 0.095, y: position === 1 ? 0.24 : 0.5, width: 0.045, height: 0.065 }, ...overrides };
}

// Only public selection labels and card names/geometry retained from the local
// draft review. Match IDs, player labels, and unrelated HUD text are excluded.
function observedSelectionFrame(): NativeOcrBlock[] {
  return [
    block('SELECT ITEMS', 0.038333, 0.181818, 0.244444, 0.052372),
    block('CHOICE 1 OF 3', 0.04, 0.267787, 0.097778, 0.023715),
    block('Toxic Bullets', 0.221111, 0.676877, 0.114444, 0.029644),
    block('Tesla Bullets', 0.443889, 0.447628, 0.111667, 0.030632),
    block('Use Re-Roll', 0.462778, 0.653162, 0.074444, 0.019763),
    block('1 Re-Roll Remaining', 0.46, 0.713439, 0.079444, 0.01581),
    block('RARE!', 0.7, 0.51581, 0.042222, 0.021739),
    block('Spiritual Ouerflow', 0.638889, 0.673913, 0.165556, 0.039526),
  ];
}

describe('anonymized actual selection OCR geometry', () => {
  it('recognizes the actual three cards and bounded rotated-name corruption', () => {
    const parsed = parseScreenOffers(observedSelectionFrame(), catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.isDraft).toBe(true);
    expect(parsed.offers.map(offer => offer.name)).toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
    expect(parsed.offers[2]?.warning).toMatch(/OCR correction/);
    expect(parsed.offers.every(offer => offer.variant === 'base' && offer.bonusIds === null)).toBe(true);
  });
  it('also reconstructs the actual individually bounded OCR heading words', () => {
    const blocks = observedSelectionFrame().filter(value => !['Toxic Bullets', 'Tesla Bullets', 'Spiritual Ouerflow'].includes(value.text));
    blocks.push(block('Toxic', 0.221111, 0.677866, 0.047222, 0.028656), block('Bullets', 0.272778, 0.676877, 0.062778, 0.02668),
      block('Tesla', 0.443889, 0.450593, 0.043889, 0.027668), block('Bullets', 0.493333, 0.447628, 0.062222, 0.027668),
      block('Spiritual', 0.638889, 0.678854, 0.077222, 0.034585), block('Ouerflow', 0.721667, 0.673913, 0.082778, 0.029644));
    expect(parseScreenOffers(blocks, catalog, { conservativeUnmarkedDetails: true }).offers.map(offer => offer.name))
      .toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
  });
  it('places the two readable cards of a partially revealed actual frame and keeps the third explicitly unread', () => {
    // Cards deal in one at a time (2026-10-18: the first set took 1.1-1.7 s to show); readable cards show at once.
    const blocks = observedSelectionFrame().filter(value => !['RARE!', 'Spiritual Ouerflow'].includes(value.text));
    const parsed = parseScreenOffers(blocks, catalog, { conservativeUnmarkedDetails: true });
    expect(parsed).toMatchObject({ isDraft: true, incomplete: true, signature: null });
    expect(parsed.offers.map(offer => [offer.position, offer.name])).toEqual([[0, 'Toxic Bullets'], [1, 'Tesla Bullets'], [2, 'Unread item choice']]);
    expect(parsed.offers[2]).toMatchObject({ itemId: '', confidence: 0, bonusIds: null });
  });
  it('retains the same card details when the actual reroll counter drops out of OCR', () => {
    const first = parseScreenOffers(observedSelectionFrame(), catalog, { conservativeUnmarkedDetails: true });
    const next = parseScreenOffers(observedSelectionFrame().filter(value => value.text !== '1 Re-Roll Remaining'), catalog, { conservativeUnmarkedDetails: true });
    expect(first.rerolls).toBe(1); expect(next.rerolls).toBeNull();
    expect(next.offers).toEqual(first.offers);
  });
  it('corroborates an external hint from the observed staggered heading geometry', () => {
    const blocks = observedSelectionFrame().filter(value => ['Toxic Bullets', 'Tesla Bullets', 'Spiritual Ouerflow', 'RARE!'].includes(value.text));
    expect(parseScreenOffers(blocks, catalog, { draftConfirmed: true, conservativeUnmarkedDetails: true }).offers.map(offer => offer.name))
      .toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
  });
});

describe('source-backed draft cues and spatial offers', () => {
  it('reads three actual catalogue names in the native staggered layout', () => {
    const parsed = parseScreenOffers(frame(), catalog);
    expect(parsed.isDraft).toBe(true); expect(parsed.incomplete).toBe(false);
    expect(parsed.offers.map(offer => [offer.position, offer.name])).toEqual([[0, 'Active Reload'], [1, 'Bullet Lifesteal'], [2, 'Spirit Resilience']]);
    expect(parsed.offers.every(offer => offer.confidence === 1 && offer.bonusIds?.length === 0 && offer.variant === 'base')).toBe(true);
    expect(parsed.rerolls).toBe(1); expect(parsed.signature).not.toBeNull();
  });
  it('orders choices by x rather than OCR text order or vertical position', () => {
    expect(parseScreenOffers([...frame()].reverse(), catalog).offers.map(offer => offer.name)).toEqual(itemNames);
  });
  it('accepts the exact Use Re-Roll button when crop clips the title/progress', () => {
    const blocks = frame().filter(value => !value.text.includes('ITEMS') && !value.text.includes('Choice'));
    expect(parseScreenOffers(blocks, catalog).incomplete).toBe(false);
  });
  it('requires a real draft cue and never promotes three random inventory names', () => {
    const blocks = frame().filter(value => !['SELECT ITEMS', 'Choice 1 of 3', 'Use Re-Roll', '1 Re-Roll Remaining'].includes(value.text));
    expect(parseScreenOffers(blocks, catalog).isDraft).toBe(false);
  });
  it('does not infer drafting from a round and generic reroll count', () => {
    const blocks = frame().filter(value => !['SELECT ITEMS', 'Choice 1 of 3', 'Use Re-Roll'].includes(value.text));
    blocks.push(block('Round 2', 0.01, 0.03, 0.13));
    expect(parseScreenOffers(blocks, catalog).isDraft).toBe(false);
  });
  it('supports a separate fresh hint but still requires spatial choices', () => {
    const blocks = frame().filter(value => !['SELECT ITEMS', 'Choice 1 of 3', 'Use Re-Roll', '1 Re-Roll Remaining'].includes(value.text));
    expect(parseScreenOffers(blocks, catalog, { draftConfirmed: true }).incomplete).toBe(false);
    expect(parseScreenOffers([blocks[0]!], catalog, { draftConfirmed: true }).signature).toBeNull();
  });
  it('clears a just-observed draft hint when the later capture contains only combat HUD text', () => {
    const parsed = parseScreenOffers([block('ROUND 2', 0.01, 0.01, 0.15), block('1250', 0.02, 0.8, 0.05)], catalog, { draftConfirmed: true });
    expect(parsed).toMatchObject({ isDraft: false, offers: [], signature: null });
  });
  it('rejects an ordinary inventory row after a separate draft hint', () => {
    const blocks = itemNames.map((name, position) => block(name, centers[position]! - 0.09, 0.55));
    expect(parseScreenOffers(blocks, catalog, { draftConfirmed: true })).toMatchObject({ isDraft: false, offers: [], signature: null });
  });
  it('rejects small HUD labels even when their positions mimic the staggered choices', () => {
    const blocks = itemNames.map((name, position) => block(name, centers[position]! - 0.09, position === 1 ? 0.42 : 0.68, 0.18, 0.011));
    expect(parseScreenOffers(blocks, catalog, { draftConfirmed: true }).isDraft).toBe(false);
  });
  it('keeps exact current panel cues authoritative when item headings shrink or rotate', () => {
    const blocks = frame().map(value => itemNames.includes(value.text) ? { ...value, y: 0.55, height: 0.014 } : value);
    expect(parseScreenOffers(blocks, catalog)).toMatchObject({ isDraft: true, incomplete: false });
  });
  it('closed/selects-complete text overrides both names and an external hint', () => {
    expect(parseScreenOffers([...frame(), block('Selects Complete', 0.35, 0.25, 0.3)], catalog, { draftConfirmed: true }).isDraft).toBe(false);
  });
  it('places a partially revealed two-card frame by the fixed card positions', () => {
    const blocks = frame().filter(value => value.text !== 'Spirit Resilience' && !(value.text === 'Tier 2' && value.x > 0.6));
    const parsed = parseScreenOffers(blocks, catalog);
    expect(parsed).toMatchObject({ isDraft: true, incomplete: true, signature: null });
    expect(parsed.offers.map(offer => offer.itemId ? offer.name : '')).toEqual(['Active Reload', 'Bullet Lifesteal', '']);
    // The right card alone is placed on the right.
    const right = parseScreenOffers(frame().filter(value => !['Active Reload', 'Bullet Lifesteal', 'Tier 2'].includes(value.text) || value.x > 0.6), catalog);
    expect(right.offers.map(offer => offer.itemId ? offer.name : '')).toEqual(['', '', 'Spirit Resilience']);
  });
  it('does not place a lone name that is not where a card name can be', () => {
    const blocks = [...frame().filter(value => !itemNames.includes(value.text) && value.text !== 'Tier 2'), block('Active Reload', 0.38, 0.6)];
    expect(parseScreenOffers(blocks, catalog).offers.filter(offer => offer.itemId)).toEqual([]);
  });
  it('keeps an unread third main item explicit when its card anchor is visible', () => {
    const parsed = parseScreenOffers(frame(['Active Reload', 'Bullet Lifesteal', 'Quantum Marmalade']), catalog);
    expect(parsed.offers[2]).toMatchObject({ position: 2, itemId: '', variant: 'unknown', bonusIds: null, confidence: 0 });
    expect(parsed.incomplete).toBe(true); expect(parsed.signature).toBeNull();
  });
  it('rejects compressed side-by-side labels without three sufficiently spaced columns', () => {
    const blocks = [block('Select Items', 0.2, 0.05), block('Choice 1 of 3', 0.2, 0.12),
      ...itemNames.map((name, position) => block(name, 0.2 + position * 0.06, 0.55, 0.04))];
    expect(parseScreenOffers(blocks, catalog).signature).toBeNull();
  });
  it('does not promote a large inventory grid even with an unrelated draft hint', () => {
    const blocks = [block('Inventory', 0.1, 0.05), ...frame(),
      ...['Frenzy', 'Leech', 'Healbane'].flatMap((name, row) => centers.map(x => block(name, x - 0.09, 0.25 + row * 0.075)))];
    expect(parseScreenOffers(blocks, catalog, { draftConfirmed: true }).isDraft).toBe(false);
  });
  it('shows ambiguous extra names rather than selecting the first item in a column', () => {
    const parsed = parseScreenOffers([...frame(), block('Leech', 0.17, 0.6)], catalog);
    expect(parsed.offers[0]?.itemId).toBe(''); expect(parsed.signature).toBeNull();
  });
});

describe('whole-name OCR matching', () => {
  it('normalizes case, apostrophes and hyphens without substring matching', () => {
    expect(normalizeOfferText("DIVINER’S KEVLAR")).toBe('diviners kevlar');
    expect(parseScreenOffers(frame(["DIVINER’S KEVLAR", 'HIGH-VELOCITY ROUNDS', 'Spirit Resilience']), catalog).incomplete).toBe(false);
    expect(parseScreenOffers(frame(['Not Leech', 'Bullet Lifesteal', 'Spirit Resilience']), catalog).offers[0]?.itemId).toBe('');
  });
  it('does not match a vague Healing label to Healing Rite or Healing Nova', () => {
    expect(parseScreenOffers(frame(['Healing', 'Bullet Lifesteal', 'Spirit Resilience']), catalog).offers[0]?.itemId).toBe('');
  });
  it('does not correct a short unrelated Beech label into Leech', () => {
    expect(parseScreenOffers(frame(['Beech', 'Bullet Lifesteal', 'Spirit Resilience']), catalog).offers[0]?.itemId).toBe('');
  });
  it('allows a specific 1/l OCR glyph confusion with an explicit correction warning', () => {
    const offer = parseScreenOffers(frame(['1eech', 'Bullet Lifesteal', 'Spirit Resilience']), catalog).offers[0];
    expect(offer?.name).toBe('Leech'); expect(offer?.confidence).toBeGreaterThan(0.94); expect(offer?.warning).toMatch(/OCR correction/);
  });
  it('allows bounded high-margin corruption of a long name', () => {
    const offer = parseScreenOffers(frame(['Escalating Exposurc', 'Bullet Lifesteal', 'Spirit Resilience']), catalog).offers[0];
    expect(offer?.name).toBe('Escalating Exposure'); expect(offer?.warning).toMatch(/OCR correction/);
  });
  it('rejects fuzzy matches tied between two names', () => {
    const custom: Catalog = { ...catalog, items: [...catalog.items,
      { ...catalog.items[0]!, id: 'test-a', name: 'Spiritual Boost' }, { ...catalog.items[0]!, id: 'test-b', name: 'Spiritual Boast' }] };
    expect(parseScreenOffers(frame(['Spiritual Bost', 'Bullet Lifesteal', 'Spirit Resilience']), custom).offers[0]?.itemId).toBe('');
  });
  it('joins adjacent aligned multiline names', () => {
    const blocks = frame(['Active Reload', 'Bullet\nLifesteal', 'Spirit Resilience']).map(value => value.text.includes('\n') ? { ...value, height: 0.065 } : value);
    expect(parseScreenOffers(blocks, catalog).offers[1]?.name).toBe('Bullet Lifesteal');
  });
  it('joins horizontally adjacent OCR words within a card', () => {
    const blocks = frame().filter(value => value.text !== 'Bullet Lifesteal');
    blocks.push(block('BULLET', 0.41, 0.42, 0.065), block('LIFESTEAL', 0.485, 0.42, 0.105));
    expect(parseScreenOffers(blocks, catalog).offers[1]?.name).toBe('Bullet Lifesteal');
  });
  it('never joins pieces from different offer columns into a name', () => {
    const blocks = frame(['Bullet', 'Lifesteal', 'Spirit Resilience']);
    expect(parseScreenOffers(blocks, catalog).incomplete).toBe(true);
  });
  it('does not extract a known item from prose mentioning it', () => {
    expect(parseScreenOffers(frame(['Gain healing with Leech', 'Bullet Lifesteal', 'Spirit Resilience']), catalog).offers[0]?.itemId).toBe('');
  });
});

describe('bonus bundles and variants', () => {
  it('reads unlabelled real-capture cards as base items but keeps their unread bonus details unknown', () => {
    const parsed = parseScreenOffers(frame(), catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.offers.map(offer => offer.name)).toEqual(itemNames);
    expect(parsed.offers.every(offer => offer.itemId && offer.variant === 'base' && offer.bonusIds === null)).toBe(true);
    expect(parsed.offers[0]?.warning).not.toMatch(/modifier/);
    expect(parsed.offers[0]?.warning).toMatch(/bundle.*unconfirmed/);
    expect(parsed.message).toMatch(/details are unconfirmed/);
    expect(parsed.message).not.toMatch(/advice is withheld/);
    expect(parsed.incomplete).toBe(true); expect(parsed.signature).toBeNull();
  });
  it('does not let an unmarked native image pair certify a real-capture bonus bundle', () => {
    const parsed = parseScreenOffers(frame(), catalog, { conservativeUnmarkedDetails: true, iconMatches: [bonusIcon(0), bonusIcon(0, 1)] });
    expect(parsed.offers[0]?.bonusIds).toBeNull();
    expect(parsed.offers[0]?.warning).toMatch(/Bonus details were not read/);
  });
  it('retains affirmative modifier and marker-backed bonus evidence in conservative captures', () => {
    const parsed = parseScreenOffers([...frame(), marker('Enhanced'), marker('Bonus!')], catalog,
      { conservativeUnmarkedDetails: true, iconMatches: [bonusIcon(0), bonusIcon(0, 1)] });
    expect(parsed.offers[0]).toMatchObject({ variant: 'enhanced', bonusIds: ['upgrade_improved_spirit', 'upgrade_improved_spirit'] });
    expect(parsed.offers[1]).toMatchObject({ variant: 'base', bonusIds: null });
  });
  it('retains explicitly named bonus quantities even when no standalone marker was read', () => {
    const parsed = parseScreenOffers(frame(['Leech + Extra Spirit + Extra Regen', 'Bullet Lifesteal', 'Spirit Resilience']), catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.offers[0]).toMatchObject({ variant: 'base', bonusIds: ['upgrade_improved_spirit', 'upgrade_endurance'] });
  });
  it('does not use unmarked native extras to enlarge an explicitly named real-capture bundle', () => {
    const parsed = parseScreenOffers(frame(['Leech + Extra Spirit', 'Bullet Lifesteal', 'Spirit Resilience']), catalog,
      { conservativeUnmarkedDetails: true, iconMatches: [bonusIcon(0), bonusIcon(0, 1)] });
    expect(parsed.offers[0]?.bonusIds).toBeNull();
  });
  it('keeps Rare roll rarity insufficient to certify no bonus', () => {
    expect(parseScreenOffers([...frame(), marker('Rare!')], catalog, { conservativeUnmarkedDetails: true }).offers[0])
      .toMatchObject({ variant: 'base', bonusIds: null });
  });
  it('preserves all explicitly named plus-separated bonus items', () => {
    const parsed = parseScreenOffers(frame(['Leech + Extra Spirit + Extra Regen', 'Bullet Lifesteal', 'Spirit Resilience']), catalog);
    expect(parsed.offers[0]?.bonusIds).toEqual(['upgrade_improved_spirit', 'upgrade_endurance']); expect(parsed.incomplete).toBe(false);
  });
  it('preserves two explicitly named bonuses with the same identity', () => {
    const parsed = parseScreenOffers(frame(['Leech + Extra Spirit + Extra Spirit', 'Bullet Lifesteal', 'Spirit Resilience']), catalog);
    expect(parsed.offers[0]?.bonusIds).toEqual(['upgrade_improved_spirit', 'upgrade_improved_spirit']);
  });
  it('reads separate explicitly labelled bonus name strings', () => {
    const parsed = parseScreenOffers([...frame(), block('Bonus: Extra Regen', 0.17, 0.6)], catalog);
    expect(parsed.offers[0]?.bonusIds).toEqual(['upgrade_endurance']);
  });
  it('repairs a wrapped bonus name without keeping its unread fragment active', () => {
    const parsed = parseScreenOffers([...frame(), block('Bonus: Extra\nSpirit', 0.17, 0.57, 0.18, 0.065)], catalog);
    expect(parsed.offers[0]?.bonusIds).toEqual(['upgrade_improved_spirit']); expect(parsed.incomplete).toBe(false);
  });
  it('does not let a known bonus hide an unknown later segment', () => {
    const parsed = parseScreenOffers(frame(['Leech + Extra Spirit + Quantum Marmalade', 'Bullet Lifesteal', 'Spirit Resilience']), catalog);
    expect(parsed.offers[0]?.bonusIds).toBeNull(); expect(parsed.signature).toBeNull();
  });
  it('does not turn an unknown bonus into a no-bonus bundle', () => {
    const parsed = parseScreenOffers(frame(['Leech + Quantum Marmalade', 'Bullet Lifesteal', 'Spirit Resilience']), catalog);
    expect(parsed.offers[0]?.bonusIds).toBeNull(); expect(parsed.signature).toBeNull();
  });
  it('keeps icon-only Bonus! unresolved without validated icon identities', () => {
    const parsed = parseScreenOffers([...frame(), marker('Bonus!')], catalog);
    expect(parsed.offers[0]?.bonusIds).toBeNull(); expect(parsed.offers[0]?.warning).toMatch(/Bonus items/); expect(parsed.signature).toBeNull();
  });
  it('accepts strong labelled matches for both native bonus slots in the same card', () => {
    const parsed = parseScreenOffers([...frame(), marker('Bonus!')], catalog, { iconMatches: [bonusIcon(0), bonusIcon(0, 1)] });
    expect(parsed.offers[0]?.bonusIds).toEqual(['upgrade_improved_spirit', 'upgrade_improved_spirit']); expect(parsed.incomplete).toBe(false);
  });
  it('does not certify one native bonus slot when its sibling is missing', () => {
    const parsed = parseScreenOffers([...frame(), marker('Bonus!')], catalog, { iconMatches: [bonusIcon(0)] });
    expect(parsed.offers[0]?.bonusIds).toBeNull(); expect(parsed.signature).toBeNull();
  });
  it('keeps a bundle unresolved when a crop-relative sibling extends outside the capture', () => {
    const croppedSibling = bonusIcon(0, 1, { itemId: '', confidence: 0, bounds: { x: -0.017113, y: 0.5, width: 0.06, height: 0.065 } });
    const parsed = parseScreenOffers([...frame(), marker('Bonus!')], catalog, { iconMatches: [bonusIcon(0), croppedSibling] });
    expect(parsed.offers[0]?.bonusIds).toBeNull(); expect(parsed.signature).toBeNull();
  });
  it('preserves failure of a second visible bonus slot', () => {
    const parsed = parseScreenOffers([...frame(), marker('Bonus!')], catalog, { iconMatches: [bonusIcon(0), bonusIcon(0, 1, { itemId: '', confidence: 0 })] });
    expect(parsed.offers[0]?.bonusIds).toBeNull(); expect(parsed.signature).toBeNull();
  });
  it('preserves two actual icon slots even when their identities are equal', () => {
    const parsed = parseScreenOffers([...frame(), marker('Bonus!')], catalog, { iconMatches: [bonusIcon(0), bonusIcon(0, 1)] });
    expect(parsed.offers[0]?.bonusIds).toEqual(['upgrade_improved_spirit', 'upgrade_improved_spirit']);
  });
  it('does not double-count a bonus identified in both text and an icon slot', () => {
    const parsed = parseScreenOffers([...frame(), block('Bonus: Extra Spirit', 0.17, 0.6)], catalog, { iconMatches: [bonusIcon(0), bonusIcon(0, 1)] });
    expect(parsed.offers[0]?.bonusIds).toEqual(['upgrade_improved_spirit', 'upgrade_improved_spirit']);
  });
  it('keeps disagreement between named bonus text and icon identity unresolved', () => {
    const parsed = parseScreenOffers([...frame(), block('Bonus: Extra Regen', 0.17, 0.6)], catalog, { iconMatches: [bonusIcon(0), bonusIcon(0, 1)] });
    expect(parsed.offers[0]?.bonusIds).toBeNull(); expect(parsed.signature).toBeNull();
  });
  it('rejects low-confidence or unlabelled generic icon matches', () => {
    for (const icon of [bonusIcon(0, 0, { confidence: 0.8 }), bonusIcon(0, 0, { role: undefined }), bonusIcon(0, 0, { slot: undefined })]) {
      expect(parseScreenOffers([...frame(), marker('Bonus!')], catalog, { iconMatches: [icon] }).offers[0]?.bonusIds).toBeNull();
    }
  });
  it('requires slot zero before a slot-one-only bundle can be complete', () => {
    expect(parseScreenOffers([...frame(), marker('Bonus!')], catalog, { iconMatches: [bonusIcon(0, 1)] }).offers[0]?.bonusIds).toBeNull();
  });
  it('rejects conflicting identities for one icon slot', () => {
    expect(parseScreenOffers([...frame(), marker('Bonus!')], catalog, { iconMatches: [bonusIcon(0), bonusIcon(0, 0, { itemId: 'upgrade_endurance' })] }).offers[0]?.bonusIds).toBeNull();
  });
  it('does not attach an adjacent-column icon to the wrong bundle', () => {
    const parsed = parseScreenOffers([...frame(), marker('Bonus!', 0), marker('Bonus!', 1)], catalog, { iconMatches: [bonusIcon(1), bonusIcon(1, 1)] });
    expect(parsed.offers[0]?.bonusIds).toBeNull(); expect(parsed.offers[1]?.bonusIds).toEqual(['upgrade_improved_spirit', 'upgrade_improved_spirit']);
  });
  it.each(['enhanced', 'legendary', 'corrupted'] as const)('recognizes %s but withholds unresolved modifier guidance', variant => {
    const parsed = parseScreenOffers(frame([`${variant} Active Reload`, 'Bullet Lifesteal', 'Spirit Resilience']), catalog);
    expect(parsed.offers[0]?.variant).toBe(variant); expect(parsed.incomplete).toBe(true); expect(parsed.signature).toBeNull();
  });
  it('recognizes a separate enhancement label near the card', () => {
    expect(parseScreenOffers([...frame(), marker('Enhanced', 1)], catalog).offers[1]?.variant).toBe('enhanced');
  });
  it('keeps conflicting or unknown modifier labels uncertain', () => {
    expect(parseScreenOffers([...frame(), marker('Empowered', 0)], catalog).offers[0]?.variant).toBe('unknown');
    expect(parseScreenOffers(frame(['Enhanced Legendary Leech', 'Bullet Lifesteal', 'Spirit Resilience']), catalog).offers[0]?.variant).toBe('unknown');
  });
  it('does not confuse a Rare! roll label with an enhanced item', () => {
    const parsed = parseScreenOffers([...frame(), marker('Rare!')], catalog);
    expect(parsed.offers[0]?.variant).toBe('base'); expect(parsed.incomplete).toBe(false);
  });
});

describe('observed fields, signature and bounded input', () => {
  it('reads a unique exact hero label and explicit numeric round', () => {
    expect(parseScreenOffers([...frame(), block('Your Hero: Lady Geist', 0.01, 0.94, 0.22), block('Round 3', 0.01, 0.03, 0.13)], catalog)).toMatchObject({ heroId: 'hero_ghost', round: 3 });
  });
  it('does not use descriptive prose or a non-Street-Brawl round as the current round', () => {
    for (const label of ['Round 3 bonus', 'After Round 3', 'Round 30', 'Round 0', 'Round 6']) {
      expect(parseScreenOffers([...frame(), block(label, 0.01, 0.03, 0.18)], catalog).round).toBeNull();
    }
  });
  it('does not infer a local hero from a roster or player-name substrings', () => {
    expect(parseScreenOffers([...frame(), block('Lady Geist', 0.01, 0.9), block('Haze', 0.8, 0.9)], catalog).heroId).toBeNull();
    expect(parseScreenOffers([...frame(), block('Lady Geist fan 123', 0.01, 0.9)], catalog).heroId).toBeNull();
  });
  it('preserves a visibly zero reroll count and never fills an absent count with zero', () => {
    const blocks = frame().filter(value => value.text !== '1 Re-Roll Remaining');
    expect(parseScreenOffers(blocks, catalog).rerolls).toBeNull();
    expect(parseScreenOffers([...blocks, block('0 Re-Rolls Remaining', 0.4, 0.84, 0.2)], catalog).rerolls).toBe(0);
  });
  it('withholds conflicting numeric fields', () => {
    expect(parseScreenOffers([...frame(), block('2 Re-Rolls Remaining', 0.01, 0.94, 0.25)], catalog).rerolls).toBeNull();
  });
  it('uses flat crop-relative coordinates instead of optional full-client bounds', () => {
    const blocks = frame().map(value => ({ ...value, bounds: { x: 0, y: 0, width: 1, height: 1 } }));
    expect(parseScreenOffers(blocks, catalog).incomplete).toBe(false);
  });
  it('ignores geometry jitter and OCR enumeration order in complete signatures', () => {
    const initial = parseScreenOffers(frame(), catalog);
    const moved = parseScreenOffers(frame().map(value => ({ ...value, x: value.x + 0.001, y: value.y + 0.001 })).reverse(), catalog);
    expect(moved.signature).toBe(initial.signature);
    expect(parseScreenOffers(frame(['Frenzy', 'Bullet Lifesteal', 'Spirit Resilience']), catalog).signature).not.toBe(initial.signature);
  });
  it('invalid geometry and truncated inputs can never form a complete signature', () => {
    const parsed = parseScreenOffers([...frame(), block('bad', Number.NaN, 0.5)], catalog);
    expect(parsed.incomplete).toBe(true); expect(parsed.signature).toBeNull();
    expect(parseScreenOffers([...frame(), ...Array.from({ length: 600 }, () => block('HUD', 0.01, 0.96, 0.03, 0.02))], catalog).signature).toBeNull();
  });
  it('handles missing text without throwing', () => {
    expect(parseScreenOffers(null as unknown as NativeOcrBlock[], catalog).isDraft).toBe(false);
    expect(detectDraftHint([])).toBe(false);
  });
  it('detects source title, progress or button hints without giving offers', () => {
    expect(detectDraftHint([block('Select Items', 0.1, 0.1)])).toBe(true);
    expect(detectDraftHint([block('Choice 1 of 3', 0.1, 0.1)])).toBe(true);
    expect(detectDraftHint([block('Use Re-Roll', 0.1, 0.1)])).toBe(true);
    expect(detectDraftHint([block('Round 3', 0.1, 0.1)])).toBe(false);
    expect(detectDraftHint([block('Select Items', 0.1, 0.1), block('Selects Complete', 0.1, 0.2)])).toBe(false);
  });
  it('does not confuse inventory instructions or generic choose/skip labels with the source title', () => {
    for (const label of ['Select items from your inventory', 'Choose an item', 'Pick one item', 'Item Draft', 'Skip Item', 'Choices available', 'Select Items to sell']) {
      expect(detectDraftHint([block(label, 0.1, 0.1)])).toBe(false);
    }
    expect(detectDraftHint([block('SeIect ltems', 0.1, 0.1)])).toBe(true);
  });
  it('accepts only the observed three-choice progress range from the pinned source', () => {
    for (const label of ['Choice 0 of 3', 'Choice 4 of 3', 'Choice 1 of 10', 'Choice 0 of 0', 'Choice 2 of 3 complete']) {
      expect(detectDraftHint([block(label, 0.1, 0.1)])).toBe(false);
    }
    expect(detectDraftHint([block('Choice 3 of 3', 0.1, 0.1)])).toBe(true);
  });
});

// Real 2026-10-11 Street Brawl draft geometry (client 1920x1080), public card labels only.
function realDraft(names: [string, string, string] = ['Disarming Hex', 'Stamina Mastery', 'Surge of Power']): NativeOcrBlock[] {
  return [block('SELECT ITEM•', 0.038333, 0.175889, 0.260556, 0.0583), block('CHOICE 3 OF 3', 0.039444, 0.267787, 0.101111, 0.023715),
    block(names[0], 0.213889, 0.675889, 0.128889, 0.032609), block(names[1], 0.423889, 0.447628, 0.151667, 0.031621),
    block('Use Re-Roll', 0.462778, 0.653162, 0.074444, 0.019763), block('Re-Roll Remaining', 0.464444, 0.713439, 0.075, 0.01581),
    block(names[2], 0.653333, 0.675889, 0.136667, 0.036561)];
}
// The middle card's "BONUS!" label (citadel_item_draft_option.css: 20px at (60,30) of the 400px option)
// as Windows OCR actually reads it, and the native matcher's two bonus slots around it.
const middleBonusLabel = (text = 'eoNUS!') => block(text, 0.428, 0.239, 0.031, 0.022);
const middleBonusIcon = (slot: 0 | 1, itemId: string, confidence = 0.97): NativeIconMatch => ({ role: 'bonus', slot, itemId, confidence,
  bounds: slot === 0 ? { x: 0.417, y: 0.248, width: 0.052, height: 0.093 } : { x: 0.396, y: 0.327, width: 0.042, height: 0.074 } });

describe('Street Brawl "Bonus!" cards', () => {
  it.each(['eoNUS!', 'eoNusr', 'BONUS!', 'Bonus!'])('reads the real OCR form %s of the Bonus! label as the bonus marker', text => {
    const parsed = parseScreenOffers([...realDraft(), middleBonusLabel(text)], catalog,
      { conservativeUnmarkedDetails: true, iconMatches: [middleBonusIcon(0, 'upgrade_improved_spirit'), middleBonusIcon(1, 'upgrade_endurance')] });
    expect(parsed.offers.map(offer => offer.name)).toEqual(['Disarming Hex', 'Stamina Mastery', 'Surge of Power']);
    expect(parsed.offers[1]).toMatchObject({ bonusIds: ['upgrade_improved_spirit', 'upgrade_endurance'], bonusExpected: true });
    expect(parsed.offers[0]?.bonusExpected).toBeUndefined();
  });
  it('predicts a bonus from an owned component and records the item the upgrade absorbs', () => {
    const parsed = parseScreenOffers(realDraft(), catalog, { conservativeUnmarkedDetails: true, ownedItemIds: ['upgrade_improved_stamina'] });
    expect(parsed.offers[1]).toMatchObject({ itemId: 'upgrade_superior_stamina', bonusIds: null, bonusExpected: true, absorbsIds: ['upgrade_improved_stamina'] });
    expect(parsed.offers[1]?.warning).toMatch(/Bonus! card/);
    // Cards that upgrade nothing you own carry no bonus: confirmed, not "unread".
    expect(parsed.offers[0]?.bonusIds).toEqual([]); expect(parsed.offers[2]?.bonusIds).toEqual([]);
    expect(parsed.offers[0]?.warning ?? '').not.toMatch(/Bonus/);
  });
  it('keeps bonus coverage unknown when your inventory has not been read', () => {
    const parsed = parseScreenOffers(realDraft(), catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.offers.every(offer => offer.bonusIds === null && !offer.bonusExpected)).toBe(true);
  });
  it('accepts one identified bonus with an empty second slot when one owned component is absorbed', () => {
    const icons = [middleBonusIcon(0, 'upgrade_improved_spirit'), middleBonusIcon(1, '', 0)];
    const owned = parseScreenOffers([...realDraft(), middleBonusLabel()], catalog, { conservativeUnmarkedDetails: true, iconMatches: icons, ownedItemIds: ['upgrade_improved_stamina'] });
    expect(owned.offers[1]?.bonusIds).toEqual(['upgrade_improved_spirit']);
    // Without the ownership prediction an empty second slot cannot prove a one-item bundle.
    expect(parseScreenOffers([...realDraft(), middleBonusLabel()], catalog, { conservativeUnmarkedDetails: true, iconMatches: icons }).offers[1]?.bonusIds).toBeNull();
  });
  it('never reads the bonus label or bonus icons as a separate card', () => {
    const parsed = parseScreenOffers([...realDraft(), middleBonusLabel()], catalog,
      { conservativeUnmarkedDetails: true, iconMatches: [middleBonusIcon(0, 'upgrade_improved_spirit'), middleBonusIcon(1, '', 0)], ownedItemIds: ['upgrade_improved_stamina'] });
    expect(parsed.offers).toHaveLength(3);
    expect(parsed.offers.map(offer => offer.position)).toEqual([0, 1, 2]);
  });
  it('accepts unlabelled native bonus slots only when an owned component predicts the bonus', () => {
    // Windows OCR rarely reads the small label; the native helper then searches the fixed slots.
    const icons = [middleBonusIcon(0, 'upgrade_improved_spirit'), middleBonusIcon(1, '', 0)];
    const predicted = parseScreenOffers(realDraft(), catalog, { conservativeUnmarkedDetails: true, iconMatches: icons, ownedItemIds: ['upgrade_improved_stamina'] });
    expect(predicted.offers[1]).toMatchObject({ bonusIds: ['upgrade_improved_spirit'], bonusExpected: true, absorbsIds: ['upgrade_improved_stamina'] });
    expect(predicted.offers[1]?.warning ?? '').not.toMatch(/bonus/i);
    // Nothing owned is upgraded by this card: a template match alone cannot certify a bundle.
    const unpredicted = parseScreenOffers(realDraft(), catalog, { conservativeUnmarkedDetails: true, iconMatches: icons, ownedItemIds: ['upgrade_endurance'] });
    expect(unpredicted.offers[1]).toMatchObject({ bonusIds: null, bonusExpected: true });
  });
});

describe('hover tooltips over a neighbouring card', () => {
  // Real 19:58:02Z read: the right card's tooltip covered the middle card; its title was read as
  // the middle card (offers "Metal Skin, Stamina Mastery, Stamina Mastery").
  const tooltipFrame = (): NativeOcrBlock[] => [
    block('SELECT ITEM:', 0.038, 0.182, 0.227, 0.052), block('CHOICE 3 OF 3', 0.039, 0.268, 0.101, 0.024),
    block('Metal Skin', 0.232, 0.674, 0.094, 0.032), block('Stamina Mastery', 0.393, 0.476, 0.136, 0.031),
    block('•2 Stamina', 0.392, 0.551, 0.047, 0.013), block('•18% Stamina Recovery', 0.392, 0.577, 0.098, 0.016),
    block('•23% Air Jump/Dash Distance', 0.392, 0.604, 0.121, 0.015), block('Passive', 0.397, 0.642, 0.031, 0.013),
    block('Allows an additional use of Air Jump or Air', 0.392, 0.670, 0.171, 0.016), block('Dash before landing.', 0.392, 0.693, 0.082, 0.015),
    block('UPGRADES FROM:', 0.396, 0.730, 0.057, 0.009), block('Stamina Mastery', 0.640, 0.678, 0.159, 0.039)];
  it('does not read a tooltip title as the covered card', () => {
    // The coordinator confirms the draft from a fresh title read; the tooltip hides Use Re-Roll here.
    const parsed = parseScreenOffers(tooltipFrame(), catalog, { draftConfirmed: true, conservativeUnmarkedDetails: true });
    expect(parsed.offers.filter(offer => offer.name === 'Stamina Mastery').length).toBeLessThanOrEqual(1);
    expect(parsed.offers.some(offer => offer.position === 1 && offer.itemId === 'upgrade_superior_stamina')).toBe(false);
    expect(parsed).toMatchObject({ isDraft: true, incomplete: true });
  });
  it('does not read an "UPGRADES FROM:" component as the covered card (real 17:31:01Z Warp Stone → Headshot Booster flip)', () => {
    const blocks = [block('SELECT ITEMS', 0.038, 0.182, 0.227, 0.052), block('CHOICE 2 OF 3', 0.039, 0.268, 0.101, 0.024),
      block('Radiant Regeneration', 0.2, 0.675, 0.16, 0.032), block('Headhunter', 0.66, 0.676, 0.11, 0.036),
      block('Headhunter', 0.55, 0.30, 0.10, 0.031), block('Passive', 0.552, 0.40, 0.031, 0.013),
      block('UPGRADES FROM:', 0.551, 0.52, 0.057, 0.009), block('Headshot Booster', 0.553, 0.535, 0.07, 0.012)];
    const parsed = parseScreenOffers(blocks, catalog, { draftConfirmed: true, conservativeUnmarkedDetails: true });
    expect(parsed.offers.some(offer => offer.itemId === 'upgrade_headshot_booster')).toBe(false);
    expect(parsed).toMatchObject({ isDraft: true, incomplete: true });
  });
  it('still reads the three real cards when no tooltip is open', () => {
    const parsed = parseScreenOffers(realDraft(['Blood Tribute', 'Torment Pulse', 'Surge of Power']), catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.offers.map(offer => offer.name)).toEqual(['Blood Tribute', 'Torment Pulse', 'Surge of Power']);
  });
});

describe('real misreads from the 2026-10-13/16 logs', () => {
  it('never takes a tooltip stat line ("•13% Spirit Lifesteal") as a card name', () => {
    // A tooltip over the middle card: its title is unread and its stat lines sit where a name could be.
    const blocks = frame().filter(entry => entry.text !== 'Bullet Lifesteal')
      .concat([block('•13%', 0.42, 0.42, 0.04), block('Spirit Lifesteal', 0.465, 0.42, 0.12), block('+8% Fire Rate', 0.42, 0.46, 0.14)]);
    const parsed = parseScreenOffers(blocks, catalog);
    expect(parsed.offers.map(offer => offer.itemId)).not.toContain('upgrade_health_stealing_magic');
    expect(parsed.offers[1]?.itemId).toBe('');
  });
  it('reads the reroll count when its "1" is read as a letter', () => {
    const swap = (label: string) => frame().map(entry => entry.text === '1 Re-Roll Remaining' ? { ...entry, text: label } : entry);
    for (const label of ['I Re-Roll Remaining', 'J Re-Roll Remaining', 'l Re-ROII Remaining']) expect(parseScreenOffers(swap(label), catalog).rerolls).toBe(1);
  });
  it('finds the three cards on an ultrawide 2560x1080 screen, where the panel stays centred', () => {
    const squeeze = (16 / 9) / (2560 / 1080);
    const wide = frame().map(entry => ({ ...entry, x: 0.5 + (entry.x - 0.5) * squeeze, width: entry.width * squeeze }));
    expect(parseScreenOffers(wide, catalog).offers.filter(offer => offer.itemId)).toHaveLength(0);
    expect(parseScreenOffers(wide, catalog, { aspect: 2560 / 1080 }).offers.map(offer => offer.name)).toEqual(itemNames);
  });
});

describe('2026-10-18 live draft reads', () => {
  it.each(['eoevus!', "eotVUS'", 'eoegus!', 'eo.VUS!'])('reads the real OCR form %s of the Bonus! label above the card name', text => {
    // 12:03:16Z Greater Expansion (with Sprint Boots) and 18:24:40Z Radiant Regeneration (with Healing Rite).
    const parsed = parseScreenOffers([...realDraft(), middleBonusLabel(text)], catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.offers[1]).toMatchObject({ name: 'Stamina Mastery', bonusExpected: true });
    expect(parsed.offers[0]?.bonusExpected).toBeUndefined();
  });
  it('does not take ordinary short words for the Bonus! label, nor a fuzzy form below the name', () => {
    for (const word of ['focus', 'venus', 'minus', 'bogus', 'genus', 'bonfire', 'eo', 'bus']) expect(isBonusLabel(normalizeOfferText(word))).toBe(word === 'bogus'); // 'bogus' is one edit from bonus; it never stands alone above a card
    const below = parseScreenOffers([...realDraft(), block('eoevus!', 0.428, 0.52, 0.031, 0.022)], catalog, { conservativeUnmarkedDetails: true });
    expect(below.offers[1]?.bonusExpected).toBeUndefined();
  });
  it('never reads the item after "UPGRADES TO :" in a hover tooltip as the covered card (12:03:10.881Z)', () => {
    // The left card's tooltip covers the middle card (Battle Vest); its component list is indented past the icon.
    const blocks = [block('SELECT ITEMS', 0.038, 0.182, 0.227, 0.052), block('CHOICE 1 OF 3', 0.039, 0.268, 0.101, 0.024),
      block('Weakening Headshot', 0.205, 0.676, 0.146, 0.033), block('Arcane Surge', 0.665, 0.676, 0.112, 0.033),
      block('Weakening Headshot', 0.392, 0.40, 0.14, 0.031), block('.60 Bonus Health', 0.392, 0.45, 0.07, 0.013), block('Passive', 0.397, 0.48, 0.031, 0.013),
      block('UPGRADES TO :', 0.396, 0.53, 0.06, 0.012), block('Cripping Headshot', 0.425, 0.547, 0.11, 0.032)];
    const parsed = parseScreenOffers(blocks, catalog, { draftConfirmed: true, conservativeUnmarkedDetails: true });
    expect(parsed.offers.some(offer => offer.itemId === 'upgrade_crippling_headshot' || /Crippling/.test(offer.name))).toBe(false);
    expect(parsed.offers.map(offer => offer.itemId ? offer.name : '')).toEqual(['Weakening Headshot', '', 'Arcane Surge']);
  });
  it('keeps the readable cards beside a tooltip that covers the middle one (match B 18:08:11Z)', () => {
    const blocks = [block('SELECT ITEMS', 0.038, 0.182, 0.227, 0.052), block('CHOICE 2 OF 3', 0.039, 0.268, 0.101, 0.024),
      block('Recharging Rush', 0.21, 0.676, 0.135, 0.033), block('Spirit Lifesteal', 0.66, 0.676, 0.125, 0.033),
      block('Recharging Rush', 0.392, 0.40, 0.13, 0.031), block('•20% Max Ammo', 0.392, 0.45, 0.07, 0.013),
      block('Passive', 0.397, 0.50, 0.031, 0.013), block('See Details', 0.392, 0.62, 0.05, 0.013)];
    const parsed = parseScreenOffers(blocks, catalog, { draftConfirmed: true, conservativeUnmarkedDetails: true });
    expect(parsed.offers.map(offer => offer.itemId ? offer.name : '')).toEqual(['Recharging Rush', '', 'Spirit Lifesteal']);
  });
  it('stays a draft while the next choice deals in with only "CHOICE 2 OF 3" readable (18:10:24.5Z)', () => {
    const parsed = parseScreenOffers([block('CHOICE 2 OF 3', 0.039, 0.268, 0.101, 0.024), block('.18', 0.3, 0.5, 0.02, 0.013)], catalog, { draftConfirmed: true });
    expect(parsed).toMatchObject({ isDraft: true, offers: [] });
    expect(parsed.message).not.toMatch(/no longer visible/);
  });
  it('finds the picked card that lingers while the next choice deals in (match B 18:10:27.8Z)', () => {
    const blocks = [block('SELECT', 0.038, 0.182, 0.1, 0.052), block('CHOICE 3 OF 3', 0.039, 0.268, 0.101, 0.024), block('Use Re-Roll', 0.462, 0.653, 0.074, 0.02),
      block('Spirit Resilience', 0.6, 0.5, 0.12, 0.03)];
    expect(draftChoiceStage(blocks)).toBe(3);
    expect(namedItems(blocks, catalog, ['upgrade_tech_purge', 'upgrade_bullet_armor_reduction_aura', 'upgrade_warp_stone'])).toEqual(['upgrade_tech_purge']);
    expect(namedItems(blocks, catalog, ['upgrade_warp_stone'])).toEqual([]);
  });
});

describe('2026-11-01 Linux draft misreads', () => {
  const withMiddle = (...middle: NativeOcrBlock[]) => observedSelectionFrame().filter(entry => entry.text !== 'Tesla Bullets').concat(middle);
  const middleName = (blocks: NativeOcrBlock[]) => parseScreenOffers(blocks, catalog).offers[1]?.name;

  it('matches the visible part of a middle card name whose ends the open scoreboard covers', () => {
    // The native reader marks each covered end with "…"; the scoreboard columns cover x<0.445 and x>0.554 here.
    expect(middleName(withMiddle(block('…thereal Shif…', 0.446, 0.429, 0.108, 0.04)))).toBe('Ethereal Shift');
    expect(middleName(withMiddle(block('…apid Rechart…', 0.446, 0.447, 0.108, 0.03)))).toBe('Rapid Recharge');
    expect(middleName(withMiddle(block('…ritual Querfl…', 0.446, 0.447, 0.108, 0.03)))).toBe('Spiritual Overflow');
    expect(middleName(withMiddle(block('Surge of Pow…', 0.47, 0.447, 0.084, 0.03)))).toBe('Surge of Power');
  });

  it('keeps a covered name unread when its visible part is unmarked, too short or fits several names', () => {
    expect(middleName(withMiddle(block('thereal Shif', 0.446, 0.429, 0.108, 0.04)))).toBe('Unread item choice');
    expect(middleName(withMiddle(block('…Headshot…', 0.46, 0.447, 0.08, 0.03)))).toBe('Unread item choice');
    expect(middleName(withMiddle(block('…Charge…', 0.47, 0.447, 0.06, 0.03)))).toBe('Unread item choice');
  });

  it('never joins a card name with smaller tooltip text beside it on the same row', () => {
    // A tooltip's "Damage Per Second  Radius" stat captions ended 0.044 left of the right card's name (real: Toxic Bullets).
    const blocks = observedSelectionFrame().filter(entry => entry.text !== 'Spiritual Ouerflow')
      .concat(block('Radius', 0.6, 0.685, 0.022, 0.01), block('Metal Skin', 0.666, 0.663, 0.1, 0.043));
    expect(parseScreenOffers(blocks, catalog).offers.map(offer => offer.name)).toEqual(['Toxic Bullets', 'Tesla Bullets', 'Metal Skin']);
  });

  it('reads the card font\'s O as Q and y or v as u', () => {
    expect(middleName(withMiddle(block('Spiritual Querflow', 0.42, 0.447, 0.16, 0.03)))).toBe('Spiritual Overflow');
    expect(middleName(withMiddle(block('Lucku Shot', 0.455, 0.447, 0.09, 0.03)))).toBe('Lucky Shot');
  });
});
