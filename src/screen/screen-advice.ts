import type { Catalog, CatalogHero, CatalogItem } from '../shared/types';
import type { ScreenAdvice, ScreenMatchContext, ScreenOffer } from '../shared/screen-reading';
import { evaluateContextOffers } from './context-advice';
import { bestOfThree, draftPool, enhancedOfferRate, enhancedPoints, poolMean, poolPercentile, rerollPlan, streetBrawlFit, WIN_RATE_WEIGHT,
  type BestOfThree, type PoolCard } from './street-brawl-fit';
import { CHOICE_TIERS, draftTierOf } from '../shared/draft-tiers';
import { streetBrawlData } from './street-brawl-data';
import { imbueTarget } from './imbue-advice';
import { absorbedComponents } from './item-bundles';
import { CLOSE_CALL_MARGIN, holdShownPick, type ShownPick } from './pick-hold';

export interface ScreenOfferContext {
  heroId: string | null; round: number | null; rerolls: number | null;
  /** Which of the round's three choices is on screen ("Choice N of 3"), 1-3; the reroll expires after choice 3. */
  choice?: number | null;
  /** Enemy heroes identified in this match; their Street Brawl counter data is applied. */
  enemyHeroIds?: readonly string[];
  /** Items read in your own inventory this match. */
  ownedItemIds?: readonly string[];
  /** Items read on the enemy team's scoreboard rows this match. */
  enemyItemIds?: readonly string[];
  matchContext?: ScreenMatchContext;
  now?: number;
  /** The cards and pick already shown for this draft: the pick stays unless another card clearly beats it (pick-hold.ts). */
  shownPick?: ShownPick | null;
  /** The most active items (a button to press) the player wants to own, 0-4; 4 or unset is no limit (the game allows four). */
  maxActiveItems?: number;
}
/** One advised card. Besides the shared fields, two Street Brawl numbers for the interface. */
export type AdvisedOffer = ScreenAdvice['ranked'][number] & {
  /** Card value minus the average card of its tier pool for this hero and enemies, in win-rate percentage points. */
  edge?: number;
  /** 0-100: where the card ranks in its tier pool for this hero and enemies (by how often each card is drawn). */
  tierPercentile?: number;
};
export interface StreetBrawlAdvice extends ScreenAdvice { ranked: AdvisedOffer[] }
type Direction = 'weapon' | 'spirit' | 'melee';
type FixedStat = 'health' | 'spiritPower' | 'weaponPower' | 'fireRate' | 'bulletResist' | 'spiritResist' | 'regen' | 'bulletLifesteal' | 'spiritLifesteal' | 'statusResist';
interface BaseFacts { fixed: Partial<Record<FixedStat, number>>; traits: string[]; active: boolean }
interface ItemProfile {
  item: CatalogItem; directions: Direction[]; facts: BaseFacts | null;
  traits: Set<string>; condition: string | null; points: number; notes: string[];
}
interface OfferComparison { offer: ScreenOffer; main: ItemProfile | null; profiles: ItemProfile[]; score: number; reasons: string[]; problems: string[] }

const READ_QUALITY_MINIMUM = 0.85;
/** The game lets a player carry four active items, so a preference of four is no limit. */
const ACTIVE_ITEM_SLOTS = 4;
const PINNED_CLIENT = '6861';
const PINNED_REVISION = '11219368';
/**
 * Extracted from the saved client-6861 Valve-asset snapshot (items SHA-256
 * ed77a501256bee9cdd862948ea736e89afad62392461bc3a978dc9d0bbc7a4f4).
 * Only positive own innate allowlisted properties, without upgrade requirements,
 * negative attributes, or conditional flags are retained. Fixed amounts also
 * exclude scaling functions. Explicit Street Brawl values override normal ones.
 * This small local table is read once, never fetched or parsed in the capture loop.
 */
