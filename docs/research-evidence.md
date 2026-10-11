# Street Brawl companion research evidence

Checked October 3, 2026. This register separates published contracts, direct read-only public samples, verified prior files, and proposed engineering decisions. A community mirror of Valve-authored assets is identified as a mirror, not an official Valve API.

Reviewed source pins: SteamTracking game assets/schema commit `4c6431ccdb816d2911bbbaa4335169cc34140386`; Deadlock API source commit `f6e1974d45af3ccebe0f36324ea22e1e12990ff3`. Provider documentation and current public response URLs are mutable, so implementation must retain retrieval metadata and hashes for its own immutable bundles.

## Eight research workstreams

| Workstream | Contribution |
| --- | --- |
| Live data | Participant vs spectator access, GEP coverage/health, draft schema, latency and availability gaps |
| Street Brawl mechanics | Round resources, mode-specific rules, version changes, draft bundles and special variants |
| API and assets | Mode filters, populated historical samples, current assets and schema/field limitations |
| Recommendation engine | Marginal bundle utility, sequential pick/reroll model, statistical bias and evaluation needs |
| Windows architecture | Supported runtime, state correctness, caching, packaging, monitor/DPI and deployment requirements |
| Portrait experience | Phase-aware layout, missing-data states, readability and automatic-only acceptance |
| Valve policies | Gameplay automation, normally hidden state, support/approval distinctions and privacy boundaries |
| Existing context | Prior chats, real local source/data inspection, stale catalogue and statistical provenance audit |

No external messages were sent and no provider proposal was submitted. Research probes were read-only. The planning task did not test a live participant feed or measure game-state-to-advice latency.

## Primary source register

