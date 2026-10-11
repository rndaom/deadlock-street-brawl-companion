import { z } from 'zod';
import type { TelemetryEvent } from '../shared/types';

const identity = z.string().trim().min(1).max(256);
const timestamp = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Street Brawl has eight participants, but provider roster slots may be sparse in 0..11.
const seat = z.number().int().min(0).max(11);
const team = z.number().int().min(0).max(1);
const completeness = z.enum(['unknown', 'partial', 'complete']);
const phase = z.enum(['waiting', 'draft', 'combat', 'transition', 'finished']);
const scores = z.tuple([count, count]).nullable();
const unique = <T>(values: T[], key: (value: T) => string | number) =>
  new Set(values.map(key)).size === values.length;

/** All times are in the local epoch-millisecond domain. Receipt is never origin time. */
export const observationSchema = z.object({
  sessionId: identity.nullable().optional(),
  provider: identity,
  receivedAt: timestamp,
  observedAt: timestamp.nullable(),
  clockUncertaintyMs: timestamp.nullable(),
  sequence: count,
  visibility: z.enum(['participant', 'unknown']),
  changedAt: timestamp.nullable().optional(),
  confirmedAt: timestamp.nullable().optional(),
}).strict();

export const itemInstanceSchema = z.object({
  id: identity,
  instanceId: identity,
  bonusIds: z.array(identity).max(64),
  variant: z.enum(['base', 'enhanced', 'legendary', 'corrupted', 'unknown']),
  modifierBits: z.string().max(256).nullable(),
  modifiersDecoded: z.boolean(),
}).strict();

const items = z.array(itemInstanceSchema).max(256)
  .refine((value) => unique(value, (item) => item.instanceId), 'Duplicate inventory instance ID');
const abilitySchema = z.object({
  id: identity,
  rank: count.nullable(),
  unlocked: z.boolean().nullable(),
}).strict();
const abilities = z.array(abilitySchema).max(64)
  .refine((value) => unique(value, (ability) => ability.id), 'Duplicate ability ID');
const purchaseSchema = z.object({
  itemId: identity,
  gameTime: timestamp.nullable(),
  className: z.string().max(256).optional(),
  name: z.string().max(256).optional(),
  enhanced: z.boolean().nullable().optional(),
  upgradeBits: z.string().max(256).nullable().optional(),
}).strict();
const purchases = z.array(purchaseSchema).max(2048);

export const sourceStateSchema = z.object({
  sessionId: identity.nullable().optional(),
  provider: identity,
  status: z.enum(['unavailable', 'connecting', 'connected', 'interrupted']),
  runtimeVersion: z.string().max(256).nullable(),
  capabilities: z.array(z.object({
    name: z.enum([
      'participant_match', 'street_brawl_round', 'own_draft_offers', 'offer_modifiers',
      'own_reroll_state', 'current_inventories', 'purchased_items', 'ability_investment',
      'corruption_decision', 'source_continuity',
    ]),
    supported: z.boolean(),
    verified: z.boolean(),
    detail: z.string().max(4096),
  }).strict()).max(10).refine((value) => unique(value, (capability) => capability.name), 'Duplicate capability'),
  noImageMethodVerified: z.boolean(),
  sequence: count.nullable(),
  sequenceKind: z.enum(['upstream', 'local']).optional(),
  lastReceivedAt: timestamp.nullable(),
  deliveryBoundMs: timestamp.nullable(),
  continuity: z.enum(['unknown', 'continuous', 'gap']),
  message: z.string().max(8192),
}).strict();

