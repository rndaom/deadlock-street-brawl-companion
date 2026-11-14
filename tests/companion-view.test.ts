import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_CATALOG } from '../src/app/catalog';
import { createInitialScreenReaderState, SCREEN_CARD_HOLD_MS } from '../src/shared/screen-reading';
import type { ScreenAdvice, ScreenOffer, ScreenReaderState } from '../src/shared/screen-reading';
import { abilityStep, classifyReason, levelCells, deriveView, formatEdge, hopeTiers, parseCounter, parseWinStat, percentileLabel, READ_PROGRESS_TIMEOUT_MS, READING_CONFIRM_TIMEOUT_MS, readProgressTimedOut } from '../src/renderer/view';
import { matchInsights } from '../src/screen/match-insights';
import type { ReaderClock } from '../src/renderer/view';
import { SAMPLE_STATES, sampleState } from './sample-states';
import { Decision } from '../src/renderer/components/Decision';
import { Guide, Loadout, Teams } from '../src/renderer/components/Loadout';
import { TopBar, MatchStrip } from '../src/renderer/components/TopBar';
import { Leveling } from '../src/renderer/components/Leveling';

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

  it('shows the free item of a Bonus! card on the card and on the pick', () => {
    const bonusOffers = [offer(0, 'upgrade_toxic_bullets', { bonusIds: ['upgrade_improved_spirit'], bonusExpected: true }),
      offer(1, 'upgrade_quick_silver', { bonusIds: null, bonusExpected: true, absorbsIds: ['upgrade_improved_stamina'] }), offer(2, 'upgrade_improved_bullet_armor')];
    const result = view(reader({ offers: bonusOffers }));
    expect(result.cards![0]!.bonus).toMatchObject({ items: [{ id: 'upgrade_improved_spirit' }], pending: false });
    expect(result.cards![0]!.tags).toContain('Bonus');
    expect(result.cards![1]!.bonus).toMatchObject({ items: [], pending: true, absorbs: ['Extra Stamina'] });
    expect(result.cards![2]!.bonus).toMatchObject({ items: [], pending: false });
    const html = renderToStaticMarkup(createElement(Decision, { view: result, generation: 1, onAction: () => undefined }));
    expect(html).toContain('Bonus: also gives Extra Spirit');
    expect(html).toContain('free bonus item');
  });

  it('shows an unidentified card honestly without inventing a pick for it', () => {
    const result = view(reader({ offers: [offer(0, 'upgrade_toxic_bullets', { itemId: 'unknown-item', name: 'Unknown visible card', variant: 'unknown', bonusIds: null, warning: 'Item not identified.' })], advice: null }));
    const card = result.cards![0]!;
    expect(card.name).toBe('Reading…');
    expect(card.identified).toBe(false);
    expect(card.tags).toEqual(['Variant not read']);
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

  it('only suggests the best card read so far while another card is unread', () => {
    const result = view(reader({ advice: { ...advice, title: 'Best so far: Toxic Bullets' } }));
    expect(result.call?.kind).toBe('partial');
    expect(result.cards?.map((card) => [card.isPick, card.isConsider])).toEqual([[true, false], [false, false], [false, false]]);
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
    expect(result.match).toEqual({ round: 4, rerollsLeft: null, choice: null, scores: { ours: 1, theirs: 3, labels: ['You', 'Enemy'] } });
  });

  it('never shows a hideout or previous-match hero as yours', () => {
    const base = createInitialScreenReaderState();
    const seen = (capturedAt: number) => ({ sessionId: 's', frameId: 'f', capturedAt, receivedAt: capturedAt, method: 'layout-association' as const, confidence: 1, bounds: [] });
    const empty = { seats: Array(8).fill(null), localHeroId: null, localSide: null, allies: [], enemies: [] };
    // The match context still holds Solomon from the hideout HUD (2026-10-11 19:54-19:57).
    const stale = { ...base.matchContext, localHeroId: 'hero_chessmaster', observations: { ...base.matchContext.observations, localHeroId: seen(now - 60_000) } };
    const at = (roster: ScreenReaderState['roster'], context = stale) =>
      view(reader({ status: 'waiting-draft', offers: [], advice: null, heroId: null, roster, matchContext: context })).me.hero?.name ?? null;
    expect(at({ ...empty, phase: 'outside', since: null })).toBeNull();
    expect(at({ ...empty, phase: 'match', since: now - 30_000 })).toBeNull();
    expect(at({ ...empty, localHeroId: 'hero_ratking', phase: 'match', since: now - 30_000 })).toBe('Rat King');
    // A HUD hero proven during the current match may fill in until the roster names one.
    const fresh = { ...stale, localHeroId: 'hero_ratking', observations: { ...stale.observations, localHeroId: seen(now - 1_000) } };
    expect(at({ ...empty, phase: 'match', since: now - 30_000 }, fresh)).toBe('Rat King');
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
    expect(classifyReason('Counters Lady Geist (+2.1) and Infernus (+1.6).')).toBe('counter');
    expect(classifyReason('Weak against Seven (-1.9).')).toBe('concern');
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
    if (['pick', 'imbue', 'close', 'reroll', 'unread'].includes(id)) {
      expect(result.call).not.toBeNull();
      expect(html).toContain(result.call!.kind === 'reroll' ? '>Reroll<' : `>${result.call!.item.name}<`);
      expect(html).toContain(result.call!.kind === 'reroll' ? 'best card if you keep these' : 'suggested pick');
    } else {
      expect(result.call).toBeNull();
      // Between drafts the top slot shows the enemy threat instead of a notice.
      expect(html).toContain(result.notice!.kind === 'between' ? 'Enemy threat' : result.notice!.title);
    }
    if (id === 'imbue') expect(html).toContain('Imbue on Bullet Dance');
    if (id === 'waiting') expect(html).toContain('How it works');
    else expect(html).toContain('Lady Geist');
  });
});