const PINNED_BASE_FACTS: Record<string, BaseFacts> = {
  "upgrade_ability_power_shard": {"fixed":{"spiritResist":5,"bulletResist":5},"traits":["bullet-resist","spirit-resist"],"active":true},
  "upgrade_ability_refresher": {"fixed":{},"traits":[],"active":true},
  "upgrade_absorbing_armor": {"fixed":{"spiritPower":14,"spiritResist":22},"traits":["spirit","spirit-resist"],"active":false},
  "upgrade_aoe_root": {"fixed":{},"traits":[],"active":true},
  "upgrade_arctic_blast": {"fixed":{"spiritResist":10},"traits":["spirit-resist"],"active":true},
  "upgrade_auto_cleanse": {"fixed":{"bulletResist":10,"spiritResist":10},"traits":["bullet-resist","spirit-resist"],"active":false},
  "upgrade_banshee_slugs": {"fixed":{"health":125},"traits":["health"],"active":false},
  "upgrade_berserker": {"fixed":{"bulletResist":8},"traits":["bullet-resist"],"active":false},
  "upgrade_blitz_bullets": {"fixed":{"fireRate":20},"traits":["weapon"],"active":false},
  "upgrade_blood_tribute": {"fixed":{"spiritResist":8,"statusResist":8},"traits":["control-resist","spirit-resist"],"active":true},
  "upgrade_boundless_spirit": {"fixed":{"spiritPower":30,"health":75},"traits":["health","spirit"],"active":false},
  "upgrade_boxing_glove": {"fixed":{"health":125},"traits":["health"],"active":false},
  "upgrade_bullet_armor_reduction_aura": {"fixed":{"health":100},"traits":["health"],"active":false},
  "upgrade_burst_fire": {"fixed":{"fireRate":10},"traits":["weapon"],"active":false},
  "upgrade_capacitor": {"fixed":{"fireRate":5},"traits":["weapon"],"active":true},
  "upgrade_celestial_guidance": {"fixed":{},"traits":[],"active":true},
  "upgrade_cheat_death": {"fixed":{"health":200},"traits":["health"],"active":false},
  "upgrade_chonky": {"fixed":{"health":375},"traits":["health"],"active":false},
  "upgrade_cloaking_device_active": {"fixed":{},"traits":[],"active":true},
  "upgrade_close_quarter_combat": {"fixed":{"health":75},"traits":["health"],"active":false},
  "upgrade_cold_front": {"fixed":{"spiritResist":6},"traits":["spirit-resist"],"active":true},
  "upgrade_colossus": {"fixed":{},"traits":[],"active":true},
  "upgrade_containment": {"fixed":{},"traits":[],"active":true},
  "upgrade_counterspell": {"fixed":{"health":50,"spiritPower":5},"traits":["health","spirit"],"active":false},
  "upgrade_crackshot": {"fixed":{"spiritPower":7},"traits":["spirit"],"active":false},
  "upgrade_crushing_fists": {"fixed":{"bulletResist":12},"traits":["bullet-resist"],"active":false},
  "upgrade_damage_recycler": {"fixed":{"spiritPower":12,"health":180},"traits":["bullet-lifesteal","health","spirit","spirit-lifesteal"],"active":false},
  "upgrade_debuff_reducer": {"fixed":{"health":90},"traits":["health"],"active":false},
  "upgrade_deflecting_armor": {"fixed":{"health":130},"traits":["health"],"active":false},
  "upgrade_discord": {"fixed":{"health":100},"traits":["health"],"active":true},
  "upgrade_divine_barrier": {"fixed":{},"traits":[],"active":true},
  "upgrade_dps_aura": {"fixed":{},"traits":[],"active":true},
  "upgrade_endurance": {"fixed":{"regen":2.5},"traits":["healing"],"active":false},
  "upgrade_escalating_exposure": {"fixed":{"spiritResist":17},"traits":["spirit-resist"],"active":false},
  "upgrade_ethereal_bullets": {"fixed":{"spiritPower":7},"traits":["spirit"],"active":false},
  "upgrade_extra_charge": {"fixed":{"spiritPower":7},"traits":["spirit"],"active":false},
  "upgrade_fervor": {"fixed":{"health":160,"fireRate":15},"traits":["bullet-lifesteal","health","weapon"],"active":false},
  "upgrade_fleetfoot_boots": {"fixed":{},"traits":[],"active":true},
  "upgrade_focus_lens": {"fixed":{"fireRate":10},"traits":["weapon"],"active":true},
  "upgrade_fury_trance": {"fixed":{"health":100},"traits":["bullet-lifesteal","health"],"active":true},
  "upgrade_glitch": {"fixed":{},"traits":[],"active":true},
  "upgrade_goose_egg": {"fixed":{},"traits":[],"active":true},
  "upgrade_greater_withering_whip": {"fixed":{"health":75},"traits":["health"],"active":true},
  "upgrade_grit": {"fixed":{},"traits":[],"active":true},
  "upgrade_guardian_ward": {"fixed":{},"traits":[],"active":true},
  "upgrade_headhunter": {"fixed":{"health":50},"traits":["health"],"active":false},
  "upgrade_headshot_booster": {"fixed":{"health":30},"traits":["health"],"active":false},
  "upgrade_headshot_booster2": {"fixed":{"health":60},"traits":["health"],"active":false},
  "upgrade_healbane": {"fixed":{"spiritPower":7},"traits":["spirit"],"active":false},
  "upgrade_healbuff": {"fixed":{"spiritResist":10,"regen":6},"traits":["healing","spirit-resist"],"active":false},
  "upgrade_health": {"fixed":{"health":210},"traits":["health"],"active":false},
  "upgrade_health_nova": {"fixed":{"spiritPower":8},"traits":["spirit"],"active":true},
  "upgrade_health_stealing_magic": {"fixed":{"spiritPower":8,"health":90},"traits":["health","spirit","spirit-lifesteal"],"active":false},
  "upgrade_health_stimpak": {"fixed":{},"traits":[],"active":true},
  "upgrade_hollow_point_rounds": {"fixed":{"health":125},"traits":["health"],"active":false},
  "upgrade_improved_spirit": {"fixed":{"spiritPower":10},"traits":["spirit"],"active":false},
  "upgrade_infinite_rounds": {"fixed":{"fireRate":35},"traits":["weapon"],"active":false},
  "upgrade_infuser": {"fixed":{"spiritPower":8,"health":100},"traits":["health","spirit","spirit-lifesteal"],"active":true},
  "upgrade_inhibitor": {"fixed":{"health":150},"traits":["health"],"active":false},
  "upgrade_juggernaut": {"fixed":{"regen":15},"traits":["healing"],"active":false},
  "upgrade_magic_carpet": {"fixed":{"spiritPower":14,"health":125},"traits":["health","spirit"],"active":true},
  "upgrade_magic_shield": {"fixed":{"spiritResist":18},"traits":["spirit-resist"],"active":false},
  "upgrade_magic_shock": {"fixed":{"health":50},"traits":["health"],"active":false},
  "upgrade_magic_slow": {"fixed":{"health":50},"traits":["health"],"active":false},
  "upgrade_melee_charge": {"fixed":{"bulletResist":6},"traits":["bullet-resist"],"active":false},
  "upgrade_melee_rebuttal": {"fixed":{"health":75},"traits":["health"],"active":false},
  "upgrade_metal_skin": {"fixed":{"bulletResist":12},"traits":["bullet-resist"],"active":true},
  "upgrade_mystic_regeneration": {"fixed":{"health":50},"traits":["health"],"active":false},
  "upgrade_mystical_piano": {"fixed":{},"traits":[],"active":true},
  "upgrade_non_player_bonus_sacrifice": {"fixed":{},"traits":[],"active":true},
  "upgrade_nullification_aura": {"fixed":{"health":300,"statusResist":40},"traits":["control-resist","health"],"active":true},
  "upgrade_omnicharge_pendant": {"fixed":{"spiritPower":50},"traits":["spirit"],"active":false},
  "upgrade_phantom_strike": {"fixed":{"spiritPower":8},"traits":["spirit"],"active":true},
  "upgrade_prism_blast": {"fixed":{},"traits":[],"active":true},
  "upgrade_pristine_emblem": {"fixed":{"spiritPower":7},"traits":["spirit"],"active":false},
  "upgrade_rapid_recharge": {"fixed":{"spiritPower":14},"traits":["spirit"],"active":false},
  "upgrade_rapid_rounds": {"fixed":{"fireRate":9},"traits":["weapon"],"active":false},
  "upgrade_reduce_debuff_duration": {"fixed":{},"traits":[],"active":true},
  "upgrade_regenerating_bullet_shield": {"fixed":{"bulletResist":18},"traits":["bullet-resist"],"active":false},
  "upgrade_reinforcing_casings": {"fixed":{"health":75},"traits":["health"],"active":false},
  "upgrade_rescue_beam": {"fixed":{},"traits":[],"active":true},
  "upgrade_resonant_healing": {"fixed":{"health":90},"traits":["health"],"active":false},
  "upgrade_restorative_locket": {"fixed":{"spiritResist":8},"traits":["spirit-resist"],"active":true},
  "upgrade_return_fire": {"fixed":{"bulletResist":10},"traits":["bullet-resist"],"active":true},
  "upgrade_ricochet": {"fixed":{"fireRate":18},"traits":["weapon"],"active":false},
  "upgrade_rocket_booster": {"fixed":{},"traits":[],"active":true},
  "upgrade_rupture": {"fixed":{"spiritPower":8,"health":65},"traits":["health","spirit"],"active":true},
  "upgrade_self_bubble": {"fixed":{},"traits":[],"active":true},
  "upgrade_shadow_strike": {"fixed":{"health":350},"traits":["health"],"active":false},
  "upgrade_shrink_ray": {"fixed":{},"traits":[],"active":true},
  "upgrade_soaring_spirit": {"fixed":{"spiritPower":18},"traits":["spirit"],"active":false},
  "upgrade_spellbreaker": {"fixed":{"spiritResist":18,"statusResist":25,"health":90},"traits":["control-resist","health","spirit-resist"],"active":false},
  "upgrade_spellslinger_headshots": {"fixed":{"health":75},"traits":["health"],"active":false},
  "upgrade_spirit_sap": {"fixed":{"health":50},"traits":["health"],"active":true},
  "upgrade_spirit_snatch": {"fixed":{"health":75},"traits":["health"],"active":false},
  "upgrade_split_shot": {"fixed":{},"traits":[],"active":true},
  "upgrade_suppressor": {"fixed":{"spiritPower":6,"bulletResist":8},"traits":["bullet-resist","spirit"],"active":false},
  "upgrade_surging_power": {"fixed":{"health":100},"traits":["bullet-lifesteal","health"],"active":true},
  "upgrade_target_stun": {"fixed":{"health":75},"traits":["health"],"active":true},
  "upgrade_targeted_silence": {"fixed":{"health":90},"traits":["health"],"active":true},
  "upgrade_tech_damage_pulse": {"fixed":{"health":100},"traits":["health"],"active":false},
  "upgrade_tech_overflow": {"fixed":{"spiritPower":8,"health":90},"traits":["health","spirit","spirit-lifesteal"],"active":false},
  "upgrade_thermal_detonator": {"fixed":{"spiritPower":10},"traits":["spirit"],"active":true},
  "upgrade_ultimate_burst": {"fixed":{"health":50},"traits":["health"],"active":false},
  "upgrade_unstable_concoction": {"fixed":{},"traits":[],"active":true},
  "upgrade_unstoppable": {"fixed":{"health":125,"statusResist":25},"traits":["control-resist","health"],"active":true},
  "upgrade_vampire": {"fixed":{"health":90},"traits":["bullet-lifesteal","health"],"active":false},
  "upgrade_veil_walker": {"fixed":{"health":125,"spiritPower":6},"traits":["health","spirit"],"active":false},
  "upgrade_warp_stone": {"fixed":{},"traits":[],"active":true},
  "upgrade_weapon_backstabber": {"fixed":{"health":50},"traits":["health"],"active":false},
  "upgrade_weighted_shots": {"fixed":{"statusResist":22},"traits":["control-resist"],"active":false},
  "upgrade_withering_whip": {"fixed":{"health":60},"traits":["health"],"active":true},
};

