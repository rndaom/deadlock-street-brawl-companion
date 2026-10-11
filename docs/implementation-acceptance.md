# Implementation acceptance checklist

Derived from the project research on October 3, 2026, with the user's later instructions applied. The user now authorizes visible-screen reading and requires the original full match context: both teams' heroes and inventories, the local hero/build and actual ability investments, and situational item guidance. The latest presentation preference puts the item to consider first and keeps enemy heroes/items visible; own abilities, allied builds, evidence and settings remain available in closed details. Screen reading replaces the archived no-image acquisition constraint; no gameplay input, hooks, or hidden-state access is added. The [full-context screen audit](full-context-acceptance.md) defines the visible surfaces and practical checks for this route.

This is a build and verification checklist, not a report of completed participant tests. Synthetic fixtures verify application contracts; normal game observations establish real field coverage, accuracy, transitions, and game-change-to-advice latency.

## Source traceability

| Ref | Project source | Requirements used here |
| --- | --- | --- |
| P1 | [Application plan: Product requirements](street-brawl-companion-plan.md#product-requirements) | Own automatic offers; eight-seat roster; current inventories; actual ability investment; no manual data entry; advice only. The later user request permits the image route |
| P2 | [Application plan: State correctness](street-brawl-companion-plan.md#state-correctness) | Field provenance, unknown values, source continuity, atomic invalidation, frozen decision keys, inventory operations, pinned match catalogue |
| P3 | [Application plan: Street Brawl rules and versioning](street-brawl-companion-plan.md#street-brawl-rules-and-versioning) | Runtime deadlines/rerolls; ordered bundles and modifiers; variable round/pick pools; runtime corruption eligibility; no fixed inventory cap |
| P4 | [Application plan: Item and reroll recommendations](street-brawl-companion-plan.md#item-and-reroll-recommendations) | Whole-bundle utility, honest explanations, separately validated reroll probabilities, missing-input gates |
| P5 | [Application plan: Portrait experience](street-brawl-companion-plan.md#portrait-experience) | Persistent Demo state, unavailable/interrupted/unsupported states, game-order offers, 720 by 1280 layout and focus behavior |
| P6 | [Application plan: Acceptance targets](street-brawl-companion-plan.md#acceptance-targets-to-measure) | Meaningful state tests, separate local and true-source timing, real-match and distributed-build verification |
| T1 | [Telemetry proof: Existing support and proposed additions](automatic-telemetry-proof.md#existing-support-and-proposed-additions) | Published purchased items are not an own-offer/full-rank contract; proposed capabilities remain proposed |
| T2 | [Telemetry proof: Observation procedure](automatic-telemetry-proof.md#observation-procedure) | Three-match discovery; clock uncertainty or bounded delivery; restart/reconnect/hydration and visibility checks |
| T3 | [Telemetry proof: Decision criteria](automatic-telemetry-proof.md#decision-criteria) | Separate draft feasibility and full inventory/rank tracking gates; withheld dependent advice |
| E1 | [Research evidence: Direct API observations](research-evidence.md#direct-api-observations) | Explicit mode mapping; caches can predate retrieval; static definitions and completed purchases are not live state |
| E2 | [Research evidence: Recovered source directories](research-evidence.md#recovered-source-directories) | Stale old catalogue; positive-only inventory merge is insufficient; empty draft arrays are negative evidence; statistical provenance gaps |

Linked primary documents and immutable research pins remain in these source documents. This checklist does not redefine a provider API.

## Build acceptance

### Acquisition and honest availability

- [ ] Default Live startup reads the visible game automatically and displays the actual waiting, reading, or unavailable state. Synthetic data starts only in Demo, whose label persists across every screen and phase. (P1, P5, latest user request)
- [ ] Live and Demo have separate source identities. Entering or leaving Demo resets match state and advice rather than preserving synthetic values in a live session. (P2, P5)
- [ ] A capability report distinguishes documented, unsupported, unknown, and tested fields. A healthy provider connection alone never enables own-offer, inventory, rank, or reroll capabilities. (T1, T3)
- [ ] No production manual roster/offer/round/reroll entry, gameplay input automation, invented GSI contract, custom hooks, or automatic raw participant archive exists. The authorized screen route captures only the visible foreground game client; a preview remains an explicit user action. (P1, latest user request)
- [ ] The participant source uses only normally visible information. Enemy private offers and hidden ranks are excluded. Reading a collapsed panel, spectator view, tooltip, purchase feed, or catalogue cannot establish local ownership or complete player context. (T1, T2, screen audit)

### Identity, evidence, and source freshness

- [ ] Match state carries the reader/provider epoch, observed mode/build/local seat/teams, and distinct visual seat keys. A true game match ID or Steam ID is stored only when supplied by an authorized source; the screen reader's window/session ID is never presented as a game match ID. Unknown identity remains explicit, and repeated hero names or blank/bot IDs do not collapse seats. (P1, P2, E1, screen audit)
- [ ] Every field distinguishes known, unknown, unavailable, and incomplete where applicable. Unknown rerolls/ranks/items are not represented as zero, an empty complete inventory, or a typical build. (P2, P5)
- [ ] Preserve provider, match/seat, sequence/watermark, receipt time, origin time when available, visibility, and completeness. Preserve changed time separately from confirmation time. (P2)
- [ ] Structured-feed freshness uses a mapped origin clock or independently bounded delivery contract. The screen route records verified current capture time and processing age separately; reusing OCR is fresh only after a new capture verifies identical pixels. Fields outside that frame retain their own earlier observation time. (P2, T2, screen audit)
- [ ] Receipt-to-state, scoring, and receipt-to-render metrics are named separately from game-change-to-advice. A heartbeat or copied historical snapshot does not refresh the game observation time. (P2, P6, T2)
- [ ] Duplicate/out-of-order events cannot regress state. Gaps, provider restarts, stale fields, and disconnects invalidate affected advice until accepted compatible hydration restores the required fields. A new source epoch may restart its sequence. (P2, T2)
- [ ] A new match, local-seat change, mode change, game exit, or provider identity change clears dependent match state and rejects events/workers from the prior identity. (P2, T2)

### Atomic state and model contracts

- [ ] One reducer/store transaction removes advice when accepting a pick, reroll, offer replacement, round/phase change, disconnect, or incompatible build/model update. No renderer frame may show new state paired with old advice. (P2, P6)
- [ ] Scoring input is immutable and keyed by source epoch, match, round, draft ID, offer generation, inventory revision, ability revision, and pinned catalogue/model versions. Worker output must match the current key in full. (P2)
- [ ] Advice invalidates when relevant inventory or ranks change, even when draft generation is unchanged. A rejected stale worker cannot restore superseded advice. (P2)
- [ ] Catalogue, modifier decoder, and model compatibility are explicit. Do not infer compatibility from names, retrieval date, or a green source indicator. Keep the compatible bundle pinned during a match; install replacement bundles between matches. (P2, E1, E2)
- [ ] Unsupported item IDs, unknown modifier bits, inconsistent positions, or incompatible builds withhold dependent comparisons and appear as explicit unavailable/unsupported state. Never silently convert a variant to its base item. (P2, P3, T3)

### Current inventories, ranks, and draft semantics

- [ ] Purchased-item history is displayed and stored separately from confirmed current inventory. An adapter promotes neither history nor additive-only events to a complete ownership claim without documented semantics. (P1, P2, T1)
- [ ] Complete snapshots replace inventory; additive deltas preserve unaffected items; removal, replacement, and upgrade operations modify the correct instance and modifier identity. Completeness survives only supported continuity. (P2)
- [ ] A player's accepted choice removes old advice immediately, but inventory advances only on a supported ownership update. Offer changes alone do not establish a pick or reroll. (P2, T1)
- [ ] Exact observed ranks/unlocks and completeness are separate from hero level, ultimate-ready flags, upgrade costs, team AP totals, and aggregate upgrade-order priors. The next local upgrade is visible in the app; an upgrade-now directive requires actual local investment and observed unspent AP or verified affordability. A conditional priority is clearly labelled when legality is unknown. (P1, T1, T3, screen audit)
- [ ] Offers preserve game position, main item, both bonus items, raw/decoded modifiers, drafted/rare flags, availability, draft identity, and generation. Highlighting does not reorder cards. (P3, P5)
- [ ] Deadline comes from confirmed current phase data. A static 50-second round estimate is not a current countdown. Reroll budget comes from actual legal runtime state rather than the configured base schedule. (P3, T1)
- [ ] Runtime corruption activation, eligibility, both effects, remaining opportunities, and skip option are required before corruption advice. Round 5/configuration alone does not enable it. (P3, T1)

### Advice and display

- [ ] The default screen gives the current item suggestion the strongest visual emphasis and shows observed enemy heroes/items. Own build, ability advice, allies, facts, reroll model details and reader configuration are accessible without occupying the essential view. Closing details does not stop their acquisition or use in scoring. The short material uncertainty remains beside the suggestion. (Latest user preference)
- [ ] Current pick guidance requires usable current offers, understood bundles, correct identity/phase, bounded source freshness, and a compatible scoring model. Missing contextual ranks/inventories are explicit qualifiers; they cannot be claimed complete. (P1, P2, P4, T3)
- [ ] Conditional main-item guidance has its own position and visible base-effects label. It excludes every bonus/modifier consistently and withholds an affected highlight for undecoded owned-item repeats. It cannot appear as a confirmed full-card pick merely because detailed limitations are collapsed. (Latest implementation scope, screen audit)
- [ ] Reroll guidance additionally requires legal runtime availability/budget, a validated replacement distribution, and sufficient confirmed time. Missing probabilities do not become fabricated odds or a favourite-item reroll rule. (P4)
- [ ] A utility score is not labelled win probability. Two short reasons explain the selected whole bundle and evidence limits. Correlated buyer win rates are not offer probabilities or proof of policy lift. (P4, E2)
- [ ] Waiting for draft data, interruption, expired drafts, unsupported build/items, unknown source age, and post-match state have no affected actionable directive. (P2, P5, T3)
- [ ] At 720 by 1280 logical units, the decision, ordered offers and source state are easy to inspect; enemy builds remain in the essential view. Own/allied detail and explanation depth do not displace the decision. Inventories expand without a fixed 12-item cap; labels supplement colour, and updates do not steal game focus. (P3, P5, P6, latest user preference)

## High-risk automated state tests

Use synthetic normalized fixtures. These tests prove reducer and gating behavior, not provider field availability.

| Case | Setup and transition | Expected result |
| --- | --- | --- |
| Fresh receipt, old source | Current draft snapshot received now; game-origin time is 90 seconds old | No current advice; old observation age is preserved |
| Continuous unknown-age feed | Increasing sequence and healthy connection; no source clock or delivery bound | Source age remains unknown; receipt timing is still measurable; live directives remain gated |
| Unchanged confirmed inventory | Identical inventory confirmation through a continuous, bounded feed | Confirmation advances without changing the original changed time |
| Unknown versus zero | Missing rerolls/ranks/inventory, then explicit zero/empty complete values | The two states render and gate differently; unknown values are never coerced |
| Partial inventory | Complete `[A,B,C]`, then additive `[D]`, then incomplete hydration `[E]` | Addition preserves A/B/C; incomplete hydration is not called complete; stale items do not silently become confirmed |
| Remove and upgrade | A/B with instance IDs; remove A; upgrade B to B+ with distinct modifiers | A disappears, B is replaced once, unrelated items survive, revision advances |
| Purchased history only | Purchase A then upgrade/removal semantics absent | History shows A; complete current inventory capability remains unavailable |
| Atomic replacement | Advice for generation 7; accept generation 8 offers | Generation 7 advice disappears in the same published state; positions remain correct |
| Late worker | Generation 7 worker resolves after generation 8; or ranks change with generation unchanged | Result is rejected against the full snapshot key |
| Pick without ownership | Accept pick transition; inventory event has not arrived | Advice clears; inventory does not speculatively gain the offer |
| Duplicate/order/gap | Duplicate sequence, older sequence, then a sequence gap | No duplicate inventory mutation or regression; gap gates advice until compatible hydration |
| Provider restart | Prior epoch at sequence 100; new epoch begins at sequence 1 | New epoch is accepted with reset/hydration; old epoch events cannot mutate it |
| Match and local identity reset | Match A worker pending; match B arrives with reused seat indices or changed local seat | A state/advice disappear atomically; old events/workers are rejected |
| Demo exit | Synthetic current draft; select Live with no participant feed | Demo state clears; unavailable-provider state appears; no synthetic roster/advice survives |
| Same name, unknown variant | Known item name with unknown ID or modifier bits | No name matching or base-item substitution; affected comparison withheld |
| Build/model mismatch | Mid-draft game build differs from pinned catalogue or result model version | Advice invalidates; incompatible result is rejected; source status explains the gap |
| Unknown replacement model | Complete offers and actual reroll count; no validated draw/replacement probabilities | No reroll directive or made-up chance; eligible pick reasoning may remain |
| Expiry/combat transition | Deadline passes or combat begins while worker is running | Draft directive disappears and cannot be restored by that worker |
| Corruption flag absent | Round 5 and configured corruption support, runtime activation unknown | No corruption advice or inferred eligible target |
| Bot identifiers | Eight seats; two blank Steam IDs and duplicate bot identifiers | Eight distinct seats survive; IDs remain strings |
| Mode ambiguity | Normal-mode event, numeric 4, `StreetBrawl`, and `street_brawl` fixtures | Only documented explicit mappings enter Street Brawl; unsupported mode resets/gates advice |

## Release evidence still required

- [ ] Authorized visible-screen acquisition is checked in normal participant matches with errors, unread fields, panel visibility, and field age recorded. The archived no-image/provider discovery gate applies only to that separate provider route. (T2, T3, latest user request)
- [ ] Full tracking gate separately verifies current ownership semantics and permitted exact ability ranks. A draft feasibility pass is not a full product pass. (P6, T3)
- [ ] Proposed alpha coverage: twenty matches and at least two hundred offer generations, including restarts, reconnects, picks/rerolls, and active special variants. (P6, T2)
- [ ] Proposed p95 true draft-change-to-advice at most one second, scoring below 100 ms, and receipt-to-render below 500 ms measured on the target PC. Without a mapped origin clock or bounded delivery, only local timings are verified. (P6)
- [ ] Supported signed distributed build demonstrates the same capabilities as development; portrait/DPI/monitor removal behavior is checked on Windows. (P6, T2)

Until field checks pass, describe each implemented screen capability as a game-test feature and distinguish static-source evidence, synthetic contract tests, and actual game observations. A local packaged build can be tested without waiting for the separate provider extension. Do not describe full tracking or optimal recommendations as verified merely because the application builds.
