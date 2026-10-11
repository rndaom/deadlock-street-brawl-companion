# Deadlock FPS config for this machine

The config package is built for your Ryzen 7 9800X3D, RX 7800 XT, 32 GB DDR5-6400 and current 1920×1080/480 Hz primary output. It targets Deadlock build **25689475**, client **6745**, source revision **11078118**, video version **20**. It contains normal native video settings, a guarded installer, exact backups, rollback and frame-time measurement tools. The second research pass adds an FPS-first FSR1 67% candidate and controlled comparisons; it does not establish a measured winner.

**Installed:** the aggressive FSR1 80% profile was applied on October 3, 2026, at 7:39 PM EDT, after Deadlock closed and Steam Cloud completed. Both file hashes and saved settings were verified. Exact originals are in `optimization/backups/2026-10-03T23-39-43-399Z-36559c46`.

**FPS gains and the winning profile are unmeasured.** Before installation, your Steam-user video settings already closely matched OptiLock Potato, with FSR2 at about 80% render scale. Low quality settings alone cannot honestly be presented as a large new improvement. Switching upscalers and confirming the conflicting stored FPS caps are the relevant first experiments. Changes to nonmenu overrides may increase or decrease rendering work.

All eight research agents completed a fresh second pass across Valve sources, original forums, wikis, current OptiLock distribution files, your installed game, hardware, AMD documentation, and measurement validity. Detailed reports are under [research/round2](../research/round2/). The existing Street Brawl Companion project is preserved.

## Install or review

Open **[Deadlock FPS.cmd](Deadlock%20FPS.cmd)** and choose **1** to prepare the FPS-first **67% FSR1 candidate**. The menu now has four actions: prepare, apply, verify, restore. Advanced experiments are kept out of this menu. Preparation writes only into this project's private `optimization/local` folder and prints the actual changes. The prepared `video.txt` is a complete local preview; do not copy it to the older game-folder config.

Quit Deadlock normally and wait for Steam Cloud synchronization to finish. Choose **2** to apply the latest prepared plan. A running game is deliberately rejected because it can save over these files. If Steam has changed the settings after preparation, choose **1** again and inspect the new plan. Settings are backed up and checked before either replacement.

Launch normally through Steam. Check the video menu, especially the upscaler, render scale, shadow quality, texture quality and low-latency setting. Choose **3** to check disk settings; this check explicitly does not establish effective runtime values. Use the game console to query `fps_max`, `fps_max_ui`, `r_citadel_upscaling` and `mat_viewportscale`, then `condump` to save the output. A value query does not set a variable. [runtime-check.cfg](profiles/runtime-check.cfg) lists the read-only queries. Do not copy development-only values into an autoexec to set them; use the native video path.

Choose **4** to restore the exact files from the last application backup while Deadlock is closed. Restore first backs up the current settings, including changes you made after installation. Recovery is allowed after same-build resolution changes; a new game build, video format or modified gameinfo requires a fresh audit. Original files remain accessible in `optimization/backups` if a guard rejects automatic recovery. Inspect the backup and the new patch's settings before manually restoring anything.

The tool uses Node.js, already installed for this workspace. It only writes the active Steam user's `1422450/local/cfg/video.txt` and the `fps_max` scalar in `machine_convars.vcfg`. It preserves display mode, resolution, refresh/device IDs, accessibility, camera/FOV, keybinds, crosshair, audio, networking and existing UI FPS cap. It rechecks build, stock gameinfo hashes and original settings hashes before writing. File replacements are individually atomic; the two-file operation cannot be guaranteed atomic across a power loss.

From the workspace directory:

```powershell
node optimization/tools/optimizer.mjs prepare --profile fpsfirst
node optimization/tools/optimizer.mjs apply
node optimization/tools/optimizer.mjs verify --profile installed
node optimization/tools/optimizer.mjs restore
```

## Candidate settings

| Profile | Scene resolution at your current output | Upscaler | Purpose |
| --- | --- | --- | --- |
| `aggressive` | 1536×864 | FSR1, RCAS control 0.2 | Currently installed. The numeric control is not a verified percentage of sharpening strength. |
| `fpsfirst` | About 1280×720 | FSR1, RCAS control 0.2 | Second-pass FPS-first candidate. About 30.56% fewer scene pixels than 80%; this is not a predicted FPS gain. |
| `native` | 1920×1080 | Stretch/no upscaling, no AA | Clarity and CPU-limited comparison. More pixels can reduce GPU-limited FPS. |
| `fsr2quality` | About 1280×720 | FSR2 TAA, official Quality ratio | Temporal reconstruction challenger; inspect small/distant targets carefully. |
| `fsr3quality` | About 1280×720 | FSR3 TAA, official Quality ratio | Menu candidate; effective backend support on the current DX11 renderer must be checked. It does not enable frame generation. |

