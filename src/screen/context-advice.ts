import { CONTEXT_CATALOG, contextCatalogCompatible } from '../shared/context-catalog';
import type { ContextAbility, ContextHero, ContextItem, ContextProperty } from '../shared/context-catalog';
import { SCREEN_CONTEXT_MAX_AGE_MS } from '../shared/screen-reading';
import type { ScreenAdvice, ScreenContextObservation, ScreenInventoryItem, ScreenMatchContext, ScreenOffer } from '../shared/screen-reading';
import type { Catalog } from '../shared/types';
import { isScreenObservationUsable } from './match-state';

type Fact = NonNullable<ScreenAdvice['factsUsed']>[number];
type Stat = 'health' | 'weapon' | 'fire' | 'spirit' | 'melee' | 'bulletResist' | 'spiritResist' | 'meleeResist' | 'regen' | 'bulletLife' | 'spiritLife' | 'status' | 'cooldown' | 'duration';
type Stats = Record<Stat, number>;
interface KnownItem { definition: ContextItem; observed: ScreenInventoryItem; fact: Fact }
interface KnownAbility { definition: ContextAbility; rank: number; fact: Fact; coefficients: { property: ContextProperty; coefficient: number }[] }
interface PlayerProfile {
  hero: ContextHero; heroFact: Fact; items: KnownItem[]; stats: Stats;
  weaponThreat: number; spiritThreat: number; meleeThreat: number; healing: number; control: number;
}
interface Build {
  hero: ContextHero | null; heroFact: Fact | null; items: KnownItem[]; stats: Stats; abilities: KnownAbility[];
  lockedAbilityIds: Set<string>;
  abilitiesComplete: boolean;
  allies: PlayerProfile[]; enemies: PlayerProfile[]; limitations: string[]; hasContext: boolean;
}
interface Contribution { points: number; reason: string; facts: Fact[] }
export interface ContextOfferEvaluation {
  hasContext: boolean;
  heroId: string | null;
  ranked: { position: number; score: number; reasons: string[] }[];
  limitations: string[];
  factsUsed: Fact[];
  /** Only material offer/owned duplicate semantics, never missing roster fields. */
  materialProblems: string[];
}

const SOURCE_ITEMS = new Map(CONTEXT_CATALOG.items.map(item => [item.id, item]));
const SOURCE_HEROES = new Map(CONTEXT_CATALOG.heroes.map(hero => [hero.id, hero]));
const SOURCE_ABILITIES = new Map(CONTEXT_CATALOG.abilities.map(ability => [ability.id, ability]));
const STAT_TYPES: Record<string, Stat> = {
  MODIFIER_VALUE_HEALTH_MAX: 'health', MODIFIER_VALUE_WEAPON_POWER: 'weapon',
  MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE: 'weapon', MODIFIER_VALUE_FIRE_RATE: 'fire', MODIFIER_VALUE_TECH_POWER: 'spirit',
  MODIFIER_VALUE_MELEE_DAMAGE_INCREASE: 'melee', MODIFIER_VALUE_MELEE_RESIST: 'meleeResist',
  MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST: 'bulletResist', MODIFIER_VALUE_TECH_RESIST: 'spiritResist',
  MODIFIER_VALUE_HEALTH_REGEN_PER_SECOND: 'regen', MODIFIER_VALUE_BULLET_LIFESTEAL: 'bulletLife',
  MODIFIER_VALUE_TECH_LIFESTEAL: 'spiritLife', MODIFIER_VALUE_STATUS_RESISTANCE: 'status',
  MODIFIER_VALUE_COOLDOWN_REDUCTION_PERCENTAGE: 'cooldown', MODIFIER_VALUE_TECH_DURATION: 'duration',
};
const emptyStats = (): Stats => ({ health: 0, weapon: 0, fire: 0, spirit: 0, melee: 0, bulletResist: 0, spiritResist: 0, meleeResist: 0, regen: 0, bulletLife: 0, spiritLife: 0, status: 0, cooldown: 0, duration: 0 });
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const round = (value: number): number => Math.round(value * 100) / 100;
const numberText = (value: number): string => String(round(value));

/** A hidden snapshot is not a continuously observed live stat sheet. */
export function isContextObservationUsable(
  observation: ScreenContextObservation | null | undefined, context: ScreenMatchContext, now: number,
  options: { allowSameRound?: boolean; roundSensitive?: boolean } = {},
): observation is ScreenContextObservation {
  if (!observation || !context.sessionId || context.retiredSessionIds.includes(context.sessionId)
    || (context.gameSessionId !== null && context.retiredGameSessionIds.includes(context.gameSessionId))
    || !isScreenObservationUsable(observation, context, now, SCREEN_CONTEXT_MAX_AGE_MS) || !observation.frameId
    || !Number.isFinite(now) || !Number.isFinite(observation.capturedAt) || !Number.isFinite(observation.receivedAt)
    || observation.capturedAt < 0 || observation.capturedAt > now || observation.receivedAt < observation.capturedAt
    || observation.receivedAt > now || !Number.isFinite(observation.confidence) || observation.confidence < 0.85 || observation.confidence > 1) return false;
  // A newer round/header confirmation cannot refresh a hidden mutable snapshot.
  return now - observation.capturedAt <= SCREEN_CONTEXT_MAX_AGE_MS
    && (options.roundSensitive === false || observation.round == null || context.round == null || observation.round === context.round);
}

