import { describe, expect, it } from 'vitest';
import catalogData from '../data/public-catalog.json';
import type { Catalog } from '../src/shared/types';
import type { NativeIconMatch, NativeOcrBlock } from '../src/shared/screen-reading';
import { detectDraftHint, normalizeOfferText, parseScreenOffers } from '../src/screen/offer-parser';

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
    expect(parsed.offers.every(offer => offer.variant === 'unknown' && offer.bonusIds === null)).toBe(true);
  });
  it('also reconstructs the actual individually bounded OCR heading words', () => {
    const blocks = observedSelectionFrame().filter(value => !['Toxic Bullets', 'Tesla Bullets', 'Spiritual Ouerflow'].includes(value.text));
    blocks.push(block('Toxic', 0.221111, 0.677866, 0.047222, 0.028656), block('Bullets', 0.272778, 0.676877, 0.062778, 0.02668),
      block('Tesla', 0.443889, 0.450593, 0.043889, 0.027668), block('Bullets', 0.493333, 0.447628, 0.062222, 0.027668),
      block('Spiritual', 0.638889, 0.678854, 0.077222, 0.034585), block('Ouerflow', 0.721667, 0.673913, 0.082778, 0.029644));
    expect(parseScreenOffers(blocks, catalog, { conservativeUnmarkedDetails: true }).offers.map(offer => offer.name))
      .toEqual(['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow']);
  });
  it('withholds a partially revealed actual frame with only two headings', () => {
    const blocks = observedSelectionFrame().filter(value => !['RARE!', 'Spiritual Ouerflow'].includes(value.text));
    expect(parseScreenOffers(blocks, catalog, { conservativeUnmarkedDetails: true })).toMatchObject({ isDraft: true, incomplete: true, offers: [] });
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
  it('withholds a partially revealed two-card frame', () => {
    const blocks = frame().filter(value => value.text !== 'Spirit Resilience' && !(value.text === 'Tier 2' && value.x > 0.6));
    expect(parseScreenOffers(blocks, catalog)).toMatchObject({ isDraft: true, incomplete: true, offers: [], signature: null });
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
  it('keeps unmarked real-capture details unknown while preserving readable main cards', () => {
    const parsed = parseScreenOffers(frame(), catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.offers.map(offer => offer.name)).toEqual(itemNames);
    expect(parsed.offers.every(offer => offer.itemId && offer.variant === 'unknown' && offer.bonusIds === null)).toBe(true);
    expect(parsed.offers[0]?.warning).toMatch(/modifier.*unconfirmed/);
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
    expect(parsed.offers[1]).toMatchObject({ variant: 'unknown', bonusIds: null });
  });
  it('retains explicitly named bonus quantities even when no standalone marker was read', () => {
    const parsed = parseScreenOffers(frame(['Leech + Extra Spirit + Extra Regen', 'Bullet Lifesteal', 'Spirit Resilience']), catalog, { conservativeUnmarkedDetails: true });
    expect(parsed.offers[0]).toMatchObject({ variant: 'unknown', bonusIds: ['upgrade_improved_spirit', 'upgrade_endurance'] });
  });
  it('does not use unmarked native extras to enlarge an explicitly named real-capture bundle', () => {
    const parsed = parseScreenOffers(frame(['Leech + Extra Spirit', 'Bullet Lifesteal', 'Spirit Resilience']), catalog,
      { conservativeUnmarkedDetails: true, iconMatches: [bonusIcon(0), bonusIcon(0, 1)] });
    expect(parsed.offers[0]?.bonusIds).toBeNull();
  });
  it('keeps Rare roll rarity insufficient to certify no modifiers or no bonus', () => {
    expect(parseScreenOffers([...frame(), marker('Rare!')], catalog, { conservativeUnmarkedDetails: true }).offers[0])
      .toMatchObject({ variant: 'unknown', bonusIds: null });
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
