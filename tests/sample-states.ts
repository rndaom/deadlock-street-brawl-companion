import { APP_CATALOG } from '../src/app/catalog';
import { createInitialScreenReaderState } from '../src/shared/screen-reading';
import type { ScreenAdvice, ScreenContextObservation, ScreenOffer, ScreenReaderState } from '../src/shared/screen-reading';

/*
 * Sample reader states for interface tests. Offers, reasons and plans were produced by the
 * real advice engine (src/screen/screen-advice.ts, ability-plan.ts) for a Haze game.
 */
export type SampleStateId = 'pick' | 'imbue' | 'close' | 'reroll' | 'reading' | 'between' | 'waiting' | 'background' | 'paused';

export const SAMPLE_STATES: { id: SampleStateId; label: string }[] = [
  { id: 'pick', label: 'Draft · clear pick' },
  { id: 'imbue', label: 'Draft · imbue item' },
  { id: 'close', label: 'Draft · close call' },
  { id: 'reroll', label: 'Draft · reroll suggested' },
  { id: 'reading', label: 'Draft · reading cards' },
  { id: 'between', label: 'Between rounds' },
  { id: 'waiting', label: 'Waiting for Deadlock' },
  { id: 'background', label: 'Game in background' },
  { id: 'paused', label: 'Reading paused' },
];

const name = (id: string) => APP_CATALOG.items.find((item) => item.id === id)?.name ?? id;
const offer = (position: number, itemId: string, extra: Partial<ScreenOffer> = {}): ScreenOffer =>
  ({ position, itemId, name: name(itemId), bonusIds: [], variant: 'base', confidence: 0.97, warning: null, ...extra });

const LIMITS = [
  'Observed-context heuristic: relative comparison points, not win odds or a complete-match optimum.',
  'Recognition quality is a matching signal, not a calibrated probability of a correct read.',
  'Round 3 was read; this comparison values immediate effects and does not infer future resources.',
];
const SEATS = ['hero_haze', 'hero_atlas', 'hero_tengu', 'hero_forge', 'hero_gigawatt', 'hero_inferno', 'hero_wraith', 'hero_ghost'];
const MY_ITEMS = ['upgrade_rapid_rounds', 'upgrade_headshot_booster', 'upgrade_fleetfoot_boots', 'upgrade_slowing_bullets', 'upgrade_vampire'];
const SEAT_ITEMS = [
  MY_ITEMS,
  ['upgrade_close_range', 'upgrade_health', 'upgrade_melee_charge', 'upgrade_healbane'],
  ['upgrade_extra_charge', 'upgrade_improved_spirit', 'upgrade_healing_booster', 'upgrade_magic_slow'],
  ['upgrade_clip_size', 'upgrade_high_velocity_mag', 'upgrade_health_stimpak'],
  ['upgrade_improved_spirit', 'upgrade_extra_charge', 'upgrade_magic_tempo', 'upgrade_spirit_sap', 'upgrade_health'],
  ['upgrade_toxic_bullets', 'upgrade_magic_burst', 'upgrade_magic_shield', 'upgrade_improved_stamina'],
  ['upgrade_rapid_rounds', 'upgrade_headshot_booster', 'upgrade_kinetic_sash', 'upgrade_active_reload', 'upgrade_grit'],
  ['upgrade_mystic_regeneration', 'upgrade_extra_charge', 'upgrade_spirit_sap'],
];

