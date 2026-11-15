import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_CATALOG } from '../src/app/catalog';
import { cardHoldMs, createInitialScreenReaderState, SCREEN_CARD_BACKGROUND_HOLD_MS, SCREEN_CARD_HOLD_MS } from '../src/shared/screen-reading';
import type { ScreenAdvice, ScreenOffer, ScreenReaderState } from '../src/shared/screen-reading';
import { AP_NUDGE_MS, AP_PROMPT_MAX_AGE_MS, DRAFT_CARD_CENTERS, DRAFT_CARD_RADIUS, overlayAbilityNudge, overlayHasDraftCall, overlayShouldShow, overlayStage, REROLL_BUTTON } from '../src/shared/overlay';
import { DEFAULT_SETTINGS, validateSettingsPatch } from '../src/shared/settings';
import { abilityNudgeView, deriveView } from '../src/renderer/view';
import { AbilityMarks, CallSummary, draftHeader, DraftMarks, InfoPanel } from '../src/renderer/Overlay';
import { sampleState } from './sample-states';

const now = 5_000_000;
const name = (id: string) => APP_CATALOG.items.find((item) => item.id === id)!.name;
const offer = (position: number, itemId: string): ScreenOffer =>
  ({ position, itemId, name: name(itemId), bonusIds: [], variant: 'base', confidence: 0.96, warning: null });
const offers = [offer(0, 'upgrade_toxic_bullets'), offer(1, 'upgrade_quick_silver'), offer(2, 'upgrade_improved_bullet_armor')];
const advice = (patch: Partial<ScreenAdvice> = {}): ScreenAdvice => ({
  preferredPosition: 2, title: 'Pick Bullet Resilience', reasons: ['Wins 53% of 34k Street Brawl games (about average).', 'Shrugs off the enemy gun damage.'],
  limitations: ['Visible-offer heuristic.'],
  ranked: [{ position: 2, score: 3.5, reasons: [] }, { position: 0, score: 1, reasons: [] }, { position: 1, score: 0.5, reasons: [] }],
  rerollReason: '1 reroll left. The suggested card is a solid pick — keep your rerolls.', rerollSuggested: false, ...patch,
});
const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
function reader(patch: Partial<ScreenReaderState> = {}): ScreenReaderState {
  return { ...createInitialScreenReaderState(), revision: 3, status: 'ready', enabled: true, engineReady: true, gamePresent: true, foreground: true,
    message: 'Item choices read from the game screen.', observedAt: now - 100, offers, advice: advice(), generation: 2, gameBounds: bounds, ...patch };
}
const callFor = (state: ScreenReaderState) => deriveView(state, APP_CATALOG, { now, readingSince: null, lastProgressAt: now - 500 }).call!;
const px = (markup: string, property: 'left' | 'top') => [...markup.matchAll(new RegExp(`${property}:(-?[\\d.]+)px`, 'g'))].map((match) => Number(match[1]));

describe('overlay stage geometry', () => {
  it('maps the 1920×1080 design grid onto 16:9 windows one to one or scaled', () => {
    expect(overlayStage(1920, 1080)).toEqual({ left: 0, top: 0, scale: 1 });
    expect(overlayStage(2560, 1440)).toEqual({ left: 0, top: 0, scale: 4 / 3 });
    expect(overlayStage(1280, 720).scale).toBeCloseTo(2 / 3);
  });
  it('centres the design grid on ultrawide windows, like the game HUD', () => {
    const stage = overlayStage(3440, 1440);
    expect(stage.scale).toBeCloseTo(4 / 3);
    expect(stage.left).toBeCloseTo((3440 - 2560) / 2);
  });
  it('keeps every card ring inside the design grid', () => {
    for (const center of DRAFT_CARD_CENTERS) {
      expect(center.x - DRAFT_CARD_RADIUS).toBeGreaterThan(0); expect(center.x + DRAFT_CARD_RADIUS).toBeLessThan(1920);
      expect(center.y - DRAFT_CARD_RADIUS).toBeGreaterThan(0); expect(center.y + DRAFT_CARD_RADIUS).toBeLessThan(1080);
    }
    // The raised middle card's ring ends above the Re-Roll button.
    expect(DRAFT_CARD_CENTERS[1]!.y + DRAFT_CARD_RADIUS).toBeLessThan(REROLL_BUTTON.y);
  });
});

