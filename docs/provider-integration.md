# Provider integration findings

Checked October 3, 2026 against the current primary Overwolf documentation and public package metadata. No provider message, proposal submission, game attachment, capture, or participant test was performed.

The documented feed can support an automatic diagnostic companion. It does **not** currently establish automatic Street Brawl offer recommendations. The missing-event gate in [automatic-telemetry-proof.md](automatic-telemetry-proof.md) still applies.

## Runtime and access

Overwolf Electron is a standalone Electron fork; Overwolf Native depends on the Overwolf client. An ordinary Electron development build can render the same local UI, but has no Overwolf GEP access. The selected product path is a Windows desktop window using the provider-managed GEP package. [Framework comparison](https://dev.overwolf.com/ow-electron/getting-started/onboarding-resources/frameworks-overview/)

Current npm `latest` values observed on October 3:

| Package | Version | Published |
| --- | --- | --- |
| `@overwolf/ow-electron` | `42.11.4` | September 29, 2026 |
| `@overwolf/ow-electron-builder` | `26.9.3` | September 8, 2026 |
| `@overwolf/ow-electron-packages-types` | `1.1.12` | October 1, 2026 |

These are retrieval observations, not a claim that the application has tested those versions. Pin actual installed versions in the lockfile. [Overwolf Electron package](https://www.npmjs.com/package/@overwolf/ow-electron), [builder](https://www.npmjs.com/package/@overwolf/ow-electron-builder), [package types](https://www.npmjs.com/package/@overwolf/ow-electron-packages-types)

Declare only `"overwolf": { "packages": ["gep"] }` for the proof. The official starter also includes overlay and recorder examples; neither package is necessary for the second-monitor diagnostic. Package access is through Electron main-process `app.overwolf.packages`. [First-app setup](https://dev.overwolf.com/ow-electron/getting-started/onboarding-resources/first-app/), [API overview](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/Overview/)

Current local dev mode requires either `OW_CLI_EMAIL` plus `OW_CLI_API_KEY`, or `OW_DEV_KEY` from an approved developer profile. Without valid dev credentials, the desktop app runs but gaming packages do not load. Dev mode cannot activate in a packaged/distributed executable. Keep credentials out of source, renderer IPC, diagnostics, and committed environment files. [Dev Mode](https://dev.overwolf.com/ow-electron/guides/dev-tools/dev-mode/)

The older GEP overview still describes a QA endpoint argument. Current package-channel guidance supersedes it: use `--owepm-package-channel=gep:dev` only when the provider instructs testing that channel. With runtime `42.7.1` or later the CLI override is for one run; `setChannel()` persists a preference. Use the public channel by default. A downloaded channel update requires restart; do not restart the provider during an active match. [Package Channels](https://dev.overwolf.com/ow-electron/guides/dev-tools/package-channels/)

Distribution requires an approved/whitelisted app idea and a visible desktop window. A signed distributed build needs the app owner's Overwolf Console credentials, `OW_BUILD_KEY`, the registered App UID, and the developer's own trusted code-signing certificate. Unsigned distributed builds do not load gaming packages. A successful unsigned package build is not a live-integration pass. [Release requirements](https://dev.overwolf.com/ow-electron/getting-started/release-your-app/), [App Signing](https://dev.overwolf.com/ow-electron/guides/dev-tools/app-signing/)

## Exact Electron API surface

Use the typed reference signature rather than the overview's abbreviated one-argument feature-registration example. These documented methods belong to `app.overwolf.packages.gep`:

```ts
getSupportedGames(): Promise<object[]>;
getFeatures(gameId: number): Promise<string[]>;
setRequiredFeatures(gameId: number, features: string[] | undefined): Promise<void>;
getInfo(gameId: number): Promise<any>;
```

Electron listeners are:

```ts
on('game-detected', (event, gameId, name, ...args) => { /* event.enable() */ });
on('new-info-update', (event, gameId, data) => { /* persistent update */ });
on('new-game-event', (event, gameId, data) => { /* discrete event */ });
on('game-exit', (event, gameId, gameName, pid, processName, processPath, commandLine) => {});
on('elevated-privileges-required', (event, gameId, name, pid) => {});
on('error', (event, gameId, error, ...args) => {});
```

Deadlock's game ID is `24482`. Enable only that detected game, register features promptly, and hydrate through `getInfo(24482)`. Show an elevated-process explanation when the documented privilege event fires. `getInfo` is typed `any`; its returned dictionary must pass defensive validation rather than being trusted as complete current match state. [GEP package interface](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/gep/interfaces/OverwolfGameEventPackage/), [detection event](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/gep/interfaces/GepGameLaunchEvent/)

The Electron discrete payload is `GameEvent = { gameId: number, feature: string, key: string, value: any }`. Persistent `InfoUpdate` adds `category: string`. The provider's callback `data` is this flat payload; it is not the Native `{ events: [{ name, data }] }` wrapper. [GameEvent](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/gep/namespaces/gep/interfaces/GameEvent/), [InfoUpdate](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/gep/namespaces/gep/interfaces/InfoUpdate/)

The package manager emits `ready(event, packageName, version)`, `failed-to-initialize(event, packageName)`, `crashed(event, canRecover)`, and `package-update-pending(event, info[])`. Wait for the GEP package before accessing its API, handle recovery as a state invalidation, and retain only aggregate operational counters. [Package manager](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/packages/interfaces/OverwolfPackageManager/)

## Published Deadlock fields

Available features: `gep_internal`, `game_info`, `match_info`.

| Category / keys | Documented content |
| --- | --- |
| `gep_internal.version_info` | Local/public provider versions and `is_updated` |
| `game_info.phase` | `Init`, `WaitingForPlayersToJoin`, `PreGameWait`, `GameInProgress`, `PostGame` |
| `game_info.game_mode` | JSON object with `match_mode`, `game_mode`; example `Normal`, no published Street Brawl token enumeration |
| `game_info.steam_id`, `match_history` | Local identity and prior completed-match data |
| `match_info.match_id`, `team_score` | Match identity; JSON score object with `amber`, `sapphire` |
| `match_info.roster_N` | Seat-keyed player/Steam/team/hero IDs and names, `is_local`, level/KDA, damage/healing/health/souls/lane, `ultimate_trained`, `ultimate_ready` |
| `match_info.items_N` | Purchased items by player; `id`, `class_name`, `name`, `enhanced`; example also includes `upgrade_info` without a decoding contract |
| `match_info.match_outcome` | `winning_team`: `AMBER` or `SAPPHIRE` |
| `match_info.incoming_damage` | Damage-panel-dependent breakdown |

Discrete events are `match_start`, `match_end`, `kill`, `death`, `assist` (null), `match_clock` (clock string), `game_paused` (boolean), `tower_destroyed` (team). Clock/pause are documented for ordinary Deadlock mode only. Some Deadlock examples use `data` instead of the typed `value`; parse that compatibility alias conservatively. Retain JSON-in-string decoding failures as unavailable fields. [Electron Deadlock contract](https://dev.overwolf.com/ow-electron/live-game-data-gep/supported-games/deadlock/)

Street Brawl support was explicitly added in Native GEP `300.0.1` and Electron GEP `300.0.2`; their version labels differ. This establishes mode support, not the missing draft fields. [Native changelog](https://dev.overwolf.com/ow-native/getting-started/changelog/ow-changelog/), [Electron changelog](https://dev.overwolf.com/ow-electron/getting-started/changelog/ow-changelog/)

## Health and capability limits

The public [Deadlock health endpoint](https://game-events-status.overwolf.com/24482_prod.json) returned state `1`, `published=true`, `disabled=false`, `disabled_electron=false`, and minimum Native/Electron GEP `314.2.4` in this research run. Its `match_info` keys omit `items` despite the documentation. Several health key names have trailing spaces. Its roster sample uses a numeric Steam ID beyond JavaScript's safe-integer range: reject unsafe numbers as identity, keep string IDs, and use roster seat plus `is_local` where provided. `is_vgep=false` does not disclose the acquisition method.

Health codes are 0 unsupported, 1 green, 2 partial, 3 unavailable. Health may lag the actual provider by approximately ten minutes; it is an operational signal, not an observed game-data clock or proof of correctness. A green status cannot unlock unknown capabilities. [Health verification](https://dev.overwolf.com/ow-electron/live-game-data-gep/verifying-events-for-your-app/)

No current public contract was found for:

- Own unselected ordered offers, bonus bundles, draft identity/generation or modifier decoding.
- Actual pick stage, round phase/deadline, legal rerolls or transition classification.
- Full exact ability investment, current inventory removal/upgrade/completeness semantics, or runtime corruption decisions.
- Source sequence/gap semantics, a game-origin timestamp mapped to local time, or a bounded delivery guarantee.

These gaps are an assessment of the published contracts above. They must remain unavailable in production until an authorized documented provider extension and participant validation resolve them. Match clock, purchased-item history, hero level and ultimate flags cannot substitute for those inputs. No independent proof of a no-image acquisition method or Valve endorsement was found.

The next external step is the already drafted, reviewable provider request in [automatic-telemetry-proof.md](automatic-telemetry-proof.md). It has not been sent. A future response should resolve both field coverage and acquisition method; the prototype should not guess unpublished APIs.