The standard candidates use Valve's low shadow and fog levels, low textures (mip bias **2**), SSAO off, AA off, no area lights/bloom/DOF, low dashboard/shader settings and native low-latency mode 1. The AMD menu labels this Anti-Lag 2; actual backend invocation remains unverified. Shadow quality **0 means Low**, not Off. Mip bias above the menu's 0–2 range is excluded. The Valve low preset's remaining motion/particle-depth storage fields are retained for compatibility; their current implementation is not established as an additional FPS lever.

Advanced profiles isolate one variable: `fsr1control` versus `fpsfirst`/`fsr160` changes render scale; versus `stretch80` changes the upscaler; versus `fsr1fxaa` changes native FXAA; versus `throughput80` disables the latency setting. At 67%, compare `fpsfirst`, `stretch67`, `fsr2equal67`, and `fsr3equal67`. Both sharpening storage fields are fixed at 0.2 for these pairs, which does not imply equal visual strength across algorithms. FSR1 provides no anti-aliasing by itself; inspect moving distant targets before accepting the faster no-AA candidate.

The installer removes 31 unique nonmenu manual renderer override keys from the preexisting video file, including contradictory shadow/particle/outline/portal controls. Twenty still have names in current engine metadata; removal has not been proven performance-neutral. The `fsr2control` profile retains the original custom 0.79999995 temporal scale and zero sharpening values to isolate normalization against the exact original backup, with an equal uncapped runtime FPS setting in both. Do not credit cleanup with a gain before this comparison. CPU/memory/GPU tier fields remain unchanged: they differ from Valve's hardware-selection buckets, but the current runtime consequences are undocumented. The archived game FPS cap becomes **0 = uncapped**. The existing UI cap remains **120**.

