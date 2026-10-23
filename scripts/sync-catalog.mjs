#!/usr/bin/env node
/** Public static assets only. No accounts, matches, analytics, game access or credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.deadlock-api.com';
const OWNER = 'Community Deadlock API parsing Valve assets; not an official Valve API';
const SCHEMA_VERSION = 1;
const MAX_BYTES = 16 * 1024 * 1024;
const NAMES = ['openapi', 'steam-info', 'items', 'heroes', 'generic-data'];
const BOOLEAN_HERO_FLAGS = ['disabled', 'in_development', 'needs_testing', 'assigned_players_only', 'limited_testing'];
const CATEGORIES = ['weapon', 'vitality', 'spirit'];
const ROLE_TAG = { marksman: 'weapon', mystic: 'spirit', brawler: 'melee' };
const TAGS = ['weapon', 'spirit', 'melee', 'healing', 'support', 'anti-heal', 'bullet-resist', 'spirit-resist', 'melee-resist', 'crowd-control', 'control-resist', 'mobility'];

function ensure(condition, message) { if (!condition) throw new Error(message); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function integer(value, name, minimum = 0) { ensure(Number.isSafeInteger(value) && value >= minimum, `Invalid ${name}`); return value; }
function object(value, name) { ensure(value !== null && typeof value === 'object' && !Array.isArray(value), `Invalid ${name}: expected object`); return value; }
function string(value, name) { ensure(typeof value === 'string' && value.length > 0, `Invalid ${name}: expected nonempty string`); return value; }
function within(root, candidate) { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function iso(value, name) { ensure(typeof value === 'string' && Number.isFinite(Date.parse(value)) && /Z$/.test(value), `Invalid ${name}: expected UTC timestamp`); }

/** API text is data: emit plain text and never renderer HTML/SVG. */
export function readable(value) {
  return (typeof value === 'string' ? value : '')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/\{g:citadel_inline_attribute:'([^']+)'\}/g, (_, label) => label.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
    .replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:39|34);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#34;': '"' }[entity]))
    .replace(/\s+/g, ' ').trim();
}
function imageUrl(value) {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password && /(?:^|\.)deadlock-api\.com$/.test(url.hostname)) return url.href; } catch { /* Unsupported images remain absent. */ }
  return undefined;
}
function descriptionFor(source) {
  const text = [...new Set(['desc', 'passive', 'active'].map(key => readable(source.description?.[key])).filter(Boolean))].join(' ');
  if (text) return text;
  return [...new Set(Object.values(source.properties ?? {}).filter(property => property?.tooltip_section === 'innate' && property.value !== '0').map(property => readable(property.label)).filter(Boolean))].join('; ');
}
/** Descriptive tags. These are neither statistical item values nor executed formulas. */
export function tagsFor(source, description = '', category = source.item_slot_type) {
  const tags = new Set();
  if (category === 'weapon' || category === 'spirit') tags.add(category);
  const text = description.toLowerCase();
  const enemyEffect = /\b(?:enemy|enemies|target|targets|their|them|victim)\b/.test(text) && /\b(?:damage|bullet|attack|hit|reduce|reduces|prevent|prevents|inflict|curse)\b/.test(text);
  for (const [name, property] of Object.entries(source.properties ?? {})) {
    if (property?.negative_attribute === true) continue;
    const raw = property?.street_brawl_value ?? property?.value;
    // A number with a unit or a formula is deliberately not converted to a number.
    if (typeof raw !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) continue;
    const value = Number(raw); if (!Number.isFinite(value) || value === 0) continue;
    const type = property.provided_property_type ?? '';
    if (value > 0) {
      if (/^MODIFIER_VALUE_(?:WEAPON_POWER|BASEATTACK_DAMAGE_PERCENT|BASE_ATTACK_DAMAGE_PERCENT|BULLET_DAMAGE)$/.test(type) || /^(?:BaseAttackDamagePercent|WeaponPower|BonusFireRate)$/.test(name)) tags.add('weapon');
      if (type === 'MODIFIER_VALUE_TECH_POWER') tags.add('spirit');
      if (type === 'MODIFIER_VALUE_MELEE_DAMAGE_INCREASE') tags.add('melee');
      if (type === 'MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST' || /^(?:BulletResistBelowThreshold|BulletResistPerStack)$/.test(name)) tags.add('bullet-resist');
      if (type === 'MODIFIER_VALUE_TECH_RESIST' || name === 'TechResistBelowThreshold') tags.add('spirit-resist');
      if (type === 'MODIFIER_VALUE_MELEE_RESIST') tags.add('melee-resist');
      if (/^MODIFIER_VALUE_(?:TECH_LIFESTEAL|BULLET_LIFESTEAL|HEALTH_REGEN_PER_SECOND|OUT_OF_COMBAT_HEALTH_REGEN|HEAL_AMP_CAST_PERCENT|HEAL_AMP_REGEN_PERCENT)$/.test(type) || /^(?:LifestrikeHeal|HealOnActivate|HealOnKill|HealPercentAmount|HealAmount|HealPerStack|TotalHealthRegen)$/.test(name)) tags.add('healing');
      if (/^MODIFIER_VALUE_(?:STATUS_RESISTANCE|MOVEMENT_SLOW_RESISTANCE)$/.test(type)) tags.add('control-resist');
      if (/^MODIFIER_VALUE_(?:MOVEMENT_SPEED_MAX|SPRINT_SPEED_BONUS|STAMINA|STAMINA_REGEN_PER_SECOND_PERCENTAGE|AIR_MOVE_DISTANCE_INCREASE_PERCENT|MOVEMENT_GROUND_DASH_INCREASE_PERCENT)$/.test(type)) tags.add('mobility');
      if (type === 'MODIFIER_VALUE_MOVEMENT_SPEED_SLOW_PERCENT' || /^(?:StunDuration|RootDuration|SilenceDuration|DisarmDuration)$/.test(name)) tags.add('crowd-control');
    }
    if (value < 0 && enemyEffect && /^MODIFIER_VALUE_HEAL_AMP_(?:RECEIVE|REGEN)_PERCENT$/.test(type)) tags.add('anti-heal');
  }
  if (/\b(?:heavy melee|light melee|melee (?:attack|damage|hit))\b/.test(text)) tags.add('melee');
  if (/\b(?:heal|healing|restore|protect|buff|target)[^.]{0,80}\b(?:ally|allies)\b|\b(?:ally|allies)[^.]{0,80}\b(?:heal|healing|restore|protect|buff)\b/.test(text)) tags.add('support');
  if (/\b(?:heals you|heal yourself|health regen|lifesteal|heal allies|heal the target)\b/.test(text)) tags.add('healing');
  if (enemyEffect && /\b(?:reduces? (?:their|enemy|the target'?s) healing|healing reduction on|apply (?:a )?healing reduction|prevents?[^.!?]{0,60}healing effects on enemies)/.test(text)) tags.add('anti-heal');
  if (text.split(/[.!?]/).some(sentence => !/\b(?:remove|purge|cleanse)\b.{0,50}\b(?:debuff|negative effect)|\b(?:immune to|cannot be used while|slows? down when)\b/.test(sentence) && /\b(?:stuns?|slows?|roots?|silences?|disarms?)\s+(?:the |an |all |nearby )?(?:enemy|enemies|target|targets|them)\b|\b(?:enemy|enemies|target|targets)\b.{0,80}\b(?:stunned|slowed|rooted|silenced|disarmed|sleep)/.test(sentence))) tags.add('crowd-control');
  if (/\b(?:cleanse|cleanses|purge|debuff resistance|debuff resist)\b|\bremove(?:s)? (?:all )?(?:non-stun |negative )?debuff|\bblock the next debuff|\bimmune to (?:stun|slow|silence|sleep|root|disarm)/.test(text)) tags.add('control-resist');
  if (/(?:^|[.!?:]\s+)(?:instantly |quickly )?(?:teleport|leap|dash|perform a dash|pull yourself)\b|\b(?:you (?:can )?|to |then )(?:teleport|leap|dash)\b|\b(?:dash|leap) (?:forward|backward|backwards|toward|towards)\b/.test(text)) tags.add('mobility');
  if (/\b(?:immune to bullets|bullet immunity)\b/.test(text)) tags.add('bullet-resist');
  if (/\b(?:immune to melee|melee immunity)\b/.test(text)) tags.add('melee-resist');
  return [...tags].sort();
}
export function releasedHero(hero) {
  // A released, selectable hero can keep a stale in_development flag after launch (Baba, client 6774).
  return hero.player_selectable === true && hero.development_state === 'release' && hero.prerelease_only !== true
    && BOOLEAN_HERO_FLAGS.every(flag => hero[flag] === false || (flag === 'in_development' && hero[flag] === true));
}
function identity(record, kind) { object(record, kind); string(record.class_name, `${kind}.class_name`); ensure(/^[A-Za-z0-9_+]+$/.test(record.class_name), `Invalid ${kind} class_name`); integer(record.id, `${kind}.id`); ensure(typeof record.name === 'string', `Invalid ${kind}.name`); }
function unique(records, key, name) { const values = records.map(record => record[key]); ensure(new Set(values).size === values.length, `Duplicate ${name}`); }

export function verifyContract(schema) {
  object(schema, 'OpenAPI'); ensure(/^3\./.test(schema.openapi), 'Unsupported OpenAPI version');
  for (const name of NAMES.filter(name => name !== 'openapi')) {
    const endpoint = schema.paths?.[`/v1/assets/${name}`]?.get;
    ensure(endpoint?.parameters?.some(parameter => parameter.name === 'client_version' && parameter.in === 'query'), `Missing version pin contract: ${name}`);
    if (['items', 'heroes', 'generic-data'].includes(name)) ensure(endpoint.parameters.some(parameter => parameter.name === 'language' && parameter.in === 'query'), `Missing language contract: ${name}`);
    ensure(endpoint.responses?.['200']?.content?.['application/json']?.schema, `Missing JSON asset contract: ${name}`);
  }
  for (const [name, fields] of Object.entries({ SteamInfo: ['client_version', 'source_revision', 'app_id', 'version_datetime'], Upgrade: ['id', 'class_name', 'name', 'shopable', 'shop_version', 'item_tier', 'item_slot_type', 'properties'], Hero: ['id', 'class_name', 'name', 'player_selectable', 'development_state', 'disabled', 'items'], ItemProperty: ['value', 'street_brawl_value', 'negative_attribute', 'provided_property_type'], GenericData: ['street_brawl'] })) {
    const definition = schema.components?.schemas?.[name];
    ensure(definition?.properties && fields.every(field => field in definition.properties), `Unsupported source contract: ${name}`);
  }
}
export function buildCatalog(raw, sources, clientVersion) {
  verifyContract(raw.openapi);
  const steam = object(raw['steam-info'], 'SteamInfo');
  ensure(integer(steam.client_version, 'client version', 1) === clientVersion, 'The provider returned a different client version');
  ensure(integer(steam.app_id, 'app ID') === 1422450 && steam.product_name === 'citadel', 'Not Deadlock asset metadata');
  integer(steam.source_revision, 'source revision', 1);
  ensure(typeof steam.version_datetime === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(steam.version_datetime), 'Invalid source patch timestamp');
  for (const name of ['items', 'heroes']) { ensure(Array.isArray(raw[name]) && raw[name].length > 0 && raw[name].length <= 5000, `Invalid ${name} array`); raw[name].forEach(record => identity(record, name)); unique(raw[name], 'class_name', `${name} class names`); }
  object(raw['generic-data'], 'GenericData'); object(raw['generic-data'].street_brawl, 'StreetBrawl definition');
  const selectedItems = raw.items.filter(item => item.type === 'upgrade' && item.shopable === true && item.shop_version === 0 && CATEGORIES.includes(item.item_slot_type));
  const selectedHeroes = raw.heroes.filter(releasedHero);
  ensure(selectedItems.length >= 50 && selectedHeroes.length >= 20, 'Suspiciously incomplete catalog; existing files left intact');
  const items = selectedItems.map(item => {
    ensure(Number.isInteger(item.item_tier) && item.item_tier >= 1 && item.item_tier <= 5, `Unknown source item tier: ${item.class_name}`);
    const description = descriptionFor(item);
    return { id: item.class_name, numericId: String(item.id), name: readable(item.name), category: item.item_slot_type, tier: item.item_tier, tags: tagsFor(item, description), description, ...(imageUrl(item.shop_image) ? { imageUrl: imageUrl(item.shop_image) } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const itemDefinitions = new Map(raw.items.map(item => [item.class_name, item]));
  const heroes = selectedHeroes.map(hero => {
    const signatureAbilities = [1, 2, 3, 4].map(slot => {
      const ability = itemDefinitions.get(hero.items?.[`signature${slot}`]);
      ensure(ability?.type === 'ability', `Missing signature${slot}: ${hero.class_name}`);
      return ability;
    });
    const role = typeof hero.hero_type === 'string' ? hero.hero_type : 'unknown';
    // Flavor tags and statistical popular_items are deliberately not scoring inputs.
    const tags = new Set(signatureAbilities.flatMap(ability => tagsFor(ability, descriptionFor(ability), undefined)));
    if (ROLE_TAG[role]) tags.add(ROLE_TAG[role]);
    const portrait = imageUrl(hero.images?.icon_image_small_webp) ?? imageUrl(hero.images?.icon_image_small);
    return { id: hero.class_name, numericId: String(hero.id), name: readable(hero.name), role, tags: [...tags].sort(), ...(portrait ? { imageUrl: portrait } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  unique(items, 'numericId', 'base item numeric IDs'); unique(heroes, 'numericId', 'hero numeric IDs');
  const retrievedAt = sources.map(source => source.retrievedAt).sort().at(-1);
  return { clientVersion: String(clientVersion), revision: String(steam.source_revision), source: OWNER, retrievedAt, items, heroes, liveModelValidated: false, modelVersion: `descriptive-tags-v1-client-${clientVersion}` };
}
export function validateCatalog(catalog) {
  object(catalog, 'Catalog'); ensure(/^\d+$/.test(catalog.clientVersion) && /^\d+$/.test(catalog.revision), 'Catalog must pin client/revision');
  string(catalog.source, 'catalog source'); iso(catalog.retrievedAt, 'catalog retrieval time');
  ensure(catalog.liveModelValidated === false, 'Public assets do not validate a live recommendation model');
  ensure(Array.isArray(catalog.items) && Array.isArray(catalog.heroes) && catalog.items.length && catalog.heroes.length, 'Empty catalog');
  for (const [kind, records] of Object.entries({ items: catalog.items, heroes: catalog.heroes })) {
    unique(records, 'id', `${kind} IDs`); unique(records, 'numericId', `${kind} numeric IDs`);
    for (const record of records) {
      string(record.id, 'catalog ID'); string(record.name, 'catalog name'); ensure(/^\d+$/.test(record.numericId), 'Missing numeric ID mapping');
      ensure(Array.isArray(record.tags) && record.tags.every(tag => TAGS.includes(tag)), 'Unsupported descriptive tag');
      ensure(!record.imageUrl || imageUrl(record.imageUrl) === record.imageUrl, 'Unsafe image URL');
      if (kind === 'items') { ensure(CATEGORIES.includes(record.category) && Number.isInteger(record.tier), 'Invalid item category/tier'); ensure(typeof record.description === 'string', 'Invalid description'); }
    }
  }
  return catalog;
}
async function request(name, clientVersion) {
  const url = name === 'openapi' ? `${API}/openapi.json` : `${API}/v1/assets/${name}?${name === 'steam-info' ? '' : 'language=english&'}client_version=${clientVersion}`;
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
  ensure(response.ok, `${name}: HTTP ${response.status}`); ensure(response.headers.get('content-type')?.includes('json'), `${name}: expected JSON response`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; ensure(bytes <= MAX_BYTES, `${name}: oversized response`); chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  const metadata = { name, url, retrievedAt: new Date().toISOString(), bytes: body.length, sha256: hash(body), cacheAgeSeconds: response.headers.get('age') === null ? null : Number(response.headers.get('age')), lastModified: response.headers.get('last-modified'), cacheControl: response.headers.get('cache-control'), owner: OWNER };
  return { body, metadata, value: JSON.parse(body.toString('utf8')) };
}
async function readArchive(directory, clientVersion) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'source-manifest.json'), 'utf8'));
  ensure(manifest.schemaVersion === SCHEMA_VERSION && manifest.clientVersion === clientVersion, 'Source archive version mismatch');
  ensure(Array.isArray(manifest.sources) && manifest.sources.length === NAMES.length, 'Incomplete source archive');
  const entries = {};
  for (const name of NAMES) {
    const metadata = manifest.sources.find(source => source.name === name); ensure(metadata, `Missing source ${name}`); iso(metadata.retrievedAt, 'source retrieval time');
    const body = await fs.readFile(path.join(directory, `${name}.json`)); ensure(body.length <= MAX_BYTES && body.length === metadata.bytes && hash(body) === metadata.sha256, `Source hash mismatch: ${name}`);
    const expectedUrl = name === 'openapi' ? `${API}/openapi.json` : `${API}/v1/assets/${name}?${name === 'steam-info' ? '' : 'language=english&'}client_version=${clientVersion}`;
    ensure(metadata.url === expectedUrl, `Source must use canonical versioned endpoint: ${name}`);
    entries[name] = { body, metadata, value: JSON.parse(body.toString('utf8')) };
  }
  return entries;
}
async function atomicFile(filename, contents) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, contents, { flag: 'wx' }); await fs.rename(temporary, filename); } finally { await fs.rm(temporary, { force: true }); }
}
async function archiveSources(entries, outputDirectory, clientVersion) {
  const bundleHash = hash(NAMES.map(name => entries[name].metadata.sha256).join('\n'));
  const relative = `catalog-sources/client-${clientVersion}-${bundleHash.slice(0, 16)}`;
  const directory = path.join(outputDirectory, relative);
  try { return { entries: await readArchive(directory, clientVersion), relative }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, { recursive: true });
  for (const name of NAMES) await atomicFile(path.join(directory, `${name}.json`), entries[name].body);
  await atomicFile(path.join(directory, 'source-manifest.json'), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, clientVersion, sources: NAMES.map(name => entries[name].metadata) }, null, 2)}\n`);
  return { entries, relative };
}
export async function checkBundle(outputDirectory = path.join(ROOT, 'data')) {
  const manifest = JSON.parse(await fs.readFile(path.join(outputDirectory, 'catalog-manifest.json'), 'utf8'));
  ensure(manifest.schemaVersion === SCHEMA_VERSION && manifest.catalog?.file === 'public-catalog.json', 'Unsupported catalog manifest');
  integer(manifest.clientVersion, 'manifest client version', 1); integer(manifest.sourceRevision, 'manifest revision', 1);
  const body = await fs.readFile(path.join(outputDirectory, manifest.catalog.file));
  ensure(body.length === manifest.catalog.bytes && hash(body) === manifest.catalog.sha256, 'Catalog snapshot hash mismatch');
  const catalog = validateCatalog(JSON.parse(body.toString('utf8')));
  ensure(catalog.clientVersion === String(manifest.clientVersion) && catalog.revision === String(manifest.sourceRevision), 'Catalog/manifest version mismatch');
  ensure(catalog.items.length === manifest.counts.baseShopItems && catalog.heroes.length === manifest.counts.releasedHeroes, 'Catalog counts mismatch');
  const archiveDirectory = path.resolve(outputDirectory, manifest.sourceArchive);
  ensure(within(outputDirectory, archiveDirectory), 'Invalid source archive path');
  const entries = await readArchive(archiveDirectory, manifest.clientVersion);
  const sources = NAMES.map(name => entries[name].metadata);
  const rebuilt = validateCatalog(buildCatalog(Object.fromEntries(NAMES.map(name => [name, entries[name].value])), sources, manifest.clientVersion));
  ensure(JSON.stringify(rebuilt) === JSON.stringify(catalog), 'Catalog cannot be reproduced from its checked sources');
  ensure(JSON.stringify(manifest.sources) === JSON.stringify(sources), 'Source archive/manifest mismatch');
  return { clientVersion: catalog.clientVersion, sourceRevision: catalog.revision, items: catalog.items.length, heroes: catalog.heroes.length, offline: true };
}
async function main() {
  const args = process.argv.slice(2); const options = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (['--fetch', '--check', '--help'].includes(option)) options[option.slice(2)] = true;
    else if (['--client-version', '--from-dir', '--output-dir'].includes(option)) { ensure(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${option}`); options[option.slice(2)] = args[++index]; }
    else throw new Error(`Unknown option: ${option}`);
  }
  if (options.help) { console.log('Offline verification (default): node scripts/sync-catalog.mjs --check\nExplicit public refresh (five bounded GET requests): node scripts/sync-catalog.mjs --fetch --client-version 6745\nRebuild from a checked source archive: node scripts/sync-catalog.mjs --from-dir data/catalog-sources/<archive> --client-version 6745\n--output-dir must remain inside this workspace. Refresh never reads telemetry or analytics.'); return; }
  const outputDirectory = path.resolve(ROOT, options['output-dir'] ?? 'data'); ensure(within(ROOT, outputDirectory), 'Catalog output must remain inside this workspace');
  ensure(!(options.fetch && options['from-dir']), 'Choose --fetch or --from-dir'); ensure(!(options.check && (options.fetch || options['from-dir'])), '--check cannot refresh data');
  if (!options.fetch && !options['from-dir']) { console.log(JSON.stringify(await checkBundle(outputDirectory), null, 2)); return; }
  ensure(/^\d+$/.test(options['client-version'] ?? ''), 'Refresh requires an explicit --client-version; latest is never selected implicitly');
  const clientVersion = integer(Number(options['client-version']), 'client version', 1); let entries;
  if (options.fetch) {
    const schema = await request('openapi', clientVersion); verifyContract(schema.value);
    const steam = await request('steam-info', clientVersion); ensure(steam.value.client_version === clientVersion, 'Version pin returned different metadata');
    const rest = await Promise.all(['items', 'heroes', 'generic-data'].map(name => request(name, clientVersion)));
    entries = { openapi: schema, 'steam-info': steam, ...Object.fromEntries(rest.map(entry => [entry.metadata.name, entry])) };
  } else entries = await readArchive(path.resolve(ROOT, options['from-dir']), clientVersion);
  // Cache raw static responses for inspection/rebuild even if normalization is rejected.
  // The active catalog remains untouched until its complete validation succeeds.
  await fs.mkdir(outputDirectory, { recursive: true });
  const archived = await archiveSources(entries, outputDirectory, clientVersion); entries = archived.entries;
  const sources = NAMES.map(name => entries[name].metadata); const raw = Object.fromEntries(NAMES.map(name => [name, entries[name].value]));
  const catalog = validateCatalog(buildCatalog(raw, sources, clientVersion));
  const body = `${JSON.stringify(catalog, null, 2)}\n`;
  const manifest = {
    schemaVersion: SCHEMA_VERSION, clientVersion, sourceRevision: raw['steam-info'].source_revision,
    patchDateTime: raw['steam-info'].version_datetime, patchTimeZone: null, language: 'english', owner: OWNER,
    sourceArchive: archived.relative, sources,
    catalog: { file: 'public-catalog.json', sha256: hash(body), bytes: Buffer.byteLength(body) },
    counts: { sourceItemRecords: raw.items.length, sourceHeroRecords: raw.heroes.length, baseShopItems: catalog.items.length, releasedHeroes: catalog.heroes.length, signatureAbilitySlots: catalog.heroes.length * 4 },
    coverage: { itemFilter: "type=upgrade, shopable=true, shop_version=0, supported category; source tiers 1–5 retained", heroFilter: 'Selectable release heroes; all disabled/development/testing/prerelease flags excluded', excludedHeroes: raw.heroes.filter(hero => !releasedHero(hero)).map(hero => ({ id: hero.class_name, name: readable(hero.name), developmentState: hero.development_state, playerSelectable: hero.player_selectable, disabled: hero.disabled, inDevelopment: hero.in_development, needsTesting: hero.needs_testing, assignedPlayersOnly: hero.assigned_players_only, limitedTesting: hero.limited_testing, prereleaseOnly: hero.prerelease_only })), itemTierCounts: Object.fromEntries([1, 2, 3, 4, 5].map(tier => [tier, catalog.items.filter(item => item.tier === tier).length])), streetBrawlOverrides: raw.items.filter(item => catalog.items.some(selected => selected.id === item.class_name)).reduce((count, item) => count + Object.values(item.properties ?? {}).filter(property => property.street_brawl_value !== undefined && property.street_brawl_value !== null).length, 0), unmodeled: ['Live offer eligibility and offer-pool probabilities', 'Enhanced/legendary/corrupted modifier evaluation', 'Item marginal value, win rates and causal effects', 'Runtime possession, ability investment and round behavior', 'Installed build compatibility until participant telemetry supplies a client version'] },
    tagRuleVersion: 1, tagDefinitions: { weapon: 'Weapon category or positive weapon/fire-rate properties', spirit: 'Spirit category or positive spirit-power property', melee: 'Melee damage mechanic or brawler hero role', healing: 'Positive healing/regeneration/lifesteal mechanic', support: 'Description explicitly supports an ally', 'anti-heal': 'Offensive enemy healing reduction; wearer penalties excluded', 'bullet-resist': 'Positive bullet resistance or immunity', 'spirit-resist': 'Positive spirit resistance', 'melee-resist': 'Positive melee resistance or immunity', 'crowd-control': 'Explicit hostile slow/stun/root/silence/disarm mechanic', 'control-resist': 'Status/slow resistance, cleanse or debuff immunity', mobility: 'Positive movement/stamina property or explicit caster movement action' },
    notes: ['All raw static sources retained with SHA-256; refresh pins metadata and all assets to an explicit client_version.', 'Static tags describe mechanics and do not score numerical damage or prove an optimal pick.', 'Street Brawl overrides use explicit non-null source values for descriptive sign checks; complete raw properties/formulas remain in the archive.', 'Tier-5 shop records are special source definitions; shopability does not establish current Street Brawl offer eligibility.', 'Source version_datetime has no timezone and is not relabeled UTC.', 'Source metadata is cached by the provider; request/retrieval time and cache age are recorded separately.', 'Public asset retrieval does not verify the installed game or pass the automatic participant telemetry gate.', 'Valve owns game text and assets. This same-machine bundle makes no redistribution-rights claim.'],
    researchPins: { steamTrackingCommit: '3207c1601bf83515155a1108b4b8def7338b1b29', apiSourceCommit: 'f6e1974d45af3ccebe0f36324ea22e1e12990ff3', note: 'Reviewed research source commits; these do not authenticate the mutable provider response.' },
  };
  await atomicFile(path.join(outputDirectory, 'public-catalog.json'), body);
  await atomicFile(path.join(outputDirectory, 'catalog-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(await checkBundle(outputDirectory), null, 2));
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Catalog sync failed: ${error.message}`); process.exitCode = 1; });
