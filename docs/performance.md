# Background performance

Version 0.3.0 adds visible team/build acquisition and contextual scoring to the local reader, retaining the earlier confirmation repair. The user's request requires responsiveness and low game overhead. This build does not establish unchanged game FPS.

## Implemented limits

- The native helper runs at below-normal priority with affinity restricted to one logical CPU. Windows OCR, capture conversion, hashing, and cached icon matching run outside Electron's UI/main threads.
- Capture requires the foreground, visible, uncovered Deadlock client. It checks window identity and geometry before capture and again before accepting OCR. Alt-tab, minimization, occlusion, invalid geometry, and black captures withhold readings. No focus or gameplay input is automated.
- GDI StretchBlt directly scales the selected client region into a buffer limited to two million pixels, rather than first copying a complete 4K frame. GDI still has graphics overhead that requires game testing.
- Outside drafts, small upper/lower HUD regions alternate at a total maximum of one scan per second. A positive scoreboard cue requests one wider handoff; draft context refresh replaces an existing card read. Draft reads remain limited to two starts per second. There is one active request and no queue.
- Context matching runs against the same captured pixels and requested crop, with no second hidden capture. It reserves early work for the own signature HUD, then traverses roster/items with a 60 ms matching budget. Inventory traversal rotates so later players can make progress. The budget excludes Windows capture/OCR, which remain under the coordinator's overall deadline.
- A bounded cache stores three OCR/icon result records keyed by pixel hash, crop, client geometry, process/window identity, and synthetic/live origin. Identical pixels reuse OCR after a fresh capture; budgeted context traversal can advance on those current pixels. Cached game images are not retained. Context loss clears recognition results.
- Warm reads have a 250 ms deadline. Explicit startup has a separate three-second allowance for the installed engine and cached assets; its synthetic warmup can never become live advice. Cancellation rejects overdue results and kills the helper; the next process cannot start until termination is confirmed. A failed stop leaves reading locked.
- Work is followed by at least four times its measured duration in cooldown, and by the cadence minimum. This bounds elapsed worker duty share to 20% across work/cooldown cycles. It is not an instantaneous CPU cap or FPS guarantee.
- Actual worker CPU/memory counters feed status and pressure checks. Repeated sustained pressure or three read timeouts since the last retry pause reading until the user retries. These checks concern reader work and do not measure GPU load or game stutter.
- The interface exposes Pause reading, Resume reading, and Retry reading. It discards changed/stale advice immediately and independently expires observations after one second. The original match controller/countdown timers also stop while idle.

No OCR models or icon assets download during gameplay. All 173 item icons and 278 context images are cached locally. Build-time descriptors contain only verified static-image features and avoid decoding every PNG during reader startup; stale/corrupt descriptors fall back to verified source images. The source-backed comparison reads static definitions once and performs no per-decision disk/network/model work; a populated eight-player fixture averaged 0.22–0.30 ms per evaluation over 100 iterations on this PC. That is a scorer microbenchmark, not a game or full reader latency measurement. Game pixels and OCR text stay in memory during normal use; explicit previews are not saved. The separately authorized development review saved bounded private captures excluded from the package.