Normal archived `cl_ragdoll_limit` remains **20**. A [current OptimizationLock README](https://github.com/Sqooky/OptimizationLock/tree/a70ba39997f4f2e43f0622ad8160ce099e2fa5ae) links this limit to Doorman's ultimate indicator. Reducing ragdolls, gun tracers, particles, outlines, portals, or camera visibility is excluded from the default without gameplay validation. Two release shadow controls exist, but their ranges, effect and benefit are not established; they are research hypotheses rather than default tweaks.

Default DirectX 11 remains your renderer. Test Vulkan separately with a restart and fully warmed cache; a static recommendation cannot establish which backend wins on the current patch. Keep driver frame generation, RSR, Chill, Boost and extra frame limiters off for the controlled baseline if they are currently enabled. Their actual state was not established by the registry audit. AMD Anti-Lag 2 is a latency feature; its presence is not counted as an FPS gain. [AMD documentation](https://gpuopen.com/anti-lag-2/)

## What the audit established

The fresh read-only Steam depot audit inventoried **3,877 files** and positively classified **all 517 VPKs** as stock files by current depot filenames and sizes. The one-file difference from the first audit is ordinary `reconnect.dat`, not an asset discrepancy. It found no missing depot files, no size mismatches, no extra DLL/EXE/VPK files and no identified add-on/mod/cache folders. Seven critical binary/gameinfo files and the main English localization match depot SHA1. A separate VPK index pass examined **142,335** core/citadel resources and CRC-checked 34 extracted configuration/UI resources. Every archive payload was not fully hashed. The correct settings owner is **USRLOCAL**, under Steam userdata; the older `game/citadel/cfg/video.txt` differs and is not the installer target.

Valve's [City Never Sleeps update](https://www.playdeadlock.com/cityneversleeps) moved the game to a newer Source 2 version and expanded player-specific cloud settings. Actual installed low presets and localization match the [pinned current-build Valve file mirror](https://github.com/SteamTracking/GameTracking-Deadlock/tree/4c6431ccdb816d2911bbbaa4335169cc34140386) after line-ending/encoding normalization; mirror ownership and derivation are documented in the saved evidence.

The exact reported instruction to “delete all mods, mod cache and VPKs” could not be verified. Two public archives corroborate Yoshi's October 2 Rat King camera/mod warning and link to the [original Discord announcement](https://discord.com/channels/1231286446472691825/1231311070786752579/1555688504762175510), which requires access. Your installation contains no identified mod files to clean. No official asset, shader cache or mod cache is deleted by this package.

[OptiLock at its audited commit](https://github.com/dacooderr/OptiLock/tree/7f7a54a1b8237d9b66348067d09f93174c47d303) replaces gameinfo and recommends separate VPK mods. The refreshed distribution's version-5 configs ZIP contains no VPKs; all 36 text files match that GitHub commit after newline normalization. Its recommended gameinfo contains 544 unique assigned names, 90 duplicate occurrences, 69 names absent as current ConVars and 31 `gameinfo_cannot_override` variables. Some names are commands or special keys, so absence alone does not prove they are inert. Hundreds carry development-only flags. Those large lists are not transplanted into this config, and published numeric gains are not treated as controlled evidence for your machine.

The fresh hardware sample found about **2.9 GiB of available physical RAM** and **90.84–90.99% of commit capacity in use**. Page-input/read/write counters were zero in both new snapshots, so active paging cannot be claimed from this pass. Roblox Studio consumed measurable competing CPU/GPU time. Save your work and close discretionary heavy applications before final comparisons. These observations do not establish the gameplay bottleneck or cause of hitches. No process is terminated by the config. The physical primary display is 480 Hz; virtual display adapters are detached. FreeSync state and temperatures remain unverified.

## Measure before choosing the winner

Preserve your exact original profile as the baseline. Query/set the ordinary `fps_max 0` in each test so a 400 FPS cap does not masquerade as a rendering improvement. Keep driver, renderer, resolution, camera, game mode, scene, overlays and background applications constant. Leave shader caches intact, warm the same dense-city and team-fight replay segments, and use a fixed camera and playback speed. An empty sandbox or lobby average cannot establish late-game combat performance.

The initial replay inventory found no downloaded demo. You selected a current-patch replay for the second-pass measurement; its readiness, path/hash, camera and repeatable start point still need to be established before comparisons. Do not use a public match as the experimental run. Compare one variable at a time: first original versus compatibility-normalized settings at the same FSR2 scale, then upscalers/render scale, then renderer if needed. Keep the original if normalization regresses frame times or cues.

The optional [Capture-PresentMon.ps1](tools/Capture-PresentMon.ps1) uses official Intel PresentMon **2.6.0**, checks its pinned SHA256, and records ETW data without game injection. It never launches the game or changes settings. It requires explicit scene/foreground declarations and records what is known about cache warmth, frame generation, trace loss and memory pressure. An ETW permission failure is reported; the script does not silently elevate or change Windows policies. See [benchmark research](../research/benchmark-research.txt) for the full protocol and exact command options.

Copy [benchmark-context.example.json](benchmark-context.example.json) to a private file under `optimization/local`, then fill its scenario, replay hash/ticks, camera, runtime FPS cap and background-workload fields. Use the installed PowerShell 7 runtime (`pwsh.exe`); the legacy Windows PowerShell file runner is restricted on this machine. Once the declared replay scene is running, this records a run after a 10-second delay for refocusing. Only include the cache/generation switches after verifying those states:

```powershell
pwsh.exe -NoLogo -NoProfile -File optimization/tools/Capture-PresentMon.ps1 -Profile aggressive -RunId run01 -ScenarioId dense-city-01 -MatchingMetadataPath optimization/local/context.json -ForegroundConfirmed -SceneConfirmed -ShaderCacheWarm -FrameGenerationDisabled -Download
```

`-Download` retrieves only the pinned official PresentMon binary into `optimization/local/tools` and checks its SHA256 before execution. It is optional; you can supply that exact binary with `-PresentMonPath`. The second pass downloaded and verified the 980,320-byte standalone CLI against GitHub's release digest, then ran help and a two-second diagnostic capture. It reported zero lost events but produced no target CSV; this is not an FPS measurement. No overlay, service installer, driver or mod was installed. The wrapper prints the analyzer command for its actual output directory.

[analyze-presentmon.mjs](tools/analyze-presentmon.mjs) is an offline parser. It rejects mixed processes/swapchains, invalid/incomplete intervals, unknown frame types, recorded trace loss and inadequate windows. It keeps hitch frames, excludes generated frames from rendered FPS and distinguishes **1000 / mean frame time**, the mean of the slowest 1% of intervals, and reciprocal p99. GPU timings under HAGS and Vulkan have attribution limits; low total CPU percentage alone cannot exclude a main-thread bottleneck.

Screen candidates with short fixed-scene runs, then confirm the surviving pair with at least three **ABBA/BAAB** blocks. The comparison tool requires matching context and independent real captures and declines to call unstable or regressing results a useful improvement. Synthetic test fixtures are explicitly labeled and cannot be used as real performance evidence. Inspect enemy silhouettes, souls, ability effects, outlines, movement and distant targets during normal-speed playback before accepting lower scene resolution.

```powershell
node optimization/tools/analyze-presentmon.mjs analyze optimization/captures/run01.csv --metadata optimization/captures/run01.json --profile aggressive --run-id run01 --warmup 10 --duration 120 --out optimization/captures/run01.report.json
node optimization/tools/analyze-presentmon.mjs compare optimization/captures/comparison.json --out optimization/captures/comparison.report.json
node --test optimization/tests/*.test.mjs
```

## Saved evidence

- [Machine and audit manifest](profile-manifest.json)
- [Hardware inventory](../research/hardware-audit.json)
- [Installed game audit](../research/game-install-audit.txt)
- [OptiLock audit](../research/optilock-audit.txt)
- [Valve update verification](../research/valve-update.json)
- [Engine/native settings research](../research/engine-research.txt)
- [Vendor research](../research/vendor-research.txt)
- [Independent implementation review](../research/independent-final-review.txt)
- [Installed VPK audit](../evidence/valve-build-25689475/installed-vpk/vpk-audit.json)
- [Current-build source hashes](../evidence/valve-build-25689475/mirrored-engine/source-inventory.json)

The implementation checks cover parser validity, preference preservation, idempotence, concurrent Steam saves, game-start races, failed second writes, backup tampering, real PresentMon schemas and comparison math. They verify the tool's behavior; they are not measurements of game FPS.
