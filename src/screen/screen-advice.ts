import type { Catalog, CatalogHero, CatalogItem } from '../shared/types';
import type { ScreenAdvice, ScreenMatchContext, ScreenOffer } from '../shared/screen-reading';
import { evaluateContextOffers } from './context-advice';
import { streetBrawlFit } from './street-brawl-fit';
import { imbueTarget } from './imbue-advice';

export interface ScreenOfferContext {
  heroId: string | null; round: number | null; rerolls: number | null;
  /** Enemy heroes identified in this match; their Street Brawl counter data is applied. */
  enemyHeroIds?: readonly string[];
  /** Items read in your own inventory this match. */
  ownedItemIds?: readonly string[];
  /** Items read on the enemy team's scoreboard rows this match. */
  enemyItemIds?: readonly string[];
  matchContext?: ScreenMatchContext;
  now?: number;
}
type Direction = 'weapon' | 'spirit' | 'melee';
type FixedStat = 'health' | 'spiritPower' | 'weaponPower' | 'fireRate' | 'bulletResist' | 'spiritResist' | 'regen' | 'bulletLifesteal' | 'spiritLifesteal' | 'statusResist';
interface BaseFacts { fixed: Partial<Record<FixedStat, number>>; traits: string[]; active: boolean }
interface ItemProfile {
  item: CatalogItem; directions: Direction[]; facts: BaseFacts | null;
  traits: Set<string>; condition: string | null; points: number; notes: string[];
}
interface OfferComparison { offer: ScreenOffer; main: ItemProfile | null; profiles: ItemProfile[]; score: number; reasons: string[]; problems: string[] }

