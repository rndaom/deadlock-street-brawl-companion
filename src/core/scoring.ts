import type {
  Advice, Catalog, CatalogHero, CatalogItem, DraftOffer, ItemInstance,
  MatchState, Observation, PlayerState, RankedOffer,
} from '../shared/types';
import { decisionBlockers, getDecisionKey } from './store';

type Style = 'weapon' | 'spirit' | 'melee' | 'support';
interface Effects {
  styles: Set<Style>;
  targets: Set<string>;
  counters: Set<string>;
  utilities: Set<string>;
}
interface Profile {
  player: PlayerState;
  hero: CatalogHero;
  heroEffects: Effects;
  inventory: CatalogItem[];
  effects: Effects;
}
interface Component { points: number; reason: string }

/**
 * Deliberately small, inspectable Demo weights. These are design examples, not
 * measured item values, combat formulas, acquisition odds, or win probabilities.
 * Tier and price are not automatic bonuses; duplicate ownership is not a penalty.
 */
const DEMO_WEIGHTS = Object.freeze({ heroStyle: 2, loadoutStyle: 3, enemyAnswer: 2, teamComplement: 1.5 });
const MODEL_LIMITS = [
  'Demo only: scores are relative synthetic tag points, not win probabilities or a validated mechanics model.',
  'The baseline considers every main and bonus item. It does not model stacking rules, numerical ability scaling, active-item execution, or future rounds.',
  'Ability investment is displayed from observations; this baseline does not infer ranks or recommend upgrades.',
];

/** Evaluate a snapshot without mutating it or changing the game's offer positions. */
export function evaluateDecision(state: MatchState, catalog: Catalog, now = Date.now()): Advice | null {
  const key = getDecisionKey(state, catalog.modelVersion, catalog.revision);
  if (!key) return null;

  const blockers = [...decisionBlockers(state, catalog, now), ...catalogBlockers(state, catalog)];
  // A boolean on a catalogue cannot turn this illustrative tag scorer into a
  // mechanics evaluator. A separately verified evaluator contract is still needed.
  if (state.mode === 'live') {
    blockers.push('A verified live mechanics evaluator is not installed. The synthetic tag baseline runs only in Demo.');
  }

  const reroll = rerollVerdict(state);
  if (blockers.length > 0) {
    return {
      key, kind: 'withheld', preferredPosition: null, title: 'Advice withheld',
      reasons: [...new Set(blockers)], limitations: [...MODEL_LIMITS],
      ranked: [], reroll, evidence: 'synthetic', computedAt: now,
    };
  }

  const items = new Map(catalog.items.map(item => [item.id, item]));
  const heroes = new Map(catalog.heroes.map(hero => [hero.id, hero]));
  const profiles: Profile[] = state.players.map(player => ({
    player,
    hero: heroes.get(player.heroId!)!,
    heroEffects: effectsOf(heroes.get(player.heroId!)!.tags),
    inventory: player.inventory.flatMap(instance => bundleItems(instance, items)),
    effects: mergeEffects(player.inventory.flatMap(instance => bundleItems(instance, items)).map(item => effectsOf(item.tags))),
  }));
  const self = profiles.find(profile => profile.player.seat === state.match!.localSeat)!;
  const allies = profiles.filter(profile => profile.player.team === self.player.team && profile !== self);
  const enemies = profiles.filter(profile => profile.player.team !== self.player.team);

  // Keep this array in the incoming offer order. preferredPosition identifies the
  // winner without moving a card or renumbering an option.
  const ranked = state.draft!.offers.filter(offer => offer.available).map(offer =>
    scoreBundle(offer, items, self, allies, enemies));
  const best = [...ranked].sort((left, right) => right.score - left.score || left.position - right.position)[0];
  if (!best) {
    return {
      key, kind: 'withheld', preferredPosition: null, title: 'Advice withheld',
      reasons: ['No current offer is confirmed selectable.'], limitations: [...MODEL_LIMITS],
      ranked: [], reroll, evidence: 'synthetic', computedAt: now,
    };
  }

  const limitations = [...MODEL_LIMITS];
  const incomplete = profiles.filter(profile => profile.player.inventoryCompleteness !== 'complete');
  if (incomplete.length > 0) {
    limitations.push(`Inventories for ${names(incomplete.map(profile => profile.hero.name))} are incomplete; only observed positive tags contribute, and team coverage gaps are not assumed.`);
  }
  if (ranked.filter(offer => offer.score === best.score).length > 1) {
    limitations.push('The best synthetic scores tie; the lowest original offer position breaks the tie.');
  }

  return {
    key, kind: 'pick', preferredPosition: best.position,
    title: `Demo preference: ${items.get(best.itemId)!.name}`,
    reasons: best.reasons, limitations, ranked, reroll,
    evidence: 'synthetic', computedAt: now,
  };
}

