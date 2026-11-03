import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import publicCatalog from '../data/public-catalog.json';
import {
  blocksForScreenParser, createScreenReader, DRAFT_FOOTER_REGION, DRAFT_HINT_REGION,
  MATCH_CONTEXT_REGION, normalizeNativeReply, SCREEN_READER_LIMITS,
} from '../electron/screen-reader';
import { parseScreenMatchObservation } from '../src/screen/match-parser';
import { isScreenObservationUsable, reduceScreenMatchContext, resetScreenMatchContext } from '../src/screen/match-state';
import { parseScreenOffers } from '../src/screen/offer-parser';
import { evaluateScreenOffers } from '../src/screen/screen-advice';
import { evaluateAbilityUpgrade } from '../src/screen/ability-advice';
import {
  createInitialScreenMatchContext, SCREEN_CAPTURE_FRESHNESS_MS, SCREEN_CONTEXT_MAX_AGE_MS,
  type NativeScreenContext, type ScreenMatchContext, type ScreenReaderState,
} from '../src/shared/screen-reading';
import type { Catalog } from '../src/shared/types';
import {
  CONTEXT_TEST_START, ContextTestWorker, contextBlock, contextReply, contextWithinCrop,
  hudContext, publicDraftBlocks, scoreboardContext,
  type ContextTestBlock, type ContextTestRequest,
} from './context-fixtures';

const catalog = publicCatalog as Catalog;
const FULL = { ...MATCH_CONTEXT_REGION };
const readers: ReturnType<typeof createScreenReader>[] = [];
let serial = 0;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CONTEXT_TEST_START); serial = 0; });
afterEach(async () => { for (const reader of readers.splice(0)) await reader.dispose(); vi.useRealTimers(); });
const later = (milliseconds = 200) => vi.setSystemTime(Date.now() + milliseconds);

const brawlRound = () => [contextBlock('ROUND 3', .45, .08)];
function parsed(context: NativeScreenContext, blocks: ContextTestBlock[] = brawlRound(), previousContext?: ScreenMatchContext,
  patch: Record<string, unknown> = {}, sessionId = 'integration-reader') {
  const request = { id: `integration-${++serial}`, op: 'read', crop: FULL };
  const reply = normalizeNativeReply(contextReply(request, context, blocks, patch), FULL);
  return parseScreenMatchObservation(reply, catalog, { sessionId, receivedAt: Date.now(), previousContext });
}
function observe(state: ScreenMatchContext, context: NativeScreenContext, blocks: ContextTestBlock[] = brawlRound(),
  patch: Record<string, unknown> = {}, sessionId = 'integration-reader'): ScreenMatchContext {
  const frame = parsed(context, blocks, state, patch, sessionId);
  expect(frame).not.toBeNull();
  return reduceScreenMatchContext(state, frame!, Date.now());
}
function abilities(context: NativeScreenContext, fixationRank: number | null, points?: number,
  nextUpgradeCost?: number): NativeScreenContext {
  const output = structuredClone(context);
  output.regions.push({ kind: 'abilities', slotCount: 4, complete: true,
    bounds: { x: .28, y: .7, width: .44, height: .13 } });
  output.abilities = ([0, 1, 2, 3] as const).map(slot => ({ slot, rank: slot === 2 ? fixationRank : 0,
    unlocked: slot === 2 ? fixationRank === null ? null : true : false,
    confidence: fixationRank === null ? 0 : .98, nextUpgradeCost: slot === 2 ? nextUpgradeCost ?? null : null,
    bounds: { x: .3 + slot * .1, y: .72, width: .07, height: .08 } }));
  if (points !== undefined) {
    const bounds = { x: .48, y: .9, width: .04, height: .025 };
    output.regions.push({ kind: 'ability-points', bounds, complete: true });
    output.abilityPoints = { value: points, confidence: .98, bounds };
  }
  return output;
}
function withLocalInventory(context: NativeScreenContext, itemIds: string[]): NativeScreenContext {
  const output = structuredClone(context);
  output.regions.push({ kind: 'inventory', bounds: { x: .12, y: .72, width: .13, height: .16 },
    slotCount: Math.max(2, itemIds.length), complete: true });
  for (let slot = 0; slot < Math.max(2, itemIds.length); slot++) output.items.push({ slot,
    itemId: itemIds[slot] ?? null, status: itemIds[slot] ? 'recognized' : 'empty', role: 'local-inventory',
    confidence: .98, variant: 'unknown', bounds: { x: .13 + (slot % 4) * .025,
      y: .73 + Math.floor(slot / 4) * .025, width: .021, height: .021 } });
  return output;
}
function visibleOffers(names = ['Extra Spirit', 'Rapid Rounds', 'Monster Rounds']) {
  const request = { id: `offers-${++serial}`, op: 'read', crop: FULL };
  const reply = normalizeNativeReply(contextReply(request, { ...hudContext(), panel: 'draft' }, publicDraftBlocks(names)), FULL);
  const offers = parseScreenOffers(blocksForScreenParser(reply), catalog, { conservativeUnmarkedDetails: true }).offers;
  expect(offers).toHaveLength(3);
  return offers;
}
function advice(state: ScreenMatchContext, names?: string[]) {
  return evaluateScreenOffers(visibleOffers(names), catalog, { heroId: state.localHeroId,
    round: state.round, rerolls: state.rerollsRemaining, matchContext: state, now: Date.now() })!;
}