/**
 * Deterministic local comparison of observed builds and source parameters.
 * Weapon/fire arithmetic is a comparison anchor, not reconstructed live DPS.
 * Ability gains are the source's linear spirit term, before target modifiers.
 * Threat weights describe possible mechanics in an observed enemy's kit/gear;
 * they do not invent enemy unlocks, hit rates, uptime or damage dealt.
 */
export function evaluateContextOffers(offers: ScreenOffer[], catalog: Catalog, context: ScreenMatchContext, now = Date.now()): ContextOfferEvaluation {
  const build = prepareBuild(catalog, context, now);
  if (!build.hasContext) return { hasContext: false, heroId: null, ranked: offers.map(offer => ({ position: offer.position, score: 0, reasons: ['No current participant context is usable.'] })), limitations: build.limitations, factsUsed: [], materialProblems: [] };
  const factsUsed: Fact[] = [];
  const materialProblems: string[] = [];
  const ranked = offers.map(offer => {
    const main = SOURCE_ITEMS.get(offer.itemId);
    const definitions = [main, ...(offer.bonusIds ?? []).map(id => SOURCE_ITEMS.get(id))].filter((item): item is ContextItem => !!item);
    if (!main) return { position: offer.position, score: 0, reasons: ['Item identity is not resolved; no effects are assumed.'] };
    const repeated = definitions.filter((item, index) => definitions.findIndex(other => other.id === item.id) !== index);
    const ownedRepeated = definitions.filter(item => build.items.some(owned => owned.definition.id === item.id));
    if (repeated.length || ownedRepeated.length) {
      materialProblems.push(`Offer ${offer.position + 1}: repeated ${unique([...repeated, ...ownedRepeated].map(item => item.name)).join(', ')} has no decoded Street Brawl upgrade/stacking state.`);
    }
    const contributions: Contribution[] = [];
    // Repetition is recorded, but an unspecified item upgrade operator is never
    // converted into an additive runtime level or duplicated passive proc.
    for (const item of definitions.filter((item, index) => definitions.findIndex(other => other.id === item.id) === index)) {
      contributions.push(...scoreItem(item, build));
    }
    for (const contribution of contributions) factsUsed.push(...contribution.facts);
    const ordered = contributions.filter(entry => entry.reason && entry.points > 0.01).sort((a, b) => b.points - a.points);
    const reasons = ordered.slice(0, 3).map(entry => entry.reason);
    if (!reasons.length && build.hero && build.heroFact) {
      reasons.push(`${main.name} has no clear stat or counter advantage for ${build.hero.name} right now.`);
      factsUsed.push(build.heroFact);
    }
    if (!reasons.length) reasons.push(`${main.name}: ${shortDescription(main.description) || 'no supported contextual effect is available.'}`);
    const bonusNames = (offer.bonusIds ?? []).map(id => SOURCE_ITEMS.get(id)?.name).filter((name): name is string => !!name);
    if (bonusNames.length) reasons.push(`Read bonuses: ${quantityNames(bonusNames)}; their known base parameters are included once per distinct item.`);
    if (offer.variant !== 'base' || offer.bonusIds === null) reasons.unshift('Comparison of known base mechanics; unread bundle effects can change the order.');
    if (repeated.length || ownedRepeated.length) reasons.push('A repeat may upgrade the existing item; the unobserved upgrade operator is not assumed.');
    return { position: offer.position, score: round(contributions.reduce((total, entry) => total + entry.points, 0)), reasons };
  });
  return {
    hasContext: build.hasContext, heroId: build.hero?.id ?? null, ranked,
    limitations: unique(build.limitations), materialProblems: unique(materialProblems),
    factsUsed: deduplicateFacts(factsUsed),
  };
}

