import { randomUUID } from 'node:crypto';
import type {
  Capability, MatchContext, Observation, PlayerState, PurchasedItemHistoryEntry,
  SourceState, TelemetryEvent,
} from '../src/shared/types';

export const DEADLOCK_GAME_ID = 24482;
export const REQUIRED_FEATURES = ['gep_internal', 'game_info', 'match_info'] as const;
const PROVIDER = 'Overwolf Electron GEP';
const RETRY_DELAYS = [500, 1000, 2000, 4000];
type Listener = (...args: unknown[]) => void;
interface EventSource {
  on(name: string, listener: Listener): unknown;
  removeListener(name: string, listener: Listener): unknown;
}
interface Gep extends EventSource {
  setRequiredFeatures(gameId: number, features: string[] | undefined): Promise<void>;
  getInfo(gameId: number): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function decodedRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value);
  if (value.length > 131_072) return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}

function text(value: unknown, maximum = 128): string | null {
  if (typeof value !== 'string' || value.length > maximum) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim() || null;
}

function numericId(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{1,24}$/.test(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function steamId(value: unknown): string | null {
  // Steam's 64-bit identifiers must not pass through an imprecise JS number.
  return typeof value === 'string' && /^\d{1,24}$/.test(value) ? value : null;
}

function wholeNumber(value: unknown, maximum = 1_000_000): number | null {
  const converted = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : value;
  return typeof converted === 'number' && Number.isSafeInteger(converted) && converted >= 0 && converted <= maximum
    ? converted : null;
}

export function providerCapabilities(available = true): Capability[] {
  return [
    { name: 'participant_match', supported: available, verified: false, detail: 'Documented local match ID and seat-keyed roster; real participant coverage and Street Brawl mode token remain unverified.' },
    { name: 'street_brawl_round', supported: false, verified: false, detail: 'No published round, draft stage, round phase, or current deadline contract.' },
    { name: 'own_draft_offers', supported: false, verified: false, detail: 'Unselected offers and ordered bundles are not documented GEP fields.' },
    { name: 'offer_modifiers', supported: false, verified: false, detail: 'Purchased-item enhancement flags do not describe current offer bundles or decode modifier bits.' },
    { name: 'own_reroll_state', supported: false, verified: false, detail: 'Remaining rerolls and legal replacement semantics are undocumented.' },
    { name: 'current_inventories', supported: false, verified: false, detail: 'Purchased-item history has no documented current ownership/removal/completeness semantics.' },
    { name: 'purchased_items', supported: available, verified: false, detail: 'Published items_N records purchased items; retained separately from current inventory.' },
    { name: 'ability_investment', supported: false, verified: false, detail: 'Hero level and limited ultimate flags are not exact ability investment.' },
    { name: 'corruption_decision', supported: false, verified: false, detail: 'No documented runtime corruption eligibility or positive/negative effects contract.' },
    { name: 'source_continuity', supported: false, verified: false, detail: 'No published upstream sequence, mapped game-origin clock, or bounded delivery guarantee.' },
  ];
}

/** Only the GEP contract's explicit Normal example is mapped. Other API mode enums do not apply. */
export function mapDeadlockMode(value: unknown): 'normal' | 'unknown' {
  return decodedRecord(value)?.game_mode === 'Normal' ? 'normal' : 'unknown';
}

export function parseDeadlockRoster(seat: number, input: unknown, observation: Observation): PlayerState | null {
  if (!Number.isSafeInteger(seat) || seat < 0 || seat > 11) return null;
  const value = decodedRecord(input);
  if (!value) return null;
  const providerTeam = wholeNumber(value.team_id, 3);
  if (providerTeam !== 2 && providerTeam !== 3) return null;
  return {
    seat, team: providerTeam === 2 ? 0 : 1,
    heroId: numericId(value.hero_id), heroName: text(value.hero_name),
    playerName: text(value.player_name), steamId: steamId(value.steam_id),
    isLocal: value.is_local === true,
    inventory: [], inventoryCompleteness: 'unknown', inventoryRevision: 0,
    abilities: [], abilityCompleteness: 'unknown', abilityRevision: 0,
    observation,
  };
}

export function parsePurchasedHistory(input: unknown): PurchasedItemHistoryEntry[] | null {
  const value = decodedRecord(input);
  if (!value || !Array.isArray(value.items) || value.items.length > 256) return null;
  const result: PurchasedItemHistoryEntry[] = [];
  for (const raw of value.items) {
    const item = record(raw);
    const itemId = item && numericId(item.id);
    if (!item || itemId === null) return null;
    const className = text(item.class_name);
    const name = text(item.name);
    const rawBits = numericId(item.upgrade_info);
    result.push({
      itemId, gameTime: null,
      ...(className ? { className } : {}), ...(name ? { name } : {}),
      enhanced: typeof item.enhanced === 'boolean' ? item.enhanced : null,
      upgradeBits: rawBits,
    });
  }
  return result;
}

function emitter(value: unknown): EventSource | null {
  const candidate = record(value);
  return candidate && typeof candidate.on === 'function' && typeof candidate.removeListener === 'function'
    ? candidate as unknown as EventSource : null;
}

function packageManager(app: unknown): (EventSource & { gep?: Gep }) | null {
  try {
    const manager = record(record(record(app)?.overwolf)?.packages);
    return emitter(manager) as (EventSource & { gep?: Gep }) | null;
  } catch { return null; }
}

function gepPackage(manager: unknown): Gep | null {
  try {
    const candidate = record(record(manager)?.gep);
    return emitter(candidate) && typeof candidate?.setRequiredFeatures === 'function' && typeof candidate?.getInfo === 'function'
      ? candidate as unknown as Gep : null;
  } catch { return null; }
}

/**
 * Uses only app.overwolf.packages.gep's documented Electron methods/events.
 * No capture, process reader, Native API relay, gameplay input, or telemetry file log.
 * The app observation ordinal orders accepted callbacks; it is NOT an upstream watermark.
 */
export function startOverwolfProvider(app: unknown, onEvent: (event: TelemetryEvent) => void): { stop(): void } {
  const manager = packageManager(app);
  let stopped = false;
  let currentGep: Gep | null = null;
  let sessionId = randomUUID();
  let receiptOrdinal = 0;
  let contextGeneration = 0;
  let registrationGeneration = 0;
  let hydrationGeneration = 0;
  let registrationInFlight = false;
  let registered = false;
  let gameExited = false;
  let recoveryAttempts = 0;
  let runtimeVersion: string | null = null;
  let lastReceivedAt: number | null = null;
  let sourceStatus: SourceState['status'] = manager ? 'connecting' : 'unavailable';
  let matchId: string | null = null;
  let localSteamId: string | null = null;
  let mode: MatchContext['mode'] = 'unknown';
  let globalPhase = 'Init';
  let scores: [number, number] | null = null;
  let rosterScopeUnsupported = false;
  const players = new Map<number, PlayerState>();
  const purchases = new Map<number, PurchasedItemHistoryEntry[]>();
  const subscriptions: { target: EventSource; name: string; listener: Listener }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const emit = (event: TelemetryEvent) => { if (!stopped) onEvent(event); };
  function source(status: SourceState['status'], message: string): void {
    sourceStatus = status;
    if (status === 'connected' && mode === 'normal') message += ' Normal mode is outside the eight-seat Street Brawl roster scope; no roster or purchase history is promoted.';
    else if (status === 'connected' && rosterScopeUnsupported) message += ' Provider roster contains more than eight players; the entire roster is withheld without truncation.';
    emit({ type: 'source', source: {
      provider: manager ? PROVIDER : 'Ordinary Electron — no participant provider',
      sessionId, status, runtimeVersion, capabilities: providerCapabilities(currentGep !== null),
      noImageMethodVerified: false, sequence: null, sequenceKind: 'local', lastReceivedAt,
      deliveryBoundMs: null, continuity: status === 'interrupted' ? 'gap' : 'unknown', message,
    } });
  }
  function observe(): Observation {
    return { provider: PROVIDER, sessionId, sequence: ++receiptOrdinal, receivedAt: Date.now(),
      observedAt: null, clockUncertaintyMs: null, visibility: 'unknown', changedAt: null, confirmedAt: null };
  }
  function reset(reason: string): void {
    contextGeneration++;
    hydrationGeneration++;
    sessionId = randomUUID();
    receiptOrdinal = 0;
    lastReceivedAt = null;
    matchId = null;
    localSteamId = null;
    mode = 'unknown';
    globalPhase = 'Init';
    scores = null;
    rosterScopeUnsupported = false;
    players.clear();
    purchases.clear();
    emit({ type: 'reset', reason, at: Date.now() });
  }
  function schedule(callback: () => void, delay: number): void {
    const timer = setTimeout(() => { timers.delete(timer); if (!stopped) callback(); }, delay);
    timers.add(timer);
  }
  function subscribe(target: EventSource, name: string, listener: Listener): void {
    target.on(name, listener);
    subscriptions.push({ target, name, listener });
  }
  function detachGep(): void {
    for (let index = subscriptions.length - 1; index >= 0; index--) {
      const subscription = subscriptions[index];
      if (subscription.target !== manager) {
        subscription.target.removeListener(subscription.name, subscription.listener);
        subscriptions.splice(index, 1);
      }
    }
    currentGep = null;
    registered = false;
    registrationInFlight = false;
    registrationGeneration++;
  }
  function withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => { timers.delete(timeout); rejectPromise(new Error('Provider timeout')); }, 8000);
      timers.add(timeout);
      promise.then((value) => { clearTimeout(timeout); timers.delete(timeout); resolvePromise(value); },
        () => { clearTimeout(timeout); timers.delete(timeout); rejectPromise(new Error('Provider request failed')); });
    });
  }
  function publishMatch(): void {
    if (!matchId) return;
    const locals = [...players.values()].filter((player) => player.isLocal);
    const local = !rosterScopeUnsupported && mode !== 'normal' && locals.length === 1 ? locals[0] : undefined;
    emit({ type: 'match', match: {
      id: matchId, mode, clientVersion: null, localSeat: local?.seat ?? null, localTeam: local?.team ?? null,
      round: null, scores, deadlineAt: null,
      // Global GameInProgress is not a Street Brawl draft/combat boundary.
      phase: globalPhase === 'PostGame' ? 'finished' : mode === 'normal' && globalPhase === 'GameInProgress' ? 'combat' : 'waiting',
      observation: observe(),
    } });
  }
  function publishPlayers(): void {
    if (!matchId || players.size === 0 || rosterScopeUnsupported || mode === 'normal') return;
    if ([...players.values()].filter((player) => player.isLocal).length > 1) {
      reset('Provider hydration reported more than one local player.');
      source('interrupted', 'Local identity is ambiguous. The entire match state was cleared; waiting for a fresh provider identity.');
      return;
    }
    emit({ type: 'roster', matchId, players: [...players.values()], complete: false, observation: observe() });
  }
  function publishPurchases(seat: number): void {
    if (!matchId || !players.has(seat) || !purchases.has(seat) || rosterScopeUnsupported || mode === 'normal') return;
    emit({ type: 'purchases', matchId, seat, items: purchases.get(seat)!, complete: false, observation: observe() });
  }
  function withholdRosterScope(): void {
    const identity = matchId;
    const reportedMode = mode;
    const reportedPhase = globalPhase;
    const reportedScores = scores;
    reset('Provider roster contains more than eight players. The previous roster was cleared.');
    matchId = identity;
    mode = reportedMode;
    globalPhase = reportedPhase;
    scores = reportedScores;
    rosterScopeUnsupported = true;
    source('connected', 'Only documented match metadata is retained. The roster exceeds the eight-player Street Brawl scope.');
  }
  function applyInfo(feature: string, key: string, value: unknown, hydrating = false): boolean {
    if (feature === 'gep_internal' && (key === 'version_info' || key === 'gep_internal')) {
      const versions = decodedRecord(value);
      const version = versions && text(versions.local_version, 48);
      if (version && /^[\d.]+$/.test(version)) runtimeVersion = version;
      return version !== null;
    }
    if (feature === 'match_info' && key === 'match_id') {
      const id = numericId(value);
      if (!id || id === '0') return false;
      if (matchId !== id) {
        const previousMatch = matchId;
        reset(previousMatch ? 'The provider reported a different match.' : 'A match identity was received.');
        matchId = id;
        source('connected', 'Documented match telemetry is available. Own offers, current inventories, and exact ability ranks are unavailable; source age is unknown.');
      }
      if (!hydrating) publishMatch();
      return true;
    }
    if (feature === 'game_info' && key === 'game_mode') {
      const valueRecord = decodedRecord(value);
      if (!valueRecord || typeof valueRecord.game_mode !== 'string') return false;
      const nextMode = mapDeadlockMode(valueRecord);
      if (matchId && mode !== nextMode && mode !== 'unknown' && !hydrating) {
        reset('The provider reported a different game mode.');
        source('connecting', 'Game mode changed; waiting for validated match hydration.');
        mode = nextMode;
        void hydrate();
      } else {
        mode = nextMode;
        if (mode === 'normal') { players.clear(); purchases.clear(); }
        if (!hydrating) publishMatch();
      }
      return true;
    }
    if (feature === 'game_info' && key === 'phase') {
      if (typeof value !== 'string' || !['Init', 'WaitingForPlayersToJoin', 'PreGameWait', 'GameInProgress', 'PostGame'].includes(value)) return false;
      if (matchId && (value === 'Init' || value === 'WaitingForPlayersToJoin') && !hydrating) {
        reset('The game returned to its waiting phase.');
        source('connected', 'Waiting for a documented current match identity.');
      }
      globalPhase = value;
      if (!hydrating) publishMatch();
      return true;
    }
    if (feature === 'game_info' && key === 'steam_id') {
      const identity = steamId(value);
      if (!identity) return false;
      if (localSteamId && identity !== localSteamId && !hydrating) {
        reset('The provider reported a different local player.');
        source('connecting', 'Local identity changed; waiting for validated match hydration.');
        void hydrate();
      }
      localSteamId = identity;
      return true;
    }
    if (!matchId || feature !== 'match_info') return false;
    if (key === 'team_score') {
      const values = decodedRecord(value);
      const amber = values && wholeNumber(values.amber);
      const sapphire = values && wholeNumber(values.sapphire);
      if (amber === null || sapphire === null) return false;
      scores = [amber, sapphire];
      if (!hydrating) publishMatch();
      return true;
    }
    if (key === 'match_outcome') {
      const outcome = decodedRecord(value)?.winning_team;
      if (outcome !== 'AMBER' && outcome !== 'SAPPHIRE') return false;
      globalPhase = 'PostGame';
      if (!hydrating) publishMatch();
      return true;
    }
    const rosterSeat = /^roster_(\d{1,2})$/.exec(key);
    if (rosterSeat) {
      const seat = Number(rosterSeat[1]);
      const player = parseDeadlockRoster(seat, value, observe());
      if (!player) return false;
      if (mode === 'normal' || rosterScopeUnsupported) return true;
      if (players.size >= 8 && !players.has(seat)) {
        withholdRosterScope();
        if (!hydrating) publishMatch();
        return true;
      }
      const previousLocal = [...players.values()].find((entry) => entry.isLocal);
      const currentSeat = players.get(seat);
      const changedLocal = (player.isLocal && previousLocal && previousLocal.seat !== seat)
        || (currentSeat?.isLocal && (!player.isLocal || (currentSeat.steamId !== null && player.steamId !== currentSeat.steamId)));
      if (changedLocal && !hydrating) {
        reset('The provider reported a different local seat.');
        source('connecting', 'Local seat changed; waiting for validated match hydration.');
        void hydrate();
        return false;
      }
      players.set(seat, player);
      if (!hydrating) { publishMatch(); publishPlayers(); publishPurchases(seat); }
      return true;
    }
    const itemSeat = /^items_(\d{1,2})$/.exec(key);
    if (itemSeat) {
      const seat = Number(itemSeat[1]);
      const history = parsePurchasedHistory(value);
      if (seat > 11 || history === null) return false;
      if (mode === 'normal' || rosterScopeUnsupported) return true;
      purchases.set(seat, history);
      if (!hydrating) publishPurchases(seat);
      return true;
    }
    return false;
  }
  async function hydrate(): Promise<void> {
    const gep = currentGep;
    if (!gep || !registered || stopped) return;
    const hydration = ++hydrationGeneration;
    const generation = contextGeneration;
    try {
      const result = await withTimeout(gep.getInfo(DEADLOCK_GAME_ID));
      if (stopped || currentGep !== gep || hydration !== hydrationGeneration || generation !== contextGeneration) return;
      const outer = decodedRecord(result);
      const info = outer && (decodedRecord(outer.info) ?? outer);
      if (!info) return;
      const match = decodedRecord(info.match_info);
      const game = decodedRecord(info.game_info);
      const internal = decodedRecord(info.gep_internal);
      // Require identity from this hydration; never attach cached seat updates to an old match.
      if (!match || !applyInfo('match_info', 'match_id', match.match_id, true)) return;
      for (const key of ['game_mode', 'phase', 'steam_id']) if (game && key in game) applyInfo('game_info', key, game[key], true);
      if (internal && 'version_info' in internal) applyInfo('gep_internal', 'version_info', internal.version_info, true);
      if ('team_score' in match) applyInfo('match_info', 'team_score', match.team_score, true);
      if ('match_outcome' in match) applyInfo('match_info', 'match_outcome', match.match_outcome, true);
      for (const key of Object.keys(match).filter((entry) => /^roster_\d{1,2}$/.test(entry)).slice(0, 12)) applyInfo('match_info', key, match[key], true);
      for (const key of Object.keys(match).filter((entry) => /^items_\d{1,2}$/.test(entry)).slice(0, 12)) applyInfo('match_info', key, match[key], true);
      lastReceivedAt = Date.now();
      source('connected', 'Hydrated documented match fields. Hydration has no origin clock or completeness guarantee; live draft advice remains unavailable.');
      publishMatch(); publishPlayers();
      for (const seat of purchases.keys()) publishPurchases(seat);
    } catch {
      if (!stopped && currentGep === gep && hydration === hydrationGeneration) {
        reset('Provider hydration failed.');
        source('interrupted', 'Current match hydration failed. Prior match data was cleared; restart the supported runtime or wait for provider recovery.');
      }
    }
  }
  function registerFeatures(): void {
    const gep = currentGep;
    if (!gep || stopped || registrationInFlight) return;
    if (gameExited) {
      source('connected', 'Waiting for Deadlock. No cached match is hydrated after a confirmed game exit.');
      return;
    }
    const registration = ++registrationGeneration;
    registered = false;
    registrationInFlight = true;
    source('connecting', 'Registering the documented Deadlock feature set. Draft offers remain unsupported.');
    async function attempt(index: number): Promise<void> {
      if (stopped || currentGep !== gep || registration !== registrationGeneration) return;
      try {
        await withTimeout(gep!.setRequiredFeatures(DEADLOCK_GAME_ID, [...REQUIRED_FEATURES]));
        if (stopped || currentGep !== gep || registration !== registrationGeneration) return;
        registrationInFlight = false;
        registered = true;
        source('connected', 'GEP subscription ready; waiting for documented match data. Automatic current offers are unavailable.');
        void hydrate();
      } catch {
        if (stopped || currentGep !== gep || registration !== registrationGeneration) return;
        if (index < RETRY_DELAYS.length) schedule(() => void attempt(index + 1), RETRY_DELAYS[index]);
        else {
          registrationInFlight = false;
          reset('Deadlock feature registration failed.');
          source('unavailable', 'Deadlock feature registration failed after five attempts. Launch the companion before Deadlock and verify supported runtime access.');
        }
      }
    }
    void attempt(0);
  }
  function attachGep(): void {
    const gep = gepPackage(manager);
    if (!gep || stopped) {
      source('unavailable', 'The supported GEP package is not ready. Check runtime access and package initialization.');
      return;
    }
    detachGep();
    currentGep = gep;
    reset('A provider session started.');
    subscribe(gep, 'game-detected', (event, gameId) => {
      if (gameId !== DEADLOCK_GAME_ID) return;
      const launch = record(event);
      if (!launch || typeof launch.enable !== 'function') return;
      try { launch.enable.call(event); } catch {
        reset('The provider could not enable Deadlock.');
        source('unavailable', 'Deadlock event activation failed.');
        return;
      }
      gameExited = false;
      reset('Deadlock was detected.');
      recoveryAttempts = 0;
      registrationInFlight = false;
      registerFeatures();
    });
    subscribe(gep, 'new-info-update', (_event, gameId, input) => {
      if (gameId !== DEADLOCK_GAME_ID || !registered) return;
      const update = record(input);
      if (!update || update.gameId !== DEADLOCK_GAME_ID || typeof update.feature !== 'string'
        || typeof update.category !== 'string' || update.category !== update.feature || typeof update.key !== 'string') return;
      const value = Object.prototype.hasOwnProperty.call(update, 'value') ? update.value : update.data;
      if (applyInfo(update.feature, update.key.trim(), value)) {
        // A stream update makes an earlier in-flight getInfo response obsolete.
        hydrationGeneration++;
        lastReceivedAt = Date.now();
        recoveryAttempts = 0;
        source('connected', 'Documented diagnostic data received. Current offers, exact ranks, ownership semantics, and source age remain unverified.');
      }
    });
    subscribe(gep, 'new-game-event', (_event, gameId, input) => {
      if (gameId !== DEADLOCK_GAME_ID || !registered) return;
      const event = record(input);
      if (!event || event.gameId !== DEADLOCK_GAME_ID || event.feature !== 'match_info') return;
      const value = Object.prototype.hasOwnProperty.call(event, 'value') ? event.value : event.data;
      if ((event.key === 'match_start' || event.key === 'match_end') && value !== null) return;
      if (event.key === 'match_start') {
        reset('A match started; requesting fresh identity hydration.');
        source('connecting', 'Waiting for current match hydration.');
        void hydrate();
      } else if (event.key === 'match_end' && matchId) {
        hydrationGeneration++;
        globalPhase = 'PostGame';
        publishMatch();
      }
    });
    subscribe(gep, 'game-exit', (_event, gameId) => {
      if (gameId !== DEADLOCK_GAME_ID) return;
      gameExited = true;
      registered = false;
      registrationInFlight = false;
      registrationGeneration++;
      reset('Deadlock exited.');
      source('connected', 'Waiting for Deadlock. The previous match was cleared.');
    });
    subscribe(gep, 'elevated-privileges-required', (_event, gameId) => {
      if (gameId !== DEADLOCK_GAME_ID) return;
      registered = false;
      registrationGeneration++;
      registrationInFlight = false;
      reset('Deadlock privilege levels do not match.');
      source('unavailable', 'Deadlock is running elevated. Run the game and companion at matching privilege levels using the supported runtime.');
    });
    subscribe(gep, 'error', (_event, gameId) => {
      if (gameId !== DEADLOCK_GAME_ID) return;
      registered = false;
      registrationGeneration++;
      registrationInFlight = false;
      reset('The Deadlock provider was interrupted.');
      source('interrupted', 'Deadlock telemetry was interrupted; prior match data was cleared.');
      const recoveryContext = contextGeneration;
      if (++recoveryAttempts <= 3) schedule(() => {
        if (recoveryContext === contextGeneration) registerFeatures();
      }, 1000);
      else source('unavailable', 'Deadlock telemetry repeatedly failed. Restart the supported runtime after checking provider availability.');
    });
    registerFeatures();
  }

  source(sourceStatus, manager
    ? 'Waiting for the supported GEP package. Development access may be required.'
    : 'This ordinary Electron build has no participant telemetry. Demo is available; an approved Overwolf runtime and missing draft capabilities are required for live advice.');
  if (manager) {
    subscribe(manager, 'ready', (_event, packageName, version) => {
      if (packageName !== 'gep') return;
      runtimeVersion = text(version, 48);
      attachGep();
    });
    subscribe(manager, 'failed-to-initialize', (_event, packageName) => {
      if (packageName !== 'gep') return;
      detachGep();
      reset('The GEP package failed to initialize.');
      source('unavailable', 'GEP initialization failed. Verify supported runtime development access and provider status.');
    });
    subscribe(manager, 'crashed', () => {
      detachGep();
      reset('The provider package crashed.');
      source('interrupted', 'The provider package crashed. Prior match data was cleared; waiting for package recovery.');
    });
    if (gepPackage(manager)) attachGep();
    else schedule(() => {
      if (!currentGep) source('unavailable', 'The GEP package has not become ready. Check supported runtime access and provider initialization.');
    }, 10_000);
  }
  return {
    stop() {
      stopped = true;
      contextGeneration++;
      hydrationGeneration++;
      registrationGeneration++;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const subscription of subscriptions) subscription.target.removeListener(subscription.name, subscription.listener);
      subscriptions.length = 0;
      players.clear();
      purchases.clear();
      currentGep = null;
    },
  };
}
