import type { Catalog, DemoScenarioId, ItemInstance, Observation, PlayerState, SourceState, TelemetryEvent } from '../shared/types';

/** Entirely synthetic. Display names are familiar; IDs/effect tags are laboratory fixtures. */
export const DEMO_CATALOG: Catalog = {
  clientVersion: 'synthetic-v1', revision: 'fixture-2026-10-03', source: 'Synthetic development fixtures',
  retrievedAt: '2026-10-03', liveModelValidated: false, modelVersion: 'synthetic-situational-v1',
  items: [
    { id: 'demo:heal-bane', name: 'Heal Bane', category: 'vitality', tier: 2, tags: ['anti_heal', 'sustain'], description: 'Synthetic effect tags: healing suppression and sustain.' },
    { id: 'demo:spirit-lifesteal', name: 'Spirit Lifesteal', category: 'vitality', tier: 2, tags: ['spirit', 'sustain', 'lifesteal'], description: 'Synthetic effect tags: spirit damage sustain.' },
    { id: 'demo:improved-spirit', name: 'Improved Spirit', category: 'spirit', tier: 3, tags: ['spirit', 'damage'], description: 'Synthetic effect tags: spirit damage.' },
    { id: 'demo:kinetic-dash', name: 'Kinetic Dash', category: 'weapon', tier: 2, tags: ['weapon', 'mobility'], description: 'Synthetic effect tags: weapon mobility.' },
    { id: 'demo:bullet-armor', name: 'Bullet Armor', category: 'vitality', tier: 2, tags: ['bullet_resist', 'survival'], description: 'Synthetic effect tags: bullet resistance.' },
    { id: 'demo:spirit-armor', name: 'Spirit Armor', category: 'vitality', tier: 2, tags: ['spirit_resist', 'survival'], description: 'Synthetic effect tags: spirit resistance.' },
    { id: 'demo:healing-rite', name: 'Healing Rite', category: 'vitality', tier: 1, tags: ['healing', 'support', 'active'], description: 'Synthetic effect tags: healing and team support.' },
    { id: 'demo:extra-spirit', name: 'Extra Spirit', category: 'spirit', tier: 1, tags: ['spirit'], description: 'Synthetic bonus item with spirit tag.' },
    { id: 'demo:extra-stamina', name: 'Extra Stamina', category: 'vitality', tier: 1, tags: ['mobility'], description: 'Synthetic bonus item with mobility tag.' },
    { id: 'demo:rapid-rounds', name: 'Rapid Rounds', category: 'weapon', tier: 1, tags: ['weapon', 'fire_rate'], description: 'Synthetic effect tags: weapon fire rate.' },
    { id: 'demo:debuff-remover', name: 'Debuff Remover', category: 'vitality', tier: 3, tags: ['cleanse', 'survival', 'active'], description: 'Synthetic effect tags: cleanse and survival.' },
    { id: 'demo:knockdown', name: 'Knockdown', category: 'spirit', tier: 3, tags: ['control', 'active'], description: 'Synthetic effect tags: active control.' },
  ],
  heroes: [
    { id: 'demo:lady-geist', name: 'Lady Geist', role: 'Spirit / sustain', tags: ['spirit', 'sustain'] },
    { id: 'demo:abrams', name: 'Abrams', role: 'Frontline', tags: ['healing', 'melee', 'control'] },
    { id: 'demo:haze', name: 'Haze', role: 'Weapon', tags: ['weapon', 'fire_rate'] },
    { id: 'demo:ivy', name: 'Ivy', role: 'Support', tags: ['support', 'weapon'] },
    { id: 'demo:infernus', name: 'Infernus', role: 'Damage over time', tags: ['spirit', 'healing', 'debuff'] },
    { id: 'demo:mcginnis', name: 'McGinnis', role: 'Team sustain', tags: ['weapon', 'healing', 'support'] },
    { id: 'demo:seven', name: 'Seven', role: 'Spirit / control', tags: ['spirit', 'control'] },
    { id: 'demo:dynamo', name: 'Dynamo', role: 'Healing / control', tags: ['spirit', 'healing', 'control'] },
  ],
};

export const DEMO_SCENARIOS: { id: DemoScenarioId; label: string }[] = [
  { id: 'draft', label: 'Current draft' }, { id: 'rerolled', label: 'New offer generation' },
  { id: 'combat', label: 'Combat' }, { id: 'interrupted', label: 'Connection interrupted' },
  { id: 'unknown-item', label: 'Unknown item' }, { id: 'unknown-ranks', label: 'Ability ranks unavailable' },
  { id: 'post-match', label: 'Post-match' }, { id: 'waiting', label: 'Waiting for match' },
];