describe('ability grid with a column the reader could not see', () => {
  it('marks that column as not read instead of unbought, and asks for a clear Tab look', () => {
    const result = deriveView(sampleState('partial', now), APP_CATALOG, clock());
    expect(result.me.ranksKnown).toBe(true);
    expect(result.me.abilities.map((ability) => ability.rank)).toEqual([2, null, 1, 1]);
    expect(result.me.plan).toBeNull();
    const html = renderToStaticMarkup(createElement(Leveling, { view: result }));
    expect(html.match(/Not read yet/g)).toHaveLength(1);
    expect(html).toContain('lvl-col-unread');
    expect(html).toContain('tier I (1 AP): not read yet');
    expect(html).toContain('with the cursor off the panel');
    expect(html).not.toContain('Every ability is fully upgraded');
  });
});

describe('card standing: edge first, counters marked, raw win rate in the detail', () => {
  it('reads both counter wordings and names the enemies', () => {
    expect(parseCounter('Counters Lady Geist (+2.1) and Infernus (+1.6).')).toMatchObject({ tone: 'up', enemies: ['Lady Geist', 'Infernus'] });
    expect(parseCounter('Counters Lady Geist (+2.1).')).toMatchObject({ tone: 'up', enemies: ['Lady Geist'] });
    expect(parseCounter('Weak against Seven (-1.9), Wraith (-1.6) and Infernus (-1.5).')).toMatchObject({ tone: 'down', enemies: ['Seven', 'Wraith', 'Infernus'] });
    expect(parseCounter('Does well against Lady Geist (+2.1) and Infernus (+1.6): points over its usual win rate.')).toMatchObject({ tone: 'up', enemies: ['Lady Geist', 'Infernus'] });
    expect(parseCounter('Does poorly against Seven: -1.9 points under its usual win rate.')).toMatchObject({ tone: 'down', enemies: ['Seven'] });
    expect(parseCounter('Your bullets build up a Bleed.')).toBeNull();
  });
  it('formats edges and tier ranks decisively', () => {
    expect([formatEdge(2.44), formatEdge(-1.26), formatEdge(0.04)]).toEqual(['+2.4', '−1.3', '0.0']);
    expect(percentileLabel({ edge: 2, percentile: 92, tier: 2 })).toBe('Top 8% of tier II');
    expect(percentileLabel({ edge: -2, percentile: 12, tier: null })).toBe('Bottom 12%');
    expect(percentileLabel({ edge: 0, percentile: 100, tier: 3 })).toBe('Top 1% of tier III');
  });
  it('shows the edge (not the raw win rate) on each card, with a counter badge where counters drove it', () => {
    const result = view(sampleState('pick', now));
    const [toxic, quicksilver] = result.cards!;
    expect(toxic!.standing).toEqual({ edge: 2.4, percentile: 88, tier: 3 });
    expect(toxic!.counter).toMatchObject({ tone: 'up', enemies: ['Lady Geist', 'Infernus'] });
    expect(quicksilver!.counter).toBeNull();
    // Quicksilver has the higher raw win rate (54% vs 53%) but the lower edge: the card never shows the raw number.
    expect(quicksilver!.stat!.winRate).toBeGreaterThan(toxic!.stat!.winRate);
    expect(quicksilver!.standing!.edge).toBeLessThan(toxic!.standing!.edge);
    expect(result.call?.standing).toEqual({ edge: 2.4, percentile: 88, tier: 3 });
    const html = renderToStaticMarkup(createElement(Decision, { view: result, generation: 1, onAction: () => undefined }));
    const board = html.slice(html.indexOf('class="board"'));
    expect(board).toContain('+2.4');
    expect(board).toContain('−2.6');
    expect(board).toContain('Counter ×2');
    expect(board).not.toContain('chip-wr');
    // The pick panel leads with edge, tier rank and the counter; the raw win rates sit in the "Why" table.
    const call = html.slice(0, html.indexOf('class="board"'));
    expect(call).toContain('+2.4</strong> vs tier III average');
    expect(call).toContain('Top 12% of tier III');
    expect(call).toContain('Counters Lady Geist (+2.1) and Infernus (+1.6).');
    expect(call).not.toContain('chip-counter');
    const why = call.slice(call.indexOf('class="why"'));
    expect(why).toContain('The three cards');
    expect(why).toContain('54%');
    expect(why).toContain('Wins 53% of 34k Street Brawl games on Haze');
    expect(call.slice(0, call.indexOf('class="why"'))).not.toContain('chip-wr');
  });
  it('makes fit bars absolute from the tier rank, so a weak draft is not 5/5 for its best card', () => {
    expect(view(sampleState('reroll', now)).cards!.map((card) => card.fit)).toEqual([2, 1, 2]);
    expect(view(sampleState('pick', now)).cards!.map((card) => card.fit)).toEqual([5, 4, 1]);
    // Without tier ranks the bars stay relative to the cards shown.
    expect(view(reader()).cards!.map((card) => card.fit)).toEqual([5, 4, 1]);
  });
  it('falls back to the win-rate chip when the advice carries no edge', () => {
    const html = renderToStaticMarkup(createElement(Decision, { view: view(reader()), generation: 1, onAction: () => undefined }));
    expect(html).toContain('chip-wr');
    expect(html).not.toContain('chip-edge');
  });
});

