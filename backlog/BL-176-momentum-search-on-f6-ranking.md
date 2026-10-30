# BL-176 — Momentum: a fresh strategy search on the F6-fixed (point-in-time) ranking

| | |
|---|---|
| **Priority** | P1 — the followed strategy and the favourites were chosen on a ranking with a hindsight-bearing cross-section; the selection itself may carry it |
| **Status** | Planned (Phase 0 drafted 2026-10-30; every owner decision answered; registration to be committed with Phase 1) |
| **Type** | research (+ small engine and runner work: a Monday-close fill, four light keys) |
| **Area** | momentum |
| **Created** | 2026-10-28 |
| **Depends on** | BL-001's F6 fix (PRs #318 → #319 → #322) merged; [BL-010](BL-010-momentum-evaluation-review.md) (the criteria files); BL-036 Phase 2 (the `mon_open` fill); BL-086 (lookback-following `voladj`); BL-087 (all-Fridays groups); closes BL-116 Phase 2's open check (top-sector weight) |
| **TODO.md row** | 3.13.11 |

## Context

BL-001's F6 finding: Broad's `voladj` score z-scored members against every stock column in the frame, including stocks that only joined a later year's `turnover_rank` list, and filled internal gaps depending on the end of the data. The fix ranks over each week's point-in-time members only. On live data it moves the followed strategy (Four Sectors Monthly, No Tilt) from 42.93% to 35.03% CAGR and most favourites by 3.5–10 points (`packages/momentum-backtesting/docs/lookahead-requests-2026-10-24.md`). BL-010's search, which picked these strategies, ran on the old ranking.

The 57 saved backtests were re-run on the fixed code on 2026-10-29, so the Saved runs page shows F6-fixed figures. The **selection** was not redone: round 7 (`search_spaces/round7_A.toml`, 8,003 runs, 2026-10-02 → 10-04), its point-in-time re-score (2026-10-06) and the Phase 5 choice all used the old ranking, and the favourites were picked by hand from the 2026-10-08 top-10 list. Two groups are invested today: Four Sectors Monthly, No Tilt (the money, BL-142) and Five Sectors, Rank Sum.

What round 7's space got wrong or left out, and this round corrects (owner, 2026-10-30):

1. **`voladj` ignores `lookbacks` and `weights`.** It is NSE's fixed method (26- and 52-week returns measured 4 weeks back, each over trailing 26-week volatility, z-scored, summed). The followed strategy's saved lookbacks 4/13/26/52 and weights 1/2/3/4 do nothing (they feed only the stock tilt, which is 0). The lookback-following variant (`Config.voladj_lookbacks=True`, BL-086) was tested on 10 favourites and killed (6–21 points worse on FY2018–22) but has never been a dimension the search could choose, and the set [26, 52], NSE's own pair, was in no round's list.
2. **The fill day was fixed at the next Friday's close** (`signal_delay = 1`). Live orders are placed Friday 14:15 as AMOs for **Monday's open**, so the journal scores a fill the search never saw. `mon_open` exists for Broad (BL-036 Phase 2, delay 0 only) and lost to the next-Friday fill on the followed group (BL-158). A Monday-close fill does not exist.
3. **`rebalance_offset` was searched.** Fridays are numbered from 2016-01-01; a config trading every K weeks fires on the Fridays whose number mod K equals the offset, so offsets 0–3 are four monthly calendars a week apart. BL-010 F6 found this let winners pick their lucky Friday; BL-087's "· all Fridays" groups are the fix for the favourites, but the search still ranked single offsets.
4. **The realism block was written for ₹2 lakh in one book.** The money runs as four ₹50,000 sleeves (a position is ₹8,000–12,000), so the ₹10,000 price ceiling admits shares bought as one unit (addendum 7 measured whole-share rounding at 1.2 CAGR points on a ₹50,000 sleeve, which the value-based engine cannot see).
5. **Levers that exist in the engine were never searched:** the category cap (`max_category`), the stock-tilt screen (`stock_tilt_screen_pct`), the top-sector weight (`top_sector_weight`, BL-116 Phase 2: 2× passes development, its 2023–26 confirmation waits on this item), the `voladj` skip rule, and the shortest lookback set [1, 4, 13] (round 6 asked for it, round 7 did not carry it).

## Goal