describe('native protocol → visible context → current decisions', () => {
  it('keeps eight source positions, four relative sides and own HUD association without inventing a match ID', () => {
    const state = observe(createInitialScreenMatchContext(), scoreboardContext());
    expect(state.rosterCompleteness).toBe('complete');
    expect(state.players.map(player => [player.seat, player.team])).toEqual([
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 1], [5, 1], [6, 1], [7, 1],
    ]);
    expect([state.localSeat, state.localTeam, state.localHeroId]).toEqual([2, 0, 'hero_haze']);
    expect(state.players.filter(player => player.isLocal === true).map(player => player.seat)).toEqual([2]);
    expect(state.gameSessionId).toBe('synthetic-window-a');
    expect(state.matchId).toBeNull();
    expect(state.localInventory.map(item => item.itemId)).toEqual(['upgrade_health', 'upgrade_vampire']);
    expect(state.localInventorySlotCompleteness).toBe('complete');
    expect(state.localInventoryCompleteness).toBe('partial');
    expect(state.localAbilities).toEqual([]);
  });

  it('never collapses two players with the same hero into one inventory', () => {
    const native = scoreboardContext();
    native.heroes.find(hero => hero.seat === 6)!.heroId = 'hero_gigawatt';
    native.items.find(item => item.seat === 6 && item.slot === 0)!.itemId = 'upgrade_metal_skin';
    const state = observe(createInitialScreenMatchContext(), native);
    expect(state.players.filter(player => player.heroId === 'hero_gigawatt').map(player => player.seat)).toEqual([4, 6]);
    expect(state.players.find(player => player.seat === 4)!.inventory[0]!.itemId).toBe('upgrade_improved_spirit');
    expect(state.players.find(player => player.seat === 6)!.inventory[0]!.itemId).toBe('upgrade_metal_skin');
  });

  it('does not truncate a proven sixteen-slot current grid to a familiar inventory capacity', () => {
    const state = observe(createInitialScreenMatchContext(), withLocalInventory(hudContext(), Array(16).fill('upgrade_health')));
    expect(state.localInventory).toHaveLength(16);
    expect(state.localInventory.map(item => item.slot)).toEqual(Array.from({ length: 16 }, (_, slot) => slot));
    expect(state.localInventorySlotCompleteness).toBe('complete');
    expect(state.localInventoryCompleteness).toBe('partial');
  });

  it('replaces a proven current slot and removes a confirmed empty slot even when modifiers are unread', () => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext());
    const before = state.localInventoryRevision;
    later();
    state = observe(state, scoreboardContext('synthetic-window-a', ['upgrade_boundless_spirit']));
    expect(state.localInventory.map(item => item.itemId)).toEqual(['upgrade_boundless_spirit']);
    expect(state.players.find(player => player.seat === 2)!.inventory.map(item => item.itemId)).toEqual(['upgrade_boundless_spirit']);
    expect(state.localInventoryRevision).toBeGreaterThan(before);
    expect(state.localInventorySlotCompleteness).toBe('complete');
    expect(state.localInventoryCompleteness).toBe('partial');
  });

  it('a partial positive frame preserves unseen players and slots with their original capture times', () => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext());
    const originalAt = state.players.find(player => player.seat === 4)!.inventory[1]!.observation.capturedAt;
    later(500);
    const native = scoreboardContext();
    native.heroes = native.heroes.filter(hero => hero.role === 'local' || hero.seat === 4);
    native.items = native.items.filter(item => item.seat === 4 && item.slot === 0);
    native.regions = native.regions.filter(region => region.kind === 'local-hero' || region.kind === 'inventory' && region.seat === 4)
      .map(region => ({ ...region, complete: false }));
    state = observe(state, native);
    expect(state.players).toHaveLength(8);
    expect(state.players.find(player => player.seat === 4)!.inventory[1]!.observation.capturedAt).toBe(originalAt);
    expect(state.players.find(player => player.seat === 4)!.inventory[0]!.observation.capturedAt).toBe(Date.now());
    expect(state.rosterCompleteness).toBe('partial');
  });

  it('a high-quality explicitly empty slot removes only that slot from a partial grid', () => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext());
    later();
    const native = scoreboardContext();
    native.items = native.items.filter(item => item.seat === 2 && item.slot === 1)
      .map(item => ({ ...item, itemId: null, status: 'empty' as const }));
    native.regions = native.regions.map(region => region.kind === 'inventory' ? { ...region, complete: false } : region);
    state = observe(state, native);
    expect(state.localInventory.map(item => item.itemId)).toEqual(['upgrade_health']);
    expect(state.localInventorySlotCompleteness).toBe('partial');
    expect(state.players.find(player => player.seat === 4)!.inventory).toHaveLength(2);
  });

  it.each(['unknown', 'hidden'] as const)('an %s cell does not prove removal or reconfirm old item ownership', status => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext());
    const originalAt = state.localInventory[1]!.observation.capturedAt;
    later(800);
    const native = scoreboardContext();
    const item = native.items.find(item => item.seat === 2 && item.slot === 1)!;
    item.itemId = null; item.status = status; item.confidence = 0;
    state = observe(state, native);
    expect(state.localInventory[1]!.itemId).toBe('upgrade_vampire');
    expect(state.localInventory[1]!.observation.capturedAt).toBe(originalAt);
    expect(state.localInventorySlotCompleteness).toBe('partial');
  });

  it('identical confirmations retain the first change time and semantic revision', () => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext());
    const originalAt = state.localInventory[0]!.observation.changedAt;
    const revision = state.revision;
    later(200);
    state = observe(state, scoreboardContext());
    expect(state.revision).toBe(revision);
    expect(state.localInventory[0]!.observation.changedAt).toBe(originalAt);
    expect(state.localInventory[0]!.observation.confirmedAt).toBe(Date.now());
    expect(state.observations.localHeroId!.changedAt).toBe(CONTEXT_TEST_START);
  });

  it('a crop that misses the lower grid cannot certify complete ownership or local identity', () => {
    const request = { id: 'cropped-top', op: 'read', crop: { ...DRAFT_HINT_REGION } };
    const native = contextWithinCrop(scoreboardContext(), request.crop);
    const reply = normalizeNativeReply(contextReply(request, native), request.crop);
    const frame = parseScreenMatchObservation(reply, catalog, { sessionId: 'integration-reader', receivedAt: Date.now() })!;
    const state = reduceScreenMatchContext(createInitialScreenMatchContext(), frame, Date.now());
    expect(state.players).toHaveLength(8);
    expect(state.localSeat).toBeNull();
    expect(state.localHeroId).toBeNull();
    expect(state.players.every(player => player.inventoryCompleteness === 'unknown')).toBe(true);
  });

  it('a confirmed empty current grid remains distinct from an unobserved loadout', () => {
    const empty = observe(createInitialScreenMatchContext(), withLocalInventory(hudContext(), []));
    const missing = observe(createInitialScreenMatchContext(), hudContext());
    expect(empty.localInventory).toEqual([]);
    expect(empty.localInventorySlotCompleteness).toBe('complete');
    expect(empty.localInventoryCompleteness).toBe('complete');
    expect(missing.localInventory).toEqual([]);
    expect(missing.localInventoryCompleteness).toBe('unknown');
    expect(missing.localInventoryObservation).toBeNull();
  });

  it('reads unlocked rank zero separately from absent or uncertain pips', () => {
    const known = observe(createInitialScreenMatchContext(), abilities(hudContext(), 0));
    const unknown = observe(createInitialScreenMatchContext(), abilities(hudContext(), null));
    expect(known.localAbilities.find(ability => ability.slot === 2)).toMatchObject({ rank: 0, unlocked: true });
    expect(known.localAbilities.find(ability => ability.slot === 0)).toMatchObject({ rank: 0, unlocked: false });
    expect(unknown.localAbilities.every(ability => ability.rank !== 0)).toBe(true);
    expect(unknown.abilityCompleteness).toBe('partial');
  });

  it('unread replacement pips retain the old rank as an aged fact without a new confirmation', () => {
    let state = observe(createInitialScreenMatchContext(), abilities(hudContext(), 1));
    const originalAt = state.localAbilities.find(ability => ability.slot === 2)!.observation.capturedAt;
    later(400);
    state = observe(state, abilities(hudContext(), null));
    expect(state.localAbilities.find(ability => ability.slot === 2)).toMatchObject({ rank: 1, observation: { capturedAt: originalAt } });
    expect(state.abilityCompleteness).toBe('partial');
  });

  it('actual read Fixation investment changes the same OCR-recognized offers', () => {
    let state = observe(createInitialScreenMatchContext(), abilities({ ...hudContext(), panel: 'draft' }, 0), publicDraftBlocks());
    const before = advice(state);
    later();
    state = observe(state, abilities({ ...hudContext(), panel: 'draft' }, 1), publicDraftBlocks());
    const after = advice(state);
    expect(before.comparisonPosition).toBe(1);
    expect(after.comparisonPosition).toBe(0);
    expect(after.reasons.join(' ')).toContain('Fixation rank 1');
    expect(after.factsUsed?.some(fact => fact.scope === 'own' && fact.label.includes('Fixation'))).toBe(true);
    // Native OCR has not resolved full variant/bonus coverage: the best main-item card is
    // still named, with the unread bonuses stated as a caveat instead of withholding it.
    expect(before.preferredPosition).toBe(1);
    expect(after.preferredPosition).toBe(0);
    expect(after.title).toContain('Extra Spirit');
    expect(after.caveat).toMatch(/not read/);
  });

  it('explicit own AP and the visible next-tier price authorize spending; other numbers do not', () => {
    const state = observe(createInitialScreenMatchContext(), abilities(hudContext(), 0, 2, 2));
    expect(evaluateAbilityUpgrade(state, catalog, Date.now())).toMatchObject({ kind: 'upgrade', slot: 2, availablePoints: 2, cost: 2 });
    const noPrice = observe(createInitialScreenMatchContext(), abilities(hudContext(), 0, 2));
    expect(evaluateAbilityUpgrade(noPrice, catalog, Date.now())?.kind).toBe('plan');
    const teamNumber = observe(createInitialScreenMatchContext(), abilities(hudContext(), 0, undefined, 2), [
      ...brawlRound(), contextBlock('TEAM ABILITY POINTS 99', .18, .1), contextBlock('COOLDOWN 2', .42, .74),
    ]);
    expect(teamNumber.localAbilityPoints).toBeNull();
    expect(evaluateAbilityUpgrade(teamNumber, catalog, Date.now())?.kind).toBe('plan');
    later(SCREEN_CAPTURE_FRESHNESS_MS - 1);
    expect(evaluateAbilityUpgrade(state, catalog, Date.now())?.kind).toBe('upgrade');
    later(2);
    expect(evaluateAbilityUpgrade(state, catalog, Date.now())?.kind).toBe('plan');
  });

  it('a lower freshly read own AP budget cannot keep an unconfirmed pre-spend rank actionable', () => {
    let state = observe(createInitialScreenMatchContext(), abilities(hudContext(), 0, 2, 1));
    expect(evaluateAbilityUpgrade(state, catalog, Date.now())?.kind).toBe('upgrade');
    later(200);
    const next = abilities(hudContext(), null, 1);
    next.abilities = []; next.regions = next.regions.filter(region => region.kind !== 'abilities');
    state = observe(state, next);
    expect(state.localAbilityPoints).toBe(1);
    expect(evaluateAbilityUpgrade(state, catalog, Date.now())?.kind).not.toBe('upgrade');
  });

  it.each(['spectator', 'death cam', 'replay playback'] as const)('visible %s proof cannot hydrate own hero, ranks, inventory or points', veto => {
    const native = abilities(withLocalInventory(scoreboardContext(), ['upgrade_metal_skin']), 1, 99, 2);
    if (veto === 'spectator') native.viewMode = 'spectator';
    const blocks = veto === 'spectator' ? [] : [contextBlock(veto, .4, .4)];
    const state = observe(createInitialScreenMatchContext(), native, blocks);
    expect(state.viewMode).toBe('spectator');
    expect([state.localSeat, state.localTeam, state.localHeroId, state.localAbilityPoints]).toEqual([null, null, null, null]);
    expect(state.localInventory).toEqual([]);
    expect(state.localAbilities).toEqual([]);
    expect(state.players.every(player => player.isLocal !== true)).toBe(true);
    expect(evaluateAbilityUpgrade(state, catalog, Date.now())).toBeNull();
  });

  it('a unique known roster hero is not proof of the local seat without HUD ownership', () => {
    const native = scoreboardContext(); native.viewMode = 'unknown';
    native.heroes = native.heroes.filter(hero => hero.role === 'roster');
    const state = observe(createInitialScreenMatchContext(), native);
    expect(state.players).toHaveLength(8);
    expect(state.localSeat).toBeNull();
    expect(state.localHeroId).toBeNull();
    expect(state.localInventory).toEqual([]);
  });

  it('exact synthetic account text corroborates a current HUD hero only in the matching source K/D/A column', () => {
    const native = scoreboardContext(); native.viewMode = 'unknown';
    native.heroes.forEach(hero => { delete hero.isLocal; });
    const xs = [.09, .15, .21, .27, .67, .73, .79, .85];
    // Source PlayerName -> HeroName -> K/D/A flow: the name starts within ~43 design px above K/D/A (40 px here).
    const nameY = .27 - 40 / 1080;
    const blocks = xs.flatMap((x, seat) => [contextBlock('K D A', x, .27, .045, .012),
      contextBlock(seat === 2 ? 'Synthetic Local' : `Synthetic ${seat}`, x, nameY, .045, .012)]);
    const request = { id: 'aliased-local-column', op: 'read', crop: FULL };
    const reply = normalizeNativeReply(contextReply(request, native, blocks), FULL);
    const frame = parseScreenMatchObservation(reply, catalog, { sessionId: 'integration-reader', receivedAt: Date.now(), localPlayerNames: ['synthetic local'] })!;
    const state = reduceScreenMatchContext(createInitialScreenMatchContext(), frame, Date.now());
    expect([state.viewMode, state.localSeat, state.localHeroId, state.localTeam]).toEqual(['participant', 2, 'hero_haze', 0]);
    const ambiguousReply = normalizeNativeReply(contextReply({ ...request, id: 'ambiguous-alias' }, native,
      [...blocks, contextBlock('Synthetic Local', xs[1]!, nameY, .045, .012)]), FULL);
    const ambiguous = parseScreenMatchObservation(ambiguousReply, catalog, { sessionId: 'integration-reader', receivedAt: Date.now(), localPlayerNames: ['synthetic local'] })!;
    expect(ambiguous.localSeat).toBeNull();
    expect(ambiguous.localHeroId).toBeNull();
  });

  it('an unsupported twelve-player native layout is not truncated into an eight-player match', () => {
    const native = scoreboardContext();
    native.heroes = native.heroes.filter(hero => hero.role === 'local');
    native.items = []; native.regions = native.regions.filter(region => region.kind === 'local-hero');
    for (let seat = 0; seat < 12; seat++) native.heroes.push({ role: 'roster', seat, team: seat < 6 ? 0 : 1,
      heroId: 'hero_haze', status: 'recognized', confidence: .98,
      bounds: { x: .08 + seat * .065, y: .06, width: .04, height: .07 } });
    native.regions.push({ kind: 'roster', slotCount: 12, complete: true, bounds: { x: .07, y: .03, width: .85, height: .16 } });
    const state = observe(createInitialScreenMatchContext(), native, []);
    expect(state.players.length).toBe(0);
    expect(state.rosterCompleteness).toBe('unknown');
    expect(state.localHeroId).toBeNull();
  });

  it('an undecoded owned-item repeat withdraws the main-item highlight but still names a pick', () => {
    const native = { ...scoreboardContext('synthetic-window-a', ['upgrade_rapid_rounds']), panel: 'draft' as const };
    const state = observe(createInitialScreenMatchContext(), native, publicDraftBlocks(['Extra Spirit', 'Rapid Rounds', 'Monster Rounds']));
    const result = advice(state);
    // No confident base-effects comparison is claimed for a set containing an undecoded repeat.
    expect(result.comparisonPosition ?? null).toBeNull();
    expect(result.comparisonBasis).toBeUndefined();
    // The best readable card is still named; the repeat is carried as a limitation, as in context-advice.
    expect([0, 1, 2]).toContain(result.preferredPosition);
    expect(result.title).toMatch(/^(Pick|Slight edge:) /);
    // The undecoded repeat is a diagnostic limitation, not a hedge in the shown reasons.
    expect(result.reasons.join(' ')).not.toMatch(/Comparison only|unobserved|unread/);
    expect(result.limitations.join(' ')).toContain('no decoded Street Brawl upgrade/stacking state');
    expect(result.ranked.find(entry => entry.position === 1)!.reasons.join(' ')).not.toContain('A repeat may upgrade the existing item');
  });

  it('fresh header/round confirmations do not freshen a hidden mutable snapshot beyond thirty seconds', () => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext(), [contextBlock('ROUND 3', .45, .08)]);
    const oldAt = state.players[4]!.inventory[0]!.observation.capturedAt;
    later(SCREEN_CONTEXT_MAX_AGE_MS + 1);
    state = observe(state, { ...hudContext(), panel: 'draft' }, [contextBlock('ROUND 3', .45, .08), ...publicDraftBlocks()]);
    expect(state.players[4]!.inventory[0]!.observation.capturedAt).toBe(oldAt);
    expect(isScreenObservationUsable(state.players[4]!.inventory[0]!.observation, state, Date.now())).toBe(false);
    expect(advice(state).factsUsed?.some(fact => fact.scope === 'enemy')).toBe(false);
  });

  it.each([-1, SCREEN_CAPTURE_FRESHNESS_MS, 90_000])('rejects an external frame with capture age %i ms before state hydration', age => {
    const native = scoreboardContext();
    expect(parsed(native, [], undefined, { capturedAt: Date.now() - age })).toBeNull();
  });

  it('accepts a slow real read that arrives just inside the capture freshness window', () => {
    expect(parsed(scoreboardContext(), [], undefined, { capturedAt: Date.now() - (SCREEN_CAPTURE_FRESHNESS_MS - 1) })).not.toBeNull();
  });

  it('a changed helper epoch clears the old build and rejects its later hydration', () => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext());
    later();
    state = observe(state, hudContext('synthetic-window-a'), [], {}, 'replacement-reader');
    expect(state.players).toEqual([]);
    expect(state.localInventory).toEqual([]);
    expect(state.retiredSessionIds).toContain('integration-reader');
    const newState = state;
    later();
    const oldFrame = parsed(scoreboardContext(), [], undefined, {}, 'integration-reader')!;
    expect(reduceScreenMatchContext(state, oldFrame, Date.now())).toBe(newState);
  });

  it('a changed window epoch clears all old seats and refuses a fresh late reply from the retired window', () => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext());
    later();
    state = observe(state, hudContext('synthetic-window-b', 'hero_lash'));
    expect(state.players).toEqual([]);
    expect(state.localInventory).toEqual([]);
    expect(state.localHeroId).toBe('hero_lash');
    expect(state.retiredGameSessionIds).toContain('synthetic-window-a');
    later();
    const oldFrame = parsed(scoreboardContext(), [], state)!;
    expect(reduceScreenMatchContext(state, oldFrame, Date.now())).toBe(state);
  });

  it.each(['round-regression', 'finished-to-combat'] as const)('%s resets a same-process context without carrying old inventories', boundary => {
    let state = observe(createInitialScreenMatchContext(), scoreboardContext(), [contextBlock('ROUND 5', .45, .08)]);
    later();
    if (boundary === 'finished-to-combat') {
      state = observe(state, { ...hudContext(), panel: 'post-match' });
      later();
    }
    if (boundary === 'round-regression') {
      // One "ROUND 1" read below round 5 is a misread until a second read agrees (2026-10-18: a misread round was taken at once).
      state = observe(state, hudContext(), [contextBlock('ROUND 1', .45, .08)]);
      expect(state.round).toBe(5);
      later();
    }
    state = observe(state, hudContext(), boundary === 'round-regression' ? [contextBlock('ROUND 1', .45, .08)] : []);
    expect(state.players).toEqual([]);
    expect(state.localInventory).toEqual([]);
    expect(state.localAbilities).toEqual([]);
  });

  it('rejects child provenance from a different frame atomically', () => {
    const frame = parsed(scoreboardContext())!;
    frame.players![0]!.inventory![0]!.observation.frameId = 'different-capture';
    const state = createInitialScreenMatchContext();
    expect(reduceScreenMatchContext(state, frame, Date.now())).toBe(state);
  });

  it('rejects a ninth visible player instead of importing the telemetry sparse-seat convention', () => {
    const frame = parsed(scoreboardContext())!;
    frame.players!.push({ ...frame.players![0]!, seat: 8 });
    const state = createInitialScreenMatchContext();
    expect(reduceScreenMatchContext(state, frame, Date.now())).toBe(state);
  });

  it.each(['invalid-rank', 'invalid-seat', 'confidence', 'outside-bounds', 'unknown-status', 'oversized-items'] as const)(
    'rejects malformed native %s context before parsing', failure => {
      const context = abilities(scoreboardContext(), 0) as NativeScreenContext;
      if (failure === 'invalid-rank') context.abilities[2]!.rank = 4;
      if (failure === 'invalid-seat') context.heroes[1]!.seat = 12;
      if (failure === 'confidence') context.heroes[1]!.confidence = Number.NaN;
      if (failure === 'outside-bounds') context.items[0]!.bounds.x = 1.1;
      if (failure === 'unknown-status') (context.items[0] as unknown as { status: string }).status = 'bought-sometime';
      if (failure === 'oversized-items') context.items = Array(257).fill(context.items[0]);
      const request = { id: 'invalid-context', op: 'read', crop: FULL };
      expect(() => normalizeNativeReply(contextReply(request, context), FULL)).toThrow(TypeError);
    });

  it('positive inventory cells from an enemy never become local investment', () => {
    const native = scoreboardContext('synthetic-window-a', []);
    native.items.filter(item => item.seat === 4).forEach(item => { item.itemId = 'upgrade_boundless_spirit'; item.status = 'recognized'; });
    const state = observe(createInitialScreenMatchContext(), native);
    const result = advice(state, ['Metal Skin', 'Enchanter Emblem', 'Monster Rounds']);
    expect(state.localInventory).toEqual([]);
    expect(result.factsUsed?.filter(fact => fact.scope === 'own').some(fact => fact.label.includes('Boundless Spirit'))).toBe(false);
    expect(state.players.find(player => player.seat === 4)!.inventory.every(item => item.itemId === 'upgrade_boundless_spirit')).toBe(true);
  });

  it('an explicit reset retires the reader session and cannot be undone by a fresh old frame', () => {
    const first = observe(createInitialScreenMatchContext(), scoreboardContext());
    const reset = resetScreenMatchContext(first);
    later();
    expect(reduceScreenMatchContext(reset, parsed(scoreboardContext())!, Date.now())).toBe(reset);
    expect(reset.localHeroId).toBeNull();
    expect(reset.players).toEqual([]);
  });
});

