// Refreshes the bundled data/street-brawl-data.json from the public deadlock-api (no key needed).
// Run after a Deadlock patch: `node scripts/sync-street-brawl-data.mjs`.
// The installed app also refreshes its own copy in the background once a day (electron/main.ts).
import fs from 'node:fs/promises';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/screen/street-brawl-fetch.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { fetchStreetBrawlData } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const contextCatalog = JSON.parse(await fs.readFile(new URL('../data/context-catalog.json', import.meta.url), 'utf8'));
const slots = new Map(contextCatalog.abilities.map(ability => [String(ability.numericId), ability.slot]));
const output = await fetchStreetBrawlData(slots);
await fs.writeFile(new URL('../data/street-brawl-data.json', import.meta.url), `${JSON.stringify(output)}\n`);
console.log(`Saved ${Object.keys(output.items).length} items and ${Object.keys(output.heroes).length} heroes`,
  `(${Object.keys(output.globalItemStats).length} item win rates, fetched ${output.fetchedAt}).`);
