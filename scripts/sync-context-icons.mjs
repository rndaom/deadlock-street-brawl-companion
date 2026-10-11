#!/usr/bin/env node
/** Explicit build-time public PNG cache. Default verification is entirely offline. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyContextCatalog } from './sync-context-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_REQUESTS = 400;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const APPROVED_ROLES = ['hero-card', 'hero-small', 'hero-vertical', 'ability', 'hud-glyph'];
function ensure(value, message) { if (!value) throw new Error(message); }
export function iconHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function contextPngMetadata(bytes) {
  ensure(bytes.length >= 45 && bytes.length <= MAX_PNG_BYTES && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('ascii', 12, 16) === 'IHDR', 'Invalid context PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  ensure(width >= 16 && height >= 16 && width <= 2048 && height <= 2048 && bytes.includes(Buffer.from('IEND')), 'Invalid context PNG dimensions/end');
  return { width, height, bytes: bytes.length, sha256: iconHash(bytes) };
}
function safeUrl(value) {
  ensure(typeof value === 'string', 'Missing context image URL'); const url = new URL(value);
  ensure(url.protocol === 'https:' && url.hostname === 'assets-bucket.deadlock-api.com' && !url.port && !url.username && !url.password && !url.search && !url.hash
    && /^\/assets-api-res\/images\/(?:heroes|abilities)\/[a-zA-Z0-9_/-]+\.png$/.test(url.pathname), 'Unapproved context image URL');
  return url.href;
}
function safeFile(file) { ensure(typeof file === 'string' && /^(?:heroes|abilities|glyphs)\/[a-zA-Z0-9_-]+\.png$/.test(file), 'Unsafe context image filename'); return file; }
function safeGlyphSource(file) {
  ensure(typeof file === 'string' && /^data\/context-sources\/installed-client-\d+-\d+\/(?:raw|exports)\/[a-zA-Z0-9_-]+\.(?:png|vtex_c|vsvg_c)$/.test(file), 'Unsafe static context glyph source'); return file;
}
export function expectedContextAssets(catalog) {
  const sources = new Map(catalog.sources.map(source => [source.name, source]));
  const heroes = catalog.heroes.flatMap(hero => hero.portraits.map(portrait => ({ id: `${hero.id}:${portrait.role}`, heroId: hero.id, role: portrait.role,
    file: safeFile(portrait.file), sourceUrl: safeUrl(portrait.sourceUrl), sourceSha256: sources.get('heroes').sha256, sourceFile: sources.get('heroes').file, sourcePointer: hero.sourcePointer })));
  const abilities = catalog.abilities.map(ability => ({ id: ability.id, abilityId: ability.id, heroId: ability.heroId, slot: ability.slot, sourceSlot: ability.sourceSlot, role: 'ability',
    file: safeFile(ability.iconFile), sourceUrl: safeUrl(ability.imageUrl), sourceSha256: sources.get('items').sha256, sourceFile: sources.get('items').file, sourcePointer: ability.sourcePointer }));
  const glyphs = catalog.hudGlyphs.map(glyph => {
    ensure(/^valve-resource:\/\/\d+$/.test(glyph.sourceUrl.slice(0, -glyph.sourcePointer.length - 1)) && Number(glyph.sourceUrl.split('/')[2]) <= Number(catalog.clientVersion) && glyph.sourceUrl.endsWith(`/${glyph.sourcePointer}`) && /^panorama\/images\/hud\/[a-zA-Z0-9_-]+\.(?:vtex_c|vsvg_c)$/.test(glyph.sourcePointer), 'Invalid static context glyph reference');
    return { id: glyph.id, heroId: null, role: 'hud-glyph', file: safeFile(glyph.file), sourceUrl: glyph.sourceUrl,
      sourceSha256: glyph.sourceSha256, sourceFile: safeGlyphSource(glyph.sourceFile), sourcePointer: glyph.sourcePointer,
      exportFile: safeGlyphSource(glyph.exportFile), exportSha256: glyph.exportSha256 };
  });
  const assets = [...heroes, ...abilities, ...glyphs];
  ensure(assets.length > 0 && assets.length <= MAX_REQUESTS && new Set(assets.map(asset => asset.id)).size === assets.length && new Set(assets.map(asset => asset.file)).size === assets.length, 'Invalid context image coverage');
  ensure(assets.every(asset => APPROVED_ROLES.includes(asset.role)), 'Invalid context image role');
  return assets;
}
async function cacheEntry(root, entry) {
  safeFile(entry.file); const bytes = await fs.readFile(path.join(root, 'assets/context-icons', entry.file)); const metadata = contextPngMetadata(bytes);
  ensure(metadata.sha256 === entry.sha256 && metadata.bytes === entry.bytes && metadata.width === entry.width && metadata.height === entry.height, `Context icon integrity failure: ${entry.id}`);
  if (entry.role === 'hud-glyph') ensure(metadata.sha256 === entry.exportSha256, `Static context glyph cache/export mismatch: ${entry.id}`);
  return metadata;
}
function mappingMatches(entry, expected) {
  return ['id', 'heroId', 'role', 'file', 'sourceUrl', 'sourceSha256', 'sourceFile', 'sourcePointer', 'abilityId', 'slot', 'sourceSlot', 'exportFile', 'exportSha256'].every(key => entry[key] === expected[key]);
}
async function readInputs(root) {
  await verifyContextCatalog(root);
  const bytes = await fs.readFile(path.join(root, 'data/context-catalog.json')); const catalog = JSON.parse(bytes);
  return { catalog, contextCatalogSha256: iconHash(bytes), assets: expectedContextAssets(catalog) };
}
export async function verifyContextIcons(root = ROOT) {
  const { catalog, contextCatalogSha256, assets } = await readInputs(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'assets/context-icons/manifest.json'), 'utf8'));
  ensure(manifest.schemaVersion === 1 && manifest.clientVersion === catalog.clientVersion && manifest.revision === catalog.revision
    && manifest.catalogSha256 === catalog.catalogSha256 && manifest.contextCatalogSha256 === contextCatalogSha256 && Array.isArray(manifest.assets) && manifest.assets.length === assets.length, 'Context image manifest pin/coverage mismatch');
  const expected = new Map(assets.map(asset => [asset.id, asset])); let totalBytes = 0;
  for (const entry of manifest.assets) {
    const definition = expected.get(entry.id); ensure(definition && mappingMatches(entry, definition), 'Context image manifest mapping mismatch');
    totalBytes += (await cacheEntry(root, entry)).bytes; expected.delete(entry.id);
  }
  ensure(expected.size === 0 && totalBytes <= MAX_TOTAL_BYTES && totalBytes === manifest.totalBytes, 'Incomplete context image cache');
  return { images: assets.length, totalBytes, clientVersion: catalog.clientVersion, revision: catalog.revision };
}
async function download(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(25_000), headers: { Accept: 'image/png' } });
  ensure(response.ok, `Context image HTTP ${response.status}`);
  ensure(/^(?:image\/png|application\/octet-stream)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'Unexpected context image content type');
  const contentLength = Number(response.headers.get('content-length') ?? 0); ensure(Number.isFinite(contentLength) && contentLength <= MAX_PNG_BYTES, 'Context image response too large');
  ensure(response.body, 'Missing context image body'); const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    while (true) { const result = await reader.read(); if (result.done) break; total += result.value.byteLength; ensure(total <= MAX_PNG_BYTES, 'Context PNG exceeded byte budget'); chunks.push(Buffer.from(result.value)); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = Buffer.concat(chunks); contextPngMetadata(bytes); return bytes;
}
async function refresh() {
  const { catalog, contextCatalogSha256, assets } = await readInputs(ROOT); const iconRoot = path.join(ROOT, 'assets/context-icons');
  let existing;
  try { existing = JSON.parse(await fs.readFile(path.join(iconRoot, 'manifest.json'), 'utf8')); } catch { /* Initial explicit cache population. */ }
  const prior = existing?.schemaVersion === 1 && existing.clientVersion === catalog.clientVersion && existing.revision === catalog.revision ? new Map(existing.assets.map(entry => [entry.id, entry])) : new Map();
  await fs.mkdir(path.join(iconRoot, 'heroes'), { recursive: true }); await fs.mkdir(path.join(iconRoot, 'abilities'), { recursive: true }); await fs.mkdir(path.join(iconRoot, 'glyphs'), { recursive: true });
  const cached = new Array(assets.length); let next = 0, completed = 0, requests = 0, totalBytes = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < assets.length) {
      const index = next++; const expected = assets[index]; const entry = prior.get(expected.id); let result;
      if (entry && mappingMatches(entry, expected)) { try { result = { ...expected, ...(await cacheEntry(ROOT, entry)), retrievedAt: entry.retrievedAt }; } catch { /* Explicit refresh repairs failed integrity. */ } }
      if (!result) {
        let bytes;
        if (expected.role === 'hud-glyph') {
          bytes = await fs.readFile(path.join(ROOT, safeGlyphSource(expected.exportFile)));
          ensure(iconHash(bytes) === expected.exportSha256, 'Static context glyph export integrity failure');
        } else {
          ensure(++requests <= MAX_REQUESTS, 'Public context request limit exceeded'); bytes = await download(expected.sourceUrl);
        }
        const metadata = contextPngMetadata(bytes);
        await fs.writeFile(path.join(iconRoot, expected.file), bytes); result = { ...expected, ...metadata, retrievedAt: new Date().toISOString() };
      }
      totalBytes += result.bytes; ensure(totalBytes <= MAX_TOTAL_BYTES, 'Public context cache total byte budget exceeded'); cached[index] = result;
      completed++; if (completed % 40 === 0 || completed === assets.length) console.log(`Cached/verified ${completed}/${assets.length} public context images.`);
    }
  }));
  const manifest = { schemaVersion: 1, clientVersion: catalog.clientVersion, revision: catalog.revision, catalogSha256: catalog.catalogSha256, contextCatalogSha256,
    sourceArchive: catalog.sourceArchive, verifiedAt: new Date().toISOString(), source: 'Public hero/ability PNG mirrors and decoded pinned Valve static HUD resources; no game captures',
    totalBytes, featureGrid: 16, limitations: ['CDN URLs are not client-versioned; content hashes pin the retrieved template bytes, not independent Valve build authentication.', 'HUD glyphs are bound to cached static client resources by CRC32/SHA256 and decoder provenance; valve-resource URLs are metadata, never runtime download targets.', 'Full templates do not prove HUD crop, state, identity, inventory ownership, unlocked state, or ability rank.', 'Unavailable/mismatched recognition must remain unknown.'], assets: cached };
  await fs.writeFile(path.join(iconRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Context image cache ready (${requests} bounded public GETs; no credentials).`);
}
async function main() {
  const args = process.argv.slice(2); ensure(args.length <= 1 && args.every(arg => ['--verify', '--refresh'].includes(arg)), 'Usage: node scripts/sync-context-icons.mjs [--verify | --refresh]');
  if (args.includes('--refresh')) await refresh();
  const result = await verifyContextIcons(); console.log(`Verified ${result.images} pinned public context images (${(result.totalBytes / 1024 / 1024).toFixed(2)} MiB); offline verification.`);
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Context icon sync failed: ${error.message}`); process.exitCode = 1; });