function autonomous(responder: (request: ContextTestRequest) => { context?: NativeScreenContext; blocks?: ContextTestBlock[]; patch?: Record<string, unknown>; delay?: number } | undefined,
  options: { autoStart?: boolean; now?: () => number } = {}) {
  const workers: ContextTestWorker[] = [];
  const publications: ScreenReaderState[] = [];
  const spawn = vi.fn(() => {
    const worker = new ContextTestWorker();
    worker.respond = request => {
      if (request.op === 'fixture') return { reply: contextReply(request), afterMs: 20 };
      const response = responder(request);
      return response && { reply: contextReply(request, response.context && contextWithinCrop(response.context, request.crop), response.blocks ?? [], response.patch),
        afterMs: response.delay ?? 20 };
    };
    workers.push(worker); return worker;
  });
  const reader = createScreenReader({ helperPath: 'mock-reader-never-launched.exe', catalog, autoStart: options.autoStart ?? true,
    now: options.now ?? (() => Date.now()), monotonicNow: () => Date.now() - CONTEXT_TEST_START, spawnProcess: spawn,
    onState: state => publications.push(state) });
  readers.push(reader);
  return { reader, workers, spawn, publications };
}

describe('unattended context acquisition and decision liveness', () => {
  it('alternates truthful HUD crops at one total read per second and only widens for an observed scoreboard', async () => {
    let scene: 'combat' | 'scoreboard' = 'combat';
    const harness = autonomous(() => ({ context: scene === 'combat' ? hudContext() : scoreboardContext(), blocks: brawlRound() }));
    await vi.advanceTimersByTimeAsync(7_000);
    const worker = harness.workers[0]!;
    const combatReads = worker.requests.filter(({ request }) => request.op === 'read');
    expect(combatReads.length).toBeGreaterThanOrEqual(5);
    expect(combatReads.every(({ request }) => [DRAFT_HINT_REGION, DRAFT_FOOTER_REGION].some(region => JSON.stringify(region) === JSON.stringify(request.crop)))).toBe(true);
    for (let index = 1; index < combatReads.length; index++) expect(combatReads[index]!.startedAt - combatReads[index - 1]!.startedAt).toBeGreaterThanOrEqual(1_000);
    expect(harness.reader.getState().matchContext.localHeroId).toBe('hero_haze');
    expect(harness.reader.getState().matchContext.localSeat).toBeNull();
    scene = 'scoreboard';
    await vi.advanceTimersByTimeAsync(4_000);
    expect(worker.requests.some(({ request }) => request.op === 'read' && JSON.stringify(request.crop) === JSON.stringify(FULL))).toBe(true);
    expect(harness.reader.getState().matchContext.rosterCompleteness).toBe('complete');
    expect(harness.reader.getState().matchContext.localSeat).toBe(2);
    expect(worker.maximumOutstanding).toBe(1);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(worker.requests.filter(({ request }) => request.op === 'read').every(({ request }) => request.context === true)).toBe(true);
  });

  it('automatically tracks HUD → scoreboard → closed scoreboard → real-geometry draft → combat without keeping stale decisions', async () => {
    let scene: 'combat' | 'scoreboard' | 'draft' = 'combat';
    const harness = autonomous(() => ({ context: scene === 'scoreboard' ? scoreboardContext() : { ...hudContext(), panel: scene === 'draft' ? 'draft' : 'hud' },
      blocks: scene === 'draft' ? publicDraftBlocks() : [contextBlock('ROUND 3', .45, .08)] }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.reader.getState().matchContext.localHeroId).toBe('hero_haze');
    scene = 'scoreboard'; await vi.advanceTimersByTimeAsync(4_000);
    const closedAt = Date.now();
    scene = 'combat'; await vi.advanceTimersByTimeAsync(50);
    // A scan already dispatched before closing can finish. Later HUD frames cannot reconfirm it.
    const seenEnemyAt = harness.reader.getState().matchContext.players[4]!.inventory[0]!.observation.capturedAt;
    expect(seenEnemyAt).toBeLessThanOrEqual(closedAt);
    await vi.advanceTimersByTimeAsync(2_950);
    expect(harness.reader.getState().matchContext.players[4]!.inventory[0]!.observation.capturedAt).toBe(seenEnemyAt);
    scene = 'draft'; await vi.advanceTimersByTimeAsync(5_000);
    const ready = harness.reader.getState();
    expect(ready.status).toBe('ready');
    expect(ready.offers.map(offer => offer.itemId)).toEqual(['upgrade_toxic_bullets', 'upgrade_chain_lightning', 'upgrade_tech_overflow']);
    expect(ready.matchContext.players).toHaveLength(8);
    expect(ready.matchContext.localAbilities).toEqual([]);
    expect(ready.advice?.factsUsed?.some(fact => fact.scope === 'enemy')).toBe(true);
    // Bonuses are unread: the best card is named with a caveat rather than withheld.
    expect(ready.advice?.preferredPosition).not.toBeNull();
    expect(ready.offers.some(offer => offer.position === ready.advice!.preferredPosition)).toBe(true);
    expect(ready.advice?.caveat).toBeDefined();
    scene = 'combat'; await vi.advanceTimersByTimeAsync(1_200);
    expect(harness.reader.getState()).toMatchObject({ offers: [], advice: null });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.reader.getState().status).toBe('waiting-draft');
    expect(harness.reader.getState().offers).toEqual([]);
    expect(harness.reader.getState().advice).toBeNull();
    expect(harness.workers[0]!.maximumOutstanding).toBe(1);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it('the same visible choices change comparison from a newly read ability investment', async () => {
    let fixationRank = 0;
    const harness = autonomous(() => ({ context: abilities({ ...hudContext(), panel: 'draft' }, fixationRank),
      blocks: publicDraftBlocks(['Extra Spirit', 'Rapid Rounds', 'Monster Rounds']) }));
    await vi.advanceTimersByTimeAsync(5_000);
    const first = harness.reader.getState();
    expect(first.status).toBe('ready');
    expect(first.advice?.comparisonPosition).toBe(1);
    fixationRank = 1;
    await vi.advanceTimersByTimeAsync(2_000);
    const second = harness.reader.getState();
    expect(second.status).toBe('ready');
    expect(second.advice?.comparisonPosition).toBe(0);
    expect(second.advice?.factsUsed?.some(fact => fact.label.includes('Fixation') && fact.observedAt! > first.observedAt!)).toBe(true);
    // The named pick follows the newly read investment, not the earlier one.
    expect(first.advice?.preferredPosition).toBe(1);
    expect(second.advice?.preferredPosition).toBe(0);
    for (const state of harness.publications.filter(state => state.advice?.comparisonPosition === 0)) {
      expect(state.matchContext.localAbilities.find(ability => ability.slot === 2)?.rank).toBe(1);
    }
    expect(harness.workers[0]!.maximumOutstanding).toBe(1);
  });

  it('withdraws own ability and build guidance, but not the visible draft, when the view changes to spectating', async () => {
    let spectator = false;
    const harness = autonomous(() => ({ context: { ...abilities({ ...hudContext(), panel: 'draft' }, 0, 2, 2), viewMode: spectator ? 'spectator' : 'participant' },
      blocks: publicDraftBlocks() }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reader.getState().status).toBe('ready');
    expect(harness.reader.getState().abilityAdvice?.kind).toBe('upgrade');
    spectator = true; await vi.advanceTimersByTimeAsync(1_000);
    // The own build and ability guidance go; the visible draft (only offered to players) keeps its pick.
    expect(harness.reader.getState()).toMatchObject({ abilityAdvice: null,
      matchContext: { viewMode: 'spectator', localHeroId: null, localAbilityPoints: null, localInventory: [], localAbilities: [] } });
    expect(harness.reader.getState().offers).toHaveLength(3);
    expect(harness.reader.getState().advice?.factsUsed?.some(fact => fact.scope === 'own')).toBeFalsy();
  });

  it('a changed native window epoch cannot show the old eight players beside new choices', async () => {
    let session = 'synthetic-window-a'; let showScoreboard = true;
    const harness = autonomous(() => ({ context: showScoreboard ? scoreboardContext(session) : { ...hudContext(session, 'hero_lash'), panel: 'draft' },
      blocks: showScoreboard ? [] : publicDraftBlocks() }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reader.getState().matchContext.players).toHaveLength(8);
    const revision = harness.reader.getState().revision;
    session = 'synthetic-window-b'; showScoreboard = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.reader.getState().status).toBe('ready');
    expect(harness.reader.getState().matchContext.localHeroId).toBe('hero_lash');
    expect(harness.reader.getState().matchContext.players).toEqual([]);
    expect(harness.reader.getState().advice?.factsUsed?.some(fact => fact.scope === 'ally' || fact.scope === 'enemy')).toBe(false);
    for (const state of harness.publications.filter(state => state.revision > revision && state.matchContext.gameSessionId === 'synthetic-window-b')) {
      expect(state.matchContext.players).toEqual([]);
    }
  });

  it('rejects fresh card pixels explicitly tagged with an already retired native window epoch', async () => {
    let session = 'synthetic-window-a'; let names = ['Toxic Bullets', 'Tesla Bullets', 'Spiritual Overflow'];
    const harness = autonomous(() => ({ context: { ...hudContext(session), panel: 'draft' }, blocks: publicDraftBlocks(names) }));
    await vi.advanceTimersByTimeAsync(4_000);
    session = 'synthetic-window-b'; await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.reader.getState().matchContext.retiredGameSessionIds).toContain('synthetic-window-a');
    session = 'synthetic-window-a'; names = ['Metal Skin', 'Enchanter Emblem', 'Monster Rounds'];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.reader.getState().offers.map(offer => offer.itemId)).not.toEqual(['upgrade_metal_skin', 'upgrade_magic_shield', 'upgrade_non_player_bonus']);
    expect(harness.reader.getState().offers).toEqual([]);
    expect(harness.reader.getState().advice).toBeNull();
  });

  it('stops and retires a worker epoch before restart; late lines cannot restore old context', async () => {
    let session = 'synthetic-window-a';
    const harness = autonomous(() => ({ context: scoreboardContext(session) }));
    await vi.advanceTimersByTimeAsync(5_000);
    const old = harness.workers[0]!;
    const oldContext = harness.reader.getState().matchContext.sessionId;
    await harness.reader.retry();
    expect(old.kill).toHaveBeenCalledTimes(1);
    expect(old.exitCode).not.toBeNull();
    expect(harness.reader.getState().matchContext.players).toEqual([]);
    old.output(contextReply({ id: old.requests.at(-1)!.request.id, op: 'read', crop: FULL }, scoreboardContext('stale-window')));
    session = 'synthetic-window-b';
    await vi.advanceTimersByTimeAsync(5_000);
    const state = harness.reader.getState();
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(state.matchContext.sessionId).not.toBe(oldContext);
    expect(state.matchContext.retiredSessionIds).toContain(oldContext);
    expect(state.matchContext.gameSessionId).toBe('synthetic-window-b');
    expect(state.matchContext.players).toHaveLength(8);
    expect(harness.workers.every(worker => worker.maximumOutstanding === 1)).toBe(true);
  });

  it('does not spawn a replacement while the previous worker still lacks a confirmed exit', async () => {
    let session = 'synthetic-window-a';
    const harness = autonomous(() => ({ context: scoreboardContext(session) }));
    await vi.advanceTimersByTimeAsync(5_000);
    const old = harness.workers[0]!; old.acknowledgeKill = false;
    const restarting = harness.reader.retry();
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.reader.getState().matchContext.players).toEqual([]);
    old.output(contextReply({ id: old.requests.at(-1)!.request.id, op: 'read', crop: FULL }, scoreboardContext()));
    expect(harness.reader.getState().matchContext.players).toEqual([]);
    session = 'synthetic-window-b'; old.confirmExit(); await restarting;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.reader.getState().matchContext.gameSessionId).toBe('synthetic-window-b');
  });

  it('missing responses withdraw guidance and stop at the retry limit instead of building a request backlog', async () => {
    let missing = false;
    const harness = autonomous(() => missing ? undefined : { context: { ...hudContext(), panel: 'draft' }, blocks: publicDraftBlocks() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reader.getState().status).toBe('ready');
    missing = true;
    // One slow read keeps the shown cards (it only restarts the helper).
    await vi.advanceTimersByTimeAsync(SCREEN_READER_LIMITS.readTimeoutMs + 500);
    expect(harness.reader.getState().metrics.timeouts).toBe(1);
    expect(harness.reader.getState().offers).toHaveLength(3);
    // Each attempt waits the full read timeout plus a helper restart; allow for all of them.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reader.getState()).toMatchObject({ status: 'paused', offers: [], advice: null, abilityAdvice: null });
    expect(harness.reader.getState().metrics.timeouts).toBe(SCREEN_READER_LIMITS.maxTimeoutsBeforeRetry);
    expect(harness.spawn.mock.calls.length).toBeLessThanOrEqual(SCREEN_READER_LIMITS.maxTimeoutsBeforeRetry);
    expect(harness.workers.every(worker => worker.maximumOutstanding === 1 && worker.exitCode !== null)).toBe(true);
    const requests = harness.workers.reduce((sum, worker) => sum + worker.requests.length, 0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.workers.reduce((sum, worker) => sum + worker.requests.length, 0)).toBe(requests);
  });

  it('round regression in the same native process clears old ranks and enemy builds before showing the next match cards', async () => {
    let newMatch = false;
    const harness = autonomous(() => ({ context: newMatch ? { ...hudContext(), panel: 'draft' } : abilities({ ...scoreboardContext(), panel: 'draft' }, 1),
      blocks: [contextBlock(`ROUND ${newMatch ? 1 : 5}`, .45, .08), ...publicDraftBlocks()] }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reader.getState().matchContext.players).toHaveLength(8);
    expect(harness.reader.getState().matchContext.localAbilities.find(ability => ability.slot === 2)?.rank).toBe(1);
    newMatch = true; await vi.advanceTimersByTimeAsync(3_000);
    const state = harness.reader.getState();
    expect(state.status).toBe('ready');
    expect(state.matchContext.round).toBe(1);
    expect(state.matchContext.players).toEqual([]);
    expect(state.matchContext.localAbilities).toEqual([]);
    expect(state.advice?.factsUsed?.some(fact => fact.scope === 'enemy' || fact.label.includes('rank 1'))).toBe(false);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it('full context refresh replaces a card request and honors the worker duty limit under a slow frame load', async () => {
    const harness = autonomous(() => ({ context: abilities({ ...hudContext(), panel: 'draft' }, 1), blocks: publicDraftBlocks(),
      delay: 210, patch: { elapsedMs: 210, metrics: { cpuMs: 3, workingSetMb: 100 } } }));
    await vi.advanceTimersByTimeAsync(20_000);
    const worker = harness.workers[0]!;
    const reads = worker.requests.filter(({ request }) => request.op === 'read');
    expect(reads.length).toBeGreaterThan(8);
    for (let index = 1; index < reads.length; index++) {
      // A draft is on screen throughout, so the draft's (larger) duty share applies.
      expect(reads[index]!.startedAt - reads[index - 1]!.startedAt).toBeGreaterThanOrEqual(210 / SCREEN_READER_LIMITS.draftWorkerWallShare);
    }
    const full = reads.filter(({ request }) => JSON.stringify(request.crop) === JSON.stringify(FULL));
    expect(full.length).toBeGreaterThan(2);
    for (let index = 1; index < full.length; index++) expect(full[index]!.startedAt - full[index - 1]!.startedAt).toBeGreaterThanOrEqual(1_000);
    expect(worker.maximumOutstanding).toBe(1);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.reader.getState().metrics.timeouts).toBe(0);
  });

  it('turning off stops acquisition and atomically removes context and all spend/pick guidance', async () => {
    const harness = autonomous(() => ({ context: abilities({ ...scoreboardContext(), panel: 'draft' }, 0, 2, 2), blocks: publicDraftBlocks() }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reader.getState().offers).toHaveLength(3);
    await harness.reader.setEnabled(false);
    const state = harness.reader.getState();
    expect(state).toMatchObject({ enabled: false, status: 'paused', offers: [], advice: null, abilityAdvice: null,
      matchContext: { sessionId: null, localHeroId: null, players: [], localAbilities: [] } });
    expect(harness.workers[0]!.exitCode).not.toBeNull();
    const writes = harness.workers[0]!.requests.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.workers[0]!.requests).toHaveLength(writes);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it('the ability spending freshness timer cannot be extended by a backward epoch clock adjustment', async () => {
    let epochOffset = 0;
    const harness = autonomous(() => ({ context: abilities({ ...hudContext(), panel: 'draft' }, 0, 2, 2), blocks: publicDraftBlocks() }),
      { autoStart: false, now: () => Date.now() + epochOffset });
    for (const duration of [500, 500, 1_000, 500]) {
      const work = harness.reader.pollOnce(); await vi.advanceTimersByTimeAsync(duration); await work;
    }
    expect(harness.reader.getState().abilityAdvice?.kind).toBe('upgrade');
    const pointsAt = harness.reader.getState().matchContext.observations.localAbilityPoints!.capturedAt;
    epochOffset = -500;
    await vi.advanceTimersByTimeAsync(pointsAt + SCREEN_CAPTURE_FRESHNESS_MS - 2 - Date.now());
    expect(harness.reader.getState().abilityAdvice?.kind).toBe('upgrade');
    // Elapsed time passes the window; the shifted wall clock alone would still be 500 ms inside it.
    await vi.advanceTimersByTimeAsync(3);
    expect(harness.reader.getState().abilityAdvice?.kind).not.toBe('upgrade');
  });
});