function prepareBuild(catalog: Catalog, context: ScreenMatchContext, now: number): Build {
  const limitations: string[] = [];
  const unavailable: Build = { hero: null, heroFact: null, items: [], stats: emptyStats(), abilities: [], lockedAbilityIds: new Set(), abilitiesComplete: false, allies: [], enemies: [], limitations, hasContext: false };
  if (!contextCatalogCompatible(catalog)) {
    limitations.push('Context mechanics do not match this catalogue version; no pinned quantities or rank formulas are applied.');
    return unavailable;
  }
  if (!context.sessionId || context.phase === 'finished') {
    limitations.push('No active observed match context; previous game observations are not used.');
    return unavailable;
  }
  const usable = (observation: ScreenContextObservation | null | undefined, roundSensitive = false) => isContextObservationUsable(observation, context, now, { roundSensitive });
  if (context.viewMode !== 'participant' || !usable(context.observations.viewMode)) {
    limitations.push(context.viewMode === 'spectator'
      ? 'Spectating view: displayed heroes, items and ranks are not assigned to your build.'
      : 'Participant view is not confirmed; visible HUD fields are not assigned to your own build.');
    return unavailable;
  }
  let hero: ContextHero | null = usable(context.observations.localHeroId) && context.localHeroId ? SOURCE_HEROES.get(context.localHeroId) ?? null : null;
  let heroFact: Fact | null = hero ? observationFact('own', `Own hero: ${hero.name}`, context.observations.localHeroId!) : null;
  const knownLocalSeat = usable(context.observations.localSeat) ? context.localSeat : null;
  const localRow = context.players.find(player => player.seat === knownLocalSeat && player.isLocal === true && usable(player.localObservation));
  if (!hero && localRow?.heroId && usable(localRow.heroObservation)) {
    hero = SOURCE_HEROES.get(localRow.heroId) ?? null;
    if (hero) heroFact = observationFact('own', `Own hero: ${hero.name}`, localRow.heroObservation!, localRow.seat);
  }
  if (!hero) limitations.push('Own hero is unknown, stale, or outside this catalogue; no hero-specific ability scaling is inferred.');
  // Compare actual snapshot clocks when HUD and scoreboard both identify own gear.
  const useRow = !!localRow && usable(localRow.inventoryObservation, true)
    && (!usable(context.localInventoryObservation, true) || localRow.inventoryObservation!.capturedAt > context.localInventoryObservation!.capturedAt);
  const ownInventory = useRow ? localRow!.inventory : context.localInventory;
  const inventoryObservation = useRow ? localRow!.inventoryObservation : context.localInventoryObservation;
  const inventoryCompleteness = useRow ? localRow!.inventoryCompleteness : context.localInventoryCompleteness;
  const items = readItems(ownInventory, context, now, 'own', limitations, useRow ? localRow!.seat : undefined);
  if (!usable(inventoryObservation, true)) limitations.push('Own loadout snapshot is missing or stale; missing items are not treated as an empty build.');
  else {
    if (inventoryCompleteness !== 'complete') limitations.push('Own loadout is partial; only confirmed items contribute and absent items are unknown.');
    if (now - inventoryObservation!.capturedAt > 1_000) limitations.push(`Own loadout was last seen ${Math.floor((now - inventoryObservation!.capturedAt) / 1000)}s ago; later hidden changes are not confirmed.`);
  }
  const abilities: KnownAbility[] = [];
  const lockedAbilityIds = new Set<string>();
  const abilitySlots = new Set<number>();
  if (hero) for (const observed of context.localAbilities) {
    if (!usable(observed.observation, true)) continue;
    const expectedId = hero.abilityIds[observed.slot];
    if (observed.abilityId !== null && observed.abilityId !== expectedId) { limitations.push('An observed ability does not match the identified hero and slot; its investment is ignored.'); continue; }
    if (observed.rank !== null && Number.isSafeInteger(observed.rank) && observed.rank >= 0 && observed.rank <= 3 && observed.unlocked !== null) abilitySlots.add(observed.slot);
    if (observed.unlocked === false) lockedAbilityIds.add(expectedId);
    if (observed.rank === null || !Number.isSafeInteger(observed.rank) || observed.rank < 0 || observed.rank > 3 || observed.unlocked !== true) continue;
    const definition = SOURCE_ABILITIES.get(expectedId);
    if (!definition) continue;
    if (definition.properties.some(property => property.cssClass === 'tech_damage' && property.unit === 'percent' && (property.numericValue ?? 0) > 0)) limitations.push(`${definition.name}: percentage-of-health damage terms are omitted from flat-damage comparisons; current target health is not observed.`);
    const fact = observationFact('own', `${definition.name}: observed unlocked, rank ${observed.rank}`, observed.observation);
    abilities.push({ definition, rank: observed.rank, fact, coefficients: abilityCoefficients(definition, observed.rank) });
  }
  if (context.abilityCompleteness !== 'complete' || !usable(context.abilityObservation, true)) limitations.push('Ability investment is incomplete or stale; only explicitly read unlocked ranks are used.');
  const allies: PlayerProfile[] = [], enemies: PlayerProfile[] = [];
  for (const player of context.players) {
    if (player.isLocal === true && usable(player.localObservation)) continue;
    if (knownLocalSeat !== null && player.seat === knownLocalSeat) continue;
    if (!usable(player.teamObservation) || !usable(player.heroObservation) || player.heroId === null || player.team === null) continue;
    const knownHero = SOURCE_HEROES.get(player.heroId);
    if (!knownHero) continue;
    // ScreenTeam is explicitly relative (0 allied, 1 opposing), not an inferred
    // server team number or a requirement to identify all eight players.
    const scope = player.team === 0 ? 'ally' : 'enemy';
    const playerItems = readItems(player.inventory, context, now, scope, limitations, player.seat);
    if (player.inventoryCompleteness !== 'complete' || !usable(player.inventoryObservation, true)) limitations.push(`${knownHero.name}'s ${scope} loadout is partial or stale; unshown gear is unknown.`);
    const stats = collectStats(playerItems);
    const profile = heroProfile(knownHero, observationFact(scope, `${scope === 'ally' ? 'Allied' : 'Enemy'} hero: ${knownHero.name}`, player.heroObservation!, player.seat), playerItems, stats);
    (scope === 'ally' ? allies : enemies).push(profile);
  }
  if (!enemies.length) limitations.push('No fresh identified opponents; counter priorities cannot reflect the actual opposing build.');
  else limitations.push('Enemy ability unlocks, ranks, hit frequency and current damage output are not observed; kit threats are possible source mechanics.');
  if (!allies.length) limitations.push('No fresh identified allies; team overlap and shared damage synergies are unknown.');
  if (context.rosterCompleteness !== 'complete') limitations.push('Roster coverage is partial; no unshown ally or opponent is invented.');
  limitations.push('Quantities use known base parameters and explicit linear spirit terms; conditional uptime, passive overlap and unobserved upgrades are not measured.');
  limitations.push('Health and damage anchors use source starting stats plus read base-item parameters; level growth and actual combined live stats are unobserved.');
  limitations.push('Local comparison weights are transparent heuristics, not measured marginal match value or win probabilities.');
  return { hero, heroFact, items, stats: collectStats(items), abilities, lockedAbilityIds, abilitiesComplete: context.abilityCompleteness === 'complete' && usable(context.abilityObservation, true) && abilitySlots.size === 4, allies, enemies, limitations,
    hasContext: !!hero || items.length > 0 || abilities.length > 0 || allies.length > 0 || enemies.length > 0 };
}

