# BL-167 — ITM2 added to the Adaptive ranking universe (Core and T1)

| | |
|---|---|
| **Priority** | P2 — decides whether ITM2 Dir joins the rotation universe |
| **Status** | Done |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-26 |
| **Depends on** | BL-166 (ITM2 results, the matched stop), BL-058 (rotation), BL-113 (T1 track) |
| **TODO.md row** | — |

## Context

Owner, 2026-10-26, after BL-166: add ITM2 into the T1 and the Adaptive universe and find out how much
it changes drawdown, return and so on. Second question the same day: if ITM2 is added, what share of
the ITM1 and ATM picks does it replace?

Adaptive Classic = list C ranking over Core-298. Adaptive Tuned (T1) = list C over Core-298 plus the
223 T1 variants. BL-166 produced stored one-lot results for ITM2 Dir at the 25 rotation start times on
NIFTY and SENSEX from 2024-10-09, at six overall stops; the ITM1 and ATM re-simulations there equal the
rotation store exactly (1,497 of 1,497 checked days).

## Goal

For each universe, say with numbers how the Adaptive picks change when the 50 ITM2 variants join:
net return, drawdown, win rate, worst day, how often ITM2 is picked, and which picks it displaces.

## Out of scope

ITM3, other stops, changing any list weight or the Widesl minimum, putting ITM2 live, T1's own tuned
sets for ITM2, margin sizing, the Buy add-on, the expiring-index rule (reconstruction never applies it).

## Plan

### Phase 0 — Pre-register
Written and committed **before the full run**.

- **Hypothesis:** adding ITM2 Dir variants to the universe lets the ranking pick better Dir strategies, so
  list C earns more per day, with no deeper drawdown. Null: no difference after charges.
- **Arms**, per universe (Core-298; Core-298 + T1): *base*; *+ITM2 at the common ₹3,000 stop* (50
  variants `<N|S>_ditm2_<HHMM>`, the standard Dir template); *+ITM2 at BL-166's matched ₹4,000 stop*
  (same names). The primary arm is **₹4,000** (the BL-166 finding); ₹3,000 is the control.
- **Method:** the stored history from the rotation reconstruction (`daylog.reconstruction`) with the 50
  ITM2 columns appended; list C's three core picks by `pick.score_history` for every session with 63
  earlier sessions (2025-01-10 → 2026-10-23), a session whose stored history stops short of the previous
  trading day dropped. ITM2 is classed as a Dir variant (`score.is_dir` widened inside the script), as a
  production change would; no repo file is edited. A variant that did not trade a day is a stored ₹0,
  as in the rotation store.
- **Outcome:** net ₹ after charges (`gross - lot_plans.brokerage(n_trades)`), 1 lot a strategy, the
  three core picks (Buy left out).
- **Primary metric:** per universe, the mean daily difference (+ITM2 at ₹4,000 minus base), 90% circular
  block-bootstrap interval (`readout.block_bootstrap_mean`, 5-day blocks, 2,000 resamples, seed 20261026).
- **Reading rule, per universe:** *ITM2 adds value* if the interval is wholly above zero AND both calendar
  parts (2025, 2026) have a positive mean AND the maximum drawdown of the cumulative daily series is no
  more than 25% deeper than base. *No gain* if the mean difference is zero or below. Else *inconclusive*.
- **Secondary, fixed now, descriptive only:** total, mean, win rate, worst day, maximum drawdown and a
  daily Sharpe (mean over standard deviation) for each arm; the same on the hold-out year from
  2025-10-09; the 2025 and 2026 differences; days the picks differ; how many core picks are ITM2, by
  index; **the replacement table:** over all days, the share of the base universe's core picks of each
  family (ATM Dir, ITM1 Dir, Widesl, other) that are dropped when ITM2 joins, and which families enter
  in their place; the ₹3,000 arm beside the ₹4,000 one.
- **Look-ahead check:** each day's ranking reads results through the previous session only (asserted in
  the script) and that day's weekday, VIX open and days to expiry, exactly as the 09:16 job does; ITM2's
  stored results are the same simulation as ITM1's.
- **Known biases, stated now:** (1) the lists' weights were tuned on this same history, and ITM2 was
  proposed after BL-166 looked well on SENSEX's hold-out year, so this is an in-sample demonstration, not
  a test; the forward journal is the only clean check. (2) The engine fills with no spread; deeper ITM
  looks better than it would trade, and zero-volume minutes were not checked (BL-166). (3) ITM2 at ₹4,000
  uses a stop chosen in BL-166 on the same data. (4) T1's own variants were tuned on this history.
