import { build as buildWeb } from 'vite';
import { build as buildJS } from 'esbuild';
import { spawn } from 'node:child_process';

for (const script of ['scripts/sync-reader-icons.mjs', 'scripts/sync-context-catalog.mjs', 'scripts/sync-context-icons.mjs', 'scripts/build-native.mjs']) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, script.includes('sync-') ? [script, '--verify'] : [script], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} failed (${code}).`)));
  });
}

await buildWeb();
await buildJS({
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['electron'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
await buildJS({
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'],
});
console.log('Built local UI, desktop runtime, and isolated preload.');