describe('draft tier and the tiers worth hoping for', () => {
  const insights = matchInsights('hero_haze', ['hero_gigawatt', 'hero_inferno', 'hero_wraith', 'hero_ghost'], [])!;
  it('lists only the tier on screen and the next tier, from the round and choice', () => {
    expect(hopeTiers({ round: 3, phase: 'combat', pickStage: null }, null)).toEqual([{ tier: 3, label: 'Next draft' }, { tier: 4, label: 'Later' }]);
    expect(hopeTiers({ round: 3, phase: 'draft', pickStage: 1 }, 2)).toEqual([{ tier: 2, label: 'This draft' }, { tier: 3, label: 'Later' }]);
    expect(hopeTiers({ round: 1, phase: 'draft', pickStage: 3 }, 3)).toEqual([{ tier: 3, label: 'This draft' }, { tier: 2, label: 'Later' }]);
    expect(hopeTiers({ round: 5, phase: 'draft', pickStage: 2 }, 4)).toEqual([{ tier: 4, label: 'This draft' }]);
    expect(hopeTiers({ round: null, phase: 'combat', pickStage: null }, null)).toBeNull();
  });
  it('counts a RARE card at its choice tier, like the pick logic', () => {
    // Two RARE tier III cards and a tier II card: a tier II draft (the old rule called it tier III).
    const rare = [offer(0, 'upgrade_toxic_bullets', { rare: true }), offer(1, 'upgrade_quick_silver'), offer(2, 'upgrade_improved_bullet_armor', { rare: true })];
    const base = createInitialScreenReaderState();
    const result = view(reader({ offers: rare, heroId: 'hero_haze', insights, matchContext: { ...base.matchContext, round: 3, phase: 'draft', pickStage: 1 } }));
    expect(result.insights?.wishlist.map((row) => [row.tier, row.label, row.current])).toEqual([[2, 'This draft', true], [3, 'Later', false]]);
  });
  it('shows the next draft and the tier after it between drafts', () => {
    const result = view(sampleState('between', now));
    expect(result.insights?.wishlist.map((row) => [row.tier, row.label])).toEqual([[3, 'Next draft'], [4, 'Later']]);
    expect(result.insights?.hopes).toEqual([]);
  });
});