describe('overlay visibility', () => {
  const show = (state: ScreenReaderState | null, patch: { enabled?: boolean; panel?: boolean; at?: number } = {}) =>
    overlayShouldShow({ enabled: patch.enabled ?? true, state, panel: patch.panel ?? false, now: patch.at ?? now });
  it('shows over the game while a confirmed pick is fresh', () => {
    expect(show(reader())).toBe(true);
    expect(overlayHasDraftCall(reader(), now)).toBe(true);
  });
  it('stays hidden with nothing to draw, so the game keeps its normal presentation', () => {
    expect(show(reader({ status: 'waiting-draft', offers: [], advice: null, observedAt: null }))).toBe(false);
    expect(show(reader({ status: 'reading', advice: null }))).toBe(false);
    expect(show(reader({ observedAt: now - SCREEN_CARD_HOLD_MS }))).toBe(false);
  });
  it('opens the hotkey panel without a draft', () => {
    expect(show(reader({ status: 'waiting-draft', offers: [], advice: null, observedAt: null }), { panel: true })).toBe(true);
  });
  it('never draws over the desktop or the companion: the game must be present, in front and placed', () => {
    for (const state of [reader({ foreground: false }), reader({ gamePresent: false }), reader({ gameBounds: null }), reader({ gameBounds: undefined }),
      reader({ enabled: false }), reader({ gameBounds: { x: 0, y: 0, width: 200, height: 100 } }), null]) {
      expect(show(state)).toBe(false);
      expect(show(state, { panel: true })).toBe(false);
    }
    expect(show(reader(), { enabled: false })).toBe(false);
  });
  it('stays over a game that lost focus but is still seen uncovered, when the caller allows it (Windows, companion elsewhere)', () => {
    const visible = (state: ScreenReaderState, showWhileVisible: boolean) => overlayShouldShow({ enabled: true, state, panel: false, now, showWhileVisible });
    expect(visible(reader({ foreground: false, gameVisible: true }), true)).toBe(true);
    // Not allowed (Linux, or the companion sits over the game), covered, or never captured: hidden as before.
    expect(visible(reader({ foreground: false, gameVisible: true }), false)).toBe(false);
    expect(visible(reader({ foreground: false, gameVisible: false }), true)).toBe(false);
    expect(visible(reader({ foreground: false }), true)).toBe(false);
    expect(visible(reader({ foreground: false, gameVisible: true, gamePresent: false }), true)).toBe(false);
  });
});

describe('cards held while alt-tabbed (one monitor)', () => {
  it('holds cards longer only while the game is present but in the background', () => {
    expect(cardHoldMs({ gamePresent: true, foreground: true })).toBe(SCREEN_CARD_HOLD_MS);
    expect(cardHoldMs({ gamePresent: true, foreground: false })).toBe(SCREEN_CARD_BACKGROUND_HOLD_MS);
    expect(cardHoldMs({ gamePresent: false, foreground: false })).toBe(SCREEN_CARD_HOLD_MS);
    expect(SCREEN_CARD_BACKGROUND_HOLD_MS).toBeGreaterThan(SCREEN_CARD_HOLD_MS);
  });
  it('keeps the pick in the companion window while the player reads it, and drops it after the background hold', () => {
    const view = (state: ScreenReaderState) => deriveView(state, APP_CATALOG, { now, readingSince: null, lastProgressAt: now - 500 });
    const away = reader({ foreground: false, observedAt: now - 30_000 });
    expect(view(away).call?.item.name).toBe(name('upgrade_improved_bullet_armor'));
    expect(view(away).holding).toBe(true);
    expect(view(reader({ foreground: false, observedAt: now - SCREEN_CARD_BACKGROUND_HOLD_MS })).call).toBeNull();
    // Back in the game, the normal hold applies again until a fresh read confirms the cards.
    expect(view(reader({ observedAt: now - 30_000 })).call).toBeNull();
  });
});