function readItems(items: ScreenInventoryItem[], context: ScreenMatchContext, now: number, scope: Fact['scope'], limitations: string[], seat?: number): KnownItem[] {
  const known: KnownItem[] = [];
  const slots = new Set<number>();
  for (const observed of items) {
    if (!isContextObservationUsable(observed.observation, context, now, { allowSameRound: true }) || !Number.isSafeInteger(observed.slot) || observed.slot < 0 || slots.has(observed.slot)) continue;
    slots.add(observed.slot);
    const definition = observed.itemId ? SOURCE_ITEMS.get(observed.itemId) : null;
    if (!definition) { if (observed.itemId) limitations.push('An observed inventory item is outside the pinned mechanics catalogue; its effects are not invented.'); continue; }
    const quantity = observed.quantity && Number.isSafeInteger(observed.quantity) && observed.quantity > 1 ? `${observed.quantity}× ` : '';
    const fact = observationFact(scope, `${scope === 'own' ? 'Owned' : scope === 'ally' ? 'Allied' : 'Enemy'} item: ${quantity}${definition.name}${observed.variant !== 'base' ? ` (${observed.variant}; base mechanics only)` : ''}`, observed.observation, seat);
    known.push({ definition, observed, fact });
    if (observed.variant !== 'base' || observed.bonusIds === null || (observed.quantity ?? 1) > 1) limitations.push(`${definition.name}: runtime upgrade/bonus/quantity effects are not decoded; its identity informs mechanics, not an invented total stat value.`);
    for (const [index, id] of (observed.bonusIds ?? []).entries()) {
      const bonus = SOURCE_ITEMS.get(id);
      if (!bonus) { limitations.push(`${definition.name} has an unresolved owned bonus; its effects are omitted.`); continue; }
      known.push({ definition: bonus, observed: { ...observed, slot: observed.slot * 100 + index, itemId: id, quantity: 1, variant: 'base', bonusIds: [] },
        fact: observationFact(scope, `${scope === 'own' ? 'Owned' : scope === 'ally' ? 'Allied' : 'Enemy'} bonus: ${bonus.name} on ${definition.name}`, observed.observation, seat) });
    }
  }
  return known;
}

function collectStats(items: KnownItem[]): Stats {
  const result = emptyStats();
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.definition.id) || item.observed.variant !== 'base') continue;
    seen.add(item.definition.id);
    const stats = itemStats(item.definition);
    for (const stat of Object.keys(result) as Stat[]) result[stat] += stats[stat];
  }
  return result;
}

function itemStats(item: ContextItem): Stats {
  const stats = emptyStats();
  for (const property of item.properties) {
    const stat = property.providedPropertyType ? STAT_TYPES[property.providedPropertyType] : null;
    if (!stat || property.section !== 'innate' || property.negativeAttribute || property.requiredUpgradeBits.length
      || property.usageFlags.length || property.numericValue === null || property.numericValue <= 0) continue;
    // Lifesteal's EHealingOutput formula changes its evaluated amount. Its listed
    // base percent is a route-specific comparison feature, never actual healing.
    if (property.scale && !(['bulletLife', 'spiritLife'].includes(stat) && property.scale.specific_stat_scale_type === 'EHealingOutput')) continue;
    stats[stat] += property.numericValue;
  }
  return stats;
}

function abilityCoefficients(ability: ContextAbility, rank: number): KnownAbility['coefficients'] {
  return ability.properties.filter(property => isFlatSpiritParameter(property) && property.numericValue !== null)
    .map(property => {
      const scale = property.scale;
      const spiritScale = scale && (scale.specific_stat_scale_type === 'ETechPower' || (!scale.specific_stat_scale_type && scale.class_name === 'scale_function_tech_damage'));
      let coefficient = spiritScale && typeof scale.stat_scale === 'number' && Number.isFinite(scale.stat_scale) ? scale.stat_scale : 0;
      if (spiritScale && typeof scale.street_brawl_stat_scale === 'number' && Number.isFinite(scale.street_brawl_stat_scale)) coefficient = scale.street_brawl_stat_scale;
      for (const upgrade of ability.upgrades) if (upgrade.tier !== null && upgrade.tier <= rank) {
        for (const change of upgrade.properties) if (change.name === property.name && change.upgradeType === 'EAddToScale' && change.scaleStatFilter === 'ETechPower' && change.numericBonus !== null) coefficient += change.numericBonus;
      }
      return { property, coefficient };
    }).filter(entry => entry.coefficient > 0);
}