describe('match strip: score only when read, choice and rerolls during a draft', () => {
  const strip = (state: ScreenReaderState) => renderToStaticMarkup(createElement(MatchStrip, { view: view(state) }));
  it('shows the choice of 3 with the rerolls left during a draft', () => {
    const html = strip(sampleState('pick', now));
    expect(html).toContain('Choice 2 of 3, 2 rerolls left');
    expect(html).toContain('Round wins: You 1, Enemy 1');
  });
  it('drops the score cell until the round pips are read, and the choice cell between drafts', () => {
    const state = sampleState('between', now);
    const html = strip({ ...state, matchContext: { ...state.matchContext, scores: null } });
    expect(html).not.toContain('Score');
    expect(html).not.toContain('Round wins');
    expect(html).not.toContain('Choice');
    expect(html).not.toContain('Rerolls');
  });
});

describe('between drafts: enemy threat and the next ability step', () => {
  it('fills the top slot with the threat summary and the spend step', () => {
    const result = view(sampleState('between', now));
    expect(result.teams.threat).not.toBeNull();
    expect(result.me.step).toEqual({ spend: true, points: 5, title: 'Spend 5 AP: Sleep Dagger III', detail: 'Then Smoke Bomb II, Fixation II' });
    const html = renderToStaticMarkup(createElement(Decision, { view: result, generation: 1, onAction: () => undefined }));
    expect(html).toContain('Enemy threat');
    expect(html).toContain(result.teams.threat!.priority);
    expect(html).toContain('Spend 5 AP: Sleep Dagger III');
    expect(html).not.toContain('Between item choices');
    // Two enemy items were hidden: ask for a Tab look.
    expect(html).toContain('hold <kbd>Tab</kbd>');
  });
  it('names the next upgrade and its cost when the points do not pay for it', () => {
    // No AP counter read during this draft: the next upgrade with its cost.
    const result = view(sampleState('close', now));
    expect(result.me.step).toEqual({ spend: false, points: null, title: 'Next: Fixation I · 1 AP', detail: 'Then Fixation II, Fixation III' });
    expect(abilityStep(null, result.me.abilities, 6)).toBeNull();
  });
  it('names every step the AP total pays for, and continues "Then" right after the last one named', () => {
    const path = [0, 1, 2, 3, 0, 1, 2, 3];
    const { cells } = levelCells([0, 0, 0, 0], path, 5);
    const abilities = [0, 1, 2, 3].map((slot) => ({ slot, label: null, name: `Ab${slot}`, rank: 0, isNext: slot === 0, cells: cells[slot]! }));
    const plan = { slot: 0, ability: 'Ab0', tier: 1, cost: 1, reason: '', then: [], winRate: null, games: 0, path };
    // Four 1-AP steps are affordable; three are named, so the total is 3 AP and "Then" starts at Ab3 I.
    expect(abilityStep(plan, abilities, 5)).toEqual({ spend: true, points: 3, title: 'Spend 3 AP: Ab0 I, Ab1 I, Ab2 I', detail: 'Then Ab3 I, Ab0 II' });
  });
});

describe('ability grid labels', () => {
  it('shows a cost only on the next upgrade, labelled AP', () => {
    const html = renderToStaticMarkup(createElement(Leveling, { view: view(sampleState('between', now)) }));
    expect(html.match(/class="lvl-cost/g)).toHaveLength(1);
    expect(html).toContain('Next<span class="lvl-cost num">5 AP</span>');
  });
});