| Source | What it supports | Limit |
| --- | --- | --- |
| [Valve Old Gods announcement](https://www.playdeadlock.com/oldgods) | Original Street Brawl format and draft concept | January launch rules may be superseded |
| [Valve City Never Sleeps update](https://www.playdeadlock.com/cityneversleeps) | September content, including temporary corrupted-item behavior | Runtime event activation on October 3 remains to verify |
| [Valve developer changelog forum](https://forums.playdeadlock.com/forums/changelog.10/) | Official later rule/balance updates | Use exact dated notes and installed build, not forum user assertions |
| [Overwolf Deadlock GEP contract](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/deadlock/) | Published roster, items, match identity, limited ultimate fields | No published unselected-offer/full ability-rank contract |
| [Overwolf GEP changelog](https://dev.overwolf.com/ow-native/getting-started/changelog/ow-changelog/) | Version 300.0.1 explicitly adds Street Brawl; later item fixes | Does not guarantee all fields work in current build |
| [Overwolf current Deadlock health JSON](https://game-events-status.overwolf.com/24482_prod.json) | During research: published/enabled health, minimum GEP 314.2.4 | Health is mutable; its listed keys and item documentation differ; `is_vgep=false` does not establish acquisition method |
| [Overwolf GEP overview](https://dev.overwolf.com/ow-native/live-game-data-gep/live-game-data-gep-intro/) | Subscription, hydration, reset/health caveats; warning against logging GEP | Provider method/retention for this exact use still requires resolution |
| [Overwolf framework comparison](https://dev.overwolf.com/ow-electron/getting-started/onboarding-resources/frameworks-overview/) | Electron runtime independent of Native client | Ordinary Electron/WPF cannot be assumed to inherit GEP access |
| [Overwolf release process](https://dev.overwolf.com/ow-electron/getting-started/release-your-app/) | Whitelisting, signing, visible desktop window, review requirements | Does not promise review or provider-extension timing |
| [Overwolf Developer Terms](https://legal.overwolf.com/docs/overwolf/developers/developer-terms/) | Section 4.1.12 requires written permission for undocumented Platform APIs | A proposed unpublished draft extension needs documented or authorized development access |
| [Overwolf C# plugin guide](https://dev.overwolf.com/ow-native/guides/dev-tools/plugins/writing-your-own-ow-plugin/) | Framework 4.8/x64 plugin guidance | Does not document a .NET 10 WPF external relay |
| [Overwolf second-screen guidance](https://dev.overwolf.com/ow-native/guides/product-guidelines/app-screen-behavior/second-screen/) | Native desktop window/display behavior | Electron uses its own documented display APIs |
| [Deadlock API OpenAPI](https://api.deadlock-api.com/openapi.json) | Exact analytics/asset/match contracts and mode filters | Community API; schema does not guarantee population, coverage, or causality |
| [Public draft replay schema](https://api.deadlock-api.com/v1/matches/demo/schema) | Pawn/round/ability fields available to replay parsing | Not a supported local participant API |
| [Community event parser source](https://github.com/deadlock-api/deadlock-api/blob/f6e1974d45af3ccebe0f36324ea22e1e12990ff3/live-events/src/demo_parser/entity_events.rs) | Item/ability packed-field decoding implemented by provider | Not proof of permissible/timely all-player live use |
| [Generic assets](https://api.deadlock-api.com/v1/assets/generic-data) | Populated draft and round settings | Some raw mirrored bias fields are omitted; current unpinned endpoint is mutable |
| [Item assets](https://api.deadlock-api.com/v1/assets/items), [hero assets](https://api.deadlock-api.com/v1/assets/heroes) | Mechanics, mode overrides, hero draft preferences | Definitions do not identify owned items or current offers |
| [Mirrored generic Valve data](https://github.com/SteamTracking/GameTracking-Deadlock/blob/4c6431ccdb816d2911bbbaa4335169cc34140386/game/citadel/pak01_dir/scripts/generic_data.vdata) | Configured round schedule and weighting fields | Community mirror; pin commit/build and verify server behavior |
| [Mirrored steam.inf](https://github.com/SteamTracking/GameTracking-Deadlock/blob/4c6431ccdb816d2911bbbaa4335169cc34140386/game/citadel/steam.inf) | Reviewed client 6745/revision 11078118 | Not verification of the user's installed build |
| [Mirrored option schema](https://github.com/SteamTracking/GameTracking-Deadlock/blob/4c6431ccdb816d2911bbbaa4335169cc34140386/DumpSource2/schemas/client/ItemDraftOption_t.h), [item schema](https://github.com/SteamTracking/GameTracking-Deadlock/blob/4c6431ccdb816d2911bbbaa4335169cc34140386/DumpSource2/schemas/client/ItemDraftItem_t.h) | Main/bonus bundle and item modifier structure | Existence is distinct from visible populated fields |
| [Live-service indexed quickstart](https://live.deadlock-api.com/docs/quickstart) | Provider-reported 60–90 second public spectate delay | Direct research fetches failed; production availability not established |
| [Electron screen API](https://www.electronjs.org/docs/latest/api/screen), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security) | Display/DPI handling and safe renderer design | Implementation still needs hardware validation |
| [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/), [Steam API terms](https://steamcommunity.com/dev/apiterms) | Automation/process and unfair-advantage restrictions | No Deadlock-specific companion approval was found |
| [Steam VAC support](https://help.steampowered.com/en/faqs/view/571A-97DA-70E9-FF74) | Anti-cheat policy background | Read-only/second-monitor status is not a blanket exemption |
| [Valve Dota statement](https://www.dota2.com/newsentry/3677788723152833273) | Analogous precedent about normally invisible client information | February 2023 Dota policy, not a Deadlock ruling |

## Direct API observations

These observations came from bounded read-only research probes; they are not recorded live participant sessions.

- Current asset responses contain 738 mixed item/ability/weapon records and 65 hero records; they are not counts of purchasable/released content.
- `generic-data.street_brawl` has populated buy time, ability points, base rerolls, score-to-win, corruption-round, and draft-weight data.
- Lady Geist's hero asset contains populated Magic Burst/Headhunter draft preferences; some other weight fields are null. Null is not a zero weight.
- A completed Street Brawl metadata sample, match 110511353, has eight players, team score `[0,3]`, and item upgrade encodings. It confirms historical mode-specific population, not current offers.
- A Lady Geist item query with `game_mode=street_brawl`, `hero_ids=4`, `min_unix_timestamp=1790726400`, and `min_matches=20` returned 172 item rows. An ability-order query for the same hero/window returned 39 sequences. These are aggregate purchases/orders without round or enhanced-variant grouping. Item analytics separately support a corrupted-status filter. [Item probe](https://api.deadlock-api.com/v1/analytics/item-stats?game_mode=street_brawl&hero_ids=4&min_unix_timestamp=1790726400&min_matches=20), [ability probe](https://api.deadlock-api.com/v1/analytics/ability-order-stats?game_mode=street_brawl&hero_id=4&min_unix_timestamp=1790726400&min_matches=20)
- The REST query parameter is `game_mode=street_brawl`. Completed metadata uses `StreetBrawl`; Watch/replay uses numeric mode 4. These representations must be mapped explicitly rather than conflated.
- Analytics default to normal; Street Brawl badge filters are unsupported. Item bucket/time/net-worth fields do not supply before-pick round state or unchosen offers.
- Source inspection shows hour-rounded shared timestamp filters and day-grained hero/item rollups; the hero aggregate's upper bound includes the full cutoff day. That can plausibly explain later Rat King appearances within the supposedly pre-release window, but is not a proven diagnosis. Raw item statistics expand acquisition arrays, so repeated same-item acquisitions can count more than once in matches; distinct players and clustered/deduplicated observations matter. [Pinned time filters](https://github.com/deadlock-api/deadlock-api/blob/f6e1974d45af3ccebe0f36324ea22e1e12990ff3/api/src/routes/v1/analytics/common_filters.rs), [pinned hero implementation](https://github.com/deadlock-api/deadlock-api/blob/f6e1974d45af3ccebe0f36324ea22e1e12990ff3/api/src/routes/v1/analytics/hero_stats.rs), [pinned item implementation](https://github.com/deadlock-api/deadlock-api/blob/f6e1974d45af3ccebe0f36324ea22e1e12990ff3/api/src/routes/v1/analytics/item_stats.rs)

Public asset and analytic caches can serve data older than request time. Versioned assets, model windows, retrieval timestamps, and compatibility checks are therefore separate inputs. Legacy `assets.deadlock-api.com` failed direct DNS probes; the canonical main API asset namespace worked.

## Recovered source directories

Existing companion and its source-backed research:

`C:\Users\Random\Documents\Codex\2026-09-30\task-2\street-brawl-companion`

Latest saved research/statistics:

`C:\Users\Random\Documents\Codex\2026-10-03\research-and-find-what-the-absolute\work`

Prior read-only static extracts and policy pages also exist under:

`C:\Users\Random\AppData\Local\Temp\deadlock-streetbrawl-research-20260930`

The current Deadlock workspace was initially empty apart from Git metadata. No validated personal match-history dataset or relevant Page source was retrieved. Relevant chats were “Find the best Street Brawl build” and “Build Deadlock Street Brawl Companion”; their claims were checked against actual files where possible.

### Existing companion

| Relative path within the companion directory | Verified reuse and limitation |
| --- | --- |
| `src/Brawl.Core/Catalog.cs`, `MatchState.cs`, `Evidence.cs` | Capture-independent catalogue and eight-seat evidence-aware state; positive partial inventory merge needs replacement/removal semantics |
| `src/Brawl.Core/RecommendationEngine.cs` | Deterministic explainable tag baseline; not a learned marginal-value model or reroll optimizer |
| `scripts/import-game-data.mjs` | Pinned public assets and installed metadata/localization checks |
| `data/catalog.json`, `data/catalog-provenance.json` | Client 6723/revision 11059930/build 25627654; 173 base shop items, 38 released heroes, 152 signature abilities; stale and excludes Rat King |
| `src/Brawl.DirectInput/CommunityEventReader.cs` | Selected JSON/JSONL imports labelled Estimate; not an automatic participant subscription or draft/inventory feed |
| `src/Brawl.DirectInput/SteamMetadataReader.cs`, `ConsoleDiagnosticsReader.cs` | Limited metadata/diagnostics; not gameplay state |
| `docs/research-direct-inputs.md`, `docs/research-mechanics.md`, `docs/static-data.md` | Prior source map, mechanics and explicit integration limitations |
| `tests/Brawl.DirectInput.Tests/Fixtures/public-street-brawl-pawn-redacted.json` | September 30 public probe for match 109121942: mode 4, all five offer arrays empty, zero drafts remaining, no hero ID |
| `artifacts/verification-summary.json` | Prior build checks; no claim of real live gameplay accuracy |

### Existing statistical data

| Relative file within the October 3 work directory | Observed grain and caveat |
| --- | --- |
| `street-brawl-hero-stats.json` | 39 hero aggregate rows; requested `bucket=no_bucket&game_mode=street_brawl&min_unix_timestamp=1790974791`; no maximum timestamp/account/rank filter |
| `street-brawl-item-stats.json` | 343 item rows from hero buckets for Paige/Rat King; requested heroes 84,67,71; ID 71 was a mistake for Graves |
| `graves-brawl-items.json` | 166 separate Graves item rows using hero 76 |
| `brawl-pre-rat-stats.json` | 39 hero rows with 2,956 Rat King appearances in a supposedly prerelease time window; unresolved temporal attribution |
| `heroes.json`, `items.json` | Unpinned current static definitions, not possession or offer data |
| `deadlock-openapi.json` | Saved API contract, including mode/item/ability endpoints and six-hour item-analytics cache documentation |
| `valve-news.json`, `steam-news.json` | Saved announcements/news; individual items require source/date discrimination |

Saved aggregate files passed basic count and duplicate-key consistency checks. Internal consistency does not prove the requested temporal filter, representative sampling, correct patch attribution, or causal item value. Exact requests were recovered from the prior chat; the raw aggregates need a provenance envelope before model import.

No saved offer-set, reroll-transition, round-conditioned decision, or ability-order dataset was found in the recovered work. Current API queries can add historical ability priors, but cannot reconstruct unchosen choices from final purchases.

## Research limitations

No live no-image acquisition method was demonstrated. No authoritative Deadlock-specific approval for this exact proposed use was found. No automatic own-draft event is documented in the reviewed GEP contract. Some published schema/configuration fields may be empty, delayed, not participant-visible, or disabled by server flags. The commercial live-service domain was not reachable in direct research attempts.

The product plan therefore makes participant telemetry its first pass/fail milestone. It does not substitute manual input, historical builds, public spectator data, or synthetic fixtures for automatic current-game information.