const ADVICE: Record<'pick' | 'imbue' | 'close' | 'reroll', { offers: ScreenOffer[]; advice: Omit<ScreenAdvice, 'limitations'>; rerolls: number }> = {
  pick: {
    rerolls: 2,
    offers: [offer(0, 'upgrade_toxic_bullets'), offer(1, 'upgrade_quick_silver'), offer(2, 'upgrade_improved_bullet_armor')],
    advice: {
      preferredPosition: 0, title: 'Pick Toxic Bullets',
      reasons: ["Wins 53% of 34k Street Brawl games on Haze (about average) · on Valve's list for Haze.",
        'Your bullets build up a Bleed on enemies, causing them to lose a percentage of their Max Health over time.',
        'Does well against Lady Geist, Infernus in Street Brawl.',
        "Matches observed Haze's weapon direction; actual ability scaling and owned items are not known."],
      ranked: [
        { position: 0, score: 3.49, reasons: ["Wins 53% of 34k Street Brawl games on Haze (about average) · on Valve's list for Haze."] },
        { position: 1, score: 2.97, reasons: ["Wins 54% of 12k Street Brawl games on Haze (about average) · on Valve's list for Haze."] },
        { position: 2, score: 0.19, reasons: ['When below 50% health, gain additional Bullet Resist.'] },
      ],
      rerollReason: '2 rerolls left. The suggested card is a solid pick — keep your rerolls.', rerollSuggested: false,
      factsUsed: [{ scope: 'own', label: 'Haze with 5 weapon items' }, { scope: 'enemy', label: 'Lady Geist and Infernus sustain' }, { scope: 'round', label: 'Round 3 of 5' }],
    },
  },
  imbue: {
    rerolls: 1,
    offers: [offer(0, 'upgrade_magic_tempo'), offer(1, 'upgrade_kinetic_sash'), offer(2, 'upgrade_long_range', { rare: true, variant: 'enhanced' })],
    advice: {
      preferredPosition: 0, title: 'Pick Compress Cooldown',
      reasons: ['Wins 57% of 3,140 Street Brawl games on Haze (+1.8 vs. average).',
        'Imbue it on Bullet Dance: longest cooldown (165s), so it gains the most.',
        'Your ultimate comes back far sooner in every round.'],
      ranked: [
        { position: 0, score: 3.1, reasons: ['Wins 57% of 3,140 Street Brawl games on Haze (+1.8 vs. average).'] },
        { position: 1, score: 0.86, reasons: ['When you Dash-Jump you gain Fire Rate and bonus Ammo until your next reload.'] },
        { position: 2, score: 2.05, reasons: ['Wins 55% of 2,244 Street Brawl games on Haze (about average).'] },
      ],
      rerollReason: '1 reroll left. The suggested card is a solid pick — keep your rerolls.', rerollSuggested: false,
      imbue: 'Imbue it on Bullet Dance (longest cooldown (165s), so it gains the most).',
      caveat: 'Bonuses or special effects on the cards were not read; check them in game.',
    },
  },
  close: {
    rerolls: 2,
    offers: [offer(0, 'upgrade_counterspell'), offer(1, 'upgrade_tech_purge'), offer(2, 'upgrade_fury_trance')],
    advice: {
      preferredPosition: 1, title: `Slight edge: ${name('upgrade_tech_purge')}`,
      reasons: [`Close call: ${name('upgrade_tech_purge')} edges out the alternatives.`,
        "Wins 56% of 28k Street Brawl games on Haze (+1.3 vs. average) · on Valve's list for Haze.",
        'Wins more against Lady Geist 53%.', 'When below 50% health, gain additional Spirit Resist.'],
      ranked: [
        { position: 0, score: 0.39, reasons: ['Wins 54% of 3,727 Street Brawl games on Haze (about average).'] },
        { position: 1, score: 4.62, reasons: ["Wins 56% of 28k Street Brawl games on Haze (+1.3 vs. average) · on Valve's list for Haze."] },
        { position: 2, score: 4.55, reasons: ['Bullet lifesteal rewards landing weapon damage. Base stats: +100 base health.'] },
      ],
      rerollReason: '2 rerolls left. The top cards are close, but either is a solid pick — keep your rerolls.', rerollSuggested: false,
    },
  },
  reroll: {
    rerolls: 2,
    offers: [offer(0, 'upgrade_goose_egg'), offer(1, 'upgrade_acolytes_glove'), offer(2, 'upgrade_lifestrike_gauntlets')],
    advice: {
      preferredPosition: 0, title: `Reroll — or take ${name('upgrade_goose_egg')}`,
      reasons: ['Gain souls over time, as long as you are alive.', 'Requires manual activation and a suitable timing window.', 'Your next Melee attack heals you.'],
      ranked: [
        { position: 0, score: 0.6, reasons: ['Gain souls over time, as long as you are alive.'] },
        { position: 1, score: -1.5, reasons: ["Light and Heavy Melee hits deal extra spirit damage and reduce the target's Spirit Resist."] },
        { position: 2, score: -0.33, reasons: ['Wins 53% of 901 Street Brawl games on Haze (about average).'] },
      ],
      rerollReason: '2 rerolls left. None of these cards fits your hero or the fight well — a reroll is likely to offer something better.', rerollSuggested: true,
    },
  },
};