/**
 * A separate, openly limited visible-offer comparison. It neither authorizes the
 * legacy live model nor consumes invented inventories, ability ranks or enemies.
 * Points express general utility and an observed hero's broad damage direction;
 * they are not measured marginal value, win odds, or a complete-match optimum.
 */
export function evaluateScreenOffers(liveOffers: ScreenOffer[], catalog: Catalog, context: ScreenOfferContext): StreetBrawlAdvice | null {
  if (liveOffers.length === 0) return null;
  // Once a card of this draft is taken it counts as owned while the cards are still shown;
  // the advice keeps the draft as it was before the pick instead of jumping to another card.
  const { offers, ownedItemIds } = stableDraft(liveOffers, context);
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const contextual = context.matchContext ? evaluateContextOffers(offers, catalog, context.matchContext, context.now ?? Date.now()) : null;
  // An unverified match context has no hero of its own; fall back to the hero we were given.
  const heroId = contextual?.heroId ?? context.heroId;
  const hero = heroId === null ? null : catalog.heroes.find(candidate => candidate.id === heroId) ?? null;
  const usePinnedFacts = catalog.clientVersion === PINNED_CLIENT && catalog.revision === PINNED_REVISION;
  const comparisons = offers.map(offer => compareOffer(offer, items, hero, usePinnedFacts));
  /** Offer-only heuristic score of each card, kept before an observed-context score replaces it (anchors card values to the tier pool). */
  const offerOnlyScores = comparisons.map(comparison => comparison.score);
  if (contextual?.hasContext) for (const comparison of comparisons) {
    const actual = contextual.ranked.find(entry => entry.position === comparison.offer.position);
    if (actual) { comparison.score = actual.score; comparison.reasons = actual.reasons; }
  }
  const positions = offers.map(offer => offer.position);
  const shapeComplete = positions.length === 3 && new Set(positions).size === 3 && [0, 1, 2].every(position => positions.includes(position));
  const ambiguousCatalog = items.size !== catalog.items.length;
  const problems = comparisons.flatMap(comparison => comparison.problems);
  if (contextual?.hasContext) problems.push(...contextual.materialProblems);
  if (context.matchContext && !contextual?.hasContext) problems.push('Own build and team context are unverified; only an offer-only base comparison is available.');
  if (!usePinnedFacts) problems.push('The current catalogue build does not match the supported base mechanics.');
  if (!shapeComplete) problems.unshift('All three distinct offer positions have not been identified.');
  if (ambiguousCatalog) problems.unshift('The catalogue contains ambiguous item identifiers.');
  const understood = comparisons.filter(comparison => comparison.main !== null);
  const ordered = [...understood].sort((left, right) => right.score - left.score || left.offer.position - right.offer.position);
  const best = ordered[0];
  const alternative = ordered[1];
  const unclearValue = !!best && !!alternative && best.score - alternative.score < 0.25;
  const preferredPosition = problems.length === 0 && best && !unclearValue ? best.offer.position : null;
  const reliableMainNames = shapeComplete && !ambiguousCatalog && offers.every(offer => items.has(offer.itemId)
    && Number.isFinite(offer.confidence) && offer.confidence >= READ_QUALITY_MINIMUM && offer.confidence <= 1);
  // An unread bonus/variant is material to the full card. A separate
  // main-item comparison gives useful conditional guidance without pretending
  // to know that bundle or mixing known bonuses from only some cards.
  const baseOffers = preferredPosition === null && problems.length > 0 && reliableMainNames
    ? offers.map(offer => ({ ...offer, bonusIds: [], variant: 'base' as const, warning: null })) : null;
  const baseComparison = baseOffers && contextual?.hasContext && context.matchContext
    ? evaluateContextOffers(baseOffers, catalog, context.matchContext, context.now ?? Date.now()) : null;
  const offerOnlyBase = baseOffers && !contextual?.hasContext && usePinnedFacts
    && context.matchContext?.viewMode !== 'spectator' && context.matchContext?.phase !== 'finished'
    ? baseOffers.map(offer => compareOffer(offer, items, hero, true)) : null;
  const baseRanked = baseComparison?.ranked ?? offerOnlyBase?.map(comparison => ({ position: comparison.offer.position,
    score: comparison.score, reasons: comparison.reasons })) ?? [];
  const baseOrder = [...baseRanked].sort((a, b) => b.score - a.score || a.position - b.position);
  const baseBest = baseOrder[0], baseOther = baseOrder[1];
  const hasGroundedFacts = baseComparison?.factsUsed.some(fact => ['own', 'ally', 'enemy'].includes(fact.scope));
  const hasComparisonBasis = baseComparison ? hasGroundedFacts && baseComparison.materialProblems.length === 0 : offerOnlyBase !== null;
  const comparisonPosition = baseBest && baseOther && hasComparisonBasis && baseBest.score > 0 && baseBest.score - baseOther.score >= 0.25
    ? baseBest.position : null;
  const unreadEffects = offers.some(offer => offer.variant !== 'base' || offer.bonusIds === null
    || offer.bonusIds.some(id => !items.has(id)) || !!offer.warning?.trim());
  const excludedBonuses = offers.some(offer => !!offer.bonusIds?.length);
  const limitations = [
    contextual?.hasContext ? 'Observed-context heuristic: relative comparison points, not win odds or a complete-match optimum.'
      : 'Visible-offer heuristic: relative comparison points, not win odds or a complete-match recommendation.',
    ...(contextual ? contextual.limitations : ['Current loadout, stacking rules, ability investment, teammate items and enemy needs are not read by this comparison.']),
    `Base catalogue build ${catalog.clientVersion}; installed-game compatibility and unshown modifier effects are not confirmed.`,
    'Recognition quality is a matching signal, not a calibrated probability of a correct read.',
  ];
  if (!hero && !contextual?.hasContext) limitations.push('Hero not identified: the comparison favors broadly usable damage, sustain, protection and control.');
  if (context.round === null) limitations.push('Round not identified; remaining picks, deadline and future-round value are not estimated.');
  else limitations.push(`Round ${context.round} was read; this comparison values immediate effects and does not infer future resources.`);
  if (problems.length) limitations.push(...new Set(problems));
  if (comparisonPosition !== null) limitations.push('Main-item base effects only: every bonus and special modifier is excluded from this provisional comparison.'
    + (unreadEffects ? ' Unread effects may change the order.' : excludedBonuses ? ' Excluded bonuses may change the order.' : ' Build and team context may change the choice.'));

  // Always name the best readable card. Unread bonuses and unverified context are
  // shown as the caveat; withholding a pick left the player with no guidance at all.
  // Real Street Brawl evidence (hero win rate, Valve's per-hero Good bucket, genuine
  // counters to the identified enemies) is added to every card, whichever comparison
  // produced its base score. Reasons are short statements about the card itself.
  const baseScores = comparisonPosition !== null ? baseRanked
    : comparisons.map(comparison => ({ position: comparison.offer.position, score: comparison.score, reasons: comparison.reasons }));
  const contextScored = comparisonPosition !== null ? !!baseComparison : !!contextual?.hasContext;
  const enemyHeroIds = context.enemyHeroIds ?? [];
  const owned = new Set(ownedItemIds);
  // The owned items, for how each card wins beside them (measured item pairs).
  const ownedIds = [...owned];
  const draftTier = draftTierOf(offers.map(offer => ({ tier: items.get(offer.itemId)?.tier, rare: offer.rare })));
  const pools = heroId && streetBrawlData().heroes[heroId] ? draftPools(heroId, hero, usePinnedFacts, enemyHeroIds, owned, context, items, bonusMechanicsFor(items, hero, usePinnedFacts)) : null;
  const slotPool = draftTier === null ? null : pools?.(draftTier) ?? null;
  const slotMean = slotPool ? poolMean(slotPool) : null;
  // Measured Street Brawl results lead; the offer-only heuristic only breaks ties, while
  // scores from the observed match (own build, enemy kits) keep their full weight.
  const weight = contextScored ? CONTEXT_WEIGHT : HEURISTIC_WEIGHT;
  /**
   * Card value: the pick score without the tier points every card of the draft shares, so the
   * recommended card always has the highest value, edge and tierPercentile among the shown cards.
   * The tier pool can only be scored with the offer-only heuristic (see draftPools), so the
   * comparison term (observed-context or base-effects score) is moved by one constant per draft —
   * the shown cards' average offer-only term minus their average comparison term. That keeps the
   * order among the shown cards and puts their level on the pool's scale.
   */
  const judged = baseScores.map((entry, index) => {
    const offer = offers[index];
    return offer && items.has(offer.itemId) ? { term: weight * entry.score, offerOnly: HEURISTIC_WEIGHT * (offerOnlyScores[index] ?? 0) } : null;
  }).filter((entry): entry is { term: number; offerOnly: number } => entry !== null);
  const anchor = judged.length ? judged.reduce((sum, entry) => sum + entry.offerOnly - entry.term, 0) / judged.length : 0;
  const bonusMechanics = bonusMechanicsFor(items, hero, usePinnedFacts);
  const cardValues = new Map<number, number>();
  const ranked: AdvisedOffer[] = baseScores.map((entry, index) => {
    const offer = offers[index];
    if (!offer || !items.has(offer.itemId)) return entry;
    const item = items.get(offer.itemId)!;
    const fit = streetBrawlFit(offer.itemId, heroId, enemyHeroIds, ownedIds);
    const build = buildFit(item, context, items);
    // A "Bonus!" card gives a second, free item; an Enhanced card is the same item with extra stats.
    const bonus = bonusValue(offer, items, bonusMechanics);
    const enhanced = offer.variant === 'enhanced';
    const enhancedExtra = enhanced ? enhancedPoints(offer.itemId) : 0;
    const extra = build.points + bonus.points + enhancedExtra;
    // A RARE card sits above the draft's tier: real extra power over the other cards.
    const aboveTier = draftTier !== null && item.tier !== null && Number.isFinite(item.tier) ? Math.max(0, item.tier - draftTier) : 0;
    const value = weight * entry.score + anchor + fit.points + extra + aboveTier * TIER_POINTS;
    cardValues.set(index, value);
    const standing = slotPool && slotMean !== null ? {
      edge: Math.round((value - slotMean) / WIN_RATE_WEIGHT * 1_000) / 10,
      tierPercentile: Math.round(poolPercentile(value, slotPool)),
    } : {};
    const imbue = imbueTarget(offer.itemId, heroId);
    const [lead, ...support] = [...fit.reasons, ...bonus.reasons, ...build.reasons,
      ...(enhanced ? [enhancedLine(offer.itemId, enhancedExtra)] : []), ...confidentReasons(entry.reasons)];
    // The strongest evidence leads; a real weakness follows straight after it, ahead of supporting detail.
    const reasons = [...new Set([...(lead ? [lead] : []), ...fit.concerns, ...(imbue ? [`Imbue it on ${imbue.ability}: ${imbue.reason}.`] : []), ...support])];
    return { position: entry.position, score: roundPoints(weight * entry.score + fit.points + extra + tierPoints(item)), reasons, ...standing };
  });
  // ranked follows the offers array order, so each entry keeps its own offer even
  // when OCR reports two cards at one position.
  const resolved = ranked.map((entry, index) => ({ ...entry, offer: offers[index]! }))
    .filter(entry => items.has(entry.offer.itemId)).sort((a, b) => b.score - a.score || a.position - b.position);
  // A draft never offers an item you already own, so such a card is a likely misread: it is
  // kept in the ranking but does not become the pick while another card is readable.
  const misread = resolved.filter(entry => owned.has(entry.offer.itemId));
  for (const entry of misread) {
    limitations.push(`Offer ${entry.position + 1}: ${items.get(entry.offer.itemId)!.name} is already owned; a draft does not offer owned items, so this read is treated as a likely misread.`);
  }
  const trusted = resolved.filter(entry => !owned.has(entry.offer.itemId));
  // Once the player owns as many active items as they want, an active card does not become the pick while a
  // trusted card without a button is on offer. Like a misread it keeps its score and place in the ranking.
  // Only the main item counts: a Bonus! card's free item is valued apart from it (bonusValue) and is often unread.
  const activeOwned = [...owned].filter(id => isActiveItem(id, usePinnedFacts)).length;
  const limit = context.maxActiveItems;
  const limitReached = limit !== undefined && Number.isFinite(limit) && limit < ACTIVE_ITEM_SLOTS && activeOwned >= limit;
  const isActiveCard = (entry: { offer: ScreenOffer }) => isActiveItem(entry.offer.itemId, usePinnedFacts);
  const withoutButton = limitReached ? trusted.filter(entry => !isActiveCard(entry)) : trusted;
  const skippedActive = limitReached && withoutButton.length ? trusted.filter(isActiveCard) : [];
  const pickOrder = withoutButton.length ? withoutButton : trusted.length ? trusted : resolved;
  const allActive = limitReached && trusted.length > 0 && withoutButton.length === 0;
  // Cards are only read while a draft is visible, which only a player in the match sees; an ended match has no pick.
  const ownView = context.matchContext?.phase !== 'finished';
  // While the same cards stay on screen, the pick already shown stays unless another card clearly beats it.
  const hold = ownView ? holdShownPick(pickOrder, liveOffers, context.shownPick) : null;
  const pickEntry = hold?.pick;
  const pick = pickEntry?.position ?? null;
  const pickName = pickEntry ? items.get(pickEntry.offer.itemId)?.name ?? null : null;
  const challengerName = hold?.challenger ? items.get(hold.challenger.offer.itemId)?.name ?? null : null;
  const margin = pickEntry && pickOrder.length > 1 ? pickEntry.score - Math.max(...pickOrder.filter(entry => entry !== pickEntry).map(entry => entry.score)) : null;
  const closeCall = hold?.kept === 'close' || hold?.kept !== 'unconfirmed' && margin !== null && margin < CLOSE_CALL_MARGIN;
  const keptLine = !pickName || !challengerName ? null
    : hold?.kept === 'close' ? `Close call: ${pickName} and ${challengerName} are about even; the pick stays on ${pickName}.`
    : hold?.kept === 'unconfirmed' ? `${challengerName} only leads on a read with unconfirmed card details; the pick stays on ${pickName}.` : null;
  // Name the card the limit passed over when it outscores the pick.
  const passed = pickEntry ? skippedActive.find(entry => entry.score > pickEntry.score) : undefined;
  const limitLine = passed && pickEntry ? `${items.get(passed.offer.itemId)!.name} is passed over: an active item, and you already own ${activeOwned} (you want at most ${limit}).`
    : allActive && pickEntry ? `Every readable card is an active item and you already own ${activeOwned} (you want at most ${limit}); this is the best of them.` : null;
  const reasons = !best ? ['No offered item can be resolved to the local catalogue.', 'Read the item names and complete bonus/modifier details before comparing choices.']
    : !pickEntry ? ['The match has ended; there is no pick to make.']
    : [...(limitLine ? [limitLine] : []), ...(keptLine ? [keptLine] : closeCall && pickName ? [`Close call: ${pickName} edges out the alternatives.`] : []), ...pickEntry.reasons];
  // The reroll call compares the whole draft with what this tier usually offers, so it needs
  // three distinct resolved cards, none of them a likely misread.
  const fullDraft = shapeComplete && offers.length === 3 && resolved.length === 3 && misread.length === 0;
  // The reroll call weighs the card you would take against what a fresh draft is worth, on the same scale.
  const pickValue = pickEntry ? cardValues.get(offers.indexOf(pickEntry.offer)) ?? null : null;
  const reroll = rerollDecision({
    rerolls: context.rerolls, choice: context.choice ?? null, round: context.round, pools: pickEntry ? pools : null,
    heroName: heroId ? streetBrawlData().heroes[heroId]?.name ?? hero?.name ?? null : null, tier: draftTier,
    currentValue: fullDraft && cardValues.size === 3 ? pickValue : null,
  });
  const weakName = offers.some(offer => !items.has(offer.itemId) || !(offer.confidence >= READ_QUALITY_MINIMUM));
  const unidentifiedBonus = offers.some(offer => offer.bonusExpected && offer.bonusIds === null);
  const caveat = unidentifiedBonus ? 'A Bonus! card\'s free item was not read; check it in game.'
    : unreadEffects ? 'Bonuses or special effects on the cards were not read; check them in game.'
    : weakName ? 'One card name was not read clearly; check it in game.' : null;
  return {
    preferredPosition: pick,
    // Until all three cards are read (and none is a likely misread), the unread card may still beat the pick.
    title: pickName === null ? 'Compare the readable cards' : reroll.suggest ? `Reroll — or take ${pickName}`
      : !fullDraft ? `Best so far: ${pickName}` : closeCall ? `Slight edge: ${pickName}` : `Pick ${pickName}`,
    reasons, limitations,
    // Preserve the original game positions and array order, including unknown cards.
    ranked,
    rerollReason: reroll.reason,
    rerollSuggested: reroll.suggest,
    ...(() => {
      const imbue = pickEntry ? imbueTarget(pickEntry.offer.itemId, heroId) : null;
      return imbue ? { imbue: `Imbue it on ${imbue.ability} (${imbue.reason}).` } : {};
    })(),
    ...(caveat ? { caveat } : {}),
    ...(comparisonPosition !== null ? { factsUsed: baseComparison?.factsUsed ?? [] } : contextual ? { factsUsed: contextual.factsUsed } : {}),
    ...(comparisonPosition === null ? {} : { comparisonPosition, comparisonBasis: 'main-item-base-effects' as const }),
  };
}