function heroProfile(hero: ContextHero, heroFact: Fact, items: KnownItem[], stats: Stats): PlayerProfile {
  // Per-second source values and one-off hit parameters are put on deliberately
  // separate modest comparison anchors. Neither represents measured combat.
  let spiritThreat = 0, healing = 0, control = 0;
  for (const id of hero.abilityIds) {
    const ability = SOURCE_ABILITIES.get(id);
    if (!ability) continue;
    const damage = ability.properties.filter(property => isFlatSpiritParameter(property) && property.numericValue !== null && property.numericValue > 0);
    for (const property of damage) {
      const coefficient = abilityCoefficients(ability, 0).find(entry => entry.property.name === property.name)?.coefficient ?? 0;
      const parameter = property.numericValue! + coefficient * stats.spirit;
      spiritThreat = Math.max(spiritThreat, /DPS|PerSecond/i.test(property.name) ? parameter : parameter / 3);
    }
    for (const property of ability.properties) {
      if (property.numericValue === null || property.numericValue <= 0 || /NonHero|NPC|TurretHeal/i.test(property.name)) continue;
      if (property.cssClass === 'healing' && /HealingPerSecond|LifeDrainPerSecond|ExternalBonusHealthRegen|RegenIncomingDamagePercent|HealingFactor|LifeDrainHealthMult/i.test(property.name)) healing = Math.max(healing, Math.min(property.numericValue / (/Percent|Factor|Mult/.test(property.name) ? 50 : 20), 3));
      if (/StunDuration|SleepDuration|RootDuration|SilenceDuration/i.test(property.name)) control = Math.max(control, Math.min(property.numericValue, 4));
    }
    if (/pull.*(?:in|center)|interrupt.*channel|lift.*(?:air|up)|stun/i.test(ability.description)) control = Math.max(control, 0.75);
  }
  const weaponParameter = hero.weapon?.damagePerSecond;
  const weaponThreat = (typeof weaponParameter === 'number' && Number.isFinite(weaponParameter) && weaponParameter > 0 ? weaponParameter : 35)
    * (1 + stats.weapon / 100) * (1 + stats.fire / 100);
  const meleeThreat = stats.melee > 0 ? startingHeavyMelee(hero) / 3 * (1 + stats.melee / 100) : 0;
  healing += Math.min((stats.bulletLife + stats.spiritLife) / 20 + stats.regen / 10, 4);
  for (const item of items) control = Math.max(control, itemControl(item.definition));
  return { hero, heroFact, items, stats, weaponThreat, spiritThreat, meleeThreat, healing, control };
}

