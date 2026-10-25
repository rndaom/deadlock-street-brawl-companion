# Screen reader helper

`ScreenReader.exe` is a dedicated CPU worker for the application. It uses installed Windows OCR, one engine instance, BelowNormal priority, and one allowed logical processor where Windows permits affinity. It has no polling loop: the main application schedules one request at a time over UTF-8 JSON lines.

Build with the .NET 10 Windows SDK:

```powershell
dotnet publish native/ScreenReader/ScreenReader.csproj -c Release -r win-x64 --self-contained true -o native/ScreenReader/publish
```

The self-contained executable needs no separately installed .NET runtime or OCR model download. Windows must already have an OCR recognition language installed. The worker prefers `en-US`, then an installed user-profile language. The packaged executable is approximately 58 MB; Windows OCR is supplied by the OS.

## Linux build

`ReaderPlatform` in the project selects the build and defaults to the build machine's OS (`-p:ReaderPlatform=windows` cross-checks the Windows build on Linux). The Linux build is a self-contained `linux-x64` executable named `ScreenReader`:

```bash
node scripts/build-native.mjs
```

It shares the recognizer, the protocol and every static descriptor with the Windows build. Platform code is split into:

- `TextEngine.cs` (the common OCR result shape), `TextEngine.Windows.cs` (Windows OCR) and `TextEngine.Linux.cs` (Tesseract 5 through its C API: LSTM engine, sparse-text page mode, English model from the system `tessdata`). Tesseract reads dark text on light backgrounds, so mostly dark images are inverted first, and pure black-and-white upscaled fields are softened slightly because the recognizer misreads their stair-stepped edges. `OMP_THREAD_LIMIT=1` keeps Tesseract's worker threads from competing on the reader's single core.
- `Native.Windows.cs` (Win32 discovery and GDI capture) and `Native.Linux.cs` (Hyprland IPC discovery, `grim` capture). The game is the client whose class is `steam_app_1422450` or whose process is `deadlock.exe` under Proton. `grim -T` copies the game toplevel's own buffer, so the stacking and overlap checks only run when it falls back to copying the screen area after three failed window copies.
- `Drawing.Linux.cs`: the small part of `System.Drawing` the recognizer uses, implemented on SkiaSharp. Text rendering differs slightly from GDI+, which is why the descriptors shipped from Windows are kept while their hashes still match.

Status names and their meanings are the same on both platforms. A Hyprland window that is pinned counts as shown on its monitor's current workspace.

## Protocol 1

The worker accepts `--icons <absolute directory>` for public item icons and `--context-icons <absolute directory>` for public hero portraits, signature icons, and installed-client HUD glyphs. It warms static templates before its first request and performs no network requests. Each input line is a request:

```json
{"id":"request-1","op":"read","crop":{"x":0.02,"y":0.08,"width":0.96,"height":0.84}}
```

`id` is a string. Operations are `probe`, `read`, `fixture`, and `stop`. `crop` uses the physical game-client rectangle normalized to 0–1. Omitting it scans the full client. `debugPreview:true` returns an in-memory PNG encoded as `previewPngBase64`; it never writes an image file. The production app controls whether that debugging request is exposed.

Replies contain `protocol:1`, matching `id`, `status`, `gamePresent`, `foreground`, physical `clientWidth`/`clientHeight`, `capturedAt` in epoch milliseconds, `elapsedMs`, `hash`, and `blocks`. Each block has `text`, full-client normalized `bounds`, and individual `words` with the same coordinate convention. Windows OCR's nonzero `TextAngle` is applied clockwise around the bitmap center before mapping word boxes back to the original captured pixels. Boxes clip to the actual crop, and empty clipped words are discarded. `crop` describes the actual pixel-rounded captured region. The TypeScript coordinator converts full-client bounds into crop-relative flat coordinates before parsing offers.

Captured images are scaled to at most 1,800 × 2,400 pixels, with an independent hard limit of two million output pixels. The low-cost `probe` uses at most 192 × 192 pixels and performs no text recognition. Read results are cached for the latest three crop geometries. Identical pixels are revalidated against the current foreground window, then return `status:"unchanged"`, cached blocks/icons, a new capture timestamp, and `unchanged:true`. Partial context matching still advances on that fresh image; an unchanged scoreboard cannot freeze on an incomplete first batch. A skipped small-text refinement may be attempted once when time becomes available. The hash covers every captured pixel: animation behind unchanged cards will miss this cache. Card confirmation must compare parsed identities rather than requiring an unchanged hash.