function rerollVerdict(state: MatchState): Advice['reroll'] {
  const draft = state.draft;
  if (draft?.rerollsRemaining === 0) {
    return { kind: 'withheld', reason: 'Zero rerolls remain in the observed draft; reroll is unavailable.' };
  }
  if (draft?.rerollAvailable === false) {
    return { kind: 'withheld', reason: 'The observed draft reports that reroll is currently unavailable.' };
  }
  if (draft?.rerollsRemaining == null || draft.rerollAvailable == null) {
    return { kind: 'withheld', reason: 'Actual reroll availability or remaining budget is unknown.' };
  }
  return {
    kind: 'withheld',
    reason: `${draft.rerollsRemaining} reroll${draft.rerollsRemaining === 1 ? '' : 's'} observed. Keep-versus-reroll advice requires a verified replacement process and continuation-value model; neither is installed.`,
  };
}

function catalogBlockers(state: MatchState, catalog: Catalog): string[] {
  const blockers: string[] = [];
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const heroes = new Map(catalog.heroes.map(hero => [hero.id, hero]));
  if (items.size !== catalog.items.length || heroes.size !== catalog.heroes.length) {
    blockers.push('Catalogue identifiers are ambiguous because entries contain duplicate IDs.');
  }
  for (const player of state.players) {
    inspectObservation(player.observation, `Seat ${player.seat} hero`, state, blockers);
    inspectObservation(
      player.inventoryObservation === undefined ? player.observation : player.inventoryObservation,
      `Seat ${player.seat} inventory`, state, blockers,
    );
    if (!player.heroId || !heroes.has(player.heroId)) {
      blockers.push(`Seat ${player.seat}: observed hero ID is unknown to the pinned catalogue.`);
    }
    for (const instance of player.inventory) {
      inspectBundle(instance, `Seat ${player.seat} inventory`, items, blockers);
    }
  }
  for (const offer of state.draft?.offers ?? []) {
    if (offer.available) inspectBundle(offer.item, `Offer ${offer.position}`, items, blockers);
  }
  return blockers;
}

function inspectObservation(observation: Observation | null, label: string, state: MatchState, blockers: string[]): void {
  if (!observation || observation.visibility !== 'participant') {
    blockers.push(`${label}: participant-visible observation is unavailable.`);
  } else if (observation.provider !== state.source.provider ||
    (observation.sessionId ?? null) !== (state.source.sessionId ?? null)) {
    blockers.push(`${label}: observation belongs to another source or source session.`);
  }
}

function inspectBundle(instance: ItemInstance, label: string, items: Map<string, CatalogItem>, blockers: string[]): void {
  for (const id of [instance.id, ...instance.bonusIds]) {
    if (!items.has(id)) blockers.push(`${label}: item or bonus ID ${id} is unknown to the pinned catalogue.`);
  }
  if (!instance.modifiersDecoded || instance.variant === 'unknown') {
    blockers.push(`${label}: the item variant or modifier bundle has not been decoded.`);
  } else if (instance.variant !== 'base' || (instance.modifierBits !== null && !/^0+(?:x0+)?$/i.test(instance.modifierBits.trim()))) {
    // CatalogItem has only base descriptive tags, no per-modifier effect contract.
    blockers.push(`${label}: ${instance.variant} modifiers require an effect evaluator that is not installed.`);
  }
}

function bundleItems(instance: ItemInstance, items: Map<string, CatalogItem>): CatalogItem[] {
  return [instance.id, ...instance.bonusIds].map(id => items.get(id)!);
}

