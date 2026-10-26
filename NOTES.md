# 2026-10-26 first real Linux matches: draft reading fixed

- Measured on 14 saved draft frames from the 2026-10-26 matches: full-frame Tesseract read 14 of 33 cards and missed the SELECT ITEMS title on 4 frames, so cards showed 5-20 s late or never (log: median 5.5 s from draft to three cards). Windows OCR did not have this problem.
- Fix (`Program.cs` `ReadDraftLabels`, coverage bit 32): the magenta CHOICE N OF 3 label proves a draft by pixels (about 15% of its box on every draft frame, 0 elsewhere); then the label, the title, each card's name row (white text isolated, 2x) and the blue ENHANCED row are OCR'd on their own. Fixed labels are emitted in canonical spelling and replace OCR noise on their row (a "SELECT ITEMS ree" merge hid the draft). Result: 33/33 cards on the draft frames, all 7 other draft frames found, no false drafts on 39 non-draft frames; about +50-70 ms per draft read. Regression test: `tests/draft-cards-native.test.ts` with cropped real frames in `tests/fixtures/draft-cards`.
- Pick model checked (split-window test on the API, 8 heroes): shrunk per-hero item deltas correlate 0.92 between 09-29..10-13 and 10-13..now; following them is worth about +1.4 win-rate points per pick over a random card. Round-aware stats gave no gain; the API refuses badge filters for Street Brawl. Model left as is.
- Idle "Waiting for Deadlock" probes are logged once a minute (they rotated a whole evening of match logs out overnight).
- `scripts/replay-frames.ts` runs on Linux and prints variant/rare/bonus flags.
- Not verified on real frames: Bonus! cards (no saved frame had one). Legendary items are in the catalog, icons and win-rate data.
- `tests/replay/real-draft-replay.test.ts` fails on this machine only because `optimization/captures` (Windows-local evidence) is absent.

# 2026-10-24 Linux port (Hyprland)

Goal: run on Omarchy/Hyprland 0.56 with Deadlock under Proton. Nothing committed.