`metrics` reports measured `captureMs`, `ocrMs`, per-request process `cpuMs`, `workingSetMb`, `privateMemoryMb`, and image statistics. `affinityLimited` reports whether the one-processor limit applied. The coordinator computes utilization across request and idle intervals; these measurements do not measure game FPS or GPU usage.

Optional `icons` identify confidently matched public bonus icons, with normalized bounds, a `role:"bonus"`, and zero-based slot. Each observed `Bonus!` anchor produces both inferred slots. A failed match, clipped slot, or unavailable cache produces an explicit record with `itemId:""` and `confidence:0`, so recognizing one icon cannot imply that the complete bonus bundle was read. An icon match does not establish modifier effects or complete offer coverage.

Failure statuses include `not_found`, `no_window`, `not_foreground`, `minimized`, `occluded`, `offscreen`, `blank_capture`, `ocr_unavailable`, `capture_failed`, and `invalid_request`. Failure replies have no actionable OCR blocks. `stop` returns `stopped` and exits. The parent enforces request deadlines and terminates/restarts an unresponsive helper.

The worker has no advice or persistent match-data state. A visible combat frame can correctly return `ok` with no recognized words. The coordinator must expire both unconfirmed and confirmed choices, and clear them when current draft cues disappear. The bottom-edge `Selects Complete` label may lie outside a calibrated reading area; detecting that label cannot be the only way to end a draft. Native `elapsedMs` ends before JSON serialization and pipe delivery, so the coordinator's measured request wall time determines its total deadline and cadence.

## Visible match context

`context:true` adds a `context` reply object containing `panel`, `viewMode`, `heroes`, `items`, `abilities`, `regions`, and optional `abilityPoints`. Every bound remains full-client normalized and lies inside the requested crop. Context uses only that one captured bitmap. A top crop cannot report a bottom HUD, and a footer crop cannot report unseen teammates. The app alternates cheap top/footer reads outside a draft; it requests a full client only for a current scoreboard/draft handoff.

The native candidates follow pinned client 6745 Panorama geometry. At 1920×1080 the four-player portrait centers are 550/638/726/814 and 1106/1194/1282/1370; portrait candidates are 80×100. The live badge contains card artwork inside a compositor rather than a raw stretched portrait. A public card reference renders at x4.8/y0 with width70.4 and preserved aspect on the measured gray backer; recognition requires both the complete patch and its inner 56×80 patch to agree on the same distinct hero. The strict distance/margin checks remain in force. An offline review of the already-authorized draft frame resolved all eight visible badges with this agreement, whereas the old raw reference accepted only one. This is one reviewed frame, not a general live-accuracy result.

`seat` denotes a visible UI column, not a server player or account identifier. The default unknown layout has twelve predicted columns; positive round/draft cues or exactly eight balanced source KDA headers establish four per side. KDA grouping retains actual OCR word boxes, including KD+A and K+DA fragments. A literal `KOA` fallback requires exactly eight whole words within the source header fields (design y155–225, below the player-name row), one baseline, and at least four strong same-frame portraits. One word, a username, missing columns, punctuation aliases, or a twelve-column row does not establish that layout. Fresh fallback portrait matches are emitted in the same reply.

Own-view identity requires a coherent four-signature match for one public hero. Ordinary source buttons use two 90% containers: final 50% icon size is 48.6px, with 89.1px pitch, first center y1022.4, and a 16.2px lift for middle slots. Upgradable/untrained 53% images add a 51.516px hypothesis. The older 54/60px hypotheses remain strict alternatives. The prior authorized frame supplied four independently distinct Haze signature matches at the smaller sizes; all agreed on Haze without lowering acceptance thresholds. Source-scale hypotheses and vertical poses rotate between reads, so a later pose remains reachable under the work limit. Shop layouts use different scaling and are not certified by these ordinary-HUD poses.

A source-position spectator glyph or scoped spectator/replay text vetoes own inventory, ranks and AP. Rings, brightness and an active-view hero alone do not prove participant ownership. Native `viewMode` stays `unknown` unless a spatially bounded interactive UNLOCK cue is present; the parser may separately corroborate a trusted local alias with a full scoreboard name and matching bottom hero. No enemy ability ranks enter the own-rank array.

