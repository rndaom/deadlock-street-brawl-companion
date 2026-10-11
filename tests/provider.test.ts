import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEADLOCK_GAME_ID, mapDeadlockMode, parseDeadlockRoster, parsePurchasedHistory,
  providerCapabilities, REQUIRED_FEATURES, startOverwolfProvider,
} from '../electron/overwolf-provider';
import { parseTelemetryEvent } from '../src/core/validation';
import { createInitialState, reduceTelemetry } from '../src/core/store';
import type { TelemetryEvent } from '../src/shared/types';
import { observation } from './fixtures';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const stops: (() => void)[] = [];

class MockGep extends EventEmitter {
  setRequiredFeatures = vi.fn<(gameId: number, features: string[] | undefined) => Promise<void>>(async () => undefined);
  getInfo = vi.fn<(gameId: number) => Promise<unknown>>(async () => ({}));
}
class MockPackages extends EventEmitter { gep?: MockGep; }

function rosterValue(seat = 0, overrides: Record<string, unknown> = {}) {
  return {
    hero_id: '4', hero_name: 'Fixture Hero', player_name: `Fixture player ${seat}`,
    steam_id: `76561190000000${seat}`, team_id: seat < 4 ? 2 : 3,
    is_local: seat === 0, ...overrides,
  };
}

function hydration(overrides: Record<string, unknown> = {}) {
  return {
    game_info: { game_mode: { game_mode: 'StreetBrawl' }, phase: 'GameInProgress' },
    match_info: {
      match_id: '12345', roster_0: rosterValue(0),
      items_0: { items: [{ id: '99', class_name: 'fixture-item', name: 'Fixture Item', enhanced: true, upgrade_info: '123' }] },
      team_score: { amber: '1', sapphire: '2' },
    },
    ...overrides,
  };
}

function runtime(info: unknown = {}) {
  const gep = new MockGep();
  gep.getInfo.mockResolvedValue(info);
  const packages = new MockPackages();
  packages.gep = gep;
  const events: TelemetryEvent[] = [];
  const provider = startOverwolfProvider({ overwolf: { packages } }, (event) => events.push(event));
  stops.push(() => provider.stop());
  return { gep, packages, events, provider };
}

