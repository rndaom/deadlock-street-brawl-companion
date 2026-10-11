# Deadlock Street Brawl Companion

A Windows companion for Deadlock's **Street Brawl** mode. It reads what is visible on your game screen and, when the **Select Items** draft opens, tells you which of the three cards to take (or when to reroll), using real Street Brawl win rates, your hero, your build and the enemy team.

## Use it

1. Double-click **Start Companion.cmd** (or `release/win-unpacked/Street Brawl Companion.exe`; keep the whole `win-unpacked` folder together).
2. Put the companion on your second monitor. Run Deadlock in **borderless windowed** mode with the English interface, and click back into the game.
3. Play normally. Within a second or two of a draft opening, the companion shows:
   - **the pick panel**: the card to take, its win rate on your hero, why, and whether to reroll;
   - **the three cards** in game order (left, middle, right);
   - **your build**: items, ability ranks and the next ability upgrade players usually take;
   - **the enemy team and your team** with the items read from the scoreboard.
4. At a safe moment, hold **Tab** for a few seconds so the companion can read both teams' items. It works out which team you are on from your Steam name and your hero, so enemy counters and enemy items feed the pick.

See the [short game-test guide](docs/game-test-guide.md) for troubleshooting.

## How it works

- A small native reader (`native/ScreenReader`, C#) captures the game window, runs Windows OCR and matches item/hero icons. It runs at below-normal priority on one CPU core and only reads while Deadlock is in front and uncovered. No input is ever sent to the game.
- `src/screen/` turns reads into the draft cards, the match roster (`draft-roster.ts`), your build (`build-tracker.ts`) and the pick (`screen-advice.ts`, `street-brawl-fit.ts`).
- Street Brawl win rates, Valve's per-hero item lists, counter stats and ability-upgrade orders come from the public deadlock-api. A snapshot ships with the app and is refreshed in the background once a day.
- `src/renderer/` is the React interface.

## Diagnostics

Every read is logged to `Documents\Street Brawl Companion\diagnostics\reader-log.jsonl`, and recent draft screenshots go to `diagnostics\frames`. Nothing leaves your computer. Saved frames can be replayed offline through the reader and pick logic:

```powershell
npx esbuild scripts/replay-frames.ts --bundle --platform=node --format=esm --outfile=replay.mjs
$env:LOCAL_NAMES = "<your Steam name>"; node replay.mjs "<path to frames>\draft-*.png"
```

## Build from source

Requires Node and the .NET 10 SDK on Windows:

```powershell
npm ci
npm run package:dir
```

The packaged app includes its self-contained reader and needs no .NET SDK. `npm start` opens the built desktop app, `npm run dev` serves a browser preview of the interface (it cannot read the game), and `npm test` runs the checks.

## More

- [Implementation status](docs/implementation-status.md)
- [Screen-reading verification](docs/screen-reading-verification.md)
- [Performance limits and measurements](docs/performance.md)
- [Desktop development](docs/desktop-development.md)
- [Research evidence](docs/research-evidence.md)
