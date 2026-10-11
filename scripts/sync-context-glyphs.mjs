#!/usr/bin/env node
/** Static client resource decoding only. No process access, screen capture or game input. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = 'context-sources/installed-client-6745-11078118';
const DEFINITIONS = [
  { id: 'ability-upgrade-check', path: 'panorama/images/hud/ability_upgrade_check_psd.vtex_c', output: 'ability_upgrade_check_psd.png' },
  { id: 'ability-pip', path: 'panorama/images/hud/hero_ability_pip_psd.vtex_c', output: 'hero_ability_pip_psd.png' },
  { id: 'ability-pip-empty', path: 'panorama/images/hud/hero_ability_pip_empty_psd.vtex_c', output: 'hero_ability_pip_empty_psd.png' },
  { id: 'ap-icon', path: 'panorama/images/hud/ap_icon.vsvg_c', output: 'ap.png' },
  { id: 'spectator-icon', path: 'panorama/images/hud/spec_icon_png.vtex_c', output: 'spec_icon_png.png' },
];
const TOPBAR = 'panorama/layout/citadel_hud_top_bar_player.vxml_c';
function ensure(condition, message) { if (!condition) throw new Error(message); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function clientPin(text) { return { clientVersion: text.match(/^ClientVersion=(\d+)\r?$/m)?.[1], revision: text.match(/^SourceRevision=(\d+)\r?$/m)?.[1] }; }
function png(bytes) {
  ensure(bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR', 'Invalid exported static PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20); ensure(width >= 16 && height >= 16 && width <= 256 && height <= 256, 'Unexpected glyph canvas');
  return { width, height, bytes: bytes.length, sha256: hash(bytes) };
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
function child(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  ensure(result.status === 0 && !result.error, `Static decoder failed: ${result.error?.message ?? result.stderr?.slice(0, 300) ?? result.status}`);
  return result.stdout;
}
export async function verifyStaticContextGlyphs(root = ROOT) {
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'data/public-catalog.json'), 'utf8'));
  const directory = path.join(root, 'data', ARCHIVE); const manifest = JSON.parse(await fs.readFile(path.join(directory, 'source-manifest.json'), 'utf8'));
  // Static HUD glyphs keep their own client pin; they may predate the catalog's patch but never follow it.
  ensure(manifest.schemaVersion === 1 && Number(manifest.clientVersion) <= Number(catalog.clientVersion) && manifest.glyphs.length === DEFINITIONS.length, 'Static glyph source pin/coverage mismatch');
  const expected = new Set([...DEFINITIONS.map(definition => definition.path), TOPBAR, 'steam.inf']);
  for (const source of manifest.sources) {
    ensure(expected.has(source.sourcePath) && source.file === (source.sourcePath === 'steam.inf' ? 'steam.inf' : `raw/${path.basename(source.sourcePath)}`), 'Unsafe static source path');
    const bytes = await fs.readFile(path.join(directory, source.file)); ensure(bytes.length === source.bytes && hash(bytes) === source.sha256, 'Static glyph source integrity failure');
    if (source.crc32) ensure(crc32(bytes) === source.crc32, 'Static resource directory CRC mismatch'); expected.delete(source.sourcePath);
  }
  ensure(expected.size === 0, 'Incomplete static glyph provenance');
  const pin = clientPin(await fs.readFile(path.join(directory, 'steam.inf'), 'utf8')); ensure(pin.clientVersion === manifest.clientVersion && pin.revision === manifest.revision, 'Cached static client metadata mismatch');
  for (const definition of DEFINITIONS) {
    const glyph = manifest.glyphs.find(entry => entry.id === definition.id);
    ensure(glyph && glyph.sourcePath === definition.path && glyph.exportFile === `exports/${definition.output}` && glyph.file === `glyphs/${definition.id}.png`, 'Static glyph mapping mismatch');
    const metadata = png(await fs.readFile(path.join(directory, glyph.exportFile)));
    ensure(metadata.sha256 === glyph.exportSha256 && metadata.bytes === glyph.bytes && metadata.width === glyph.width && metadata.height === glyph.height, 'Static glyph PNG integrity failure');
    const source = manifest.sources.find(entry => entry.sourcePath === glyph.sourcePath); ensure(source.sha256 === glyph.sourceSha256 && source.file === glyph.sourceFile, 'Static glyph source binding mismatch');
  }
  return { manifest, archive: ARCHIVE };
}
async function extract(options) {
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, 'data/public-catalog.json'), 'utf8'));
  const gameRoot = path.resolve(options['--game-root']); const decoder = path.resolve(options['--decoder']); const indexPath = path.resolve(options['--index']);
  ensure(path.basename(decoder).toLowerCase() === 'source2viewer-cli.exe', 'Unexpected resource decoder');
  const steamBytes = await fs.readFile(path.join(gameRoot, 'steam.inf')); const pin = clientPin(steamBytes.toString('utf8'));
  ensure(pin.clientVersion === catalog.clientVersion && pin.revision === catalog.revision && catalog.clientVersion === '6745' && catalog.revision === '11078118', 'Installed/static catalog version mismatch');
  const indexBytes = await fs.readFile(indexPath); ensure(indexBytes.length < 32 * 1024 * 1024, 'Static resource index exceeds limit'); const entries = JSON.parse(indexBytes);
  ensure(Array.isArray(entries) && entries.length < 200_000, 'Invalid static VPK index');
  const directory = path.join(ROOT, 'data', ARCHIVE); await fs.mkdir(path.join(directory, 'raw'), { recursive: true }); await fs.mkdir(path.join(directory, 'exports'), { recursive: true });
  const sources = [{ sourcePath: 'steam.inf', file: 'steam.inf', sha256: hash(steamBytes), bytes: steamBytes.length }]; await fs.writeFile(path.join(directory, 'steam.inf'), steamBytes);
  for (const sourcePath of [...DEFINITIONS.map(definition => definition.path), TOPBAR]) {
    const matching = entries.filter(entry => entry.path === sourcePath); ensure(matching.length === 1, 'Ambiguous/missing static resource'); const entry = matching[0];
    ensure(Number.isSafeInteger(entry.archive) && entry.archive >= 0 && entry.archive <= 999 && Number.isSafeInteger(entry.offset) && entry.offset >= 0 && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 1024 * 1024, 'Invalid static resource segment');
    const archiveFile = `pak01_${String(entry.archive).padStart(3, '0')}.vpk`; const resource = Buffer.alloc(entry.bytes); const handle = await fs.open(path.join(gameRoot, archiveFile), 'r');
    try { const result = await handle.read(resource, 0, resource.length, entry.offset); ensure(result.bytesRead === resource.length, 'Incomplete static resource read'); } finally { await handle.close(); }
    ensure(crc32(resource) === entry.crc32, 'Static VPK resource CRC mismatch'); const file = `raw/${path.basename(sourcePath)}`; await fs.writeFile(path.join(directory, file), resource);
    sources.push({ sourcePath, file, archiveFile, offset: entry.offset, bytes: resource.length, crc32: entry.crc32, sha256: hash(resource) });
  }
  const decoderVersion = child(decoder, ['--version']).split(/\r?\n/)[0]; const decoderSha256 = hash(await fs.readFile(decoder));
  for (const definition of DEFINITIONS) {
    const raw = path.join(directory, 'raw', path.basename(definition.path)); const output = definition.id === 'ap-icon' ? 'ap.svg' : definition.output;
    child(decoder, ['-i', raw, '-o', path.join(directory, 'exports', output), '-d']);
  }
  child(decoder, ['-i', path.join(directory, 'raw', path.basename(TOPBAR)), '-o', path.join(directory, 'exports', 'top-bar-player.xml'), '-d']);
  ensure((await fs.readFile(path.join(directory, 'exports/top-bar-player.xml'), 'utf8')).includes('panorama/images/hud/spec_icon_png.vtex'), 'Spectator glyph not bound to topbar XML');
  child('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/rasterize-context-svg.ps1'), '-InputPath', path.join(directory, 'exports/ap.svg'), '-OutputPath', path.join(directory, 'exports/ap.png')]);
  const extractedAt = new Date().toISOString();
  const glyphs = await Promise.all(DEFINITIONS.map(async definition => {
    const source = sources.find(entry => entry.sourcePath === definition.path); const metadata = png(await fs.readFile(path.join(directory, 'exports', definition.output)));
    return { id: definition.id, file: `glyphs/${definition.id}.png`, sourcePath: definition.path, sourceFile: source.file, sourceSha256: source.sha256,
      exportFile: `exports/${definition.output}`, exportSha256: metadata.sha256, bytes: metadata.bytes, width: metadata.width, height: metadata.height, extractedAt };
  }));
  const manifest = { schemaVersion: 1, clientVersion: pin.clientVersion, revision: pin.revision, source: 'Installed Valve static client resources; no gameplay capture or personal data',
    indexSha256: hash(indexBytes), decoder: { name: 'Source2Viewer-CLI', version: decoderVersion, sha256: decoderSha256 },
    svgRasterizerSha256: hash(await fs.readFile(path.join(ROOT, 'scripts/rasterize-context-svg.ps1'))), sources, glyphs };
  await fs.writeFile(path.join(directory, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
async function main() {
  const args = process.argv.slice(2); const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; ensure(['--verify', '--extract', '--game-root', '--decoder', '--index'].includes(key) && !(key in options), 'Invalid static glyph arguments');
    options[key] = ['--verify', '--extract'].includes(key) ? true : args[++index];
  }
  ensure(!(options['--verify'] && options['--extract']), 'Use one static glyph operation');
  if (options['--extract']) { ensure(options['--game-root'] && options['--decoder'] && options['--index'], 'Static extraction requires game-root, decoder, and index'); await extract(options); }
  const result = await verifyStaticContextGlyphs(); console.log(`Verified ${result.manifest.glyphs.length} static HUD glyphs offline for client ${result.manifest.clientVersion}; no game input, capture, or network requests.`);
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Static glyph sync failed: ${error.message}`); process.exitCode = 1; });
