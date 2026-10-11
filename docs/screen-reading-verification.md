# Screen-reading verification

The context-tracking expansion passes **54 independent context integration tests** and the **47 existing mocked screen integration tests**, with TypeScript checking clean. The combined focused run is **101 passing, one native test intentionally excluded**. It exercises the production native JSON adapter, visible-context parser, context reducer, offer parser, coordinator timers and recommendation entry points with injected local responses. No application or native helper was launched for this expansion's independent test run. The root's final complete suite, native matching session and package checks are separate evidence.

Run these checks without starting a helper:

```powershell
npx vitest run tests/context-integration.test.ts tests/screen-integration.test.ts -t "native protocol|unattended|native JSONL|actual-reading"
npm run typecheck
```

The earlier **0.2.1 draft-reader checkpoint** passed **454 tests across 11 files**, including the actual Windows OCR test and all **48 screen integration tests**. That checkpoint followed the October 3, 2026 live game failure in which the application could remain at “Reading cards” or “Confirming the new item choices” after the selection screen disappeared. Run the complete screen integration check with:

```powershell
npx vitest run tests/screen-integration.test.ts
```

The native test runs when Windows and `native/ScreenReader/publish/ScreenReader.exe` are available. Otherwise that test is skipped; a skipped native test does not establish OCR readiness. It starts a hidden helper with local `assets/reader-icons`, uses only in-memory synthetic fixtures, and stops the process afterward. Run the mocked integration checks without starting any helper with:

```powershell
npx vitest run tests/screen-integration.test.ts -t "native JSONL|actual-reading"
```

## Observed context and recommendations

The automatic integration sequence starts with combat HUD and a centered Street Brawl round cue, discovers the expanded scoreboard, reads eight distinct positions, closes the scoreboard, recognizes the actual public draft geometry, and returns to combat for ten simulated minutes. Only fake timers advance it; the test never calls `pollOnce()` to drive that sequence. Responses are filtered against every requested crop, so a top scan cannot provide bottom HUD evidence or unseen inventories. A capture already dispatched before closing a panel may finish, but later HUD scans do not refresh the disappeared scoreboard's item timestamps.

The new suite verifies:

- Eight visible positions, four relative allied and four opposing sides, and corroborated own HUD/roster association. Duplicate hero identities retain separate inventories. These seats are UI positions 0–7; a twelve-player native layout is withheld as a whole rather than truncated. An opaque helper/window epoch is never a game match ID.
- Independent occupied-slot coverage and material-detail coverage. A proven sixteen-slot fixture is preserved. Complete current slot observations replace prior occupied slots; a high-quality explicit empty cell removes only its slot. Partial, hidden, unknown and cropped cells preserve older positive facts with their original capture times. Unknown quantities, special variants and bonuses do not become a complete known build.
- First-change timestamps and semantic revisions remain stable on identical confirmations. Fresh round/header text does not freshen hidden mutable data; observations older than thirty seconds are excluded from decisions. Source epochs, window epochs, same-process round regression, post-match restart, stale captures and mixed child-frame provenance cannot restore the previous build.
- Spectator, deathcam and replay evidence withdraws own card/ability guidance and prevents another player's HUD, items, ranks or AP from being assigned to the participant. A unique hero is insufficient local-seat proof. Exact synthetic account-name correlation is accepted only in its matching source K/D/A column with a corroborated current HUD hero; ambiguous aliases are rejected.
- Rank zero and locked state require positive observations. Missing or unread pips remain unknown. Upgrade spending requires fresh own AP plus the observed price of the next unpaid tier; team AP, cooldown digits and an assumed price schedule cannot satisfy that condition. A lower AP reading without fresh ranks invalidates the old spending context.
- The same three OCR-recognized offers change the provisional main-item comparison from **Rapid Rounds** to **Extra Spirit** when an actual parsed Haze **Fixation rank 0 → 1** observation arrives. The explanation references Fixation's pinned spirit damage term and the accepted observation. Unknown card variants/bonuses keep the firm preferred position null, and an undecoded owned-item repeat withdraws the provisional highlight too. Each publication carries the corresponding accepted context atomically.
- One worker and one request in flight, at most one total top/bottom phase read per second outside drafts, a bounded scoreboard handoff, and full-context refreshes replacing card reads. A 210 ms workload respects the 20% worker wall-share cooldown. Disable, worker retry, confirmed-exit barriers, late lines and missing responses do not leave a queue or stale spend/pick guidance.

