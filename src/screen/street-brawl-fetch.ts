import type { AbilityOrder, EnhancedStat, ItemStat, MatchupStat, StreetBrawlData } from './street-brawl-data';

/**
 * Downloads Street Brawl item win rates, Valve's per-hero item lists and ability upgrade
 * orders from the public deadlock-api (no key; about 100 requests). Used by the app's daily
 * background refresh and by scripts/sync-street-brawl-data.mjs.
 */
export const STREET_BRAWL_API = 'https://api.deadlock-api.com';
/** Format of the download; isStreetBrawlData rejects older saved copies (their per-hero deltas were shrunk differently). */
export const STREET_BRAWL_SCHEMA = 2;
/**
 * Start of the current balance window: the 2026-09-29 "City Never Sleeps" update reworked
 * the item pool (corrupted items exist only from that date). Later minor updates and weekly
 * hero drops are inside the window. Move this forward after the next major item/balance patch.
 */
export const STREET_BRAWL_PATCH_START = Date.UTC(2026, 8, 29) / 1000;
const DAY = 86_400;
/** A patch younger than this leaves too few games; the window then reaches back this far anyway. */
const MIN_WINDOW_DAYS = 14;
/** A stale patch date never pulls in more than this many days of games. */
const MAX_WINDOW_DAYS = 45;
/** Heroes with too little data in the patch window use this wider window for their own rows. */
const WIDE_WINDOW_DAYS = 90;
/** A hero with fewer games than this in the patch window has its per-hero rows re-read over the wide window. */
const MIN_HERO_GAMES = 8_000;
/** Ability orders covering fewer games than this are re-read over the wide window. */
const MIN_ORDER_GAMES = 400;
/** Matches of evidence that count as much as the average when smoothing all-hero and per-enemy win rates. */
const PRIOR_MATCHES = 750;
/** Hero-vs-hero samples are smaller; a matchup needs this many games before it is kept. */
const MIN_MATCHUP_GAMES = 200;
const PRIOR_MATCHUP_GAMES = 400;
/** Ability orders need this many games to be listed (the API default; 20 dropped rare but valid orders). */
const MIN_ORDER_MATCHES = 10;
/** Bounds for the estimated prior strengths (games), so a degenerate estimate cannot switch shrinkage off or make it absolute. */
const PRIOR_BOUNDS = [100, 20_000] as const;
const REQUEST_TIMEOUT_MS = 30_000;

interface ApiItem { id: number; class_name: string; name: string; type: string; shopable?: boolean; disabled?: boolean; item_tier: number; item_slot_type: string; is_active_item?: boolean }
interface ApiHero { id: number; class_name: string; name: string; hero_type?: string; gun_tag?: string; player_selectable?: boolean; item_draft_bucketing?: Record<string, { bucket?: string }> }
interface ItemRow { item_id: number; bucket?: number; wins: number; matches: number }
interface OrderRow { abilities: number[]; wins: number; matches: number }
interface HeroStatRow { hero_id: number; wins: number; matches: number }
interface CounterRow { hero_id: number; enemy_hero_id: number; wins: number; matches_played: number }

export interface StreetBrawlFetchOptions {
  /** Current time in Unix seconds (default: now). */
  now?: number;
  /** Override the start of the patch window (Unix seconds). */
  since?: number;
}

/** The patch window (Unix seconds) used for every analytics request, and the wider fallback window for thin heroes. */
export function streetBrawlWindow(now = Math.floor(Date.now() / 1000), since?: number): { since: number; wideSince: number } {
  const start = since ?? Math.min(now - MIN_WINDOW_DAYS * DAY, Math.max(now - MAX_WINDOW_DAYS * DAY, STREET_BRAWL_PATCH_START));
  return { since: Math.floor(start), wideSince: Math.floor(Math.min(start, now - WIDE_WINDOW_DAYS * DAY)) };
}

function heroResult(row: HeroStatRow | undefined): { winRate?: number; matches?: number } {
  return row && row.matches > 0 ? { winRate: Math.round(row.wins / row.matches * 1_000) / 1_000, matches: row.matches } : {};
}
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const clampPrior = (value: number) => Math.round(Math.max(PRIOR_BOUNDS[0], Math.min(PRIOR_BOUNDS[1], value)));

/**
 * Empirical-Bayes prior strength (in games) from method of moments: the spread of observed
 * effects is true spread plus binomial noise, so true variance = observed variance minus
 * the mean sampling variance, and a mean win rate p is worth p(1-p)/variance games.
 * `samples` are (effect, sampling variance) pairs.
 */
