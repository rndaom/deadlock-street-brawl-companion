import { describe, expect, it } from 'vitest';
import { parseTelemetryEvent } from '../src/core/validation';
import { DEFAULT_SETTINGS, isAppMode, readStoredSettings, validateSettingsPatch } from '../src/shared/settings';
import type { TelemetryEvent } from '../src/shared/types';
import { draft, fixtureEvents, item, MATCH_ID, match, NOW, observation, player, source } from './fixtures';

function inventoryEvent(): Extract<TelemetryEvent, { type: 'inventory' }> {
  return {
    type: 'inventory', matchId: MATCH_ID, seat: 0, operation: 'snapshot',
    items: [item('a')], removeInstanceIds: [], complete: true, observation: observation(4),
  };
}

describe('untrusted normalized telemetry boundary', () => {
  it('accepts the synthetic contract fixtures without converting unknown values to zero', () => {
    for (const event of fixtureEvents()) expect(parseTelemetryEvent(event)).toEqual(event);
    const unknown = { type: 'draft', matchId: MATCH_ID, draft: draft({ rerollsRemaining: null, rerollAvailable: null }) };
    const parsed = parseTelemetryEvent(unknown);
    expect(parsed.type).toBe('draft');
    if (parsed.type === 'draft') {
      expect(parsed.draft.rerollsRemaining).toBeNull();
      expect(parsed.draft.rerollAvailable).toBeNull();
    }
  });

  it.each([null, undefined, [], {}, 12, 'draft', { type: 'capture' }, { type: 'inject' }])('rejects a malformed event envelope: %j', (input) => {
    expect(() => parseTelemetryEvent(input)).toThrow();
  });

  it('rejects unknown event fields rather than carrying arbitrary payloads forward', () => {
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), rawTelemetry: { personalData: 'fixture' } })).toThrow();
    expect(() => parseTelemetryEvent({ type: 'match', match: { ...match(), hiddenEnemyOffer: 'fixture' } })).toThrow();
  });

  it.each([-1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects a non-monotonic sequence representation: %s', (sequence) => {
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), observation: observation(sequence) })).toThrow();
  });

  it.each([-1, NaN, Infinity, '1000'])('rejects an invalid clock representation: %s', (receivedAt) => {
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), observation: { ...observation(4), receivedAt } })).toThrow();
  });

  it.each([-1, 12, 1.5, '0'])('rejects an invalid roster seat: %s', (seat) => {
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), seat })).toThrow();
  });

  it('rejects duplicate seat keys and multiple claimed local players', () => {
    const roster = { type: 'roster', matchId: MATCH_ID, complete: true, observation: observation(2) };
    expect(() => parseTelemetryEvent({ ...roster, players: [player(0), player(0)] })).toThrow();
    expect(() => parseTelemetryEvent({ ...roster, players: [player(0), player(1, { isLocal: true })] })).toThrow();
  });

  it('preserves 64-bit Steam identifiers as strings and accepts blank bot IDs', () => {
    const roster = {
      type: 'roster', matchId: MATCH_ID, complete: true, observation: observation(2),
      players: [player(0, { steamId: '76561198012345678' }), player(1, { steamId: '' })],
    };
    const parsed = parseTelemetryEvent(roster);
    expect(parsed.type).toBe('roster');
    if (parsed.type === 'roster') expect(parsed.players.map((entry) => entry.steamId)).toEqual(['76561198012345678', '']);
    expect(() => parseTelemetryEvent({ ...roster, players: [{ ...player(0), steamId: 76561198012345678 }] })).toThrow();
  });

  it('rejects duplicate inventory instance IDs while permitting equal item IDs in separate instances', () => {
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), items: [item('a'), item('b', 'instance-a')] })).toThrow();
    expect(parseTelemetryEvent({ ...inventoryEvent(), items: [item('a', 'one'), item('a', 'two')] }).type).toBe('inventory');
  });

  it('rejects contradictory removal and snapshot operations', () => {
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), operation: 'remove', items: [item('a')] })).toThrow();
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), operation: 'add', removeInstanceIds: ['instance-b'] })).toThrow();
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), operation: 'snapshot', removeInstanceIds: ['instance-b'] })).toThrow();
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), operation: 'replace', removeInstanceIds: ['one', 'one'] })).toThrow();
  });

  it('rejects ambiguous offer positions and oversized external arrays', () => {
    const base = draft();
    expect(() => parseTelemetryEvent({ type: 'draft', matchId: MATCH_ID, draft: { ...base, offers: [base.offers[0], base.offers[0]] } })).toThrow();
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), items: Array.from({ length: 257 }, (_, index) => item('a', `instance-${index}`)) })).toThrow();
  });

  it('requires the exact normalized mode enum instead of guessing from a similar string or number', () => {
    for (const mode of ['StreetBrawl', 'streetbrawl', 4]) {
      expect(() => parseTelemetryEvent({ type: 'match', match: { ...match(), mode } })).toThrow();
    }
    for (const mode of ['street_brawl', 'normal', 'unknown']) {
      expect(parseTelemetryEvent({ type: 'match', match: { ...match(), mode } }).type).toBe('match');
    }
  });

  it('rejects duplicate capability declarations', () => {
    const valid = source();
    expect(() => parseTelemetryEvent({ type: 'source', source: { ...valid, capabilities: [valid.capabilities[0], valid.capabilities[0]] } })).toThrow();
  });

  it('does not permit string coercion of ranks, availability, or completion', () => {
    expect(() => parseTelemetryEvent({ ...inventoryEvent(), complete: 'true' })).toThrow();
    expect(() => parseTelemetryEvent({ type: 'draft', matchId: MATCH_ID, draft: draft({ rerollsRemaining: '0' as never }) })).toThrow();
    expect(() => parseTelemetryEvent({ type: 'abilities', matchId: MATCH_ID, seat: 0, complete: true, abilities: [{ id: 'ability-a', rank: '0', unlocked: true }], observation: observation(4) })).toThrow();
  });

  it('accepts unknown purchase timing without turning history into an inventory event', () => {
    const parsed = parseTelemetryEvent({ type: 'purchases', matchId: MATCH_ID, seat: 0, complete: true, items: [{ itemId: 'a', gameTime: null }], observation: observation(4) });
    expect(parsed.type).toBe('purchases');
    if (parsed.type === 'purchases') expect(parsed.items[0]!.gameTime).toBeNull();
  });
});