describe('overlay marks and summary', () => {
  it('rings the recommended card at its circle and labels it', () => {
    for (const position of [0, 1, 2]) {
      const call = callFor(reader({ advice: advice({ preferredPosition: position, ranked: [{ position, score: 3, reasons: [] }] }) }));
      const markup = renderToStaticMarkup(createElement(DraftMarks, { call }));
      const center = DRAFT_CARD_CENTERS[position]!;
      const [ringLeft, chipLeft] = px(markup, 'left'); const [ringTop] = px(markup, 'top');
      const radius = DRAFT_CARD_RADIUS + 10;
      expect(ringLeft).toBe(center.x - radius); expect(ringTop).toBe(center.y - radius);
      expect(chipLeft).toBe(center.x);
      expect(markup).toContain('>Pick<');
      expect(markup).not.toContain('ov-ring-button');
    }
  });
  it('rings the Reroll button when a reroll is suggested, and marks the card to keep otherwise', () => {
    const call = callFor(reader({ advice: advice({ preferredPosition: 0, rerollSuggested: true, rerollReason: '1 reroll left. These cards are weak for your build.' }) }));
    expect(call.kind).toBe('reroll');
    const markup = renderToStaticMarkup(createElement(DraftMarks, { call }));
    expect(markup).toContain('ov-ring-button');
    expect(markup).toContain('>Reroll<');
    expect(markup).not.toContain('Re-roll');
    expect(markup).toContain('>If kept<');
    const summary = renderToStaticMarkup(createElement(CallSummary, { call }));
    expect(summary).toContain('Reroll suggested');
    expect(summary).not.toContain('Re-roll');
    expect(summary).toContain('These cards are weak for your build.');
  });
  it('summarises the pick with its name, side and top reasons', () => {
    const summary = renderToStaticMarkup(createElement(CallSummary, { call: callFor(reader()) }));
    expect(summary).toContain('Take the right card');
    expect(summary).toContain(name('upgrade_improved_bullet_armor'));
    expect(summary).toContain('Shrugs off the enemy gun damage.');
    // The keep-your-rerolls note only appears when a reroll is actually suggested.
    expect(summary).not.toContain('keep your rerolls');
  });
  it('tells the player how to close the info panel, or that the key is unavailable', () => {
    const view = deriveView(reader({ status: 'waiting-draft', offers: [], advice: null, observedAt: null }), APP_CATALOG, { now, readingSince: null, lastProgressAt: now - 500 });
    expect(renderToStaticMarkup(createElement(InfoPanel, { view, hotkey: 'F7' }))).toContain('F7 hides this panel');
    expect(renderToStaticMarkup(createElement(InfoPanel, { view, hotkey: null }))).toContain('taken by another program');
  });
});

describe('overlay setting', () => {
  it('is on by default and accepts only a boolean', () => {
    expect(DEFAULT_SETTINGS.overlay).toBe(true);
    expect(validateSettingsPatch({ overlay: false })).toEqual({ overlay: false });
    expect(() => validateSettingsPatch({ overlay: 'yes' })).toThrow();
  });
});