function compareOffer(offer: ScreenOffer, items: Map<string, CatalogItem>, hero: CatalogHero | null, usePinnedFacts: boolean): OfferComparison {
  const problems: string[] = [];
  const item = items.get(offer.itemId);
  if (!item) problems.push(`Offer ${offer.position + 1}: item identity is unresolved.`);
  if (offer.variant !== 'base') problems.push(`Offer ${offer.position + 1}: ${offer.variant} effects are not fully read; only base effects can be compared.`);
  if (!Number.isFinite(offer.confidence) || offer.confidence < READ_QUALITY_MINIMUM || offer.confidence > 1) {
    problems.push(`Offer ${offer.position + 1}: the name match needs confirmation.`);
  }
  if (offer.warning?.trim()) problems.push(`Offer ${offer.position + 1}: ${offer.warning.trim()}`);
  if (offer.bonusIds === null) problems.push(`Offer ${offer.position + 1}: bonus coverage is unread.`);
  const bonusIds = offer.bonusIds ?? [];
  for (const id of bonusIds) if (!items.has(id)) problems.push(`Offer ${offer.position + 1}: a bonus item is unidentified.`);
  const profiles = [item, ...bonusIds.map(id => items.get(id))].filter((entry): entry is CatalogItem => !!entry)
    .map(entry => profileItem(entry, hero, usePinnedFacts));
  const main = item ? profiles[0] : null;
  // Bonus items are valued once, as free items, by bonusValue (as a fresh draft's Bonus! card is).
  const score = roundPoints(main?.points ?? 0);
  // What the main item does (bonus items are described by bonusValue; unread details go to the caveat).
  const reasons = main ? [...main.notes] : ['Item name is not identified; no item value is assumed.'];
  return { offer, main, profiles, score, reasons, problems };
}