function scoreBundle(
  offer: DraftOffer, items: Map<string, CatalogItem>, self: Profile,
  allies: Profile[], enemies: Profile[],
): RankedOffer {
  const bundle = bundleItems(offer.item, items);
  const effect = mergeEffects(bundle.map(item => effectsOf(item.tags)));
  const components: Component[] = [];

  const heroStyles = intersection(effect.styles, self.heroEffects.styles);
  components.push({
    points: DEMO_WEIGHTS.heroStyle * ratio(heroStyles.length, self.heroEffects.styles.size),
    reason: heroStyles.length
      ? `Fits ${self.hero.name}'s ${heroStyles.join('/')} build.`
      : `No shared build direction is known for your observed ${self.hero.name}.`,
  });

  const buildStyles = intersection(effect.styles, self.effects.styles);
  const matchingOwned = self.inventory.filter(item => intersection(effectsOf(item.tags).styles, effect.styles).length > 0);
  components.push({
    points: DEMO_WEIGHTS.loadoutStyle * ratio(buildStyles.length, self.effects.styles.size),
    reason: buildStyles.length
      ? `Follows your ${buildStyles.join('/')} build around confirmed ${names(matchingOwned.map(item => item.name))}.`
      : `${self.hero.name}'s ${self.inventory.length} confirmed item${self.inventory.length === 1 ? '' : 's'} show no matching build direction.`,
  });

  for (const counter of effect.counters) {
    const relevant = enemies.filter(enemy => enemy.effects.targets.has(counter) || enemy.heroEffects.targets.has(counter));
    if (relevant.length === 0) continue;
    const evidence = relevant.map(enemy => {
      const observedItems = enemy.inventory.filter(item => effectsOf(item.tags).targets.has(counter));
      return observedItems.length
        ? `${enemy.hero.name} with ${observedItems[0].name}`
        : enemy.hero.name;
    });
    components.push({
      points: DEMO_WEIGHTS.enemyAnswer * relevant.length,
      reason: `${counterPurpose(counter)} observed on ${names(evidence)}.`,
    });
  }

  const damageAllies = allies.filter(ally => [...ally.effects.styles, ...ally.heroEffects.styles].some(style => style !== 'support'));
  const supportsTeam = effect.styles.has('support') || effect.utilities.has('control') || effect.utilities.has('shielding');
  if (supportsTeam && damageAllies.length) {
    components.push({
      points: DEMO_WEIGHTS.teamComplement * damageAllies.length / Math.max(1, allies.length),
      reason: `Supports damage builds on teammates ${names(damageAllies.map(ally => ally.hero.name))}.`,
    });
  }

  // Only complete inventories support an absence statement. This concerns Demo
  // catalogue tag coverage, not a claim about real stacking or hidden abilities.
  const team = [self, ...allies];
  if (team.every(profile => profile.player.inventoryCompleteness === 'complete')) {
    const relevantGaps = [...effect.counters].filter(counter =>
      enemies.some(enemy => enemy.effects.targets.has(counter) || enemy.heroEffects.targets.has(counter)) &&
      team.every(profile => !profile.effects.counters.has(counter)));
    if (relevantGaps.length) {
      components.push({
        points: DEMO_WEIGHTS.teamComplement * relevantGaps.length,
        reason: `No ${relevantGaps.map(counterLabel).join('/').toLowerCase()} item is confirmed on your team (${names(team.map(profile => profile.hero.name))}).`,
      });
    }
  }

  const reasons = [...components].sort((left, right) => right.points - left.points).slice(0, 2).map(component => component.reason);
  if (bundle.length > 1) {
    // Explain bonuses even when they did not add a new tag to the saturated model.
    reasons[reasons.length - 1] = reasons[reasons.length - 1].replace(/\.$/, '') + `; includes ${names(bundle.slice(1).map(item => item.name))}.`;
  }
  return {
    position: offer.position, itemId: offer.item.id,
    score: Math.round(components.reduce((sum, component) => sum + component.points, 0) * 100) / 100,
    reasons,
  };
}

