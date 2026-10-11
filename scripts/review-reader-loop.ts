// Explicit, bounded diagnostic of the real autonomous reader. No game focus or input.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScreenReader } from '../electron/screen-reader';
import { DEFAULT_CAPTURE_REGION } from '../src/shared/screen-reading';
import { loadLocalPlayerNames } from '../electron/local-identity';
import type { Catalog } from '../src/shared/types';

async function check() {
  const catalog = JSON.parse(await fs.readFile('data/public-catalog.json', 'utf8')) as Catalog;
  const states: unknown[] = [];
  let lastKey = '';
  const resources = path.resolve('release/win-unpacked/resources');
  const localPlayerNames = await loadLocalPlayerNames();
  const reader = createScreenReader({ helperPath: path.join(resources, 'screen-reader/ScreenReader.exe'), iconDirectory: path.join(resources, 'reader-icons'),
    contextIconDirectory: path.join(resources, 'context-icons'), localPlayerNames, catalog,
    initialCrop: { ...DEFAULT_CAPTURE_REGION }, autoStart: true,
    onState(state) {
      const key = JSON.stringify([state.status, state.message, state.offers.map(offer => offer.itemId), state.metrics.reads]);
      if (key === lastKey) return;
      lastKey = key;
      const summary = { status: state.status, message: state.message, revision: state.revision, foreground: state.foreground, offers: state.offers.map(offer => ({ position: offer.position, name: offer.name })), preferredPosition: state.advice?.preferredPosition ?? null, reads: state.metrics.reads, timeouts: state.metrics.timeouts, readMs: state.readMs };
      states.push(summary); console.log(JSON.stringify(summary));
    } });
  try {
    const samples: unknown[] = [];
    for (let index = 0; index < 12; index++) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      const current = reader.getState();
      const sample = { event: 'sample', seconds: (index + 1) * 2, status: current.status, revision: current.revision,
        gamePresent: current.gamePresent, foreground: current.foreground, reads: current.metrics.reads, timeouts: current.metrics.timeouts,
        phase: current.matchContext.phase, knownHeroes: current.matchContext.players.filter(player => player.heroId).length,
        localHeroRead: !!current.matchContext.localHeroId, cpuPercent: current.metrics.cpuPercent, memoryMb: current.metrics.memoryMb };
      samples.push(sample); console.log(JSON.stringify(sample));
    }
    const final = reader.getState();
    await fs.mkdir('optimization/local', { recursive: true });
    await fs.writeFile('optimization/local/reader-loop-review.json', JSON.stringify({ scope: 'Actual autonomous foreground reader; no images, player identifiers, game focus or game input.', states, samples, final: { status: final.status, foreground: final.foreground, reads: final.metrics.reads, timeouts: final.metrics.timeouts, cpuPercent: final.metrics.cpuPercent, memoryMb: final.metrics.memoryMb } }, null, 2));
    console.log(JSON.stringify({ event: 'finished', status: final.status, reads: final.metrics.reads, timeouts: final.metrics.timeouts }));
  } finally { await reader.dispose(); }
}
void check().catch(error => { console.error(error.message); process.exitCode = 1; });