function update(gep: MockGep, feature: string, key: string, value: unknown, gameId = DEADLOCK_GAME_ID) {
  gep.emit('new-info-update', {}, gameId, { gameId, feature, category: feature, key, value });
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

describe('documented provider field boundaries', () => {
  it('never promotes connection health to verified own-offer or tracking capabilities', () => {
    const report = providerCapabilities();
    expect(report).toHaveLength(10);
    expect(report.every((value) => !value.verified)).toBe(true);
    expect(report.find((value) => value.name === 'participant_match')?.supported).toBe(true);
    expect(report.find((value) => value.name === 'purchased_items')?.supported).toBe(true);
    for (const name of ['own_draft_offers', 'current_inventories', 'ability_investment', 'own_reroll_state', 'source_continuity']) {
      expect(report.find((value) => value.name === name)?.supported).toBe(false);
    }
    expect(providerCapabilities(false).every((value) => !value.supported)).toBe(true);
  });

  it('maps only a mode token documented for this provider namespace', () => {
    expect(mapDeadlockMode({ game_mode: 'Normal' })).toBe('normal');
    expect(mapDeadlockMode(JSON.stringify({ game_mode: 'Normal' }))).toBe('normal');
    for (const input of [{ game_mode: 'StreetBrawl' }, { game_mode: 'street_brawl' }, { game_mode: 4 }, { game_mode: 'normal' }, 4, 'Normal', null, '{invalid']) {
      expect(mapDeadlockMode(input)).toBe('unknown');
    }
  });

  it('preserves source slot, team and string Steam identity without guessing current ownership or ranks', () => {
    const parsed = parseDeadlockRoster(9, JSON.stringify(rosterValue(9, { is_local: true, steam_id: '76561198012345678' })), observation(1));
    expect(parsed?.seat).toBe(9);
    expect(parsed?.team).toBe(1);
    expect(parsed?.isLocal).toBe(true);
    expect(parsed?.steamId).toBe('76561198012345678');
    expect(parsed?.inventory).toEqual([]);
    expect(parsed?.inventoryCompleteness).toBe('unknown');
    expect(parsed?.abilities).toEqual([]);
    expect(parsed?.abilityCompleteness).toBe('unknown');
  });

  it('retains blank/bot seats without coercing imprecise numeric Steam IDs', () => {
    for (const steam_id of ['', null, 76561198012345678]) {
      const parsed = parseDeadlockRoster(1, rosterValue(1, { steam_id }), observation(1));
      expect(parsed?.seat).toBe(1);
      expect(parsed?.steamId).toBeNull();
    }
  });

  it.each([-1, 12, 0.5, NaN])('rejects an invalid source slot %s', (seat) => {
    expect(parseDeadlockRoster(seat, rosterValue(), observation(1))).toBeNull();
  });

  it('rejects missing/malformed teams instead of assigning the local team', () => {
    for (const team_id of [null, undefined, 0, 1, 4, -1, 'unknown']) {
      expect(parseDeadlockRoster(0, rosterValue(0, { team_id }), observation(1))).toBeNull();
    }
    expect(parseDeadlockRoster(0, '{bad-json', observation(1))).toBeNull();
  });

  it('keeps purchased modifier metadata separate from item instances and ownership', () => {
    const parsed = parsePurchasedHistory({ items: [{ id: '99', name: 'Fixture Item', class_name: 'fixture-item', enhanced: true, upgrade_info: '123' }] });
    expect(parsed).toEqual([{ itemId: '99', gameTime: null, name: 'Fixture Item', className: 'fixture-item', enhanced: true, upgradeBits: '123' }]);
    expect(parsed![0]).not.toHaveProperty('instanceId');
    expect(parsed![0]).not.toHaveProperty('variant');
    expect(parsePurchasedHistory({ items: [] })).toEqual([]);
  });

  it.each([null, [], '{invalid', { items: [{ id: 'unknown' }] }, { items: Array.from({ length: 257 }, () => ({ id: '99' })) }])('rejects malformed purchased history %j', (input) => {
    expect(parsePurchasedHistory(input)).toBeNull();
  });
});

describe('supported-runtime lifecycle with mocked package events', () => {
  it('starts ordinary Electron with explicit unavailability and no synthetic gameplay events', () => {
    const events: TelemetryEvent[] = [];
    const provider = startOverwolfProvider({}, (event) => events.push(event));
    stops.push(() => provider.stop());
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('source');
    if (events[0]!.type === 'source') {
      expect(events[0]!.source.status).toBe('unavailable');
      expect(events[0]!.source.noImageMethodVerified).toBe(false);
      expect(events[0]!.source.deliveryBoundMs).toBeNull();
      expect(events[0]!.source.capabilities.every((value) => !value.supported && !value.verified)).toBe(true);
    }
  });

  it('registers only the published feature set and still withholds own-draft semantics', async () => {
    const work = runtime(hydration());
    await flush();
    expect(work.gep.setRequiredFeatures).toHaveBeenCalledWith(DEADLOCK_GAME_ID, [...REQUIRED_FEATURES]);
    expect(work.gep.getInfo).toHaveBeenCalledWith(DEADLOCK_GAME_ID);
    const source = work.events.filter((event) => event.type === 'source').at(-1)!;
    expect(source.type).toBe('source');
    if (source.type === 'source') {
      expect(source.source.status).toBe('connected');
      expect(source.source.continuity).toBe('unknown');
      expect(source.source.deliveryBoundMs).toBeNull();
      expect(source.source.noImageMethodVerified).toBe(false);
      expect(source.source.capabilities.every((value) => !value.verified)).toBe(true);
    }
    expect(work.events.some((event) => event.type === 'draft' || event.type === 'abilities' || event.type === 'inventory')).toBe(false);
  });

  it.each([false, true])('accepts documented dictionary hydration (info wrapper %s) at the strict normalized boundary', async (wrapped) => {
    const payload = hydration();
    const work = runtime(wrapped ? { info: payload } : payload);
    await flush();
    for (const event of work.events) expect(() => parseTelemetryEvent(event)).not.toThrow();
    const state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.match?.id).toBe('12345');
    expect(state.match?.mode).toBe('unknown');
    expect(state.match?.round).toBeNull();
    expect(state.match?.deadlineAt).toBeNull();
    expect(state.match?.scores).toEqual([1, 2]);
    expect(state.players).toHaveLength(1);
    expect(state.players[0]!.inventoryCompleteness).toBe('unknown');
    expect(state.players[0]!.purchasedHistory?.[0]?.itemId).toBe('99');
    expect(state.draft).toBeNull();
    expect(state.advice).toBeNull();
  });

  it('preserves eight sparse source slots and local identity without renumbering', async () => {
    const slots = [0, 1, 2, 3, 6, 7, 8, 9];
    const payload = hydration({ match_info: {
      match_id: '12345',
      ...Object.fromEntries(slots.map((seat) => [`roster_${seat}`, rosterValue(seat, { is_local: seat === 9 })])),
    } });
    const work = runtime(payload);
    await flush();
    for (const event of work.events) expect(() => parseTelemetryEvent(event)).not.toThrow();
    const state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.players.map((entry) => entry.seat)).toEqual(slots);
    expect(state.match?.localSeat).toBe(9);
    expect(state.match?.localTeam).toBe(1);
  });

  it('withholds the entire roster of a normal match instead of truncating it to eight', async () => {
    const work = runtime(hydration({ game_info: { game_mode: { game_mode: 'Normal' }, phase: 'GameInProgress' } }));
    await flush();
    expect(work.events.some((event) => event.type === 'roster' || event.type === 'purchases')).toBe(false);
    const state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.match?.mode).toBe('normal');
    expect(state.players).toEqual([]);
  });

  it('clears an eight-player partial roster when a ninth distinct participant arrives', async () => {
    const payload = hydration({ match_info: { match_id: '12345', ...Object.fromEntries(Array.from({ length: 8 }, (_, seat) => [`roster_${seat}`, rosterValue(seat)])) } });
    const work = runtime(payload);
    await flush();
    const before = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(before.players).toHaveLength(8);
    update(work.gep, 'match_info', 'roster_8', rosterValue(8));
    const state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.players).toEqual([]);
    expect(state.match?.id).toBe('12345');
    expect(state.match?.localSeat).toBeNull();
  });

  it('ignores wrong-game callbacks, unknown fields, and malformed event envelopes', async () => {
    const work = runtime();
    await flush();
    const count = work.events.length;
    update(work.gep, 'match_info', 'match_id', '999', 123);
    update(work.gep, 'match_info', 'own_draft_offers', { offers: ['must-not-be-used'] });
    work.gep.emit('new-info-update', {}, DEADLOCK_GAME_ID, { feature: 'match_info', key: 'match_id', value: '999' });
    expect(work.events).toHaveLength(count);
  });

  it('clears old context on game exit and package crash', async () => {
    const work = runtime(hydration());
    await flush();
    work.gep.emit('game-exit', {}, DEADLOCK_GAME_ID, 'Deadlock');
    let state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.match).toBeNull();
    expect(state.players).toEqual([]);
    work.packages.emit('crashed', {}, true);
    state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.source.status).toBe('interrupted');
    expect(state.match).toBeNull();
  });

  it('does not hydrate a cached match from a recovery retry after game exit', async () => {
    vi.useFakeTimers();
    const work = runtime(hydration());
    await vi.advanceTimersByTimeAsync(0);
    const initialHydrations = work.gep.getInfo.mock.calls.length;
    expect(initialHydrations).toBe(1);
    work.gep.emit('error', {}, DEADLOCK_GAME_ID, 'Fixture disconnect');
    work.gep.emit('game-exit', {}, DEADLOCK_GAME_ID, 'Deadlock');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work.gep.getInfo).toHaveBeenCalledTimes(initialHydrations);
    expect(work.events.reduce(reduceTelemetry, createInitialState('live')).match).toBeNull();
    const enable = vi.fn();
    work.gep.emit('game-detected', { enable }, DEADLOCK_GAME_ID, 'Deadlock');
    await vi.advanceTimersByTimeAsync(0);
    expect(enable).toHaveBeenCalledOnce();
    expect(work.gep.getInfo).toHaveBeenCalledTimes(initialHydrations + 1);
  });

  it('withholds ambiguous local identities before an invalid roster can cross the boundary', async () => {
    const work = runtime(hydration({ match_info: { match_id: '12345', roster_0: rosterValue(0), roster_1: rosterValue(1, { is_local: true }) } }));
    await flush();
    for (const event of work.events) expect(() => parseTelemetryEvent(event)).not.toThrow();
    const state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.match).toBeNull();
    expect(state.players).toEqual([]);
    expect(state.source.status).toBe('interrupted');
  });

  it('changes source epoch on package recovery and restarts local observation ordering', async () => {
    const work = runtime(hydration());
    await flush();
    const old = work.events.filter((event) => event.type === 'source').at(-1)!;
    work.packages.emit('ready', {}, 'gep', '1.2.3');
    await flush();
    const next = work.events.filter((event) => event.type === 'source').at(-1)!;
    if (old.type === 'source' && next.type === 'source') expect(next.source.sessionId).not.toBe(old.source.sessionId);
    const state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.match?.id).toBe('12345');
    expect(state.advice).toBeNull();
  });

  it('ignores a stale in-flight hydration once a newer stream identity arrives', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const work = runtime();
    work.gep.getInfo.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await flush();
    update(work.gep, 'match_info', 'match_id', '67890');
    finish!(hydration());
    await flush();
    const state = work.events.reduce(reduceTelemetry, createInitialState('live'));
    expect(state.match?.id).toBe('67890');
    expect(state.players).toEqual([]);
  });

  it('detaches event subscriptions and ignores late async completion after stop', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const work = runtime();
    work.gep.getInfo.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await flush();
    work.provider.stop();
    const count = work.events.length;
    finish!(hydration());
    update(work.gep, 'match_info', 'match_id', '999');
    work.packages.emit('ready', {}, 'gep', '1.2.3');
    await flush();
    expect(work.events).toHaveLength(count);
    expect(work.gep.eventNames()).toEqual([]);
    expect(work.packages.eventNames()).toEqual([]);
  });

  it('stops retrying feature registration after five attempts', async () => {
    vi.useFakeTimers();
    const gep = new MockGep();
    gep.setRequiredFeatures.mockRejectedValue(new Error('Fixture unavailable'));
    const packages = new MockPackages();
    packages.gep = gep;
    const events: TelemetryEvent[] = [];
    const provider = startOverwolfProvider({ overwolf: { packages } }, (event) => events.push(event));
    stops.push(() => provider.stop());
    await vi.runAllTimersAsync();
    expect(gep.setRequiredFeatures).toHaveBeenCalledTimes(5);
    const last = events.at(-1)!;
    expect(last.type).toBe('source');
    if (last.type === 'source') expect(last.source.status).toBe('unavailable');
  });
});
