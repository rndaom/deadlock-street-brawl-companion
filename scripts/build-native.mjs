import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = path.join(root, 'native', 'ScreenReader', 'ScreenReader.csproj');
const output = path.join(root, 'native', 'ScreenReader', 'publish');
const helper = path.join(output, 'ScreenReader.exe');
const sources = (await fs.readdir(path.dirname(project))).filter(name => /\.(cs|csproj|manifest)$/.test(name));
let current = false;
try {
  const binaryTime = (await fs.stat(helper)).mtimeMs;
  current = (await Promise.all(sources.map(name => fs.stat(path.join(path.dirname(project), name))))).every(stat => stat.mtimeMs <= binaryTime);
} catch { /* The first build must publish a native reader. */ }

if (current && !process.argv.includes('--force')) {
  console.log('Native Windows reader is current.');
} else {
  const args = ['publish', project, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
    '--output', output, '/p:DebugType=None', '/p:DebugSymbols=false'];
  await new Promise((resolve, reject) => {
    const child = spawn('dotnet', args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error('The .NET 10 SDK is required to build the Windows reader from source. The packaged app includes its reader.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Windows reader build failed (${code}).`)));
  });
  const size = (await fs.stat(helper)).size;
  if (size < 100_000 || size > 200 * 1024 * 1024) throw new Error('The built Windows reader has an unexpected size.');
  console.log('Built the self-contained Windows reader.');
}

// Precompute tiny descriptors from verified static assets at build time. They
// contain no captured pixels and avoid decoding hundreds of PNGs at startup.
await new Promise((resolve, reject) => {
  const child = spawn(helper, ['--prepare-descriptors', path.join(root, 'assets/context-icons'), path.join(root, 'assets/reader-icons')],
    { cwd: root, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => { child.kill(); reject(new Error('Static descriptor preparation exceeded its build-time limit.')); }, 20_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Static descriptor preparation failed (${code}).`)); });
});
