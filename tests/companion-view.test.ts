import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_CATALOG } from '../src/app/catalog';
import { createInitialScreenReaderState, SCREEN_CARD_HOLD_MS } from '../src/shared/screen-reading';
import type { ScreenAdvice, ScreenOffer, ScreenReaderState } from '../src/shared/screen-reading';
import { classifyReason, deriveView, parseWinStat, READ_PROGRESS_TIMEOUT_MS, READING_CONFIRM_TIMEOUT_MS, readProgressTimedOut } from '../src/renderer/view';
import type { ReaderClock } from '../src/renderer/view';
import { SAMPLE_STATES, sampleState } from './sample-states';
import { Decision } from '../src/renderer/components/Decision';
import { Guide, Loadout, Teams } from '../src/renderer/components/Loadout';
import { TopBar, MatchStrip } from '../src/renderer/components/TopBar';

const now = 5_000_000;
const name = (id: string) => APP_CATALOG.items.find((item) => item.id === id)!.name;
const offer = (position: number, itemId: string, patch: Partial<ScreenOffer> = {}): ScreenOffer =>
  ({ position, itemId, name: name(itemId), bonusIds: [], variant: 'base', confidence: 0.96, warning: null, ...patch });
const offers = [offer(0, 'upgrade_toxic_bullets'), offer(1, 'upgrade_quick_silver'), offer(2, 'upgrade_improved_bullet_armor')];
const advice: ScreenAdvice = {
  preferredPosition: 0, title: 'Pick Toxic Bullets',
  reasons: ["Wins 53% of 34k Street Brawl games on Haze (about average) · on Valve's list for Haze.", 'Your bullets build up a Bleed.', 'Does well against Lady Geist in Street Brawl.'],
  limitations: ['Visible-offer heuristic.'],
  ranked: [{ position: 0, score: 3.5, reasons: ["Wins 53% of 34k Street Brawl games on Haze (about average) · on Valve's list for Haze."] },
    { position: 1, score: 3, reasons: ['Wins 54% of 12k Street Brawl games on Haze (about average).'] },
    { position: 2, score: 0.2, reasons: ['When below 50% health, gain additional Bullet Resist.'] }],
  rerollReason: '2 rerolls left. The suggested card is a solid pick — keep your rerolls.', rerollSuggested: false,
};
function reader(patch: Partial<ScreenReaderState> = {}): ScreenReaderState {
  return { ...createInitialScreenReaderState(), revision: 3, status: 'ready', enabled: true, engineReady: true, gamePresent: true, foreground: true,
    message: 'Item choices read from the game screen.', observedAt: now - 100, offers, advice, generation: 2, ...patch };
}
const clock = (patch: Partial<ReaderClock> = {}): ReaderClock => ({ now, readingSince: null, lastProgressAt: now - 500, ...patch });
const view = (state: ScreenReaderState | null, patch: Partial<ReaderClock> = {}) => deriveView(state, APP_CATALOG, clock(patch));

