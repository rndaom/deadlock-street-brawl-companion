import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const audit = await import(pathToFileURL(path.join(process.cwd(), 'scripts/lib/match-audit.mjs')).href);

// Everything below is invented: item names, ids, hero ids, account ids and times.
const catalog = {
  items: ['Alpha Blade', 'Beta Shield', 'Gamma Orb', 'Delta Coil', 'Epsilon Ring', 'Zeta Gem'].map((name, i) => ({ id: `upgrade_${name.split(' ')[0].toLowerCase()}`, numericId: String(1000 + i), name })),
  heroes: [{ id: 'hero_one', numericId: '7', name: 'Hero One' }, { id: 'hero_two', numericId: '8', name: 'Hero Two' }],
};
const index = audit.buildIndex(catalog);
const START = 1_800_000_000;
const iso = (offsetS: number) => new Date((START + offsetS) * 1000).toISOString();
const item = (itemId: number, time: number, soldTime = 0) => ({ item_id: itemId, game_time_s: time, sold_time_s: soldTime, upgrade_id: 1 });

const record = {
  match_info: {
    match_id: 4242, game_mode: 4, start_time: START, duration_s: 600, team_score: [2, 1],
    street_brawl_rounds: [{ round_duration_s: 100, winning_team: 0 }, { round_duration_s: 90, winning_team: 1 }],
    players: [
      { account_id: 1001, hero_id: 7, team: 'Team0', items: [
        item(1000, 10), item(1001, 18), item(1005, 26), item(555, 30),           // draft 1 (555 is an ability: not in the catalogue)
        item(1002, 150), item(1003, 158), item(1004, 165, 170),                  // draft 2
      ] },
      { account_id: 1002, hero_id: 8, team: 'Team1', items: [item(1000, 12)] },
    ],
  },
};

type Read = { at: number; round?: number; decision: string; offers: string[]; preferred?: number | null; choice?: string; phase?: string; pick?: string; hero?: string };
const line = (read: Read) => JSON.stringify({
  at: iso(read.at), op: 'read', round: read.round, matchPhase: read.phase ?? 'draft', decision: read.decision,
  parse: { isDraft: true, message: null, offers: read.offers, readable: true },
  advice: read.preferred === undefined ? null : { preferred: read.preferred, title: 't', reroll: null, choice: read.choice },
  roster: { localHeroId: read.hero ?? 'hero_one' }, ...(read.pick ? { pick: read.pick } : {}),
});
const gap = (at: number) => JSON.stringify({ at: iso(at), op: 'read', matchPhase: 'draft', decision: '', parse: { isDraft: true, offers: [], readable: false } });