Each ability rank requires all three visible source tier rows, positive paid-check or unpaid-pip graphics, and a contiguous paid prefix from bottom tier1 to top tier3. Green affordability fill alone, a missing row or conflicting glyphs returns unknown. Source CSS hides those rows for untrained/unlockable abilities, so a complete three-tier surface supports unlocked state. Rank evidence is independent of reading the price. Only the first unpaid row supplies an observed next price. AP requires the source bottom glyph next to its amount; topbar team totals are excluded.

Item candidates use tiny cached public descriptors at source-sized positions. The lower-left ordinary HUD uses 54px panes at 61.2px pitch, with two down-flow candidates per column. The expanded scoreboard uses 27px panes at approximately 33px pitch in a 70px wrapping container with two columns. Its item row follows dynamic name, hero, KDA/stat, graph, detail and ability rows; there is no fixed y174 item grid. Acquisition requires a measured same-seat KDA/stat anchor, a fresh hero identity and two distinct confidently recognized current item panes. A bounded search advances at most eight candidate origins per seat per read. A successful origin is re-proved against current pixels before its partial cells are emitted.

Each positively established team grid includes an opaque `layoutId` for its cell mapping. Row/column slot keys stay stable within that mapping; a freshly proved origin change over four design pixels creates a new epoch. The parser/reducer invalidates the old mapped snapshot on a fresh positive new epoch without claiming an item was removed or the inventory is complete. Missing/unread acquisition carries no new epoch and does not clear history. IDs are random geometry tokens, never account or player identifiers.

Every failed inspected cell is `unknown`; dark texture does not prove empty. Unvisited cells are omitted. Item variants default to `unknown`. Inventories are partial because this candidate grid cannot prove the game's dynamic inventory boundary or removed-slot completeness. Matching rotates between player/item cells, emits at most 192 team and 22 local candidates, and never truncates a claimed complete inventory. The state layer accepts fresh team items only with fresh same-frame hero proof for that seat. The dynamic scoreboard search and tinted item compositor still require a real expanded-scoreboard review; source-shaped authored fixtures alone do not establish that live coverage.

Context matching uses a60ms soft work slice: own identity first, bounded rank/AP evidence, rotating portraits, own items, then rotating team items. Small descriptor calls are indivisible, and OS scheduling can exceed a soft slice. The parent retains the250ms warm wall deadline and3s engine startup limit; overrun replies are discarded and cannot refresh evidence. There is no guarantee of250ms latency or a measured game-FPS effect.

An optional top text strip upscales only existing pixels from the source header/name area; it starts only before155ms elapsed and contains at most750,000 output pixels. Positively localized unread numeric fields can receive one additional bounded OCR canvas before170ms elapsed. It tightly copies the same numeric pixels four times to help the installed OCR segment isolated amounts. Copies are one observation, do not raise confidence, and must decode to four equal digit strings; clipped, disagreeing, dark or nonnumeric results remain unknown. The canvas is at most720×988, no additional capture occurs, and attempts are bounded/cached for unchanged pixels. The worker never substitutes I/l for digit1.

## Static descriptor preparation

The packaged build prepares descriptors using the published executable:

```powershell
native/ScreenReader/publish/ScreenReader.exe --prepare-descriptors C:\absolute\assets\context-icons C:\absolute\assets\reader-icons
```

This mode performs no OCR, capture or network work. It validates pinned PNG bytes and writes context `templates.bin`/`templates.json` and item `context-templates.bin`/`context-templates.json`. These contain only public static icon features. Metadata schema1 and `algorithmVersion:2` bind the entire manifest SHA256, binary SHA256, template count and 12×12 grid. The context cache contains 766 features, including 78 full/inner compositor references from the 39 public hero cards; the item cache contains 173. The binary starts `DLDESC01`, validates bounded identities, roles, slots, finite RGB/gray features and exact EOF. Old algorithm-version descriptors are rejected. Missing, corrupt or stale descriptors fall back to hash-verified PNG loading. A bounded RAM cache holds only current pixel-patch hashes and descriptor results, never captured images or player history.

## Capture boundary

The worker discovers a top-level window whose process image filename is exactly `deadlock.exe`. It reads process/window metadata only. Capture requires that window to be foreground, visible, non-minimized, non-cloaked, and fully contained on one monitor. Visible windows above it may not intersect its client rectangle; center and corner hit tests must belong to the same game window. These checks are repeated before copy, after copy, and after recognition. Resize, focus loss, minimization, and occlusion clear cached text.

