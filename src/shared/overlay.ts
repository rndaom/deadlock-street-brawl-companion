import { cardHoldMs, SCREEN_CONTEXT_MAX_AGE_MS, type ScreenReaderState } from './screen-reading';

/**
 * In-game overlay geometry. Deadlock lays its HUD out on a 1920×1080 design grid, scaled
 * to the window height and centred horizontally (the native reader uses the same rule).
 * Positions below are design pixels measured from real 1080p Street Brawl draft frames.
 */
export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;

/** Centres of the three draft-card circles, in game order (left, middle, right). The middle card sits higher. */
export const DRAFT_CARD_CENTERS: readonly { x: number; y: number }[] = [{ x: 535, y: 674 }, { x: 960, y: 427 }, { x: 1387, y: 674 }];
/** Outer radius of a draft-card circle including its coloured rim. */
export const DRAFT_CARD_RADIUS = 172;
/** The "Use Re-Roll" button under the middle card. */
export const REROLL_BUTTON = { x: 855, y: 686, width: 211, height: 64 } as const;
/** Free space right of the cards, under "ROUND BEGINS IN…", for the pick explanation. */
export const OVERLAY_PANEL = { x: 1590, y: 380, width: 300 } as const;

export interface OverlayStage { left: number; top: number; scale: number }

/** Maps the design grid onto a game client of this size (CSS pixels of the overlay window). */
export function overlayStage(width: number, height: number): OverlayStage {
  const scale = height > 0 ? height / DESIGN_HEIGHT : 1;
  return { left: (width - DESIGN_WIDTH * scale) / 2, top: 0, scale };
}

/** A confirmed draft recommendation is on screen right now. */
export function overlayHasDraftCall(state: ScreenReaderState | null, now: number): boolean {
  const at = state?.observedAt ?? null;
  return !!state && state.enabled && state.status === 'ready' && state.advice !== null && state.offers.length === 3
    && at !== null && at <= now && now - at < cardHoldMs(state);
}

/** The HUD's unspent-points counter backs the spend prompt this long after it was read (the reader re-stamps it every 15 s). */
export const AP_PROMPT_MAX_AGE_MS = 20_000;

/**
 * Unspent ability points that pay for the next planned upgrade, read fresh, while the draft (and its
 * upgrade panel) is open: the overlay prompts "Spend N AP" without the hotkey. Never while spectating.
 */
export function overlayHasApPrompt(state: ScreenReaderState | null, now: number): boolean {
  if (!state || !state.enabled) return false;
  const points = state.abilityPoints;
  if (!points || !Number.isInteger(points.value) || points.value <= 0 || points.at > now || now - points.at >= AP_PROMPT_MAX_AGE_MS) return false;
  const cost = state.abilityPlan?.cost ?? (state.abilityAdvice && state.abilityAdvice.kind !== 'withheld' && state.abilityAdvice.slot !== null ? state.abilityAdvice.cost : null);
  if (cost === null || cost === undefined || points.value < cost) return false;
  const context = state.matchContext;
  if (context.viewMode === 'spectator') return false;
  const phaseAt = context.observations.phase?.capturedAt ?? null;
  const drafting = context.phase === 'draft' && phaseAt !== null && phaseAt <= now && now - phaseAt < SCREEN_CONTEXT_MAX_AGE_MS;
  const at = state.observedAt;
  const cards = (state.status === 'ready' || state.status === 'reading') && state.offers.length > 0 && at !== null && at <= now && now - at < cardHoldMs(state);
  return drafting || cards;
}

/**
 * The overlay window exists only while it has something to draw over a game that is in front:
 * a draft pick, the spend prompt for unspent ability points during a draft, or the info panel the
 * player opened with the hotkey. Otherwise it is hidden, so the game keeps its normal
 * (uncomposited) presentation and nothing floats over the desktop.
 */
export function overlayShouldShow(input: { enabled: boolean; state: ScreenReaderState | null; panel: boolean; now: number }): boolean {
  const { enabled, state, panel, now } = input;
  if (!enabled || !state || !state.enabled || !state.gamePresent || !state.foreground) return false;
  const bounds = state.gameBounds;
  if (!bounds || bounds.width < 320 || bounds.height < 240) return false;
  return panel || overlayHasDraftCall(state, now) || overlayHasApPrompt(state, now);
}
