import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_CATALOG } from '../src/app/catalog';
import type { ScreenReaderState } from '../src/shared/screen-reading';
import {
  ABILITY_COLUMN_GAPS, ABILITY_COLUMN_X, ABILITY_ICON, ABILITY_PANEL, ABILITY_PILL, ABILITY_TIER_Y, AP_NUDGE_MS, AP_PROMPT_MAX_AGE_MS, AP_SEEN_MAX_AGE_MS,
  DESIGN_HEIGHT, DESIGN_WIDTH, DRAFT_CARD_CENTERS, DRAFT_CARD_RADIUS, nextApNudgeClock, overlayAbilityNudge, overlayShouldShow, REROLL_BUTTON,
} from '../src/shared/overlay';
import type { ApNudgeClock } from '../src/shared/overlay';
import { abilityNudgeView, deriveView } from '../src/renderer/view';
import { abilityMarkGeometry, AbilityMarks } from '../src/renderer/Overlay';
import { sampleState } from './sample-states';

const now = 5_000_000;
const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
/** Between rounds in combat: 6 unspent points, the plan says Sleep Dagger III for 5 (ranks 2,1,1,1). */
const combat = (patch: Partial<ScreenReaderState> = {}): ScreenReaderState => ({ ...sampleState('between', now), gameBounds: bounds, ...patch });
const points = (value: number, at = now, seenAt?: number) => ({ abilityPoints: { value, at, ...(seenAt === undefined ? {} : { seenAt }) } as ScreenReaderState['abilityPoints'] });
const show = (state: ScreenReaderState | null, at = now, apSince: number | null = null) => overlayShouldShow({ enabled: true, state, panel: false, now: at, apSince });
const nudgeView = (state: ScreenReaderState, at = now) =>
  abilityNudgeView(deriveView(state, APP_CATALOG, { now: at, readingSince: null, lastProgressAt: at - 500 }).me, overlayAbilityNudge(state, at)!);
const px = (markup: string, property: 'left' | 'top' | 'width') => [...markup.matchAll(new RegExp(`(?<![-\\w])${property}:(-?[\\d.]+)px`, 'g'))].map((match) => Number(match[1]));

describe('ability upgrade panel geometry', () => {
  it('puts the four columns where the native reader reads the upgrade bars, one per gap', () => {
    expect(ABILITY_COLUMN_X).toHaveLength(4);
    expect(ABILITY_COLUMN_GAPS).toHaveLength(5);
    ABILITY_COLUMN_X.forEach((x, slot) => {
      expect(x).toBeGreaterThan(ABILITY_COLUMN_GAPS[slot]!);
      expect(x).toBeLessThan(ABILITY_COLUMN_GAPS[slot + 1]!);
      // Columns sit about 89 design px apart, the HUD icon pitch.
      if (slot > 0) expect(x - ABILITY_COLUMN_X[slot - 1]!).toBeCloseTo(89, -1);
    });
  });
  it('stacks the tier pills bottom-up inside the panel, above the ability icons', () => {
    const [one, two, three] = ABILITY_TIER_Y as [number, number, number];
    expect(one).toBeGreaterThan(two); expect(two).toBeGreaterThan(three);
    expect(three - ABILITY_PILL.height / 2).toBeGreaterThan(ABILITY_PANEL.top);
    expect(one + ABILITY_PILL.height / 2).toBeLessThan(ABILITY_ICON.y - ABILITY_ICON.radius);
    expect(ABILITY_ICON.y + ABILITY_ICON.radius).toBeLessThan(ABILITY_PANEL.bottom);
    expect(ABILITY_PANEL.bottom).toBeLessThan(DESIGN_HEIGHT);
  });
  it('frames a column from gap to gap, so it holds its pills and icon and never its neighbour', () => {
    for (let slot = 0; slot < 4; slot++) {
      const at = abilityMarkGeometry(slot, 3)!;
      const x = ABILITY_COLUMN_X[slot]!;
      expect(at.frame.left).toBe(ABILITY_COLUMN_GAPS[slot]);
      expect(at.frame.left + at.frame.width).toBe(ABILITY_COLUMN_GAPS[slot + 1]);
      // The pill (half a border of slack at the gap line) and the icon circle are inside the frame.
      expect(x - ABILITY_PILL.width / 2).toBeGreaterThan(at.frame.left);
      expect(x + ABILITY_PILL.width / 2).toBeLessThan(at.frame.left + at.frame.width + 1);
      expect(x - ABILITY_ICON.radius).toBeGreaterThan(at.frame.left);
      expect(x + ABILITY_ICON.radius).toBeLessThan(at.frame.left + at.frame.width);
      expect(at.frame.top).toBeLessThan(ABILITY_TIER_Y[2]! - ABILITY_PILL.height / 2);
      expect(at.frame.top + at.frame.height).toBeGreaterThan(ABILITY_ICON.y + ABILITY_ICON.radius);
      // The marker is clear of the neighbouring columns' pills.
      if (slot > 0) expect(at.frame.left).toBeGreaterThan(ABILITY_COLUMN_X[slot - 1]! + ABILITY_PILL.width / 2 - 2);
      if (slot < 3) expect(at.frame.left + at.frame.width).toBeLessThan(ABILITY_COLUMN_X[slot + 1]! - ABILITY_PILL.width / 2 + 2);
    }
  });
  it('rings the tier pill to click, and only a real tier', () => {
    for (const tier of [1, 2, 3]) {
      const pill = abilityMarkGeometry(1, tier)!.pill!;
      expect(pill.top + pill.height / 2).toBe(ABILITY_TIER_Y[tier - 1]);
      expect(pill.left + pill.width / 2).toBe(ABILITY_COLUMN_X[1]);
    }
    expect(abilityMarkGeometry(1, null)!.pill).toBeNull();
    expect(abilityMarkGeometry(4, 1)).toBeNull();
    expect(abilityMarkGeometry(-1, 1)).toBeNull();
  });
  it('anchors the label above the panel at the column\'s right edge, inside the grid; the frames stay clear of the draft cards', () => {
    for (let slot = 0; slot < 4; slot++) {
      const { label } = abilityMarkGeometry(slot, 1)!;
      expect(label.left).toBe(ABILITY_COLUMN_GAPS[slot + 1]);
      expect(label.top).toBeLessThan(ABILITY_PANEL.top);
      // A label up to 520 px wide (the CSS max) ending here stays on the grid.
      expect(label.left - 520).toBeGreaterThan(0);
      expect(label.left).toBeLessThan(DESIGN_WIDTH);
    }
    // The marker (label up to ~70 px tall) sits below the Re-Roll button, and the column frames between the side cards.
    expect(ABILITY_PANEL.top - 12 - 70).toBeGreaterThan(REROLL_BUTTON.y + REROLL_BUTTON.height);
    expect(ABILITY_COLUMN_GAPS[0]!).toBeGreaterThan(DRAFT_CARD_CENTERS[0]!.x + DRAFT_CARD_RADIUS);
    expect(ABILITY_COLUMN_GAPS[4]!).toBeLessThan(DRAFT_CARD_CENTERS[2]!.x - DRAFT_CARD_RADIUS);
  });
});