function profileItem(item: CatalogItem, hero: CatalogHero | null, usePinnedFacts: boolean): ItemProfile {
  const facts = usePinnedFacts ? PINNED_BASE_FACTS[item.id] ?? null : null;
  const traits = new Set([...item.tags.map(normalize), ...(facts?.traits ?? [])]);
  // NPC-only weapon bonuses do not establish a hero-damage direction for Brawl.
  const npcDamageOnly = /^(?:weapon|bullet)\s+damage\s+vs\.?\s+(?:NPCs?|non.?heroes)/i.test(item.description);
  const directions = npcDamageOnly ? [] : damageDirections(traits);
  const heroDirections = hero ? damageDirections(new Set(hero.tags.map(normalize))) : [];
  const matches = directions.filter(direction => heroDirections.includes(direction));
  const condition = executionCondition(item.description, facts);
  const fixed = facts?.fixed ?? {};
  // General, deliberately modest preference weights. Item tier tracks raw power
  // (a tier 4 item carries far larger stats and effects than a tier 1 item).
  let points = directions.length ? 1.25 : 0;
  if (matches.length) points += 3 * matches.length / Math.max(1, heroDirections.length);
  if (traits.has('healing')) points += 0.9;
  if (traits.has('bullet-lifesteal')) points += 1.1;
  if (traits.has('spirit-lifesteal')) points += 1.1;
  if (traits.has('crowd-control') || traits.has('control')) points += 1.1;
  if (traits.has('mobility')) points += 0.75;
  if (traits.has('control-resist')) points += 0.75;
  if (traits.has('anti-heal')) points += 0.25; // Enemy healing has not been observed.
  points += Math.min((fixed.health ?? 0) / 150, 3);
  points += Math.min((fixed.bulletResist ?? 0) / 20, 1.5);
  points += Math.min((fixed.spiritResist ?? 0) / 20, 1.5);
  if (traits.has('bullet-resist') && !fixed.bulletResist) points += 0.5;
  if (traits.has('spirit-resist') && !fixed.spiritResist) points += 0.5;
  points += Math.min((fixed.regen ?? 0), 1);
  points += Math.min((fixed.statusResist ?? 0) / 30, 1);
  if (!hero || heroDirections.includes('weapon')) points += Math.min((fixed.weaponPower ?? 0) / 40 + (fixed.fireRate ?? 0) / 40, 1.5);
  if (!hero || heroDirections.includes('spirit')) points += Math.min((fixed.spiritPower ?? 0) / 40, 1.5);
  if (condition) points -= /costs health/i.test(condition) ? 1.25 : 0.45;
  // What it does for this hero first, then what it does, then what it asks of the player.
  const notes = [...(matches.length ? [`Complements ${hero!.name}'s ${matches.join('/')} damage.`] : []), mechanicsNote(item, facts, traits), ...(condition ? [condition] : [])];
  return { item, facts, traits, directions, condition, points: Math.max(0, points), notes };
}

