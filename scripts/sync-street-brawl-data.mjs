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
const target = new URL('../data/street-brawl-data.json', import.meta.url);
await fs.writeFile(new URL('../data/street-brawl-data.json.tmp', import.meta.url), `${JSON.stringify(output)}\n`);
await fs.rename(new URL('../data/street-brawl-data.json.tmp', import.meta.url), target);
const wide = Object.values(output.heroes).filter(hero => hero.wideWindow).map(hero => hero.name);
console.log(`Saved ${Object.keys(output.items).length} items and ${Object.keys(output.heroes).length} heroes`,
  `(${Object.keys(output.globalItemStats).length} item win rates, fetched ${output.fetchedAt}).`);
console.log(`Games since ${output.window.since.slice(0, 10)} (wide fallback since ${output.window.wideSince.slice(0, 10)}${wide.length ? ` for ${wide.join(', ')}` : ', unused'}).`,
  `Per-hero prior ${output.heroPriorMatches} games, Good-list prior ${(output.goodPrior * 100).toFixed(2)} points,`,
  output.enhanced ? `Enhanced: ${output.enhanced.share * 100 | 0}% of drafted copies, mean uplift ${(output.enhanced.meanUplift * 100).toFixed(2)} points.` : 'no Enhanced results.');
console.log(output.itemPairs ? `Item pairs: ${output.itemPairs.rows.length / 4} of ${output.itemPairs.minMatches}+ games, prior ${output.itemPairs.priorMatches} games.`
  : 'No item pairs (request failed); synergy is off until the next sync.');