describe('companion view: card freshness and recommendation', () => {
  it('names the pick and marks its card while the read is fresh', () => {
    const result = view(reader());
    expect(result.stage).toBe('call');
    expect(result.call?.kind).toBe('pick');
    expect(result.call?.item.name).toBe('Toxic Bullets');
    expect(result.call?.stat).toMatchObject({ winRate: 53, games: '34k', hero: 'Haze', valve: true });
    expect(result.cards?.map((card) => card.isPick)).toEqual([true, false, false]);
    expect(result.cards?.[0]!.fit).toBe(5);
    expect(result.cards?.[2]!.fit).toBe(1);
    expect(result.status).toEqual({ tone: 'ready', label: 'Cards read' });
  });

  it('holds cards for the hold window and withdraws them, and the pick, at its end', () => {
    expect(view(reader({ observedAt: now - SCREEN_CARD_HOLD_MS + 1 })).call?.item.name).toBe('Toxic Bullets');
    const stale = view(reader({ observedAt: now - SCREEN_CARD_HOLD_MS }));
    expect(stale.cards).toBeNull();
    expect(stale.call).toBeNull();
    expect(stale.notice).toMatchObject({ kind: 'stale', title: 'Waiting for a fresh reading', actions: ['read-again', 'reading-area'] });
  });

  it.each([{ enabled: false }, { observedAt: now + 100 }, { status: 'waiting-draft' as const }])('hides cards and advice when paused, future-stamped or out of a draft: %j', (patch) => {
    const result = view(reader(patch));
    expect(result.cards).toBeNull();
    expect(result.call).toBeNull();
  });

  it('shows tentative cards without a pick while the draft is unconfirmed, then reports it unconfirmed', () => {
    const tentative = view(reader({ status: 'reading', advice: null }), { readingSince: now - 1_000 });
    expect(tentative.cards?.map((card) => card.name)).toEqual(['Toxic Bullets', 'Quicksilver Reload', 'Bullet Resilience']);
    expect(tentative.call).toBeNull();
    expect(tentative.notice).toMatchObject({ kind: 'reading', title: 'Checking for draft cards' });
    const late = view(reader({ status: 'reading', advice: null }), { readingSince: now - READING_CONFIRM_TIMEOUT_MS });
    expect(late.notice).toMatchObject({ kind: 'unconfirmed', actions: ['read-again', 'reading-area'] });
  });

  it('shows an unidentified card honestly without inventing a pick for it', () => {
    const result = view(reader({ offers: [offer(0, 'upgrade_toxic_bullets', { itemId: 'unknown-item', name: 'Unknown visible card', variant: 'unknown', bonusIds: null, warning: 'Item not identified.' })], advice: null }));
    const card = result.cards![0]!;
    expect(card.name).toBe('Unknown visible card');
    expect(card.identified).toBe(false);
    expect(card.tags).toEqual(['Variant not read', 'Bonus details not confirmed']);
    expect(result.cards!.some((entry) => entry.isPick)).toBe(false);
    expect(result.cards![1]!.offer).toBeNull();
  });

  it.each([
    [{ foreground: false }, 'Holding cards'],
    [{ engineReady: false }, 'Starting'],
    [{ gamePresent: false }, 'Waiting for game'],
  ] as const)('keeps a held pick while the game is unfocused, absent or restarting (%j) with an honest status', (patch, label) => {
    const result = view(reader(patch));
    expect(result.call?.item.name).toBe('Toxic Bullets');
    expect(result.status.label).toBe(label);
  });

  it('flags missing reader progress only while reads are expected', () => {
    const state = reader({ status: 'waiting-draft', offers: [], advice: null });
    expect(readProgressTimedOut(state, now - READ_PROGRESS_TIMEOUT_MS, now)).toBe(true);
    expect(readProgressTimedOut({ ...state, foreground: false }, now - READ_PROGRESS_TIMEOUT_MS, now)).toBe(false);
    const stalled = view(state, { lastProgressAt: now - READ_PROGRESS_TIMEOUT_MS });
    expect(stalled.notice).toMatchObject({ kind: 'stalled', actions: ['read-again', 'reading-area'] });
    expect(stalled.status).toEqual({ tone: 'warn', label: 'No new reading' });
  });
});

