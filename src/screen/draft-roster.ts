import type { Catalog } from '../shared/types';
import type { CaptureRegion, NativeScreenContext } from '../shared/screen-reading';

/**
 * Who is in the current Street Brawl match, accumulated over many reads.
 * Seats 0-3 are the left top-bar team and 4-7 the right team. Your own team is found from,
 * in order: your Steam name above a top-bar seat, the hero shown in your own HUD appearing in
 * the top bar, or (when your own portrait is the one that was not recognized) elimination.
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
}
interface TextBlock { text: string; bounds: CaptureRegion }
export interface RosterOptions {
  /** Your own display names (Steam persona), matched against the player names above the top bar. */
  localPlayerNames?: readonly string[];
}

/** Street Brawl top-bar portrait/name centers at 1920 px wide (4 players per side). */
const SEAT_CENTERS = [550, 638, 726, 814, 1106, 1194, 1282, 1370].map(x => x / 1920);
const SEAT_TOLERANCE = 0.03;
/** Votes needed before a seat or own hero is trusted; older votes fade so a new match takes over. */
// Two agreeing reads (1 + 0.97 after fading) are enough.
const MIN_VOTES = 1.9;
const DECAY = 0.97;
const HERO_CONFIDENCE = 0.9;
/** Consecutive confident reads of a different own hero that mean a new match has started. */
const NEW_HERO_STREAK = 4;
/** No top-bar evidence for this long (menus, queue, loading) means the next one is a new match. */
export const MATCH_GAP_MS = 180_000;

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
function seatAt(centerX: number): number | null {
  let best: number | null = null; let gap = SEAT_TOLERANCE;
  SEAT_CENTERS.forEach((center, seat) => { const d = Math.abs(center - centerX); if (d <= gap) { gap = d; best = seat; } });
  return best;
}
/** "MATCH: 111230189" anywhere, or the bare footer number in the bottom-right corner. */
function matchNumber(block: TextBlock): string | null {
  const labelled = block.text.match(/MATCH[:;]?\s*([\d-]{6,})/i)?.[1]?.replace(/-/g, '');
  if (labelled) return labelled;
  if (block.bounds.y > 0.93 && block.bounds.x > 0.8) return block.text.trim().match(/^\D{0,8}(\d{8,11})$/)?.[1] ?? null;
  return null;
}

export function createRosterTracker(catalog: Catalog, options: RosterOptions = {}) {
  const heroNames = catalog.heroes.map(hero => ({ id: hero.id, key: letters(hero.name) })).filter(hero => hero.key.length >= 3);
  const ownNames = [...new Set((options.localPlayerNames ?? []).map(nameKey).filter(key => key.length >= 3 && key.length <= 32))];
  let seatVotes: Map<string, number>[] = SEAT_CENTERS.map(() => new Map());
  let localVotes = new Map<string, number>();
  let localSeatVotes = new Map<number, number>();
  let challenger: { heroId: string; streak: number } | null = null;
  let matchId: string | null = null;
  let updatedAt: number | null = null;
  let epoch = 0;

  function reset() {
    seatVotes = SEAT_CENTERS.map(() => new Map()); localVotes = new Map(); localSeatVotes = new Map();
    challenger = null; matchId = null; updatedAt = null; epoch++;
  }
  function vote<K>(votes: Map<K, number>, key: K) {
    for (const [other, value] of votes) votes.set(other, value * DECAY);
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  function leader<K>(votes: Map<K, number>): K | null {
    let best: K | null = null; let score = MIN_VOTES - 1e-9;
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

  /** Feed one full-client read: native hero matches and the OCR text (full-client bounds). */
  function observe(context: NativeScreenContext | undefined, blocks: readonly TextBlock[], now: number) {
    const match = blocks.map(matchNumber).find(Boolean) ?? null;
    // The small footer digits are misread now and then (111221552 vs 111221352): only a
    // clearly different number means a new match.
    if (match && matchId && distance(match, matchId) > 2) reset();
    if (match && (!matchId || distance(match, matchId) > 2)) matchId = match;
    let seen = false;
    const evidence = () => {
      // A long silence (menus, queue, loading screen) ends the old match's roster.
      if (!seen && updatedAt !== null && now - updatedAt > MATCH_GAP_MS) { reset(); matchId = match; }
      seen = true;
    };
    for (const hero of context?.heroes ?? []) {
      if (!hero.heroId || hero.status !== 'recognized' || !(hero.confidence >= HERO_CONFIDENCE)) continue;
      if (hero.role === 'local') {
        evidence();
        const current = leader(localVotes);
        if (current !== null && current !== hero.heroId) {
          // Your own hero cannot change within a match: a steady different hero is a new match.
          challenger = challenger?.heroId === hero.heroId ? { heroId: hero.heroId, streak: challenger.streak + 1 } : { heroId: hero.heroId, streak: 1 };
          if (challenger.streak >= NEW_HERO_STREAK) {
            reset(); matchId = match;
            vote(localVotes, hero.heroId); vote(localVotes, hero.heroId);
          }
          continue;
        }
        challenger = null;
        vote(localVotes, hero.heroId);
        continue;
      }
      // The top-bar portraits sit at the very top of the client.
      if (hero.bounds.y > 0.2) continue;
      const seat = seatAt(hero.bounds.x + hero.bounds.width / 2);
      if (seat !== null) { evidence(); vote(seatVotes[seat]!, hero.heroId); }
    }
    for (const block of blocks) {
      if (block.bounds.y > 0.2) continue;
      // Scoreboard / draft header: hero names in small caps under each player name,
      // at ~150 px of 1080 in full-window captures (scoreboard and draft).
      if (block.bounds.y >= 0.125 && block.bounds.y <= 0.155) {
        const heroId = heroFromText(block.text);
        const seat = heroId ? seatAt(block.bounds.x + block.bounds.width / 2) : null;
        if (heroId && seat !== null) { evidence(); vote(seatVotes[seat]!, heroId); continue; }
      }
      // Your own player name above a seat places you directly, even when your portrait is unread.
      const center = ownNameCenter(block);
      const seat = center === null ? null : seatAt(center);
      if (seat !== null) { evidence(); vote(localSeatVotes, seat); }
    }
    if (seen) updatedAt = now;
  }

  function snapshot(): DraftRoster {
    const seats = seatVotes.map(leader);
    const localHeroId = leader(localVotes);
    let localSeat = leader(localSeatVotes);
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
    return { seats, localHeroId, localSide, localSeat, matchId, updatedAt, epoch,
      allies: own.filter((hero): hero is string => !!hero && hero !== localHeroId),
      enemies: other.filter((hero): hero is string => !!hero) };
  }
  return { observe, snapshot, reset };
}
