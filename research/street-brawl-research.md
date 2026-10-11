# Deadlock Street Brawl: research notes for the item-draft companion

Compiled 2026-10-04. Sources were fetched on that date. Game client build at the time was 6746, from `https://api.deadlock-api.com/v1/assets/client-versions`.

How to read the flags:
- **[VERIFIED-DATA]** I fetched this from the public deadlock-api JSON myself today. Those endpoints mirror Valve's game files.
- **[WIKI]** or **[PATCH]** come from the community wiki or from Valve's patch notes.
- **[3RD-PARTY]** comes from a community tool or a guide.
- **[UNCERTAIN]** or **[POSSIBLY OUTDATED]** means a single source, my own interpretation, or something that has changed recently.

Street Brawl changes often. Valve has published balance passes specific to it in Jan, Feb, Mar, Jun and Sep 2026, and on 2026-10-04 it silently removed a feature that was added on 2026-09-29. Re-pull the data before trusting any hard-coded numbers.

---

## 0. TL;DR for the recommender

1. **Draft structure**
   - Each of the 5 rounds has **3 sequential choices** ("Choice 1 of 3" through "3 of 3"). Each choice offers **3 cards**, and you keep 1.
   - You get **1 re-roll per round**. Picking "Random Hero" adds a bonus re-roll in rounds 1–3.
   - Buy/draft time is **50 s** in rounds 1–4 and **65 s** in round 5.
   - Sources: [VERIFIED-DATA] generic-data `street_brawl`, [WIKI], [PATCH].
2. **The tier of each choice slot is fixed by Valve's config.**

   | Round | Choice 1 | Choice 2 | Choice 3 |
   |---|---|---|---|
   | R1 | T1 | T2 | T3 |
   | R2 | T2 | T3 | T3 |
   | R3 | T2 | T3 | T4 |
   | R4 | T3 | T3 | T4 |
   | R5 | T4 | T4 | T4 |

   - A **"RARE!" card is one tier above** the slot's normal tier. In R5 that means a **T5 Legendary**.
   - **"Enhanced"** cards are the same item with extra stats.
   - Source: [VERIFIED-DATA].
3. **Valve ships a per-hero "Good"/"Normal" item bucket list**, `heroes[].item_draft_bucketing`, that biases which cards each hero is offered.
   - A T1 card is drawn from the hero's Good bucket 60% of the time. The rate falls to 40% at T2–T3, 35% at T4 and 20% at T5.
   - This is the best authoritative "is this item on-kit for my hero" signal that exists. Use it as a prior.
   - Source: [VERIFIED-DATA].
4. **Win-rate data filtered to Street Brawl is publicly available.** Use `https://api.deadlock-api.com/v1/analytics/item-stats?game_mode=street_brawl&hero_id=<id>`, and add `&enemy_hero_ids=a,b,c` for counters.
   - No API key is needed. The limit is 200 requests/min per IP, and responses are cached for 6 h.
   - Source: [VERIFIED-DATA].
5. **The old host `assets.deadlock-api.com` no longer resolves in DNS.** Asset JSON now lives at `https://api.deadlock-api.com/v1/assets/...`, and images are on `https://assets-bucket.deadlock-api.com/...`.
   - Source: [VERIFIED-DATA].
6. **Legendaries are not equally good.** Street Brawl win rates over the last 30 days:
   - Top: Mystic Conduit 60.0%, Seraphim Wings 57.4%, Celestial Blessing 56.5%, Shrink Ray 54.5%, Haunting Shot 54.2%.
   - Bottom: Shadow Strike 42.5%, Omnicharge Signet 45.3%, Mystical Piano 45.7%, Runed Gauntlets 45.9%.
   - A bad legendary can be worse than a good on-kit T4.
   - Source: [VERIFIED-DATA].

---

## 1. Rules of the mode

| Rule | Value | Source |
|---|---|---|
| Release | Added in the "Old Gods, New Blood" update on 2026-01-22 | [WIKI] https://deadlock.wiki/Street_Brawl |
| Teams | 4v4, single lane. `lane_number: 4` in config. Matches rotate through lanes, starting in the blue middle lane | [WIKI]; [3RD-PARTY] https://tracklock.gg/articles/street-brawl-explained-new-deadlock-4v4-gamemode |
| Format | Best of 5. `score_to_win: 3` | [VERIFIED-DATA] generic-data; [WIKI] |
| Round win | Destroy the enemy Guardian. Once a team has won 2 rounds, the enemy's objective switches from Guardian to a **Walker**. Config: `tier2_bonus_health: 4000` | [WIKI] |
| Objective HP per round | 1800 / 3200 / 4600 / 6000 / 7400 | [VERIFIED-DATA] `objective_max_health` |
| Comeback bonus HP | +1200 for the losing team, +2800 at match point | [VERIFIED-DATA] `comeback_bonus_health(_critical)` |
| Round length | 3 min. Overtime starts after 3 min, and "urgent" overtime starts at 4.5 min | [VERIFIED-DATA] `round_length_minutes`, `round_length_minutes_urgent` |
| Overtime | Respawn +25 s (R5: +30 s), or +40 s / +45 s in urgent overtime. Troopers get 1.75–2.5× health and 1.44–1.56× damage | [VERIFIED-DATA] |
| Respawn | 25 / 25 / 30 / 30 / 30 s | [VERIFIED-DATA] `respawn_times` |
| Troopers | Spawn every 18 / 18 / 15 / 15 / 15 s, first wave 5 s before the round starts. They have 20% spirit resist, plus another 20% in overtime. There are no neutral creeps | [VERIFIED-DATA]; [PATCH] https://forums.playdeadlock.com/threads/01-30-2026-update.102822/ |
| Economy | **No soul economy and no shop.** Items come only from the draft | [WIKI]; https://tracklock.gg/articles/street-brawl-explained-new-deadlock-4v4-gamemode |
| "gold_per_round" | 5600 / 7400 / 9400 / 11600 / 14000 | [VERIFIED-DATA]. **[UNCERTAIN]** My reading is that this is the notional soul value credited per round, which drives boons and level stats. It is not spendable |
| Boons (level-ups) per round | 10 / 19 / 25 / 30 / 34 | [WIKI] **[UNCERTAIN]**: the wiki's figure, which I did not cross-check against data |
| Ability points per round | 6 / 6 / 5 / 5 / **10**, for 32 AP total. Config field: `apper_round` | [VERIFIED-DATA]. Since 2026-03-21, "You now have all AP unlocked by round 5" [WIKI update history]. 32 AP equals 4 abilities × (1+2+5), so every ability is fully upgraded by R5. That standard upgrade-cost reading is mine |
| Ultimate | Available from round 1 (`ultimate_unlock_round: 1`). The initial ultimate cooldown was increased by 5 s in Jan 2026 | [VERIFIED-DATA]; [PATCH] 01-30-2026 |
| What persists between rounds | Items, ability upgrades and spent AP accumulate. Missed picks carry over: if you are AFK or disconnected, items and AP still carry to the next round, **but re-rolls do not** | [WIKI]; forum https://forums.playdeadlock.com/threads/streetbrawl-if-you-miss-afk-disconnect-etc-item-picking-the-next-round-you-dont-carry-over-rerolls.123333/ (2026-03-31). **[UNCERTAIN]** Whether *unused* re-rolls carry forward under normal play is undocumented. The config gives 1 per round |
| Bans | Hero ban (avoid) system, 2 bans in total | [PATCH] 01-30-2026 |
| Custom balance | Street Brawl has its own hero and item numbers (`street_brawl_value` fields in items JSON). Since 2026-06-11, all ability and item range/radius values are reduced by 10% | [PATCH] 01-30-2026; [WIKI] https://deadlock.wiki/Street_Brawl/Update_history |
| MMR | Does not affect standard-mode MMR | [WIKI] |