function item(id: string, slot: string, bonusIds: string[] = []): ItemInstance {
  return { id: `demo:${id}`, instanceId: slot, bonusIds: bonusIds.map(value => `demo:${value}`), variant: 'base', modifierBits: '0', modifiersDecoded: true };
}

export function getDemoEvents(scenario: DemoScenarioId, now = Date.now()): TelemetryEvent[] {
  let sequence = 0;
  const sessionId = `synthetic-${now}`;
  const observation = (): Observation => ({ provider: 'Synthetic fixtures', sessionId, receivedAt: now, observedAt: now, clockUncertaintyMs: 0, sequence: ++sequence, visibility: 'participant', changedAt: now, confirmedAt: now });
  const source: SourceState = {
    sessionId, provider: 'Synthetic fixtures', status: 'connected', runtimeVersion: 'fixture-v1',
    capabilities: ['participant_match', 'street_brawl_round', 'own_draft_offers', 'offer_modifiers', 'own_reroll_state', 'current_inventories', 'ability_investment', 'source_continuity'].map(name => ({ name: name as SourceState['capabilities'][number]['name'], supported: true, verified: true, detail: 'Synthetic test data; this does not establish live provider support.' })),
    noImageMethodVerified: true, sequence: 0, sequenceKind: 'local', lastReceivedAt: now, deliveryBoundMs: 0, continuity: 'continuous',
    message: 'Scripted development example. No game data is being read.',
  };
  const events: TelemetryEvent[] = [{ type: 'source', source }];
  if (scenario === 'waiting') return events;
  const matchId = 'synthetic-street-brawl';
  events.push({ type: 'match', match: { id: matchId, mode: 'street_brawl', clientVersion: DEMO_CATALOG.clientVersion, localSeat: 0, localTeam: 0, round: 3, scores: [1, 1], phase: 'draft', deadlineAt: now + 50000, observation: observation() } });
  const players: PlayerState[] = DEMO_CATALOG.heroes.map((hero, seat) => ({
    seat, team: seat < 4 ? 0 : 1, heroId: hero.id, heroName: hero.name,
    playerName: null, steamId: null, isLocal: seat === 0,
    inventory: [item(seat === 0 ? 'spirit-lifesteal' : seat % 2 === 0 ? 'spirit-armor' : 'healing-rite', `seat-${seat}-item-1`)],
    inventoryCompleteness: 'complete', inventoryRevision: 1,
    abilities: [1, 2, 3, 4].map((rank, index) => ({ id: `Ability ${index + 1}`, rank: index === 0 ? 2 : rank === 4 ? 1 : 0, unlocked: true })),
    abilityCompleteness: 'complete', abilityRevision: 1, observation: null,
  }));
  const rosterObservation = observation();
  for (const player of players) {
    player.observation = rosterObservation;
    player.inventoryObservation = rosterObservation;
    player.abilityObservation = rosterObservation;
  }
  if (scenario === 'unknown-ranks') {
    players[0].abilities = []; players[0].abilityCompleteness = 'unknown'; players[0].abilityObservation = null;
  }
  events.push({ type: 'roster', matchId, players, complete: true, observation: rosterObservation });
  const generation = scenario === 'rerolled' ? 2 : 1;
  events.push({ type: 'draft', matchId, draft: {
    id: 'synthetic-round-3-pick-2', generation, pickStage: 2, round: 3,
    offers: [
      { position: 0, available: true, item: scenario === 'unknown-item' ? { ...item('undecoded-option', 'offer-0'), variant: 'unknown', modifierBits: 'undecoded', modifiersDecoded: false } : item('heal-bane', 'offer-0', ['extra-spirit']) },
      { position: 1, available: true, item: item(scenario === 'rerolled' ? 'debuff-remover' : 'improved-spirit', 'offer-1') },
      { position: 2, available: true, item: item(scenario === 'rerolled' ? 'knockdown' : 'kinetic-dash', 'offer-2', ['extra-stamina']) },
    ],
    rerollsRemaining: scenario === 'rerolled' ? 0 : 1, rerollAvailable: scenario !== 'rerolled', observation: observation(),
  } });
  if (scenario === 'combat' || scenario === 'post-match') {
    events.push({ type: 'round', matchId, round: 3, phase: scenario === 'combat' ? 'combat' : 'finished', scores: scenario === 'post-match' ? [3, 1] : [1, 1], deadlineAt: null, observation: observation() });
  }
  if (scenario === 'interrupted') events.push({ type: 'source', source: { ...source, sequence, status: 'interrupted', continuity: 'gap', message: 'Synthetic provider interruption. Previous advice has been cleared.' } });
  return events;
}