export const playerStateSchema = z.object({
  seat,
  team,
  heroId: identity.nullable(),
  heroName: z.string().max(256).nullable(),
  playerName: z.string().max(256).nullable(),
  // Blank IDs occur for bots. Numeric coercion would corrupt 64-bit identifiers.
  steamId: z.string().max(32).nullable(),
  isLocal: z.boolean(),
  inventory: items,
  inventoryCompleteness: completeness,
  inventoryRevision: count,
  abilities,
  abilityCompleteness: completeness,
  abilityRevision: count,
  observation: observationSchema.nullable(),
  inventoryObservation: observationSchema.nullable().optional(),
  abilityObservation: observationSchema.nullable().optional(),
  purchasedHistory: purchases.optional(),
}).strict();

export const matchContextSchema = z.object({
  id: identity,
  mode: z.enum(['street_brawl', 'normal', 'unknown']),
  clientVersion: identity.nullable(),
  localSeat: seat.nullable(),
  localTeam: team.nullable(),
  round: count.nullable(),
  scores,
  phase,
  deadlineAt: timestamp.nullable(),
  observation: observationSchema,
}).strict();

export const draftStateSchema = z.object({
  id: identity,
  round: count.nullable().optional(),
  generation: count,
  pickStage: count,
  offers: z.array(z.object({
    position: count,
    item: itemInstanceSchema,
    available: z.boolean(),
  }).strict()).max(32).refine((value) => unique(value, (offer) => offer.position), 'Duplicate offer position'),
  rerollsRemaining: count.nullable(),
  rerollAvailable: z.boolean().nullable(),
  observation: observationSchema,
}).strict();

const players = z.array(playerStateSchema).max(8)
  .refine((value) => unique(value, (player) => player.seat), 'Duplicate roster seat')
  .refine((value) => value.filter((player) => player.isLocal).length <= 1, 'Multiple local players');

export const telemetryEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('source'), source: sourceStateSchema }).strict(),
  z.object({ type: z.literal('reset'), reason: z.string().max(4096), at: timestamp }).strict(),
  z.object({ type: z.literal('match'), match: matchContextSchema }).strict(),
  z.object({ type: z.literal('roster'), matchId: identity, players, complete: z.boolean(), observation: observationSchema }).strict(),
  z.object({ type: z.literal('round'), matchId: identity, round: count, phase, scores, deadlineAt: timestamp.nullable(), observation: observationSchema }).strict(),
  z.object({ type: z.literal('draft'), matchId: identity, draft: draftStateSchema }).strict(),
  z.object({ type: z.literal('action'), matchId: identity, action: z.enum(['pick', 'reroll', 'draft_closed']), observation: observationSchema }).strict(),
  z.object({ type: z.literal('inventory'), matchId: identity, seat, operation: z.enum(['snapshot', 'add', 'remove', 'replace']), items, removeInstanceIds: z.array(identity).max(256).refine((value) => unique(value, (id) => id), 'Duplicate removed instance ID'), complete: z.boolean(), observation: observationSchema }).strict(),
  z.object({ type: z.literal('abilities'), matchId: identity, seat, abilities, complete: z.boolean(), observation: observationSchema }).strict(),
  z.object({ type: z.literal('purchases'), matchId: identity, seat, items: purchases, complete: z.boolean(), observation: observationSchema }).strict(),
]).superRefine((event, context) => {
  if (event.type === 'inventory') {
    if (event.operation === 'remove' && event.items.length > 0) {
      context.addIssue({ code: 'custom', path: ['items'], message: 'Removal events cannot add items' });
    }
    if (event.operation === 'snapshot' && event.removeInstanceIds.length > 0) {
      context.addIssue({ code: 'custom', path: ['removeInstanceIds'], message: 'Snapshot removal is expressed by its complete flag' });
    }
    if (event.operation === 'add' && event.removeInstanceIds.length > 0) {
      context.addIssue({ code: 'custom', path: ['removeInstanceIds'], message: 'Use replace for a combined removal and addition' });
    }
  }
});

/** The normalized boundary admits data only; no hooks, capture commands or game input exist here. */
export function parseTelemetryEvent(input: unknown): TelemetryEvent {
  return telemetryEventSchema.parse(input) as TelemetryEvent;
}