function mechanicsNote(item: CatalogItem, facts: BaseFacts | null, traits: Set<string>): string {
  const fixed = facts?.fixed ?? {};
  const snippets: string[] = [];
  if (fixed.health) snippets.push(`+${fixed.health} base health`);
  if (fixed.spiritPower) snippets.push(`+${fixed.spiritPower} spirit power`);
  if (fixed.weaponPower) snippets.push(`+${fixed.weaponPower}% weapon damage`);
  if (fixed.bulletResist) snippets.push(`${fixed.bulletResist}% bullet resist`);
  if (fixed.spiritResist) snippets.push(`${fixed.spiritResist}% spirit resist`);
  if (fixed.fireRate) snippets.push(`+${fixed.fireRate}% fire rate`);
  if (fixed.regen) snippets.push(`+${fixed.regen} health regeneration per second`);
  if (fixed.statusResist) snippets.push(`${fixed.statusResist}% debuff resistance`);
  const leech = traits.has('bullet-lifesteal') && traits.has('spirit-lifesteal')
    ? 'Bullet and spirit lifesteal cover either damage route.'
    : traits.has('bullet-lifesteal') ? 'Bullet lifesteal rewards landing weapon damage.'
      : traits.has('spirit-lifesteal') ? 'Spirit lifesteal rewards landing spirit damage.' : null;
  if (leech) return snippets.length ? `${leech} Base stats: ${snippets.slice(0, 2).join(', ')}.` : leech;
  const description = compactDescription(item.description);
  // A bare label ("Spirit Power.") would only repeat the stat.
  const label = description.split(/\s+/).length <= 3;
  if (snippets.length && description.length < 75) return `Base stats: ${snippets.slice(0, 2).join(', ')}.${label ? '' : ` ${description}`}`;
  return description || (snippets.length ? `Base stats: ${snippets.slice(0, 2).join(', ')}.` : traitDescription(traits));
}

/** Whether the item has a button to press: the pinned base facts' `active` flag, false when there are none (as executionCondition reads it). */
function isActiveItem(itemId: string, usePinnedFacts: boolean): boolean {
  return usePinnedFacts && PINNED_BASE_FACTS[itemId]?.active === true;
}
function executionCondition(description: string, facts: BaseFacts | null): string | null {
  if (/^(?:weapon|bullet)\s+damage\s+vs\.?\s+(?:NPCs?|non.?heroes)/i.test(description)) return 'Its listed damage bonus is against NPCs; hero-fight value is limited.';
  if (/sacrifice\s+health/i.test(description)) return 'Costs health while active; the health tradeoff needs care.';
  if (/highlighted\s+portion|pressing\s+reload/i.test(description)) return 'Requires a timed reload to gain its temporary bonuses.';
  if (/headshot/i.test(description)) return 'Depends on landing headshots for its conditional benefits.';
  if (/below\s+\d+(?:\.\d+)?%?\s+health/i.test(description)) return 'Some benefits require low health; they are not always active.';
  if (/above\s+\d+(?:\.\d+)?%?\s+health/i.test(description)) return 'Some benefits require staying above its health threshold.';
  if (/dash.jump/i.test(description)) return 'Its bonuses require a dash-jump before the ability.';
  if (/out\s+of\s+combat/i.test(description)) return 'Regeneration described as out of combat is not constant fight healing.';
  if (/heavy\s+melee/i.test(description)) return 'Its conditional benefit requires a heavy melee connection.';
  if (/hero\s+dies|after\s+(?:a\s+)?kill|on\s+kill/i.test(description)) return 'Its kill-triggered payoff is conditional.';
  return facts?.active ? 'Requires manual activation and a suitable timing window.' : null;
}
function traitDescription(traits: Set<string>): string {
  const features = ['weapon', 'spirit', 'melee', 'healing', 'anti-heal', 'crowd-control', 'bullet-resist', 'spirit-resist', 'mobility']
    .filter(trait => traits.has(trait));
  return features.length ? `Catalogue effects include ${features.join(', ')}.` : 'No detailed base effect is available for this item.';
}
function damageDirections(traits: Set<string>): Direction[] { return (['weapon', 'spirit', 'melee'] as const).filter(direction => traits.has(direction)); }
function normalize(value: string): string { return value.trim().toLowerCase().replace(/[ _]/g, '-'); }
function compactDescription(value: string): string {
  const plain = value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  // "vs. NPCs" is not a sentence end.
  const sentence = plain.split(/(?<!\bvs\.)(?<=[.!?])\s+(?=[A-Z])/)[0];
  if (!sentence) return '';
  if (sentence.length <= 160) return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  const shortened = sentence.slice(0, 145).replace(/\s+\S*$/, '');
  return `${shortened}…`;
}
function quantityNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => count > 1 ? `${count}× ${name}` : name).join(', ');
}
function roundPoints(points: number): number { return Math.round(points * 100) / 100; }
/**
 * What the enemies actually bought: stacked healing makes anti-heal worth more, and a team
 * leaning on spirit (or weapon) items makes the matching resist worth more.
 */