This review found and reproduced an additional clock defect: a 500 ms backward epoch adjustment could extend the old ability “upgrade” label past its original one-second wall freshness. The coordinator now uses a monotonic lower bound for context/ability expiry while retaining actual capture and receipt provenance. The regression passes without another read. Native review also identified repeated early signature-search poses that could starve later valid poses; the native owner added rotating signature search and rotating item traversal. Injected context JSON cannot prove that the pixel matcher makes progress, so the native owner's separate synthetic stress result is required for that claim.

The contract rectangles and hero/item/rank records in `tests/context-fixtures.ts` are synthetic producer inputs. They establish merge, scheduling and recommendation behavior, not live detection accuracy. Only the draft text and geometry identified below came from authorized game observations. The [full-context acceptance document](full-context-acceptance.md) links the pinned public Panorama layouts and explains the remaining accuracy requirements.

The current native recognizer reports positive and unknown item cells with partial inventory coverage. It does not yet certify every empty cell, complete current owned grid, stack quantity, special modifier, bonus bundle or enemy rank. Therefore these tests prove explicit removal/replacement behavior when supplied by a truthful producer, not that every such event is currently detectable from normal gameplay. Actual eight-player ownership, AP/rank correctness and loadout changes still need comparison against the human-visible normal game. A contextual base-effects heuristic and the existing real draft/combat proof do not establish complete-match optimal advice or a no-stutter/FPS result.

## Reproduction and corrected behavior

A separate reproduction loaded only the reader code from the previously shipped JavaScript bundle, excluding all Electron boot code. A fully injected fake process supplied thirteen current observations with the same three card identities and bonus identities but alternating icon similarity values `.9713` and `.9679`. The old reader stayed at `reading` with zero offers. Advancing ten simulated minutes without another capture still left that status unchanged. No desktop application, native helper, or game operation was launched for this reproduction. An independent synthetic pixel test of the icon matcher also produced this confidence drift for an unchanged identity and bounding box.

The old confirmation key included fine confidence values, warning text, and optional context. Ordinary OCR corrections, varying icon similarity, or a missing reroll digit could therefore restart confirmation indefinitely. A first candidate had no expiry timer. A separate scheduling defect could also keep scanning the title: a 210 ms title read plus its worker cooldown consumed the hint lifetime before the full card request. These are confirmed defects in the shipped reader; the capture and package checks below provide additional evidence about the reported live behavior.

The reader now confirms main identities independently of changing detail quality. Fresh, stable names can appear with unread modifier and bonus warnings and a null preferred position. A first candidate expires after one second; current combat text clears it without depending on a closure label. One full capture follows a positive title hint despite the cooldown, and that capture must still establish a current selection panel. The title strip includes the observed choice counter, and a bounded center/footer fallback can find the real reroll button. Card reads include the selected area plus the closing-control region; the explicit preview still uses exactly the selected area.

The new regression coverage includes:

- Confidence drift, exact versus corrected item words, missing ancillary counters, and alternating known/unknown bonus or modifier details.
- A timer-only unattended loop that reaches ready, changes to anonymized combat geometry, and remains clear for ten simulated minutes while its scheduler continues running. It uses observed native timings and pixel-rounded crop geometry, permits only one request in flight, and requests no preview bytes.
- An unconfirmed first observation with no subsequent polls, and a 210 ms title read followed by a full card handoff.
- Draft discovery through the actual center button when a configured title strip misses the heading.
- Actual coordinator publications flowing through the renderer's revision guard: a delayed ready RPC snapshot cannot replace the higher-revision combat-clear publication. The application applies this guard to initial fetches, subscriptions, and preview responses.

The original tests mainly supplied stable text and similarity values, called `pollOnce()` manually, and put “Selects Complete” conveniently inside the crop. They verified parsing and explicit transitions but did not establish unattended scheduling, dynamic OCR confirmation, or closure when the real label lay near the bottom edge. The updated tests do not rely on that label to recognize combat. The renderer also has a continuous tentative-reading watchdog and an independent one-second expiry for visible offers; those UI protections are separate from the coordinator regressions.

## Actual game observations and synthetic OCR proof