describe('ability nudge rules', () => {
  it('nudges in combat while fresh points pay for the next planned upgrade', () => {
    expect(overlayAbilityNudge(combat(), now)).toEqual({ slot: 0, tier: 3, cost: 5, points: 6, ready: true });
    expect(show(combat())).toBe(true);
  });
  it('names the next step without prompting to spend when the points fall short', () => {
    const short = combat(points(3));
    expect(overlayAbilityNudge(short, now)).toMatchObject({ slot: 0, tier: 3, cost: 5, points: 3, ready: false });
    expect(show(short)).toBe(true);
    expect(show(short, now, now - AP_NUDGE_MS)).toBe(false);
  });
  it('falls back on the source-effect advice, taking the tier from the ranks read', () => {
    const state = combat({ abilityPlan: null, abilityAdvice: { kind: 'plan', slot: 1, abilityId: null, title: 'Next upgrade', reasons: [], limitations: [], cost: 2, availablePoints: 6 } });
    expect(overlayAbilityNudge(state, now)).toEqual({ slot: 1, tier: 2, cost: 2, points: 6, ready: true });
    expect(overlayAbilityNudge({ ...state, abilityAdvice: { ...state.abilityAdvice!, kind: 'withheld', slot: null, cost: null } }, now)).toBeNull();
    expect(overlayAbilityNudge({ ...state, abilityAdvice: { ...state.abilityAdvice!, cost: null } }, now)).toBeNull();
  });
  it('draws nothing from a stale, future or empty counter', () => {
    for (const patch of [points(0), points(6, now - AP_PROMPT_MAX_AGE_MS), points(6, now + 1), { abilityPoints: null }, points(2.5)]) {
      expect(overlayAbilityNudge(combat(patch), now)).toBeNull();
      expect(show(combat(patch))).toBe(false);
    }
  });
  it('uses the reader\'s last-seen time when it supplies one', () => {
    expect(overlayAbilityNudge(combat(points(6, now - 14_000, now - 1_000)), now)?.ready).toBe(true);
    expect(overlayAbilityNudge(combat(points(6, now - 1_000, now - AP_SEEN_MAX_AGE_MS)), now)).toBeNull();
    expect(overlayAbilityNudge(combat(points(6, now, now + 1)), now)).toBeNull();
  });
  it('never while spectating, after the match, outside a match or with the reader paused', () => {
    const base = combat();
    for (const state of [
      combat({ matchContext: { ...base.matchContext, viewMode: 'spectator' } }),
      combat({ matchContext: { ...base.matchContext, phase: 'finished' } }),
      combat({ roster: { ...base.roster!, phase: 'outside' } }),
      combat({ enabled: false }),
      combat({ abilityPlan: { ...base.abilityPlan!, slot: 4 } }),
      combat({ abilityPlan: { ...base.abilityPlan!, cost: 0 } }),
    ]) expect(overlayAbilityNudge(state, now)).toBeNull();
  });
  it('keeps the overlay off the desktop: the game must be present, in front and placed', () => {
    for (const state of [combat({ foreground: false }), combat({ gamePresent: false }), combat({ gameBounds: null })]) expect(show(state)).toBe(false);
    expect(overlayShouldShow({ enabled: false, state: combat(), panel: false, now })).toBe(false);
  });
});

