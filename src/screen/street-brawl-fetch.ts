import type { AbilityOrder, ItemStat, StreetBrawlData } from './street-brawl-data';

/**
 * Downloads Street Brawl item win rates, Valve's per-hero item lists and ability upgrade
 * orders from the public deadlock-api (no key; about 80 requests). Used by the app's daily
 * background refresh and by scripts/sync-street-brawl-data.mjs.
 */
export const STREET_BRAWL_API = 'https://api.deadlock-api.com';
/** Matches of evidence that count as much as the average when smoothing win rates. */
const PRIOR_MATCHES = 750;
const REQUEST_TIMEOUT_MS = 20_000;

interface ApiItem { id: number; class_name: string; name: string; type: string; shopable?: boolean; disabled?: boolean; item_tier: number; item_slot_type: string; is_active_item?: boolean }
interface ApiHero { id: number; class_name: string; name: string; hero_type?: string; gun_tag?: string; player_selectable?: boolean; item_draft_bucketing?: Record<string, { bucket?: string }> }
interface ItemRow { item_id: number; bucket?: number; wins: number; matches: number }
interface OrderRow { abilities: number[]; wins: number; matches: number }

export async function fetchStreetBrawlData(abilitySlots: ReadonlyMap<string, number>,
  fetchJson: (url: string) => Promise<unknown> = async url => {
    // A hung request would otherwise block every later refresh until the app restarts.
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }): Promise<StreetBrawlData> {
  const get = <T>(path: string) => fetchJson(`${STREET_BRAWL_API}${path}`) as Promise<T>;
  const [items, allHeroes, global, perHero] = await Promise.all([
    get<ApiItem[]>('/v1/assets/items?language=english'),
    get<ApiHero[]>('/v1/assets/heroes?only_active=true&language=english'),
    get<ItemRow[]>('/v1/analytics/item-stats?game_mode=street_brawl'),
    get<ItemRow[]>('/v1/analytics/item-stats?game_mode=street_brawl&bucket=hero'),
  ]);
  const heroes = allHeroes.filter(hero => hero.player_selectable !== false);
  const draftable = items.filter(item => item.type === 'upgrade' && item.shopable && !item.disabled);
  const byId = new Map(draftable.map(item => [item.id, item]));
  const deltas = (rows: ItemRow[]) => {
    const usable = rows.filter(row => byId.has(row.item_id) && row.matches > 0);
    const wins = usable.reduce((sum, row) => sum + row.wins, 0);
    const matches = usable.reduce((sum, row) => sum + row.matches, 0);
    const base = matches ? wins / matches : 0.5;
    const result: Record<string, ItemStat> = {};
    for (const row of usable) {
      const smoothed = (row.wins + PRIOR_MATCHES * base) / (row.matches + PRIOR_MATCHES);
      result[byId.get(row.item_id)!.class_name] = { delta: Math.round((smoothed - base) * 10_000) / 10_000,
        winRate: Math.round(row.wins / row.matches * 1_000) / 1_000, matches: row.matches };
    }
    return result;
  };
  const heroRows = new Map<number, ItemRow[]>();
  for (const row of perHero) heroRows.set(row.bucket ?? -1, [...(heroRows.get(row.bucket ?? -1) ?? []), row]);
  // Sequential per-hero requests stay well inside the API's 200 requests/minute.
  const versus = new Map<number, Record<string, ItemStat>>();
  const orders = new Map<number, AbilityOrder[]>();
  for (const hero of heroes) {
    versus.set(hero.id, deltas(await get<ItemRow[]>(`/v1/analytics/item-stats?game_mode=street_brawl&enemy_hero_ids=${hero.id}`)));
    const rows = await get<OrderRow[]>(`/v1/analytics/ability-order-stats?hero_id=${hero.id}&game_mode=street_brawl&min_matches=20`);
    orders.set(hero.id, rows.map(row => ({ order: row.abilities.map(id => abilitySlots.get(String(id)) ?? '?').join(''), wins: row.wins, matches: row.matches }))
      .filter(row => !row.order.includes('?')));
  }
  return {
    source: `${STREET_BRAWL_API} (game_mode=street_brawl)`, fetchedAt: new Date().toISOString(), priorMatches: PRIOR_MATCHES,
    items: Object.fromEntries(draftable.map(item => [item.class_name, { id: item.id, name: item.name, tier: item.item_tier, slot: item.item_slot_type, active: !!item.is_active_item }])),
    globalItemStats: deltas(global),
    heroes: Object.fromEntries(heroes.map(hero => [hero.class_name, {
      id: hero.id, name: hero.name, type: hero.hero_type ?? null, gun: hero.gun_tag ?? null,
      good: Object.entries(hero.item_draft_bucketing ?? {}).filter(([, value]) => value?.bucket === 'Good').map(([className]) => className)
        .filter(className => draftable.some(item => item.class_name === className)).sort(),
      itemStats: deltas(heroRows.get(hero.id) ?? []),
      versusItemStats: versus.get(hero.id) ?? {},
      abilityOrders: orders.get(hero.id) ?? [],
    }])),
  };
}