- **Hold-out:** none unseen. The year from 2025-10-09 is reported separately; the ranking's history
  window before 2025-01-10 is too short to add a clean earlier period.
- **Will not run:** ITM3, other stops, another list (A, B, REF), other universes, weights or minimums
  changed, a live or forward run. Running one needs `override: <reason>` in the Log.

### Phase 1 — Run and report
- **Tasks:** `packages/option-backtesting/research/bl167/study.py`; findings in this Log and
  `research/options/common/rotation-ranking.md` (and a line on the Directional strike-depth page).
- **Done when:** every number above is in the Log, whatever it shows.

## Risks

- ITM2 might simply swap one Dir for another with no change in results; the replacement table says so.
- A better in-sample reading is not evidence for the forward book; the item says so up front.

## Open questions

Answered by default: "add into the T1" is read as adding the 50 plain ITM2 variants to both universes
(Adaptive Classic and Adaptive Tuned), not tuned T1 sets for ITM2.

## Log

- 2026-10-26 — created from the owner's two messages; Phase 0 written and committed before the full run
  (the script runs end to end on counts: 431 sessions per arm and universe).
- 2026-10-26 — **run** (`research/bl167/study.py`; output `results/study.json`, git-ignored). 431 sessions (2025-01-10 → 2026-10-23) per arm; ITM2 is classed as Dir inside the script only. **Adaptive Classic (Core-298), ITM2 at ₹4,000 (primary) / ₹3,000 (control):** mean difference to base **−₹57 a day [−235, +118] / +₹13 [−131, +167]**; 2025 −217 [−434, −11] / −109; 2026 +144 / +166; hold-out year +37 / +49 (every interval includes zero except the 2025 half at ₹4,000, wholly below it: ITM2 made Core worse in 2025, in-sample). Total net ₹354,613 / ₹384,719 against base ₹379,202; maximum drawdown ₹31,849 / ₹30,399 against ₹42,326 (25% / 28% shallower); win rate 57.1% / 57.3% against 57.3%; worst day −₹11,954 / −₹10,839 against −₹10,862; daily Sharpe 0.154 / 0.172 against 0.169. Picks differ on 292 / 274 of 431 days; ITM2 is 263 / 245 of 1,293 core picks (20.3% / 18.9%; NIFTY 136 / 130, SENSEX 127 / 115). **Adaptive Tuned (T1):** **−₹74 a day [−258, +108] / −₹100 [−276, +72]**; 2025 −42 / −107; 2026 −114 / −91; hold-out −178 [−456, +77] / −177. Total ₹621,694 / ₹610,271 against ₹653,498; maximum drawdown ₹28,840 / ₹34,803 against ₹25,887 (11% / 34% deeper); win rate 64.7% / 64.3% against 65.4%; worst day −₹14,092 in all; Sharpe 0.259 / 0.252 against 0.264. Picks differ on 209 / 194 days; ITM2 is 176 / 158 of 1,293 core picks (13.6% / 12.2%). **Replacement** (share of the base universe's core picks, over 431 days, that are dropped when ITM2 joins; ₹4,000 / ₹3,000): Core ITM1 **77.5% / 75.0%** (220 / 213 of 284), ATM **58.0% / 50.7%** (40 / 35 of 69), Widesl 5.1% / 5.2% (48 / 49 of 940). T1 ITM1 **49.7% / 46.3%** (162 / 151 of 326), ATM **40.5% / 29.7%** (15 / 11 of 37), Widesl 5.1% / 4.9%. What enters: ITM2 263 / 245 (Core) and 176 / 158 (T1), plus 37 to 43 Widesl in Core and 39 in T1, almost no ITM1 or ATM. **Reading by the registered rule:** both universes at the primary ₹4,000 arm: *no gain* (mean difference below zero). The ₹3,000 control: Core +13 and T1 −100, also not value-adding (2025 negative in both). **Caveats, as registered:** in-sample; the lists' weights and ITM2's stop were chosen on this history; no spread; the forward journal is the only clean test.
- 2026-10-26 — after review (PR 332): the BL-166 results were also compared with the rotation store on the NET column (3 variants x 499 days, 1,497 days, 0 differ), not gross only. The replacement table now asserts that picks leaving equal picks entering (Core 308 and 308; T1 224 and 224), and says "dropped", not "replaced": what enters is counted apart. Not done: a forward shadow of the ITM2 variants (the only clean test), proposed in the review.