- Native: `ReaderPlatform` csproj switch; Tesseract engine, Hyprland/grim capture, SkiaSharp `System.Drawing` shim (see native/ScreenReader/README.md). All native tests pass on Linux, including the 27 real-frame ability-panel tests; draft OCR ~110 ms, full scoreboard ~300 ms.
- Electron: overlay placed by a runtime Hyprland Lua window rule (`electron/hyprland.ts`; `move` is monitor-relative, so the rule names the game's monitor); the overlay window is created at the game size because Hyprland keeps a non-resizable window's creation size. Signal handlers installed after `ready` replace Chromium's, which stopped the loop without cleanup. Reader updates are ignored once quitting (a queued update used to hit the destroyed tray: "Tray is destroyed" dialog, also possible on Windows).
- Local identity reads Steam's `loginusers.vdf` from `~/.steam/steam`, `~/.local/share/Steam` or the Flatpak path.
- Packaging: `npm run package:linux` → `release/linux-unpacked`, `./start-companion.sh`; verify-package passes.
- Verified with a stand-in window (class `steam_app_1422450` showing a synthetic draft): offers read, pick shown, overlay matches the game rect on both monitors without taking focus, SIGTERM/SIGINT/SIGHUP quit in ~50 ms.

- 2026-10-25 overlay offset fix: Chromium multiplied GNOME `text-scaling-factor` (0.9091 here) into its device scale (dpr 0.90625), so the overlay page filled only the top-left 1740×980 of its 1920×1080 window and the marks sat up and left. Startup now forces `force-device-scale-factor` to the Hyprland monitors' shared scale (`hyprlandDeviceScale`); `--disable-features=WaylandUiScale` has no effect in Electron 44. Mixed-scale setups are left alone (unverified there), and the main window now ignores the desktop text scale on Linux too.

Open: not yet tried with the real game. Check that the overlay shows above a fullscreen Deadlock (no rule field for above-fullscreen; borderless windowed is the safe setting), the toplevel copy of the Proton/XWayland game window, and OCR accuracy on live frames. `refresh-patch.mjs` has only been run on Windows.

# 2026-10-18 review round (multi-agent), packaged 2026-10-18 ~21:10 local

Reviewers audited the 3 live matches of 2026-10-18, the native diff and pick logic/UI; fixes were then independently reviewed and the confirmed findings fixed. 1015 tests pass, verify-package passed. Pre-session snapshot: dangling commit 18277596c13b69ba24273278dd0e1d4f02592ac5. Nothing committed.

- Picks: win rates from the current patch window only (`STREET_BRAWL_PATCH_START` = 2026-09-29 in street-brawl-fetch.ts, clamped 14-45 days, 90-day fallback for thin heroes; move it after a major patch, refresh-patch.mjs reminds). Per-hero item stats shrunk toward the all-hero result; Valve "Good" list is a fading prior; reroll = exact best-of-3 expectation + DP over choices/rerolls left (counts the random-hero extra reroll); measured Enhanced uplift; Bonus! valued once; card `edge`/`tierPercentile` derive from the pick score, so the pick always has the top edge; downloads missing item/hero data for >20% of heroes are rejected.
- Detection: ability ranks accept one trustworthy full read; round +1 inference after combat (prev draft within 5 min), max 5, 3 lower reads correct a misread, round/score reset on new match (`forgetMatchRound`); fuzzy BONUS!; "UPGRADES TO/FROM" tooltip lines dropped; shown card replaced only after 2 reads; cards shown as they deal in; leaving pick hidden and credited (two reads, same slot), incl. the third pick at draft close; post-match screens end the match, 3 s menu cadence, no frames outside matches.
- Native: AP counter by teal glyph shape (`ReadApCounter`), round pips (`ReadRoundPips`, only with pixel-proven title; match-parser accepts them without the OCR title), unfocused-but-visible game read as ok + Foreground=false, menu no longer read as scoreboard, Tab read ~150 -> ~80 ms, seat-grid median offset fixed.
- UI: edge chips (+2.4 vs tier average, Top N% of tier), absolute fit bars, Choice N/3 + rerolls and round score in the strip, Enemy threat panel between drafts (src/shared/enemy-threat.ts), "Hope to draft" only this/next tier, overlay auto "Spend N AP" prompt during drafts, "Counters X (+2.1)." wording, shared draft tiers (src/shared/draft-tiers.ts).
- Demo mode fully removed (src/demo deleted; core/scoring tag baseline always withholds in live).

Open: AP above 0 barely tested on real frames; Tab per-player rank pips not read; overlay AP prompt only during drafts (no "upgrade panel open" signal yet); thin heroes' own item rows still use the 90-day window.

# Work notes: patch 6794 / Violet update and v0.5.0 overhaul (Oct 2026)

Goal: update for client 6794 (Violet), then audit and improve detection (ability ranks first), lag, logic and the interface.

## Done
- Data refreshed to client 6794 (Violet = hero_artist). `node scripts/refresh-patch.mjs` does the whole refresh, including repinning screen-advice base facts.
- Features: ability grid with the plan path, AP affordability and a "Then" chain with tiers; hero matchups on enemy seats; toughest matchup; per-tier "Hope to draft"; "Reroll for …" hopes; build category split; hero win rate; version in About.
- Dev preview: `npm run dev`, then `?sample=pick|imbue|close|reroll|reading|between|partial|waiting|background|paused` (dev only; re-stamped every second).

### Detection
- Ability ranks (`src/screen/ability-ranks.ts`): per-column confirmation (2 agreeing of the last 4), draft reads never lower a rank, lowering needs 3 consecutive Tab reads, instant accept only when spend + AP counter on the same frame equals the round budget (6/12/17/22/32). Columns covered by the cursor/tooltip arrive as null and show "Not read yet" in the grid.
- Bottom strip is read at read spacing while the upgrade panel is up (`panelReadDue`).
- Spectator guard: own items/ranks are not taken while dead/spectating (+4 s grace); "Respawn in", "Spectating", "Next/Previous player" are death-screen cues.
- Roster: post-match/menu cues updated; stale loading ends on a menu cue; an alt-tab gap keeps the match, a new own hero after a gap starts a new one; seat positions handle ultrawide.
- Card parser: tooltip stat lines are not card names; unmarked cards are "base" (not "unknown"); reroll label misreads; ultrawide column geometry.
- Match is only dropped after 15 s without the game (`GAME_GONE_MS`); "Joining the fight" triggers an early full read for the hero.

### Picks (pick-logic agent)
- Counters use the residual (per-enemy delta minus the shrunk general delta), ±0.5 pt noise band, ±1.5 pt label threshold. Wording: "Does well/poorly against X: +2.3 points over its usual win rate."
- Reroll: exact percentile of the best card among random drafts of that tier for this hero and enemies. Bars at the three-choice break-even points: choice 1 → 25th, 2 → 30th, 3 → 45th, unknown → 30th. The reader passes the "Choice N of 3" label (`rerolls.stage`, cleared at round change and draft close).
- Hedging text removed; owned cards are never the pick while another card is readable.

### Lag
- `main.ts` coalesces reader states to one IPC message per tick; `publish()` skips no-op patches; overlay only gets state while shown.
- Drafts read at 250 ms / 50% duty (normal 500 ms / 30%); the first card read after a draft appears waits only for the draft duty floor.
- Helper spawned with `DOTNET_GCgen0size=0x1000000` (240 → 136 MB); stdout line scan only searches new text; preview base64 check by round trip.
- No diagnostic screenshot in the first 3 s of a draft.

### Data refresh guard
- `isStreetBrawlData` rejects downloads where fewer than 80% of heroes have ability orders and enemy-item results.

## Packaged 2026-10-17 (v0.5.0)
- `release/win-unpacked/Street Brawl Companion.exe`, verify-package passed, 931 tests pass.
- Packaging needed `-c.electronDist=node_modules/electron/dist`: the normal run fails with EPERM renaming `win-unpacked.tmp` (something on the machine briefly locks freshly unpacked Electron files).

## Open
- Native agent was stopped mid-task (it was restructuring scoreboard seat corners to use the median of measured seats). Its native source edits so far are in the working tree and the shipped helper was rebuilt from them; all native tests pass. Review its diff in `native/ScreenReader/*.cs` (per-column `abilityRanks` with nulls, hue-classified pills, 8 scoreboard rows, csproj memory settings) before continuing.
- Score pips (B16): the match strip's score is never filled. The HUD shows two pips per side under "ROUND N" (frame 1800x1012: y ≈ 0.077, x ≈ 0.471/0.484 | 0.514/0.528; filled = cream). Needs a native pixel sample anchored on the ROUND block.
- Deferred: participant path is dead code (B7); data window includes pre-patch games (B12); draft title/card probes (L4/L5).

## Verify after the next real match
- `Documents\Street Brawl Companion\diagnostics\reader-log.jsonl`: ranks match the panel (incl. last upgrade), no spectator items, full enemy item lists, `choice` in advice notes, cards shown within ~0.5 s of the draft opening.
