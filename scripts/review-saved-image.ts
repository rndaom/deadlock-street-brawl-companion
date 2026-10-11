// Explicit offline replay of an already authorized saved PNG. Never publishes live state.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeNativeReply } from '../electron/screen-reader';
import { parseScreenMatchObservation } from '../src/screen/match-parser';
import type { Catalog } from '../src/shared/types';

async function review() {
  const root = process.cwd();
  const filename = process.argv[2];
  if (!filename || !path.isAbsolute(filename)) throw new Error('An explicitly selected absolute PNG path is required.');
  const helper = path.resolve(process.argv[3] ?? 'native/ScreenReader/publish/ScreenReader.exe');
  const expected = ['hero_ratking', 'hero_synth', 'hero_astro', 'hero_haze', 'hero_inferno', 'hero_unicorn', 'hero_orion', 'hero_necro'];
  const knownDraft = process.argv.includes('--known-draft');
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'data/public-catalog.json'), 'utf8')) as Catalog;
  const privateDirectory = path.join(root, 'optimization/captures/saved-image-review');
  await fs.mkdir(privateDirectory, { recursive: true });
  const worker = spawn(helper, ['--icons', path.join(root, 'assets/reader-icons'), '--context-icons', path.join(root, 'assets/context-icons'),
    '--review-image', filename], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: worker.stdout });
  const frames: unknown[] = [];
  let serial = 0;
  let stderrBytes = 0;
  let failure: string | null = null;
  const pendingWrites: Promise<void>[] = [];
  const timer = setTimeout(() => { failure = 'Offline review exceeded 30 seconds.'; worker.kill(); }, 30_000);
  worker.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  lines.on('line', line => {
    try {
      const raw = JSON.parse(line);
      const reply = normalizeNativeReply(raw, { x: 0, y: 0, width: 1, height: 1 });
      if (!reply.synthetic || reply.gamePresent || reply.foreground || reply.capturedAt !== null) throw new Error('Offline replay must not claim live game evidence.');
      if (parseScreenMatchObservation(reply, catalog, { receivedAt: Date.now(), sessionId: 'offline-rejected' }) !== null)
        throw new Error('Offline pixels were accepted as a live match.');
      const roster = reply.context?.heroes.filter(hero => hero.role === 'roster').sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99)) ?? [];
      const local = reply.context?.heroes.find(hero => hero.role === 'local');
      const frame = { frame: ++serial, elapsedMs: reply.elapsedMs, cpuMs: reply.metrics?.cpuMs, memoryMb: reply.metrics?.workingSetMb,
        panel: reply.context?.panel, roster: roster.map(hero => ({ seat: hero.seat, heroId: hero.heroId, confidence: hero.confidence })),
        ownSignatureHero: local?.heroId ?? null, ownHeroConfidence: local?.confidence ?? 0,
        recognizedLocalItems: reply.context?.items.filter(item => item.role === 'local-inventory' && item.status === 'recognized').map(item => item.itemId) ?? [],
        offlineEvidenceRejected: true };
      frames.push(frame); console.log(JSON.stringify(frame));
      pendingWrites.push(fs.writeFile(path.join(privateDirectory, `frame-${serial}.json`), line + '\n'));
    } catch (error) { failure = error instanceof Error ? error.message : 'Invalid offline reply.'; worker.kill(); }
  });
  const code = await new Promise<number | null>((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  clearTimeout(timer); lines.close(); await Promise.all(pendingWrites);
  const rows = frames as { roster: { seat?: number; heroId: string | null }[]; ownSignatureHero: string | null; elapsedMs: number }[];
  const exactRoster = rows.length === 4 && rows.every(frame => frame.roster.length === 8 && frame.roster.every((hero, index) => hero.seat === index && hero.heroId === expected[index]));
  const ownHaze = rows.some(frame => frame.ownSignatureHero === 'hero_haze');
  if (knownDraft && (!exactRoster || !ownHaze)) failure ??= 'Prior actual draft image did not recover its known eight badges and Haze signatures.';
  if (code !== 0 || rows.length !== 4) failure ??= 'Offline worker did not complete four serialized reads.';
  const report = { schemaVersion: 1, testedAt: new Date().toISOString(), applicationVersion: '0.3.1',
    scope: 'Explicit replay of one prior authorized saved game image; no fresh game capture or live-match proof.',
    passed: failure === null, nativeReaderSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex'),
    frameCount: frames.length, knownPriorDraftChecked: knownDraft, exactEightBadgesPassed: knownDraft && exactRoster,
    ownHazeSignaturesPassed: knownDraft && ownHaze, frames, stderrBytes, livePromotionRejected: true,
    actualScoreboardItemsValidated: false, currentParticipantMatchValidated: false, failure };
  await fs.writeFile(path.join(root, 'artifacts/saved-image-replay-verification.json'), JSON.stringify(report, null, 2) + '\n');
  if (failure) throw new Error(failure);
}
void review().catch(error => { console.error(error.message); process.exitCode = 1; });