const READ_QUALITY_MINIMUM = 0.85;
const PINNED_CLIENT = '6774';
const PINNED_REVISION = '11112755';
/**
 * Extracted from the saved client-6774 Valve-asset snapshot (items SHA-256
 * 31c96630cba83b9fdbbedf62bb76a70cc3334667f05d2694c58d1d73791fe596).
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
  "upgrade_healing_booster": {"fixed":{"regen":3},"traits":["healing"],"active":false},
  "upgrade_health": {"fixed":{"health":210},"traits":["health"],"active":false},
  "upgrade_health_nova": {"fixed":{"spiritPower":8},"traits":["spirit"],"active":true},
  "upgrade_health_stealing_magic": {"fixed":{"spiritPower":6,"health":90},"traits":["health","spirit","spirit-lifesteal"],"active":false},
  "upgrade_health_stimpak": {"fixed":{},"traits":[],"active":true},
  "upgrade_hollow_point_rounds": {"fixed":{"health":125},"traits":["health"],"active":false},
  "upgrade_improved_spirit": {"fixed":{"spiritPower":10},"traits":["spirit"],"active":false},
  "upgrade_infinite_rounds": {"fixed":{"fireRate":35},"traits":["weapon"],"active":false},
  "upgrade_infuser": {"fixed":{"spiritPower":6,"health":100},"traits":["health","spirit","spirit-lifesteal"],"active":true},
  "upgrade_inhibitor": {"fixed":{"health":150},"traits":["health"],"active":false},
  "upgrade_juggernaut": {"fixed":{"regen":8},"traits":["healing"],"active":false},
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
  "upgrade_return_fire": {"fixed":{},"traits":[],"active":true},
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
  "upgrade_targeted_silence": {"fixed":{"health":50},"traits":["health"],"active":true},
  "upgrade_tech_damage_pulse": {"fixed":{"health":100},"traits":["health"],"active":false},
  "upgrade_tech_overflow": {"fixed":{"spiritPower":6,"health":90},"traits":["health","spirit","spirit-lifesteal"],"active":false},
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
export function evaluateScreenOffers(offers: ScreenOffer[], catalog: Catalog, context: ScreenOfferContext): ScreenAdvice | null {
  if (offers.length === 0) return null;
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const contextual = context.matchContext ? evaluateContextOffers(offers, catalog, context.matchContext, context.now ?? Date.now()) : null;
  // An unverified match context has no hero of its own; fall back to the hero we were given.
  const heroId = contextual?.heroId ?? context.heroId;
  const hero = heroId === null ? null : catalog.heroes.find(candidate => candidate.id === heroId) ?? null;
  const usePinnedFacts = catalog.clientVersion === PINNED_CLIENT && catalog.revision === PINNED_REVISION;
  const comparisons = offers.map(offer => compareOffer(offer, items, hero, usePinnedFacts));
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
  const provisionalName = comparisonPosition === null ? null : items.get(offers.find(offer => offer.position === comparisonPosition)!.itemId)?.name;
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

  let reasons: string[];
  if (!best) {
    reasons = ['No offered item can be resolved to the local catalogue.', 'Read the item names and complete bonus/modifier details before comparing choices.'];
  } else if (comparisonPosition !== null && baseBest) {
    const qualifier = unreadEffects ? 'Bonuses or special effects are unread and could change this choice.'
      : excludedBonuses ? 'Known bonuses are excluded and could change this choice.' : 'Only the main item is compared.';
    reasons = [baseComparison ? baseBest.reasons[0] : `${provisionalName} base effects: ${baseBest.reasons[0]}`,
      baseComparison ? qualifier : `Offer-only guidance: your build and teams are unverified. ${qualifier}`];
  } else if (problems.length) {
    reasons = [
      'Comparison only: at least one card, bonus bundle or modifier is not fully identified.',
      contextual?.hasContext ? (best.reasons.find(reason => !reason.startsWith('Comparison of known')) ?? best.reasons[0])
        : `${best.main!.item.name} base effects: ${best.main!.notes[0]}`,
    ];
  } else {
    const comparison = contextual?.hasContext
      ? best.reasons[1] ?? (alternative?.reasons[0] ? `Alternative ${alternative.main!.item.name}: ${alternative.reasons[0]}` : comparativeReason(best, alternative, hero))
      : comparativeReason(best, alternative, hero);
    reasons = [best.reasons[0], comparison];
    if (unclearValue) reasons[1] = `These offers have similar ${contextual?.hasContext ? 'contextual comparison scores' : 'general value'}. ${comparison}`;
  }
  // Always name the best readable card. Unread bonuses and unverified context are
  // shown as caveats; withholding a pick left the player with no guidance at all.
  // Real Street Brawl evidence (Valve's per-hero Good bucket and match win rates) is
  // added to every card, whichever comparison produced its base score.
  const baseScores = comparisonPosition !== null ? baseRanked
    : comparisons.map(comparison => ({ position: comparison.offer.position, score: comparison.score, reasons: comparison.reasons }));
  const contextScored = comparisonPosition !== null ? !!baseComparison : !!contextual?.hasContext;
  const ranked = baseScores.map((entry, index) => {
    const offer = offers[index];
    if (!offer || !items.has(offer.itemId)) return entry;
    const fit = streetBrawlFit(offer.itemId, heroId, context.enemyHeroIds ?? []);
    const build = buildFit(items.get(offer.itemId)!, context, items);
    fit.points += build.points; fit.reasons.push(...build.reasons);
    // An Enhanced card is the same item with extra stats.
    if (offer.variant === 'enhanced') { fit.points += ENHANCED_POINTS; fit.reasons.push('Enhanced: carries bonus stats on top of the base item.'); }
    // Measured Street Brawl results lead; the offer-only heuristic only breaks ties, while
    // scores from the observed match (own build, enemy kits) keep their full weight.
    const weight = contextScored ? CONTEXT_WEIGHT : HEURISTIC_WEIGHT;
    const imbue = imbueTarget(offer.itemId, heroId);
    const imbueLine = imbue ? [`Imbue it on ${imbue.ability}: ${imbue.reason}.`] : [];
    return { position: entry.position, score: roundPoints(weight * entry.score + fit.points + tierPoints(items.get(offer.itemId)!)),
      reasons: [...fit.reasons.slice(0, 1), ...imbueLine, ...fit.reasons.slice(1), ...entry.reasons, ...fit.concerns] };
  });
  // ranked follows the offers array order, so each entry keeps its own offer even
  // when OCR reports two cards at one position.
  const pickOrder = ranked.map((entry, index) => ({ ...entry, offer: offers[index]! }))
    .filter(entry => items.has(entry.offer.itemId)).sort((a, b) => b.score - a.score || a.position - b.position);
  // Cards are only read while a draft is visible, which only a player in the match sees; an ended match has no pick.
  const ownView = context.matchContext?.phase !== 'finished';
  const pickEntry = !ownView ? undefined : pickOrder[0];
  if (pickEntry) {
    // Lead with the pick's own reasons; drop older summary lines that describe another card.
    const otherNames = offers.filter(offer => offer !== pickEntry.offer).map(offer => items.get(offer.itemId)?.name).filter((name): name is string => !!name)
      .filter(name => name !== items.get(pickEntry.offer.itemId)?.name);
    const own = pickEntry.reasons;
    reasons = [...own, ...reasons.filter(reason => !own.includes(reason) && !otherNames.some(name => reason.includes(name)))];
  }
  const pick = pickEntry?.position ?? null;
  const pickName = pickEntry ? items.get(pickEntry.offer.itemId)?.name ?? null : null;
  const margin = pickEntry && pickOrder.length > 1 ? pickEntry.score - Math.max(...pickOrder.filter(entry => entry !== pickEntry).map(entry => entry.score)) : null;
  const closeCall = margin !== null && margin < 0.25;
  const reroll = rerollDecision(context.rerolls, pickEntry?.score ?? null, closeCall);
  if (closeCall && pickName) reasons = [`Close call: ${pickName} edges out the alternatives.`, ...reasons];
  const weakName = offers.some(offer => !items.has(offer.itemId) || !(offer.confidence >= READ_QUALITY_MINIMUM));
  const caveat = unreadEffects ? 'Bonuses or special effects on the cards were not read; check them in game.'
    : weakName ? 'One card name was not read clearly; check it in game.' : null;
  return {
    preferredPosition: pick,
    title: pickName === null ? 'Compare the readable cards' : reroll.suggest ? `Reroll — or take ${pickName}` : closeCall ? `Slight edge: ${pickName}` : `Pick ${pickName}`,
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
  const score = roundPoints(profiles.reduce((total, profile) => total + profile.points, 0));
  const reasons = main ? [main.notes[0], main.condition ?? main.notes[1]] : ['Item name is not identified; no item value is assumed.'];
  if (bonusIds.length) {
    const known = bonusIds.map(id => items.get(id)?.name).filter((name): name is string => !!name);
    if (known.length) reasons.push(`Comes with ${quantityNames(known)}.`);
  }
  if (offer.bonusIds === null) reasons.push('Bonus details not read; compared on the main item.');
  if (offer.variant !== 'base') reasons.unshift('Base mechanics only; the shown variant can change the comparison.');
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
  const notes = [mechanicsNote(item, facts, traits)];
  if (matches.length) notes.push(`Matches observed ${hero!.name}'s ${matches.join('/')} damage.`);
  else if (condition) notes.push(condition);
  else notes.push('General-purpose pick; no specific synergy with your hero.');
  if (condition && !notes.includes(condition)) notes.push(condition);
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
  if (snippets.length && description.length < 75) return `Base stats: ${snippets.slice(0, 2).join(', ')}. ${description || traitDescription(traits)}`;
  return description || (snippets.length ? `Base stats: ${snippets.slice(0, 2).join(', ')}.` : traitDescription(traits));
}

function comparativeReason(best: OfferComparison, other: OfferComparison | undefined, hero: CatalogHero | null): string {
  const main = best.main!;
  const knownBonuses = best.profiles.slice(1).map(profile => profile.item.name);
  const bonus = knownBonuses.length ? ` Includes ${quantityNames(knownBonuses)}.` : '';
  if (!other?.main) return `Only this named base item is understood; compare the remaining card details.${bonus}`;
  const otherMain = other.main;
  const heroDirections = hero ? damageDirections(new Set(hero.tags.map(normalize))) : [];
  const ownFit = main.directions.filter(direction => heroDirections.includes(direction));
  const otherFit = otherMain.directions.filter(direction => heroDirections.includes(direction));
  if (hero && ownFit.length && !otherFit.length) {
    return `${hero.name}'s observed ${ownFit.join('/')} direction favors this over ${otherMain.item.name}'s ${shortFocus(otherMain)} focus.${bonus}`;
  }
  if (otherMain.condition && !main.condition) {
    return `${otherMain.item.name}: ${otherMain.condition} This offer emphasizes ${shortFocus(main)}.${bonus}`;
  }
  return `Compared with ${otherMain.item.name}: ${shortFocus(main)} versus ${shortFocus(otherMain)}.${bonus}`;
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
function shortFocus(profile: ItemProfile): string {
  const traits = profile.traits;
  if (traits.has('bullet-lifesteal') && traits.has('spirit-lifesteal')) return 'sustain for both damage routes';
  if (traits.has('healing')) return profile.directions.length ? `${profile.directions.join('/')} sustain` : 'sustain';
  if (traits.has('crowd-control') || traits.has('control')) return 'control';
  if (traits.has('control-resist')) return 'debuff protection';
  if (profile.directions.length) return profile.directions.join('/');
  if (traits.has('bullet-resist') || traits.has('spirit-resist')) return 'damage protection';
  if (traits.has('mobility')) return 'mobility';
  return 'general utility';
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
  if (context.ownedItemIds?.includes(item.id)) reasons.push(`You already own ${item.name}.`);
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
/** Weight of the offer-only mechanics/hero-direction heuristic next to measured Street
 * Brawl data. Observed-context scores (own build, enemy kits) keep full weight. */