describe('companion view: call kinds', () => {
  it('reports a close call from the advice title', () => {
    const result = view(reader({ advice: { ...advice, title: 'Slight edge: Toxic Bullets', reasons: ['Close call: Toxic Bullets edges out the alternatives.', ...advice.reasons] } }));
    expect(result.call?.kind).toBe('close');
    expect(result.call?.reasons.some((reason) => reason.text.startsWith('Close call'))).toBe(false);
  });

  it('leads with the reroll and marks the best card only as the fallback', () => {
    const result = view(reader({ rerollsLeft: 2, advice: { ...advice, title: 'Reroll — or take Toxic Bullets', rerollSuggested: true, rerollReason: '2 rerolls left. None of these cards fits.' } }));
    expect(result.call?.kind).toBe('reroll');
    expect(result.call?.reroll).toEqual({ suggested: true, text: '2 rerolls left. None of these cards fits.', left: 2 });
    expect(result.cards?.map((card) => [card.isPick, card.isFallback])).toEqual([[false, true], [false, false], [false, false]]);
  });

  it('falls back to a base-item comparison when no pick is named', () => {
    const result = view(reader({ advice: { ...advice, preferredPosition: null, comparisonPosition: 2, comparisonBasis: 'main-item-base-effects' } }));
    expect(result.call?.kind).toBe('consider');
    expect(result.cards?.map((card) => card.isConsider)).toEqual([false, false, true]);
  });

  it('pulls the imbue target out with its ability art', () => {
    const result = view(reader({ heroId: 'hero_haze', advice: { ...advice, imbue: 'Imbue it on Bullet Dance (longest cooldown (165s), so it gains the most).',
      reasons: [...advice.reasons, 'Imbue it on Bullet Dance: longest cooldown (165s), so it gains the most.'] } }));
    expect(result.call?.imbue).toMatchObject({ abilityName: 'Bullet Dance', why: 'longest cooldown (165s), so it gains the most', ability: { id: 'ability_bullet_flurry', slot: 3 } });
    expect([...result.call!.reasons, ...result.call!.moreReasons].some((reason) => reason.kind === 'imbue')).toBe(false);
  });
});

describe('companion view: match, build and teams', () => {
  const seats = ['hero_gigawatt', 'hero_inferno', 'hero_wraith', 'hero_ghost', 'hero_haze', 'hero_atlas', 'hero_tengu', null];
  const roster = { seats, localHeroId: 'hero_haze', localSide: 1 as const, allies: ['hero_atlas', 'hero_tengu'], enemies: seats.slice(0, 4) as string[] };
  const build = { myItems: ['upgrade_rapid_rounds', 'upgrade_vampire'], seatItems: [['upgrade_improved_spirit'], [], [], [], ['upgrade_rapid_rounds'], [], [], []], abilityRanks: [2, 1, 0, 1], hiddenEnemyItems: 3 };
  const plan = { slot: 2, ability: 'Fixation', tier: 1, cost: 1, winRate: null, games: 0, then: ['Fixation'], reason: 'players usually raise this one next' };

  it('places your side from the roster, flags you, and maps scoreboard items', () => {
    const result = view(reader({ status: 'waiting-draft', offers: [], advice: null, roster, build, abilityPlan: plan }));
    expect(result.teams.known).toBe(true);
    expect(result.teams.ours.map((seat) => seat.hero?.name ?? null)).toEqual(['Haze', 'Abrams', 'Ivy', null]);
    expect(result.teams.ours[0]!.isLocal).toBe(true);
    expect(result.teams.theirs[0]!.items.map((ref) => ref.item?.name)).toEqual(['Extra Spirit']);
    expect(result.teams.hiddenEnemyItems).toBe(3);
    expect(result.me.hero?.name).toBe('Haze');
    expect(result.me.items.map((ref) => ref.id)).toEqual(build.myItems);
    expect(result.me.abilities.map((ability) => [ability.name, ability.rank, ability.isNext])).toEqual([
      ['Sleep Dagger', 2, false], ['Smoke Bomb', 1, false], ['Fixation', 0, true], ['Bullet Dance', 1, false]]);
    expect(result.notice).toMatchObject({ kind: 'between', tip: 'tab' });
    expect(result.hasMatchData).toBe(true);
  });

  it('uses neutral side labels and an idle notice before anything is read', () => {
    const result = view(reader({ status: 'waiting-draft', offers: [], advice: null }));
    expect(result.teams.ours).toEqual([]);
    expect(result.hasMatchData).toBe(false);
    expect(result.notice).toMatchObject({ kind: 'idle', title: 'Watching for your match' });
    expect(result.status).toEqual({ tone: 'live', label: 'Watching' });
  });

  it('falls back to the context reader for players and labels the score by side', () => {
    const base = createInitialScreenReaderState();
    const seen = { sessionId: 's', frameId: 'f', capturedAt: now, receivedAt: now, method: 'layout-association' as const, confidence: 1, bounds: [] };
    const player = (seat: number, team: 0 | 1, heroId: string) => ({ seat, team, heroId, isLocal: seat === 0, heroObservation: seen, teamObservation: seen, localObservation: null,
      inventory: [{ slot: 0, itemId: 'upgrade_vampire', variant: 'base' as const, bonusIds: [], observation: seen }], inventoryCompleteness: 'partial' as const, inventoryObservation: seen, inventoryRevision: 1 });
    const result = view(reader({ status: 'waiting-draft', offers: [], advice: null, matchContext: { ...base.matchContext, viewMode: 'participant', localTeam: 1, localSeat: 0, scores: [3, 1], round: 4,
      players: [player(0, 1, 'hero_haze'), player(4, 0, 'hero_wraith')] } }));
    expect(result.teams.ours.map((seat) => seat.hero?.name)).toEqual(['Haze']);
    expect(result.teams.theirs.map((seat) => seat.hero?.name)).toEqual(['Wraith']);
    expect(result.match).toEqual({ round: 4, rerollsLeft: null, scores: { ours: 1, theirs: 3, labels: ['You', 'Enemy'] } });
  });
});

