import type { Catalog } from '../shared/types';
import type { CaptureRegion, NativeScreenContext } from '../shared/screen-reading';

/**
 * Where the player is, from what the screen shows:
 * - 'outside': hideout, main menu, party, queue or post-match. Nothing new is learned there (the
 *   hideout shows your practice hero, a top bar and even your own name), and the last match
 *   stays shown until the next one begins.
 * - 'loading' / 'match': a Street Brawl match. 'loading' is the "JOINING THE FIGHT AS..." screen.
 * - 'unknown': not established yet (app start, game restart). Evidence is collected but not shown.
 */
export type RosterPhase = 'unknown' | 'outside' | 'loading' | 'match';

/**
 * Who is in the current Street Brawl match, accumulated over many reads.
 * Seats 0-3 are the left top-bar team and 4-7 the right team. Your own hero is found from,
 * in order: the loading screen ("JOINING THE FIGHT AS... RAT KING"), your own HUD ability icons
 * and your Steam name above a top-bar seat with the hero name under it (scoreboard / draft),
 * then the hero in the seat your name is above. Your team comes from that seat, or from the
 * hero shown in your own HUD appearing in the top bar, or (when your own portrait is the one
 * that was not recognized) elimination.
 */
export interface DraftRoster {
  /** Hero per top-bar seat (left 0-3, right 4-7); null when not yet recognized. */
  seats: (string | null)[];
  localHeroId: string | null;
  /** 0 = left team, 1 = right team, null while your hero is not placed. */
  localSide: 0 | 1 | null;
  /** Your own top-bar seat when your name or hero placed it. */
  localSeat: number | null;
  allies: string[];
  enemies: string[];
  matchId: string | null;
  updatedAt: number | null;
  /** Increments every time the tracker starts over for a new match. */
  epoch: number;
  phase: RosterPhase;
  /** When the current match's evidence began; anything observed earlier belongs to another match or the hideout. */
  since: number | null;
}
interface TextBlock { text: string; bounds: CaptureRegion }
export interface RosterOptions {
  /** Your own display names (Steam persona), matched against the player names above the top bar. */
  localPlayerNames?: readonly string[];
}

/** Street Brawl top-bar portrait/name centers at 1920 px wide (4 players per side). */
const SEAT_CENTERS = [550, 638, 726, 814, 1106, 1194, 1282, 1370].map(x => x / 1920);
const SEAT_TOLERANCE = 0.03;
/** Votes needed before a seat or your own seat is trusted; older votes fade. */
// Two agreeing reads (1 + 0.97 after fading) are enough.
const MIN_VOTES = 1.9;
const DECAY = 0.97;
const HERO_CONFIDENCE = 0.9;
/**
 * One confident read of your own hero is enough. In the logs every wrong own-hero read came from
 * the hideout, a spectated player (dead / SPECTATING) or a loading screen, all of which are excluded.
 */
const LOCAL_MIN_VOTES = 0.95;
/** Past this support a different own hero is a challenger (possible new match), not a correction. */
const LOCAL_ESTABLISHED = 2.5;
/** Consecutive confident reads of a different own hero that mean a new match has started. */
const NEW_HERO_STREAK = 4;
/** No top-bar evidence for this long (menus, queue, loading) means the next one is a new match. */
export const MATCH_GAP_MS = 180_000;
/** A different match number counts once it is read twice within this window (single footer misreads are common). */
const MATCH_CONFIRM_MS = 120_000;

const letters = (text: string) => text.toUpperCase().replace(/[^A-Z]/g, '');
const nameKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}
/**
 * Footer misreads of the same match differ in a digit or two (114818933 / 114819933 / 1148189331).
 * Match numbers are sequential, so two real matches minutes apart share their leading digits:
 * equal-length numbers are compared digit by digit (114833840 vs 114839384 is 4 digits apart,
 * a different match, though only 2 edits apart).
 */