Authorized local game observations provided both positive and negative evidence. The first draft observation revealed two item headings. The next three resolved **Toxic Bullets**, **Tesla Bullets**, and **Spiritual Overflow** in positions 0/1/2; the last name was read as “Spiritual Ouerflow” and matched at `.941176…`. The reroll count changed from `1` to `null` while the card identities stayed the same. Whole-window reads took 101.84–105.66 ms after an initial 195.9 ms preview. The observed choice counter extended beyond the old title crop, and the reroll button was around client-relative `y = .653`, above the earlier fallback region.

Only public card/cue text and normalized geometry from these observations are embedded in the tests. Native word reconstruction, the incomplete two-name reveal, the corrected third name, and the missing count run through the production coordinator with automatic scheduling. The regression reaches ready with all three correct identities, keeps unknown details explicit and the preferred position null, then clears on combat. No match identifiers, participant names, screenshots, or raw private HUD text are included in these fixtures.

Four actual combat observations produced no draft or offers through the parser. Full-area reads took 180.52 and 117.21 ms; title reads took 43.45 and 45.09 ms. The only relevant public heading was “ROUND 2”. Anonymized versions of this geometry cover clearing both a pending candidate and a previously ready selection. The native observations establish one real draft and four combat frames; the automatic replay establishes the draft-to-combat transition. They do not measure recognition accuracy across heroes, animated frames, resolutions, or game updates. The [game test guide](game-test-guide.md) covers continued normal-game testing.

Earlier that day, the published helper passed all **38** original integration tests, including actual installed Windows OCR. Its in-memory staggered fixture contains **Select Items**, **Choice 1 of 3**, and **Use Re-Roll**, with **Active Reload**, **Bullet Lifesteal**, and **Spirit Resilience**. All identities resolve against client **6745**, catalogue revision **11078118**, in positions 0/1/2 through native normalization, the word adapter, parser, and limited comparison. Spirit Armor was removed from an earlier fixture because it is absent from this catalogue; it is not silently aliased to a current item.

The native fixture covers the whole client, default area `(0.02, 0.08, 0.96, 0.84)`, and custom crop `(0.02, 0.02, 0.96, 0.90)`. Native word bounds stay relative to the full client; parser coordinates are crop-relative. Combat and blank fixtures produce no offers. The updated native test also uses the production conservative detail option: exact main names remain readable while absent modifier/bonus evidence stays unknown and no preferred position is asserted. Synthetic fixture replies always have `synthetic: true` and make no game-presence or foreground claim; the coordinator rejects them as live evidence.

The suite additionally covers lost foreground, occlusion, minimization, blank images, stale/future timestamps, changed offers, expiry during hung work or clock rollback, repeated timeout recovery, cancellation and confirmed process exit, late output, payload limits, omitted nullable fields, unknown second bonus slots, custom crop mapping, and explicit deferred previews.

## Runtime and resource scope

A read-only artifact check found that the shipped JavaScript matched the then-current built JavaScript and the packaged helper matched the published helper. The shipped reader still contained the volatile confidence key and lacked candidate expiry. There was no evidence of an accidental mixed helper/package version at that checkpoint. Later native fixes map rotated OCR word geometry and clamp failed bonus boxes to the actual capture bounds; they require the corresponding fresh package.

The configured packaged helper is `resources/screen-reader/ScreenReader.exe`, with public item icons in `resources/reader-icons` and hero/ability/HUD glyph templates in `resources/context-icons`. Runtime uses installed Windows OCR and local assets, with no model or icon download. The .NET SDK is a source-build dependency; the published helper is self-contained. The application disposes the reader on close, and the coordinator awaits confirmed worker exit before reuse.

A final autonomous reader check lasted 35 seconds. With the game present but outside the foreground, the reader correctly published `interrupted`, no offers, and advancing publication revisions. It stopped cleanly and left no helper process. This checks the actual process and callback path under lost foreground; the positive draft-to-combat path is backed by the authorized native observations and automatic replay described above.

An earlier helper-only experiment, before final icon integration, showed no idle CPU counter increment over 5.232 seconds. Twenty synthetic frames at two requests per second used 0.53125 CPU seconds over 9.765 seconds, or 0.3400% across this machine's 16 logical processors. Reads took 13.03–35.96 ms, averaging 16.385 ms; peak reported working set was 144.32 MiB. This excluded Electron and is development evidence. Current whole-application measurements and their scope belong in [the performance document](performance.md). These checks do not establish a game FPS or frame-time result.
