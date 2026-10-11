import { CONTEXT_CATALOG, contextCatalogCompatible } from '../shared/context-catalog';
import type { ContextAbility, ContextCatalog, ContextUpgradeDefinition } from '../shared/context-catalog';
import { SCREEN_CAPTURE_FRESHNESS_MS, SCREEN_CONTEXT_MAX_AGE_MS } from '../shared/screen-reading';
import type { ScreenAbilityAdvice, ScreenAbilityState, ScreenContextObservation, ScreenMatchContext } from '../shared/screen-reading';
import type { Catalog } from '../shared/types';

function usable(observation: ScreenContextObservation | null | undefined, context: ScreenMatchContext, now: number, maximumAge = SCREEN_CONTEXT_MAX_AGE_MS): boolean {
  return !!observation && !!context.sessionId && !!observation.frameId && observation.sessionId === context.sessionId
    && observation.invalidatedAt == null
    && observation.capturedAt <= now && observation.receivedAt >= observation.capturedAt && observation.receivedAt <= now
    && now - observation.capturedAt <= maximumAge && observation.confidence >= .85 && observation.confidence <= 1
    && (observation.round == null || context.round == null || observation.round === context.round);
}
function plain(value: string): string { return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function propertyLabel(value: string): string { return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^Ability /, ''); }
function effect(upgrade: ContextUpgradeDefinition): string {
  if (upgrade.description) return plain(upgrade.description);
  const properties = upgrade.properties.filter(property => property.numericBonus !== null && property.scaleStatFilter === null).slice(0, 2);
  return properties.length ? properties.map(property => `${propertyLabel(property.name)}: ${property.bonus}${property.unit === 'percent' ? '%' : property.unit === 'seconds' ? 's' : ''}`).join('; ')
    : 'The source describes this tier, but its full effects need checking in game.';
}
interface Candidate { observed: ScreenAbilityState; ability: ContextAbility; upgrade: ContextUpgradeDefinition; points: number; reason: string; cost: number | null }

/**
 * A source-effect priority among actually observed next tiers, never a typical
 * build substituted for ranks. Only a fresh visible tier price and own AP can
 * authorize an "upgrade" label. Costs shown on unbought tiers are not ranks.
 */