describe('ability nudge clock', () => {
  it('keeps the first sighting while the amount stands, and restarts when it changes', () => {
    const first = nextApNudgeClock(null, combat(points(6, now - 2_000)), now)!;
    expect(first).toEqual({ value: 6, since: now - 2_000 });
    // The reader re-stamps an unchanged amount every 15 s; the clock still counts from the first sighting.
    expect(nextApNudgeClock(first, combat(points(6, now + 15_000)), now + 15_000)).toBe(first);
    expect(nextApNudgeClock(first, combat(points(5, now + 16_000)), now + 16_000)).toEqual({ value: 5, since: now + 16_000 });
    expect(nextApNudgeClock(first, combat(points(0, now + 16_000)), now + 16_000)).toBeNull();
    expect(nextApNudgeClock(first, null, now)).toBeNull();
  });
  it('shows the nudge as points arrive, steps aside after AP_NUDGE_MS, and comes back when points are spent or added', () => {
    let clock: ApNudgeClock | null = null;
    const step = (state: ScreenReaderState, at: number) => { clock = nextApNudgeClock(clock, state, at); return show(state, at, clock?.since ?? null); };
    expect(step(combat(points(6, now)), now)).toBe(true);
    expect(step(combat(points(6, now + 15_000)), now + 15_000)).toBe(true);
    expect(step(combat(points(6, now + 30_000)), now + AP_NUDGE_MS - 1)).toBe(true);
    expect(step(combat(points(6, now + 45_000)), now + AP_NUDGE_MS)).toBe(false);
    // One tier bought: 1 point left, short of the next step, which is named for a while again.
    const after = combat({ ...points(1, now + 50_000), abilityPlan: { ...combat().abilityPlan!, slot: 1, ability: 'Smoke Bomb', tier: 2, cost: 2 } });
    expect(step(after, now + 50_000)).toBe(true);
    expect(overlayAbilityNudge(after, now + 50_000)?.ready).toBe(false);
    expect(step(combat(points(0, now + 52_000)), now + 52_000)).toBe(false);
  });
});

describe('ability marker drawing', () => {
  it('frames the planned ability, rings its tier and says to upgrade it now', () => {
    const view = nudgeView(combat());
    expect(view).toMatchObject({ slot: 0, tier: 3, ready: true, title: 'Upgrade Sleep Dagger III now', detail: 'Hold Tab · 5 AP of your 6' });
    const markup = renderToStaticMarkup(createElement(AbilityMarks, { nudge: view }));
    const [frameLeft, pillLeft, labelLeft] = px(markup, 'left');
    expect(frameLeft).toBe(ABILITY_COLUMN_GAPS[0]);
    expect(pillLeft).toBe(ABILITY_COLUMN_X[0]! - ABILITY_PILL.width / 2 - 4);
    expect(labelLeft).toBe(ABILITY_COLUMN_GAPS[1]);
    expect(px(markup, 'top')[1]).toBe(ABILITY_TIER_Y[2]! - ABILITY_PILL.height / 2 - 4);
    expect(markup).toContain('Upgrade Sleep Dagger III now');
    expect(markup).not.toContain('ov-ab-soft');
  });
  it('marks a step the points cannot pay for yet quietly, with how many more it needs', () => {
    const view = nudgeView(combat(points(3)));
    expect(view).toMatchObject({ ready: false, title: 'Next: Sleep Dagger III', detail: 'Needs 2 more AP · 3 of 5' });
    const markup = renderToStaticMarkup(createElement(AbilityMarks, { nudge: view }));
    expect(markup).toContain('ov-ab-frame ov-ab-soft');
    expect(markup).toContain('Next: Sleep Dagger III');
  });
  it('leaves the tier out when it is not known, and frames the column alone', () => {
    const state = combat({ abilityPlan: null, build: { ...combat().build!, abilityRanks: [2, null, 1, 1] },
      abilityAdvice: { kind: 'upgrade', slot: 1, abilityId: null, title: 'Consider upgrading', reasons: [], limitations: [], cost: 2, availablePoints: 6 } });
    const view = nudgeView(state);
    expect(view.tier).toBeNull();
    expect(view.title).toBe('Upgrade Smoke Bomb now');
    const markup = renderToStaticMarkup(createElement(AbilityMarks, { nudge: view }));
    expect(markup).not.toContain('ov-ab-pill');
    expect(markup).toContain('ov-ab-frame');
  });
});