const logText = [
  // Before the match window: another match's draft must be ignored.
  line({ at: -4000, round: 1, decision: 'new cards shown', offers: ['Zeta Gem', 'Zeta Gem', 'Zeta Gem'], preferred: 0, choice: '1' }),
  'this line is not json',
  // Draft 1, choice 1: recommended Alpha Blade (slot 0), player took it.
  line({ at: 8, round: 1, decision: 'new cards shown', offers: ['Alpha Blade', 'Beta Shield', 'Unread item choice'], preferred: 0, choice: '1' }),
  line({ at: 9, round: 1, decision: 'same cards', offers: ['Alpha Blade', 'Beta Shield', 'Gamma Orb'], preferred: 0, choice: '1' }),
  line({ at: 10, round: 1, decision: 'same cards', offers: ['Alpha Blade', 'Beta Shield', 'Gamma Orb'], preferred: 0, choice: '1' }),
  line({ at: 10.5, round: 1, decision: 'kept shown cards through unreadable frame', offers: ['Delta Coil', 'Delta Coil', 'Delta Coil'] }),
  gap(12),
  // Choice 2: recommended Gamma Orb (slot 2), player took Beta Shield.
  line({ at: 15, round: 1, decision: 'new cards shown', offers: ['Delta Coil', 'Beta Shield', 'Gamma Orb'], preferred: 2, choice: '2' }),
  line({ at: 16, round: 1, decision: 'same cards', offers: ['Delta Coil', 'Beta Shield', 'Gamma Orb'], preferred: 2, choice: '2' }),
  gap(19),
  // Choice 3: every card read, none of them is what the player took (Zeta Gem).
  line({ at: 22, round: 1, decision: 'new cards shown', offers: ['Delta Coil', 'Epsilon Ring', 'Gamma Orb'], preferred: 1, choice: '3' }),
  line({ at: 23, round: 1, decision: 'same cards', offers: ['Delta Coil', 'Epsilon Ring', 'Gamma Orb'], preferred: 1, choice: '3' }),
  // Draft 2 (round 2), choice 1: one card never read, and the taken item is not among the other two.
  line({ at: 148, round: 2, decision: 'new cards shown', offers: ['Alpha Blade', 'Unread item choice', 'Delta Coil'], preferred: 0, choice: '1' }),
  line({ at: 149, round: 2, decision: 'same cards (partly read)', offers: ['Alpha Blade', 'Unread item choice', 'Delta Coil'], preferred: 0, choice: '1' }),
  gap(152),
  // Choice 2 with a reroll: the first set is replaced (same stage); the player took Delta Coil from the second set.
  line({ at: 155, round: 2, decision: 'new cards shown', offers: ['Alpha Blade', 'Beta Shield', 'Gamma Orb'], preferred: 1, choice: '2' }),
  line({ at: 156, round: 2, decision: 'cards changed; old cards withdrawn', offers: ['Unread item choice', 'Unread item choice', 'Unread item choice'] }),
  line({ at: 157, round: 2, decision: 'new cards shown', offers: ['Delta Coil', 'Beta Shield', 'Gamma Orb'], preferred: 0, choice: '2' }),
  // Choice 3: a name the catalogue does not have. The reader's pick note, written while this set deals in, is for choice 2.
  line({ at: 162, round: 2, decision: 'new cards shown', offers: ['Epsilon Ring', 'Mystery Item', 'Alpha Blade'], preferred: 0, choice: '3', pick: 'upgrade_alpha' }),
  line({ at: 163, round: 2, decision: 'same cards', offers: ['Epsilon Ring', 'Mystery Item', 'Alpha Blade'], preferred: 0, choice: '3' }),
  line({ at: 400, round: 3, decision: 'combat', phase: 'combat', offers: [] }),
].join('\n');

const entries = audit.parseLog(logText);
const run = (overrides = {}) => audit.auditMatch({ match: audit.normalizeMatch(record), entries, index, accountId: 1001, ...overrides });

describe('match record normalizing', () => {
  it('reads the single-match shape and marks Street Brawl', () => {
    const match = audit.normalizeMatch(record);
    expect(match).toMatchObject({ matchId: 4242, isStreetBrawl: true, startUnix: START, durationS: 600, score: [2, 1] });
    expect(match.rounds).toHaveLength(2);
    expect(match.players[0].items[0]).toEqual({ itemId: 1000, time: 10, soldTime: 0, upgradeId: 1 });
  });
  it('reads the bulk shape (string mode and start time, one-element array)', () => {
    const bulk = audit.normalizeMatch([{ match_id: 9, game_mode: 'StreetBrawl', start_time: '2027-01-15 08:00:00', duration_s: 5, players: [] }]);
    expect(bulk).toMatchObject({ isStreetBrawl: true, startUnix: Date.UTC(2027, 0, 15, 8) / 1000 });
    expect(audit.normalizeMatch({ match_info: { game_mode: 1, start_time: START, players: [] } }).isStreetBrawl).toBe(false);
  });
  it('rejects something that is not a record', () => {
    expect(() => audit.normalizeMatch({ error: 'x' })).toThrow(/not a match record/);
  });
});

describe('log parsing', () => {
  it('skips bad lines and keeps only the match window', () => {
    expect(entries.length).toBe(logText.split('\n').length - 1);
    const windowed = audit.windowEntries(entries, audit.normalizeMatch(record));
    expect(windowed.every((entry: { at: string }) => Date.parse(entry.at) >= (START - 300) * 1000)).toBe(true);
    expect(windowed.length).toBe(entries.length - 1);
  });
  it('reads the hero from the roster', () => {
    expect(audit.localHeroClass(entries)).toBe('hero_one');
  });
});