export function sameMatchNumber(a: string, b: string): boolean {
  if (a.length === b.length) {
    let differ = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
    return differ <= 2;
  }
  return distance(a, b) <= 2;
}
/**
 * The top bar is laid out for 16:9 and kept centred and scaled by height on other shapes, so a
 * 2560x1080 screen puts the seats closer to the middle (as a share of the width) than 1920x1080.
 */
function seatAt(centerX: number, aspect = 16 / 9): number | null {
  const squeeze = (16 / 9) / (Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9);
  let best: number | null = null; let gap = SEAT_TOLERANCE * squeeze;
  SEAT_CENTERS.forEach((center, seat) => {
    const d = Math.abs(0.5 + (center - 0.5) * squeeze - centerX);
    if (d <= gap) { gap = d; best = seat; }
  });
  return best;
}
/** "MATCH: 114924390" (also "MATCH : 114818-9 33") anywhere, or the bare footer number in the bottom-right corner. */
function matchNumber(block: TextBlock): string | null {
  const labelled = block.text.match(/MATCH\s*[:;]?\s*(\d[\d\s-]{6,}\d)/i)?.[1];
  if (labelled) {
    // Truncated ("114839") or padded reads are not usable numbers.
    const digits = labelled.replace(/\D/g, '');
    return digits.length >= 9 && digits.length <= 10 ? digits : null;
  }
  if (block.bounds.y > 0.93 && block.bounds.x > 0.8) return block.text.trim().match(/^\D{0,8}(\d{9,10})$/)?.[1] ?? null;
  return null;
}
/**
 * Hideout and queue text (letters only, so OCR spacing and punctuation do not matter). None of
 * these can be on screen while a match runs, and none appeared in any in-match read of the
 * 2026-10-11 logs: the hideout HUD shows "$0 ITEM VALUE" / "PRESS TO SHOP", the queue
 * "FINDING STREET BRAWL / ESC TO CANCEL SEARCH" (also on the post-match summary). The 2026-10 post-match
 * summary shows "PLAY AGAIN", "REPLAY NOT YET READY", "KEY PLAYER" and "Total Round Time" (it also shows the
 * match number, which used to start a false loading phase). Before that summary the game shows "THE VOTES ARE IN...",
 * "WINNER'S BONUS", "SECOND/THIRD MOST ..." awards and "N players commended" (2026-10-18: those screens were read
 * as your HUD and trimmed a 12-item build to 3). ("RECOMMENDED" shows in a match, so only "PLAYER(S) COMMENDED" counts.)
 */
const OUTSIDE_CUES = /FINDING|NGSTREETBRAWL|CANCELSEAR|WAITINGFORPARTY|PRESSTOSHOP|ITEMVAL|PLAYAGAIN|REPLAYNOTYETREADY|TOTALROUNDTIME|KEYPLAYER|THEVOTESAREIN|WINNERSBONUS|SECONDMOST|THIRDMOST|PLAYERS?COMMENDED/;
/**
 * Main-menu and party pages ("READ ALL ABOUT IT", "MENU BUILDS", "CREATE ROSTER", "SWAP HERO").
 * The in-match Esc menu can show these too, so they never end a match; they only mark a read
 * that teaches nothing, and an app start on them as being outside a match.
 */
