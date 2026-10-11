// Explicit development review: serial reads of the foreground game only; no focus or input.
// Private raw evidence remains beneath the ignored optimization/captures directory.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { normalizeNativeReply, blocksForScreenParser, DRAFT_HINT_REGION } from '../electron/screen-reader';
import { DEFAULT_CAPTURE_REGION } from '../src/shared/screen-reading';
import { detectDraftHint, parseScreenOffers } from '../src/screen/offer-parser';
import { parseScreenMatchObservation } from '../src/screen/match-parser';
import { loadLocalPlayerNames } from '../electron/local-identity';
import type { Catalog } from '../src/shared/types';

async function review() {
  const root = process.cwd();
  const watchDraft = process.argv.includes('--watch-draft');
  const contextReview = process.argv.includes('--context-review');
  const directory = path.join(root, 'optimization', 'captures', contextReview ? `context-review-${Date.now()}` : watchDraft ? 'draft-review' : 'live-review');
  await fs.mkdir(directory, { recursive: true });
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'data', 'public-catalog.json'), 'utf8')) as Catalog;
  const resources = path.join(root, 'release', 'win-unpacked', 'resources');
  const localPlayerNames = await loadLocalPlayerNames();
  const child = spawn(path.join(resources, 'screen-reader', 'ScreenReader.exe'), ['--icons', path.join(resources, 'reader-icons'),
    '--context-icons', path.join(resources, 'context-icons')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered = '';
  let pending: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    if (buffered.length > 5_000_000) { child.kill(); pending?.reject(new Error('Excessive response size.')); return; }
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (pending && value.id === pending.id) { const request = pending; pending = null; clearTimeout(request.timer); request.resolve(value); }
      } catch { pending?.reject(new Error('Malformed native response.')); child.kill(); }
    }
  });
  child.stderr.resume();
  child.on('error', error => pending?.reject(error));
  child.on('exit', () => pending?.reject(new Error('Native reader exited.')));
  let sequence = 0;
  const request = (op: string, crop = { ...DEFAULT_CAPTURE_REGION }, debugPreview = false) => new Promise<unknown>((resolve, reject) => {
    const id = `review-${++sequence}`;
    const timer = setTimeout(() => { pending = null; child.kill(); reject(new Error('Diagnostic read exceeded three seconds.')); }, 3_000);
    pending = { id, resolve, reject, timer };
    child.stdin.write(JSON.stringify({ id, op, crop, debugPreview, ...(['read', 'fixture'].includes(op) ? { context: true } : {}),
      ...(op === 'fixture' ? { fixture: 'draft' } : {}) }) + '\n');
  });
  const summaries: unknown[] = [];
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + (watchDraft || contextReview ? 55_000 : 28_000);
  let liveFrames = 0;
  try {
    const warm = normalizeNativeReply(await request('fixture'));
    console.log(JSON.stringify({ event: 'prepared', nativeMs: warm.elapsedMs, ocrAvailable: warm.ocrAvailable }));
    while (Date.now() < deadline && liveFrames < (contextReview ? 8 : 4)) {
      if (watchDraft && liveFrames === 0) {
        const scanCrop = sequence % 2 ? { ...DRAFT_HINT_REGION } : { x: .02, y: .72, width: .96, height: .28 };
        const scan = normalizeNativeReply(await request('read', scanCrop), scanCrop);
        const hint = scan.foreground && ['ok', 'unchanged'].includes(scan.status) && detectDraftHint(blocksForScreenParser(scan));
        if (!hint) {
          if (sequence % 10 === 0) console.log(JSON.stringify({ event: 'watching', status: scan.status, foreground: scan.foreground, draftHint: false }));
          await delay(Math.max(1000, scan.elapsedMs * 4)); continue;
        }
        console.log(JSON.stringify({ event: 'draft-cue', nativeMs: scan.elapsedMs }));
      }
      const probe = normalizeNativeReply(await request('probe', { ...DRAFT_HINT_REGION }));
      if (probe.status !== 'ok' || !probe.foreground) {
        const status = { event: 'visibility', status: probe.status, gamePresent: probe.gamePresent, foreground: probe.foreground };
        summaries.push(status); console.log(JSON.stringify(status));
        await delay(1500); continue;
      }
      await delay(500);
      const crop = watchDraft || contextReview ? { x: 0, y: 0, width: 1, height: 1 } : liveFrames % 2 === 0 ? { ...DEFAULT_CAPTURE_REGION } : { ...DRAFT_HINT_REGION };
      const raw = await request('read', crop, contextReview || liveFrames === 0);
      const reply = normalizeNativeReply(raw, crop);
      const blocks = blocksForScreenParser(reply);
      const draftHint = detectDraftHint(blocks);
      const icons = reply.icons?.map(icon => ({ ...icon, bounds: { x: (icon.bounds.x - crop.x) / crop.width, y: (icon.bounds.y - crop.y) / crop.height, width: icon.bounds.width / crop.width, height: icon.bounds.height / crop.height } }));
      const parsed = parseScreenOffers(blocks, catalog, { draftConfirmed: draftHint, iconMatches: icons });
      const match = parseScreenMatchObservation(reply, catalog, { sessionId: 'explicit-review', receivedAt: Date.now(), localPlayerNames });
      const name = `frame-${liveFrames + 1}`;
      await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify({ raw, parsed, draftHint, match }, null, 2));
      if (reply.previewPng) await fs.writeFile(path.join(directory, contextReview ? `${name}.png` : 'game-crop.png'), Buffer.from(reply.previewPng, 'base64'));
      const summary = { event: 'frame', name, status: reply.status, foreground: reply.foreground, size: [reply.clientWidth, reply.clientHeight], crop,
        nativeMs: reply.elapsedMs, cpuMs: reply.metrics?.cpuMs, blockCount: blocks.length, draftHint, isDraft: parsed.isDraft, incomplete: parsed.incomplete,
        nativeContextPresent: !!reply.context, nativePanel: reply.context?.panel, nativeHeroMatches: reply.context?.heroes.filter(hero => hero.status === 'recognized').length ?? 0,
        nativeItemMatches: reply.context?.items.filter(item => item.status === 'recognized').length ?? 0,
        parsedMatch: { phase: match?.phase, round: match?.round, players: match?.players?.length ?? 0, knownHeroes: match?.players?.filter(player => player.heroId).length ?? 0,
          ownHeroRead: !!match?.localHeroId, viewMode: match?.viewMode }, message: parsed.message,
        offers: parsed.offers.map(offer => ({ position: offer.position, name: offer.name, confidence: offer.confidence, variant: offer.variant, bonusUnknown: offer.bonusIds === null })) };
      summaries.push(summary); console.log(JSON.stringify(summary));
      liveFrames++;
      await delay(Math.max(contextReview ? 4000 : 1000, reply.elapsedMs * 4));
    }
    await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify({ scope: 'Explicit user-requested local game review, no game focus/input, no default runtime logging.', summaries }, null, 2));
    console.log(JSON.stringify({ event: 'review-complete', liveFrames, privateDirectory: path.relative(root, directory) }));
    await request('stop');
    child.stdin.end();
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(1500).then(() => child.kill())]);
  } finally {
    if (pending) clearTimeout(pending.timer);
    if (child.exitCode === null) child.kill();
  }
}
void review().catch(error => { console.error(error.message); process.exitCode = 1; });
