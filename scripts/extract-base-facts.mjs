#!/usr/bin/env node
// Prints the PINNED_BASE_FACTS table entries for src/screen/screen-advice.ts
// from a saved Valve-asset items.json (data/catalog-sources/client-*/items.json).
// Usage: node scripts/extract-base-facts.mjs <items.json>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CATEGORIES = ['weapon', 'vitality', 'spirit']; // same item filter as sync-catalog.mjs

/** Allowlisted own innate properties -> fixed stat (summed when several rows map to one stat). */
const FIXED = {
  TechPower: 'spiritPower', SpiritPower: 'spiritPower', SpiritPowerInnate: 'spiritPower', BonusSpiritForChargedAbilities: 'spiritPower', WeaponPower: 'weaponPower', BonusHealth: 'health', BonusFireRate: 'fireRate',
  BulletResist: 'bulletResist', TechResist: 'spiritResist', BonusHealthRegen: 'regen', StatusResistancePercent: 'statusResist', InnateStatusResistancePercent: 'statusResist',
};
/** Fixed stat -> descriptive trait. */
const TRAIT_OF = {
  health: 'health', spiritPower: 'spirit', weaponPower: 'weapon', fireRate: 'weapon', bulletResist: 'bullet-resist',
  spiritResist: 'spirit-resist', regen: 'healing', statusResist: 'control-resist',
};
const LIFESTEAL_TRAIT = { MODIFIER_VALUE_BULLET_LIFESTEAL: 'bullet-lifesteal', MODIFIER_VALUE_TECH_LIFESTEAL: 'spirit-lifesteal' };

const number = raw => typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
const explicit = value => value !== null && value !== undefined;

export function extractBaseFacts(items) {
  const entries = [];
  for (const item of items) {
    if (item.type !== 'upgrade' || item.shopable !== true || item.shop_version !== 0 || !CATEGORIES.includes(item.item_slot_type)) continue;
    const fixed = {}, traits = new Set();
    for (const [name, property] of Object.entries(item.properties ?? {})) {
      const raw = explicit(property.street_brawl_value) ? property.street_brawl_value : property.value;
      const value = number(raw);
      if (!(value > 0) || property.negative_attribute === true || property.conditional || property.required_upgrade_bits?.length) continue;
      if (property.tooltip_section !== 'innate' || property.usage_flags?.length) continue;
      const lifesteal = LIFESTEAL_TRAIT[property.provided_property_type];
      if (lifesteal) traits.add(lifesteal);
      const stat = FIXED[name];
      if (!stat || property.scale_function) continue;
      fixed[stat] = (fixed[stat] ?? 0) + value;
      traits.add(TRAIT_OF[stat]);
    }
    const active = item.is_active_item === true;
    if (!Object.keys(fixed).length && !traits.size && !active) continue;
    entries.push([item.class_name, { fixed, traits: [...traits].sort(), active }]);
  }
  return entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

export function formatEntries(entries) {
  return entries.map(([id, facts]) => `  ${JSON.stringify(id)}: ${JSON.stringify(facts)},`).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) { console.error('Usage: node scripts/extract-base-facts.mjs <items.json>'); process.exit(2); }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  console.log(formatEntries(extractBaseFacts(Array.isArray(raw) ? raw : Object.values(raw))));
}