const MENU_CUES = /READALLABOUTIT|MENUBUILDS|CITYNEVERSLEEPS|CREATEROSTER|EDITROSTER|SWAPHERO|PRESSTOSELECTAGAMEMODE|SELECTPLAYMODE|INAPARTY|EARLYDEVELOPMENTBUILD|PRACTICERANGE|LEARNTOPLAY/;
/** A loading phase that saw no match after this long was a menu or practice range, not a match about to start. */
const LOADING_STALE_MS = 45_000;
/** Hideout or queue text: a frame showing it is not a match in progress. */
export function isOutsideMatchText(text: string): boolean { return OUTSIDE_CUES.test(letters(text)); }
/** Only the end-of-match screens (awards, vote, summary): seeing one means the match you were in is over. */
const POST_MATCH_CUES = /PLAYAGAIN|REPLAYNOTYETREADY|TOTALROUNDTIME|KEYPLAYER|THEVOTESAREIN|WINNERSBONUS|SECONDMOST|THIRDMOST|PLAYERS?COMMENDED/;
export function isPostMatchText(text: string): boolean { return POST_MATCH_CUES.test(letters(text)); }
/** The match loading screen: "PLAYERS CONNECTING / JOINING THE FIGHT AS... / FINISHING LOADING". */
const LOADING_CUES = /JOININGTHEFIGHT|FINISHINGLOADING/;
/** Dead or watching someone: the bottom HUD (ability icons) belongs to the spectated player. */
const SPECTATING_CUES = /SPECTATING|RESPAWNIN|NEXTPLAYER|PREVIOUSPLAYER/;
const centerX = (bounds: CaptureRegion) => bounds.x + bounds.width / 2;

