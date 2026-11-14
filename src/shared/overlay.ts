import { cardHoldMs, type ScreenReaderState } from './screen-reading';

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

/**
 * The ability upgrade panel at the bottom centre (held Tab, death screen; dimmed in the draft), where the
 * player clicks a tier to buy it. Measured on tab-2026-11-05T23-57-43-951Z and tab-2026-11-06T00-05-44-648Z
 * (diagnostics frames, 1920×1080 client saved at 1800×1012) and matching the native reader's ReadAbilityBars.
 * Without Tab the four ability icons stay in place and "HOLD TAB TO UPGRADE" covers the tier rows.
 */
export const ABILITY_COLUMN_X: readonly number[] = [827, 915, 1005, 1093];
/** Panel grey between (and outside) the columns: a column's marker spans from one gap to the next. */
export const ABILITY_COLUMN_GAPS: readonly number[] = [780, 871, 960, 1049, 1141];
/** Centre of each tier's pill, tier 1 (bottom, 1 AP) to tier 3 (top, 5 AP). */
export const ABILITY_TIER_Y: readonly number[] = [935, 914.5, 893];
export const ABILITY_PILL = { width: 83, height: 19 } as const;
/** The panel's green top border, and the bottom of the ability icons with their slot keys. */
export const ABILITY_PANEL = { top: 869, bottom: 1062 } as const;
/** Ability icon circles (centred on the column). */
export const ABILITY_ICON = { y: 1019, radius: 35 } as const;

/** The HUD's unspent-points counter backs the ability nudge this long after it was read (the reader re-stamps it every 15 s). */
export const AP_PROMPT_MAX_AGE_MS = 20_000;
/** With the reader's optional last-seen time, the counter must have been seen this recently (it is read every 1-2 s in a match). */
export const AP_SEEN_MAX_AGE_MS = 6_000;
/**
 * The nudge steps aside after one unspent amount has stood this long, so points saved on purpose do not keep
 * the overlay up for the round. Matches 2026-11-05..14: points were spent 7.8 s (median, p90 17.5 s) after they arrived.
 */
export const AP_NUDGE_MS = 45_000;

/** The next planned ability step and the unspent points that face it; `ready` when they pay for it now. */
export interface AbilityNudge { slot: number; tier: number | null; cost: number; points: number; ready: boolean }

/** The reader may add when the counter was last seen (unchanged reads do not re-stamp `at`). */
type PointsRead = { value: number; at: number; seenAt?: number };

/**
 * Unspent ability points, read fresh, in a match, with a known next step: where to put them. Points arrive
 * after the draft closes and are spent with Tab held, so this does not wait for a draft. Never while
 * spectating, after the match, or from a stale counter.
 */
export function overlayAbilityNudge(state: ScreenReaderState | null, now: number): AbilityNudge | null {
  if (!state || !state.enabled) return null;
  const read = state.abilityPoints as PointsRead | null | undefined;
  if (!read || !Number.isInteger(read.value) || read.value <= 0 || read.at > now || now - read.at >= AP_PROMPT_MAX_AGE_MS) return null;
  if (read.seenAt !== undefined && (read.seenAt > now || now - read.seenAt >= AP_SEEN_MAX_AGE_MS)) return null;
  const context = state.matchContext;
  if (context.viewMode === 'spectator' || context.phase === 'finished' || state.roster?.phase === 'outside') return null;
  const plan = state.abilityPlan;
  const advice = state.abilityAdvice;
  let step: { slot: number; tier: number | null; cost: number } | null = null;
  if (plan) step = { slot: plan.slot, tier: plan.tier, cost: plan.cost };
  else if (advice && advice.kind !== 'withheld' && advice.slot !== null && advice.cost !== null) {
    const rank = state.build?.abilityRanks?.[advice.slot] ?? context.localAbilities.find((ability) => ability.slot === advice.slot)?.rank ?? null;
    step = { slot: advice.slot, tier: rank !== null && rank < 3 ? rank + 1 : null, cost: advice.cost };
  }
  if (!step || !Number.isInteger(step.slot) || step.slot < 0 || step.slot > 3 || !Number.isInteger(step.cost) || step.cost <= 0) return null;
  const tier = step.tier !== null && Number.isInteger(step.tier) && step.tier >= 1 && step.tier <= 3 ? step.tier : null;
  return { slot: step.slot, tier, cost: step.cost, points: read.value, ready: read.value >= step.cost };
}

/** When the current unspent amount was first seen; follows the reader from one state to the next. */
export interface ApNudgeClock { value: number; since: number }

/** Keeps `since` while the amount stands, restarts it when the amount changes, and drops it with the nudge. */
export function nextApNudgeClock(previous: ApNudgeClock | null, state: ScreenReaderState | null, now: number): ApNudgeClock | null {
  const nudge = overlayAbilityNudge(state, now);
  if (!nudge) return null;
  if (previous && previous.value === nudge.points && previous.since <= now) return previous;
  return { value: nudge.points, since: Math.min(now, state!.abilityPoints!.at) };
}

/**
 * The overlay window exists only while it has something to draw over a game that is in front:
 * a draft pick, the ability to put unspent points into (for AP_NUDGE_MS after they appear, when the
 * caller passes `apSince`), or the info panel the player opened with the hotkey. Otherwise it is
 * hidden, so the game keeps its normal (uncomposited) presentation and nothing floats over the desktop.
 */
export function overlayShouldShow(input: { enabled: boolean; state: ScreenReaderState | null; panel: boolean; now: number; apSince?: number | null }): boolean {
  const { enabled, state, panel, now, apSince = null } = input;
  if (!enabled || !state || !state.enabled || !state.gamePresent || !state.foreground) return false;
  const bounds = state.gameBounds;
  if (!bounds || bounds.width < 320 || bounds.height < 240) return false;
  const nudge = !!overlayAbilityNudge(state, now) && (apSince === null || now - apSince < AP_NUDGE_MS);
  return panel || overlayHasDraftCall(state, now) || nudge;
}
