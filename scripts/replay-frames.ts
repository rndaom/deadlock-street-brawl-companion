// Offline replay of saved diagnostic frames through the native reader and the full pick logic.
// Usage: node <bundled>.mjs <frame.png> [...more]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import catalogJson from '../data/public-catalog.json';
import { blocksForScreenParser, normalizeNativeReply } from '../electron/screen-reader';
import { createRosterTracker } from '../src/screen/draft-roster';
import { createBuildTracker } from '../src/screen/build-tracker';
import { parseScreenOffers } from '../src/screen/offer-parser';
import { evaluateScreenOffers } from '../src/screen/screen-advice';
import type { Catalog } from '../src/shared/types';

const catalog = catalogJson as unknown as Catalog;
const root = process.cwd();
const roster = createRosterTracker(catalog, { localPlayerNames: (process.env.LOCAL_NAMES ?? '').split(',').filter(Boolean) });
const build = createBuildTracker();
const item = (id: string) => catalog.items.find(entry => entry.id === id)?.name ?? id;
const name = (id: string | null) => catalog.heroes.find(hero => hero.id === id)?.name ?? id ?? '?';
for (const frame of process.argv.slice(2)) {
  const run = spawnSync(path.join(root, 'native/ScreenReader/publish/ScreenReader.exe'), ['--icons', path.join(root, 'assets/reader-icons'),
    '--context-icons', path.join(root, 'assets/context-icons'), '--review-image', path.resolve(frame)], { encoding: 'utf8', windowsHide: true });
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const reply = normalizeNativeReply(JSON.parse(line), { x: 0, y: 0, width: 1, height: 1 });
    const epochBefore = roster.snapshot().epoch;
    roster.observe(reply.context, reply.blocks.flatMap(block => block.bounds ? [{ text: block.text, bounds: block.bounds }] : []), Date.now());
    if (roster.snapshot().epoch !== epochBefore) build.reset();
    build.observe(reply.context?.brawl);
  }
  const reply = normalizeNativeReply(JSON.parse(lines[0]!), { x: 0, y: 0, width: 1, height: 1 });
  const parsed = parseScreenOffers(blocksForScreenParser(reply), catalog, { conservativeUnmarkedDetails: true });
  const known = roster.snapshot();
  const seen = build.snapshot();
  const enemyItems = known.localSide === 0 ? seen.seatItems.slice(4).flat() : known.localSide === 1 ? seen.seatItems.slice(0, 4).flat() : [];
  console.log(`  abilities ${seen.abilityRanks?.join('/') ?? '-'} | your items: ${seen.myItems.map(item).join(', ')}`);
  console.log(`  enemy items (${enemyItems.length}): ${enemyItems.map(item).join(', ')}`);
  const advice = parsed.offers.length ? evaluateScreenOffers(parsed.offers, catalog, { heroId: known.localHeroId, round: parsed.round, rerolls: parsed.rerolls, enemyHeroIds: known.enemies, ownedItemIds: seen.myItems, enemyItemIds: enemyItems }) : null;
  console.log(`\n== ${path.basename(frame)} (${reply.elapsedMs} ms)`);
  console.log(`  seats: ${known.seats.map(name).join(', ')}`);
  console.log(`  you: ${name(known.localHeroId)} (side ${known.localSide}) | allies: ${known.allies.map(name).join(', ')} | enemies: ${known.enemies.map(name).join(', ')}`);
  console.log(`  draft: ${parsed.isDraft} round ${parsed.round} rerolls ${parsed.rerolls} | cards: ${parsed.offers.map(offer => `${offer.name}${offer.variant === 'enhanced' ? ' [Enhanced]' : ''}`).join(' / ')}`);
  if (advice) {
    console.log(`  => ${advice.title} | ${advice.rerollReason}`);
    for (const entry of advice.ranked) console.log(`     ${entry.score.toFixed(2)}  ${parsed.offers.find(offer => offer.position === entry.position)?.name}: ${entry.reasons.slice(0, 2).join(' / ')}`);
  }
}