const HEURISTIC_WEIGHT = 0.35;
/** Extra value of an Enhanced card over the plain item. */
const ENHANCED_POINTS = 1;
/** Win rates average over every enemy line-up; counters to the enemies actually read
 * (and the own build actually read) outweigh them. */
const CONTEXT_WEIGHT = 2;
/** A RARE card is one tier above its slot; the higher tier is real extra power. */
function tierPoints(item: CatalogItem): number { return item.tier === null || !Number.isFinite(item.tier) ? 0 : Math.max(0, Math.min(5, item.tier) - 1) * 0.6; }
/** Best-card score below which a reroll is suggested: about the weakest fifth of random
 * draws (sampled over all tiers and several heroes). There is one reroll per round,
 * so it is spent only on clearly weak sets. */
const REROLL_SCORE_THRESHOLD = 1;
function rerollDecision(rerolls: number | null, bestScore: number | null, closeCall: boolean): { suggest: boolean; reason: string } {
  if (rerolls === 0) return { suggest: false, reason: 'No rerolls left — take the best card.' };
  const known = rerolls !== null && Number.isSafeInteger(rerolls) && rerolls > 0;
  // With several rerolls left, spending one on a weak set costs less.
  const threshold = REROLL_SCORE_THRESHOLD + (known && rerolls! >= 2 ? 0.5 : 0);
  if (bestScore === null) return { suggest: false, reason: 'Cards are not fully read yet.' };
  const budget = known ? `${rerolls} reroll${rerolls === 1 ? '' : 's'} left. ` : 'Reroll count not read. ';
  if (bestScore < threshold) {
    return { suggest: true, reason: `${budget}None of these cards fits your hero or the fight well — a reroll is likely to offer something better.` };
  }
  return { suggest: false, reason: `${budget}${closeCall ? 'The top cards are close, but either is a solid pick' : 'The suggested card is a solid pick'} — keep your rerolls.` };
}
