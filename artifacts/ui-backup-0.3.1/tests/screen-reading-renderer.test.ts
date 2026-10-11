import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProgressTimedOut, ScreenReading } from '../src/renderer/ScreenReading';
import { DEMO_CATALOG } from '../src/demo/scenarios';
import { createInitialScreenReaderState, SCREEN_CARD_HOLD_MS } from '../src/shared/screen-reading';
import type { ScreenAdvice, ScreenOffer, ScreenObservedPlayer, ScreenReaderState } from '../src/shared/screen-reading';

const now = 1_000_000;
const offers: ScreenOffer[] = DEMO_CATALOG.items.slice(0, 3).map((item, position) => ({ position, itemId: item.id, name: item.name, bonusIds: [], variant: 'base', confidence: .96, warning: null }));
const advice: ScreenAdvice = { preferredPosition: 0, title: 'Situational preference', reasons: ['Observed own build reason.'], limitations: ['Observed builds may change.'],
  ranked: offers.map((offer) => ({ position: offer.position, score: 1, reasons: ['Observed mechanics comparison.'] })), rerollReason: 'Zero rerolls were read.',
  factsUsed: [{ scope: 'enemy', label: 'Observed opponent healing item', observedAt: now - 10_000, playerSeat: 4 }] };
function reader(patch: Partial<ScreenReaderState> = {}): ScreenReaderState {
  const initial = createInitialScreenReaderState();
  return { ...initial, status: 'ready', enabled: true, engineReady: true, gamePresent: true, foreground: true,
    matchContext: { ...initial.matchContext, sessionId: 'visible-session', viewMode: 'participant', lastObservedAt: now - 100,
      observations: { ...initial.matchContext.observations, viewMode: { sessionId: 'visible-session', frameId: 'own-frame',
        capturedAt: now - 100, receivedAt: now, method: 'layout-association', confidence: .96, bounds: [] } } },
    observedAt: now - 100, offers, advice, ...patch };
}
function render(state: ScreenReaderState) {
  return renderToStaticMarkup(createElement(ScreenReading, { screenReader: state, catalog: DEMO_CATALOG,
    onScreenEnabled: () => {}, onScreenCrop: () => {}, onScreenRetry: () => {} }));
}
function mainDecision(html: string) { return html.split('id="screen-decision"')[1].split('</section>')[0]; }
function retainedEnemy(state: ScreenReaderState): ScreenObservedPlayer {
  return { seat: 4, team: 1, heroId: DEMO_CATALOG.heroes[1].id, isLocal: false,
    heroObservation: state.matchContext.observations.viewMode, teamObservation: null, localObservation: null,
    inventory: [], inventoryCompleteness: 'unknown', inventoryObservation: null, inventoryRevision: 0 };
}