function emptyEffects(): Effects {
  return { styles: new Set(), targets: new Set(), counters: new Set(), utilities: new Set() };
}
function mergeEffects(profiles: Effects[]): Effects {
  const result = emptyEffects();
  for (const profile of profiles) {
    for (const key of ['styles', 'targets', 'counters', 'utilities'] as const) {
      for (const value of profile[key]) (result[key] as Set<string>).add(value);
    }
  }
  return result;
}
function effectsOf(tags: string[]): Effects {
  const effects = emptyEffects();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/[ _]/g, '-').replace(/^style:/, '');
    if (tag.startsWith('counter:')) {
      effects.counters.add(tag.slice(8) === 'bullet' ? 'weapon' : tag.slice(8));
      continue;
    }
    if (['weapon', 'gun', 'weapon-damage', 'bullet', 'bullet-damage', 'attack-speed', 'fire-rate', 'ammo', 'magazine'].includes(tag)) {
      effects.styles.add('weapon'); effects.targets.add('weapon');
    } else if (['spirit', 'spirit-damage', 'spirit-power', 'ability-damage', 'cooldown', 'ability-range'].includes(tag)) {
      effects.styles.add('spirit'); effects.targets.add('spirit');
    } else if (['melee', 'melee-damage', 'heavy-melee', 'light-melee'].includes(tag)) {
      effects.styles.add('melee'); effects.targets.add('melee');
    } else if (tag === 'support') {
      effects.styles.add('support');
    } else if (['healing', 'heal', 'health-regen', 'regen', 'regeneration', 'lifesteal', 'heal-amplification'].includes(tag)) {
      effects.styles.add('support'); effects.targets.add('healing'); effects.utilities.add('healing');
    } else if (['bullet-lifesteal', 'spirit-lifesteal'].includes(tag)) {
      const style = tag === 'bullet-lifesteal' ? 'weapon' : 'spirit';
      effects.styles.add(style); effects.styles.add('support'); effects.targets.add(style); effects.targets.add('healing');
    } else if (['shield', 'shielding', 'rescue'].includes(tag)) {
      effects.styles.add('support'); effects.targets.add('shielding'); effects.utilities.add('shielding');
    } else if (['bullet-resist', 'bullet-resistance', 'weapon-resist', 'bullet-armor', 'bullet-shield'].includes(tag)) {
      effects.counters.add('weapon'); effects.targets.add('bullet-resist');
    } else if (['spirit-resist', 'spirit-resistance', 'spirit-armor', 'spirit-shield'].includes(tag)) {
      effects.counters.add('spirit'); effects.targets.add('spirit-resist');
    } else if (['melee-resist', 'melee-resistance'].includes(tag)) {
      effects.counters.add('melee'); effects.targets.add('melee-resist');
    } else if (['anti-heal', 'antiheal', 'heal-reduction', 'healing-reduction'].includes(tag)) {
      effects.counters.add('healing');
    } else if (['control-resist', 'crowd-control-resist', 'debuff-resist', 'status-resist', 'anti-cc', 'cleanse'].includes(tag)) {
      effects.counters.add('control');
    } else if (tag === 'anti-mobility') {
      effects.counters.add('mobility');
    } else if (['bullet-resist-reduction', 'bullet-resistance-reduction'].includes(tag)) {
      effects.styles.add('weapon'); effects.counters.add('bullet-resist');
    } else if (['spirit-resist-reduction', 'spirit-resistance-reduction'].includes(tag)) {
      effects.styles.add('spirit'); effects.counters.add('spirit-resist');
    } else if (['crowd-control', 'control', 'stun', 'slow', 'silence'].includes(tag)) {
      effects.targets.add('control'); effects.utilities.add('control');
    } else if (['mobility', 'movement', 'move-speed', 'stamina'].includes(tag)) {
      effects.targets.add('mobility'); effects.utilities.add('mobility');
    } else if (['health', 'vitality', 'durability'].includes(tag)) {
      effects.utilities.add('health');
    }
  }
  return effects;
}
function intersection<T>(left: Set<T>, right: Set<T>): T[] { return [...left].filter(value => right.has(value)); }
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? numerator / denominator : 0; }
function names(values: string[]): string {
  const unique = [...new Set(values)];
  return unique.slice(0, 3).join(', ') + (unique.length > 3 ? ` and ${unique.length - 3} more` : '');
}
function counterLabel(counter: string): string {
  return ({ healing: 'Healing suppression', weapon: 'Weapon mitigation', spirit: 'Spirit mitigation', control: 'Control answers', mobility: 'Mobility answers' } as Record<string, string>)[counter] ?? `${counter} answers`;
}
function counterPurpose(counter: string): string {
  return ({ healing: 'Addresses healing', weapon: 'Addresses weapon damage', spirit: 'Addresses spirit damage', control: 'Addresses control', mobility: 'Addresses mobility' } as Record<string, string>)[counter] ?? `Addresses ${counter}`;
}