These choices follow [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance), Windows [process scheduling guidance](https://learn.microsoft.com/en-us/windows/win32/procthread/scheduling-priorities), and the installed [Windows OCR API](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine). Lower priority and small workloads reduce scheduling pressure; they cannot prove unchanged frame times.

## Local observations

This PC has an AMD Ryzen 7 9800X3D, 16 logical processors, an AMD Radeon RX 7800 XT, and 30.9 GiB usable RAM. The installed game's process is `deadlock.exe`; the older `citadel` name alone misses it.

The 0.3.0 native context check used the final executable and the same synthetic draft warmup as production, followed by 21 authored frames. Startup took 688.71 ms; subsequent request wall times were 34.35–208.61 ms, with no 250 ms overruns in that run. The check covers source-layout heroes/items, ranks 0–3, observed AP 3 and readable next-tier prices 2/5. The isolated price 1 remained unread; it is not inferred. This is fixture evidence with the exact binary hash in `artifacts/native-context-verification.json`, not a game accuracy or frame-time measurement. Earlier development runs under different desktop load exceeded the warm limit; the parent must still reject overdue results and apply its pause/recovery rules.

The earlier 0.2.0 self-contained helper initialized its static icon cache and answered a probe in approximately 465 ms. Actual Windows OCR on authored fixture cards took 91 ms for the first full read, 34 ms for a warm default crop, and 12 ms for an unchanged crop. Reported worker working set was approximately 147.5 MiB. These measurements establish an installed engine and bounded fixture work, rather than game-card accuracy or the new context reader's cost.

A separate earlier helper-only experiment ran twenty authored OCR frames at two requests per second over 9.765 seconds. It used 0.53125 CPU seconds, or 0.3400% normalized across 16 logical processors. Reads took 13.03–35.96 ms; peak reported worker working set was 144.32 MiB. That experiment preceded final icon integration and excludes Electron. It is not a final whole-app or game-performance measurement.

The earlier 0.2.0 packaged application's aggregate sample is in `artifacts/screen-reader-background-profile.json`. It includes the companion and the real ScreenReader process with Deadlock running, while the game was not in the foreground. The reader was waiting for visibility rather than continuously reading draft cards. The sample reports its duration, stable process set, normalized CPU, summed working sets, and private committed memory. Working-set sums can count shared pages twice; committed memory is not physical resident RAM.

That sample lasted 20.04 seconds with a stable set of five processes. Windows reported no measurable CPU counter increment during the interval (0.0000% at counter resolution); peak summed working sets were 561.8 MiB and private committed memory 376.9 MiB. This is idle/visibility-check evidence with the packaged reader present. It does not measure active game capture or establish zero CPU cost.

During the explicit live-game review, whole-window draft captures at 1920×1080 took 195.9 ms for the first read and 101.8–105.7 ms for the next three. The reader recognized the three visible base-item names. Combat reads took 117.2–180.5 ms for the broad area and 43.5–45.1 ms for the former smaller heading strip. These bounded native timings are not a game-to-advice latency measurement, a resource stress test, or a comparison of game frame times. The updated reader retains the same 250 ms warm deadline and one-worker limits.

After reopening version 0.2.1, a 20.03-second sample recorded five stable companion/reader processes with Deadlock running throughout. Windows reported no measurable CPU counter increment at its counter resolution; peak summed working sets were 528.9 MiB and private committed memory 283.8 MiB. The sample did not record foreground/reading state or game frame times, so it cannot establish active OCR cost or unchanged FPS. See `artifacts/screen-reader-0.2.1-background-profile.json`.

After opening the final 0.3.0 package, a 20.02-second sample recorded five stable companion/reader processes with Deadlock present. The packaged helper was below-normal priority with one logical CPU affinity. Windows reported no measurable CPU counter increment at its resolution; peak summed working sets were 522.9 MiB and private committed memory 318.4 MiB. Foreground/active-reading state and game frame times were not recorded, so this is a background observation rather than active gameplay performance proof. See `artifacts/screen-reader-0.3.0-background-profile.json`.

Re-run with the application already open:

```powershell
./scripts/measure-background.ps1 -Seconds 20
```

The retained `artifacts/background-profile.json` is the earlier 20.02-second **pre-reader** prototype sample: four processes, no measured CPU increment at counter resolution, 497.5 MiB summed working set, and 315.7 MiB private committed memory. Its results do not describe active OCR or the new build.

## Game validation

Compare similar gameplay with the companion closed, reading paused, and reading active. Keep graphics settings, resolution, frame cap, display arrangement, and scene comparable; alternate run order and repeat. Include draft animations/rerolls, busy combat, startup while playing, alt-tab, and a longer memory/resource session.

Check average FPS, slow frame times, companion CPU/private memory, and visible-change-to-reading delay. Proposed engineering targets are average FPS within 1% and 99th-percentile frame time within the larger of 1 ms or 3% of baseline, without repeatable new stutter. Those targets have not been achieved or measured here. Use Pause reading if a repeatable change appears. The [game-test guide](game-test-guide.md) explains the normal user test.