export function estimatePriorGames(samples: readonly { effect: number; noise: number }[], fallback: number): number {
  if (samples.length < 20) return fallback;
  const mean = samples.reduce((sum, sample) => sum + sample.effect, 0) / samples.length;
  const spread = samples.reduce((sum, sample) => sum + (sample.effect - mean) ** 2, 0) / (samples.length - 1);
  const noise = samples.reduce((sum, sample) => sum + sample.noise, 0) / samples.length;
  const signal = spread - noise;
  return signal > 0 ? clampPrior(0.25 / signal) : PRIOR_BOUNDS[1];
}

export async function fetchStreetBrawlData(abilitySlots: ReadonlyMap<string, number>,
  fetchJson: (url: string) => Promise<unknown> = async url => {
    // A hung request would otherwise block every later refresh until the app restarts.
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }, options: StreetBrawlFetchOptions = {}): Promise<StreetBrawlData> {
  const window = streetBrawlWindow(options.now ?? Math.floor(Date.now() / 1000), options.since);
  const get = <T>(path: string) => fetchJson(`${STREET_BRAWL_API}${path}`) as Promise<T>;
  const mode = (since = window.since) => `game_mode=street_brawl&min_unix_timestamp=${since}`;
  const list = <T>(value: unknown) => (Array.isArray(value) ? value : []) as T[];
  const [items, allHeroes, global, perHero, heroStats, counters, enhancedOnly, enhancedNone] = await Promise.all([
    get<ApiItem[]>('/v1/assets/items?language=english'),
    get<ApiHero[]>('/v1/assets/heroes?only_active=true&language=english'),
    get<ItemRow[]>(`/v1/analytics/item-stats?${mode()}`),
    get<ItemRow[]>(`/v1/analytics/item-stats?${mode()}&bucket=hero`),
    // Hero results and Enhanced results are optional extras: an older API or an outage must not cost the item data.
    get<HeroStatRow[]>(`/v1/analytics/hero-stats?${mode()}`).catch(() => [] as HeroStatRow[]),
    get<CounterRow[]>(`/v1/analytics/hero-counter-stats?${mode()}`).catch(() => [] as CounterRow[]),
    get<ItemRow[]>(`/v1/analytics/item-stats?${mode()}&enhanced_items=only`).catch(() => [] as ItemRow[]),
    get<ItemRow[]>(`/v1/analytics/item-stats?${mode()}&enhanced_items=exclude`).catch(() => [] as ItemRow[]),
  ]);
  const heroes = allHeroes.filter(hero => hero.player_selectable !== false);
  const draftable = items.filter(item => item.type === 'upgrade' && item.shopable && !item.disabled);
  const byId = new Map(draftable.map(item => [item.id, item]));
  const usableRows = (rows: ItemRow[]) => list<ItemRow>(rows).filter(row => byId.has(row.item_id) && row.matches > 0);
  const baseOf = (rows: ItemRow[]) => {
    const wins = rows.reduce((sum, row) => sum + row.wins, 0), matches = rows.reduce((sum, row) => sum + row.matches, 0);
    return matches ? wins / matches : 0.5;
  };
  /** Win-rate points vs. the group average, smoothed toward that average (all-hero and per-enemy results). */
  const deltas = (rows: ItemRow[]) => {
    const usable = usableRows(rows);
    const base = baseOf(usable);
    const result: Record<string, ItemStat> = {};
    for (const row of usable) {
      const smoothed = (row.wins + PRIOR_MATCHES * base) / (row.matches + PRIOR_MATCHES);
      result[byId.get(row.item_id)!.class_name] = { delta: round4(smoothed - base), winRate: Math.round(row.wins / row.matches * 1_000) / 1_000, matches: row.matches };
    }
    return result;
  };
  /** Raw win-rate points vs. this hero's average item; streetBrawlFit shrinks them toward the all-hero result. */
  const rawDeltas = (rows: ItemRow[]) => {
    const usable = usableRows(rows);
    const base = baseOf(usable);
    const result: Record<string, ItemStat> = {};
    for (const row of usable) {
      result[byId.get(row.item_id)!.class_name] = { delta: round4(row.wins / row.matches - base), winRate: Math.round(row.wins / row.matches * 1_000) / 1_000, matches: row.matches };
    }
    return result;
  };
  const classOf = new Map(heroes.map(hero => [hero.id, hero.class_name]));
  const ownStats = new Map(list<HeroStatRow>(heroStats).map(row => [row.hero_id, row]));
  const matchups = new Map<number, Record<string, MatchupStat>>();
  for (const row of list<CounterRow>(counters)) {
    const enemy = classOf.get(row.enemy_hero_id); const own = ownStats.get(row.hero_id);
    if (!enemy || !classOf.has(row.hero_id) || !(row.matches_played >= MIN_MATCHUP_GAMES)) continue;
    const base = own && own.matches > 0 ? own.wins / own.matches : 0.5;
    const smoothed = (row.wins + PRIOR_MATCHUP_GAMES * base) / (row.matches_played + PRIOR_MATCHUP_GAMES);
    const record = matchups.get(row.hero_id) ?? {};
    record[enemy] = { delta: round4(smoothed - base), winRate: Math.round(row.wins / row.matches_played * 1_000) / 1_000, matches: row.matches_played };
    matchups.set(row.hero_id, record);
  }
  const heroRows = new Map<number, ItemRow[]>();
  for (const row of list<ItemRow>(perHero)) heroRows.set(row.bucket ?? -1, [...(heroRows.get(row.bucket ?? -1) ?? []), row]);
  const orderRows = (rows: OrderRow[]) => list<OrderRow>(rows)
    .filter(row => Array.isArray(row.abilities) && row.abilities.length > 0 && row.matches > 0)
    .map(row => ({ order: row.abilities.map(id => abilitySlots.get(String(id)) ?? '?').join(''), wins: row.wins, matches: row.matches }))
    .filter(row => row.order.length > 0 && !row.order.includes('?'));
  const orderGames = (rows: AbilityOrder[]) => rows.reduce((sum, row) => sum + row.matches, 0);
  // Sequential per-hero requests stay well inside the API's 200 requests/minute.
  const versus = new Map<number, Record<string, ItemStat>>();
  const orders = new Map<number, AbilityOrder[]>();
  const wide = new Set<number>();
  for (const hero of heroes) {
    // A thin hero (new, or rarely played) reads its own rows over the wider window.
    // Without hero results (an outage) every hero keeps the patch window.
    const thin = ownStats.size > 0 && (ownStats.get(hero.id)?.matches ?? 0) < MIN_HERO_GAMES;
    if (thin) {
      wide.add(hero.id);
      heroRows.set(hero.id, list<ItemRow>(await get<ItemRow[]>(`/v1/analytics/item-stats?${mode(window.wideSince)}&hero_id=${hero.id}`).catch(() => heroRows.get(hero.id) ?? [])));
    }
    // Per-enemy rows stay in the patch window even for a thin hero: counterResidual compares them
    // with the all-hero result, which is read over the patch window (its smoothing absorbs small samples).
    versus.set(hero.id, deltas(await get<ItemRow[]>(`/v1/analytics/item-stats?${mode()}&enemy_hero_ids=${hero.id}`)));
    let heroOrders = orderRows(await get<OrderRow[]>(`/v1/analytics/ability-order-stats?hero_id=${hero.id}&${mode(thin ? window.wideSince : window.since)}&min_matches=${MIN_ORDER_MATCHES}`));
    if (!thin && orderGames(heroOrders) < MIN_ORDER_GAMES) {
      const wider = orderRows(await get<OrderRow[]>(`/v1/analytics/ability-order-stats?hero_id=${hero.id}&${mode(window.wideSince)}&min_matches=${MIN_ORDER_MATCHES}`).catch(() => []));
      if (orderGames(wider) > orderGames(heroOrders)) { heroOrders = wider; wide.add(hero.id); }
    }
    orders.set(hero.id, heroOrders);
  }

  const globalItemStats = deltas(global);
  const heroItemStats = new Map(heroes.map(hero => [hero.id, rawDeltas(heroRows.get(hero.id) ?? [])]));
  const draftableNames = new Set(draftable.map(item => item.class_name));
  const goodOf = (hero: ApiHero) => Object.entries(hero.item_draft_bucketing ?? {}).filter(([, value]) => value?.bucket === 'Good').map(([className]) => className)
    .filter(className => draftableNames.has(className)).sort();
  // How far one hero's result for an item departs from the all-hero result (beyond sampling noise)
  // sets how strongly per-hero results are pulled toward it; Valve's Good list shifts the starting point.
  const residuals: { effect: number; noise: number; good: boolean; matches: number }[] = [];
  for (const hero of heroes) {
    const good = new Set(goodOf(hero));
    for (const [itemId, stat] of Object.entries(heroItemStats.get(hero.id)!)) {
      const general = globalItemStats[itemId];
      if (!general) continue;
      const p = Math.min(0.99, Math.max(0.01, stat.winRate));
      residuals.push({ effect: stat.delta - general.delta, noise: p * (1 - p) / stat.matches, good: good.has(itemId), matches: stat.matches });
    }
  }
  const weightedMean = (rows: typeof residuals) => {
    const weight = rows.reduce((sum, row) => sum + row.matches, 0);
    return weight ? rows.reduce((sum, row) => sum + row.effect * row.matches, 0) / weight : 0;
  };
  const goodRows = residuals.filter(row => row.good), otherRows = residuals.filter(row => !row.good);
  const goodPrior = goodRows.length >= 20 && otherRows.length >= 20 ? round4(weightedMean(goodRows) - weightedMean(otherRows)) : 0;
  const heroPriorMatches = estimatePriorGames(residuals.filter(row => row.matches >= 100)
    .map(row => ({ effect: row.effect - (row.good ? goodPrior : 0), noise: row.noise })), 1_500);

  const enhanced = enhancedStats(usableRows(enhancedOnly), usableRows(enhancedNone), id => byId.get(id)!.class_name);
  return {
    schemaVersion: STREET_BRAWL_SCHEMA,
    source: `${STREET_BRAWL_API} (game_mode=street_brawl, games since ${new Date(window.since * 1000).toISOString().slice(0, 10)})`,
    fetchedAt: new Date().toISOString(), priorMatches: PRIOR_MATCHES,
    window: { since: new Date(window.since * 1000).toISOString(), wideSince: new Date(window.wideSince * 1000).toISOString() },
    heroPriorMatches, goodPrior,
    ...(enhanced ? { enhanced } : {}),
    items: Object.fromEntries(draftable.map(item => [item.class_name, { id: item.id, name: item.name, tier: item.item_tier, slot: item.item_slot_type, active: !!item.is_active_item }])),
    globalItemStats,
    heroes: Object.fromEntries(heroes.map(hero => [hero.class_name, {
      id: hero.id, name: hero.name, type: hero.hero_type ?? null, gun: hero.gun_tag ?? null,
      good: goodOf(hero),
      itemStats: heroItemStats.get(hero.id) ?? {},
      versusItemStats: versus.get(hero.id) ?? {},
      abilityOrders: orders.get(hero.id) ?? [],
      ...heroResult(ownStats.get(hero.id)),
      matchups: matchups.get(hero.id) ?? {},
      ...(wide.has(hero.id) ? { wideWindow: true } : {}),
    }])),
  };
}

