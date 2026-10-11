import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sha256, scalarMap, patchKv, PROFILES, MACHINE_SETTINGS, LEGACY_VIDEO_KEYS } from './config-core.mjs';
import { commitFiles } from './transaction.mjs';

const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = Object.freeze({ appId: '1422450', build: '25689475', client: '6745', revision: '11078118', videoVersion: '20' });
const STOCK_GAMEINFO = Object.freeze({
  'gameinfo.gi': 'ee425508c3d60137a26eed5061b24bc20bebde63c412000ac640deb468a566c3',
  'gameinfo_branchspecific.gi': '8dcaa0993e2fd12f988aa2306fd7550d52a47c8c0b871303242dfbcab775106a',
});
const NAMES = ['video.txt', 'machine_convars.vcfg'];

function winRead(code) {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); " + code],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
}

function running() {
  return winRead("if (Get-Process -Name deadlock -ErrorAction SilentlyContinue) { 'running' } else { 'closed' }") === 'running';
}

function context({ forRestore = false } = {}) {
  if (process.platform !== 'win32') throw new Error('This profile is for the audited Windows machine.');
  const inventory = JSON.parse(winRead(`
    $steamRoot=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam').SteamPath;
    $activeUser=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\ActiveProcess').ActiveUser;
    if (-not $activeUser) { throw 'No active Steam user. Start Steam and select your account.' };
    [pscustomobject]@{
      steamRoot=$steamRoot; account=[string]$activeUser;
      cpu=@(Get-CimInstance Win32_Processor | ForEach-Object { $_.Name });
      gpu=@(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
    } | ConvertTo-Json -Compress
  `));
  if (!inventory.cpu.some((name) => name.includes('9800X3D')) || !inventory.gpu.includes('AMD Radeon RX 7800 XT')) {
    throw new Error('Hardware differs from the audited 9800X3D / RX 7800 XT. Re-audit before applying.');
  }
  if (!/^\d+$/.test(inventory.account)) throw new Error('Invalid Steam account selector');
  const steamRoot = fs.realpathSync(inventory.steamRoot);
  // This game was positively located in the primary Steam library; no general
  // multi-library/other-machine installer is implied.
  const manifestPath = path.join(steamRoot, 'steamapps', `appmanifest_${PIN.appId}.acf`);
  const manifest = scalarMap(fs.readFileSync(manifestPath, 'utf8'), ['AppState'], { allowNested: true });
  if (manifest.buildid?.length !== 1 || manifest.buildid[0] !== PIN.build || manifest.StateFlags?.[0] !== '4' ||
      (manifest.TargetBuildID && manifest.TargetBuildID[0] !== PIN.build)) throw new Error('Deadlock build/state changed. Re-audit the new patch before applying.');
  const installDir = manifest.installdir?.[0];
  if (installDir !== 'Deadlock') throw new Error('Unexpected install directory; re-audit required');
  const gameRoot = fs.realpathSync(path.join(steamRoot, 'steamapps', 'common', installDir, 'game'));
  for (const [name, expectedHash] of Object.entries(STOCK_GAMEINFO)) {
    if (sha256(fs.readFileSync(path.join(gameRoot, 'citadel', name))) !== expectedHash) throw new Error('Stock gameinfo changed. Re-audit before applying or restoring.');
  }
  const stamp = fs.readFileSync(path.join(gameRoot, 'citadel', 'steam.inf'), 'utf8');
  if (!new RegExp(`^ClientVersion=${PIN.client}\\r?$`, 'm').test(stamp) ||
      !new RegExp(`^SourceRevision=${PIN.revision}\\r?$`, 'm').test(stamp)) throw new Error('Game source revision changed. Re-audit required.');
  const cfgRoot = fs.realpathSync(path.join(steamRoot, 'userdata', inventory.account, PIN.appId, 'local', 'cfg'));
  const expected = path.join(steamRoot, 'userdata', inventory.account, PIN.appId, 'local', 'cfg');
  if (cfgRoot.toLowerCase() !== expected.toLowerCase()) throw new Error('Redirected settings directory; inspect it before applying.');
  const video = scalarMap(fs.readFileSync(path.join(cfgRoot, 'video.txt'), 'utf8'), ['video.cfg']);
  if (video.Version?.[0] !== PIN.videoVersion || video.VendorID?.[0] !== '4098' || video.DeviceID?.[0] !== '29822') throw new Error('Native video version/device differs from audited profile.');
  if (!forRestore && (video['setting.defaultres']?.[0] !== '1920' || video['setting.defaultresheight']?.[0] !== '1080')) throw new Error('Display resolution changed. Re-audit this profile before applying.');
  return { steamRoot, cfgRoot, gameRoot, account: inventory.account, pin: PIN };
}

