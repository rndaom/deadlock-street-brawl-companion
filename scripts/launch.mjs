import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
if (!existsSync(new URL('../dist-electron/main.js', import.meta.url))) {
  console.error('Build the application first: npm run build');
  process.exit(1);
}
const args = process.argv.slice(2);
const useOverwolf = args.includes('--overwolf');
const executable = require(useOverwolf ? '@overwolf/ow-electron' : 'electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [root, ...args.filter(arg => arg !== '--overwolf')], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