function scoreItem(item: ContextItem, build: Build): Contribution[] {
  const stats = itemStats(item), result: Contribution[] = [];
  const ownFacts = build.items.filter(entry => entry.observed.variant === 'base').map(entry => entry.fact);
  const ownReference = build.items.find(entry => entry.observed.variant === 'base' && (itemStats(entry.definition).weapon || itemStats(entry.definition).fire));
  const ownName = build.hero?.name ?? 'your observed build';
  const heroFact = build.heroFact ? [build.heroFact] : [];
  const catalogFact: Fact = { scope: 'catalog', label: `${item.name}: source base parameters, client ${CONTEXT_CATALOG.clientVersion}` };
  const add = (points: number, reason: string, facts: Fact[]) => { if (Number.isFinite(points) && points !== 0) result.push({ points, reason, facts: [...facts, catalogFact] }); };
  const beforeWeapon = (1 + build.stats.weapon / 100) * (1 + build.stats.fire / 100);
  const afterWeapon = (1 + (build.stats.weapon + stats.weapon) / 100) * (1 + (build.stats.fire + stats.fire) / 100);
  if (stats.weapon || stats.fire) {
    const increase = [stats.weapon ? `${numberText(stats.weapon)}% weapon damage` : '', stats.fire ? `${numberText(stats.fire)}% fire rate` : ''].filter(Boolean).join(' and ');
    const route = ownReference ? `your ${ownReference.definition.name}'s observed weapon investment` : `${ownName}'s weapon firing`;
    add((afterWeapon - beforeWeapon) * 16 * (1 + Math.min(build.stats.bulletLife / 100, 0.5)), `${item.name}'s listed ${increase} supports ${route}.`, [...heroFact, ...ownFacts]);
  }
  if (stats.melee && (build.heroFact || build.items.length)) {
    const ownedMelee = build.items.find(owned => itemStats(owned.definition).melee > 0);
    add(stats.melee / 100 * startingHeavyMelee(build.hero) / 8 * (1 + build.stats.melee / 100), `${item.name}'s listed ${numberText(stats.melee)}% melee damage supports ${ownName}${ownedMelee ? ` with observed ${ownedMelee.definition.name}` : "'s source heavy-melee base"}; landing melee hits is required.`, [...heroFact, ...ownFacts]);
  }
  if (stats.spirit) {
    let coefficientGain = 0;
    for (const ability of build.abilities) {
      // Distinct damage components can hit different targets; take the largest
      // coefficient per ability, not an invented all-components rotation.
      const entry = [...ability.coefficients].sort((a, b) => b.coefficient - a.coefficient)[0];
      if (!entry) continue;
      const gain = stats.spirit * entry.coefficient;
      coefficientGain += gain;
      const unit = /DPS|PerSecond/i.test(entry.property.name) ? 'listed damage/sec' : 'listed damage per trigger';
      add(gain / 8 * (1 + Math.min(build.stats.spiritLife / 100, 0.5)), `+${numberText(stats.spirit)} spirit from ${item.name} gives ${ability.definition.name} rank ${ability.rank} +${numberText(gain)} ${unit} in its source term, before modifiers.`, [ability.fact, ...heroFact, ...ownFacts]);
    }
    if (!coefficientGain && build.hero && build.heroFact) {
      const defined = build.hero.abilityIds.map(id => SOURCE_ABILITIES.get(id)).filter((ability): ability is ContextAbility => !!ability);
      const candidate = defined.find(ability => !build.lockedAbilityIds.has(ability.id) && abilityCoefficients(ability, 0).length > 0);
      if (candidate) add(stats.spirit / 20, `${item.name}'s +${numberText(stats.spirit)} spirit can scale ${build.hero.name}'s ${candidate.name}; that ability's current unlock/rank is unread.`, [build.heroFact]);
    }
    if (build.hero && build.heroFact) {
      const clipScaling = build.hero.scalingStats.find(scaling => scaling.stat === 'EClipSize' && scaling.scalingStat === 'ETechPower' && typeof scaling.scale === 'number' && scaling.scale > 0);
      const baseClip = build.hero.weapon?.clipSize;
      if (clipScaling && typeof clipScaling.scale === 'number' && typeof baseClip === 'number' && baseClip > 0) {
        const gain = stats.spirit * clipScaling.scale;
        const anchor = baseClip + build.stats.spirit * clipScaling.scale;
        add(gain / anchor * 4, `${item.name}'s +${numberText(stats.spirit)} spirit also adds ${numberText(gain)} to ${build.hero.name}'s source clip-size term (${numberText(clipScaling.scale)} per spirit); current magazine rounding is unmodeled.`, [build.heroFact, ...ownFacts]);
      }
    }
  }
  const baseHealth = startingHealth(build.hero);
  if (stats.health && (build.heroFact || build.items.length)) add(stats.health / (baseHealth + build.stats.health) * 12, `${item.name}'s +${numberText(stats.health)} base health supports ${ownName}${build.stats.health ? ` alongside ${numberText(build.stats.health)} health in read base items` : build.hero ? "'s source starting-health anchor" : ` with observed ${build.items[0]!.definition.name}; live max health is unread`}.`, [...heroFact, ...ownFacts]);
  if (stats.regen && (build.heroFact || build.items.length)) add(stats.regen * 0.35, `${item.name}'s listed +${numberText(stats.regen)} regen supports ${ownName}; current health and healing reduction are unobserved.`, [...heroFact, ...ownFacts]);
  if (stats.bulletLife || stats.spiritLife) {
    const coefficient = build.abilities.reduce((total, ability) => total + Math.max(0, ...ability.coefficients.map(entry => entry.coefficient)), 0);
    const points = stats.bulletLife / 100 * beforeWeapon * 5 + stats.spiritLife / 100 * (1 + Math.min(coefficient / 3, 2)) * 4;
    const route = stats.bulletLife && stats.spiritLife ? 'bullet and spirit' : stats.bulletLife ? 'bullet' : 'spirit';
    const investment = build.abilities[0] ? `${build.abilities[0].definition.name} rank ${build.abilities[0].rank}` : build.items[0] ? `your observed ${build.items[0].definition.name}` : ownName;
    if (heroFact.length || ownFacts.length) add(points, `${item.name}'s listed ${route} lifesteal supports ${investment}; healing requires landing that damage.`, [...heroFact, ...ownFacts, ...build.abilities.map(ability => ability.fact)]);
  }
  const enemyTotals = build.enemies.reduce((total, player) => ({ weapon: total.weapon + player.weaponThreat, spirit: total.spirit + player.spiritThreat }), { weapon: 0, spirit: 0 });
  const threatTotal = enemyTotals.weapon + enemyTotals.spirit;
  for (const [stat, route] of [['bulletResist', 'bullet'], ['spiritResist', 'spirit']] as const) {
    if (!stats[stat] || !threatTotal) continue;
    const target = [...build.enemies].sort((a, b) => (route === 'bullet' ? b.weaponThreat - a.weaponThreat : b.spiritThreat - a.spiritThreat))[0];
    if (!target) continue;
    const share = (route === 'bullet' ? enemyTotals.weapon : enemyTotals.spirit) / threatTotal;
    const ownExisting = build.stats[stat];
    const emphasis = Math.min(2.5, Math.sqrt(threatTotal / (70 * build.enemies.length)));
    add(stats[stat] / 100 * share * 18 * emphasis / (1 + ownExisting / 30), `${item.name}'s listed ${numberText(stats[stat])}% ${route} resist answers observed ${target.hero.name}${target.items.length ? ` with ${target.items[0].definition.name}` : "'s source damage kit"}${ownExisting ? `; ${numberText(ownExisting)}% in your read base gear reduces its comparison priority` : ''}.`, [target.heroFact, ...target.items.map(entry => entry.fact), ...ownFacts]);
  }
  if (stats.meleeResist && build.enemies.some(player => player.meleeThreat > 0)) {
    const target = [...build.enemies].sort((a, b) => b.meleeThreat - a.meleeThreat)[0]!;
    const gear = target.items.find(owned => itemStats(owned.definition).melee > 0);
    add(stats.meleeResist / 100 * Math.min(target.meleeThreat / 40, 2) * 10, `${item.name}'s listed ${numberText(stats.meleeResist)}% melee resist answers enemy ${target.hero.name}'s observed ${gear?.definition.name ?? 'melee investment'}; actual melee frequency is unobserved.`, [target.heroFact, ...target.items.map(owned => owned.fact)]);
  }
  const antiHeal = healingReduction(item);
  const hasSpiritTrigger = build.abilities.some(ability => ability.coefficients.length > 0 || ability.definition.properties.some(property => isFlatSpiritParameter(property) && (property.numericValue ?? 0) > 0))
    || build.items.some(owned => owned.definition.properties.some(property => isFlatSpiritParameter(property) && (property.numericValue ?? 0) > 0));
  if (antiHeal.amount && antiHeal.trigger === 'spirit' && build.abilitiesComplete && !hasSpiritTrigger) {
    add(-0.25, `${item.name} needs spirit damage, but your read unlocked abilities and gear provide no supported spirit-damage trigger.`, [...heroFact, ...ownFacts, ...build.abilities.map(ability => ability.fact)]);
  } else if (antiHeal.amount && build.enemies.some(player => player.healing > 0)) {
    const target = [...build.enemies].sort((a, b) => b.healing - a.healing)[0]!;
    const existing = build.items.some(owned => healingReduction(owned.definition).amount > 0);
    const allied = build.allies.find(player => player.items.some(owned => healingReduction(owned.definition).amount > 0));
    const overlap = existing ? 0.35 : allied ? 0.65 : 1;
    const targetHealing = target.items.find(entry => { const value = itemStats(entry.definition); return value.bulletLife || value.spiritLife || value.regen; });
    const healStats = targetHealing ? itemStats(targetHealing.definition) : null;
    const healQuantity = healStats?.bulletLife ? ` (${numberText(healStats.bulletLife)}% listed bullet lifesteal)` : healStats?.spiritLife ? ` (${numberText(healStats.spiritLife)}% listed spirit lifesteal)` : '';
    const healName = targetHealing ? `${targetHealing.definition.name}${healQuantity}` : healingAbilityName(target.hero);
    const requirement = antiHeal.trigger === 'spirit' ? ' Requires your spirit hits.' : antiHeal.trigger === 'bullet' ? ' Requires weapon hits.' : ' Requires applying its effect.';
    add(antiHeal.amount / 100 * Math.min(target.healing, 4) * 7 * overlap, `${item.name}'s ${numberText(antiHeal.amount)}% listed healing reduction targets enemy ${target.hero.name}${healName ? `'s ${healName}` : "'s source healing"}.${requirement}`, [target.heroFact, ...target.items.map(entry => entry.fact), ...heroFact]);
    if (allied) add(0.05, `Allied ${allied.hero.name} already carries healing reduction; extra coverage may overlap rather than stack.`, [allied.heroFact, ...allied.items.filter(entry => healingReduction(entry.definition).amount > 0).map(entry => entry.fact)]);
  }
  if (stats.status && build.enemies.some(player => player.control > 0)) {
    const target = [...build.enemies].sort((a, b) => b.control - a.control)[0]!;
    add(stats.status / 100 * Math.min(target.control, 4) * 6, `${item.name}'s ${numberText(stats.status)}% listed debuff resistance addresses observed ${target.hero.name}'s control kit; actual enemy ranks are unknown.`, [target.heroFact, ...target.items.map(entry => entry.fact)]);
  }
  for (const route of ['spirit', 'bullet'] as const) {
    const reduction = resistanceReduction(item, route);
    if (!reduction) continue;
    const allies = build.allies.filter(player => route === 'spirit' ? player.spiritThreat > 0 : player.weaponThreat > 0);
    const ownSupport = route === 'spirit' ? build.abilities.length > 0 || (build.stats.spirit > 0) : !!build.hero;
    const allySupport = allies.reduce((total, player) => total + Math.min((route === 'spirit' ? player.spiritThreat : player.weaponThreat) / 70, 2), 0);
    const sharedLifesteal = route === 'spirit' ? Math.max(0, ...item.properties.filter(property => property.providedPropertyType === 'MODIFIER_VALUE_TECH_DAMAGE_TAKEN_HEALS_ATTACKER' && property.numericValue !== null && property.numericValue > 0 && !property.negativeAttribute && !property.requiredUpgradeBits.length).map(property => property.numericValue!)) : 0;
    const points = reduction / 100 * (ownSupport ? 7 : 2) + allySupport * reduction / 100 * 8 + allySupport * sharedLifesteal / 100 * 3;
    const ally = allies[0];
    if (ally) add(points, `${item.name}'s listed ${numberText(reduction)}% ${route}-resist reduction${sharedLifesteal ? ` and ${numberText(sharedLifesteal)}% shared spirit-lifesteal term` : ''} can support allied ${ally.hero.name}${ally.items.length ? ` with ${ally.items[0].definition.name}` : "'s source damage kit"}; application and overlap are unmeasured.`, [ally.heroFact, ...ally.items.map(entry => entry.fact), ...heroFact, ...ownFacts]);
    else if (ownSupport) add(points, `${item.name}'s listed ${numberText(reduction)}% ${route}-resist reduction supports ${ownName}'s observed damage route; application is required.`, [...heroFact, ...ownFacts, ...build.abilities.map(ability => ability.fact)]);
  }
  const conditional = item.properties.filter(property => property.numericValue !== null && property.numericValue > 0 && property.usageFlags.includes('ConditionallyApplied') && ['MODIFIER_VALUE_FIRE_RATE', 'MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE'].includes(property.providedPropertyType ?? ''));
  if (conditional.length && build.heroFact) {
    const property = conditional[0]!;
    add(Math.min(property.numericValue! / 100 * beforeWeapon * 4, 2), `${item.name} lists conditional ${property.label ?? property.name} (${numberText(property.numericValue!)}); supports observed ${ownName} only when its ${item.active ? 'activation' : 'trigger'} succeeds.`, [build.heroFact, ...ownFacts]);
  }
  return result;
}

function healingReduction(item: ContextItem): { amount: number; trigger: 'spirit' | 'bullet' | 'other' } {
  const properties = item.properties.filter(property => ['MODIFIER_VALUE_HEAL_AMP_RECEIVE_PERCENT', 'MODIFIER_VALUE_HEAL_AMP_REGEN_PERCENT'].includes(property.providedPropertyType ?? '') && property.numericValue !== null && property.numericValue < 0 && !property.negativeAttribute && property.requiredUpgradeBits.length === 0);
  return { amount: Math.max(0, ...properties.map(property => -property.numericValue!)), trigger: /spirit damage/i.test(item.description) ? 'spirit' : /bullet|shoot|weapon/i.test(item.description) ? 'bullet' : 'other' };
}
function resistanceReduction(item: ContextItem, route: 'spirit' | 'bullet'): number {
  const type = route === 'spirit' ? 'MODIFIER_VALUE_TECH_RESIST_REDUCTION' : 'MODIFIER_VALUE_BULLET_AND_MELEE_RESIST_REDUCTION';
  return Math.max(0, ...item.properties.filter(property => property.providedPropertyType === type && property.numericValue !== null && property.numericValue < 0 && !property.negativeAttribute && property.requiredUpgradeBits.length === 0).map(property => -property.numericValue!));
}
function itemControl(item: ContextItem): number {
  return Math.max(0, ...item.properties.filter(property => /StunDuration|SleepDuration|RootDuration|SilenceDuration/i.test(property.name) && property.numericValue !== null && property.numericValue > 0 && !property.requiredUpgradeBits.length).map(property => Math.min(property.numericValue!, 4)));
}
function healingAbilityName(hero: ContextHero): string | null {
  return hero.abilityIds.map(id => SOURCE_ABILITIES.get(id)).find(ability => ability?.properties.some(property => property.cssClass === 'healing' && (property.numericValue ?? 0) > 0 && !/NonHero|NPC/i.test(property.name)))?.name ?? null;
}
function startingHealth(hero: ContextHero | null): number {
  const value = hero?.startingStats.find(stat => stat.name === 'max_health')?.value;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 750;
}
function startingHeavyMelee(hero: ContextHero | null): number {
  const value = hero?.startingStats.find(stat => stat.name === 'heavy_melee_damage')?.value;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 116;
}
function isFlatSpiritParameter(property: ContextProperty): boolean {
  return property.cssClass === 'tech_damage' && property.unit !== 'percent'
    && !/Self|HealthToDamage|Percent|Percentage|Pct|Multiplier|DamageScale/.test(property.name);
}
function observationFact(scope: Fact['scope'], label: string, observation: ScreenContextObservation, playerSeat?: number): Fact {
  return { scope, label, observedAt: observation.capturedAt, ...(playerSeat === undefined ? {} : { playerSeat }) };
}
function deduplicateFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts.filter(fact => { const key = `${fact.scope}|${fact.playerSeat ?? ''}|${fact.label}|${fact.observedAt ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
function quantityNames(names: string[]): string {
  const quantities = new Map<string, number>();
  for (const name of names) quantities.set(name, (quantities.get(name) ?? 0) + 1);
  return [...quantities].map(([name, quantity]) => quantity > 1 ? `${quantity}× ${name}` : name).join(', ');
}
function shortDescription(description: string): string { return description.replace(/\s+/g, ' ').trim().slice(0, 150); }