The GDI copy transfers only the verified game-client crop into a small bitmap. It does not create a desktop video stream, recorder, GPU inference pipeline, process-memory reader, game hook, or gameplay input. Pixels and raw text remain in memory and the parent pipe; the helper has no telemetry logging or image-save path. GDI capture that produces a blank/unsupported game frame fails closed rather than substituting a desktop image.

## Independent synthetic OCR check

```json
{"id":"ocr-check","op":"fixture","fixture":"draft"}
{"id":"stop","op":"stop"}
```

`fixture` draws a synthetic radial three-choice screen in memory. It includes `SELECT ITEMS`, `Choice 1 of 3`, `ACTIVE RELOAD`, `BULLET LIFESTEAL`, `SPIRIT RESILIENCE`, and a reroll cue. `fixture:"combat"` and `fixture:"blank"` exercise absence of a draft. Fixture replies use `synthetic:true`, with `gamePresent:false` and `foreground:false`, so they cannot be mistaken for participant evidence. No game focus or input is changed.

Before the live-test audit, the self-contained helper recognized all three synthetic names in a 91 ms first scan; the default cropped scan took 34 ms, and identical pixels returned cached OCR in 12 ms. With the icon cache prepared at startup, the first game-presence probe returned in 465 ms from process launch. One-processor affinity applied, and the worker reported approximately 148 MiB working memory during these scans. These are local synthetic timings, not accuracy or FPS measurements from a real Deadlock draft.

An earlier context verification used the then-published production executable and pinned caches, with the application's synthetic draft warmup first. All 19 required assertions passed over 21 context frames: same-frame eight-player KOA recovery, own four signatures, ranks0/1/2/3, visible AP3, readable next prices2/5, later-seat item progress on unchanged pixels, later signature poses, strict payload/crop bounds, missing coverage, blank frames, spectator text and graphics, green affordability and incomplete tiers. The next price1 stayed unknown; the report does not claim complete-price coverage. Startup wall time was 688.71 ms, and subsequent request wall times were 34.35–208.61 ms with no 250 ms overrun in that run. Peak reported working/private memory was 246.95/157.41 MiB during the tight fixture series. That fixture used raw portraits, larger signatures and incorrectly ordered scoreboard rows, and the subsequent user's match produced no usable context. Its passing assertions did not certify the live compositor or scheduler. The current source-shaped scoreboard fixture puts names before hero/KDA and uses the contained badge and smaller icons; the integration check starts scoreboard discovery before any draft can seed the mode. Earlier unwarmed context iterations under variable desktop load exceeded 250 ms; these measurements do not guarantee a deadline under load. The parent retains its discard/stop behavior.

Aggregate evidence and the exact executable/manifest/descriptor hashes are in [native-context-verification.json](../../artifacts/native-context-verification.json). It contains no game screenshots, raw OCR, player names or account identifiers. Context recognition accuracy, complete inventories and game-FPS impact have not been validated in a live match. Only the earlier draft/capture path had an authorized live review; that evidence does not certify these new context candidates.

The explicit offline `--review-image <absolute PNG path>` CLI mode replays an already-authorized local image through installed Windows OCR and this same recognizer. It respects the two-million-pixel cap and accepts serialized crop/context requests, but forces `synthetic:true`, `gamePresent:false`, `foreground:false` and a null capture timestamp. The runtime JSONL protocol has no command to select or open an arbitrary image. Offline replies cannot be consumed as current game evidence. This mode neither focuses nor captures the game and does not create an image archive.

An authorized later local game review verified the capture path against a naturally occurring Street Brawl draft. Three warm whole-client scans took 102–106 ms and supplied Toxic Bullets, Tesla Bullets, and an OCR spelling of Spiritual Overflow that the parser conservatively resolved. Combat frames supplied no draft cues. That review found the old phase-probe crop ended above the complete `Choice` label, and it showed why phase/candidate scheduling must be tested independently of native OCR. These observations do not establish general draft accuracy or FPS impact. The subsequent native geometry patch compiled without warnings and passed six expected transforms plus 10,000 rotated/crop-edge bounds checks; its published binary includes the correction and the matcher crop-clipping correction.

Primary API documentation: [Windows OCR](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine), [OCR word coordinates](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrword.boundingrect), [OCR rotation](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrresult.textangle), [Microsoft's OCR overlay sample](https://github.com/Microsoft/Windows-universal-samples/blob/main/Samples/OCR/cs/OcrFileImage.xaml.cs), [SoftwareBitmap](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.imaging.softwarebitmap), [GDI bitmap transfer](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-stretchblt), and [foreground-window identification](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow).