/**
 * Enhanced cards keep the item's id, so the API reports them separately (`enhanced_items=only`
 * vs. `exclude`). The uplift is the Enhanced version's win rate minus the plain item's, shrunk
 * toward the mean uplift over all items by an estimated prior. Share is the fraction of drafted
 * copies that were Enhanced (players favour Enhanced cards, so it is an upper bound on how
 * often a random card is Enhanced).
 */
export function enhancedStats(only: readonly ItemRow[], none: readonly ItemRow[], className: (id: number) => string): StreetBrawlData['enhanced'] | null {
  const plain = new Map(none.map(row => [row.item_id, row]));
  const pairs = only.filter(row => row.matches > 0 && (plain.get(row.item_id)?.matches ?? 0) > 0)
    .map(row => ({ row, plain: plain.get(row.item_id)! }))
    .map(({ row, plain }) => {
      const enhancedRate = row.wins / row.matches, plainRate = plain.wins / plain.matches;
      const clamp = (p: number) => Math.min(0.99, Math.max(0.01, p));
      return { row, uplift: enhancedRate - plainRate, noise: clamp(enhancedRate) * (1 - clamp(enhancedRate)) / row.matches + clamp(plainRate) * (1 - clamp(plainRate)) / plain.matches };
    });
  if (pairs.length < 20) return null;
  const enhancedGames = pairs.reduce((sum, pair) => sum + pair.row.matches, 0);
  const plainGames = none.reduce((sum, row) => sum + row.matches, 0);
  const meanUplift = pairs.reduce((sum, pair) => sum + pair.uplift * pair.row.matches, 0) / enhancedGames;
  const priorMatches = estimatePriorGames(pairs.map(pair => ({ effect: pair.uplift, noise: pair.noise })), 3_000);
  const items: Record<string, EnhancedStat> = {};
  for (const { row, uplift } of pairs) {
    items[className(row.item_id)] = { uplift: round4((uplift * row.matches + meanUplift * priorMatches) / (row.matches + priorMatches)),
      winRate: Math.round(row.wins / row.matches * 1_000) / 1_000, matches: row.matches };
  }
  return { share: round4(enhancedGames / (enhancedGames + plainGames)), meanUplift: round4(meanUplift), priorMatches, items };
}
