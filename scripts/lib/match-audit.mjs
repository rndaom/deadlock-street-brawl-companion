// Pure matching logic for scripts/audit-match.mjs: lines up the companion's reader log with a finished
// Street Brawl match record from deadlock-api. No file, network or clock access here.
//
// What the record can and cannot say: it lists every item a player bought with its game time, and the
// round results, but not the cards that were offered. So the audit asks one question per choice: was the
// item the player took among the cards the reader saw, and was it the card the companion recommended?

export const DEFAULT_SLACK_S = 300;
/** Picks of one draft land within seconds of each other (record: 10-25 s apart); drafts are minutes apart. */
export const PICK_GAP_S = 45;
export const DRAFT_GAP_S = 90;

const UNREAD_NAMES = new Set(['unread item choice', 'ambiguous item name']);
// Reads the reader itself kept from an earlier frame or discarded: they are not fresh evidence of the cards.
const STALE_DECISION = /^(kept shown|one card read differently|game not in foreground|capture |stale or unverifiable|leftover card)/;
const normName = name => String(name ?? '').trim().toLowerCase();

export function buildIndex(catalog) {
  const byName = new Map(), byNumeric = new Map(), byClass = new Map(), heroByClass = new Map();
  for (const item of catalog.items ?? []) {
    const id = Number(item.numericId);
    if (!Number.isFinite(id)) continue;
    const entry = { id, className: item.id, name: item.name };
    byNumeric.set(id, entry);
    byClass.set(item.id, entry);
    const key = normName(item.name);
    // A name shared by two items cannot identify either of them.
    byName.set(key, byName.has(key) ? null : entry);
  }
  for (const hero of catalog.heroes ?? []) heroByClass.set(hero.id, { id: Number(hero.numericId), name: hero.name });
  return { byName, byNumeric, byClass, heroByClass };
}

/** Accepts the single-match endpoint ({ match_info }), a bare match_info, or a one-element bulk array. */
export function normalizeMatch(raw) {
  const record = Array.isArray(raw) ? raw[0] : raw;
  const info = record?.match_info ?? record;
  if (!info || !Array.isArray(info.players)) throw new Error('This is not a match record (no players list).');
  const mode = String(info.game_mode ?? '');
  const start = info.start_time;
  const startUnix = typeof start === 'number' ? start : Date.parse(`${String(start).replace(' ', 'T')}Z`) / 1000;
  return {
    matchId: info.match_id ?? null,
    // 4 on the single-match endpoint, "StreetBrawl" on the bulk one.
    isStreetBrawl: mode === '4' || /street[_ ]?brawl/i.test(mode),
    gameMode: mode,
    startUnix: Number.isFinite(startUnix) ? startUnix : null,
    durationS: Number(info.duration_s) || 0,
    score: Array.isArray(info.team_score) ? info.team_score : null,
    rounds: (info.street_brawl_rounds ?? []).map(round => ({ durationS: round.round_duration_s, winningTeam: round.winning_team })),
    players: info.players.map(player => ({
      accountId: Number(player.account_id), heroId: Number(player.hero_id), team: player.team,
      items: (player.items ?? []).map(item => ({ itemId: Number(item.item_id), time: Number(item.game_time_s), soldTime: Number(item.sold_time_s) || 0, upgradeId: item.upgrade_id })),
    })),
  };
}

export function parseLog(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const atMs = Date.parse(entry?.at);
    if (Number.isFinite(atMs)) { entry.atMs = atMs; entries.push(entry); }
  }
  return entries;
}

export function windowEntries(entries, match, slackS = DEFAULT_SLACK_S) {
  if (match.startUnix == null) return entries;
  const low = (match.startUnix - slackS) * 1000, high = (match.startUnix + match.durationS + slackS) * 1000;
  return entries.filter(entry => entry.atMs >= low && entry.atMs <= high);
}

