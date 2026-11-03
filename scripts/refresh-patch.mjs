#!/usr/bin/env node
// One command to bring the companion's game data up to a new Deadlock patch (new heroes, items, art).
//   node scripts/refresh-patch.mjs                 -> the latest client version
//   node scripts/refresh-patch.mjs --client-version 6794
// Then rebuild and package (README "Build from source"). Close the companion before packaging.
//
// Steps, in the order the pipeline needs them:
//  1. Fetch the deadlock-api asset snapshot for the client version (scripts/sync-catalog.mjs --fetch).
//  2. Find the SteamTracking/GameTracking-Deadlock commit for that version and download the
//     auxiliary Valve files listed in the previous source manifest, then repin both sync scripts.
//  3. Rebuild the catalogue from the saved archive, then the context catalogue, icon caches and
//     Street Brawl statistics (games since STREET_BRAWL_PATCH_START in src/screen/street-brawl-fetch.ts).
//  4. Repin the item base-fact table in src/screen/screen-advice.ts to the new snapshot.
//  5. Rebuild the native reader's descriptor caches (scripts/build-native.mjs) so new heroes reach the fast template path.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBaseFacts, formatEntries } from './extract-base-facts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const API = 'https://api.deadlock-api.com';
const TRACKING = 'SteamTracking/GameTracking-Deadlock';
const AUX_SCRIPTS = ['scripts/sync-catalog.mjs', 'scripts/sync-context-catalog.mjs'];

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const run = (command, args, label = args.join(' ')) => new Promise((resolve, reject) => {
  console.log(`\n> ${label}`);
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${label} failed (${code}).`)));
});
const node = (...args) => run(process.execPath, args, `node ${args.join(' ')}`);
async function getJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'street-brawl-companion-refresh', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  ensure(response.ok, `${response.status} from ${url}`);
  return response.json();
}

async function latestClientVersion() {
  const info = await getJson(`${API}/v1/assets/steam-info`);
  ensure(Number.isSafeInteger(info.client_version), 'steam-info has no client_version');
  return String(info.client_version);
}

async function newestArchive(directory, prefix) {
  const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith(prefix));
  const stats = await Promise.all(entries.map(async entry => ({ name: entry.name, at: (await fs.stat(path.join(directory, entry.name))).mtimeMs })));
  return stats.sort((a, b) => b.at - a.at)[0]?.name ?? null;
}

async function trackingCommit(clientVersion) {
  const commits = await getJson(`https://api.github.com/repos/${TRACKING}/commits?path=game/citadel/steam.inf&per_page=30`);
  ensure(Array.isArray(commits), 'GitHub did not return a commit list (rate limited?)');
  const match = commits.find(commit => commit.commit?.message?.split(/\s/)[0] === clientVersion);
  ensure(match, `No ${TRACKING} commit for client ${clientVersion} yet. Try again later.`);
  return match.sha;
}

async function currentAuxCommit() {
  const text = await fs.readFile(path.join(root, 'scripts/sync-context-catalog.mjs'), 'utf8');
  const match = /const AUX_COMMIT = '([0-9a-f]{40})'/.exec(text);
  ensure(match, 'AUX_COMMIT not found in scripts/sync-context-catalog.mjs');
  return match[1];
}

async function downloadAux(oldSha, newSha) {
  const sources = path.join(root, 'data/context-sources');
  const outDir = path.join(sources, `steamtracking-${newSha}`);
  const previous = JSON.parse(await fs.readFile(path.join(sources, `steamtracking-${oldSha}`, 'source-manifest.json'), 'utf8'));
  await fs.mkdir(outDir, { recursive: true });
  const files = [];
  for (const source of previous.sources) {
    const url = `https://raw.githubusercontent.com/${TRACKING}/${newSha}/${source.sourcePath}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    ensure(response.ok, `${response.status} from ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(path.join(outDir, source.file), bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    files.push({ ...source, url, bytes: bytes.length, sha256, retrievedAt: new Date().toISOString() });
    console.log(`  ${source.file}: ${bytes.length} bytes${sha256 === source.sha256 ? ' (unchanged)' : ''}`);
  }
  await fs.writeFile(path.join(outDir, 'source-manifest.json'), `${JSON.stringify({ ...previous, commit: newSha, sources: files }, null, 2)}\n`);
}

async function repinAux(oldSha, newSha) {
  for (const script of AUX_SCRIPTS) {
    const file = path.join(root, script);
    const text = await fs.readFile(file, 'utf8');
    ensure(text.includes(oldSha), `${script} does not pin ${oldSha}`);
    await fs.writeFile(file, text.replaceAll(oldSha, newSha));
  }
}

async function repinBaseFacts(clientVersion, archive) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'data/catalog-manifest.json'), 'utf8'));
  ensure(String(manifest.clientVersion) === clientVersion, 'catalog-manifest.json is not at the requested client');
  const itemsFile = path.join(root, 'data/catalog-sources', archive, 'items.json');
  const raw = await fs.readFile(itemsFile);
  const parsed = JSON.parse(raw.toString('utf8'));
  const table = formatEntries(extractBaseFacts(Array.isArray(parsed) ? parsed : Object.values(parsed)));
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const file = path.join(root, 'src/screen/screen-advice.ts');
  const original = await fs.readFile(file, 'utf8');
  const crlf = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');
  const before = text;
  text = text.replace(/const PINNED_CLIENT = '\d+';/, `const PINNED_CLIENT = '${clientVersion}';`)
    .replace(/const PINNED_REVISION = '\d+';/, `const PINNED_REVISION = '${manifest.sourceRevision}';`)
    .replace(/Extracted from the saved client-\d+ Valve-asset snapshot \(items SHA-256\n \* [0-9a-f]{64}\)/, `Extracted from the saved client-${clientVersion} Valve-asset snapshot (items SHA-256\n * ${sha})`);
  const start = text.indexOf('const PINNED_BASE_FACTS: Record<string, BaseFacts> = {\n');
  const end = text.indexOf('\n};\n', start);
  ensure(start >= 0 && end > start, 'PINNED_BASE_FACTS table not found');
  const header = 'const PINNED_BASE_FACTS: Record<string, BaseFacts> = {\n';
  const oldTable = text.slice(start + header.length, end);
  text = text.slice(0, start + header.length) + table + text.slice(end);
  await fs.writeFile(file, crlf ? text.replace(/\n/g, '\r\n') : text);
  console.log(`  base facts: ${oldTable.trim() === table.trim() ? 'unchanged' : 'UPDATED, review the item scoring tests'}; pinned ${clientVersion}/${manifest.sourceRevision}${before === text ? ' (no change)' : ''}`);
}