function observation(now: number): ScreenContextObservation {
  return { sessionId: 'sample', frameId: 'sample', capturedAt: now, receivedAt: now, method: 'layout-association', confidence: 1, bounds: [] };
}

export function sampleState(id: SampleStateId, now = Date.now()): ScreenReaderState {
  const base = createInitialScreenReaderState();
  const seen = observation(now);
  const ranks = id === 'between' ? [2, 1, 1, 1] : [1, 1, 0, 1];
  const plan = id === 'between'
    ? { slot: 0, ability: 'Sleep Dagger', tier: 3, cost: 5, winRate: 0.539, games: 180, then: ['Smoke Bomb', 'Fixation', 'Bullet Dance'], reason: 'the most common next upgrade from your levels, and it wins 54%' }
    : { slot: 2, ability: 'Fixation', tier: 1, cost: 1, winRate: null, games: 0, then: ['Fixation', 'Fixation', 'Sleep Dagger'], reason: 'players usually raise this one next' };
  const draft = id === 'pick' || id === 'imbue' || id === 'close' || id === 'reroll' ? ADVICE[id] : null;
  const inMatch = id !== 'waiting';
  const state: ScreenReaderState = {
    ...base, revision: 1, status: 'waiting-draft', enabled: true, engineReady: true, gamePresent: inMatch, foreground: true,
    message: 'Waiting for the item-choice screen.', generation: 1, observedAt: now, readMs: 412,
    metrics: { reads: 1284, skipped: 37, timeouts: 0, cpuPercent: 3.8, memoryMb: 61 },
    heroId: inMatch ? 'hero_haze' : null,
    matchContext: inMatch ? { ...base.matchContext, sessionId: 'sample', viewMode: 'participant', localTeam: 0, round: 3, scores: [1, 1],
      phase: draft || id === 'reading' ? 'draft' : 'combat', lastObservedAt: now,
      observations: { ...base.matchContext.observations, viewMode: seen, phase: seen, round: seen, scores: seen } } : base.matchContext,
    roster: inMatch ? { seats: SEATS, localHeroId: 'hero_haze', localSide: 0, allies: SEATS.slice(1, 4), enemies: SEATS.slice(4) } : null,
    build: inMatch ? { myItems: MY_ITEMS, seatItems: SEAT_ITEMS, abilityRanks: ranks, hiddenEnemyItems: id === 'between' ? 2 : 0 } : null,
    abilityPlan: inMatch ? plan : null,
    rerollsLeft: inMatch ? draft?.rerolls ?? 2 : null,
  };
  if (draft) return { ...state, status: 'ready', message: 'Item choices read from the game screen.', offers: draft.offers, advice: { ...draft.advice, limitations: LIMITS } };
  if (id === 'reading') return { ...state, status: 'reading', message: 'Item choices are visible but not all names could be read yet.',
    offers: [offer(0, 'upgrade_berserker'), offer(1, 'upgrade_headhunter', { confidence: 0.71 }), offer(2, 'upgrade_burst_fire')], advice: null };
  if (id === 'waiting') return { ...state, status: 'waiting-game', message: 'Waiting for Deadlock.' };
  if (id === 'background') return { ...state, status: 'interrupted', foreground: false, message: 'Return to Deadlock to read its item choices.' };
  if (id === 'paused') return { ...state, status: 'paused', enabled: false, message: 'Screen reading is paused.' };
  return state;
}