function patchFiles(ctx, profile) {
  return NAMES.map((name) => {
    const target = path.join(ctx.cfgRoot, name);
    if (fs.realpathSync(target).toLowerCase() !== target.toLowerCase()) throw new Error('Redirected settings file');
    const bytes = fs.readFileSync(target);
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('Settings encoding is not UTF-8; inspect before changing it.');
    const patch = name === 'video.txt'
      ? patchKv(source, ['video.cfg'], PROFILES[profile].video, LEGACY_VIDEO_KEYS)
      : patchKv(source, ['config', 'convars'], MACHINE_SETTINGS);
    const content = Buffer.from(patch.content, 'utf8');
    return { name, target, beforeHash: sha256(bytes), afterHash: sha256(content), content, changes: patch.changes };
  });
}

function prepare(profile) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`Unknown profile ${profile}`);
  const ctx = context();
  const files = patchFiles(ctx, profile);
  const directory = path.join(home, 'local', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(directory, file.name), file.content);
  const plan = { format: 1, kind: 'profile', profile, createdAt: new Date().toISOString(),
    measuredWinner: false, context: ctx, files: files.map(({ content, ...file }) => file) };
  const planPath = path.join(directory, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(home, 'local', 'latest-plan.txt'), planPath);
  console.log(`Prepared ${PROFILES[profile].name}. No game or Steam files changed.`);
  console.log(PROFILES[profile].description);
  for (const file of files) {
    console.log(`\n${file.name}: ${file.changes.length} changes`);
    for (const change of file.changes) console.log(`  ${change.key}: ${change.before ?? '(absent)'} -> ${change.after ?? '(removed)'}`);
  }
  console.log(`\nReview plan: ${planPath}`);
  console.log(`Apply after quitting Deadlock and Steam Cloud finishes: node optimization/tools/optimizer.mjs apply --plan "${planPath}"`);
  if (running()) console.log('Deadlock is running. Application and restore will refuse to modify settings until it is closed.');
}

function loadPlan(planPath) {
  if (!planPath) planPath = fs.readFileSync(path.join(home, 'local', 'latest-plan.txt'), 'utf8').trim();
  const resolved = fs.realpathSync(planPath);
  const allowed = fs.realpathSync(path.join(home, 'local')) + path.sep;
  if (!resolved.toLowerCase().startsWith(allowed.toLowerCase())) throw new Error('Plan must be a locally prepared optimization/local plan.');
  const plan = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (plan.format !== 1 || plan.kind !== 'profile' || !Object.hasOwn(PROFILES, plan.profile)) throw new Error('Invalid plan');
  return plan;
}

function assertContext(expected, actual) {
  for (const key of ['cfgRoot', 'steamRoot', 'gameRoot', 'account']) if (expected[key]?.toLowerCase() !== actual[key]?.toLowerCase()) throw new Error(`Steam context changed: ${key}`);
  if (JSON.stringify(expected.pin) !== JSON.stringify(actual.pin)) throw new Error('Build pin changed');
}

function closedGuard(ctx, { forRestore = false } = {}) {
  return () => {
    if (running()) throw new Error('Deadlock is running. Quit it normally and wait for Steam Cloud synchronization before applying.');
    const current = context({ forRestore });
    assertContext(ctx, current);
  };
}

