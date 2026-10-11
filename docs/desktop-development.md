# Desktop development

This build contains a local Windows desktop companion with actual screen reading, a clearly labelled synthetic preview, and a separate defensive adapter for the documented Overwolf Electron Deadlock feed. Ordinary Electron can read the visible draft without provider credentials. The original provider/full-tracking gates in [automatic-telemetry-proof.md](automatic-telemetry-proof.md) remain open; the image route follows the user's later explicit authorization and provides limited visible-offer comparisons.

## Run the local application

Use a current Node.js release supported by the pinned build tools and the .NET 10 SDK on Windows. From the repository root:

```powershell
npm ci
npm run build
npm start
```

The companion always runs Live with automatic screen reading; there is no demo mode. The packaged version includes its self-contained native helper and requires no SDK. Keep Deadlock in the foreground and uncovered; capture pauses when its window cannot be safely read. Sample reader states for interface tests live in `tests/sample-states.ts`.

`npm run dev` serves a browser preview for frontend work. The desktop application always loads the built local UI; rebuild after source edits. `npm run typecheck` checks the TypeScript boundary, and `npm test` checks the normalized state/provider contracts. These checks cannot establish real-game field availability or timing.

The build produces `dist/index.html`, `dist-electron/main.js`, a bundled sandbox-compatible `dist-electron/preload.cjs`, and `native/ScreenReader/publish/ScreenReader.exe`. The public icon cache is checked offline. `npm run package:dir` creates an unsigned ordinary Electron game-test directory with the helper under `resources/screen-reader` and all 173 icons under `resources/reader-icons`. It does not provide distributed Overwolf game-package access; that separate provider path is optional for this image-based test.

The helper uses installed Windows OCR, a bounded GDI client-region capture, and cached public icon templates. Requests/responses use a validated JSONL pipe. It runs at below-normal priority with one logical CPU; there is one in-flight job, no queue, and a confirmed process-exit barrier on cancellation. Readings, pixels, and requested previews stay in memory. See [screen verification](screen-reading-verification.md) and [performance](performance.md).

## Supported runtime integration

The optional provider profile starts the pinned Overwolf Electron runtime:

```powershell
npm run start:overwolf
```

The package declaration contains only:

```json
{ "overwolf": { "packages": ["gep"] } }
```

The provider reads `app.overwolf.packages.gep`. It registers `gep_internal`, `game_info`, and `match_info` for game ID `24482`, subscribes before registration, enables only detected Deadlock, and hydrates through `getInfo(24482)`. Registration has five attempts with bounded request timeouts. Game exit, package crashes, provider errors, changed matches, and changed local identity clear the old state. Late hydration/registration results from an obsolete session cannot repopulate it. See [the exact API findings](provider-integration.md) and the [GEP package reference](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/gep/interfaces/OverwolfGameEventPackage/).

A running Overwolf executable does not establish game-package access. Current dev mode requires approved developer credentials supplied through the provider's supported environment setup. The application does not load a credential file, inspect secret values, or expose credentials to its renderer or diagnostics. See [Overwolf Dev Mode](https://dev.overwolf.com/ow-electron/guides/dev-tools/dev-mode/).

Use the public provider package channel. Change channels only under provider guidance. Signed distribution and the supported provider release process are separate work requiring an approved app, registered identity, and the owner's signing setup; none is configured by this prototype. See [release requirements](https://dev.overwolf.com/ow-electron/getting-started/release-your-app/) and [package channels](https://dev.overwolf.com/ow-electron/guides/dev-tools/package-channels/).

## What the adapter represents

Published match IDs, team scores, global phases, seat-keyed hero rosters, and purchased-item history are normalized in memory. Original provider slots `0–11` are preserved, including sparse eight-player rosters. Steam IDs remain strings; bot/blank identifiers do not merge seats. Normal-mode rosters are outside this application's eight-player scope. A ninth distinct player clears the entire promoted roster, with an explicit scope message. No roster is truncated to resemble Street Brawl.

The published GEP mode example documents `Normal`, but does not enumerate a Street Brawl token. Other values remain unknown; REST/replay mode enums are not assumed to apply. Global `GameInProgress` does not become a Street Brawl round or draft deadline. Roster and purchased-history completeness remain unknown/partial. Names, enhancement flags, and undecoded purchase upgrade bits stay separate from confirmed inventory. No ownership, deletion, ability ranks, offers, reroll budgets, corruption opportunities, or current build is inferred from these fields. See [the published Deadlock contract](https://dev.overwolf.com/ow-electron/live-game-data-gep/supported-games/deadlock/).

Hydration has no mapped origin clock or documented maximum upstream delay. Observation sequence numbers order local normalized callbacks only. They do not prove an upstream watermark, continuous delivery, or true source freshness. All real-match capability verification flags and the no-image-method verification flag remain false. Dependent live advice remains withheld.

## Window, privacy, and IPC

The initial window prefers a secondary portrait monitor, then another portrait display, then the primary display. Settings select an available monitor and adjust text size, name visibility, and always-on-top behavior. Electron reports display/work-area bounds in logical units. Monitor removal and DPI/work-area changes move or clamp the window without focusing it. Provider updates send state only; they never activate the window. Showing the app from the tray or relaunching it is an explicit user action. Closing the desktop window quits the application.

The renderer uses an in-memory Electron session, context isolation, sandboxing, and a fixed `window.companion` bridge. Every IPC request must come from the application's main frame at `companion://app/index.html`. Settings, mode, demo IDs, and selected display IDs are validated. Renderer requests cannot choose IPC channels, filesystem paths, shell commands, or provider methods.

The custom local protocol serves only files beneath `dist` with a content security policy. Remote scripts, frames, navigation, new windows, webviews, and permissions are denied. Public static images use only origins present in the bundled catalogue. See [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [protocol API](https://www.electronjs.org/docs/latest/api/protocol), and [display API](https://www.electronjs.org/docs/latest/api/screen).

Display/interface preferences are saved to Electron's user-data `settings.json`; reader enablement and crop geometry are saved separately to `reader-settings.json`. Both writes are atomic. Match state, game images, OCR text, and provider payloads are never archived by the application. The export button opens a native save dialog for allowlisted aggregate diagnostics: capability flags, source health, catalogue versions, timing availability, reader status/resource counters, and operational counters. It excludes player identifiers, match IDs, seat IDs, item choices, game images, and raw events. The application includes no custom process hooks, gameplay automation, or provider outreach.

## Hardware and participant validation still needed

Verify a real Windows session with a second portrait display, 720 × 1280 logical workspace, mixed DPI scaling, unplug/reconnect, and focus during gameplay. Then follow the research's participant discovery procedure, including startup during a match, restart, errors, game exit, and a new match. Record a human-authored capability/test summary and permitted aggregate timings. Unknown source age cannot be reported as measured game-change-to-advice latency.
