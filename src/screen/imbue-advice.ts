import { CONTEXT_CATALOG } from '../shared/context-catalog';

/**
 * Which of your hero's abilities an "imbue" item should go on, from the ability's own
 * numbers (Street Brawl values where they differ). A rule of thumb per item effect, not
 * measured imbue win rates.
 */
type Effect = 'cooldown' | 'cooldown-damage' | 'duration' | 'echo' | 'charge-up' | 'range' | 'range-damage' | 'charges' | 'power';
const IMBUE_ITEMS: Record<string, Effect> = {
  upgrade_magic_tempo: 'cooldown', // Compress Cooldown
  upgrade_shivas_bracelet: 'cooldown-damage', // Frostbite Charm
  upgrade_arcane_extension: 'duration', // Duration Extender
  upgrade_ability_power_shard: 'echo', // Echo Shard (non-ultimate)
  upgrade_ethereal_bullets: 'charge-up', // Mercurial Magnum
  upgrade_quick_silver: 'charge-up', // Quicksilver Reload
  upgrade_magic_reach: 'range', // Mystic Expansion
  upgrade_bulletshredimbue: 'range-damage', // Ballistic Enchantment
  upgrade_omnicharge_pendant: 'charges', // Omnicharge Signet (non-ultimate)
  upgrade_magic_storm: 'power', // Surge of Power
};

interface AbilityStats { name: string; ultimate: boolean; cooldown: number; duration: number; range: number; charges: number; damage: boolean; spirit: boolean }
type Property = { name: string; numericValue: number | null; scale?: { specific_stat_scale_type?: string } | null };

function stats(heroId: string): AbilityStats[] {
  const abilities = (CONTEXT_CATALOG.abilities as unknown as { heroId: string; slot: number; name: string; abilityType: string; properties: Property[] }[])
    .filter(ability => ability.heroId === heroId).sort((a, b) => a.slot - b.slot);
  return abilities.map(ability => {
    const value = (pattern: RegExp) => Math.max(0, ...ability.properties.filter(property => pattern.test(property.name) && Number.isFinite(property.numericValue)).map(property => property.numericValue!));
    const cooldown = value(/^AbilityCooldown$/) || value(/^AbilityCooldownBetweenCharge$/);
    return { name: ability.name, ultimate: ability.abilityType === 'ultimate', cooldown,
      duration: value(/^AbilityDuration$/), range: Math.max(value(/^AbilityCastRange$/), value(/Radius$/)), charges: value(/^AbilityCharges$/),
      damage: ability.properties.some(property => /^(Damage|DPS|ProcDamage)$|Damage$/.test(property.name) && (property.numericValue ?? 0) > 0),
      spirit: ability.properties.some(property => property.scale?.specific_stat_scale_type === 'ETechPower') };
  });
}

export function isImbueItem(itemId: string): boolean { return itemId in IMBUE_ITEMS; }

/** The suggested ability and a short reason, or null when the item does not imbue or the hero is unknown. */
export function imbueTarget(itemId: string, heroId: string | null): { ability: string; reason: string } | null {
  const effect = IMBUE_ITEMS[itemId];
  if (!effect || !heroId) return null;
  // Imbues need an active ability: passives have no cooldown.
  const active = stats(heroId).filter(ability => ability.cooldown > 0);
  if (!active.length) return null;
  const normal = active.filter(ability => !ability.ultimate);
  const pick = (list: AbilityStats[], score: (ability: AbilityStats) => number) => [...(list.length ? list : active)].sort((a, b) => score(b) - score(a))[0]!;
  let target: AbilityStats; let reason: string;
  switch (effect) {
    case 'cooldown':
      target = pick(active, ability => ability.cooldown); reason = `longest cooldown (${target.cooldown}s), so it gains the most`; break;
    case 'cooldown-damage':
      target = pick(active.filter(ability => ability.damage), ability => ability.cooldown); reason = 'damaging ability with the longest cooldown'; break;
    case 'duration':
      target = pick(active.filter(ability => ability.duration > 0), ability => ability.duration); reason = `longest-lasting effect (${target.duration}s)`; break;
    case 'echo':
      target = pick(normal, ability => ability.cooldown + (ability.damage ? 10 : 0)); reason = `resets its ${target.cooldown}s cooldown; ultimates are not allowed`; break;
    case 'charge-up':
      target = pick(normal, ability => -ability.cooldown); reason = `shortest cooldown (${target.cooldown}s), so it triggers most often`; break;
    case 'range':
      target = pick(active.filter(ability => ability.range > 0), ability => ability.range + (ability.damage ? 5 : 0)); reason = 'its range or area is what lands hits'; break;
    case 'range-damage':
      // Projectiles list no cast range: any damaging ability qualifies, longer reach first.
      target = pick(active.filter(ability => ability.damage), ability => ability.range - ability.cooldown / 10); reason = 'longer reach on a damaging ability'; break;
    case 'charges':
      target = pick(normal, ability => (ability.charges > 0 ? 100 : 0) + (ability.damage ? 10 : 0) - ability.cooldown / 10);
      reason = target.charges > 0 ? 'already uses charges, so it gains extra ones' : 'a damaging ability you can then cast more often'; break;
    default:
      target = pick(active.filter(ability => ability.damage && ability.spirit), ability => -ability.cooldown); reason = 'spirit damage on a short cooldown, so the bonus is used often';
  }
  return { ability: target.name, reason };
}