export function evaluateAbilityUpgrade(context: ScreenMatchContext, catalog: Catalog, now: number,
  definitions: ContextCatalog = CONTEXT_CATALOG): ScreenAbilityAdvice | null {
  if (context.viewMode !== 'participant' || !usable(context.observations.viewMode, context, now)
    || context.localHeroId === null || !usable(context.observations.localHeroId, context, now)
    || context.phase === 'finished') return null;
  const withheld = (title: string, reason: string): ScreenAbilityAdvice => ({ kind: 'withheld', slot: null, abilityId: null,
    title, reasons: [reason], limitations: [], cost: null, availablePoints: null });
  if (!contextCatalogCompatible(catalog, definitions)) return withheld('Ability definitions need updating', 'The cached ability definitions do not match this item catalogue.');
  const hero = definitions.heroes.find(entry => entry.id === context.localHeroId);
  if (!hero) return withheld('Your hero’s abilities are not identified', 'The observed hero does not resolve to the cached definitions.');
  const ownPlayer = context.localSeat === null || !usable(context.observations.localSeat, context, now) ? undefined
    : context.players.find(player => player.seat === context.localSeat && player.isLocal === true && player.heroId === hero.id
      && usable(player.localObservation, context, now) && usable(player.heroObservation, context, now));
  const rosterInventoryAt = ownPlayer?.inventoryObservation?.capturedAt ?? -1;
  const hudInventoryAt = context.localInventoryObservation?.capturedAt ?? -1;
  const inventory = ownPlayer && usable(ownPlayer.inventoryObservation, context, now) && rosterInventoryAt >= hudInventoryAt
    ? ownPlayer.inventory : context.localInventory;
  const ownItems = inventory.filter(item => item.itemId && usable(item.observation, context, now))
    .map(item => definitions.items.find(entry => entry.id === item.itemId)).filter(item => !!item);
  const weaponBuild = ownItems.filter(item => item.category === 'weapon' || item.tags.includes('weapon')).length;
  const spiritBuild = ownItems.filter(item => item.category === 'spirit' || item.tags.includes('spirit')).length;
  const allies = context.localTeam === null ? [] : context.players.filter(player => player.team === context.localTeam && player.isLocal !== true && usable(player.heroObservation, context, now));
  const alliedWeapon = allies.filter(player => definitions.heroes.find(entry => entry.id === player.heroId)?.tags.includes('weapon')).length;
  const candidates: Candidate[] = [];
  const knownSlots = new Set<number>();
  for (const observed of context.localAbilities) {
    if (!usable(observed.observation, context, now) || knownSlots.has(observed.slot) || observed.unlocked !== true
      || observed.rank === null || !Number.isInteger(observed.rank) || observed.rank < 0 || observed.rank > 3) continue;
    const ability = definitions.abilities.find(entry => entry.heroId === hero.id && entry.slot === observed.slot && entry.id === hero.abilityIds[observed.slot]);
    if (!ability || (observed.abilityId !== null && observed.abilityId !== ability.id)) continue;
    knownSlots.add(observed.slot);
    if (observed.rank === 3) continue;
    const upgrade = ability.upgrades.find(entry => entry.tier === observed.rank! + 1);
    if (!upgrade) continue;
    const text = `${upgrade.description ?? ''} ${upgrade.properties.map(property => `${property.name} ${property.scaleStatFilter ?? ''}`).join(' ')}`;
    let points = 1;
    let reason = 'This is the next tier after the rank read from your ability panel.';
    const gunEffect = /weapon|bullet|fire.?rate|fixation.?stacks|max.?stacks/i.test(text);
    const spiritEffect = /spirit|tech.?power|proc.?damage|ability.?damage/i.test(text);
    if (gunEffect) {
      points += 1 + Math.min(weaponBuild, 4) * .55 + (hero.tags.includes('weapon') ? .6 : 0);
      reason = weaponBuild ? `Its effects support the ${weaponBuild} weapon items read in your build.` : 'Its effects support your hero’s weapon damage route.';
    }
    if (spiritEffect) {
      points += .8 + Math.min(spiritBuild, 4) * .55 + (hero.tags.includes('spirit') ? .6 : 0);
      if (spiritBuild) reason = `Its effects support the ${spiritBuild} spirit items read in your build.`;
    }
    if (/bullet.?resist.?reduction/i.test(text) && alliedWeapon) {
      points += Math.min(alliedWeapon, 3) * .7;
      reason = `Its bullet resistance reduction can also support ${alliedWeapon} observed allied weapon hero${alliedWeapon === 1 ? '' : 'es'}.`;
    }
    if (/sleep|stun|root|silence|disarm|slow/i.test(text)) points += .5;
    if (/lifesteal|heal|dispel|evasion|shield/i.test(text)) points += .6;
    if (/cooldown/i.test(text)) points += .4;
    const cost = observed.nextUpgradeCost != null && Number.isInteger(observed.nextUpgradeCost) && observed.nextUpgradeCost >= 0 && observed.nextUpgradeCost <= 100 ? observed.nextUpgradeCost : null;
    candidates.push({ observed, ability, upgrade, points, reason, cost });
  }
  if (!candidates.length) return withheld('Next ability upgrade needs a reading',
    knownSlots.size === 4 ? 'All four observed abilities are fully upgraded.' : 'Open your ability upgrade view so the companion can read actual ranks and the next tier.');
  const pointObservation = context.observations.localAbilityPoints;
  const freshPoints = context.localAbilityPoints !== null && Number.isInteger(context.localAbilityPoints) && context.localAbilityPoints >= 0
    && usable(pointObservation, context, now, SCREEN_CAPTURE_FRESHNESS_MS) ? context.localAbilityPoints : null;
  candidates.sort((left, right) => right.points - left.points || left.observed.slot - right.observed.slot);
  const affordable = candidates.filter(candidate => candidate.cost !== null && freshPoints !== null && candidate.cost <= freshPoints
    && usable(candidate.observed.observation, context, now, SCREEN_CAPTURE_FRESHNESS_MS));
  const selected = affordable[0] ?? candidates[0];
  const upgradeNow = affordable.length > 0;
  const limitations = ['Priority compares source effects with observed build information; it is not a proven optimal upgrade order.'];
  if (knownSlots.size !== 4 || context.abilityCompleteness !== 'complete') limitations.push('Some ability ranks are unread; the comparison covers only identified next tiers.');
  if (now - selected.observed.observation.capturedAt > 1000) limitations.push(`Ability rank was last seen ${Math.ceil((now - selected.observed.observation.capturedAt) / 1000)} seconds ago.`);
  if (!upgradeNow) limitations.push(selected.cost === null ? 'The next tier’s actual price is unread. Check its cost in game.'
    : freshPoints === null ? 'Your current unspent ability points need a fresh reading before spending.' : 'The selected next tier costs more than the currently observed points.');
  return { kind: upgradeNow ? 'upgrade' : 'plan', slot: selected.observed.slot, abilityId: selected.ability.id,
    title: `${upgradeNow ? 'Consider upgrading' : 'Next upgrade to consider'}: ${selected.ability.name} · tier ${selected.upgrade.tier}`,
    reasons: [effect(selected.upgrade), selected.reason], limitations, cost: selected.cost, availablePoints: freshPoints };
}