### Recent changes (most recent first)

Source: https://deadlock.wiki/Street_Brawl/Update_history

- **2026-10-04:** "Removed corrupted items on round 5". This was undocumented and found by a tracker ([WIKI] https://deadlock.wiki/Update:October_4,_2026). Current config agrees: `corrupt_item_round: 0`.
- **2026-09-29:** "City Never Sleeps" update. It gave a Corrupted Item after the R5 draft (**now removed**) and fixed bugs. Corrupted items are otherwise a standard-mode Broker mechanic. Sources: https://thegamehaus.com/deadlock/deadlock-major-update-adds-new-heroes-map-changes-hero-reworks-and-more/2026/09/29/ and https://howtovideogame.com/deadlock-corrupted-items-how/
- **2026-06-30:** "Increased item randomness a bit". **[UNCERTAIN]** This comes from the wiki only. My fetch of the forum thread for that patch found no Street Brawl lines.
- **2026-06-11:** Range and radius reduced 10%.
- **2026-03-21:** All AP unlocked by R5, and 23 Enhanced items buffed. [PATCH] https://forums.playdeadlock.com/threads/03-21-2026-update.120256/
- **2026-03-06:** "Removed item slot limit (don't need to sell items in the final round sometimes)".
- **2026-02-04:** The Random Hero bonus re-roll now also applies in round 3.
- **2026-01-30:** Custom Street Brawl balance, a Random Hero bonus re-roll for R1–R2, more Legendary drops, and troopers given 20% spirit resist.

---

## 2. The item draft

### When and how many

Each round opens with a buy phase. The `buy_time` config field is 50 / 50 / 50 / 50 / **65** s, and round 1 also has `pre_buy_time` of 6 s ([VERIFIED-DATA]). The wiki says only "50 seconds" (**[POSSIBLY OUTDATED]** for R5). There is also a `buy_time_grace_period: 60`, whose meaning is **[UNCERTAIN]**.

The draft has "three sets of three items". Sets are shown one at a time, and once you pick from a set it disappears and the next one appears ([WIKI]; tracklock article).

### Tier per choice

This is exact, from `generic-data.street_brawl.item_draft_rounds_per_game_round[round].item_draft_rounds[choice]` ([VERIFIED-DATA]):

| Round | Choice 1 (normal → rare) | Choice 2 | Choice 3 |
|---|---|---|---|
| 1 | T1 → T2 | T2 → T3 | T3 → T4 |
| 2 | T2 → T3 | T3 → T4 | T3 → T4 |
| 3 | T2 → T3 | T3 → T4 | T4 → T5 |
| 4 | T3 → T4 | T3 → T4 | T4 → T5 |
| 5 | T4 → T5 | T4 → T5 | T4 → T5 |

The wiki's tier summary ("R1 T1-3, R2 T2-3, R3 T2-4, R4 T3-4, R5 T4 + chance of T5") is consistent with this table.

On T5 in rounds 3 and 4: the config allows rare T5 there, but the R1–R4 rarity weights make it rare. **[UNCERTAIN]**: no player reports of legendaries before R5 were found.

### Rarity

**"RARE!"**
- A rare card is drawn from the slot's `rare_mod_tier`, which is the normal tier + 1 ([VERIFIED-DATA]).
- The config holds per-round weight tables for how many rares appear: `chance_rare.outcomes_to_weights`.
  - R1–R4: {2: 10, 3: 60, 4: 40, 5: 20}, giving an expected value of about 3.4.
  - R5: {0: 5, 1: 10, 2: 40, 3: 10}, giving an expected value of about 1.85.
- **[UNCERTAIN] interpretation:** these look like counts *per team per round*, across 4 players × 9 cards.
  - That fits the wiki statement that rare, enhanced and legendary drops are **mirrored**: when one team is offered one, a player on the other team gets an equivalent.
  - It implies roughly 9% of cards are rare in R1–R4, and that about 1.85 legendaries per team appear in R5.
  - A community tool reports *observed* on-screen rates of about 15% rare and 11% enhanced ([3RD-PARTY] https://github-wiki-see.page/m/Gidntsquia/deadlock-optimal-build-finder/wiki/Street-Brawl-Advisor).

**"Enhanced"**
- An Enhanced card is the same item with extra stat bonuses.
- In the items JSON, each item's `upgrades[0].property_upgrades` array, with `{name, bonus}` pairs, appears to be the Enhanced delta.
  - All 173 draftable items, including the 17 legendaries, have one.
  - For example, Toxic Bullets gets HealAmpReceivePenaltyPercent −30, HealAmpRegenPenaltyPercent −30 and DotHealthPercent +0.7.
  - [VERIFIED-DATA] for the field. **[UNCERTAIN]** that `upgrades` is specifically the Enhanced delta. That is inferred from the count, since exactly the draftable set has it, and from the 03-21 patch notes buffing "Enhanced" items.
- Weights: `chance_enhanced` R1–R4 {0: 10, 1: 20, 2: 20, 3: 35, 4: 15}; R5 {2: 5, 3: 35, 4: 15}.
- The enhanced flag belongs to the *slot* and survives a re-roll. A rare slot also stays rare after a re-roll. Source: [3RD-PARTY] Gidntsquia advisor. **[UNCERTAIN]**

**Hero-biased pool (Good/Normal buckets)**
- `generic-data.street_brawl.item_drafts[tier].bucket` gives the split between each hero's "good" and "normal" items:

  | Tier | good | normal |
  |---|---|---|
  | T1 | 60 | 40 |
  | T2 | 40 | 60 |
  | T3 | 40 | 60 |
  | T4 | 35 | 65 |
  | T5 | 20 | 80 |

- Each hero's `item_draft_bucketing` maps all 178 item class names to `{bucket: "Good" or "Normal", weight}`. The weight is 1.0 except for one 0.4 down-weight per hero, e.g. `upgrade_medic_bullets` or `upgrade_endurance`.
- [VERIFIED-DATA]. **[UNCERTAIN]**: the exact sampling algorithm, which I inferred from the field names.

**Legendaries (T5)**
- There are 17 active T5 items. All are `shopable: true`, `disabled` absent, `item_tier: 5`. Six more T5 items are disabled.
- By slot: weapon 3 (Infinite Rounds, Haunting Shot, Runed Gauntlets); spirit 7 (Omnicharge Signet, Shrink Ray, Mystical Piano, Mystic Conduit, Prism Blast, Unstable Concoction, Frostbite Charm); vitality 7 (Seraphim Wings, Nullification Burst, Celestial Blessing, Eternal Gift, Cloak of Opportunity, Electric Slippers, Shadow Strike). Source: [VERIFIED-DATA].
- **The wiki's split differs:** it says 6 weapon / 7 vitality / 4 spirit. **[UNCERTAIN]**: the wiki may use different categorisation. Trust the JSON `item_slot_type`.
- Effect summaries: https://dramalock.org/guides/deadlock-legendary-items-street-brawl/ (updated 2026-07-21).

**Corrupted variants**
- These are a standard-mode Broker mechanic, added 2026-09-29. Street Brawl got them for R5 on 2026-09-29, then they were **removed on 2026-10-04**.
- Items JSON has `corrupted_info.property_upgrades` for 95 T3/T4 items. Generic-data has `corrupted_penalties`.
- **[POSSIBLY OUTDATED]**: they may come back.

### Re-rolls

- **Config:** `item_draft_rerolls_per_round: [1, 1, 1, 1, 1]` ([VERIFIED-DATA]). The wiki says "reroll one set of items each round".
- **Random Hero bonus:** +1 re-roll in rounds 1–3 ([PATCH] 01-30-2026 and 02-04-2026). The project fixture string "Re-Rolls: 2" may correspond to this. **[UNCERTAIN]**
- **What a re-roll replaces:** it re-rolls only the *current* set of 3. Replacements are of similar tier and rarity, so the rare/enhanced slot status is kept ([3RD-PARTY]).
- **Missed picks:** if you miss a pick through AFK or disconnect, re-rolls are not carried forward (forum, 2026-03-31).

### Timeout

- **Not documented by Valve.** **[UNCERTAIN]**
- Evidence:
  - Forum, 2026-02-20 (https://forums.playdeadlock.com/threads/brawl-mode-bug-item-selection-screen-bug-after-item-selection-timer-runs-out.111005/): when the timer runs out, the selection screen stays on screen semi-transparently while you play, and clears after certain actions such as leaving the zipline.
  - Search snippets say the select screen "stays open during the match until an item is selected".
  - The AFK thread says missed items and AP carry to the next round.
- **Best reading:** there is no auto-pick on timeout. Unpicked choices remain pending and carry over.

### Duplicates and upgrades ("Bonus!")

- Wiki ([WIKI]): "If a player is presented with an item that normally upgrades from an item they have already chosen, they will be given another item of a lower tier as a bonus."
- In-game this shows as a **"Bonus!"** marker with extra item icon(s) bundled on the card. This matches forum bug threads from Jan 2026: https://forums.playdeadlock.com/threads/street-brawl-bonus-items-with-upgrades-can-eat-items.100281/ and https://forums.playdeadlock.com/threads/bonus-items-that-come-with-upgrades-in-street-brawl-dont-prompt-the-sell-menu-allowing-you-to-get-more-than-12-items-and-hides-your-highest-tier.99322/
- The bonus compensates for the component that the upgrade absorbs, as in standard mode, where `component_items` lists the components.
- **[UNCERTAIN]** I found no source on whether the exact item you already own can be offered again.

### Selling and slots

- There has been **no item limit since 2026-03-06**. Above 12 items the UI expands ([WIKI]).
- Selling was previously done by deleting an item from a slot when prompted at the cap (forums Jan–Feb 2026). It is now rarely needed.
- **Active items:** there appears to be a cap. Bonus actives can overflow, per forum 2026-04-04: https://forums.playdeadlock.com/threads/active-items-can-overflow-in-street-brawl.124352/
- **[UNCERTAIN]**: the exact number of active slots is unclear. A 2026-09-26 thread mentions "Five Active Items", and a third-party tool assumes 4.

---

## 3. UI text and layout (for screen reading)

**[UNCERTAIN] overall.** Valve publishes no UI spec. Below is what web sources state, plus cross-references to strings already in this repo's fixtures and tests, which presumably came from real captures. Confirm everything against your own screenshots.

### Draft screen

| Element | Text / appearance | Source |
|---|---|---|
| Title | `SELECT ITEMS` | Repo fixtures (`native/ScreenReader/README.md`, `tests/offer-parser.test.ts`). Not found on the web |
| Round indicator | `ROUND n`, light-coloured text above the timer | [3RD-PARTY] https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Screen-Reader |
| Choice indicator | `Choice n of 3` (the tool shows it uppercase, `CHOICE n OF 3`), magenta digits, under the title | Same, plus repo tests |
| Cards | 3 cards in a **radial/triangular layout**. At 2560×1440, icon centres are (712, 855), (1280, 527), (1848, 855), and each icon is about 185 px square. Normalised: (0.278, 0.594), (0.500, 0.366), (0.722, 0.594). The middle card is higher | [3RD-PARTY] Screen-Reader wiki. Your fixture also calls it a "radial three-choice screen" |
| Item name | Uppercase item name on the card, e.g. `ACTIVE RELOAD`, `SPIRIT RESILIENCE` | Repo fixture |
| Tier | Roman numeral I–V in the top-right corner of the icon | [3RD-PARTY] |
| Rare | `RARE!`, teal text above the card icon | [3RD-PARTY]; repo tests |
| Enhanced | `ENHANCED` (repo uses `Enhanced`), a blue box under the card name. Another tool shows enhanced items with a `+` suffix | [3RD-PARTY] |
| Bonus | `Bonus!` anchor with extra bundled icon(s) | Repo tests; [WIKI] mechanic |
| Re-roll button | `Use Re-Roll`, with `1 Re-Roll Remaining` below it | Repo tests. The Gidntsquia README mentions a "Use Re-Roll button" |
| Details | `See Details` on items. Pressing Tab while hovering opens the scoreboard/abilities, not item stats | Forum 2026-01-26 https://forums.playdeadlock.com/threads/street-bawl-item-details.101037/ |
| Your picks | Bottom-left inventory grid: 2 rows × 5 icons, 66 px icons on a 75 px pitch at 1440p | [3RD-PARTY] |
| Hero bar | 8 hero portraits. Your own portrait is a square-topped tile, the others are circles | [3RD-PARTY] |

### Tab scoreboard and HUD

- The Tab view shows **items and abilities under hero portraits**, along with KDA. Source: search summary of forum threads, plus https://forums.playdeadlock.com/threads/street-brawl-scoreboard-missing-item-ui.122118/
- **During the selection phase, enemy items are deliberately hidden** on the scoreboard. A bug leaks them through the hero stats hover. Source: https://forums.playdeadlock.com/threads/character-stats-shows-enemy-items-during-selection-phase-in-street-brawl.100983/ (2026-01-26)
  - **Implication:** read enemy builds from the Tab screen *during the round*, not during the draft. Enemy hero identities are available in the draft's hero bar.
- The post-match scoreboard shows only 12 items per player (forum 2026-03-26).
- City Never Sleeps (2026-09-29) changed the HUD: redesigned health bars, ally ultimate indicators, a new stats panel and a shop "Popular Items" section. Source: https://deadlock.one/en/news/deadlock-city-never-sleeps-update-6-new-heroes-broker-map-overhaul-hud-more
  - **[POSSIBLY OUTDATED]**: any HUD screenshots taken before 2026-09-29 may no longer match.
- **Ability upgrade UI:** I found no Street Brawl-specific description. AP is granted in a lump at the start of each round (6/6/5/5/10). It is presumably spent in the standard ability-upgrade panel, which the Tab view exposes.
  - **[UNCERTAIN]**: capture this yourself.

---

## 4. Item strategy

### Principles

Each principle is followed by its evidence.

1. **Tier is the dominant value driver.** Within a choice, every card shares a tier except a RARE!, which is one tier higher. A median card of the higher tier usually beats the best card of the lower tier (third-party advisor heuristic).
   - Treat RARE! as worth roughly one full tier.
   - In R5 a RARE! is a Legendary, but check its win rate (table below).
2. **On-kit beats generic.**
   - Use the hero's Valve `item_draft_bucketing` "Good" set as an on-kit prior.
   - Mobalytics, from a search snippet (page returned 403 to my fetch): "a Core Item for the character you're playing will usually be better than a bad enhanced item."
3. **Teamfight and sustain items over-perform** in this short, objective-focused 4v4. These are among the top Street Brawl win rates by tier ([VERIFIED-DATA], last 30 days, all heroes):

   | Tier | Highest win rate (≥20k matches) | Lowest |
   |---|---|---|
   | T1 | Extended Magazine 51.1%, Extra Charge 51.1%, Rebuttal 50.6%, Rusted Barrel 50.5%, Extra Regen 50.3% | Healing Rite 48.4%, Mystic Burst 48.3%, Spirit Strike 48.3%, Headshot Booster 47.7% |
   | T2 | Spirit Shielding 52.4%, Suppressor 52.2%, Mystic Slow 52.1%, Healbane 51.8%, Bullet Resist Shredder 51.7% | Cold Front 48.4%, Compress Cooldown 48.2%, Long Range 47.4%, Kinetic Dash 47.3% |
   | T3 | Heroic Aura 54.6%, Superior Duration 53.0%, Rescue Beam 52.7%, Healing Nova 52.6%, Spirit Resilience 51.4% | Silence Wave 47.4%, Metal Skin 47.2%, Shadow Weave 46.8%, Express Shot 46.1% |
   | T4 | Indomitable 52.7%, Escalating Exposure 52.7%, Divine Barrier 52.4%, Magic Carpet 51.8%, Healing Tempo 51.8% | Vortex Web 48.4%, Glass Cannon 47.7%, Echo Shard 47.7%, Cursed Relic 46.7% |
   | T5 | Mystic Conduit 60.0%, Seraphim Wings 57.4%, Celestial Blessing 56.5%, Shrink Ray 54.5%, Haunting Shot 54.2%, Nullification Burst 53.6% | Runed Gauntlets 45.9%, Mystical Piano 45.7%, Omnicharge Signet 45.3%, Shadow Strike 42.5% |

   - The other T5s: Infinite Rounds 51.4%, Eternal Gift 51.4%, Frostbite Charm 50.1%, Prism Blast 49.7%, Unstable Concoction 47.4%, Electric Slippers 47.4%, Cloak of Opportunity 46.5%.
   - **Caveats:**
     - These are "had the item" win rates, which carry selection bias. That bias is smaller than in standard mode because offers are random.
     - Enhanced and normal copies share one `item_id` and are not separable in the API. **[UNCERTAIN]**
     - Pooled across all heroes, so per-hero numbers can differ a lot. Always query with `hero_id`.
4. **Community legendary picks:** "Celestial Blessing, Infinite Rounds, Shrink Ray" are the always-pick legendaries, and "Rescue Beam, Majestic Leap, Veil Walker" are the enhanced auto-picks (mobalytics, search snippet, undated; https://mobalytics.gg/deadlock/tier-list/street-brawl).
   - **[POSSIBLY OUTDATED]**: the data disagrees in part. Enhanced and normal combined, Majestic Leap is at 47.7% and Veil Walker at 48.3%, while Rescue Beam is at 52.7%.
5. **Counters.** The enemy heroes are visible on the draft screen's hero bar. Use them as follows:
   - **Anti-heal vs sustain heroes.** Items carrying the `HealAmpReceivePenaltyPercent` / `HealAmpRegenPenaltyPercent` properties: Healbane (T2), Weakening Headshot (T2), Toxic Bullets (T3), Decay (T3), Blood Tribute (T3), Crippling Headshot (T4), Inhibitor (T4), Spirit Burn (T4), Haunting Shot (T5).
     - Cheat Death (T4) also carries one of these properties, but likely as a self-penalty. **[UNCERTAIN]**
     - Note the Jan 2026 patch removed the global 40% healing reduction in Street Brawl. That makes healing stronger, so anti-heal is more valuable.
   - **Spirit resist vs spirit-heavy enemy comps.** Items with a positive `TechResist` property: Enchanter's Emblem, Spirit Shielding (conditional), Restorative Locket, Spirit Resilience (30), Fury Trance, Witchmail (22), Spellbreaker (18), Escalating Exposure, Indomitable, Refresher, Healing Tempo, Ethereal Shift, Scourge (conditional).
   - **Bullet resist vs gun-heavy comps.** Items with a positive `BulletResist` property: Battle Vest (18), Weapon Shielding (conditional), Return Fire, Suppressor, Bullet Resilience (30), Metal Skin, Heroic Aura, Berserker, Warp Stone, Indomitable, Crushing Fists, Refresher, Cheat Death.
   - **Get counter evidence from data, not hand rules.** Query `item-stats?game_mode=street_brawl&hero_id=<me>&enemy_hero_ids=<their ids>` and compare each item's win rate against the hero baseline.
   - Use the hero classification in section 6 to weight spirit resist against bullet resist by the enemy comp's spirit/weapon mix.
6. **Mode-specific nerfs to factor in:**
   - Ranges and radii are −10%.
   - Greater Expansion and Mystic Expansion are weaker in Street Brawl (TechRange/RadiusMultiplier 30→25 and 20→16).
   - Alchemical Fire DPS is ×0.7, and Cursed Relic's duration is 3.25→2.75 s.
   - Troopers have extra spirit resist, which makes spirit wave-clear weaker.
   - All of the above are in the `street_brawl_value` fields ([VERIFIED-DATA]).
7. **Re-roll policy.**
   - Compare the best card on screen against the *expected max* of 3 fresh cards from that slot's tier pool, with rare/enhanced status kept.
   - You have only 1 re-roll per round (2 in R1–R3 if Random Hero), and missed picks lose it, so spending it on the highest-tier choice is generally better. That choice is the 3rd in R1–R4.
   - Community advice: "Don't hoard rerolls" (https://www.dtgre.com/2026/02/deadlock-street-brawl-guide-old-gods-new-blood.html). That guide's quality is low and it contains errors.
   - **[UNCERTAIN]**: whether unused re-rolls bank across rounds.
8. **Hero tier lists** (Street Brawl only; these change weekly):
   - https://tracklock.gg/street-brawl-tier-list (live): S+ Rat King and Paige; S Graves, Seven, Haze, Ivy.
   - https://seemeta.com/en/deadlock/street-brawl-tier-list (updated 2026-10-04): S+ Rat King and Paige; S Graves, Haze, Seven, Victor.
   - Both match the API's hero win rates (table in section 6).

### Community tools doing the same job

Use these to compare against, not to copy:

- https://github.com/Gidntsquia/deadlock-street-brawl-helper (fork: https://github.com/AngryPavel/deadlock-street-brawl-helper)
  - It is an OCR/icon-matching draft advisor fed by a 30-day deadlock-api snapshot, refreshed 2026-10-02.
  - Its scoring blends popularity, win-rate lift (shrunk toward the hero average), kit synergy, a tier bonus for rares, enemy-counter lift, pair synergy from `item-permutation-stats`, and an active-cap penalty.
  - Its re-roll logic uses the expected max of fresh cards.
  - Wiki: https://github-wiki-see.page/m/Gidntsquia/deadlock-optimal-build-finder/wiki/Street-Brawl-Advisor
- Statlocker (https://statlocker.gg/features) advertises Street Brawl win rates, Street Brawl item performance and a Street Brawl leaderboard. It has no documented public API, so I did not verify it.
- https://deadlockstattracker.com/street-brawl-builds offers Street Brawl builds. Not verified.

---

## 5. Data sources

All of these were verified working on 2026-10-04 with no key needed. OpenAPI spec: https://api.deadlock-api.com/openapi.json. Rate limit: 200 requests/min per IP, shared across analytics endpoints. Analytics responses are cached 6 h.

**Moved host:** `https://assets.deadlock-api.com/v2/*` now fails with "DNS name does not exist" (checked today). Use `https://api.deadlock-api.com/v1/assets/*` instead. Paths and query parameters are the same, e.g. `?language=english` and `?only_active=true`. Corroborated by https://github.com/EarlySalty/Deadlock-Brain/pull/33.

### Static assets (cache offline; re-pull per patch)

| Endpoint | Size today | What it gives |
|---|---|---|
| `https://api.deadlock-api.com/v1/assets/generic-data` | 25 KB | **`street_brawl` block:** `respawn_times`, `gold_per_round`, `apper_round`, `item_draft_rerolls_per_round`, `round_length_minutes(_urgent)`, `buy_time`, `pre_buy_time`, `objective_max_health`, `item_draft_rounds_per_game_round[r].{chance_rare, chance_enhanced, item_draft_rounds[c].{normal_mod_tier, rare_mod_tier}}`, `item_drafts[tier].bucket.{normal, good}`, `corrupt_item_round`, `ultimate_unlock_round`. **Also:** `item_price_per_tier` [0, 800, 1600, 3200, 6400, 9999], `corrupted_penalties` |
| `https://api.deadlock-api.com/v1/assets/items?language=english` | 5.9 MB, 738 entries | `type` (upgrade/ability/weapon). **For upgrades:** `id` (uint32, used by analytics), `class_name`, `name`, `item_tier` 1–5, `item_slot_type` weapon/spirit/vitality, `is_active_item`, `activation`, `shopable`, `disabled`, `cost`, `component_items`, `properties.{Key}.{value, label, provided_property_type, usage_flags, street_brawl_value}`, `upgrades[].property_upgrades` (Enhanced delta, see §2), `corrupted_info`, `description.desc` (HTML), `tooltip_sections`, `image`/`shop_image` (+`_webp`) on `assets-bucket.deadlock-api.com` (PNG, verified 200). **Draftable set** = `type=="upgrade" && shopable && !disabled`, which gives **173 items**: T1 23, T2 43, T3 46, T4 44, T5 17 |
| `https://api.deadlock-api.com/v1/assets/items/{id_or_class_name}` | ~8 KB | A single item, e.g. `/v1/assets/items/upgrade_toxic_bullets` |
| `https://api.deadlock-api.com/v1/assets/items/by-slot-type/{weapon\|spirit\|vitality}` | — | Filter by slot. Not individually tested |
| `https://api.deadlock-api.com/v1/assets/heroes?only_active=true&language=english` | 1.26 MB, **39 heroes** | `id`, `name`, `class_name`, `hero_type` (marksman/mystic/brawler/assassin), `gun_tag` (e.g. "Rapid Fire", "Spreadshot"), `tags`, `complexity` 1–4, `images.{icon_hero_card, icon_image_small, minimap_image, ...}`, `starting_stats`, `item_slot_info`, `popular_items.{early_game, mid_game, late_game}[].{item_id, pick_pct, winrate_pct}` (standard mode), **`item_draft_bucketing.{class_name}.{bucket: "Good"\|"Normal", weight}`** (Street Brawl), `development_state`, `player_selectable` |
| `https://api.deadlock-api.com/v1/assets/heroes?language=english` | 65 entries | Includes pre-release heroes: Deadman Danny 78, Solomon 85, Violet 86, Nurse Harrow 87, Baba 88. All are `player_selectable:false`, `development_state:"pre_release"`, but already carry `item_draft_bucketing` |
| `https://api.deadlock-api.com/v1/assets/client-versions` | — | Build list (latest 6746) |
| `https://api.deadlock-api.com/v1/patches` | 20 entries | Patch-note RSS: `title`, `pub_date`, `link`, `content_encoded`. Bodies are often truncated, so follow `link` |

### Analytics (accept `game_mode=street_brawl`)

The `game_mode` enum is normal, street_brawl, explore_n_y_c, internal. **The default is `normal`**, so always pass it.

**`GET /v1/analytics/item-stats`**
- Example: `https://api.deadlock-api.com/v1/analytics/item-stats?game_mode=street_brawl&hero_id=13`
- Parameters:
  - `bucket`: one of `no_bucket`, `hero`, `team`, `start_time_*`, `game_time_min`, `game_time_normalized_percentage`, `net_worth_by_*`
  - Hero filters: `hero_id`, `hero_ids`, `enemy_hero_ids` (comma-separated), `enemy_hero_ids_all_match`
  - Time and badge filters: `min/max_unix_timestamp` (default is the last 30 days), `min/max_average_badge`
  - `match_mode` (`ranked`, `unranked`, …), `min_matches`, `include/exclude_item_ids`, `item_order`
  - `corrupted_items`: `exclude`, `include` or `only`
- Response: an array of `{item_id, bucket, wins, losses, matches, players, avg_buy_time_s, avg_sell_time_s, avg_buy_time_relative, avg_sell_time_relative}`.
- Tested today:
  - All Street Brawl, no bucket: 172 rows, 43 KB.
  - `bucket=hero`: 1.58 MB.
  - `hero_id=1&enemy_hero_ids=31`: 172 rows.
- Sample row: `{"item_id":7409189,"bucket":0,"wins":187373,"losses":196781,"matches":384154,"players":172331,"avg_buy_time_s":222.8,...}` (Improved Spirit T2).
- **For Street Brawl, `avg_buy_time_s` acts as a proxy for the round the item was drafted.**

**`GET /v1/analytics/item-permutation-stats`**
- Example: `?game_mode=street_brawl&hero_id=1&comb_size=2&min_matches=50`
- Returns `[{item_ids:[a,b], wins, losses, matches}]`. Today's test returned 12,993 pairs.
- Use it for synergy with items you already own.

**`GET /v1/analytics/hero-stats?game_mode=street_brawl`**
- Returns `{hero_id, wins, losses, matches, total_kills, total_deaths, total_assists, total_player_damage, total_shots_hit/missed, ...}`.
- Use it for hero baselines, since an item's lift should be measured against the hero's average win rate.

**`GET /v1/analytics/hero-counter-stats?game_mode=street_brawl`**
- Returns `{hero_id, enemy_hero_id, wins, matches_played, kills, enemy_kills, ...}`.

**Other endpoints**
- `GET /v1/analytics/build-item-stats?hero_id=` covers Steam builds. It has no `game_mode` filter.
- `/v1/matches/{id}/metadata` gives match metadata, which records picks but **not** the 3 offered cards (per the third-party advisor wiki).
- `/v1/sql` is a raw ClickHouse SQL endpoint, with `/v1/sql/tables` listing the tables. It is useful for custom aggregates. **[UNCERTAIN]**: I did not test its limits.

### Recommended pipeline for the app

1. **Ship offline snapshots**, refreshed per patch or weekly:
   - `items` (draftable subset only, about 173 rows, keeping name, tier, slot, active, properties, `upgrades`, image URL)
   - `heroes` (id, name, hero_type, gun_tag, `item_draft_bucketing`)
   - `generic-data.street_brawl`
2. **Ship a per-hero Street Brawl item-stats snapshot.** Either make 39 calls with `hero_id`, or one call with `bucket=hero`, which is 1.6 MB.
   - Score each item = shrunk(win rate − hero baseline win rate).
   - Shrink with a beta prior, e.g. k ≈ 500–1000 matches.
3. **Optionally, fetch online at draft time:** `enemy_hero_ids=<the 4 enemies>` for this hero. This is 1 request, about 40 KB, and is cached server-side for 6 h.
4. **Combine** with a tier prior (rare = +1 tier), the Good-bucket prior, the enhanced bonus (from the `upgrades` delta), and pair synergy with owned items.

---

## 6. Heroes: primary damage type and role

### Method (reproducible)

- **Role:** taken directly from Valve's `hero_type` field (`marksman`, `mystic`, `brawler`, `assassin`). The gun style comes from `gun_tag`. [VERIFIED-DATA]
- **Weapon vs spirit:** there is no explicit field. I derived it from two independent data-driven signals:
  - **A. Valve's design signal.** The share of the hero's Street Brawl "Good"-bucket items that are weapon, among weapon+spirit Good items, from `item_draft_bucketing` joined to `items[].item_slot_type`.
  - **B. Player behaviour.** The soul-weighted share of weapon items among weapon+spirit purchases in **standard** mode at high badge. This comes from `item-stats?bucket=hero&min_average_badge=70`, weighted by matches × `cost`.
  - **C.** Shown for reference only: the same share in Street Brawl draft picks, where picks are constrained by the random offers.
- **Score = (A + B) / 2.** Labels: < 0.30 spirit; 0.30–0.42 spirit-lean; 0.42–0.55 hybrid; 0.55–0.65 weapon-lean; > 0.65 weapon.
- **"Melee-leaning"** means at least 5 of these 7 melee items are in the hero's Good bucket: Melee Lifesteal, Lifestrike, Melee Charge, Crushing Fists, Colossus, Spirit Snatch, Spirit Strike.
- **Caveats:**
  - Signal B is biased toward spirit, because every hero buys generic spirit utility such as cooldown and duration. The 0.42 and 0.55 cut-points absorb part of that.
  - Borderline heroes, with scores of about 0.30–0.45 or 0.53–0.60, should be treated as hybrid in counter logic. Examples: Holliday, Grey Talon, Graves, McGinnis, Viscous, Rat King, Mirage, Warden, Vindicta.
  - Community perception may differ for heroes whose builds flex. Holliday and Grey Talon are often built gun.
  - This classification is **[UNCERTAIN]** by construction. It is a reproducible starting point, not ground truth.
- The 39 active heroes match the tier lists. Rat King (id 84) is the newest hero, released around 2026-10-02.
- **[POSSIBLY OUTDATED]**: five more City Never Sleeps heroes are pre-release (Deadman Danny 78, Solomon 85, Violet 86, Nurse Harrow 87, Baba 88). Valve's schedule says "two heroes each week, Tuesdays and Fridays", so expect new ids through mid-October 2026. Their `item_draft_bucketing` already exists, so signal A works for them on day one.

Street Brawl win rate is the last-30-days figure from `hero-stats?game_mode=street_brawl`.

| Hero | id | hero_type | gun_tag | Good W/S/V | A: Valve Good-bucket weapon share | B: normal-mode soul weapon share | C: SB soul weapon share | Score (A+B)/2 | Class | Melee-leaning | SB WR (matches) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Abrams | 6 | brawler | Shotgun | 14/14/21 | 0.50 | 0.55 | 0.41 | 0.53 | **hybrid** | yes (7/7) | 51.3% (44558) |
| Apollo | 77 | assassin | Spreadshot | 3/22/15 | 0.12 | 0.07 | 0.13 | 0.09 | **spirit** | no | 51.0% (38414) |
| Bebop | 15 | brawler | Beam Weapon | 0/22/22 | 0.00 | 0.35 | 0.16 | 0.18 | **spirit** | no | 44.3% (72857) |
| Billy | 72 | brawler | Close Range | 17/7/17 | 0.71 | 0.56 | 0.61 | 0.64 | **weapon-lean** | yes (7/7) | 49.4% (43437) |
| Calico | 16 | assassin | Spreadshot | 6/19/17 | 0.24 | 0.15 | 0.27 | 0.20 | **spirit** | yes (6/7) | 46.2% (23084) |
| Celeste | 81 | mystic | Burst Fire | 5/28/11 | 0.15 | 0.20 | 0.18 | 0.17 | **spirit** | no | 47.8% (53400) |
| Drifter | 64 | assassin | Spreadshot | 19/5/17 | 0.79 | 0.46 | 0.67 | 0.63 | **weapon-lean** | yes (5/7) | 50.2% (41520) |
| Dynamo | 11 | mystic | Pistol | 6/19/16 | 0.24 | 0.16 | 0.15 | 0.20 | **spirit** | no | 52.7% (55371) |
| Graves | 76 | mystic | Pistol | 15/20/11 | 0.43 | 0.31 | 0.43 | 0.37 | **spirit-lean** | no | 60.9% (68380) |
| Grey Talon | 17 | marksman | Bow | 12/20/8 | 0.38 | 0.26 | 0.39 | 0.32 | **spirit-lean** | no | 45.9% (28659) |
| Haze | 13 | assassin | Rapid Fire | 20/8/17 | 0.71 | 0.74 | 0.72 | 0.73 | **weapon** | no | 53.7% (67139) |
| Holliday | 14 | marksman | Pistol | 16/23/11 | 0.41 | 0.23 | 0.45 | 0.32 | **spirit-lean** | no | 41.9% (32361) |
| Infernus | 1 | marksman | Rapid Fire | 13/15/16 | 0.46 | 0.46 | 0.47 | 0.46 | **hybrid** | no | 50.7% (65125) |
| Ivy | 20 | marksman | Rapid Fire | 20/21/16 | 0.49 | 0.40 | 0.48 | 0.44 | **hybrid** | no | 53.1% (41033) |
| Kelvin | 12 | brawler | Heavy Hitter | 2/24/18 | 0.08 | 0.04 | 0.11 | 0.06 | **spirit** | no | 52.7% (29990) |
| Lady Geist | 4 | mystic | Pistol | 11/20/17 | 0.35 | 0.35 | 0.29 | 0.35 | **spirit-lean** | no | 49.3% (37549) |
| Lash | 31 | assassin | Burst Fire | 4/19/11 | 0.17 | 0.22 | 0.17 | 0.20 | **spirit** | no | 47.6% (62054) |
| McGinnis | 8 | mystic | Heavy Artillery | 19/22/16 | 0.46 | 0.28 | 0.47 | 0.37 | **spirit-lean** | no | 50.2% (37580) |
| Mina | 63 | marksman | Pistol | 11/18/12 | 0.38 | 0.16 | 0.36 | 0.27 | **spirit** | no | 42.0% (50409) |
| Mirage | 52 | assassin | Pistol | 17/12/16 | 0.59 | 0.52 | 0.52 | 0.55 | **weapon-lean** | no | 43.3% (26396) |
| Mo & Krill | 18 | brawler | Spreadshot | 3/22/20 | 0.12 | 0.01 | 0.15 | 0.06 | **spirit** | no | 48.0% (29207) |
| Paige | 67 | mystic | Projectile | 2/29/15 | 0.07 | 0.11 | 0.12 | 0.09 | **spirit** | no | 62.5% (81259) |
| Paradox | 10 | marksman | Burst Fire | 19/21/19 | 0.47 | 0.48 | 0.45 | 0.48 | **hybrid** | no | 43.2% (48829) |
| Pocket | 50 | assassin | Spreadshot | 9/19/13 | 0.32 | 0.18 | 0.21 | 0.25 | **spirit** | no | 49.3% (36483) |
| Rat King | 84 | brawler | Spreadshot | 16/21/25 | 0.43 | 0.67 | 0.61 | 0.55 | **weapon-lean** | no | 68.1% (24437) |
| Rem | 79 | mystic | - | 2/26/15 | 0.07 | 0.08 | 0.13 | 0.08 | **spirit** | no | 50.0% (55654) |
| Seven | 2 | mystic | Burst Fire | 12/23/14 | 0.34 | 0.27 | 0.32 | 0.31 | **spirit-lean** | no | 54.4% (57761) |
| Shiv | 19 | brawler | Spreadshot | 6/20/23 | 0.23 | 0.25 | 0.22 | 0.24 | **spirit** | no | 50.1% (53034) |
| Silver | 80 | brawler | Long Range | 20/6/25 | 0.77 | 0.69 | 0.66 | 0.73 | **weapon** | yes (5/7) | 44.0% (37715) |
| Sinclair | 60 | mystic | Burst Fire | 2/23/14 | 0.08 | 0.15 | 0.13 | 0.11 | **spirit** | no | 44.3% (38386) |
| The Doorman | 69 | mystic | Pistol | 14/21/13 | 0.40 | 0.13 | 0.29 | 0.27 | **spirit** | no | 40.4% (36896) |
| Venator | 65 | marksman | Crossbow | 29/5/14 | 0.85 | 0.89 | 0.79 | 0.87 | **weapon** | no | 48.6% (68877) |
| Victor | 66 | brawler | Pistol | 4/18/17 | 0.18 | 0.15 | 0.22 | 0.16 | **spirit** | no | 54.0% (37455) |
| Vindicta | 3 | marksman | Long Range | 24/18/14 | 0.57 | 0.61 | 0.58 | 0.59 | **weapon-lean** | no | 51.5% (43600) |
| Viscous | 35 | mystic | Projectile | 14/18/21 | 0.44 | 0.24 | 0.37 | 0.34 | **spirit-lean** | yes (6/7) | 45.3% (37920) |
| Vyper | 58 | assassin | Rapid Fire | 27/8/17 | 0.77 | 0.67 | 0.75 | 0.72 | **weapon** | no | 47.9% (31778) |
| Warden | 25 | brawler | Heavy Hitter | 25/19/16 | 0.57 | 0.58 | 0.53 | 0.58 | **weapon-lean** | no | 49.8% (29811) |
| Wraith | 7 | marksman | Rapid Fire | 22/10/17 | 0.69 | 0.61 | 0.65 | 0.65 | **weapon-lean** | no | 50.1% (40963) |
| Yamato | 27 | assassin | Spreadshot | 4/21/15 | 0.16 | 0.30 | 0.19 | 0.23 | **spirit** | no | 46.5% (31068) |

### Reproduce

Python, about 20 lines:

```python
import json, collections, urllib.request
get = lambda u: json.load(urllib.request.urlopen(u))
items = get("https://api.deadlock-api.com/v1/assets/items?language=english")
heroes = get("https://api.deadlock-api.com/v1/assets/heroes?only_active=true&language=english")
stats = get("https://api.deadlock-api.com/v1/analytics/item-stats?bucket=hero&min_average_badge=70")
by_cn = {i["class_name"]: i for i in items}
by_id = {i["id"]: i for i in items}
spend = collections.defaultdict(collections.Counter)
for r in stats:
    it = by_id.get(r["item_id"])
    if it and it.get("type") == "upgrade":
        spend[r["bucket"]][it["item_slot_type"]] += r["matches"] * (it.get("cost") or 0)
for h in heroes:
    good = collections.Counter(by_cn[c]["item_slot_type"] for c, v in h["item_draft_bucketing"].items()
                               if v["bucket"] == "Good" and c in by_cn)
    a = good["weapon"] / (good["weapon"] + good["spirit"])
    s = spend[h["id"]]; b = s["weapon"] / (s["weapon"] + s["spirit"])
    print(h["name"], h["hero_type"], round((a + b) / 2, 2))
```

---

## Source index

**Valve and patch notes**
- https://forums.playdeadlock.com/threads/01-30-2026-update.102822/
- https://forums.playdeadlock.com/threads/03-21-2026-update.120256/
- https://forums.playdeadlock.com/threads/09-29-2026.166726/
- https://www.playdeadlock.com/cityneversleeps (renders client-side, so its content could not be fetched)

**Wiki**
- https://deadlock.wiki/Street_Brawl
- https://deadlock.wiki/Street_Brawl/Update_history
- https://deadlock.wiki/Update:October_4,_2026

**Data**
- https://api.deadlock-api.com/openapi.json
- `/v1/assets/{generic-data,items,heroes,client-versions}`
- `/v1/analytics/{item-stats,item-permutation-stats,hero-stats,hero-counter-stats}`
- `/v1/patches`

**Third-party guides and tools**
- https://tracklock.gg/articles/street-brawl-explained-new-deadlock-4v4-gamemode (2026-02-09)
- https://tracklock.gg/street-brawl-tier-list
- https://seemeta.com/en/deadlock/street-brawl-tier-list
- https://mobalytics.gg/deadlock/tier-list/street-brawl (403 to my fetch; quoted from a search snippet)
- https://dramalock.org/guides/deadlock-legendary-items-street-brawl/
- https://thegamehaus.com/deadlock/deadlock-street-brawl-review-chaotic-and-quick-fun/2026/01/28/
- https://github.com/Gidntsquia/deadlock-street-brawl-helper and its wiki Screen-Reader page
- https://github-wiki-see.page/m/Gidntsquia/deadlock-optimal-build-finder/wiki/Street-Brawl-Advisor

**Forum bug reports** (mechanics evidence)
- Threads 123333, 111005, 100281, 99322, 107468, 124352, 100983, 122118, 101037 on forums.playdeadlock.com, all cited inline above