describe('audit of drafts', () => {
  const result = run();
  it('finds two drafts and pairs them with the two pick groups', () => {
    expect(result.warnings).toEqual([]);
    expect(result.drafts.map((draft: { round: number }) => draft.round)).toEqual([1, 2]);
    expect(result.drafts.map((draft: { choices: unknown[] }) => draft.choices.length)).toEqual([3, 3]);
    expect(result.drafts[0].pickTimes).toEqual([10, 26]);
  });
  it('votes the cards over the reads and ignores kept frames', () => {
    const [first] = result.drafts[0].choices;
    expect(first.read).toEqual(['Alpha Blade', 'Beta Shield', 'Gamma Orb']);
  });
  it('credits a followed recommendation, an ignored one and a contradiction', () => {
    const [one, two, three] = result.drafts[0].choices;
    expect(one).toMatchObject({ stage: 1, recommended: 'Alpha Blade', took: 'Alpha Blade', outcome: 'followed' });
    expect(two).toMatchObject({ recommended: 'Gamma Orb', took: 'Beta Shield', outcome: 'not-followed' });
    expect(three).toMatchObject({ took: 'Zeta Gem', outcome: 'contradicted' });
    expect(result.contradictions[0]).toMatchObject({ draft: 1, stage: 3, took: 'Zeta Gem', read: ['Delta Coil', 'Epsilon Ring', 'Gamma Orb'] });
  });
  it('does not call a read wrong when a card was unread, and merges a reroll into one choice', () => {
    const [one, two, three] = result.drafts[1].choices;
    expect(one).toMatchObject({ read: ['Alpha Blade', null, 'Delta Coil'], took: 'Gamma Orb', outcome: 'unresolved' });
    expect(two).toMatchObject({ stage: 2, rerolls: 1, read: ['Delta Coil', 'Beta Shield', 'Gamma Orb'], recommended: 'Delta Coil', took: 'Delta Coil', outcome: 'followed' });
    expect(three).toMatchObject({ took: 'Epsilon Ring', outcome: 'followed' });
    expect(three.soldAt).toBe(170);
  });
  it('reports unknown names and a reader pick the record disagrees with', () => {
    expect(result.contradictions).toContainEqual({ draft: 2, stage: 3, unknownName: 'Mystery Item' });
    expect(result.contradictions).toContainEqual({ draft: 2, stage: 2, readerPick: 'Alpha Blade', took: 'Delta Coil' });
  });
  it('totals the outcomes', () => {
    expect(result.totals).toMatchObject({ drafts: 2, choices: 6, withPick: 6, contradicted: 1, unresolved: 1, followed: 3, recommended: 4, unreadCards: 2 });
  });
  it('prints a report with the totals', () => {
    const text = audit.formatReport(result);
    expect(text).toContain('Match 4242  Street Brawl');
    expect(text).toContain('took the recommended card');
    expect(text).toContain('NOT among the three cards read');
    expect(text).toContain('Totals');
  });
});

describe('choosing the player and the window', () => {
  it('finds you by the hero in the log when no account is given', () => {
    expect(run({ accountId: null }).hero).toBe('Hero One');
  });
  it('asks for --player when the hero cannot decide', () => {
    expect(() => audit.auditMatch({ match: audit.normalizeMatch(record), entries: [], index, accountId: null })).toThrow(/--player/);
    expect(() => run({ accountId: 5 })).toThrow(/not in this match/);
  });
  it('warns when the log has no entries in the window', () => {
    expect(run({ entries: [] }).warnings[0]).toMatch(/No log entries/);
  });
  it('warns when the draft count differs from the record', () => {
    const fewer = audit.parseLog(logText.split('\n').filter((_: string, i: number) => i < 12).join('\n'));
    const result = run({ entries: fewer });
    expect(result.warnings.join(' ')).toMatch(/1 draft\(s\) but the record has 2/);
    expect(result.extraRecordDrafts).toEqual([['Gamma Orb', 'Delta Coil', 'Epsilon Ring']]);
  });
});