describe('live screen-reading renderer protections', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  it('holds cards for the card-hold window but never restores them or advice from a stale READY publication', () => {
    // A read a few seconds old (slower than the old 1 s window) is still within the hold and keeps its pick.
    const held = render(reader({ observedAt: now - SCREEN_CARD_HOLD_MS + 1 }));
    expect(held).toContain('Heal Bane');
    expect(held).toContain('screen-offer-preferred');
    const html = render(reader({ observedAt: now - SCREEN_CARD_HOLD_MS }));
    expect(html).not.toContain('Heal Bane');
    expect(html).not.toContain('screen-offer-preferred');
    expect(html).toContain('Waiting for a fresh reading');
    expect(html).toContain('Read again');
    expect(html).toContain('Check reading area');
  });

  it('shows a fresh unknown partial card without inventing bonuses or a preferred pick', () => {
    const html = render(reader({ offers: [{ ...offers[0], name: 'Unknown visible card', itemId: 'unknown-item', variant: 'unknown', bonusIds: null, warning: 'Item not identified.' }], advice: null }));
    expect(html).toContain('Unknown visible card');
    expect(html).toContain('Variant not read');
    expect(html).toContain('Bonus details not confirmed');
    expect(html).not.toContain('screen-offer-preferred');
  });

  it('preserves tentative visible cards while keeping the draft claim neutral and recommendation withheld', () => {
    const html = render(reader({ status: 'reading', message: 'Confirming a new item choice…' }));
    expect(html).toContain('Checking for draft cards');
    expect(html).toContain('A current draft has not been confirmed yet');
    expect(html).toContain('Heal Bane');
    expect(html).not.toContain('Confirming a new item choice');
    expect(html).not.toContain('screen-offer-preferred');
  });

  it.each([{ enabled: false }, { observedAt: now + 100 }, { status: 'waiting-draft' as const }])('hides cards and advice when paused, future-stamped or no longer in a draft: %j', patch => {
    const html = render(reader(patch));
    expect(html).not.toContain('Heal Bane');
    expect(html).not.toContain('screen-offer-preferred');
  });

  it.each([
    [{ foreground: false }, 'Reading interrupted'],
    [{ engineReady: false }, 'Starting'],
    [{ gamePresent: false }, 'Waiting for game'],
  ] as const)('keeps a held pick visible while the game is unfocused, absent or the reader restarts (%j), with an honest status', (patch, label) => {
    const html = render(reader(patch));
    const decision = mainDecision(html);
    expect(decision).toContain('Heal Bane');
    expect(decision).toContain('Suggested · Left card');
    expect(html).toContain('screen-offer-preferred');
    // The status row still reports the real reader state instead of claiming a live read.
    expect(html.split('screen-status-row')[1].split('</div>')[0]).toContain(label);
    // Losing focus does not extend the hold: past the window the cards are gone.
    const expired = render(reader({ ...patch, observedAt: now - SCREEN_CARD_HOLD_MS }));
    expect(expired).not.toContain('Heal Bane');
    expect(expired).not.toContain('screen-offer-preferred');
  });

  it('elevates observed builds during combat and removes empty draft placeholders', () => {
    const state = reader({ status: 'waiting-draft', observedAt: null, offers: [], advice: null });
    state.matchContext.phase = 'combat';
    state.matchContext.observations.phase = { ...state.matchContext.observations.viewMode!, method: 'visible-text' };
    const html = render(state);
    expect(html).toContain('Waiting for next item choice');
    expect(html).toContain('Next ability upgrade');
    expect(html).toContain('Reroll guidance');
    expect(html).not.toContain('Awaiting offer');
    expect(html).not.toContain('Your visible draft cards');
    expect(html).not.toContain('Teams, score &amp; ranks not read');
  });

  it('uses acquired scoreboard context even when the phase is unknown, without inventing combat', () => {
    const state = reader({ status: 'waiting-draft', observedAt: null, offers: [], advice: null });
    state.matchContext.localHeroId = DEMO_CATALOG.heroes[0].id;
    const html = render(state);
    expect(html).toContain('Waiting for match reading');
    expect(html).not.toContain('Round in progress');
    expect(html).not.toContain('Awaiting offer');
  });

  it('labels the exact contextual facts used and their original observation ages', () => {
    const html = render(reader());
    expect(html).toContain('Situational preference');
    expect(html).toContain('Facts used for this comparison');
    expect(html).toContain('Observed opponent healing item');
    expect(html).toContain('10s ago');
    expect(html).toContain('Why this item');
    expect(html).toContain('No bonus items read');
  });

  it('distinguishes a provisional base-item comparison from a confirmed bundle preference', () => {
    const html = render(reader({ offers: offers.map((offer) => ({ ...offer, bonusIds: null, variant: 'unknown' })),
      advice: { ...advice, preferredPosition: null, comparisonPosition: 1, comparisonBasis: 'main-item-base-effects', title: 'Base item to consider' } }));
    expect(html).toContain('Base item to consider');
    expect(html).toContain('Main item only');
    expect(html).toContain('Bonuses or special effects may change this choice');
    expect(html).toContain('decision-provisional');
    expect(html).toContain('screen-offer-comparison');
    expect(html).not.toContain('screen-offer-preferred');
    expect(html).not.toContain('Situational preference');
  });

  it('does not turn an unidentified card into a provisional base-item choice', () => {
    const html = render(reader({ offers: [{ ...offers[0], itemId: 'unknown', name: 'Unread card identity' }, offers[1], offers[2]],
      advice: { ...advice, preferredPosition: null, comparisonPosition: 0, comparisonBasis: 'main-item-base-effects' } }));
    expect(html).not.toContain('decision-provisional');
    expect(html).not.toContain('screen-offer-comparison');
  });

  it('distinguishes automatic workload pause from manual pause', () => {
    const automatic = render(reader({ status: 'paused', enabled: true }));
    const manual = render(reader({ status: 'paused', enabled: false }));
    expect(automatic).toContain('Retry reading');
    expect(automatic).not.toContain('Pause reading</button>');
    expect(manual).toContain('Resume reading');
  });

  it('shows an actually observed reroll zero without inventing legal availability or a future draw', () => {
    const state = reader({ status: 'waiting-draft', offers: [], advice: null, observedAt: null });
    state.matchContext.rerollsRemaining = 0;
    const html = render(state);
    expect(html).toContain('0 last read');
    expect(html).toContain('Zero rerolls were observed');
    expect(html).toContain('Availability</dt><dd>Not read');
    expect(html).toContain('Replacement model unverified');
  });

  it('leads with the top reason and reroll line, keeping further reasons, facts and reroll details behind closed panels', () => {
    const html = render(reader({ advice: { ...advice, reasons: ['Observed own build reason.', 'Secondary detailed reason.'] } }));
    const decision = mainDecision(html);
    expect(decision).toContain('Heal Bane');
    expect(decision).toContain('Left card');
    expect(decision).toContain('Observed own build reason.');
    expect(decision).toContain('Zero rerolls were read.');
    expect(decision).not.toContain('decision-reroll');
    expect(decision).not.toContain('Secondary detailed reason');
    expect(decision).not.toContain('Observed opponent healing item');
    expect(decision).not.toContain('Observed builds may change');
    expect(html).toContain('Secondary detailed reason');
    expect(html).toMatch(/<details class="detail-panel screen-advice-facts"><summary>/);
    expect(html).toMatch(/<details class="detail-panel match-build-details"><summary>/);
    expect(html).toMatch(/<details class="detail-panel screen-reroll-details"><summary>/);
    expect(html).toContain('Observed own build reason');
  });

  it('asks for a fresh identity reading without hiding the actual three card names', () => {
    const state = reader({ advice: { ...advice, preferredPosition: null } });
    state.matchContext.viewMode = 'unknown';
    const html = render(state);
    expect(html).toContain('Refresh your build');
    expect(html).toContain('Press Tab in Deadlock to refresh your hero and build');
    for (const offer of offers) expect(html).toContain(offer.name);
    expect(html).not.toContain('screen-offer-preferred');
  });

  it('does not let fresh cards refresh expired ownership proof: the pick stays, labelled as the best visible card', () => {
    const state = reader();
    state.matchContext.observations.viewMode!.capturedAt = now - 30_001;
    const html = render(state);
    const decision = mainDecision(html);
    expect(decision).toContain('Suggested · Left card');
    expect(decision).toContain('Best visible card');
    expect(decision).not.toContain('Situational pick');
    expect(html).toContain('screen-offer-preferred');
    // The request to refresh identity is still surfaced in the reading details.
    expect(html).toContain('Press Tab in Deadlock to refresh your hero and build');
    // With current proof the same advice is a situational pick.
    expect(mainDecision(render(reader()))).toContain('Situational pick');
  });

  it('marks a suggested reroll in the decision header while still naming the best card', () => {
    const html = render(reader({ advice: { ...advice, title: 'Reroll — or take Heal Bane', rerollSuggested: true, rerollReason: 'All three cards are weak for this build.' } }));
    const decision = mainDecision(html);
    expect(decision).toContain('Heal Bane');
    expect(decision).toContain('Reroll suggested');
    expect(decision).toContain('decision-reroll');
    expect(decision).toContain('All three cards are weak for this build.');
  });

  it('shows the advice caveat in the decision header when bonuses were not read', () => {
    const html = render(reader({ offers: offers.map((offer) => ({ ...offer, bonusIds: null, variant: 'unknown' })),
      advice: { ...advice, caveat: 'Card bonuses were not read; they may change this pick.' } }));
    const decision = mainDecision(html);
    expect(decision).toContain('Suggested · Left card');
    expect(decision).toContain('Card bonuses were not read; they may change this pick.');
  });

  it('can show an explicit offer-only main-item comparison without inventing own or team context', () => {
    const state = reader({ advice: { ...advice, preferredPosition: null, comparisonPosition: 1,
      comparisonBasis: 'main-item-base-effects', factsUsed: [], reasons: ['Offer-only base effects.'] } });
    state.matchContext.viewMode = 'unknown';
    const html = render(state);
    expect(mainDecision(html)).toContain(offers[1].name);
    expect(mainDecision(html)).toContain('Consider · Middle card');
    expect(mainDecision(html)).toContain('Main item only · build and teams unverified');
    expect(html).toContain('screen-offer-comparison');
    expect(html).not.toContain('screen-offer-preferred');
    expect(html).not.toContain('Observed opponent healing item');
  });

  it('does not promote cached contextual comparisons after ownership proof expires', () => {
    const state = reader({ advice: { ...advice, preferredPosition: null, comparisonPosition: 1,
      comparisonBasis: 'main-item-base-effects' } });
    state.matchContext.observations.viewMode!.capturedAt = now - 30_001;
    const html = render(state);
    expect(mainDecision(html)).toContain('Refresh your build');
    expect(html).not.toContain('Consider · Middle card');
    expect(html).not.toContain('screen-offer-comparison');
  });

  it.each([{ viewMode: 'spectator' }, { phase: 'finished' }] as const)('withholds even offer-only comparisons for a $viewMode $phase view', patch => {
    const state = reader({ advice: { ...advice, preferredPosition: null, comparisonPosition: 1,
      comparisonBasis: 'main-item-base-effects', factsUsed: [] } });
    Object.assign(state.matchContext, patch);
    const html = render(state);
    expect(html).not.toContain('Consider · Middle card');
    expect(html).not.toContain('screen-offer-comparison');
    expect(html).not.toContain('screen-offer-preferred');
  });

  it('keeps useful enemy history without claiming a retained combat round is still running', () => {
    const state = reader({ status: 'waiting-draft', observedAt: null, offers: [], advice: null });
    state.matchContext.phase = 'combat';
    state.matchContext.observations.phase = { ...state.matchContext.observations.viewMode!, capturedAt: now - 60_000, receivedAt: now };
    const html = render(state);
    expect(html).toContain('Waiting for match reading');
    expect(html).toContain('Match history');
    expect(html).toContain('Last seen match');
    expect(html).toContain('Observed right-side heroes and items');
    expect(html).not.toContain('Round in progress');
    expect(html).not.toContain('Following the match');
    expect(html).not.toContain('Awaiting offer');
  });

  it('does not equate prepared OCR and completed scans with actually acquired match data', () => {
    const initial = createInitialScreenReaderState();
    const html = render(reader({ status: 'waiting-draft', observedAt: null, offers: [], advice: null,
      message: 'Waiting for the item-choice screen.', matchContext: initial.matchContext,
      metrics: { ...initial.metrics, reads: 120 } }));
    const primary = mainDecision(html);
    expect(primary).toContain('No match data read yet');
    expect(primary).toContain('No heroes, items or draft cards have been read yet');
    expect(primary).not.toContain('Following your match');
    expect(primary).not.toContain('Reading the game');
    expect(html).toContain('Text reader prepared');
  });

  it('does not count unknown roster cells or a new context timestamp as recognized match facts', () => {
    const state = reader({ status: 'waiting-draft', observedAt: null, offers: [], advice: null });
    state.matchContext.players = [{ ...retainedEnemy(state), heroId: null,
      inventory: [{ slot: 0, itemId: null, variant: 'unknown', bonusIds: null, status: 'unknown', observation: state.matchContext.observations.viewMode! }] }];
    const html = render(state);
    expect(mainDecision(html)).toContain('No match data read yet');
    expect(html).not.toContain('Following the match');
    expect(html).not.toContain('Enemy builds are below');
  });

  it('does not conceal an unverified-capture reason behind the empty-state copy or retained builds', () => {
    const state = reader({ status: 'waiting-draft', observedAt: null, offers: [], advice: null,
      message: 'The captured game image is too old or cannot be verified. Waiting for a fresh capture.' });
    const empty = render(state);
    expect(mainDecision(empty)).toContain('No match data read yet');
    expect(mainDecision(empty)).toContain(state.message);
    state.matchContext.players = [retainedEnemy(state)];
    state.matchContext.phase = 'combat';
    state.matchContext.observations.phase = state.matchContext.observations.viewMode;
    const retained = render(state);
    expect(mainDecision(retained)).toContain(state.message);
    expect(retained).not.toContain('Following the match');
  });

  it.each([
    { status: 'interrupted', enabled: true, message: 'Return to Deadlock to continue reading.' },
    { status: 'unavailable', enabled: false, message: 'The screen reader stopped. Choose Retry.' },
    { status: 'paused', enabled: true, message: 'Screen reading paused after three timeouts. Choose Retry.' },
    { status: 'paused', enabled: false, message: 'Screen reading is paused.' },
  ] as const)('keeps a $status reader message visible above retained enemy builds', patch => {
    const state = reader({ ...patch, observedAt: null, offers: [], advice: null });
    state.matchContext.players = [retainedEnemy(state)];
    state.matchContext.phase = 'combat';
    state.matchContext.observations.phase = state.matchContext.observations.viewMode;
    const html = render(state);
    expect(mainDecision(html)).toContain(patch.message);
    expect(mainDecision(html)).not.toContain('Enemy builds are below');
    expect(html).not.toContain('Following the match');
    expect(html).toContain(DEMO_CATALOG.heroes[1].name);
  });

  it.each([{ foreground: false }, { gamePresent: false }, { enabled: false }])('does not claim active match following when acquisition prerequisites are missing: %j', patch => {
    const state = reader({ status: 'waiting-draft', observedAt: null, offers: [], advice: null, ...patch });
    state.matchContext.players = [retainedEnemy(state)];
    state.matchContext.phase = 'combat';
    state.matchContext.observations.phase = state.matchContext.observations.viewMode;
    const html = render(state);
    expect(html).not.toContain('Following the match');
    expect(mainDecision(html)).not.toContain('Enemy builds are below');
  });

  it('bounds missing completed-read progress without treating publications as fresh acquisition', () => {
    const state = reader({ status: 'waiting-draft', observedAt: null, offers: [], advice: null });
    expect(readProgressTimedOut(state, now - 7_999, now)).toBe(false);
    expect(readProgressTimedOut(state, now - 8_000, now)).toBe(true);
    const republished = { ...state, revision: state.revision + 1,
      matchContext: { ...state.matchContext, lastObservedAt: now } };
    expect(readProgressTimedOut(republished, now - 8_000, now)).toBe(true);
    expect(readProgressTimedOut(state, now, now)).toBe(false);
    expect(readProgressTimedOut(state, null, now)).toBe(false);
  });

  it.each([{ foreground: false }, { gamePresent: false }, { engineReady: false }, { enabled: false },
    { status: 'paused' }, { status: 'unavailable' }, { status: 'interrupted' }, { status: 'starting' }, { status: 'waiting-game' }] as const)(
    'does not report a read-progress timeout when acquisition is intentionally inactive: %j', patch => {
      expect(readProgressTimedOut(reader(patch), now - 60_000, now)).toBe(false);
    });
});
