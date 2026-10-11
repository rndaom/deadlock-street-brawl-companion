// Development-only smoke check of our own Electron window; never captures the desktop or game.
// Run with node_modules/electron/dist/electron.exe scripts/verify-desktop.mjs.
import { app, BrowserWindow } from 'electron';
import '../dist-electron/main.js';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'deadlock-companion-verification-'));
app.setPath('userData', temporary);
writeFileSync(path.join(temporary, 'reader-settings.json'), JSON.stringify({ enabled: false, crop: { x: .02, y: .08, width: .96, height: .84 } }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
let verificationStage = 'startup';
const verificationDeadline = setTimeout(() => {
  process.stderr.write(`Desktop UI verification exceeded its 45-second limit at ${verificationStage}.\n`);
  app.exit(1);
}, 45_000);
async function verify() {
let window;
try {
  await app.whenReady();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    if (window && !window.webContents.isLoadingMainFrame() && window.webContents.getURL() === 'companion://app/index.html') break;
    await delay(50);
  }
  if (!window || window.webContents.isLoadingMainFrame()) throw new Error('The desktop window did not load.');
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  window.webContents.setBackgroundThrottling(false);
  window.hide();
  window.setMinimumSize(0, 0);
  await window.webContents.executeJavaScript('window.companion.setScreenReaderEnabled(false)');
  await delay(100);
  const reader = await window.webContents.executeJavaScript('window.companion.getScreenReaderState()');
  if (reader.enabled || reader.offers.length) throw new Error('Verification must start with reading disabled and no game offers.');
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'data/public-catalog.json'), 'utf8'));
  const application = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const definitions = JSON.parse(await fs.readFile(path.join(root, 'data/context-catalog.json'), 'utf8'));
  const names = ['Active Reload', 'Bullet Lifesteal', 'Spirit Resilience'];
  const offers = names.map((name, position) => {
    const item = catalog.items.find(entry => entry.name === name);
    if (!item) throw new Error(`Missing fixture definition: ${name}`);
    return { position, itemId: item.id, name, bonusIds: [], variant: 'base', confidence: 1, warning: null };
  });
  const fixture = {
    ...reader, status: 'ready', enabled: true, engineReady: true, gamePresent: true, foreground: true,
    message: 'Authored development fixture for layout verification.', generation: 1, offers,
    heroId: null, observedAt: Date.now(), readMs: 34, calibrationRequired: false,
    metrics: { reads: 2, skipped: 0, timeouts: 0, cpuPercent: .3, memoryMb: 148 },
    advice: { preferredPosition: 0, title: 'Compare the visible items',
      reasons: ['Fixture comparison of known item mechanics.', 'Confirm each name in Deadlock before choosing.'],
      limitations: ['Development fixture; no real match was read.'],
      ranked: offers.map(offer => ({ position: offer.position, score: 3 - offer.position, reasons: ['Known base-item comparison; match details remain unknown.'] })),
      rerollReason: 'No rerolls remain in this authored fixture.' },
  };
  const contextAt = Date.now();
  const observation = (method = 'layout-association') => ({ sessionId: 'authored-ui-session', frameId: 'authored-ui-frame',
    capturedAt: contextAt, receivedAt: contextAt, confidence: 1, method, bounds: [{ x: 0, y: 0, width: 1, height: 1 }], round: 3 });
  const fields = Object.fromEntries(Object.keys(reader.matchContext.observations).map(key => [key, observation()]));
  const rosterIds = ['hero_shiv', 'hero_kelvin', 'hero_haze', 'hero_lash', 'hero_gigawatt', 'hero_bebop', 'hero_wraith', 'hero_forge'];
  if (!rosterIds.every(id => catalog.heroes.some(hero => hero.id === id))) throw new Error('Missing authored UI hero definitions.');
  const inventory = (items) => items.map((itemId, slot) => ({ slot, itemId, status: 'recognized', variant: 'unknown', bonusIds: null, quantity: null, observation: observation('item-icon') }));
  const ownIds = catalog.items.filter(item => !offers.some(offer => offer.itemId === item.id)).slice(0, 3).map(item => item.id);
  const players = rosterIds.map((heroId, seat) => ({ seat, heroId, team: seat < 4 ? 0 : 1, isLocal: seat === 2,
    heroObservation: observation('portrait'), teamObservation: observation(), localObservation: observation(),
    inventory: inventory(seat === 2 ? ownIds : [offers[seat % 3].itemId]),
    inventoryCompleteness: 'partial', inventorySlotCompleteness: 'complete', inventoryObservation: observation('item-icon'), inventoryRevision: 1 }));
  const localAbilities = [0, 1, 2, 3].map(slot => ({ slot, abilityId: definitions.abilities.find(ability => ability.heroId === 'hero_haze' && ability.slot === slot)?.id,
    rank: [1, 2, 0, 1][slot], unlocked: true, nextUpgradeCost: 2, observation: observation('ability-pips') }));
  if (localAbilities.some(ability => !ability.abilityId)) throw new Error('Missing authored UI ability definitions.');
  const context = { ...reader.matchContext, revision: 1, sessionId: 'authored-ui-session', gameSessionId: 'authored-ui-window',
    viewMode: 'participant', phase: 'draft', round: 3, scores: [2, 1], localSeat: 2, localHeroId: 'hero_haze', localTeam: 0,
    localAbilityPoints: 3, rerollsRemaining: 1, rerollAvailable: true, pickStage: 1, observations: fields,
    players, rosterCompleteness: 'complete', rosterObservation: observation(), localInventory: players[2].inventory,
    localInventoryCompleteness: 'partial', localInventorySlotCompleteness: 'complete', localInventoryObservation: observation('item-icon'), localInventoryRevision: 1,
    localAbilities, abilityCompleteness: 'complete', abilityObservation: observation('ability-pips'), abilityRevision: 1, lastObservedAt: contextAt };
  fixture.matchContext = context;
  fixture.heroId = 'hero_haze';
  const contextual = { ...fixture, matchContext: context, abilityAdvice: { kind: 'plan', slot: 2, abilityId: localAbilities[2].abilityId,
    title: 'Next upgrade to consider: Fixation · tier 1', reasons: ['Authored source-effect layout fixture.', 'Supports the observed weapon build.'],
    limitations: ['Development fixture; no live rank or price was read.'], cost: null, availablePoints: null },
    offers: offers.map(offer => ({ ...offer, variant: 'unknown', bonusIds: null, warning: 'Special card effects are unread.' })),
    advice: { ...fixture.advice, preferredPosition: null, comparisonPosition: 0, comparisonBasis: 'main-item-base-effects', title: 'Base item to consider',
      reasons: ['Its main effects support the observed build.', 'Bonuses and special effects may change the choice.'],
      limitations: ['Development fixture; main-item effects only.'], factsUsed: [
        { scope: 'own', label: 'Haze and three observed items', observedAt: contextAt },
        { scope: 'enemy', label: 'An observed opposing build', observedAt: contextAt, playerSeat: 4 },
      ] } };
  function refreshedContext(value) {
    if (!value?.lastObservedAt) return value;
    const offset = Date.now() - value.lastObservedAt;
    // Preserve relative ages, including intentionally expired ownership proofs.
    return JSON.parse(JSON.stringify(value), (key, content) => typeof content === 'number'
      && ['capturedAt', 'receivedAt', 'lastObservedAt', 'changedAt', 'confirmedAt'].includes(key) ? content + offset : content);
  }
  await fs.mkdir(output, { recursive: true });
  await window.webContents.executeJavaScript(`(() => {
    const label = document.createElement('div');
    label.textContent = 'DEVELOPMENT FIXTURE — NOT A GAME READING';
    label.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#772900;color:white;text-align:center;padding:5px;font:12px sans-serif;pointer-events:none';
    document.body.append(label);
  })()`);
  // Windows may decline to render a fully hidden GPU-backed surface. Show this
  // clearly labelled fixture without taking focus, and capture only its page.
  window.setTitle('Layout check — development fixture');
  window.showInactive();
  const snapshots = [];
  let fixtureRevision = reader.revision;
  async function check(name, width, height, state, expanded = false, expectedCards = 3) {
    verificationStage = `${name}: layout`;
    window.setContentSize(width, height, false);
    window.webContents.send('companion:screen-reader', { ...state, matchContext: refreshedContext(state.matchContext), revision: ++fixtureRevision, observedAt: Date.now() });
    await delay(120);
    await window.webContents.executeJavaScript('document.querySelectorAll(".screen-reading details").forEach(detail => detail.open = false)');
    if (expanded) await window.webContents.executeJavaScript('document.querySelectorAll(".screen-reading details").forEach(detail => detail.open = true)');
    // Chromium defers lazy images in a hidden window. Exercise the actual local
    // asset route without showing or focusing the authored verification window.
    verificationStage = `${name}: image decoding`;
    await window.webContents.executeJavaScript(`Promise.race([
      Promise.all([...document.querySelectorAll('img[src^="companion://app/"]')].map(img => {
        img.loading = 'eager'; return img.decode().catch(() => undefined);
      })), new Promise(resolve => setTimeout(resolve, 350))
    ])`);
    verificationStage = `${name}: assertions`;
    const result = await window.webContents.executeJavaScript(`({
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      cards: document.querySelectorAll('.screen-offer').length,
      preferred: document.querySelectorAll('.screen-offer-preferred').length,
      provisional: document.querySelectorAll('.screen-offer-comparison').length,
      observedSeats: document.querySelectorAll('[data-observed-seat]').length,
      ownBuild: document.querySelector('[data-own-build]')?.textContent,
      ranks: document.querySelectorAll('.match-abilities .rank-track').length,
      facts: document.querySelector('.screen-facts')?.textContent ?? document.querySelector('.screen-facts-used')?.textContent,
      localImagesLoaded: [...document.querySelectorAll('img[src^="companion://app/"]')].filter(img => img.complete && img.naturalWidth > 0).length,
      visibleEnemyRows: [...document.querySelectorAll('.match-enemy-player[data-observed-seat]')].filter(node => node.getClientRects().length > 0).length,
      openDetailPanels: document.querySelectorAll('.screen-reading details[open]').length,
      decision: document.querySelector('#screen-reader-heading')?.textContent,
      fixtureNamesPresent: ${JSON.stringify(names)}.every(name => [...document.querySelectorAll('.screen-offer h3')].some(node => node.textContent === name)),
      pauseLabel: document.querySelector('.screen-pause')?.textContent,
      mode: [...document.querySelectorAll('.mode-control button')].find(button => button.getAttribute('aria-pressed') === 'true')?.textContent,
      hasBridge: typeof window.companion?.getScreenReaderState === 'function'
    })`);
    if (result.scrollWidth > result.width + 1) throw new Error(`Horizontal overflow in ${name}: ${JSON.stringify(result)}`);
    if (result.cards !== expectedCards || (expectedCards > 0 && !result.fixtureNamesPresent) || !result.hasBridge) throw new Error(`Missing draft UI in ${name}.`);
    const expectedPreferred = state.advice?.preferredPosition == null ? 0 : 1;
    if (result.preferred !== expectedPreferred) throw new Error(`Incorrect preference display in ${name}.`);
    const expectedComparison = state.advice?.comparisonPosition == null ? 0 : 1;
    if (result.provisional !== expectedComparison) throw new Error(`Incorrect conditional comparison in ${name}.`);
    if (state.matchContext?.players.length === 8) {
      if (result.observedSeats !== 8 || result.ranks !== 4 || !result.ownBuild?.includes('Fixation')) throw new Error(`Missing context UI in ${name}.`);
      if (result.localImagesLoaded < 1) throw new Error(`Cached context images did not load in ${name}.`);
      if (result.visibleEnemyRows !== 4 || (!expanded && result.openDetailPanels !== 0)) throw new Error(`Essential view was obscured in ${name}.`);
    }
    verificationStage = `${name}: own-window capture`;
    let captureDeadline;
    const snapshot = await Promise.race([
      window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
      new Promise((_, reject) => { captureDeadline = setTimeout(() => reject(new Error(`Own-window capture exceeded five seconds in ${name}.`)), 5_000); }),
    ]).finally(() => clearTimeout(captureDeadline));
    await fs.writeFile(path.join(output, `screen-reader-ui-${name}.png`), snapshot.toPNG());
    snapshots.push({ name, ...result });
  }
  await check('portrait', 720, 1280, fixture);
  await check('small', 360, 800, fixture);
  await window.webContents.executeJavaScript(`document.querySelector('.companion').style.setProperty('--text-scale', '1.5')`);
  await check('large-text', 720, 1280, fixture);
  await check('expanded', 600, 900, fixture, true);
  const partial = { ...fixture, offers: offers.map((offer, index) => index === 1 ? { ...offer, bonusIds: null, variant: 'enhanced', warning: 'Bonus details are unread.' } : offer), advice: { ...fixture.advice, preferredPosition: null, title: 'Compare visible base items' } };
  await check('partial', 720, 1280, partial);
  await window.webContents.executeJavaScript(`document.querySelector('.companion').style.setProperty('--text-scale', '1')`);
  await check('context-portrait', 720, 1280, contextual);
  await check('context-expanded', 720, 1280, contextual, true);
  await check('context-small', 360, 800, contextual, true);
  const combat = { ...contextual, status: 'waiting-draft', offers: [], advice: null, matchContext: { ...context, phase: 'combat' } };
  await check('context-combat', 720, 1280, combat, true, 0);
  const expiredOwnership = { ...combat, matchContext: { ...combat.matchContext, observations: { ...fields,
    viewMode: { ...fields.viewMode, capturedAt: contextAt - 31_000, receivedAt: contextAt - 31_000 } } } };
  await check('context-identity-expired', 720, 1280, expiredOwnership, true, 0);
  window.hide();
  const expiredIdentity = await window.webContents.executeJavaScript(`({ youLabels: document.querySelectorAll('.you-tag').length, own: document.querySelector('[data-own-build]')?.textContent })`);
  if (expiredIdentity.youLabels !== 0 || !expiredIdentity.own?.includes('identity unconfirmed')) throw new Error('Expired ownership retained current own-player labels.');
  window.webContents.send('companion:screen-reader', { ...reader, revision: ++fixtureRevision, enabled: true, status: 'paused', message: 'Automatic pause verification.' });
  await delay(80);
  const automaticPause = await window.webContents.executeJavaScript(`({ cards: [...document.querySelectorAll('.screen-offer h3')].map(node => node.textContent), retry: document.querySelector('.screen-pause')?.textContent })`);
  if (automaticPause.retry !== 'Retry reading' || automaticPause.cards.some(name => names.includes(name))) throw new Error('Automatic pause must clear cards and show retry.');
  window.webContents.send('companion:screen-reader', { ...fixture, revision: fixtureRevision - 1, observedAt: Date.now() });
  await delay(100);
  const stalePublication = await window.webContents.executeJavaScript(`({ cards: [...document.querySelectorAll('.screen-offer h3')].map(node => node.textContent), retry: document.querySelector('.screen-pause')?.textContent })`);
  if (stalePublication.retry !== 'Retry reading' || stalePublication.cards.some(name => names.includes(name))) throw new Error('A late publication restored cleared cards.');
  window.webContents.send('companion:screen-reader', { ...fixture, revision: ++fixtureRevision, observedAt: Date.now() });
  await delay(1_150);
  const expiredReading = await window.webContents.executeJavaScript(`({ cards: [...document.querySelectorAll('.screen-offer h3')].map(node => node.textContent), heading: document.querySelector('#screen-reader-heading')?.textContent })`);
  if (!['Waiting for a fresh reading', 'Waiting for next item choice'].includes(expiredReading.heading)
    || expiredReading.cards.some(name => names.includes(name))) throw new Error('The renderer retained expired cards without a new publication.');
  const tentative = { ...reader, enabled: true, engineReady: true, gamePresent: true, foreground: true, status: 'reading', observedAt: null, message: 'Confirming fixture choices.' };
  for (let index = 0; index < 4; index++) {
    window.webContents.send('companion:screen-reader', { ...tentative, revision: ++fixtureRevision, generation: index + 10 });
    await delay(2_100);
  }
  const unconfirmedWatchdog = await window.webContents.executeJavaScript(`({ heading: document.querySelector('#screen-reader-heading')?.textContent, actions: [...document.querySelectorAll('.screen-confirmation-help button')].map(node => node.textContent) })`);
  if (unconfirmedWatchdog.heading !== 'No current draft confirmed' || !unconfirmedWatchdog.actions.includes('Read again') || !unconfirmedWatchdog.actions.includes('Check reading area')) throw new Error('Changing tentative publications restarted the confirmation watchdog.');
  const report = { schemaVersion: 2, applicationVersion: application.version, scope: 'Actual local Electron main/preload/renderer with explicit authored UI fixtures. No game capture or input; acquisition accuracy is not established by these fixtures.', snapshots, expiredIdentity, automaticPause, stalePublication, expiredReading, unconfirmedWatchdog, rendererErrors: errors };
  if (errors.length) throw new Error('Renderer errors were reported.');
  await fs.writeFile(path.join(output, 'screen-reader-ui-verification.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ passed: true, snapshots: snapshots.length, horizontalOverflow: false, actualBridge: true, contextRendered: true, expiredIdentityCleared: true, stalePublicationIgnored: true, staleCardsExpired: true, unconfirmedWatchdogPassed: true, gameImagesCaptured: false }) + '\n');
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.stack : error) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(verificationDeadline);
  if (process.exitCode) app.exit(process.exitCode);
  else app.quit();
}
}
void verify();
