# BL-115 — Day-type variants vs Adaptive: Core-298 plus time-generic and band winners

| | |
|---|---|
| **Priority** | P1 — tells whether settings chosen for expiry and non-expiry days improve the live Adaptive list |
| **Status** | Result 2026-10-16: the registered 10 % weight fails on drawdown; T1 without the weight wins (ablation); T2 does not win |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-16 |
| **Depends on** | BL-104 (day-type lists, Stage 1 series), BL-106 (replay harness, the Core-298 / pool names), BL-058 (the registered lists) |
| **TODO.md row** | 3.10.30 |
| **Scripts** | `packages/option-backtesting/research/bl107/` and `research/bl104/daytype_lists.py` (the folder keeps the item's first local number, BL-107, renumbered to BL-115 on 2026-10-17 because main had taken BL-107) |

## Names

| Name | What it is |
|---|---|
| **Core-298** | The live rotation's 298 variants (12 families, 25 entry times; Buy has 24) |
| **Core-144** | Core-298 restricted to the 12 sampled entry times (12 families × 12) |
| **T1** | Core plus time-generic day-type winners: per family, the setting that beats its template across all sampled times, one for expiry days and one for non-expiry days, created at every entry time |
| **T2** | Core plus band winners: the same per family and day type, chosen separately for 09:15–10:30, 10:30–13:00 and 13:00–15:30, created only at their band's entry times |

## Context

The owner (2026-10-16) asked whether Adaptive, with its registered weights and 5 / 21 / 63 / 126-day
lookbacks unchanged, does better over a universe that adds day-type settings (BL-104's lists) than
over Core-298. Adaptive scores every strategy daily and trades the top ones wherever they fall: no
quota per band. A day-type weight (below) is the only change to the picker. Owner choices: boost
only, no deduction; both variant types are available every day; compare against Core-298; gross is the unit, net beside it where simulated.

## Goal

Whether Adaptive over T1 or T2 earns more per lot-day than Adaptive over Core-298 (and Core-144) in a
test year neither the winners nor the lists were fitted on, without a deeper drawdown.

## Out of scope

Changing the registered lists or the live rotation; re-simulating Core-298; any adoption from this
item alone; the all-days winner (reported in BL-104, not in the universes); a deduction for the
mismatched day type; Steady and Calendar boosts (reported unboosted for information).

## Plan

### Phase 0 — Pre-register (committed before the winners are read)

- **Hypothesis:** Adaptive over T1 (or T2) earns more gross per lot-day than over Core, without a
  deeper drawdown, because the added variants are better matched to the day type.
- **Windows:** winners chosen on 2024-10-09 → 2025-10-08 only (BL-104 `daytype_lists.py --window
  first`: "both years positive" becomes "both halves of the first year positive"; the 12 sampled
  slots). Replay on 2025-10-09 → 2026-10-09 (weekdays). History for the lookbacks from 2025-04-01.
  The 13 slots that were not sampled in BL-104 are unseen at selection.
- **Winners:** per family (12) × day type (expiry, non-expiry) × scope (all times; each of the three
  bands), by the BL-104 rule (margin ₹25 expiry / ₹15 other; ≥ 9 of 12 slots, or 3 of 4 in a band;
  worst day ≤ 1.25 × the template's; ≥ 2 neighbours beating the template). A winner equal to the
  family's template adds nothing; N_wide's owner settings are always added. Premium families keep up
  to three premiums.
- **Selection rule (BL-104 Amendment 10, owner 2026-10-16):** rank on the first half of the first
  year (2024-10-09 → 2025-04-08), take rank 1 if it also beats the template in the second half
  (2025-04-09 → 2025-10-08) by half the margin and at a majority of the times (Amendment 11), else rank
  2, else rank 3, never further.
- **Universes at 25 entry times** (the rotation's 09:17 … 15:17 at 15-minute gaps; owner 2026-10-16:
  the replay uses 25, the 12-time versions are dropped): Core-298; T1 = Core + each all-times winner
  at all 25; T2 = Core + each band winner at its band's slots only (09:17–10:17, 10:32–13:02,
  13:17–15:17).
- **Day-type weight (Adaptive only):** a variant tagged expiry on its index's weekly expiry day, or
  tagged non-expiry on any other day, has its composite score raised by 10 % of its absolute value.
  Composite scores are weighted percentile ranks and are never negative, so this is ×1.10. Reported
  with the weight off (0 %) as an ablation.
- **Pass rule:** over the common test days, Adaptive on T1 (T2) minus Adaptive on Core, mean gross
  per lot-day with the 5-day block bootstrap (2,000, seed 20261012) 90 % interval above zero, and max
  drawdown no worse. Kill: otherwise Core stands. Read once; no re-tuning after the read.
- **Known weaknesses, stated before the run:** the winners are the best of hundreds of settings per
  family, so even first-year-only selection carries a selection effect that the test year must
  overcome; the new variants are simulated after charges and gross (Core-298 results are gross
  only); re-entry types ASAP and COST ×2 are unverified against AlgoTest (BL-009).
- **Data coverage, checked 2026-10-16:** every entry time exists for every usable day (the lake holds
  1-minute bars; Core-298 has stored results for all 25 slots on every usable day). The test year has
  241 usable weekday sessions per index of about 247 trading days: the gap is mid-to-late September
  2026, before the Fyers collector's first migrated day (2026-09-23): NIFTY options are missing on
  09-16, 09-17, 09-18, 09-21 and 09-22; SENSEX options on 09-18, 09-21, 09-22, 09-23 and 09-24. The
  vendor data ends at the 2026-09-15 (NIFTY) and 2026-09-17 (SENSEX) expiries, and expired weekly
  contracts cannot be re-downloaded, so these days cannot be filled. The replay uses only days
  every universe has (the same days for all), and the day count is printed.
- **Will not run:** per-slot winners; changing the list weights or lookbacks; pooling the all-days
  winner into the universe; any deduction.

## Result (2026-10-16)

Run: `daytype_lists.py --window first` → `build_universe.py` (T1: 9 time-generic settings, 223
variants; T2: 44 band settings, 379 variants) → `simulate.py` → `replay.py` → `net_check.py`. 239
common test days 2025-10-09 → 2026-10-09. Parity: a fresh simulation reproduces Core-298's stored
results to the paisa (5 variants × 6 days), so gross is like-for-like. Charges for every Core-298 pick
were simulated on its pick day for the net comparison.

| Adaptive | Gross ₹/lot-day | Diff vs Core (90 %) | Gross max DD | Net ₹/lot-day | Net diff (90 %) | Net max DD | New picks |
|---|---|---|---|---|---|---|---|
| Core-298 | 417 | — | −10,688 | 285 | — | −12,675 | 0 % |
| **T1, weight 10 % (registered)** | 598 | +181 [+17, +360] | **−13,064** | 443 | +159 [−7, +337] | −14,698 | 96 % |
| T1, weight 0 % (ablation) | 640 | **+223 [+82, +362]** | −7,767 | 488 | **+204 [+63, +342]** | −8,905 | 70 % |
| T2, weight 10 % | 418 | +1 [−165, +179] | −8,838 | 257 | −27 [−193, +152] | −10,521 | 98 % |
| T2, weight 0 % | 476 | +59 [−98, +219] | −10,665 | 325 | +41 [−116, +200] | −12,576 | 69 % |

- **Registered verdict: kill.** T1 with the 10 % day-type weight earns more (interval above zero on
  gross) but its drawdown is deeper than Core's, which the pass rule forbids; net, its interval
  touches zero. T2 does not win at either weight.
- **Ablation (reported, not the registered test): T1 without the weight passes every condition**,
  gross and net, with a shallower drawdown. The gain comes from the time-generic settings themselves;
  the day-type weight concentrates picks (96 % new, 82 % matching the day type) and deepens the
  drawdown.
- Steady, Calendar and Baseline over T1 also beat their Core-298 versions (gross +157 to +282, every
  interval above zero; the weight applies to Adaptive only), so the T1 settings help every list.
- What Adaptive picked over T1 (no weight): SENSEX Widesl closest ₹285 expiry setting (SL 40 %, trail
  25/15, MTM ₹4,000, RE cost ×1) 19 %; NIFTY Widesl closest ₹150 expiry setting 13 %; N_wide owner
  settings 10 % (expiry) and 8 % (other days); N_ditm1 and S_ditm1 non-expiry settings with RE COST ×2
  8 % each (re-entry parity unverified, BL-009).
- Caveats: one test year; the winners are the best of hundreds per family (first-year selection,
  test year unseen); 16 % of T1's picks rely on RE COST ×2. Not adopted; the forward journal is the
  next evidence.

## Experiment 2 (registered 2026-10-16, before the test-year replay of these rules)

- **Owner:** learn from the first year only, verify on the test year. Profile and correlations:
  `research/bl107/first_year_profile.py` (2024-10-09 → 2025-10-08 only; BL-104 stored series, 12
  slots, net, slot-mean). The test year was not read to make these rules (the owner and Claude had
  seen test-year pick breakdowns earlier; the rules below use first-year numbers only).
- **R1, day-type exclusion:** on a given day, a strategy (a Core-298 family, or a T1 setting) is not
  eligible on a day type (its own index's expiry day / other day) where its first-year average net
  per lot-day was below zero. First-year exclusions: non-expiry days — Core S_wide, S_p250, S_p320,
  N_buy, S_buy and T1 #22 (SENSEX ₹285), #47, #48 (NIFTY Buy); expiry days — Core N_buy.
- **R2 = R1 + duplicates out:** also remove a Core family where a T1 setting correlates ≥ 0.9 with it
  in the first year and has a higher first-year average: Core N_wide (T1 #4, 0.94) and Core N_ditm1
  (T1 #36, 0.92).
- **Replay:** Adaptive (no weight) on the test year over T1 under R1 and under R2; the day's
  composite over the eligible universe only. Compared with T1 (no rule) and Core-298.
- **Pass rule:** a rule is kept only if its mean gross per lot-day minus T1's (no rule) has a 5-day
  block-bootstrap 90 % interval above zero and its drawdown is no worse; two rules are tested, so
  each is judged at the 95 % interval as well and the stricter one is reported. Otherwise T1
  stays unchanged.
- **Result (2026-10-16): kill — T1 stays unchanged.** `research/bl107/rules_check.py`. Adaptive,
  test year, gross per lot-day: T1 640; T1 + R1 557 (−83 vs T1, 90 % [−157, −9]); T1 + R2 503
  (−136, 90 % [−236, −46]); both with a deeper drawdown than T1 (−10,299 and −9,218 vs −7,767).
  The first-year non-expiry losers did not repeat (T1 SENSEX ₹285 earned +₹480 per non-expiry pick in
  the test year), and removing near-duplicate Core templates took away days they won. Also run, as
  information (SEEN, the idea came from the test-year breakdown): a hard expiry / non-expiry tag
  filter, `hard_filter.py`: 493 per lot-day, −147 vs T1 (90 % [−235, −62]). Every pruning tried — the
  10 % weight, the hard filter, R1, R2 — lowered the result.

## Experiment 3 — walk-forward of the T1 method, one vs up to two settings (registered 2026-10-16, before any fold was selected)

- **Owner (2026-10-16):** test ideas 4 (walk-forward) and 5 (up to two settings per family) together.
- **Question:** does the T1 *method* keep producing settings that beat Core-298 when it is re-run on
  a rolling window, and does allowing a second setting per family help?
- **Folds (select on 12 months, trade the next quarter; selection never reads its quarter):**
  1. select 2024-10-09 → 2025-10-08, trade 2025-10-09 → 2025-12-31;
  2. select 2025-01-01 → 2025-12-31, trade 2026-01-01 → 2026-03-31;
  3. select 2025-04-01 → 2026-03-31, trade 2026-04-01 → 2026-06-30;
  4. select 2025-07-01 → 2026-06-30, trade 2026-07-01 → 2026-10-09.
- **Selection in a fold:** BL-104 `daytype_lists` (Amendments 1–11) on the window only: rank on its
  first half, keep rank 1 → 3 only if it also beats the template in its second half (half the
  margin, a majority of the 12 sampled slots), the all-times group, expiry and non-expiry; N_wide's
  owner settings are the N_wide default as in T1. Premium candidates: the coarse premiums plus the
  refine premiums already chosen on the first year (a fixed, earlier candidate list).
  - **Variant 1:** at most one setting per family and day type (premium families: one premium).
  - **Variant 2:** up to two, the second only if its daily P&L correlates below 0.7 with the first
    (premium families: up to two premiums).
- **Test in a fold:** the fold's winners created at all 25 entry times (the 13 unsampled times are
  unseen), simulated 2024-10-09 → 2026-10-09 (gross); Adaptive (registered list C, no weight) replayed
  on the fold's quarter over Core-298 + winners, history from 2024-10-09, against Adaptive over
  Core-298 on the same days.
- **Pass rule:** the method passes when Core + winners beats Core in **≥ 3 of the 4 quarters** (mean
  gross per lot-day) **and** the pooled 90 % block-bootstrap interval over all quarters' days is above
  zero. Variant 2 is preferred only if it also beats variant 1 over the pooled days (90 % interval
  above zero); otherwise variant 1. Read once.
- **Known weaknesses:** four quarters is a small sample; fold 1's window equals the first year, so
  fold 1 is close to the T1 replay already seen; the refine premiums were chosen on the first year.

## Experiment 4 — beyond the grid's edges (registered 2026-10-16, before any new cell was simulated)

- **Owner (2026-10-16):** many T1 winners sit at the grid's edge (MTM ₹4,000 was the highest stop
  tried; SENSEX Widesl ₹480 the highest premium); test further out, same rule.
- **New cells (net of charges, the 12 sampled slots, 2024-10-09 → 2026-10-09, tag `edges`):**
  - Widesl and Dir: every existing setting of every family's strike again with MTM ₹5,000 and ₹6,000.
  - Widesl closest premium: NIFTY ₹210 and ₹250, SENSEX ₹560 and ₹640, each with every Widesl setting
    (the old MTM values and the two new ones).
  - Buy closest premium: NIFTY ₹150 and ₹200, SENSEX ₹400 and ₹500, each with every Buy setting.
  - Chains for the plateau rule: MTM … 4,000 → 5,000 → 6,000; premiums as an ordered list.
- **Selection:** BL-104 `daytype_lists` with `--window first` (Amendments 1–11 unchanged: rank on the
  first half of the first year, rank 1 → 3 must also beat the template in the second half) over the
  widened candidates → "T1-edge" (time-generic, expiry and non-expiry), created at all 25 entry
  times and simulated like T1.
- **Test:** Adaptive (list C, no weight) on the test year 2025-10-09 → 2026-10-09 over Core-298 +
  T1-edge, against Core-298 + T1 and Core-298 on the same days.
- **Pass rule:** T1-edge replaces T1 only if its mean gross per lot-day minus T1's has a 90 %
  block-bootstrap interval above zero and its drawdown is no worse. Otherwise T1 stands (the track
  is not changed by this experiment either way without the owner).
- **Known weaknesses:** more candidates mean more chances to fit noise in the selection year; the
  first-half / second-half check is the guard.

## Experiment 5 — book overlays on T1's Adaptive picks (registered 2026-10-16, before any run)

- **What:** the day's T1 Adaptive picks (list C over Core-298 + T1, no weight) as one book, minute by
  minute (BL-095 `portfolio.apply_book`; each pick 1 lot unless sized), gross.
- **Grid:** book stop {none, ₹6,000, ₹8,000, ₹10,000} × profit lock {none, lock ₹3,000 once the book
  is +₹6,000, lock ₹4,000 once +₹8,000} × sizing {1-1-1, 2-1-1: 2 lots on the highest-scored core
  pick}.
- **Choose on the first year** (2025-01-10 → 2025-10-08, after the warm-up; T1 is in-sample there):
  the combination with the best Calmar (annualised book P&L ÷ |max drawdown|) whose total is at least
  95 % of the plain book's (no stop, no lock, 1-1-1). **Check once on the test year.**
- **Pass rule:** in the test year the chosen combination's Calmar beats the plain book's AND its total
  is at least 95 % of the plain total. Otherwise no overlay.

## Experiment 6 — picker mix (registered 2026-10-16, before any run)

- **Rules compared:** (a) today: 3 core picks with at least 2 Widesl, + 1 Buy if in the top 10;
  (b) at least 1 Widesl; (c) 4 core picks with at least 2 Widesl. Adaptive weights and lookbacks
  unchanged; universes Core-298 and Core-298 + T1; first year shown, test year judged.
- **Pass rule (per universe):** a rule replaces (a) only if its test-year mean gross per lot-day minus
  (a)'s has a 90 % block-bootstrap interval above zero and its max drawdown per lot is no worse.
  Two alternatives are tested, so the stricter 95 % interval is also reported.

## Experiment 7 — wings (iron condor) on T1's Widesl picks (registered 2026-10-17, before any run)

- **Margin, from Zerodha's SPAN calculator (2026-10-16 SPAN file, 1 lot):** NIFTY OTM1 strangle (19-Oct
  expiry, 23200 CE / 23100 PE) ₹1,97,770 (SPAN 1,35,377 + exposure 62,393); with wings at closest premium
  ₹20 / ₹10 / ₹5 (23300/22800, 23450/22650, 23600/22400) ₹81,040 / ₹90,350 / ₹1,06,380; ATM straddle
  ₹2,01,224; the 27-Oct contract at the same strikes ₹1,94,821 and ₹90,602 with the ₹10-distance wings.
  SENSEX OTM2 strangle (22-Oct, 74900/74500) ₹2,09,171; with wings at ₹60 / ₹30 / ₹15
  (76000/72600, 76500/71900, 77100/70700) ₹1,06,209 / ₹1,20,036 / ₹1,44,044.
- **Margin model (fitted to those points):** short leg exposure 2 % of notional each; unhedged SPAN 9 %
  (NIFTY) / 9.5 % (SENSEX) of one leg's notional for a strangle or straddle; hedged SPAN = min(unhedged,
  1.27 × mean wing width in points × lot size); on the index's expiry day + 2 % of notional per short
  leg (SEBI additional ELM; an estimate, the calculator does not show it). Dir picks: unhedged; Buy:
  premium paid.
- **Wings:** a long CE and a long PE at closest premium X entered with the Widesl pick's short legs, 1 lot,
  no stop or target, closed at the exit or by the overall MTM stop; the short legs keep their settings.
  The day's T1 Adaptive picks are unchanged (only Widesl picks get wings).
- **Coarse grid:** NIFTY X ∈ {5, 10, 20}, SENSEX X ∈ {15, 30, 60} (paired by step); then refine: the
  midpoints between the best coarse pair and its neighbours, and one step beyond if the best is at an
  end (NIFTY 3 / 30, SENSEX 10 / 90). Two scopes: wings on all days, wings on expiry days only.
- **Choose on the first year** (2025-01-10 → 2025-10-08): the (X, scope) with the highest net return on
  margin (net book P&L ÷ mean daily book margin) whose net P&L is at least 85 % of the unwinged book's.
- **Pass rule on the test year:** worst day and worst-5-days sum improve by at least 30 %, net P&L falls by
  at most 15 %, and net return on margin rises. Otherwise no wings.

## Log

- 2026-10-16 — created from the owner's request; Phase 0 registered before the first-year selection
  was run.
- 2026-10-16 — run overnight; result recorded (registered weight fails on drawdown; unweighted T1 wins as an ablation; T2 no win).
- 2026-10-16 — Adaptive's Core-298 picks by family × day type, first year vs test year: most first-year losers flipped; only SENSEX Widesl (OTM, ₹320) on non-expiry days lost in both. Owner: no blocking rule; T1 stays unchanged (no weight, no filter, no pruning).
