import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import packageJson from './package.json' with { type: 'json' };

/** Dev only: serve the cached game art at the same paths the desktop app's companion:// protocol uses. */
function localGameArt(): Plugin {
  const routes: [RegExp, string][] = [
    [/^\/item-icons\/(upgrade_[A-Za-z0-9_]+\.png)$/, 'assets/reader-icons/icons'],
    [/^\/context-icons\/((?:heroes|abilities|glyphs)\/[A-Za-z0-9_-]+\.png)$/, 'assets/context-icons'],
  ];
  return {
    name: 'local-game-art',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0]!;
        for (const [pattern, directory] of routes) {
          const match = pattern.exec(path);
          const file = match ? resolve(directory, match[1]!) : null;
          if (file && existsSync(file)) {
            response.setHeader('Content-Type', 'image/png');
            createReadStream(file).pipe(response);
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localGameArt()],
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
});
