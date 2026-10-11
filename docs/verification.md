# Verification scope

Version 0.3.0 adds observed team/build acquisition and contextual item/ability guidance to the Windows reader. Verification uses source-pinned static assets, authored in-memory native layouts, injected protocol events, and the companion's own window. The earlier bounded real-game card review remains evidence for the 0.2.1 repair; it does not establish accuracy of the new team reader. No game focus or input is automated.

## Repeatable checks

```powershell
npm test -- --maxWorkers=1
npm run package:dir
node scripts/verify-package.mjs
node scripts/run-desktop-verification.mjs
```

Source builds require the .NET 10 SDK. The packaged helper is self-contained. The desktop verification script uses an isolated temporary preference directory, disables real reading, and marks every synthetic interface screenshot **DEVELOPMENT FIXTURE — NOT A GAME READING**.

## Covered contracts

| Area | Checks |
| --- | --- |
| Native OCR | The actual installed Windows engine recognizes all three current catalogue fixture names in staggered positions, across whole/default/custom crops. Combat/blank fixtures produce no offers. Synthetic responses cannot become live observations. |
| Offer parsing | Draft cues, multiline/fuzzy names, word/coordinate mapping, staggered cards, uncertain names, modifiers, bonus slot identity/coverage, duplicate bonus quantities, conflicting evidence, and strict generation fingerprints. |
| Reader coordination | Automatic scheduling; confidence/counter jitter; slow-hint handoff; two fresh consistent main-card observations; no queue or overlap; foreground/context loss; pick/reroll closure; independent candidate/offer expiry and clock rollback; limited recovery; actual stop acknowledgement; payload bounds; explicit preview; partial cards without firm preference. |
| Match context | Eight source scoreboard columns, twelve-column rejection, own identity corroboration, spectator veto, individual slot provenance, partial/full/empty semantics, original ages, AP/rank independence, source/window retirement, same-process observed resets and late-frame rejection. |
| Comparison | Source weapon/spirit/scaling mechanics, actual observed own/allied/opposing facts, investment-sensitive changes with identical offers, percentage/conditional terms, current-version definitions, stale/context reset rejection, full versus main-only preference, ties and unsupported repeated-item semantics. No invented reroll odds. |
| Ability advice | Actually observed rank/unlock and next-tier effects, explicit next-tier price and own budget, one-second upgrade legality, thirty-second ownership expiry, AP-spend invalidation and clock rollback. Unknown costs do not become an inferred 1/2/5 schedule. |
| Original core/provider | Immutable unknowns, sparse roster/identity handling, inventory semantics, source epochs, obsolete-session rejection, atomic advice invalidation, provider lifecycle, input boundaries, Demo isolation, and aggregate diagnostic redaction. |
| Performance contracts | Draft-only legacy timers, disabled legacy governor limits, native read cadence/cooldown, timeouts, pressure handling, and locked recovery after unconfirmed stop. |
| Actual desktop UI | Production Electron main/preload/renderer and fixed bridge; firm versus conditional highlights; essential item/card position and opposing-item view; cached local images; own/allied/rank details; neutral expired ownership; combat clearing; independent stale expiry/watchdog; portrait/small/text/expanded layouts without horizontal overflow. |

Current counts and outcomes are recorded in `artifacts/test-results-0.3.0.json` and `artifacts/capability-report.json`. The Windows-only OCR integration launches the actual packaged-target helper with authored fixture cards. A missing executable/non-Windows host skips that test and cannot establish readiness. Injected context tests establish parser/state/scorer integration, not native recognition accuracy.

The final 0.3.0 suite passes **747 tests across 20 files**, including actual installed Windows OCR; no tests are skipped. Type checking, source/asset verification, the Windows directory build and package integrity pass. The production main/preload/renderer passes ten actual-window layout checks, including the minimal enemy view, cached images, expired identity, old cards, late publications and the unconfirmed-reading watchdog. Every UI screenshot is an authored fixture.

The final package integrity check records version, native executable SHA-256, all 173 item icons, 278 context assets, source-catalogue binding and both precomputed static descriptor caches in `artifacts/package-verification.json`. The native context test reports its exact executable/cache hashes, per-surface assertions and timings in `artifacts/native-context-verification.json`. Its synthetic layout results are distinct from normal-game accuracy. Actual Electron checks produce `artifacts/screen-reader-ui-verification.json` and clearly marked companion-window fixture images. The capability report records the final results rather than treating the earlier 0.2.1 counts as this build's evidence.

The final native context run passes every recorded assertion, including eight-player recovery without a readable round, later-seat traversal, ranks 0–3, AP 3, readable prices 2/5, glyph-only spectating, green affordability versus paid upgrades, missing-tier rejection and crop boundaries. Price 1 remains unknown. After production's synthetic startup warmup, its 21 authored requests take 34.35–208.61 ms; runtime deadlines remain authoritative under other loads. These values do not establish complete price coverage or live accuracy.

## Privacy and boundaries

The sandboxed renderer has context isolation, no Node integration, fixed preload methods, main-frame IPC checks, denied permissions/navigation/popups, local asset containment, and an image-origin allowlist. The native helper reads only a verified foreground game client through ordinary visible-window capture. There are no process-memory reads, injections, custom game hooks, or game-input actions.

Preferences are stored atomically. Game images, recognized text, offer observations and previews remain in memory during normal use. The active Steam display name is read locally at startup for supporting ownership evidence; no account ID or credentials leave that module. Explicit diagnostics contain operational aggregates without images, choices, hero IDs or player identities. Native descriptor caches contain features of public/static images only. Fixture screenshots are the companion's own window. Earlier private game-review captures under ignored `optimization/captures` are excluded from the package and public evidence.

## What the user game test establishes

The running 1920×1080 Deadlock window was detected and read without sending game input. Four foreground combat frames correctly produced no draft offers. A subsequent animated draft revealed Toxic Bullets, Tesla Bullets, and Spiritual Overflow; a disappearing reroll label changed an optional field without changing the cards. The old bundled reader's stuck state was reproduced independently. The updated automatic loop confirms a sanitized replay of those three names and clears them on combat frames for ten simulated minutes. An additional bounded native loop correctly withheld readings while the game was not foreground. The updated package is ready for the [normal game test](game-test-guide.md).

The user was no longer in a match when team tracking was added. A normal human game must check all eight heroes, observed item grids, local identity/AP/ranks, conditional picks and closure against the real screen. Complete native inventory/removal semantics, animated bonus/variant coverage, broad accuracy, active resources, FPS/frame times and mixed-DPI reconnects remain unverified. The original provider/full-tracking gates remain open. See [full-context acceptance](full-context-acceptance.md) and the [short game guide](game-test-guide.md).
