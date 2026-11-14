#!/usr/bin/env node
/** Build-time public icon cache. No runtime game data, credentials, or captures. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_ROOT = path.join(ROOT, 'assets', 'reader-icons');
const CATALOG_PATH = path.join(ROOT, 'data', 'public-catalog.json');
const MANIFEST_PATH = path.join(ICON_ROOT, 'manifest.json');
const MAX_ICON_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--verify', '--refresh'].includes(arg)) || (args.has('--verify') && args.has('--refresh'))) {
  throw new Error('Usage: node scripts/sync-reader-icons.mjs [--verify | --refresh]');
}

function ensure(condition, message) { if (!condition) throw new Error(message); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function safeUrl(value) {
  ensure(typeof value === 'string', 'Missing public item icon URL');
  const url = new URL(value);
  ensure(url.protocol === 'https:' && url.hostname === 'assets-bucket.deadlock-api.com' && !url.port && !url.username && !url.password && !url.search && !url.hash,
    'Item icon must use the approved public asset origin');
  ensure(/^\/assets-api-res\/images\/items\/(?:weapon|vitality|spirit|brawl)\/[a-z0-9_]+\.png$/i.test(url.pathname), 'Unexpected public icon path');
  return url.href;
}
function pngMetadata(bytes) {
  ensure(bytes.length >= 33 && bytes.length <= MAX_ICON_BYTES && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('ascii', 12, 16) === 'IHDR', 'Invalid PNG data');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  ensure(width >= 16 && height >= 16 && width <= 1024 && height <= 1024, 'Unsupported PNG dimensions');
  ensure(bytes.includes(Buffer.from('IEND')), 'Incomplete PNG image');
  return { width, height, bytes: bytes.length, sha256: hash(bytes) };
}
async function readCached(entry) {
  ensure(/^icons\/upgrade_[A-Za-z0-9_]+\.png$/.test(entry.file), 'Unsafe manifest filename');
  const bytes = await fs.readFile(path.join(ICON_ROOT, entry.file));
  const actual = pngMetadata(bytes);
  ensure(actual.sha256 === entry.sha256 && actual.bytes === entry.bytes && actual.width === entry.width && actual.height === entry.height, `Cached icon changed: ${entry.itemId}`);
  return actual;
}
async function fetchIcon(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(25_000), headers: { Accept: 'image/png' } });
      ensure(response.ok, `Public icon HTTP ${response.status}`);
      ensure(/^(?:image\/png|application\/octet-stream)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'Unexpected icon response content type');
      const length = Number(response.headers.get('content-length') ?? 0);
      ensure(Number.isFinite(length) && length <= MAX_ICON_BYTES, 'Public icon response too large');
      const reader = response.body.getReader();
      const chunks = []; let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          total += value.byteLength;
          ensure(total <= MAX_ICON_BYTES, 'Public icon exceeded byte limit');
          chunks.push(Buffer.from(value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const bytes = Buffer.concat(chunks); pngMetadata(bytes); return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

const catalogBytes = await fs.readFile(CATALOG_PATH);
const catalog = JSON.parse(catalogBytes);
ensure(typeof catalog.clientVersion === 'string' && typeof catalog.revision === 'string' && Array.isArray(catalog.items) && catalog.items.length > 50 && catalog.items.length <= 500, 'Invalid pinned item catalog');
const catalogSha256 = hash(catalogBytes);
const items = catalog.items.map(item => {
  ensure(typeof item.id === 'string' && /^upgrade_[A-Za-z0-9_]+$/.test(item.id) && typeof item.name === 'string' && item.name.length <= 100, 'Invalid item identity');
  return { itemId: item.id, numericId: String(item.numericId), name: item.name, category: item.category, sourceUrl: safeUrl(item.imageUrl), file: `icons/${item.id}.png` };
});
ensure(new Set(items.map(item => item.itemId)).size === items.length, 'Duplicate catalog item ID');

let existing;
try { existing = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8')); } catch (error) { if (args.has('--verify')) throw error; }
if (args.has('--verify') || (existing && !args.has('--refresh'))) {
  ensure(existing.schemaVersion === 1 && existing.catalogSha256 === catalogSha256 && existing.clientVersion === catalog.clientVersion && existing.revision === catalog.revision && existing.icons.length === items.length,
    'Icon manifest does not match the pinned catalog; explicitly run --refresh');
  const expected = new Map(items.map(item => [item.itemId, item]));
  let total = 0;
  for (const entry of existing.icons) {
    const catalogItem = expected.get(entry.itemId);
    ensure(catalogItem && entry.sourceUrl === catalogItem.sourceUrl && entry.file === catalogItem.file, 'Icon manifest/catalog mapping changed');
    total += (await readCached(entry)).bytes; expected.delete(entry.itemId);
  }
  ensure(expected.size === 0 && total <= MAX_TOTAL_BYTES, 'Incomplete icon cache');
  console.log(`Verified ${items.length} pinned public item icons (${(total / 1024 / 1024).toFixed(2)} MiB); no network requests.`);
} else {
  await fs.mkdir(path.join(ICON_ROOT, 'icons'), { recursive: true });
  // Nothing is written until every icon has arrived: a failed download must not leave new icons under the old manifest.
  const icons = new Array(items.length), pending = new Array(items.length); let next = 0, completed = 0, total = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < items.length) {
      const index = next++, item = items[index];
      const bytes = await fetchIcon(item.sourceUrl);
      const metadata = pngMetadata(bytes);
      total += metadata.bytes; ensure(total <= MAX_TOTAL_BYTES, 'Public icon cache exceeded total byte budget');
      pending[index] = bytes;
      icons[index] = { ...item, ...metadata };
      completed++; if (completed % 30 === 0 || completed === items.length) console.log(`Cached ${completed}/${items.length} public item icons.`);
    }
  }));
  const replace = async (file, contents) => { await fs.writeFile(`${file}.tmp`, contents); await fs.rename(`${file}.tmp`, file); };
  for (let index = 0; index < items.length; index++) await replace(path.join(ICON_ROOT, items[index].file), pending[index]);
  const manifest = { schemaVersion: 1, clientVersion: catalog.clientVersion, revision: catalog.revision, catalogSha256, retrievedAt: new Date().toISOString(),
    source: 'Static public Deadlock API item images; mirrored Valve assets, not a game capture', totalBytes: total, featureGrid: 16, icons };
  await replace(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Pinned ${items.length} icons (${(total / 1024 / 1024).toFixed(2)} MiB) to assets/reader-icons/manifest.json.`);
}
