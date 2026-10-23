import type { CatalogHero, CatalogItem } from './types';

export type DamageKind = 'spirit' | 'gun' | 'melee';
/** What the enemy team brings, from the heroes and the items read on their scoreboard rows. */
export interface EnemyThreat {
  /** Share of the enemy damage by kind, whole percent (sums to 100); null when nothing points to a damage kind. */
  damage: Record<DamageKind, number> | null;
  /** The damage kind that clearly leads, or 'mixed'. */
  lead: DamageKind | 'mixed' | null;
  /** Healing heroes plus healing and lifesteal items. */
  healing: number;
  /** Crowd-control items (nearly every hero kit has some control, so kits are not counted). */
  control: number;
  heavyHealing: boolean;
  heavyControl: boolean;
  /** One decisive line: what to take first, and what to grab when a draft offers it. */
  priority: string;
  heroes: number;
  items: number;
}

/** A hero kit weighs as much as this many damage items. */
const HERO_DAMAGE_WEIGHT = 2;
/** A damage kind with at least this share of the enemy damage leads it. */
const LEAD_SHARE = 0.5;
/** Melee leads from a lower share: its resist is the only answer to it. */
const MELEE_LEAD_SHARE = 0.4;
const HEAVY_HEALING = 4;
const HEAVY_CONTROL = 3;
const RESIST_FIRST: Record<DamageKind | 'mixed', string> = {
  spirit: 'Spirit resist first', gun: 'Bullet resist first', melee: 'Melee resist first', mixed: 'Mixed damage: health first',
};

/**
 * Enemy threat summary: their damage mix (spirit, gun, melee), healing and crowd control, and what
 * to prioritise against it. Pure: hero kits come from catalogue tags, builds from the items read.
 */
export function enemyThreat(heroes: readonly CatalogHero[], items: readonly CatalogItem[]): EnemyThreat | null {
  if (!heroes.length && !items.length) return null;
  const tagged = (tags: readonly string[]) => new Set(tags.map((tag) => tag.trim().toLowerCase().replace(/[ _]/g, '-')));
  const weight: Record<DamageKind, number> = { spirit: 0, gun: 0, melee: 0 };
  let healing = 0; let control = 0;
  for (const hero of heroes) {
    const tags = tagged(hero.tags);
    const kinds = ([['spirit', 'spirit'], ['gun', 'weapon'], ['melee', 'melee']] as const).filter(([, tag]) => tags.has(tag)).map(([kind]) => kind);
    for (const kind of kinds) weight[kind] += HERO_DAMAGE_WEIGHT / kinds.length;
    if (tags.has('healing')) healing++;
  }
  for (const item of items) {
    const tags = tagged(item.tags);
    if (tags.has('melee')) weight.melee += 1;
    else if (item.category === 'weapon') weight.gun += 1;
    else if (item.category === 'spirit') weight.spirit += 1;
    if (tags.has('healing') || tags.has('bullet-lifesteal') || tags.has('spirit-lifesteal')) healing++;
    if (tags.has('crowd-control')) control++;
  }
  const total = weight.spirit + weight.gun + weight.melee;
  let damage: Record<DamageKind, number> | null = null;
  let lead: DamageKind | 'mixed' | null = null;
  if (total > 0) {
    // Largest-remainder rounding: whole percents that always sum to exactly 100.
    const kinds = ['spirit', 'gun', 'melee'] as const;
    const exact = kinds.map((kind) => weight[kind] / total * 100);
    const whole = exact.map(Math.floor);
    const order = kinds.map((_, index) => index).sort((a, b) => (exact[b]! - whole[b]!) - (exact[a]! - whole[a]!) || a - b);
    for (let left = 100 - whole.reduce((sum, value) => sum + value, 0), index = 0; left > 0; left--, index++) whole[order[index]!]!++;
    damage = { spirit: whole[0]!, gun: whole[1]!, melee: whole[2]! };
    const share = (kind: DamageKind) => weight[kind] / total;
    const top = (['spirit', 'gun', 'melee'] as const).slice().sort((a, b) => weight[b] - weight[a])[0]!;
    lead = share(top) >= (top === 'melee' ? MELEE_LEAD_SHARE : LEAD_SHARE) ? top : 'mixed';
  }
  const heavyHealing = healing >= HEAVY_HEALING;
  const heavyControl = control >= HEAVY_CONTROL;
  const clauses = [lead ? RESIST_FIRST[lead] : 'Health first', ...(heavyHealing ? ['anti-heal if offered'] : []), ...(heavyControl ? ['debuff remover if offered'] : [])];
  return { damage, lead, healing, control, heavyHealing, heavyControl, priority: `${clauses.join('; ')}.`, heroes: heroes.length, items: items.length };
}