const mode = (votes) => {
  let best = null, count = 0;
  for (const [value, n] of votes) if (n > count) { best = value; count = n; }
  return best;
};
const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/** One set = three cards on screen until they change (a reroll, the next choice, or the draft closing). */
export function extractSets(entries, index) {
  const sets = [];
  let open = null;
  for (const entry of entries) {
    if (typeof entry.pick === 'string') { const target = open ?? sets.at(-1); if (target) target.picks.push(entry.pick); }
    if (entry.matchPhase && entry.matchPhase !== 'draft') { open = null; continue; }
    const decision = String(entry.decision ?? '');
    if (/^(cards changed|draft closed|selections complete)/.test(decision)) { open = null; continue; }
    const offers = entry.parse?.offers;
    if (!entry.parse?.isDraft || !Array.isArray(offers) || offers.length !== 3 || STALE_DECISION.test(decision)) continue;
    if (!open || decision.startsWith('new cards shown')) {
      open = { startMs: entry.atMs, endMs: entry.atMs, round: null, slotVotes: [new Map(), new Map(), new Map()], stageVotes: new Map(), preferred: null, unknownNames: new Set(), picks: [], reads: 0 };
      sets.push(open);
    }
    open.endMs = entry.atMs;
    open.reads += 1;
    if (Number.isFinite(entry.round)) open.round = entry.round;
    offers.forEach((name, slot) => {
      const key = normName(name);
      if (!key || UNREAD_NAMES.has(key)) return;
      const item = index.byName.get(key);
      if (item) tally(open.slotVotes[slot], item.className); else open.unknownNames.add(String(name));
    });
    const stage = Number(entry.advice?.choice);
    if (Number.isFinite(stage)) tally(open.stageVotes, stage);
    if (Number.isInteger(entry.advice?.preferred)) open.preferred = entry.advice.preferred;
  }
  return sets.map(set => ({
    startMs: set.startMs, endMs: set.endMs, round: set.round, reads: set.reads, picks: set.picks,
    cards: set.slotVotes.map(votes => mode(votes)), stage: mode(set.stageVotes), preferred: set.preferred, unknownNames: [...set.unknownNames],
  }));
}

/** Sets of one choice: a reroll replaces the cards but keeps "Choice N of 3", so equal stage in one round merges. */
export function groupChoices(sets) {
  const choices = [];
  for (const set of sets) {
    const previous = choices.at(-1);
    if (previous && set.stage !== null && previous.stage === set.stage && previous.round === set.round && !previous.final.picks.length) {
      previous.sets.push(set);
      previous.final = set;
    } else choices.push({ sets: [set], final: set, stage: set.stage, round: set.round });
  }
  return choices;
}

export function groupDrafts(choices) {
  const drafts = [];
  for (const choice of choices) {
    const draft = drafts.at(-1), last = draft?.choices.at(-1);
    const sameDraft = draft && last
      && (choice.round === null || last.round === null || choice.round === last.round)
      && !(choice.stage !== null && last.stage !== null && choice.stage < last.stage)
      && (choice.sets[0].startMs - last.final.endMs) / 1000 <= DRAFT_GAP_S;
    if (sameDraft) draft.choices.push(choice); else drafts.push({ choices: [choice] });
  }
  return drafts;
}

/** The player's catalogue items by buy time, split into one cluster per draft. Abilities and unknown ids are skipped. */
export function recordDrafts(player, index) {
  const picks = player.items.filter(item => index.byNumeric.has(item.itemId)).sort((a, b) => a.time - b.time);
  const clusters = [];
  for (const pick of picks) {
    const cluster = clusters.at(-1);
    if (cluster && pick.time - cluster.picks.at(-1).time <= PICK_GAP_S) cluster.picks.push(pick); else clusters.push({ picks: [pick] });
  }
  return clusters;
}

export function localHeroClass(entries) {
  const votes = new Map();
  for (const entry of entries) if (typeof entry.roster?.localHeroId === 'string') tally(votes, entry.roster.localHeroId);
  return mode(votes);
}

export function selectPlayer(match, { accountId = null, heroClass = null, index }) {
  if (accountId !== null) {
    const player = match.players.find(candidate => candidate.accountId === accountId);
    if (!player) throw new Error(`Account ${accountId} is not in this match.`);
    return player;
  }
  const hero = heroClass ? index.heroByClass.get(heroClass) : null;
  const candidates = hero ? match.players.filter(player => player.heroId === hero.id) : [];
  if (candidates.length === 1) return candidates[0];
  throw new Error(hero
    ? `The log's hero (${hero.name}) matches ${candidates.length} players in the record. Pass --player <account id>.`
    : 'Could not tell which player is you from the log. Pass --player <account id>.');
}