function buildFit(item: CatalogItem, context: ScreenOfferContext, items: Map<string, CatalogItem>): { points: number; reasons: string[] } {
  const reasons: string[] = []; let points = 0;
  const tags = new Set(item.tags.map(normalize));
  const enemy = (context.enemyItemIds ?? []).map(id => items.get(id)).filter((entry): entry is CatalogItem => !!entry);
  if (enemy.length >= 3) {
    const enemyTags = enemy.map(entry => new Set(entry.tags.map(normalize)));
    const healing = enemyTags.filter(set => set.has('healing') || set.has('bullet-lifesteal') || set.has('spirit-lifesteal')).length;
    const spirit = enemy.filter(entry => entry.category === 'spirit').length;
    const weapon = enemy.filter(entry => entry.category === 'weapon').length;
    if (tags.has('anti-heal') && healing >= 3) { points += 1.5; reasons.push(`Enemies carry ${healing} healing or lifesteal items; this cuts their healing.`); }
    if (tags.has('spirit-resist') && spirit >= 4 && spirit >= weapon * 1.5) { points += 1; reasons.push(`Enemies lean on spirit damage (${spirit} spirit items).`); }
    if (tags.has('bullet-resist') && weapon >= 4 && weapon >= spirit * 1.5) { points += 1; reasons.push(`Enemies lean on gun damage (${weapon} weapon items).`); }
  }
  return { points, reasons };
}
/** Base value of one free bonus item, on top of its tier. */
const BONUS_ITEM_POINTS = 0.75;
/**
 * A card that upgrades an owned item absorbs that item and adds a lower-tier bonus item
 * ("Bonus!"). The upgrade keeps the absorbed item's effects, so the bonus is pure extra value.
 * An expected but unidentified bonus is credited as an item of the absorbed item's tier.
 */
/**
 * Weighted offer-only mechanics of one free bonus item: the item's own when identified, else the
 * average item of its tier. Counted once, here (compareOffer and the observed-context score value
 * only the main item), so a shown Bonus! card and a fresh one are valued the same way.
 */
interface BonusMechanics { known(item: CatalogItem): number; expected(tier: number): number }
function bonusMechanicsFor(items: Map<string, CatalogItem>, hero: CatalogHero | null, usePinnedFacts: boolean): BonusMechanics {
  const byTier = new Map<number, number>();
  const known = (item: CatalogItem) => HEURISTIC_WEIGHT * profileItem(item, hero, usePinnedFacts).points;
  return {
    known,
    expected(tier) {
      if (!byTier.has(tier)) {
        const sameTier = [...items.values()].filter(item => item.tier === tier);
        byTier.set(tier, sameTier.length ? sameTier.reduce((sum, item) => sum + known(item), 0) / sameTier.length : 0);
      }
      return byTier.get(tier)!;
    },
  };
}
function bonusValue(offer: ScreenOffer, items: Map<string, CatalogItem>, mechanics: BonusMechanics): { points: number; reasons: string[] } {
  const reasons: string[] = []; let points = 0;
  const absorbed = (offer.absorbsIds ?? []).map(id => items.get(id)).filter((entry): entry is CatalogItem => !!entry);
  const known = (offer.bonusIds ?? []).map(id => items.get(id)).filter((entry): entry is CatalogItem => !!entry);
  if (known.length) {
    for (const bonus of known) points += BONUS_ITEM_POINTS + tierPoints(bonus) + mechanics.known(bonus);
    reasons.push(`Bonus! Also gives ${quantityNames(known.map(bonus => bonus.name))} for free.`);
  } else if (offer.bonusExpected && offer.bonusIds === null) {
    const main = items.get(offer.itemId);
    const tier = absorbed.length ? Math.min(...absorbed.map(entry => entry.tier ?? 1)) : Math.max(1, (main?.tier ?? 2) - 1);
    points += BONUS_ITEM_POINTS + tierPoints({ tier } as CatalogItem) + mechanics.expected(tier);
    reasons.push('Bonus! card: it also gives a free lower-tier item.');
  }
  if (absorbed.length) reasons.push(`Upgrades your ${quantityNames(absorbed.map(entry => entry.name))}, which it absorbs.`);
  return { points: roundPoints(points), reasons };
}
/** Weight of the offer-only mechanics/hero-direction heuristic next to measured Street
 * Brawl data. Observed-context scores (own build, enemy kits) keep full weight. */
const HEURISTIC_WEIGHT = 0.35;
/** Win rates average over every enemy line-up; counters to the enemies actually read
 * (and the own build actually read) outweigh them. */
const CONTEXT_WEIGHT = 2;
/** General-value points per item tier above tier 1 (also what a RARE card earns per tier above its draft). */
const TIER_POINTS = 0.6;
/** Higher tiers carry larger stats and effects. Within one draft every card shares a tier, except a
 * RARE card (one tier above the choice) and a free Bonus! item, so this mainly values those. */
function tierPoints(item: CatalogItem): number { return item.tier === null || !Number.isFinite(item.tier) ? 0 : Math.max(0, Math.min(5, item.tier) - 1) * TIER_POINTS; }
/**
 * Tiers of this choice and the round's later choices. The read round and choice place the draft
 * in the table when they agree with the draft's tier; an unread choice is the one closest to the
 * middle that offers this tier; without a usable table entry the later choices share this tier
 * (an unknown choice counts as choice 2).
 */
export function remainingChoiceTiers(round: number | null, choice: number | null, tier: number): number[] {
  const row = round !== null ? CHOICE_TIERS[round] : undefined;
  const known = choice === 1 || choice === 2 || choice === 3 ? choice : null;
  if (row && known !== null && row[known - 1] === tier) return row.slice(known - 1);
  if (row && known === null) {
    const matches = [0, 1, 2].filter(index => row[index] === tier).sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1) || a - b);
    if (matches.length) return row.slice(matches[0]);
  }
  return new Array<number>(known === null ? 2 : 4 - known).fill(tier);
}
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
type Pools = (tier: number) => PoolCard[] | null;
/**
 * Tier pools for this hero and enemy team, valued like the cards on screen: measured value, the
 * weighted offer-only heuristic, and the extras a fresh card would carry — a Bonus! item when it
 * upgrades something you own, the enemy-build bonus, and the Enhanced uplift times the chance a
 * card is Enhanced. A RARE card's chance is not published, so a fresh draft is given none (a shown
 * RARE keeps its tier bonus).
 */