describe('overlay ability nudge for unspent ability points', () => {
  const draftState = (patch: Partial<ScreenReaderState> = {}) => ({ ...sampleState('pick', now), gameBounds: bounds, ...patch });
  const show = (state: ScreenReaderState, panel = false, apSince: number | null = null) => overlayShouldShow({ enabled: true, state, panel, now, apSince });
  it('shows on its own during a draft while fresh points pay for the next planned upgrade', () => {
    expect(overlayAbilityNudge(draftState(), now)).toEqual({ slot: 2, tier: 1, cost: 1, points: 1, ready: true });
    // The draft is open but the cards are not confirmed: no pick to draw, the nudge alone shows the overlay.
    const unconfirmed = draftState({ status: 'reading', advice: null });
    expect(overlayHasDraftCall(unconfirmed, now)).toBe(false);
    expect(show(unconfirmed)).toBe(true);
  });
  it('shows in combat too: points arrive after the draft closes and are spent with Tab held', () => {
    const base = draftState();
    const combat = { ...base, status: 'waiting-draft' as const, offers: [], advice: null, observedAt: null, matchContext: { ...base.matchContext, phase: 'combat' as const } };
    expect(overlayAbilityNudge(combat, now)?.ready).toBe(true);
    expect(show(combat)).toBe(true);
    // Not for the whole round: a standing amount steps aside after AP_NUDGE_MS.
    expect(show(combat, false, now - AP_NUDGE_MS)).toBe(false);
  });
  it('stays away without points, with stale points, without a plan, or while spectating', () => {
    const base = draftState();
    for (const state of [
      draftState({ abilityPoints: { value: 0, at: now } }),
      draftState({ abilityPoints: null }),
      draftState({ abilityPoints: { value: 1, at: now - AP_PROMPT_MAX_AGE_MS } }),
      draftState({ abilityPoints: { value: 1, at: now + 1_000 } }),
      draftState({ abilityPlan: null }),
      draftState({ matchContext: { ...base.matchContext, viewMode: 'spectator' } }),
    ]) expect(overlayAbilityNudge(state, now)).toBeNull();
    // Points short of the next step are named, not prompted to spend.
    expect(overlayAbilityNudge(draftState({ abilityPlan: { ...base.abilityPlan!, cost: 5 } }), now)?.ready).toBe(false);
  });
  it('names the ability and its tier on the marker', () => {
    const view = deriveView(draftState(), APP_CATALOG, { now, readingSince: null, lastProgressAt: now - 500 });
    const markup = renderToStaticMarkup(createElement(AbilityMarks, { nudge: abilityNudgeView(view.me, overlayAbilityNudge(draftState(), now)!) }));
    expect(markup).toContain('Upgrade Fixation I now');
    expect(markup).toContain('ov-ab-pill');
  });
});

describe('overlay header and wording', () => {
  const view = (state: ScreenReaderState) => deriveView(state, APP_CATALOG, { now, readingSince: null, lastProgressAt: now - 500 });
  it('heads the pick with the choice of 3 and the rerolls left', () => {
    const result = view({ ...sampleState('pick', now), gameBounds: bounds });
    expect(draftHeader(result.match)).toBe('Choice 2/3 · 2 rerolls left');
    expect(draftHeader({ ...result.match, choice: null, rerollsLeft: 0 })).toBe('No rerolls left');
    expect(draftHeader({ ...result.match, choice: null, rerollsLeft: null })).toBeNull();
    const summary = renderToStaticMarkup(createElement(CallSummary, { call: result.call!, header: draftHeader(result.match) }));
    expect(summary).toContain('Choice 2/3 · 2 rerolls left');
    // The edge leads, not the raw win rate.
    expect(summary).toContain('+2.4 vs tier avg');
    expect(summary).not.toContain('% wins');
  });
  it('writes the plan reason as a sentence', () => {
    const result = view({ ...sampleState('between', now), gameBounds: bounds });
    expect(renderToStaticMarkup(createElement(InfoPanel, { view: result, hotkey: 'F7' }))).toContain('The most common next upgrade from your levels, and it wins 54%.');
    // Between drafts the panel names what to prioritise against the enemy instead of a status line.
    expect(renderToStaticMarkup(createElement(InfoPanel, { view: result, hotkey: 'F7' }))).toContain(`Enemy threat: ${result.teams.threat!.priority}`);
  });
});