function apply(planPath) {
  const plan = loadPlan(planPath);
  const ctx = context();
  assertContext(plan.context, ctx);
  const files = patchFiles(ctx, plan.profile);
  if (!Array.isArray(plan.files) || plan.files.length !== NAMES.length) throw new Error('Invalid plan file list');
  for (let index = 0; index < files.length; index += 1) {
    const current = files[index];
    const planned = plan.files[index];
    for (const key of ['name', 'target', 'beforeHash', 'afterHash']) if (current[key] !== planned[key]) throw new Error(`Prepared plan is stale or edited: ${current.name}. Prepare again.`);
  }
  const result = commitFiles(files, path.join(home, 'backups'), closedGuard(ctx), { ...ctx, profile: plan.profile });
  fs.writeFileSync(path.join(home, 'local', 'last-applied.json'), JSON.stringify({ profile: plan.profile, backupDirectory: result.backupDirectory }, null, 2));
  console.log(`Applied ${PROFILES[plan.profile].name}; both file hashes verified.`);
  console.log(`Originals and restore manifest: ${result.backupDirectory}`);
  console.log('Launch normally through Steam, check the video menu and FPS caps, and benchmark before declaring a performance win.');
}

function verify(profile) {
  if (profile === 'installed') {
    const saved = path.join(home, 'local', 'last-applied.json');
    if (!fs.existsSync(saved)) throw new Error('No application record. Verify an explicit profile with --profile name.');
    profile = JSON.parse(fs.readFileSync(saved, 'utf8')).profile;
  }
  const ctx = context();
  if (!Object.hasOwn(PROFILES, profile)) throw new Error('Unknown profile');
  const files = patchFiles(ctx, profile);
  const mismatches = files.flatMap((file) => file.changes.map((change) => ({ file: file.name, ...change })));
  console.log(JSON.stringify({ profile, build: PIN.build, diskSettingsMatch: mismatches.length === 0,
    runtimeVerified: false, gameRunning: running(), mismatches }, null, 2));
  if (mismatches.length) process.exitCode = 2;
}

function restore(backupDirectory) {
  if (!backupDirectory) backupDirectory = JSON.parse(fs.readFileSync(path.join(home, 'local', 'last-applied.json'), 'utf8')).backupDirectory;
  const resolved = fs.realpathSync(backupDirectory);
  const allowed = fs.realpathSync(path.join(home, 'backups')) + path.sep;
  if (!resolved.toLowerCase().startsWith(allowed.toLowerCase())) throw new Error('Backup must be inside optimization/backups.');
  const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'manifest.json'), 'utf8'));
  const ctx = context({ forRestore: true });
  assertContext(manifest.context, ctx);
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== 2) throw new Error('Invalid backup manifest');
  const files = NAMES.map((name) => {
    const entry = manifest.files.find((file) => file.name === name);
    const target = path.join(ctx.cfgRoot, name);
    if (!entry || entry.target !== target) throw new Error('Backup target mismatch');
    const content = fs.readFileSync(path.join(resolved, name));
    if (sha256(content) !== entry.beforeHash) throw new Error('Backup file hash mismatch');
    const current = fs.readFileSync(target);
    return { name, target, beforeHash: sha256(current), afterHash: sha256(content), content };
  });
  const result = commitFiles(files, path.join(home, 'backups'), closedGuard(ctx, { forRestore: true }), { ...ctx, restoringFrom: resolved });
  console.log(`Restored original settings byte-for-byte. Settings immediately before restore are backed up in ${result.backupDirectory}`);
}

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

try {
  const mode = args[0] ?? 'prepare';
  if (mode === 'prepare') prepare(option('--profile', 'fpsfirst'));
  else if (mode === 'apply') apply(option('--plan'));
  else if (mode === 'verify') verify(option('--profile', 'installed'));
  else if (mode === 'restore') restore(option('--backup'));
    else throw new Error('Use prepare --profile name (see optimization/profiles), apply [--plan path], verify [--profile name|installed], or restore [--backup directory].');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