function draftPools(heroId: string, hero: CatalogHero | null, usePinnedFacts: boolean, enemyHeroIds: readonly string[], owned: ReadonlySet<string>,
  context: ScreenOfferContext, items: Map<string, CatalogItem>, mechanics: BonusMechanics): Pools {
  const ownedList = [...owned];
  const enhancedRate = enhancedOfferRate();
  const extra = (itemId: string) => {
    const item = items.get(itemId);
    const heuristic = item ? HEURISTIC_WEIGHT * profileItem(item, hero, usePinnedFacts).points : 0;
    const absorbed = absorbedComponents(itemId, ownedList).map(id => items.get(id)?.tier)
      .filter((tier): tier is number => typeof tier === 'number' && Number.isFinite(tier));
    // Its free item's identity is unknown: the average item of the absorbed tier, as for an unread bonus on screen.
    const bonusTier = absorbed.length ? Math.min(...absorbed) : null;
    const bonus = bonusTier !== null ? BONUS_ITEM_POINTS + tierPoints({ tier: bonusTier } as CatalogItem) + mechanics.expected(bonusTier) : 0;
    return heuristic + (item ? buildFit(item, context, items).points : 0) + bonus + enhancedRate * enhancedPoints(itemId);
  };
  const cache = new Map<number, PoolCard[] | null>();
  return tier => {
    if (!cache.has(tier)) cache.set(tier, draftPool(heroId, tier, enemyHeroIds, { exclude: owned, extra, owned: ownedList }));
    return cache.get(tier)!;
  };
}
interface RerollInput {
  rerolls: number | null; choice: number | null; round: number | null; heroName: string | null; tier: number | null;
  /** Tier pools for the identified hero; null without one. */
  pools: Pools | null;
  /** Card value of the card you would take; null unless all three cards are resolved. */
  currentValue: number | null;
}
/**
 * Reroll when a fresh draft, played on optimally over the round's remaining choices and
 * rerolls (rerollPlan), is worth more than taking the card on screen and keeping the rerolls.
 * Every reroll counts, including the Random Hero bonus reroll.
 */
function rerollDecision(input: RerollInput): { suggest: boolean; reason: string } {
  if (input.rerolls === 0) return { suggest: false, reason: 'No rerolls left — take the best card.' };
  const count = input.rerolls !== null && Number.isSafeInteger(input.rerolls) && input.rerolls > 0 ? input.rerolls : null;
  const budget = count === null ? '' : `${count} reroll${count === 1 ? '' : 's'} left.`;
  // Without a hero, or a fully read draft, there is nothing to measure the draft against: say nothing.
  const quiet = { suggest: false, reason: budget };
  if (!input.pools || input.tier === null || input.currentValue === null) return quiet;
  const current = input.pools(input.tier);
  if (!current) return quiet;
  const currentBest = bestOfThree(current);
  // A later choice whose pool cannot be valued is treated like this one.
  const stages: BestOfThree[] = remainingChoiceTiers(input.round, input.choice, input.tier).map((tier, index) => {
    if (index === 0) return currentBest;
    const pool = input.pools!(tier);
    return pool ? bestOfThree(pool) : currentBest;
  });
  // An unread count means at least the round's one reroll.
  const plan = rerollPlan(input.currentValue, count ?? 1, stages);
  const prefix = budget ? `${budget} ` : '';
  const last = stages.length === 1;
  if (plan.reroll) {
    return { suggest: true, reason: `${prefix}Weak draft for ${input.heroName ?? 'your hero'}: a fresh tier ${ROMAN[input.tier] ?? input.tier} draft is worth more than these cards. `
      + (last ? 'Reroll — it expires after this choice.' : 'Reroll (lost at round end).') };
  }
  return { suggest: false, reason: `${prefix}${last ? 'Solid draft — no reroll needed.' : `Solid draft — keep your reroll${(count ?? 1) > 1 ? 's' : ''}.`}` };
}
/** The draft on screen when last evaluated, and what was owned before any of its cards was taken. */
let draftMemory: { key: string; owned: readonly string[]; offers: ScreenOffer[] } | null = null;
/**
 * A draft never offers an owned item, so an offered card that becomes owned while the same
 * cards are on screen was just taken. From then on the draft is evaluated as it was before the
 * pick (ownership and card details), so the advice does not jump to another card. A card that is
 * already owned when the draft is first seen stays a likely misread.
 */
function stableDraft(offers: ScreenOffer[], context: ScreenOfferContext): { offers: ScreenOffer[]; ownedItemIds: readonly string[] } {
  const owned = context.ownedItemIds ?? [];
  // Not keyed by round: the round can be inferred or corrected in the middle of a draft, after a pick.
  const key = JSON.stringify([context.heroId, offers.map(offer => `${offer.position}:${offer.itemId}:${offer.rare ? 1 : 0}`).sort()]);
  const memory = draftMemory?.key === key ? draftMemory : null;
  if (memory && offers.some(offer => !!offer.itemId && owned.includes(offer.itemId) && !memory.owned.includes(offer.itemId))) {
    return { offers: memory.offers, ownedItemIds: memory.owned };
  }
  draftMemory = { key, owned: [...owned], offers };
  return { offers, ownedItemIds: owned };
}
/** Forget the remembered draft (tests). */
export function resetDraftMemory(): void { draftMemory = null; }
function enhancedLine(itemId: string, points: number): string {
  const stat = streetBrawlData().enhanced?.items[itemId];
  if (!stat || stat.matches < 500) return 'Enhanced: carries bonus stats on top of the base item.';
  const change = Math.round(points / WIN_RATE_WEIGHT * 1000) / 10;
  return `Enhanced: wins ${Math.round(stat.winRate * 100)}% of ${stat.matches.toLocaleString('en-US')} games${Math.abs(change) >= 0.5 ? ` (${change > 0 ? '+' : ''}${change} over the plain item)` : ''}.`;
}
/** Lines that only qualify a comparison; real read problems are carried by `caveat` instead. */
const FILLER_REASON = /^(?:Comparison of known base mechanics|A repeat may upgrade|Read bonuses:|Base mechanics only|Bonus details not read|Comes with |General-purpose pick)/;
/** A clause that hedges about what was not read, observed or measured. */
const HEDGE_CLAUSE = /\b(?:un(?:observed|read|known|measured|modell?ed|verified|confirmed)|not (?:known|read|assumed|observed|confirmed|verified|modell?ed|measured))\b/i;
/** Keeps card reasons short and confident: drops qualifier lines and hedging clauses, and "observed". */
function confidentReasons(reasons: readonly string[]): string[] {
  return reasons.flatMap(reason => {
    if (FILLER_REASON.test(reason)) return [];
    const text = reason.split(/;\s+/).filter(clause => !HEDGE_CLAUSE.test(clause)).join('; ')
      .replace(/\bobserved\s+/gi, '').replace(/\s{2,}/g, ' ').trim().replace(/[;,]$/, '');
    if (!text) return [];
    const sentence = text[0]!.toUpperCase() + text.slice(1);
    return [/[.!?…]$/.test(sentence) ? sentence : `${sentence}.`];
  });
}