export function auditMatch({ match, entries, index, accountId = null, slackS = DEFAULT_SLACK_S, windowed = true }) {
  const warnings = [];
  const scoped = windowed ? windowEntries(entries, match, slackS) : entries;
  const player = selectPlayer(match, { accountId, heroClass: localHeroClass(scoped), index });
  const hero = [...index.heroByClass.entries()].find(([, value]) => value.id === player.heroId)?.[1].name ?? `hero ${player.heroId}`;
  const logDrafts = groupDrafts(groupChoices(extractSets(scoped, index)));
  const recordClusters = recordDrafts(player, index);
  if (!scoped.length) warnings.push('No log entries fall inside the match window; check --log, or widen --slack.');
  else if (!logDrafts.length) warnings.push('The log has no draft reads in the match window.');
  if (logDrafts.length !== recordClusters.length) warnings.push(`The log shows ${logDrafts.length} draft(s) but the record has ${recordClusters.length} group(s) of picks; they are paired in order, so later pairs may be off.`);

  const totals = { drafts: logDrafts.length, choices: 0, withPick: 0, inCards: 0, recommended: 0, followed: 0, contradicted: 0, unresolved: 0, noAdvice: 0, unreadCards: 0 };
  const contradictions = [];
  const drafts = logDrafts.map((draft, draftIndex) => {
    const cluster = recordClusters[draftIndex] ? [...recordClusters[draftIndex].picks] : [];
    const times = recordClusters[draftIndex] ? [recordClusters[draftIndex].picks[0].time, recordClusters[draftIndex].picks.at(-1).time] : null;
    const inOrder = draft.choices.length === cluster.length;
    if (cluster.length && !inOrder) warnings.push(`Draft ${draftIndex + 1}: the log has ${draft.choices.length} choice(s) but the record ${cluster.length} pick(s); pairing by card, which is less certain.`);
    const choices = draft.choices.map(choice => {
      const { cards, preferred } = choice.final;
      const ids = cards.filter(card => card !== null);
      // Choice N is pick N when the counts agree. If the log missed or split a choice, fall back to the earliest
      // unclaimed pick that is one of these cards, else the next pick in order.
      let at = inOrder ? 0 : cluster.findIndex(pick => ids.includes(index.byNumeric.get(pick.itemId).className));
      if (at < 0 && cluster.length) at = 0;
      const taken = at >= 0 ? cluster.splice(at, 1)[0] : null;
      const takenItem = taken ? index.byNumeric.get(taken.itemId) : null;
      const recommended = preferred !== null && cards[preferred] ? cards[preferred] : null;
      const unread = cards.filter(card => card === null).length;
      const inCards = takenItem ? ids.includes(takenItem.className) : null;
      let outcome;
      if (!takenItem) outcome = 'no-pick';
      else if (!inCards) outcome = unread ? 'unresolved' : 'contradicted';
      else if (!recommended) outcome = 'no-advice';
      else outcome = recommended === takenItem.className ? 'followed' : 'not-followed';
      const readerPick = choice.final.picks.at(-1) ?? null;
      const readerPickItem = readerPick ? index.byClass.get(readerPick) : null;

      totals.choices += 1;
      totals.unreadCards += unread;
      if (takenItem) {
        totals.withPick += 1;
        if (inCards) totals.inCards += 1;
        if (inCards && recommended) { totals.recommended += 1; if (outcome === 'followed') totals.followed += 1; }
        if (outcome === 'no-advice') totals.noAdvice += 1;
      }
      if (outcome === 'unresolved') totals.unresolved += 1;
      const names = cards.map(card => (card ? index.byClass.get(card).name : null));
      if (outcome === 'contradicted') {
        totals.contradicted += 1;
        contradictions.push({ draft: draftIndex + 1, stage: choice.stage, read: names, took: takenItem.name });
      }
      if (takenItem && readerPickItem && readerPickItem.id !== takenItem.id) {
        contradictions.push({ draft: draftIndex + 1, stage: choice.stage, readerPick: readerPickItem.name, took: takenItem.name });
      }
      for (const name of choice.final.unknownNames) contradictions.push({ draft: draftIndex + 1, stage: choice.stage, unknownName: name });
      return {
        stage: choice.stage, rerolls: choice.sets.length - 1, read: names, recommended: recommended ? index.byClass.get(recommended).name : null,
        took: takenItem?.name ?? null, tookAt: taken?.time ?? null, soldAt: taken?.soldTime || null, outcome,
      };
    });
    return { index: draftIndex + 1, round: draft.choices[0].round, pickTimes: times, choices, leftoverPicks: cluster.map(pick => index.byNumeric.get(pick.itemId).name) };
  });
  const extraRecordDrafts = recordClusters.length > logDrafts.length ? recordClusters.slice(logDrafts.length).map(cluster => cluster.picks.map(pick => index.byNumeric.get(pick.itemId).name)) : [];
  return { matchId: match.matchId, hero, startUnix: match.startUnix, durationS: match.durationS, score: match.score, rounds: match.rounds, drafts, extraRecordDrafts, totals, contradictions, warnings, entriesInWindow: scoped.length };
}