describe('companion view: reader states', () => {
  it.each([
    [{ status: 'unavailable' as const, message: 'Reader missing.' }, 'unavailable', ['retry']],
    [{ enabled: false, status: 'paused' as const }, 'paused', ['resume']],
    [{ status: 'paused' as const, message: 'Screen reading paused after sustained helper CPU load.' }, 'auto-paused', ['retry']],
    [{ status: 'waiting-game' as const, gamePresent: false }, 'waiting-game', []],
    [{ status: 'interrupted' as const, foreground: false }, 'background', []],
  ])('maps %j to a %s notice', (patch, kind, actions) => {
    const result = view(reader({ offers: [], advice: null, ...patch }));
    expect(result.notice?.kind).toBe(kind);
    expect(result.notice?.actions).toEqual(actions);
  });
});

describe('reason helpers', () => {
  it('parses Street Brawl win-rate lines', () => {
    expect(parseWinStat('Wins 58% of 2,058 Street Brawl games on Haze (+2.5 vs. average).')).toEqual({ winRate: 58, games: '2,058', hero: 'Haze', delta: '+2.5 vs avg', positive: true, valve: false });
    expect(parseWinStat('Wins 51% of 9k Street Brawl games (about average).')).toMatchObject({ hero: null, delta: 'about average', positive: false });
    expect(parseWinStat('Gain souls over time.')).toBeNull();
  });
  it('classifies reasons for their icons', () => {
    expect(classifyReason('Wins more against Lady Geist 53%.')).toBe('counter');
    expect(classifyReason('Wins less against Seven 43%.')).toBe('concern');
    expect(classifyReason('Enhanced: carries bonus stats on top of the base item.')).toBe('enhanced');
    expect(classifyReason('Your bullets build up a Bleed.')).toBe('text');
  });
});

describe('sample match states render through the interface', () => {
  it.each(SAMPLE_STATES.map((sample) => sample.id))('%s', (id) => {
    const state = sampleState(id, now);
    const result = deriveView(state, APP_CATALOG, clock());
    const noop = () => undefined;
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(TopBar, { view: result, readerEnabled: true, onMenu: noop, onPause: noop, onRetry: noop }),
      createElement(MatchStrip, { view: result }),
      createElement(Decision, { view: result, generation: 1, onAction: noop }),
      createElement(Loadout, { view: result }), createElement(Teams, { view: result }),
      result.hasMatchData ? null : createElement(Guide)));
    if (['pick', 'imbue', 'close', 'reroll'].includes(id)) {
      expect(result.call).not.toBeNull();
      expect(html).toContain(result.call!.kind === 'reroll' ? '>Reroll<' : `>${result.call!.item.name}<`);
      expect(html).toContain(result.call!.kind === 'reroll' ? 'best card if you keep these' : 'suggested pick');
    } else {
      expect(result.call).toBeNull();
      expect(html).toContain(result.notice!.title);
    }
    if (id === 'imbue') expect(html).toContain('Imbue on Bullet Dance');
    if (id === 'waiting') expect(html).toContain('How it works');
    else expect(html).toContain('Lady Geist');
  });
});
