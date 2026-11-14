# Match audit

`scripts/audit-match.mjs` compares what the companion read during a Street Brawl match with the finished match record from the public deadlock-api. It only reads: it writes no files and sends nothing but one request for the match record (none with `--match-json`).

```
node scripts/audit-match.mjs <matchId> [--log <reader-log.jsonl>] [--match-json <record.json>] [--player <account id>]
                             [--catalog <public-catalog.json>] [--slack <seconds>] [--all-log]
```

- `<matchId>`: the match to fetch (`GET /v1/matches/{id}/metadata`, no key). A record shows up a few minutes after the match ends. May be left out when `--match-json` is given.
- `--match-json`: a saved copy of that response (also accepts one element of the bulk `/v1/matches/metadata` array). Works offline.
- `--log`: default `~/Documents/Street Brawl Companion/diagnostics/reader-log.jsonl` (on Windows `Documents\Street Brawl Companion\diagnostics`). The log keeps several matches, so only entries from 5 minutes before the record's start to 5 minutes after its end are used; change that with `--slack`, or use the whole file with `--all-log`.
- `--player`: your account id. Without it the audit takes the hero the log's roster read as yours and uses the single player in the record playing that hero; if that is not unique it asks for `--player`.

## What the record gives, and what it does not

It has the game mode (4 / `StreetBrawl`), start time, duration, team score, per-round winners and durations, and for every player the items bought with their game time (and sell time). It has no offers: the cards that were on screen are not recorded anywhere. So the audit can say what was taken, never what was offered.

## How it pairs things up

- The log's draft reads are voted into card sets (three cards until they change), sets with the same "Choice N of 3" in one round are one choice (a reroll), and choices are grouped into drafts by round, stage order and time gaps.
- The record's catalogue items for you are grouped into drafts by time gaps (a draft's picks are seconds apart, drafts minutes). Abilities and ids missing from the catalogue are skipped, so refresh `data/public-catalog.json` for a new patch before auditing a match from it.
- Drafts pair in order. Inside a draft, choice N is pick N when the counts agree; otherwise the audit pairs by card and says so.

## Report

For each draft and choice: the cards read (`?` is unread), the recommended card, the item taken, and one of:

- took the recommended card / took a different card than recommended / no recommendation shown;
- **took an item that is not among the three cards read**: all three cards were read and none is what you took, so a read is wrong. Listed again under "Reads the record contradicts";
- took an item not among the cards read, but a card was unread: not a contradiction, the unread card may be it.

The contradiction list also names a pick the reader credited (`pick` in the log) that differs from the record, and read names the catalogue does not know. Totals: drafts, choices, taken-item-among-cards, recommended-card-taken, contradicted, unresolved and unread cards.

## Limits

- A reroll whose "Choice N of 3" was never read counts as a separate choice, which shows as a count mismatch.
- A taken item from a card the reader never saw at all (no read, or a choice missed entirely) shows as a count mismatch, not as a wrong read.
- Enhanced copies share the item id with the plain item, so the audit does not check Enhanced state.

The logic is in `scripts/lib/match-audit.mjs` (pure, no I/O) and tested by `tests/match-audit.test.ts` with an invented log and record.
