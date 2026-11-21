#!/usr/bin/env node
/** Offline deterministic mechanics extract from the already pinned public source archive. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readable } from './sync-catalog.mjs';
import { verifyStaticContextGlyphs } from './sync-context-glyphs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'data/context-catalog.json';
const ABILITY_LABELS_OUTPUT = 'src/renderer/ability-labels.json';
const PINNED_NAMES = ['steam-info', 'items', 'heroes', 'generic-data'];
const AUX_COMMIT = '554634163b8c55d4e3fde34fe1a277357bcd3d98';
const AUX_ARCHIVE = `context-sources/steamtracking-${AUX_COMMIT}`;
function ensure(value, message) { if (!value) throw new Error(message); }
export function contextHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function scalar(value) {
  if (value === null || value === undefined) return null;
  ensure((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 512), 'Invalid source scalar');
  return value;
}
function stringOrNull(value) { return typeof value === 'string' && value ? readable(value) : null; }
function strings(value) { return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : []; }
export function numericScalar(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:m|s|%)?$/.test(value.trim())) return null;
  const numeric = Number(value.trim().replace(/[ms%]$/, '')); return Number.isFinite(numeric) ? numeric : null;
}
function sourceUnit(property, value) {
  if (property.display_units === 'EDisplayUnit_MetersPerSecond') return 'meters-per-second';
  if (property.display_units === 'EDisplayUnit_Meters') return 'meters';
  if (property.postfix === '%') return 'percent';
  if (property.postfix === 's') return 'seconds';
  if (property.postfix === 'm' || (typeof value === 'string' && /m$/.test(value))) return 'meters';
  if (typeof value === 'string' && /s$/.test(value)) return 'seconds';
  if (typeof value === 'string' && /%$/.test(value)) return 'percent';
  return numericScalar(value) === null ? null : 'source';
}
export function normalizeContextProperty(name, source, sourcePointer) {
  ensure(source && typeof source === 'object' && !Array.isArray(source), 'Invalid property object');
  const normalValue = scalar(source.value);
  const streetBrawlValue = scalar(source.street_brawl_value);
  const modeOverride = source.street_brawl_value !== null && source.street_brawl_value !== undefined;
  const effectiveValue = modeOverride ? streetBrawlValue : normalValue;
  return {
    name, label: stringOrNull(source.label ?? source.postvalue_label), normalValue, streetBrawlValue, effectiveValue, modeOverride,
    numericValue: numericScalar(effectiveValue), unit: sourceUnit(source, effectiveValue), postfix: stringOrNull(source.postfix),
    displayUnits: stringOrNull(source.display_units), section: stringOrNull(source.tooltip_section),
    providedPropertyType: stringOrNull(source.provided_property_type), usageFlags: strings(source.usage_flags),
    conditional: stringOrNull(source.conditional), negativeAttribute: source.negative_attribute === true,
    requiredUpgradeBits: strings(source.required_upgrade_bits), scale: source.scale_function ?? null,
    cssClass: stringOrNull(source.css_class), sourcePointer,
  };
}
function propertyUpgrade(source, record, sourcePointer) {
  ensure(typeof source.name === 'string' && source.name.length > 0 && source.name.length < 120, 'Invalid property upgrade name');
  const bonus = scalar(source.bonus);
  return { name: source.name, bonus, numericBonus: numericScalar(bonus), unit: sourceUnit(record.properties?.[source.name] ?? {}, bonus),
    upgradeType: stringOrNull(source.upgrade_type), scaleStatFilter: stringOrNull(source.scale_stat_filter), sourcePointer };
}
function upgradesFor(record, pointer, ability) {
  return (record.upgrades ?? []).map((upgrade, index) => ({ index, tier: ability ? index + 1 : null,
    description: ability ? stringOrNull(record.description?.[`t${index + 1}_desc`]) : null,
    properties: (upgrade.property_upgrades ?? []).map((property, position) => propertyUpgrade(property, record, `${pointer}/upgrades/${index}/property_upgrades/${position}`)),
  }));
}
function propertiesFor(record, pointer) {
  const referenced = new Set(importantProperties(record));
  for (const section of record.tooltip_details?.info_sections ?? []) {
    strings(section.basic_properties).forEach(name => referenced.add(name));
    if (section.property_upgrade_required) referenced.add(section.property_upgrade_required);
  }
  for (const upgrade of record.upgrades ?? []) for (const property of upgrade.property_upgrades ?? []) referenced.add(property.name);
  for (const property of record.corrupted_info?.property_upgrades ?? []) referenced.add(property.name);
  return Object.entries(record.properties ?? {}).filter(([name, property]) => {
    const effective = property.street_brawl_value ?? property.value;
    const numeric = numericScalar(effective);
    return referenced.has(name) || property.street_brawl_value !== null && property.street_brawl_value !== undefined
      || strings(property.required_upgrade_bits).length > 0 || property.conditional
      || Number(property.scale_function?.stat_scale ?? 0) !== 0
      || numeric !== 0 && effective !== property.disable_value;
  }).map(([name, property]) => normalizeContextProperty(name, property, `${pointer}/properties/${name}`));
}
function indexRecords(records, name) {
  ensure(Array.isArray(records) && records.length > 0 && records.length <= 1000, `Invalid ${name} source records`);
  const map = new Map();
  records.forEach((record, index) => {
    // An unused source weapon uses a literal '+' in its class name. Selected
    // asset filenames are validated separately; indexing does not create paths.
    ensure(record && typeof record.class_name === 'string' && /^[a-zA-Z0-9_+.-]+$/.test(record.class_name), `Invalid ${name} identity`);
    ensure(Number.isSafeInteger(record.id) && record.id >= 0 && !map.has(record.class_name), `Duplicate/invalid ${name} ID`);
    map.set(record.class_name, { record, index });
  });
  return map;
}
function sourceAsset(value) {
  ensure(typeof value === 'string', 'Missing public asset');
  const url = new URL(value);
  ensure(url.protocol === 'https:' && url.hostname === 'assets-bucket.deadlock-api.com' && !url.port && !url.username && !url.password && !url.search && !url.hash, 'Unexpected public asset origin');
  ensure(/^\/assets-api-res\/images\/(?:heroes|abilities)\/[a-zA-Z0-9_/-]+\.png$/.test(url.pathname), 'Unexpected public asset path');
  return url.href;
}
function importantProperties(record) {
  const result = [];
  for (const section of record.tooltip_details?.info_sections ?? []) {
    for (const block of section.properties_block ?? []) for (const property of block.properties ?? []) {
      if (typeof property.important_property === 'string') result.push(property.important_property);
    }
  }
  return [...new Set(result)];
}
const RESEARCH = [
  { id: 'saved-hero-rollup', sourceFile: 'street-brawl-hero-stats.json', mode: 'street_brawl', grain: 'hero aggregate; underlying day-grained rollup', minUnixTimestamp: 1790974791, maxUnixTimestamp: null, clientVersion: null, status: 'descriptive-only', limitations: ['No upper timestamp, account, or rank filter.', 'No installed-build attribution; shared filters round time boundaries.', 'Historical population context only; not hero-conditioned item marginal values.'] },
  { id: 'saved-paige-rat-items', sourceFile: 'street-brawl-item-stats.json', mode: 'street_brawl', grain: 'hero/item acquisition aggregate; repeated purchases can contribute multiple observations', minUnixTimestamp: null, maxUnixTimestamp: null, clientVersion: null, status: 'descriptive-only', limitations: ['Requested hero IDs 84, 67, 71; 71 was incorrectly identified as Graves.', 'No unchosen offers, before-pick inventory, round, or enhanced-variant grain.', 'Raw aggregates lack a full provenance envelope; not imported into the live scorer.'] },
  { id: 'saved-graves-items', sourceFile: 'graves-brawl-items.json', mode: 'street_brawl', grain: 'hero 76/item acquisition aggregate', minUnixTimestamp: null, maxUnixTimestamp: null, clientVersion: null, status: 'descriptive-only', limitations: ['Correct Graves identity but no pinned patch attribution.', 'Selections and outcomes are observational, not causal item effects.', 'No unchosen offers or action propensities; not imported into the live scorer.'] },
  { id: 'saved-pre-rat-window', sourceFile: 'brawl-pre-rat-stats.json', mode: 'street_brawl', grain: 'hero aggregate; requested prerelease time window', minUnixTimestamp: null, maxUnixTimestamp: null, clientVersion: null, status: 'excluded', limitations: ['Contains 2,956 Rat King appearances despite the requested prerelease window.', 'Temporal attribution remains unresolved; cannot establish patch-specific priors.'] },
  { id: 'geist-bounded-probe', sourceFile: 'docs/research-evidence.md#direct-api-observations', mode: 'street_brawl', grain: 'hero 4/item and ability-order aggregates', minUnixTimestamp: 1790726400, maxUnixTimestamp: null, clientVersion: null, status: 'descriptive-only', limitations: ['Research reported 172 item rows and 39 ability orders; responses are not a cached training dataset here.', 'No round/enchanted bundle conditioning or unchosen choices.', 'Win rates/orders are historical associations, not verified best actions.'] },
];

export function extractAbilityUnlockDefinitions(text) {
  ensure(typeof text === 'string' && text.length <= 8 * 1024 * 1024, 'Invalid pinned ability source');
  const headers = [...text.matchAll(/^\t([a-zA-Z0-9_+.-]+)[ \t]*=[ \t]*\r?\n[ \t]*\{/gm)];
  const result = new Map();
  headers.forEach((match, index) => {
    ensure(!result.has(match[1]), 'Ambiguous top-level ability definition');
    const block = text.slice(match.index, headers[index + 1]?.index ?? text.length);
    const field = name => { const found = block.match(new RegExp(`^\\t\\t${name}[ \\t]*=[ \\t]*(\\d+)[ \\t]*$`, 'm')); return found ? Number(found[1]) : null; };
    result.set(match[1], { abilityPointsCost: field('m_nAbilityPointsCost'), abilityUnlocksCost: field('m_nAbillityUnlocksCost'),
      sourcePointer: `abilities.vdata#${match[1]}/m_nAbilityPointsCost,m_nAbillityUnlocksCost` });
  });
  return result;
}
export function buildContextCatalog({ catalog, manifest, raw, auxiliary, staticGlyphs }) {
  ensure(manifest.schemaVersion === 1 && String(manifest.clientVersion) === catalog.clientVersion && String(manifest.sourceRevision) === catalog.revision, 'Context pin/catalog mismatch');
  ensure(String(raw['steam-info'].client_version) === catalog.clientVersion && String(raw['steam-info'].source_revision) === catalog.revision, 'Context source metadata mismatch');
  ensure(Array.isArray(catalog.heroes) && catalog.heroes.length > 0 && Array.isArray(catalog.items) && catalog.items.length > 0, 'Missing public catalog');
  const itemIndex = indexRecords(raw.items, 'item'); const heroIndex = indexRecords(raw.heroes, 'hero');
  const selectedIds = new Set(catalog.items.map(item => item.id)); const abilities = []; const seenAbilities = new Set();
  const unlockDefinitions = auxiliary ? extractAbilityUnlockDefinitions(auxiliary.abilityText) : new Map();
  const heroes = catalog.heroes.map(base => {
    const entry = heroIndex.get(base.id); ensure(entry && String(entry.record.id) === base.numericId, 'Hero ID mapping mismatch');
    const { record, index } = entry; const pointer = `heroes.json#/${index}`;
    ensure(record.player_selectable === true && record.disabled !== true && record.needs_testing !== true && record.prerelease_only !== true, 'Unsupported hero in context catalog');
    const abilityIds = [0, 1, 2, 3].map(slot => {
      const sourceSlot = `signature${slot + 1}`; const abilityEntry = itemIndex.get(record.items?.[sourceSlot]);
      ensure(abilityEntry?.record.type === 'ability', 'Missing hero signature ability');
      const ability = abilityEntry.record; const abilityPointer = `items.json#/${abilityEntry.index}`;
      ensure(!seenAbilities.has(ability.class_name), 'Shared signature ID requires an explicit multi-hero schema'); seenAbilities.add(ability.class_name);
      ensure((ability.heroes ?? []).includes(record.id) || ability.hero === record.id, 'Signature hero ownership mismatch');
      abilities.push({ id: ability.class_name, numericId: String(ability.id), heroId: base.id, slot, sourceSlot,
        name: readable(ability.name), description: readable(ability.description?.desc), summary: readable(ability.description?.quip),
        iconFile: `abilities/${ability.class_name}.png`, imageUrl: sourceAsset(ability.image),
        startTrainedDefinition: typeof ability.start_trained === 'boolean' ? ability.start_trained : null, abilityType: stringOrNull(ability.ability_type),
        unlockDefinition: unlockDefinitions.get(ability.class_name) ?? null,
        behaviours: strings(ability.behaviours), importantProperties: importantProperties(ability), properties: propertiesFor(ability, abilityPointer),
        upgrades: upgradesFor(ability, abilityPointer, true), tooltipSections: (ability.tooltip_details?.info_sections ?? []).map(section => ({ text: readable(section.loc_string), requiredPropertyUpgrade: stringOrNull(section.property_upgrade_required) })), sourcePointer: abilityPointer });
      return ability.class_name;
    });
    const portraits = [['hero-card', 'icon_hero_card', 'card'], ['hero-small', 'icon_image_small', 'small'], ['hero-vertical', 'top_bar_vertical_image', 'vertical']].map(([role, key, variant]) => ({ role, file: `heroes/${base.id}--${variant}.png`, sourceUrl: sourceAsset(record.images?.[key]) }));
    const weaponEntry = itemIndex.get(record.items?.weapon_primary); const weaponInfo = weaponEntry?.record.weapon_info;
    const weapon = weaponInfo ? { id: weaponEntry.record.class_name, numericId: String(weaponEntry.record.id),
      bulletDamage: numericScalar(weaponInfo.bullet_damage), cycleTime: numericScalar(weaponInfo.cycle_time), bullets: numericScalar(weaponInfo.bullets),
      burstShotCount: numericScalar(weaponInfo.burst_shot_count), clipSize: numericScalar(weaponInfo.clip_size), reloadDuration: numericScalar(weaponInfo.reload_duration),
      damagePerSecond: numericScalar(weaponInfo.damage_per_second), damagePerSecondWithReload: numericScalar(weaponInfo.damage_per_second_with_reload), shotsPerSecond: numericScalar(weaponInfo.shots_per_second),
      ratesAreProviderDerived: true, sourcePointer: `items.json#/${weaponEntry.index}/weapon_info` } : null;
    return { id: base.id, numericId: String(record.id), name: base.name, role: readable(record.description?.role), playstyle: readable(record.description?.playstyle), tags: base.tags,
      portraits, abilityIds, startingStats: Object.entries(record.starting_stats ?? {}).map(([name, stat]) => ({ name, value: scalar(stat.value), displayStatName: stringOrNull(stat.display_stat_name) })),
      standardLevelUpProperties: Object.entries(record.standard_level_up_upgrades ?? {}).map(([name, value]) => ({ name, value: scalar(value) })),
      scalingStats: Object.entries(record.scaling_stats ?? {}).map(([stat, entry]) => ({ stat, scalingStat: stringOrNull(entry.scaling_stat), scale: scalar(entry.scale), sourcePointer: `${pointer}/scaling_stats/${stat}` })),
      weaponId: stringOrNull(record.items?.weapon_primary), weapon, sourcePointer: pointer };
  });
  const items = catalog.items.map(base => {
    const entry = itemIndex.get(base.id); ensure(entry && String(entry.record.id) === base.numericId && entry.record.type === 'upgrade', 'Item ID mapping mismatch');
    const { record, index } = entry; const pointer = `items.json#/${index}`;
    const components = strings(record.component_items);
    return { id: base.id, numericId: String(record.id), name: base.name, category: base.category, tier: base.tier, tags: base.tags, description: base.description,
      iconFile: `icons/${base.id}.png`, active: typeof record.is_active_item === 'boolean' ? record.is_active_item : null,
      properties: propertiesFor(record, pointer), upgrades: upgradesFor(record, pointer, false), componentIds: components.filter(id => selectedIds.has(id)), unresolvedComponentIds: components.filter(id => !selectedIds.has(id)),
      tooltipSections: (record.tooltip_sections ?? []).flatMap(section => (section.section_attributes ?? []).map(attribute => ({ kind: section.section_type ?? 'unknown', text: readable(attribute.loc_string) })).filter(section => section.text)),
      corruptedProperties: (record.corrupted_info?.property_upgrades ?? []).map((property, position) => propertyUpgrade(property, record, `${pointer}/corrupted_info/property_upgrades/${position}`)),
      corruptedExcludedPenalties: strings(record.corrupted_info?.excluded_penalties), sourcePointer: pointer };
  });
  const brawl = raw['generic-data'].street_brawl; ensure(brawl && Array.isArray(brawl.apper_round), 'Missing Street Brawl static configuration');
  return { schemaVersion: 1, clientVersion: catalog.clientVersion, revision: catalog.revision, catalogSha256: manifest.catalog.sha256, sourceArchive: manifest.sourceArchive,
    sources: [...PINNED_NAMES.map(name => { const source = manifest.sources.find(entry => entry.name === name); ensure(source, 'Missing pinned context source'); return { name, file: `data/${manifest.sourceArchive}/${name}.json`, sha256: source.sha256, url: source.url }; }), ...(auxiliary?.sources ?? []), ...(staticGlyphs?.manifest.sources ?? []).map(source => ({ name: `installed-${path.basename(source.sourcePath)}`, file: `data/${staticGlyphs.archive}/${source.file}`, sha256: source.sha256, url: `valve-resource://${catalog.clientVersion}/${source.sourcePath}` }))],
    heroes, abilities, items,
    hudGlyphs: (staticGlyphs?.manifest.glyphs ?? []).map(glyph => ({ id: glyph.id, file: glyph.file, sourceUrl: `valve-resource://${staticGlyphs.manifest.clientVersion}/${glyph.sourcePath}`,
      sourceFile: `data/${staticGlyphs.archive}/${glyph.sourceFile}`, sourceSha256: glyph.sourceSha256, sourcePointer: glyph.sourcePath,
      exportFile: `data/${staticGlyphs.archive}/${glyph.exportFile}`, exportSha256: glyph.exportSha256, bytes: glyph.bytes, width: glyph.width, height: glyph.height, extractedAt: glyph.extractedAt })),
    streetBrawl: { scoreToWin: brawl.score_to_win, abilityPointsPerRound: brawl.apper_round, draftChoicesPerRound: brawl.item_draft_rounds_per_game_round.map(round => round.item_draft_rounds.length), ultimateUnlockRoundDefinition: brawl.ultimate_unlock_round ?? null, abilityUpgradeTierCosts: null },
    researchEvidence: RESEARCH,
    limitations: ['Definitions are pinned to public client assets, not proof of the installed build or current match state.', 'Base numeric values retain source units/scaling; they are not evaluated current damage, healing, cooldowns, or resistances.', 'Unused zero/disabled defaults are omitted unless UI, upgrade, scaling, mode override, or gating references them; a missing parameter remains unknown, not zero.', 'Hero starting/level-up stats describe source definitions, not a Street Brawl combat stat snapshot.', 'Weapon firing rates/DPS are provider-derived static baselines, not observed enemy damage shares.', 'Ability upgrade tiers are definitions; actual unlocked state and ranks require independent visible evidence.', 'Unlock definitions separate ability-point and ability-unlock resource costs; they do not establish currently available resources or auto-unlock mode behavior.', 'Fixed tier AP prices were not found in the pinned public assets and remain unknown; [1,2,5] is not asserted here.', 'Item upgrade operators remain explicit or unspecified; arrays alone do not prove duplicate/enhanced/corrupted application semantics.', 'Component references describe shop recipes; Street Brawl replacement and stacking behavior are not established by those links.', 'Corrupted bonuses do not decode the selected penalty or all modifier bits.', 'Historical analytics are descriptive/excluded evidence and are not imported as causal or calibrated item values.', 'Valve owns game text/assets; this local same-machine cache makes no redistribution-rights claim.'] };
}

export async function readPinnedContextInputs(root = ROOT) {
  const catalogBytes = await fs.readFile(path.join(root, 'data/public-catalog.json'));
  const catalog = JSON.parse(catalogBytes); const manifest = JSON.parse(await fs.readFile(path.join(root, 'data/catalog-manifest.json'), 'utf8'));
  ensure(contextHash(catalogBytes) === manifest.catalog.sha256 && catalogBytes.length === manifest.catalog.bytes, 'Public catalog integrity failure');
  ensure(/^catalog-sources\/client-\d+-[a-f0-9]{16}$/.test(manifest.sourceArchive), 'Unsafe source archive path');
  const raw = {};
  for (const name of PINNED_NAMES) {
    const source = manifest.sources.find(entry => entry.name === name); ensure(source, 'Missing context provenance');
    const bytes = await fs.readFile(path.join(root, 'data', manifest.sourceArchive, `${name}.json`));
    ensure(contextHash(bytes) === source.sha256 && bytes.length === source.bytes, `Pinned ${name} source integrity failure`); raw[name] = JSON.parse(bytes);
  }
  ensure(manifest.researchPins?.steamTrackingCommit === AUX_COMMIT, 'Auxiliary Valve source commit mismatch');
  const auxiliaryManifest = JSON.parse(await fs.readFile(path.join(root, 'data', AUX_ARCHIVE, 'source-manifest.json'), 'utf8'));
  ensure(auxiliaryManifest.schemaVersion === 1 && auxiliaryManifest.commit === AUX_COMMIT, 'Invalid auxiliary Valve provenance');
  const auxiliaryBytes = new Map(); const auxiliarySources = [];
  for (const source of auxiliaryManifest.sources) {
    ensure(['abilities.vdata', 'convars.txt', 'citadel_hud_ability_upgrade_button.xml', 'citadel_hud_ability_upgrade_pips.xml', 'steam.inf'].includes(source.file), 'Unsafe auxiliary source filename');
    ensure(source.url === `https://raw.githubusercontent.com/SteamTracking/GameTracking-Deadlock/${AUX_COMMIT}/${source.sourcePath}`, 'Invalid auxiliary source URL');
    const bytes = await fs.readFile(path.join(root, 'data', AUX_ARCHIVE, source.file));
    ensure(contextHash(bytes) === source.sha256 && bytes.length === source.bytes, `Auxiliary ${source.file} source integrity failure`);
    ensure(!auxiliaryBytes.has(source.file), 'Duplicate auxiliary source'); auxiliaryBytes.set(source.file, bytes);
    auxiliarySources.push({ name: `valve-${source.file}`, file: `data/${AUX_ARCHIVE}/${source.file}`, sha256: source.sha256, url: source.url });
  }
  const steamInfo = auxiliaryBytes.get('steam.inf')?.toString('utf8');
  ensure(steamInfo?.match(/^ClientVersion=(\d+)$/m)?.[1] === catalog.clientVersion && steamInfo.match(/^SourceRevision=(\d+)$/m)?.[1] === catalog.revision, 'Auxiliary Valve client/revision mismatch');
  ensure(auxiliaryBytes.has('abilities.vdata'), 'Missing primary ability definitions');
  const staticGlyphs = await verifyStaticContextGlyphs(root);
  return { catalog, manifest, raw, auxiliary: { abilityText: auxiliaryBytes.get('abilities.vdata').toString('utf8'), sources: auxiliarySources }, staticGlyphs };
}
export function buildAbilityLabels(context) {
  return { clientVersion: context.clientVersion, revision: context.revision, abilities: context.abilities.map(({ id, numericId, heroId, slot, name }) => ({ id, numericId, heroId, slot, name })) };
}
export async function verifyContextCatalog(root = ROOT) {
  const inputs = await readPinnedContextInputs(root); const context = buildContextCatalog(inputs); const expected = `${JSON.stringify(context, null, 2)}\n`;
  const bytes = await fs.readFile(path.join(root, OUTPUT)); ensure(bytes.toString('utf8') === expected, 'Context catalog differs from exact pinned source rebuild');
  const labels = await fs.readFile(path.join(root, ABILITY_LABELS_OUTPUT), 'utf8');
  ensure(labels === `${JSON.stringify(buildAbilityLabels(context), null, 2)}\n`, 'Ability labels differ from exact pinned source rebuild');
  return { heroes: inputs.catalog.heroes.length, abilities: inputs.catalog.heroes.length * 4, items: inputs.catalog.items.length, bytes: bytes.length, sha256: contextHash(bytes), clientVersion: inputs.catalog.clientVersion, revision: inputs.catalog.revision };
}
async function main() {
  const args = process.argv.slice(2); ensure(args.length <= 1 && args.every(arg => ['--verify', '--rebuild'].includes(arg)), 'Usage: node scripts/sync-context-catalog.mjs [--verify | --rebuild]');
  if (args.includes('--rebuild')) {
    const inputs = await readPinnedContextInputs(); const context = buildContextCatalog(inputs); const body = `${JSON.stringify(context, null, 2)}\n`;
    await fs.writeFile(path.join(ROOT, OUTPUT), body);
    await fs.writeFile(path.join(ROOT, ABILITY_LABELS_OUTPUT), `${JSON.stringify(buildAbilityLabels(context), null, 2)}\n`);
  }
  const result = await verifyContextCatalog(); console.log(`Verified offline context catalog: ${result.heroes} heroes, ${result.abilities} abilities, ${result.items} items, ${(result.bytes / 1024 / 1024).toFixed(2)} MiB; no network requests.`);
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Context catalog sync failed: ${error.message}`); process.exitCode = 1; });