async function heroNames() {
  try {
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'data/public-catalog.json'), 'utf8'));
    return new Map(catalog.heroes.map(hero => [hero.id, hero.name]));
  } catch { return new Map(); }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--client-version');
  const clientVersion = flag >= 0 ? args[flag + 1] : await latestClientVersion();
  ensure(/^\d+$/.test(clientVersion ?? ''), 'Usage: node scripts/refresh-patch.mjs [--client-version <N>]');
  const before = await heroNames();
  console.log(`Refreshing game data for Deadlock client ${clientVersion}.`);

  await node('scripts/sync-catalog.mjs', '--fetch', '--client-version', clientVersion);
  const archive = await newestArchive(path.join(root, 'data/catalog-sources'), `client-${clientVersion}-`);
  ensure(archive, `No saved archive for client ${clientVersion}`);

  const oldSha = await currentAuxCommit();
  const newSha = await trackingCommit(clientVersion);
  if (newSha !== oldSha) {
    console.log(`\nAuxiliary Valve files: ${oldSha.slice(0, 10)} -> ${newSha.slice(0, 10)}`);
    await downloadAux(oldSha, newSha);
    await repinAux(oldSha, newSha);
  }
  await node('scripts/sync-catalog.mjs', '--client-version', clientVersion, '--from-dir', `data/catalog-sources/${archive}`);
  await node('scripts/sync-context-catalog.mjs', '--rebuild');
  await node('scripts/sync-reader-icons.mjs', '--refresh');
  await node('scripts/sync-context-icons.mjs', '--refresh');
  await node('scripts/sync-street-brawl-data.mjs');
  console.log('\n> repin item base facts');
  await repinBaseFacts(clientVersion, archive);

  // build-native.mjs builds the reader when needed and prepares the descriptors (on Linux only when the icons changed).
  try {
    await node('scripts/build-native.mjs');
  } catch (error) {
    console.warn(`\nReader descriptors were not rebuilt (${error.message}). Run node scripts/build-native.mjs.`);
  }

  const after = await heroNames();
  const added = [...after].filter(([id]) => !before.has(id)).map(([, name]) => name);
  const removed = [...before].filter(([id]) => !after.has(id)).map(([, name]) => name);
  console.log(`\nDone: client ${clientVersion}, ${after.size} heroes.${added.length ? ` New: ${added.join(', ')}.` : ''}${removed.length ? ` Removed: ${removed.join(', ')}.` : ''}`);
  // Street Brawl statistics only count games since the last major balance patch (STREET_BRAWL_PATCH_START).
  const brawl = JSON.parse(await fs.readFile(path.join(root, 'data/street-brawl-data.json'), 'utf8'));
  console.log(`Street Brawl statistics: games since ${brawl.window?.since?.slice(0, 10) ?? 'unknown'}. After a major item or balance patch,`
    + ' move STREET_BRAWL_PATCH_START in src/screen/street-brawl-fetch.ts to its date and rerun node scripts/sync-street-brawl-data.mjs.');
  console.log('Next: node node_modules/vitest/vitest.mjs run, then npm run package:dir (with the companion closed).');
}

main().catch(error => { console.error(`\nRefresh stopped: ${error.message}`); process.exitCode = 1; });