const OUTCOME_TEXT = {
  followed: 'took the recommended card',
  'not-followed': 'took a different card than recommended',
  'no-advice': 'took a card read; no recommendation shown',
  contradicted: 'took an item that is NOT among the three cards read',
  unresolved: 'took an item not among the cards read, but a card was unread',
  'no-pick': 'no matching pick in the record',
};

export function formatReport(result) {
  const out = [];
  const when = result.startUnix == null ? 'unknown start' : new Date(result.startUnix * 1000).toISOString().replace('.000Z', 'Z');
  out.push(`Match ${result.matchId ?? '?'}  Street Brawl  ${when}  ${result.durationS} s${result.score ? `  score ${result.score.join('-')}` : ''}  you: ${result.hero}`);
  out.push(`Log: ${result.entriesInWindow} entries in the match window, ${result.totals.drafts} draft(s) seen`);
  for (const warning of result.warnings) out.push(`Warning: ${warning}`);
  for (const draft of result.drafts) {
    out.push('', `Draft ${draft.index}${draft.round != null ? ` (log round ${draft.round})` : ''}${draft.pickTimes ? `, record picks at ${draft.pickTimes[0]}-${draft.pickTimes[1]} s` : ', no record picks'}`);
    for (const choice of draft.choices) {
      const read = choice.read.map(name => name ?? '?').join(' | ');
      out.push(`  choice ${choice.stage ?? '?'}: read [${read}]${choice.rerolls ? ` (${choice.rerolls} reroll${choice.rerolls > 1 ? 's' : ''} before)` : ''}  recommended: ${choice.recommended ?? 'none'}  took: ${choice.took ?? '-'}${choice.soldAt ? ` (sold at ${choice.soldAt} s)` : ''}`);
      out.push(`    ${OUTCOME_TEXT[choice.outcome]}`);
    }
    if (draft.leftoverPicks.length) out.push(`  record picks not paired with a choice: ${draft.leftoverPicks.join(', ')}`);
  }
  for (const [at, names] of result.extraRecordDrafts.entries()) out.push('', `Record group ${result.drafts.length + at + 1} has no draft in the log: ${names.join(', ')}`);
  if (result.contradictions.length) {
    out.push('', 'Reads the record contradicts:');
    for (const entry of result.contradictions) {
      const where = `  draft ${entry.draft}, choice ${entry.stage ?? '?'}: `;
      if (entry.unknownName) out.push(`${where}read a name the catalogue does not know: "${entry.unknownName}"`);
      else if (entry.readerPick) out.push(`${where}the reader credited ${entry.readerPick}, the record shows ${entry.took}`);
      else out.push(`${where}took ${entry.took}; read [${entry.read.map(name => name ?? '?').join(' | ')}]`);
    }
  }
  const t = result.totals;
  const pct = (n, d) => (d ? ` (${Math.round((n / d) * 100)}%)` : '');
  out.push('', 'Totals',
    `  drafts seen ${t.drafts}, choices ${t.choices}, with a record pick ${t.withPick}`,
    `  taken item among the cards read: ${t.inCards} of ${t.withPick}${pct(t.inCards, t.withPick)}`,
    `  recommended card taken: ${t.followed} of ${t.recommended} choices with a recommendation${pct(t.followed, t.recommended)}`,
    `  contradicted reads: ${t.contradicted}; unresolved (a card unread): ${t.unresolved}; unread cards in total: ${t.unreadCards}`);
  return out.join('\n');
}
