import type { Catalog, CatalogHero, CatalogItem } from '../shared/types';
import abilityLabels from './ability-labels.json';

export interface AbilityLabel { id: string; heroId: string; slot: number; name: string }

/** Fast id lookups for one catalogue; built once per catalogue object. */
export interface CatalogIndex {
  item(id: string | null | undefined): CatalogItem | undefined;
  hero(id: string | null | undefined): CatalogHero | undefined;
  /** The four signature abilities of a hero, ordered by slot. */
  abilities(heroId: string | null | undefined): AbilityLabel[];
}

const byHero = new Map<string, AbilityLabel[]>();
for (const ability of abilityLabels.abilities as AbilityLabel[]) {
  const list = byHero.get(ability.heroId) ?? [];
  list.push(ability);
  byHero.set(ability.heroId, list);
}
for (const list of byHero.values()) list.sort((a, b) => a.slot - b.slot);

const indexes = new WeakMap<Catalog, CatalogIndex>();

export function indexCatalog(catalog: Catalog): CatalogIndex {
  const cached = indexes.get(catalog);
  if (cached) return cached;
  const items = new Map<string, CatalogItem>();
  for (const item of catalog.items) { items.set(item.id, item); if (item.numericId) items.set(item.numericId, item); }
  const heroes = new Map<string, CatalogHero>();
  for (const hero of catalog.heroes) { heroes.set(hero.id, hero); if (hero.numericId) heroes.set(hero.numericId, hero); }
  const index: CatalogIndex = {
    item: (id) => (id == null ? undefined : items.get(id)),
    hero: (id) => (id == null ? undefined : heroes.get(id)),
    abilities: (heroId) => {
      const hero = heroId == null ? undefined : heroes.get(heroId);
      return hero ? byHero.get(hero.id) ?? [] : [];
    },
  };
  indexes.set(catalog, index);
  return index;
}

/*
 * Local game art. The packaged app serves these from companion://app/…, and the Vite dev
 * server maps the same root-relative paths to the cached assets, so one URL works in both.
 */
export const itemIconUrl = (id: string) => `/item-icons/${encodeURIComponent(id)}.png`;
export const heroArtUrl = (id: string, variant: 'small' | 'card' | 'vertical') => `/context-icons/heroes/${encodeURIComponent(id)}--${variant}.png`;
export const abilityIconUrl = (id: string) => `/context-icons/abilities/${encodeURIComponent(id)}.png`;
export const glyphUrl = (name: 'ap-icon' | 'ability-pip' | 'ability-pip-empty') => `/context-icons/glyphs/${name}.png`;

export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export const POSITION_NAMES = ['Left', 'Middle', 'Right'];