A **fresh, pre-registered selection on the fixed engine** (owner: "start from scratch", not a measurement of the F6 effect; "do it more elaborately", not a replay of round 7's ranges): a wide screening search over every axis the engine can vary, a focused stage whose ranges a fixed rule derives, and a selection by the registered BL-010 criteria as if round 7 had never run, naming one strategy (or an ensemble, or "none") per basket. The followed strategy and the favourites are ordinary points in that space: the verdict says where they land. Every number reproducible from `search_spaces/round8_*.toml`, `search_spaces/bl176_criteria.json` and `scripts/bl176_*.py` (all under `packages/momentum-backtesting/`).

## Out of scope

- Realism as a search axis (gate, slippage, series rule, circuit locks): fixed, sensitivity reported afterwards as the bias checks do.
- Levers already killed after tax on Broad: cadence slower than 4 weeks (BL-085 L1), weekly and daily stops (BL-084, BL-085 L4), inverse-vol sizing (L5), residual momentum (L6), the ETF blend, momentum sizing (cash-lock defect), mass-exit rules (the dashboard cannot run them), feature tilts (BL-050), chart patterns (BL-042/043).
- The 2012–2016 window (spent by BL-010 Phase 6).
- Changing `bl142_followed.json`, `live_rules.toml` or any saved favourite: the money decision is the owner's, after the verdict.
- Stock and Custom Index datasets (Broad only, as every round).

## Plan

### Phase 0 — Pre-register (this section; committed before any run beyond a one-group smoke)

- **Hypothesis.** On the point-in-time ranking the Broad space holds configurations that beat Nifty200 Momentum 30 TRI by 5 points after cost and tax inside the medium basket; the best region is monthly or fortnightly rotation of 3–6 categories at 1–2 picks from a pool of 150–350 with a near-zero coverage floor (where every round since 2 has found it); the followed strategy is in or near that region; the axes added here move the reported level, not the region, except the top-sector weight, which BL-116's development window says helps. Each axis carries an expected direction (below); a surprise is a finding, not a tuning.

- **Realism, fixed for every run and never searched:** `series_break_policy = verified`; start 2017-01-01; itemised costs; slippage 15 bps; **capital ₹50,000** (one sleeve; it drives the flat ₹16 depository fee per sell); circuit locks on; `min_ranked = 1` (every week simulated); momentum sizing off; cap band 0.05; **`max_stock_price = 5000`** (a ₹50,000 sleeve at 4–6 holdings buys ₹8,000–12,000 a name); no forced weekly sell; tradability gate ₹2 cr/day, ₹30 minimum price, floor ratio 0.25, circuit filter on with a 3-day run; `voladj_skip_recent_month = true`; `broad_universe = turnover_rank` (point in time); `category_tags`: **both sets, ranked separately** (owner, decision 2): curated (the 113 hand-written themes the favourites were saved on) and extended (BSE's classification, less hindsight). The two changes from round 7 (capital, ceiling) are the sleeve's facts, registered here with that reason, not tuning.

- **Stage 1 — wide screening, `search_spaces/round8_A_curated.toml` and `round8_A_extended.toml` (arm A, paired), seed 8.** A fresh Halton draw; no point carried from round 7; round 7's ranking is retired as pre-fix.

  Heavy (the ranking; one base per combination):

  | Axis | Values | Why these |
  |---|---|---|
  | `lookbacks` (weeks) | [26,52] · [13,26,52] · [4,13,26,52] · [1,4,13,26,52] · [4,13,26] · [13,26] · [1,4,13] | round 7's five, plus NSE's pair [26,52] (the anchor: with `voladj_lookbacks = true` and equal weights it reproduces today's score) and the shortest set round 6 asked for |
  | `weight_scheme` | equal · recent · long | as round 7 |
  | `score` | voladj · blend · ranksum | as round 7 |
  | `voladj_lookbacks` | false · true | **new**: the search, not the favourites, chooses whether `voladj` follows the lookbacks |
  | `voladj_skip` | long · none | **new**, read only when `voladj_lookbacks = true`: skip the latest 4 weeks on lookbacks ≥ 26 weeks, or never |

  Distinct combinations after dropping inert ones (ranksum ignores both `voladj` keys; `voladj_skip` is inert when `voladj_lookbacks` is false; `voladj` without `voladj_lookbacks` reads no weights, NSE's fixed method): ranksum 21 + voladj 7 + 42 + blend 63 = **133** (147 before the code review of 2026-10-31 found the inert weights); `--heavy 100` sampled. A test holds the count.

  Light (after the ranking; Halton over the ranges):

  | Axis | Values | Round 7 | Why |
  |---|---|---|---|
  | `coverage_floor` | 0.0 – 0.5 | 0.0 – 0.3 | the winners sit at 0.01–0.13; 0.5 bounds the space (round 1: 0.5+ gave 11% vs 25%) |
  | `pool_top_n` / `pool_band` | 20 – 400 / 0 – 200 | 30 – 350 / 0 – 200 | favourites at 193–335; the edges widened on both sides |
  | `category_top_n` / `category_band` | 1 – 10 / 0 – 10 | 1 – 8 / 0 – 8 | favourites at 3–6; 10 bounds the "many sectors" side |
  | `picks_per_category` | 1 – 4 | 1 – 3 | favourites at 1–3 |
  | `max_position` | 0.15 · 0.2 · 0.25 · 0.35 · 0.5 · none | 0.2 … none | 0.15 added (the dashboard default) |
  | `max_category` | none · 0.3 · 0.5 | pinned none | **new**: round 1 found it inert at 3–15 categories; untested at 1–4 |
  | `rebalance_every` | 1 · 2 · 4 | same | slower killed after tax (BL-085 L1) |
  | `rebalance_offset_raw` | 0 – 3 | same | sampled; never ranked on its own (Stage 3 blend rule) |
  | `entry` | wait · make_room | same | |
  | `stock_tilt` | 0 · 0.25 · 0.5 · 0.75 · 1 | 0 · 0.5 · 1 | finer steps around the favourites' 0, 0.5, 1 |
  | `stock_tilt_screen_pct` | 0 · 0.3 | pinned 0 | **new**: apply the tilt only inside the top 30% of the category |
  | `top_sector_weight` | 1 · 1.5 · 2 | pinned 1 | **new**: BL-116 Phase 2's open check; 2× passed development |
  | `fill` | next_fri_close · mon_open · mon_close | pinned next Friday | **new**, resolved by the runner as `signal_delay 1 / fri_close`, `0 / mon_open`, `0 / mon_close` |

  Fifteen light axes. `--light 200`: **20,000 runs**, about 14 hours on four workers (round 7: 8,000 in 5.5 h), two nights, resumable. Arms B and C1 run beside A (owner, decision 1, 2026-10-30); C2 stays unrun (direct rank on the 4,000-name universe was the worst baseline, 7.4% in round 0, and lost again in rounds 1 and 6):

  - **`round8_B.toml`** — the same ~750-stock point-in-time pool, **category layer off** (direct rank). Same fixed block and heavy block. Light: the category axes drop out (`coverage_floor`, `category_top_n` / `band`, `picks_per_category`, `max_category`, `top_sector_weight`, which the engine refuses with categories off) and the direct-rank pair comes in: `off_top_n` 3 – 30, `off_band` 0 – 30 (round 7: 3 – 25 / 0 – 25); pool, caps, cadence, offset, entry, tilt, tilt screen and fill as arm A. Eleven light axes. `--heavy 100 --light 100`: **10,000 runs**, about 5 h (no category layer per run). Expected: below A in every basket (rounds 1, 6, 7); a B config that beats A's best on the lower-bound rank is a finding about the category layer (BL-010 open question 3).
  - **`round8_C1.toml`** — the **~4,000-name all-liquid universe**, category layer on, extended BSE tags (as round 7 C1; curated tags cover too few of these names to run it). Same fixed block except the universe; same heavy and light blocks as A. Each ranking build is ~56 s and ~1.5 GB, so `--heavy 40 --light 100`: **4,000 runs** on three workers, about 5 h. Expected: more CAGR and deeper falls than A at the same settings; its point-in-time status is weaker (the all-liquid list is gated per week, the tags are today's), which the verdict states beside any C1 line.

  **Tag sets (decision 2).** Arm A runs every one of its 20,000 points twice, once with curated and once with extended tags, inside the same group so the ranking base is built once and the pair differs only by the tags (`category_tags` is a run argument, not a ranking key). Arm B has no category layer and enters both rankings unchanged. Arm C1 runs on extended tags only (curated tags cover too few of the 4,000 names to run it), so it enters the extended ranking only. Two tag sets therefore mean two complete selections:

  | Ranking | Arms in it | Stage 1 runs |
  |---|---|---|
  | Curated | A (curated) + B | 20,000 + 10,000 |
  | Extended | A (extended) + B + C1 | 20,000 + 10,000 + 4,000 |

  Stage 1 in all: **54,000 runs** (B's 10,000 counted once), about 36 hours: A about 26 h (the light runs doubled, the base not), B 5 h, C1 5 h; five or six nights, resumable. Expected: extended runs 4–11 CAGR points lower and 7–14 points deeper in their worst fall than curated at the same settings (BL-010 Log 2026-10-10); the region may differ, which is the point of ranking them apart.

  Expected directions, registered: `voladj_lookbacks = true` loses (BL-086), its best cells on [13,26,52] and [26,52]; `fill`: `mon_open` more return and a deeper worst fall than `next_fri_close` (BL-158), `mon_close` between; `max_category` does nothing (caps page); `stock_tilt_screen_pct = 0.3` nothing or small; `top_sector_weight = 2` helps (BL-116 development), the 2023–26 half of the data is its confirmation and BL-116 Phase 2 closes on it; `picks = 4` and `category_top_n ≥ 8` flatten return and shallow the falls (BL-010 F5); `coverage_floor > 0.3` and the [1,4,13] set lose; `max_position = 0.15` smoother and poorer.

- **Stage 2 — focused search, one file per arm and tag set (`round8_<arm>_focus.toml`), written by `scripts/bl176_focus.py` from a fixed rule, no hand-picked range.** The search records each Stage 1 run's rank measure as it runs (`search.rank_measures`: its excess over Mom30 TRI in each financial year, their 25th percentile, and the drawdown baskets every fall passes), so ranking Stage 1 re-runs nothing. Run for an arm and tag set only if its Stage 1 top 5% holds at least 20 basket-passing configs in some basket; the rule is applied to each ranking (curated, extended) on its own, so up to five focus files. For each basket: the Stage 1 configs that pass the basket's drawdown gates and rank in the top 5% by the lower-bound measure (third-worst FY excess over Mom30 TRI, on their sampled offset). The qualifying baskets' runs are pooled. Each numeric axis's Stage 2 range is the pool's 10th–90th percentile, clipped to Stage 1's range (a band axis read as exit rank minus top; the offset keeps its whole range, since Stage 3 blends all Fridays); each choice axis, light and heavy, keeps the values held by at least 10% of the pool; the heavy combinations are the product of those values, inert ones removed, all run; runs per combination = 7,000 / combinations, between 100 and 500. The script is committed **before Stage 1 runs**, so Stage 2 cannot be steered by reading. Seed 9: about 6,000–8,000 runs per qualifying arm, one night. Expected: the plateau Stage 1 found, sampled densely enough for the nudge test to read flatness.

- **Stage 3 — blend, select, locate.** No single-offset figure reaches a ranking: every config in the top decile of each basket over Stages 1 and 2 pooled, **across the arms in that ranking** (an arm is just another setting of the same strategy family), done once for the curated ranking and once for the extended one, is re-run on all its offsets (4 for every-4-weeks, 2 for every-2-weeks, none for weekly; `mbt search score --ids`) and **scored as the all-Fridays blend** (equal capital per sleeve, reset each April, as the Saved runs page blends a group). Then the registered BL-010 machinery as written, with no reference to round 7's winners: baskets → Phase 5 rule (lower-bound rank, clusters at 0.9, medoid, 8–12 holdings preference, walk-forward kill with a 13-week embargo) → addendum 4's ensemble rule if the single pick is killed → top 100 vs 100 random in FY windows, PBO on 16 blocks (kill above 0.3), fair placebo (100 seeds), nudge plateau (`robust.py`, every searched dimension), factor alpha → one pick, one ensemble, or "none" per basket **per tag set**, frozen with commit and data snapshot. The two picks are reported side by side with how far apart they are (settings and weekly-return correlation); neither is named "the" answer by the item. The followed strategy, Five Sectors Rank Sum and the ten favourites are then **located** in the result: their blend's percentile in the space, their basket, and gates G1–G6 as addendum 6 defined them. Round 7's top 10 placed in the new ranking is a footnote written after the pick.

- **Criteria: `search_spaces/bl176_criteria.json`**, naming the files that apply unchanged: `bl010_criteria.json` (baskets, +5 over Mom30 TRI after tax, comparators), addendum 3 (the choice rule), addendum 4 (the ensemble rule), addenda 6 and 8 (gates G1–G6). **Return basis (owner, decision 3: mixed, as BL-010 addendum 3 did):** every **ranking** step (the Stage 2 rule, the top decile, the Phase 5 lower-bound rank, clusters, medoid, the ensemble's screen, the walk-forward) uses **pre-tax returns after costs**, as rounds 6 and 7 did. Every **gate** is judged **after tax at ₹50,000 a sleeve** (today's short-term rate, per sleeve, the ₹16 depository fee per sell) on the configs that reach it: the minimum bar (+5 over Mom30 TRI), G1, and the after-tax line of the still-holds rule. Drawdown baskets read the pre-tax curve (tax is paid at year end and in this engine does not deepen an intra-year fall; the after-tax worst fall is reported beside). **No walking down:** a pick that fails the after-tax bar leaves its basket at "none after tax" with the failing pick and its tax drag reported; the next cluster is not substituted, because choosing until something passes would turn the gate into another selection step. Reported for every finalist: turnover, tax drag in points, and its after-tax rank among the top decile (descriptive, not used to choose). The trial count for the deflated Sharpe and PBO is the true one: counted per ranking exactly from the results files (curated about 30,000 in Stage 1, extended about 34,000, plus each one's Stage 2; the paired A runs count in both, since each ranking chose among them), plus round 7's 8,003 (and its 4,754 on C1 / C2) named as prior trials on the same question.

- **"The followed strategy still holds"** (owner, decision 4: the looser line): its all-Fridays blend is in the **top half of the space** by the pre-tax lower-bound rank (the whole ranking, not one basket), AND beats Mom30 TRI by **5 points after tax** (G1), AND its worst fall is inside the **−40% hard ceiling**. Five Sectors, Rank Sum is read by the same rule. A favourite **keeps its place** if its blend is in the top decile of the space by the lower-bound rank (unchanged; the looser line was set for the followed strategy). Each rule is read in both rankings; a strategy that holds on curated tags but not on extended is reported as **"holds only on hindsight tags"**. The rule answers "is the money behind something clearly ordinary or worse", not "is it the best": where the fresh pick differs, both are reported side by side and the money decision stays the owner's.

- **Hold-out.** None unseen (2012–2016 spent; everything to 2026-10 has been seen). Protection is procedural and registered: Stage 2's ranges by rule, the walk-forward, fair placebo, PBO, nudge plateau, FY-window consistency; the forward journal (BL-024, Friday scores) is the only true out-of-sample from here on.

- **Look-ahead check.** Every run is a fixed rule applied week by week on the point-in-time universe with the F6 cross-section; `mbt audit lookahead-requests` on the finalists at three cuts (2019-06-28, 2021-06-25, 2024-03-28) must be identical before the verdict is written.

- **Will not run:** a value outside the listed choices; a Stage 2 range chosen by hand or a third search stage; realism as an axis; any lever in "Out of scope"; arm C2; the 2012–2016 window. Any of these needs `override: <reason>` here.

### Phase 1 — Build what the registration needs

- **Tasks (built 2026-10-31):** the `mon_close` fill (engine, `trade_prices`, `monday_fills`, Broad, API and CLI; golden scenario `broad_monday_close` accepted, no other scenario moves); the runner (`search.py`): `fill` resolved into signal delay and execution, `universe_kind` and `category_tags` settable in a space, circuit masks built for the fill's session (also in the shared `bias.Runner` the robustness tools use), inert heavy combinations collapsed (`canonical_heavy`: 133 for round 8, round 7 unchanged at 45), the rank measure recorded per run; `mbt search score --ids`; the four Stage 1 space files; `bl176_criteria.json`; `scripts/bl176_focus.py` (Stage 2 by rule); tests for each; a one-group smoke per arm. The Stage 3 helpers (blend the top decile, locate the favourites) only read Stage 1 and 2 results under the rules fixed here, so they are built before Stage 3, not before Stage 1.
- **Deliverables:** merged PR; the registration files committed with this Phase 0 (then the Status line changes to "Registered, not run").
- **Done when:** the smoke resumes correctly, the universe, tag and fill lines appear in the run log, the count test passes, and the registration files are committed with this Phase 0.

### Phase 2 — Run and read

- **Tasks:** Stage 1 over two nights (`caffeinate -i`, 4 workers; never a Friday evening when the Momentum jobs hold the catalog, never over the 15:45 options evening); `mbt search score` → `focus.py` writes Stage 2 → Stage 2 one night → Stage 3 as written → verdict → the round 7 footnote.
- **Deliverables:** `research/bl176/results/` (git-ignored; summary CSVs committed under `research/bl176/out/`), the verdict in the Log, the findings pages updated: `research/momentum/common/universe.md`, `score.md` (voladj lookbacks and skip as searched axes), `execution.md` (the fill axis, Monday close), `cadence.md` (the blend rule), `caps.md` (category cap at few categories), `strategies/broad/funnel.md` and `README.md` (the F6 caveat becomes a result); BL-116 Phase 2's result; `TODO.md` row; `backlog/INDEX.md`.
- **Done when:** the verdict is in the Log and the owner has decided whether the money keeps following Four Sectors Monthly, No Tilt and Five Sectors, Rank Sum.

## Risks

- About 36 hours for Stage 1 (A 26 h for both tag sets, B 5 h, C1 5 h) and up to 3 more nights for Stage 2 on this Mac (8 GB, four workers at ~1 GB each, three at ~1.5 GB for C1): a week of nights, or two on the Mac mini. The smoke run's timing per arm is recorded and the schedule corrected before the full run.
- Ranking pre-tax favours configs that sell often; with no walking down, a basket can end at "none after tax" when its pre-tax pick is a fast rotator. That outcome is a result (the edge is in the tax), not a failure of the run.
- Nothing is unseen: every figure is in-sample by construction and the write-up says so; the wider space means more trials and a weaker deflated Sharpe, which is why the count is registered.
- `mon_open` / `mon_close` at delay 0 are decided on Friday's close and filled Monday, the real live timing; `next_fri_close` cannot be traded as such and is kept because it is what the journal's history was scored on until now.
- The blend rule costs 4× on the top decile only; a config that is top decile on one offset and poor on the others is the finding, not a problem.
- Curated tags remain hindsight (BL-010: 4–11 points). Ranking both tag sets makes the cost of that hindsight a measured result for every config rather than a footnote; the extended ranking is the one closer to what can be known in advance.

## Open questions (owner; answered before the registration is committed)

1. ~~Arms~~ — **owner, 2026-10-30: A + C1 + B** (C2 stays unrun).
2. ~~Headline tag set~~ — **owner, 2026-10-30: both, ranked separately** (two selections, two picks reported side by side).
3. ~~Return basis~~ — **owner, 2026-10-30: mixed**: rank pre-tax, judge every gate after tax at ₹50,000 a sleeve; no walking down to the next cluster when a pick fails the after-tax bar.
4. ~~Still-holds lines~~ — **owner, 2026-10-30: looser**: top half of the space, +5 over Mom30 TRI after tax, worst fall inside −40%; favourites keep the top-decile line.
5. ~~Run slot~~ — **owner, 2026-10-30: this weekend.** Phase 1 built and reviewed on Fri 30 Oct; Stage 1 starts Sat 31 Oct once Phase 1 is merged and the registration committed, runs continuously, and is paused before Mon 2 Nov 07:30 if not finished (resumable; the remainder runs on the next nights). Stage 2 on the following free nights.
6. ~~The Stage 1 space as written above~~ — **confirmed by the owner, 2026-10-30**, including capital ₹50,000 and the ₹5,000 ceiling. Any later change to an axis is an `override:` line.

## Log

- 2026-10-28 — created when the owner closed its parent item (2026-10-28). Status `Planned`.
- 2026-10-30 — Phase 0 drafted from the planning session (plan file `~/.claude/plans/as-we-have-done-zany-sonnet.md`). Owner (2026-10-30): three additions confirmed (`voladj` lookbacks as a heavy axis, a fill-day axis with a new Monday-close option, finalists scored as all-Fridays blends); then "don't measure just the F6 effect, start from scratch" (a fresh draw and a fresh selection; round 7's top 10 a footnote after the pick); then "do it more elaborately": Phase 0 rewritten as three stages (wide screening over every searchable axis, a focused stage whose ranges a committed rule derives, blend-select-locate), with the sleeve's realism (₹50,000, ₹5,000 ceiling), NSE's [26,52] set, the category cap, the tilt screen and BL-116's top-sector weight added. Not yet committed as the registration (open questions 1–5), nothing run, no engine change made.
- 2026-10-30 — owner confirmed the Stage 1 space as written (decision 6), including the sleeve realism (capital ₹50,000, price ceiling ₹5,000). Decisions 1–5 open; the defaults stand unless changed.
- 2026-10-30 — owner, decision 1: arms **A + C1 + B** (C2 stays unrun). Added `round8_B.toml` (direct rank, `off_top_n` 3–30, 10,000 runs) and `round8_C1.toml` (all-liquid universe, extended tags, 4,000 runs) to Stage 1; Stage 2 per qualifying arm; Stage 3 ranks across the arms. Stage 1 now 34,000 runs, about 24 h.
- 2026-10-30 — owner, decision 2: **both tag sets, ranked separately**. Arm A runs its points under curated and extended tags in the same group (base built once); B enters both rankings, C1 the extended one only; Stage 2 and Stage 3 run per ranking; the still-holds rule is read in both. Stage 1 now 54,000 runs, about 36 h.
- 2026-10-30 — owner, decision 3: **mixed basis** (rank pre-tax, gates after tax at ₹50,000 a sleeve), the same split BL-010 addendum 3 used; registered with no walking down to the next cluster when a pick fails the after-tax bar, and turnover, tax drag and after-tax rank reported for every finalist.
- 2026-10-30 — owner, decision 4: the **looser** still-holds line for the followed strategy (top half of the space, +5 after tax, worst fall inside −40%); the favourites' top-decile line kept as written. Read in both tag rankings.
- 2026-10-30 — owner, decision 5: **this weekend** (Stage 1 from Sat 31 Oct, paused before Mon 07:30 if unfinished). All five decisions answered; the registration is ready to commit once Phase 1 is built and merged.
- 2026-10-31 — Phase 1 built on `research/bl176-phase1` (worktree `../ata-bl176`, the main checkout untouched): the items in Phase 1's task list. Registration details fixed while building, before any run: arm A is two paired files (`round8_A_curated`, `round8_A_extended`); fifteen light axes (not sixteen: a counting slip); the Stage 2 rule's heavy block is the product of the frequent values (a TOML space cannot list combinations), its baskets' runs pooled; the rank measure is recorded by the search itself so Stage 2 re-runs nothing.
- 2026-10-31 — code review of PR #392 (seven findings, all fixed before any run): `voladj` without `voladj_lookbacks` reads no weights, so 14 of the 147 combinations were duplicates; 133 distinct, `--heavy 100` samples them. The search now refuses to start without the rank references (a missing benchmark would have left Stage 1 with no Stage 2 inputs); `bl176_focus.py` exits 2 when no run carries a rank measure and reads its numbers from `bl176_criteria.json` (`stage_2.keys`); a score folder holds one id set; the refusal says "Monday fills"; tests pin the Monday-session masks in the search worker and the shared Runner.
- 2026-10-31 — Stage 1 started 00:48 and was **stopped by hand at 01:03**: 311 of the first 623 runs errored (`need at least one short and one long lookback`). The stock tilt needs a long (26 or 52 weeks) and a short lookback, and the two sets new in round 8 each lack one ([26, 52] no short, [1, 4, 13] no long); round 7's sets all had both, so it never arose, and the one-group smoke had drawn a tilt-capable set. Fixed before any result was read beyond the error counts: for those two sets the sampled tilt and its screen become 0 before the run id is made (`search.without_impossible_tilt`), so the groups run untilted and record it; round 7's draw is unchanged. A second smoke across every lookback set and every score / voladj variant then found `voladj_skip = "none"` read as null by the space loader's TOML convention (the base build would have crashed); the loader now keeps that word. The aborted output is kept in `data/search/round8_logs/aborted_2026-10-31_0048/`, not used. Stage 1 restarts from scratch on the fixed commit.
