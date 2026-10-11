import type {
  Advice, CapabilityName, Catalog, DraftState, ItemInstance, MatchContext,
  Observation, PlayerState, SourceState, TelemetryEvent,
} from '../src/shared/types';

/** Contract fixtures only. These values are not observed participant telemetry. */
export const NOW = 1_000_000;
export const SESSION = 'fixture-session';
export const MATCH_ID = 'fixture-match';
export const MODEL_VERSION = 'fixture-model-v1';
export const CATALOG_REVISION = 'fixture-catalog-v1';

export const testCatalog: Catalog = {
  clientVersion: 'fixture-build', revision: CATALOG_REVISION,
  source: 'Synthetic unit-test definitions', retrievedAt: '2026-10-03T00:00:00Z',
  liveModelValidated: true, modelVersion: MODEL_VERSION,
  heroes: [{ id: 'hero-a', name: 'Fixture Hero', role: 'test', tags: ['weapon'] }],
  items: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id, name: `Fixture item ${id}`, category: 'weapon', tier: 1,
    tags: ['weapon'], description: 'Synthetic contract-test item.',
  })),
};

const capabilities: CapabilityName[] = [
  'participant_match', 'street_brawl_round', 'own_draft_offers',
  'offer_modifiers', 'own_reroll_state', 'current_inventories',
  'purchased_items', 'ability_investment', 'corruption_decision', 'source_continuity',
];

export function source(overrides: Partial<SourceState> = {}): SourceState {
  return {
    sessionId: SESSION, provider: 'fixture-provider', status: 'connected',
    runtimeVersion: 'fixture-runtime', capabilities: capabilities.map((name) => ({
      name, supported: true, verified: true, detail: 'Synthetic test capability.',
    })), noImageMethodVerified: true, sequenceKind: 'upstream', sequence: null, lastReceivedAt: NOW,
    deliveryBoundMs: 100, continuity: 'continuous', message: 'Synthetic fixture.',
    ...overrides,
  };
}

export function observation(sequence: number, overrides: Partial<Observation> = {}): Observation {
  return {
    sessionId: SESSION, provider: 'fixture-provider', receivedAt: NOW,
    observedAt: NOW - 50, clockUncertaintyMs: 10, sequence,
    visibility: 'participant', changedAt: NOW - 50, confirmedAt: NOW - 50,
    ...overrides,
  };
}

export function item(id = 'a', instanceId = `instance-${id}`, overrides: Partial<ItemInstance> = {}): ItemInstance {
  return {
    id, instanceId, bonusIds: [], variant: 'base', modifierBits: null,
    modifiersDecoded: true, ...overrides,
  };
}

export function player(seat = 0, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    seat, team: seat < 4 ? 0 : 1, heroId: 'hero-a', heroName: 'Fixture Hero',
    playerName: null, steamId: seat < 2 ? '' : `76561190000000${seat}`,
    isLocal: seat === 0, inventory: [], inventoryCompleteness: 'complete',
    inventoryRevision: 0, abilities: [{ id: 'ability-a', rank: 0, unlocked: false }],
    abilityCompleteness: 'complete', abilityRevision: 0,
    observation: observation(2), inventoryObservation: observation(2),
    abilityObservation: observation(2), purchasedHistory: [], ...overrides,
  };
}

export function match(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    id: MATCH_ID, mode: 'street_brawl', clientVersion: testCatalog.clientVersion,
    localSeat: 0, localTeam: 0, round: 1, scores: [0, 0], phase: 'draft',
    deadlineAt: NOW + 30_000, observation: observation(1), ...overrides,
  };
}

export function draft(overrides: Partial<DraftState> = {}): DraftState {
  return {
    id: 'fixture-draft', round: 1, generation: 1, pickStage: 1,
    offers: [0, 1, 2].map((position) => ({
      position, item: item(['a', 'b', 'c'][position]!, `offer-${position}`), available: true,
    })), rerollsRemaining: 1, rerollAvailable: true,
    observation: observation(3), ...overrides,
  };
}

export function fixtureEvents(): TelemetryEvent[] {
  return [
    { type: 'source', source: source() },
    { type: 'match', match: match() },
    { type: 'roster', matchId: MATCH_ID, players: Array.from({ length: 8 }, (_, seat) => player(seat)), complete: true, observation: observation(2) },
    { type: 'draft', matchId: MATCH_ID, draft: draft() },
  ];
}

export function advice(key: Advice['key'], overrides: Partial<Advice> = {}): Advice {
  return {
    key, kind: 'pick', preferredPosition: 0, title: 'Synthetic fixture pick',
    reasons: ['Synthetic contract-test reason.'], limitations: ['Fixture only.'],
    ranked: [{ position: 0, itemId: 'a', score: 1, reasons: ['Fixture.'] }],
    reroll: { kind: 'withheld', reason: 'No replacement probability model.' },
    evidence: 'synthetic', computedAt: NOW, ...overrides,
  };
}