describe('renderer request validation', () => {
  it('accepts a partial patch and validates exact companion-only modes and scenarios', () => {
    expect(validateSettingsPatch({ textScale: 1.2, alwaysOnTop: true })).toEqual({ textScale: 1.2, alwaysOnTop: true });
    expect(validateSettingsPatch({ displayId: null })).toEqual({ displayId: null });
    expect(DEFAULT_SETTINGS.hidePlayerNames).toBe(true);
    expect(isAppMode('live')).toBe(true);
    expect(isAppMode('demo')).toBe(false);
    expect(isAppMode('LIVE')).toBe(false);
  });

  it.each([null, undefined, [], 'large', 1, { unknownSetting: true }, { textScale: 0.79 }, { textScale: 1.51 }, { textScale: NaN }, { textScale: Infinity }, { textScale: '1' }, { hidePlayerNames: 'true' }, { alwaysOnTop: 1 }, { displayId: '' }, { displayId: 123 }, { displayId: 'x'.repeat(101) }])('rejects a malformed settings request: %j', (input) => {
    expect(() => validateSettingsPatch(input)).toThrow();
  });

  it('validates the most-active-items preference as a whole number from 0 to 4 (default 4, no limit)', () => {
    expect(DEFAULT_SETTINGS.maxActiveItems).toBe(4);
    for (const maxActiveItems of [0, 1, 2, 3, 4]) expect(validateSettingsPatch({ maxActiveItems })).toEqual({ maxActiveItems });
    for (const maxActiveItems of [-1, 5, 1.5, NaN, Infinity, '2', null, true]) expect(() => validateSettingsPatch({ maxActiveItems })).toThrow();
    expect(readStoredSettings({ maxActiveItems: 2, textScale: 1.1 })).toEqual({ maxActiveItems: 2, textScale: 1.1 });
    // A bad saved value is dropped on its own and the default stays.
    expect(readStoredSettings({ maxActiveItems: 9, overlay: false })).toEqual({ overlay: false });
    expect(readStoredSettings({ overlay: false })).not.toHaveProperty('maxActiveItems');
  });

  it('accepts the documented text-size bounds and copies the patch', () => {
    for (const textScale of [0.8, 1.5]) expect(validateSettingsPatch({ textScale }).textScale).toBe(textScale);
    const patch = { textScale: 1 };
    const validated = validateSettingsPatch(patch);
    patch.textScale = 1.5;
    expect(validated.textScale).toBe(1);
  });
});