interface ReadCues {
  outside: boolean; menu: boolean; loading: boolean; match: boolean; spectating: boolean;
  /** A well-formed match number, read in this frame. */
  matchNumber: string | null;
}
function readCues(context: NativeScreenContext | undefined, blocks: readonly TextBlock[]): ReadCues {
  const keys = blocks.map(block => letters(block.text));
  const matchNumber_ = blocks.map(matchNumber).find(Boolean) ?? null;
  // "ROUND 2" at top center (also OCR'd as "ROU 2", "#0UND 2", "ROUND2r").
  const round = blocks.some(block => block.bounds.y < 0.1 && Math.abs(centerX(block.bounds) - 0.5) < 0.08
    && /^[^A-Za-z0-9]*[RÉ#]?[O0]?UN?[DO0]?\s*'?[1-5](?![0-9])/i.test(block.text.trim()) && /UN|ND|RO/i.test(block.text));
  const draft = context?.panel === 'draft' || blocks.some(block => block.bounds.x < 0.35 && block.bounds.y < 0.4
    && /^SELECT ITEM|^CHOICE\s*[1-3]\s*OF\s*3/i.test(block.text.trim()));
  return {
    outside: context?.panel === 'post-match' || keys.some(key => OUTSIDE_CUES.test(key)),
    menu: keys.some(key => MENU_CUES.test(key)),
    loading: keys.some(key => LOADING_CUES.test(key)),
    // The match itself is on screen (the footer number alone also shows on the loading screen).
    match: round || draft,
    spectating: context?.viewMode === 'spectator' || keys.some(key => SPECTATING_CUES.test(key)),
    matchNumber: matchNumber_,
  };
}

export function createRosterTracker(catalog: Catalog, options: RosterOptions = {}) {
  const heroNames = catalog.heroes.map(hero => ({ id: hero.id, key: letters(hero.name) })).filter(hero => hero.key.length >= 3);
  const ownNames = [...new Set((options.localPlayerNames ?? []).map(nameKey).filter(key => key.length >= 3 && key.length <= 32))];
  let seatVotes: Map<string, number>[] = SEAT_CENTERS.map(() => new Map());
  let localVotes = new Map<string, number>();
  let localSeatVotes = new Map<number, number>();
  let challenger: { heroId: string; streak: number } | null = null;
  let matchId: string | null = null;
  let pendingMatch: { id: string; at: number } | null = null;
  let updatedAt: number | null = null;
  let since: number | null = null;
  let phase: RosterPhase = 'unknown';
  let loadingSince: number | null = null;
  /** A long silence (alt-tab, menus) was seen: decided by the next match number or own hero, not by the silence alone. */
  let gap: { heroId: string | null } | null = null;
  let epoch = 0;

  function clear(now: number | null) {
    seatVotes = SEAT_CENTERS.map(() => new Map()); localVotes = new Map(); localSeatVotes = new Map();
    challenger = null; matchId = null; pendingMatch = null; updatedAt = null; since = now; gap = null; epoch++;
  }
  /** The game closed or the reader restarted: nothing is known about where the player is. */
  function reset() { clear(null); phase = 'unknown'; }
  function vote<K>(votes: Map<K, number>, key: K, weight = 1) {
    for (const [other, value] of votes) votes.set(other, value * DECAY);
    votes.set(key, (votes.get(key) ?? 0) + weight);
  }
  function leader<K>(votes: Map<K, number>, min = MIN_VOTES): K | null {
    let best: K | null = null; let score = min - 1e-9;
    for (const [key, value] of votes) if (value > score) { score = value; best = key; }
    return best;
  }
  /** Hero name text such as "GRAVES" or OCR-damaged "WA mEN" under a top-bar player name. */
  function heroFromText(text: string): string | null {
    const key = letters(text);
    if (key.length < 3 || key.length > 14) return null;
    const ranked = heroNames.map(hero => ({ id: hero.id, d: distance(key, hero.key), length: hero.key.length })).sort((a, b) => a.d - b.d);
    const best = ranked[0]; const next = ranked[1];
    if (!best) return null;
    const allowed = best.length <= 4 ? 0 : Math.max(1, Math.floor(best.length * 0.34));
    return best.d <= allowed && (!next || next.d > best.d) ? best.id : null;
  }
  /** Center x of your own name inside a top-bar text block, when the block contains it. */
  function ownNameCenter(block: TextBlock): number | null {
    if (!ownNames.length) return null;
    const text = block.text;
    for (const token of text.matchAll(/\S+/g)) {
      const key = nameKey(token[0]);
      if (key.length < 3) continue;
      const matched = ownNames.some(name => distance(key, name) <= (name.length >= 9 ? 2 : name.length >= 5 ? 1 : 0));
      if (!matched) continue;
      // OCR can join neighbouring names into one line: place the token by its character position.
      const start = token.index! / Math.max(1, text.length), end = (token.index! + token[0].length) / Math.max(1, text.length);
      return block.bounds.x + block.bounds.width * (start + end) / 2;
    }
    return null;
  }
  /**
   * "JOINING THE FIGHT AS... | INFERNUS" on the loading screen (OCR reading order: the hero name
   * follows the title). Only a single, whole hero name near it counts.
   */
  function loadingHero(blocks: readonly TextBlock[]): string | null {
    const title = blocks.find(block => /JOININGTHEFIGHT/.test(letters(block.text)));
    if (!title) return null;
    const found = new Set(blocks.filter(block => block !== title && block.bounds.y >= title.bounds.y - 0.05 && block.bounds.y <= title.bounds.y + 0.4
      && Math.abs(centerX(block.bounds) - centerX(title.bounds)) < 0.45).map(block => heroFromText(block.text)).filter((id): id is string => !!id));
    return found.size === 1 ? [...found][0]! : null;
  }

  /** Feed one full-client read: native hero matches and the OCR text (full-client bounds). */
  /** @param aspect the game client's width / height, for the top-bar seat positions. */
  function observe(context: NativeScreenContext | undefined, blocks: readonly TextBlock[], now: number, aspect = 16 / 9) {
    const cues = readCues(context, blocks);
    const staleLoading = phase === 'loading' && loadingSince !== null && now - loadingSince > LOADING_STALE_MS;
    if (cues.outside || cues.menu && phase !== 'match' && (phase !== 'loading' || staleLoading)) {
      // Leaving a match keeps its roster on screen; anything gathered before a match was
      // established (app started in the hideout) is hideout evidence and is dropped.
      if (phase === 'match') phase = 'outside';
      else if (phase !== 'outside') { clear(null); phase = 'outside'; }
      return;
    }
    // A menu page over a running match (Esc) teaches nothing either.
    if (cues.menu) return;
    if (cues.loading) {
      // A loading screen starts a match: whatever was learned belongs to an earlier one. (Strips
      // of the same loading screen without the title, e.g. the footer alone, do not end it.)
      if (phase !== 'loading' && (phase !== 'match' || updatedAt !== null)) clear(now);
      if (phase !== 'loading') loadingSince = now;
      phase = 'loading';
    } else if (phase === 'outside') {
      // Hideout reads without a cue of their own (a HUD strip with your practice hero) teach nothing.
      if (!cues.match && !cues.matchNumber) return;
      // The same match number again: either the "outside" read was a stray and the match goes on
      // (the round counter shows it), or it is that match's summary or a menu (still outside).
      // A new number is the next match being found.
      const resumed = !!cues.matchNumber && !!matchId && sameMatchNumber(cues.matchNumber, matchId);
      if (resumed && !cues.match) return;
      if (!resumed) clear(now);
      phase = cues.match ? 'match' : 'loading';
      if (phase === 'loading') loadingSince = now;
    } else if (cues.match) phase = 'match';
    else if (phase === 'unknown' && cues.matchNumber) { phase = 'loading'; loadingSince = now; }
    if (since === null) since = now;

    const number = cues.matchNumber;
    if (number) {
      if (matchId && sameMatchNumber(number, matchId)) { pendingMatch = null; gap = null; }
      else if (pendingMatch && pendingMatch.id === number && now - pendingMatch.at <= MATCH_CONFIRM_MS) {
        // A clearly different number, read twice, is a new match.
        if (matchId) clear(now);
        matchId = number;
      } else pendingMatch = { id: number, at: now };
    }
    let seen = false;
    const evidence = () => {
      // A long silence (alt-tab, menus, queue) may or may not be a new match: the next own-hero read
      // or match number decides, since neither changes within a match.
      if (!seen && !gap && updatedAt !== null && now - updatedAt > MATCH_GAP_MS) gap = { heroId: leader(localVotes, LOCAL_MIN_VOTES) };
      seen = true;
    };
    const ownHero = (heroId: string, weight: number) => {
      evidence();
      if (gap) {
        const before = gap.heroId; gap = null;
        if (before !== null && before !== heroId) { clear(now); phase = 'match'; }
      }
      const current = leader(localVotes, LOCAL_MIN_VOTES);
      if (current !== null && current !== heroId && (localVotes.get(current) ?? 0) >= LOCAL_ESTABLISHED) {
        // Your own hero cannot change within a match: a steady different hero is a new match.
        challenger = challenger?.heroId === heroId ? { heroId, streak: challenger.streak + 1 } : { heroId, streak: 1 };
        if (challenger.streak >= NEW_HERO_STREAK) {
          const keep = matchId; clear(now); matchId = keep; phase = 'match';
          vote(localVotes, heroId, 2);
        }
        return;
      }
      challenger = null;
      vote(localVotes, heroId, weight);
    };
    if (cues.loading) {
      const hero = loadingHero(blocks);
      // The game names your hero outright.
      if (hero) ownHero(hero, 2);
    }
    for (const hero of context?.heroes ?? []) {
      if (!hero.heroId || hero.status !== 'recognized' || !(hero.confidence >= HERO_CONFIDENCE)) continue;
      if (hero.role === 'local') {
        // The bottom HUD shows the spectated player's abilities while you are dead or spectating.
        if (cues.spectating || hero.isLocal === false || cues.loading) continue;
        ownHero(hero.heroId, 1);
        continue;
      }
      // The top-bar portraits sit at the very top of the client.
      if (hero.bounds.y > 0.2) continue;
      const seat = seatAt(hero.bounds.x + hero.bounds.width / 2, aspect);
      if (seat !== null) { evidence(); vote(seatVotes[seat]!, hero.heroId); }
    }
    const ownSeats = new Set<number>(); const textHeroes = new Map<number, string>();
    for (const block of blocks) {
      if (block.bounds.y > 0.2) continue;
      // Scoreboard / draft header: hero names in small caps under each player name,
      // at ~150 px of 1080 in full-window captures (scoreboard and draft).
      if (block.bounds.y >= 0.125 && block.bounds.y <= 0.155) {
        const heroId = heroFromText(block.text);
        const seat = heroId ? seatAt(block.bounds.x + block.bounds.width / 2, aspect) : null;
        if (heroId && seat !== null) { evidence(); vote(seatVotes[seat]!, heroId); textHeroes.set(seat, heroId); continue; }
      }
      // Your own player name above a seat places you directly, even when your portrait is unread.
      const center = ownNameCenter(block);
      const seat = center === null ? null : seatAt(center, aspect);
      if (seat !== null) { evidence(); vote(localSeatVotes, seat); ownSeats.add(seat); }
    }
    // Your name with a hero name right under it, in the same read, is your hero.
    if (ownSeats.size === 1) {
      const heroId = textHeroes.get([...ownSeats][0]!);
      if (heroId) ownHero(heroId, 1);
    }
    if (seen) updatedAt = now;
  }

  function snapshot(): DraftRoster {
    if (phase === 'unknown') {
      return { seats: SEAT_CENTERS.map(() => null), localHeroId: null, localSide: null, localSeat: null, allies: [], enemies: [],
        matchId, updatedAt, epoch, phase, since };
    }
    const seats = seatVotes.map(votes => leader(votes));
    let localSeat = leader(localSeatVotes);
    // Your HUD/loading/name-and-hero reads first; otherwise the hero in the seat your name is above.
    const localHeroId = leader(localVotes, LOCAL_MIN_VOTES) ?? (localSeat !== null ? seats[localSeat] ?? null : null);
    if (localSeat === null && localHeroId !== null) {
      const at = seats.indexOf(localHeroId);
      if (at >= 0 && seats.lastIndexOf(localHeroId) === at) localSeat = at;
    }
    // Your seat shows your hero, even when its portrait was not recognized.
    if (localSeat !== null && localHeroId !== null && seats[localSeat] === null && !seats.includes(localHeroId)) seats[localSeat] = localHeroId;
    const left = seats.slice(0, 4); const right = seats.slice(4);
    let localSide: 0 | 1 | null = localSeat !== null ? (localSeat < 4 ? 0 : 1) : null;
    if (localSide === null && localHeroId !== null && !seats.includes(localHeroId)) {
      // Elimination: your hero is missing from the top bar, so yours is the unread portrait
      // on the side that still has one. A full side without your hero is the enemy team.
      const leftFull = left.every(Boolean), rightFull = right.every(Boolean);
      if (leftFull && !rightFull) localSide = 1;
      else if (rightFull && !leftFull) localSide = 0;
    }
    const own = localSide === 0 ? left : localSide === 1 ? right : [];
    const other = localSide === 0 ? right : localSide === 1 ? left : [];
    return { seats, localHeroId, localSide, localSeat, matchId, updatedAt, epoch, phase, since,
      allies: own.filter((hero): hero is string => !!hero && hero !== localHeroId),
      enemies: other.filter((hero): hero is string => !!hero) };
  }
  return { observe, snapshot, reset };
}

/**
 * The hero to show as yours. The roster tracker is authoritative once it exists: a hideout or
 * previous-match hero must never stand in for the current one. While the roster has not named one
 * yet, a participant-proven HUD hero from the match context counts only when it was observed during
 * the current match, then a hero label read on the current draft screen ("Playing as ...").
 */
export function currentLocalHero(roster: Pick<DraftRoster, 'localHeroId'> & Partial<Pick<DraftRoster, 'phase' | 'since'>> | null | undefined,
  contextHeroId: string | null | undefined, contextObservedAt: number | null | undefined, draftHeroId?: string | null): string | null {
  if (!roster) return contextHeroId ?? draftHeroId ?? null;
  if (roster.localHeroId) return roster.localHeroId;
  // Hideout, menus and queue: no current hero (the last match's stays in localHeroId above).
  if (roster.phase === 'outside') return null;
  const since = roster.since ?? null;
  const fresh = contextHeroId && since !== null && contextObservedAt != null && contextObservedAt >= since ? contextHeroId : null;
  return fresh ?? draftHeroId ?? null;
}
