import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = path.join(root, 'native', 'ScreenReader', 'ScreenReader.csproj');
const output = path.join(root, 'native', 'ScreenReader', 'publish');
const windows = process.platform === 'win32';
const platformName = windows ? 'Windows' : 'Linux';
const helper = path.join(output, windows ? 'ScreenReader.exe' : 'ScreenReader');
// A user-local SDK (dotnet-install.sh into ~/.dotnet) is used when no system SDK is on PATH.
const localDotnet = path.join(os.homedir(), '.dotnet', windows ? 'dotnet.exe' : 'dotnet');
const dotnet = process.env.DOTNET_ROOT && existsSync(path.join(process.env.DOTNET_ROOT, windows ? 'dotnet.exe' : 'dotnet'))
  ? path.join(process.env.DOTNET_ROOT, windows ? 'dotnet.exe' : 'dotnet') : existsSync(localDotnet) ? localDotnet : 'dotnet';
const sources = (await fs.readdir(path.dirname(project))).filter(name => /\.(cs|csproj|manifest)$/.test(name));
let current = false;
try {
  const binaryTime = (await fs.stat(helper)).mtimeMs;
  current = (await Promise.all(sources.map(name => fs.stat(path.join(path.dirname(project), name))))).every(stat => stat.mtimeMs <= binaryTime);
} catch { /* The first build must publish a native reader. */ }

if (current && !process.argv.includes('--force')) {
  console.log(`Native ${platformName} reader is current.`);
} else {
  const args = ['publish', project, '-c', 'Release', '-r', windows ? 'win-x64' : 'linux-x64', '--self-contained', 'true',
    '--output', output, '/p:DebugType=None', '/p:DebugSymbols=false'];
  await new Promise((resolve, reject) => {
    const child = spawn(dotnet, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
    child.once('error', () => reject(new Error(`The .NET 10 SDK is required to build the ${platformName} reader from source. The packaged app includes its reader.`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${platformName} reader build failed (${code}).`)));
  });
  const size = (await fs.stat(helper)).size;
  if (size < 100_000 || size > 200 * 1024 * 1024) throw new Error(`The built ${platformName} reader has an unexpected size.`);
  console.log(`Built the self-contained ${platformName} reader.`);
}

// Precompute tiny descriptors from verified static assets at build time. They
// contain no captured pixels and avoid decoding hundreds of PNGs at startup.
// The shipped descriptors are prepared on Windows (GDI+ resampling). Linux keeps them while they
// still describe the current icon manifests and prepares new ones only after the icons change.
const sha256 = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function descriptorsCurrent() {
  try {
    for (const [directory, metadata, binary] of [['assets/context-icons', 'templates.json', 'templates.bin'], ['assets/reader-icons', 'context-templates.json', 'context-templates.bin']]) {
      const meta = JSON.parse(await fs.readFile(path.join(root, directory, metadata), 'utf8'));
      if (meta.manifestSha256 !== await sha256(path.join(root, directory, 'manifest.json')) || meta.binarySha256 !== await sha256(path.join(root, directory, binary))) return false;
    }
    return true;
  } catch { return false; }
}
if (!windows && !process.argv.includes('--descriptors') && await descriptorsCurrent()) {
  console.log('Static descriptors match the current icons; keeping them.');
} else await new Promise((resolve, reject) => {
  const child = spawn(helper, ['--prepare-descriptors', path.join(root, 'assets/context-icons'), path.join(root, 'assets/reader-icons')],
    { cwd: root, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => { child.kill(); reject(new Error('Static descriptor preparation exceeded its build-time limit.')); }, 20_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Static descriptor preparation failed (${code}).`)); });
});
