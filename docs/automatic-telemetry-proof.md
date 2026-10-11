# Automatic Street Brawl telemetry proof

This is the first implementation milestone for the Windows companion. The user requires automatic detection without screenshots, OCR, or manual item entry. A nice interface, complete item catalogue, replay parser, or successful public HTTP request does not satisfy that requirement.

Research date: October 3, 2026. The specification below distinguishes observed provider support from proposed fields. No provider request has been sent, no application proposal has been submitted, and no live participant test was performed for this planning task.

## Existing support and proposed additions

Overwolf's published Deadlock documentation describes match identity, roster, purchased items, and limited ultimate flags. Its changelog explicitly supports Street Brawl. It does not publish a current unselected-offer event or complete ability-rank contract. [Deadlock events](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/deadlock/), [changelog](https://dev.overwolf.com/ow-native/getting-started/changelog/ow-changelog/)

The mirrored Valve draft representation and community parser provide a concrete extension target. Treat field names below as a proposed application contract, not existing GEP APIs. [Draft schema](https://github.com/SteamTracking/GameTracking-Deadlock/blob/4c6431ccdb816d2911bbbaa4335169cc34140386/DumpSource2/schemas/client/ItemDraftOption_t.h), [community parser](https://github.com/deadlock-api/deadlock-api/blob/f6e1974d45af3ccebe0f36324ea22e1e12990ff3/live-events/src/demo_parser/entity_events.rs)

| Proposed capability | Required payload or semantics | Why it matters |
| --- | --- | --- |
| `participant_match` | Current match/mode/build, local seat/hero/team, connected/reconnected identity | Cannot attach to an arbitrary public spectator match |
| `street_brawl_round` | Actual phase, round, team scores, confirmed deadline, pick stage | Distinguish draft, combat, transition, and finished match |
| `own_draft_offers` | Draft ID, generation/source sequence, exact option positions, main item and bonus items, drafted/rare flags | Rank exactly what the player can choose now |
| `offer_modifiers` | Item ID, packed upgrade bits, ability level, decoded enhancement/legendary/corruption details or explicit unknown | Names alone do not describe the resulting bundle |
| `own_reroll_state` | Actual remaining rerolls, legal availability, refresh/bonus changes, explicit reroll transition | Draft counters and a changed offer do not prove a reroll |
| `current_inventories` | Per-seat inventory plus complete/delta/remove/upgrade semantics and modifier identity | Purchased history cannot always describe current ownership |
| `ability_investment` | Per-seat unlocked ability IDs and exact investment tiers, completeness and participant visibility | A hero level or ultimate-ready flag is not all ability ranks |
| `corruption_decision` | Runtime eligibility, eligible owned items, exact positive/negative modifiers, opportunities remaining, skip availability | A configured Round 5 event is not a complete corruption recommendation input |
| `source_continuity` | Live sequence/watermark, health, gap/restart semantics; game-origin clock/offset uncertainty or independently bounded delivery contract | Sequence proves ordering, not absolute freshness; a delayed stream can be continuous |

Exclude other players' private offers and information not normally available to the participant. If enemy ability ranks are not an allowed field, record that as an unresolved requested capability.

## Reviewable provider request

The following is a draft for later authorized submission; it has not been sent:

> We are planning a Windows desktop companion for Deadlock Street Brawl, displayed on a second portrait monitor. It provides item-pick, reroll, and ability-upgrade advice while the human player executes all gameplay actions. We require structured automatic data and prohibit screenshot/video capture, OCR, and image recognition.
>
> Please confirm the current Deadlock GEP acquisition method meets that restriction, its supported Street Brawl fields and current-build compatibility, and whether this proposed use is eligible for your app review process. We need the local player's current unselected draft offers with option order, item and bonus-item identities, modifier/upgrade bits, pick stage, actual remaining rerolls, round/deadline, and source sequencing. We also need participant-visible rosters, current inventories, and supported exact ability investment, without exposing hidden enemy information.
>
> Mirrored game schemas contain ItemDraftOption_t with main/bonus items and item modifier fields, and public replay parsers contain round and ability investment fields. These demonstrate candidate representations, not an assumption that your current GEP exposes them. Could a managed provider extension expose the participant-visible subset? Please document the event contract, update latency, reset/hydration semantics, mode/build identifiers, visibility/completeness guarantees, development access, distributed-build requirements, and whether any normalized data retention is permitted for evaluation.

A provider answer is an integration dependency. It should identify exact coverage and method; a generic statement that Deadlock is supported is not sufficient. Any unpublished Platform API requires prior written permission under Developer Terms section 4.1.12, or publication as a documented extension. Overwolf approval must not be described as independent Valve endorsement. [Developer terms](https://legal.overwolf.com/docs/overwolf/developers/developer-terms/)

## Minimal engineering prototype

Use the supported provider runtime with one normal desktop diagnostic window. Launch the companion/listeners before Deadlock; register required features as soon as the game launches, with documented retries. Obtain current-state hydration and subscribe to updates through the documented interface. Show normalized state in memory and provider health without building the recommendation product yet. [Feature-registration guidance](https://dev.overwolf.com/ow-native/live-game-data-gep/live-game-data-gep-intro/#set-required-features)

Keep the prototype isolated from game input and visual extraction. Do not use a recorder package, request screen-capture permission, install custom process hooks, or create a raw GEP log archive. In-memory-only operation is the prototype's design decision. Provider documentation advises against logging GEP data; future training persistence requires review of applicable terms and clarification where necessary. [GEP overview](https://dev.overwolf.com/ow-native/live-game-data-gep/live-game-data-gep-intro/)

The diagnostic display should include:

- Match/mode/build, local seat, roster, source health/version, and continuity watermark.
- Round, phase, pick stage, actual deadline, draft ID, and offer generation.
- Each ordered option's main item, bonuses, raw packed modifier values held in memory, resolved variant, and availability.
- Actual rerolls plus a separate classification of pick, reroll, round transition, and hydration.
- Inventory and ability updates with completeness/removal semantics.
- Runtime corruption eligibility and exact option modifiers when that event is active.
- Operational latency counters; never relabel receive time as game observation time.

Use synthetic fixtures to test display and state transitions before provider access. Keep Demo visible. Synthetic data must not be used as evidence that acquisition works.

## Observation procedure

1. Verify the installed game build and exact provider runtime/version. Pin the corresponding assets and schema manifest.
2. Launch the prototype before Deadlock and enter a real Street Brawl match. Confirm match identity and all eight seats automatically.
3. A human observes the actual game UI and the text event inspector. Compare every offer position, item/bundle/modifier, draft stage, and reroll count. No screenshots, video, or OCR are necessary.
4. Observe selections and legal rerolls performed normally by the player. Verify event distinctions, option replacement semantics, inventory changes, and budget transitions.
5. Check each round, winning/losing round bonus behavior, and Round 5 content if encountered. Static base schedules are not runtime ground truth.
6. Compare participant-visible team/opponent inventory and ability information with the provider. Identify any fields that reveal normally hidden state and exclude them.
7. Repeat with companion launch during a match, companion restart, provider interruption, game exit, and transition to another match. Cached hydration must not preserve old draft advice.
8. Use human observation to validate correctness and approximate timeliness. Precise game-change-to-normalized-state measurements require a documented game-origin clock mapped to the local monotonic clock, including offset uncertainty, or an independently bounded delivery contract. Otherwise source age remains unknown and report only receipt-to-render latency. Distinguish upstream delay, transport, processing, and rendering; replay download time is not live latency.
9. Build and sign a distributed test executable through the supported process and repeat. Development-only event access is insufficient for release feasibility.
10. Produce a capability table and discrepancies, with no personal payloads in diagnostic exports. Save a human-authored test summary and aggregate metrics where permitted.

Proposed discovery sample: at least three complete matches. A successful discovery is followed by a broader alpha proposed at twenty matches and at least two hundred offer generations. These are planned test sizes, not completed validation.

## Decision criteria

| Result | Decision |
| --- | --- |
| Complete own offers/bundles, legal rerolls, round context, correct local identity, supported method, bounded timely delivery | Pass draft feasibility and proceed with drafting/portrait work; inventory/ability features and full delivery still require the separate full tracking gate |
| Roster/items work, but current offers are absent | Request a provider-managed extension; do not label the dashboard a usable version of the requested product |
| Draft schema exists, but arrays are empty or source is delayed/unavailable | Does not pass; retain it only as offline/schema evidence |
| Modifiers, reroll semantics, or source continuity are unknown | Does not pass precise pick/reroll guidance; resolve contract and tests first |
| Some requested ability/inventory fields are unsupported or hidden | Full tracking gate fails for those fields; block dependent features and complete-product delivery, document the gap, and do not invent ranks |
| No supported path meets automatic/no-image requirements | Record the product as dependent on provider/Valve support; no manual fallback replacement |

Stage 0 measures draft-change-to-normalized-state when the source clock/delivery contract permits it. The later scoring/alpha target is p95 true draft-change-to-advice at or below one second; Stage 0 alone has no scorer and cannot validate that full path. Atomically remove superseded advice when the adapter accepts a transition and reject prior worker generations, while separately bounding the real-game-to-receipt interval. Local processing targets cannot conceal upstream delay.

The proof should return a concrete capability report, method/permission evidence, tested versions, aggregate latency, observed correctness, and the smallest remaining provider work. It should settle whether full product development is justified, rather than merely showing that game data can be parsed somewhere.
