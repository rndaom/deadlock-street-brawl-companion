# Deadlock Street Brawl Companion

A Windows and Linux (Hyprland) companion for Deadlock's **Street Brawl** mode. It reads what is visible on your game screen and, when the **Select Items** draft opens, tells you which of the three cards to take (or when to reroll), using real Street Brawl win rates, your hero, your build and the enemy team.

Unofficial fan tool: not affiliated with or endorsed by Valve. Deadlock, its names and art belong to Valve. Statistics and game data come from the community [deadlock-api.com](https://deadlock-api.com).

## Download

Get the latest version from the [Releases page](https://github.com/rndaom/deadlock-street-brawl-companion/releases/latest):

- **Windows:** `Street-Brawl-Companion-Setup-<version>.exe`, a one-click installer (no admin rights needed).
- **Linux:** `Street-Brawl-Companion-<version>-x86_64.AppImage`. Make it executable (`chmod +x`) and run it. See [Linux](#linux) for the system packages it needs.

**Updates are automatic.** The installed app checks for a new release when it starts and every few hours, downloads it in the background and installs it the next time you quit the companion. When an update is ready, a notification and the tray menu offer **Restart to update** to install it right away. The Windows zip and unpacked Linux folders from before 0.7.0 don't update themselves; install from the links above once.

## Windows 11 quick start

What you need: Windows 10 (2004) or Windows 11, 64-bit; Deadlock in **English**; and the English text-recognition (OCR) feature, which every English Windows install already has. On a non-English Windows, add it in **Settings → Time & language → Language & region → Add a language → English (United States)** (the "Optical character recognition" feature is enough). No other installs are needed.

1. Download `Street-Brawl-Companion-Setup-<version>.exe` from the [latest release](https://github.com/rndaom/deadlock-street-brawl-companion/releases/latest).
2. Run it. The app is not code-signed, so Windows SmartScreen may say "Windows protected your PC": click **More info → Run anyway**. You only need to do this once; it installs for your user account, starts the companion and adds Start menu and desktop shortcuts.
3. Put the companion on your second monitor (or keep it beside the game). Run Deadlock in **borderless windowed** display mode and click back into the game.
4. Play a Street Brawl match. Within a second or two of a draft opening, the companion shows:
   - **the pick panel**: the card to take, its win rate on your hero, why, and whether to reroll;
   - **the three cards** in game order (left, middle, right);
   - **your build**: items, ability ranks and the next ability upgrade players usually take;
   - **the enemy team and your team** with the items read from the scoreboard.
5. At a safe moment, hold **Tab** for a few seconds so the companion can read both teams' items. It works out which team you are on from your Steam name and your hero, so enemy counters and enemy items feed the pick.

The companion only looks at your screen, like a screenshot tool. It never reads game memory, never touches game files and never sends input to the game. It needs the internet only to refresh its win-rate data once a day, and works offline with the data it ships with.

**Remove or reset it:** close it from its tray icon, then uninstall **Street Brawl Companion** in **Settings → Apps**. Settings live in `%APPDATA%\deadlock-street-brawl-companion` and logs in `Documents\Street Brawl Companion`; delete those too to reset it fully.

See the [short game-test guide](docs/game-test-guide.md) for troubleshooting.

### From this repository

Double-click **Start Companion.cmd** after packaging (it starts `release/win-unpacked/Street Brawl Companion.exe`; keep the whole `win-unpacked` folder together). On Linux, run `./start-companion.sh` (it starts `release/linux-unpacked/street-brawl-companion`), or run `scripts/install-desktop-entry.sh` once to add **Street Brawl Companion** to the app launcher (`--remove` takes it out again).

### Linux

The Linux build runs on a **Hyprland** session (0.55 or newer, Lua configuration) with Deadlock under Proton. It needs these system packages (Arch names):

```bash
sudo pacman -S --needed tesseract tesseract-data-eng grim fuse2
```

- `fuse2` provides `libfuse.so.2`, which the AppImage needs to start; without it the AppImage exits with `dlopen(): error loading libfuse.so.2`. Systems with only `fuse3` don't have it.

- The reader copies the game window's own buffer with `grim -T`, so other windows, the bar or notifications on top of the game do not stop it. If that copy is unavailable it falls back to copying the screen area, which needs the game uncovered, as on Windows.
- The in-game overlay is placed by a runtime Hyprland window rule (floating, pinned, never focused). The rule disappears on the next config reload; the companion adds it again when it next shows the overlay.
- Other Wayland compositors and X11 sessions are not supported yet: the reader finds the game through Hyprland's IPC socket.

## How it works

- A small native reader (`native/ScreenReader`, C#) captures the game window, runs Windows OCR (Tesseract on Linux) and matches item/hero icons. It runs at below-normal priority on one CPU core and only reads while Deadlock is in front and uncovered. No input is ever sent to the game.
- `src/screen/` turns reads into the draft cards, the match roster (`draft-roster.ts`), your build (`build-tracker.ts`) and the pick (`screen-advice.ts`, `street-brawl-fit.ts`).
- Street Brawl win rates, Valve's per-hero item lists, counter stats and ability-upgrade orders come from the public deadlock-api. A snapshot ships with the app and is refreshed in the background once a day.
- `src/renderer/` is the React interface.

## Diagnostics

Every read is logged to `Documents\Street Brawl Companion\diagnostics\reader-log.jsonl` (`~/Documents/Street Brawl Companion/diagnostics` on Linux), and recent draft screenshots go to `diagnostics\frames`. Nothing leaves your computer. Saved frames can be replayed offline through the reader and pick logic:

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

On Linux, install the .NET 10 SDK (from your distribution, or `dotnet-install.sh` into `~/.dotnet`, which the build finds by itself) and the packages above, then:

```bash
npm ci
npm run reader:build
npm run package:linux
```

The Linux build keeps the shipped icon descriptors, which are prepared on Windows, while they still match the icons. `npm run reader:build -- --descriptors` rebuilds them on Linux instead.

### Releases

To publish a version, raise `version` in `package.json` (for example 0.7.0 → 0.7.1) and push or merge that to `main`. The [Release workflow](.github/workflows/release.yml) sees a version with no release yet, builds the Windows installer on Windows and the AppImage on Linux, and publishes both as release `v<version>` along with `latest.yml` and `latest-linux.yml`, the files installed copies read to find updates. Pushes that don't change the version publish nothing. Don't delete those `.yml` files from a release, and don't mark a release as a pre-release, or installed copies won't see it.

Locally, `npm run package:win` builds `release/Street-Brawl-Companion-Setup-<version>.exe` (on Windows; on Linux the NSIS installer needs Wine) and `npm run package:appimage` builds the AppImage. `npm run package:dir` builds only the Windows folder, which can be cross-built on Linux: the Windows reader is cross-built with `-p:ReaderPlatform=windows`. `node scripts/verify-package.mjs release/win-unpacked` checks the result, including that the reader inside is a Windows executable. Nothing is code-signed, so first-time Windows users see SmartScreen's "More info → Run anyway".

The packaged app includes its self-contained reader and needs no .NET SDK. `npm start` opens the built desktop app, `npm run dev` serves a browser preview of the interface (it cannot read the game; add `?sample=pick`, `?sample=between`, `?sample=reroll` … to see it with sample match data, or `&view=overlay&panel` for the in-game overlay), and `npm test` runs the checks.

## After a Deadlock patch or a new hero

One command fetches the new heroes, items, ability art and Street Brawl statistics, repins every source and rebuilds the reader's templates:

```powershell
node scripts/refresh-patch.mjs
npm test
npm run package:win
```

Close the companion before packaging. Win rates, matchups and upgrade orders also refresh on their own once a day while the app runs; only new heroes or items need the command above.

## More

- [Implementation status](docs/implementation-status.md)
- [Screen-reading verification](docs/screen-reading-verification.md)
- [Performance limits and measurements](docs/performance.md)
- [Desktop development](docs/desktop-development.md)
- [Research evidence](docs/research-evidence.md)
