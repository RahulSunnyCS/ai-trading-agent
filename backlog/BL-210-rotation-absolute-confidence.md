# BL-210 — An absolute confidence score beside the rotation rank

| | |
|---|---|
| **Priority** | P2 — research only; nothing is shown or traded on it until Phase 1 passes |
| **Status** | Done — killed by the registered rule (Phase 1, 2026-11-05); Phases 2–3 not started |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-05 |
| **Depends on** | the rotation store and journal (BL-058), the T1 track (BL-113) |
| **TODO.md row** | 3.10.61 |

## Context

The rotation's composite (`rotation/score.py`) is relative by construction: each of its criteria
(the last 5 / 10 days' P&L, the average P&L on past days with the same weekday, the same days to
expiry and the same VIX band) is computed in rupees per lot and then converted to a percentile
rank across the 298 variants, and the weighted ranks are summed. So the top pick always scores
near the maximum, whether the best strategy has been making ₹3,000 a day or losing ₹500 a day.
The pick can say which three are best; it cannot say "nothing looks good today".

Owner, 2026-11-05: "can we also score quantitatively, out of a hundred, so during a bad era the
topper might reach only 70 — from the absolute return, the win percent and so on?" Discussed: the
absolute figures already exist inside the ranking and are thrown away at the percentile step; a
gate built on them would be a tuned threshold like every other threshold in the system (the
weights, the book stops, BL-122), so it needs the same protection — pre-registration, an
in-sample / out-of-sample test, then a shadow run on the forward journal before it touches a lot.
It also differs from the rank in how fast it can be judged: the rank is tested on every forward
day, a gate only on the days it fires. The owner asked for a POC as research first, not a product
change: "Do a POC now. Don't incorporate. Just as research."

What exists: `explain.rank_day` rebuilds each criterion's raw value per variant for any past day
(the "Why this pick?" widget shows them); `rankic.py` tests whether the rank predicts the day's
results over research and forward days; `readout.block_bootstrap_mean` is the house interval.

## Goal

Know whether a 0–100 confidence figure, built from the picked basket's own absolute history in
the ranking's own windows, predicts the basket's net on the day. If it does, a shadow run and
then a display follow as their own phases; if it does not, the idea is closed with the numbers.

## Out of scope

- Any change to the ranking, the picks, the messages or the Rotation page in Phase 1.
- Tuning the figure (scale, blend, thresholds, lookbacks): one definition, declared below.
- A sizing or skip rule in production. Phase 3 only, after Phases 1 and 2 pass.

## Plan

### Phase 0 — Pre-register
Committed before any run (2026-11-05).

- **Hypothesis:** on a day the picked basket's absolute history (win rate and average ₹/lot on
  the days the ranking matched) is weak, the basket's net that day is lower; so the confidence
  figure correlates positively with the basket's same-day net, and the days in its bottom third
  earn less than those in its top third.
- **Definitions** (owner's answers, 2026-11-05):
  - *Books:* Core (list C, Adaptive, over Core-298) and T1 (list C over Core-298 plus
    `strategies/rotation_t1/`). Picks re-derived from the stored results exactly as
    `pick.score_history` does, with the day's expiry-only rule (`expiry.rule_index`, from
    2026-10-19) and the SL150 % cap (`sl150_cap`, from 2026-10-30). The three core picks only;
    a Buy pick is left out.
  - *Basket's own days (owner's choice over "average of the picks"):* for a day D with picks
    {p1, p2, p3}, the basket series b_t = Σ net per lot of the three on each earlier day t
    (slippage 0, as the ranking reads). A day on which one pick has no result leaves the basket's
    series (never counted as zero).
  - *The ranking's own windows (owner's choice over a fixed 20 days):* the matched days and
    weights of list C's criteria. `recent`: the last 10 days, weighted ⅔ on the last 5 and ⅓ on
    the 5 before, as `score.recent_score`. `weekday`, `dte`, `vix`: the days in each lookback
    window (`LOOKBACKS_NEW`) whose attribute equals D's, blended by the lookback weights and
    renormalised over the windows that have a matching day, as `score.skewed_fit`. For `dte` a
    past day matches when every pick's own label matches (a NIFTY pick compares `dte_n`, a SENSEX
    pick `dte_s`). `rfam` (a family average, 5 %) is dropped and the four weights renormalised:
    recent 15/95, weekday 30/95, dte 30/95, vix 20/95.
  - *Blend of win rate and rupees (owner's choice over win rate alone):* per criterion k,
    W_k = 100 × the share of matched days with b_t > 0; R_k = clip(50 + 50 × mean(b_t) / SCALE,
    0, 100) with **SCALE = ₹3,000 per basket-day**, fixed here (three one-lot strategies whose
    overall stops are ₹2,500–4,000; a basket averaging −₹3,000 reads 0, +₹3,000 reads 100).
    c_k = (W_k + R_k) / 2. A criterion with no matched day is left out and the weights
    renormalised over the rest.
  - *Confidence:* C(D) = Σ_k w_k c_k, in [0, 100].
- **Universe:** Core-298 and the T1 variants as stored (`rotation/results/`,
  `rotation/track_t1/results/`). Known caveat, the same as every rotation item: both universes
  were chosen (BL-058, BL-113) on this same history, so every research day is in-sample for the
  universe; the test is of the confidence figure given the universe, not of the universe.
- **Look-ahead check:** C(D) and the picks for D read only result rows strictly before D
  (`explain._history_rows`) plus D's own weekday, VIX band and days to expiry from `days.csv`
  (a journal day: the entry's recorded attributes, as `rankic.day_row`). The basket's net on D is
  read after. The script asserts that no row ≥ D enters any history array.
- **Periods:** *research set* = every day with ≥ WARMUP (63) earlier days of results, from the
  first such day (2025-01-10) to 2026-10-11, the day before the journal's first entry; *forward
  set* = 2026-10-12 to the run day, reported separately and not in the verdict (too few days for
  one). *Stability:* the research set split in two equal halves by count, each reported.
- **Statistics,** per book, on the research set:
  1. Spearman ρ between C(D) and the basket's net on D, with a 5-day circular block-bootstrap
     90 % interval (2,000 resamples, seed 20261105, the readout's conventions).
  2. The research set cut into terciles of C (cut points from the set itself): mean basket net
     per day, top tercile minus bottom, with the same interval.
  3. ONE pre-declared rule, descriptive: skip the day when C < 40. Net with and without the skip
     (simple sum per lot, no book stop), days skipped, worst drawdown of each.
- **Pass / kill rule:** *pass* when, on both books, ρ > 0 with its interval excluding 0 AND the
  tercile spread > ₹500 per basket-day with its interval excluding 0. *Kill* when either interval
  includes 0 on either book. *Inconclusive* when one book passes and the other does not. The
  skip rule's numbers are reported, never part of the verdict.
- **Hold-out:** the forward set (2026-10-12 →), shown only after the research-set verdict is
  written.
- **Will not run:** sweeps of SCALE, the 50/50 blend, the 40 threshold, the lookbacks, the
  criteria set or the per-pick alternative; any version shown in the message or on the page before
  a pass. Running one needs `override: <reason>` in the Log.

### Phase 1 — POC
- **Tasks:** `packages/option-backtesting/research/bl210/confidence.py`: build C(D) and the
  basket net for every day of both books from the live store (read-only; the T1 book's picks
  need the T1 results, so its research set starts where they do), write
  `research/bl210/confidence_<run day>.json` and `confidence_<book>_<run day>.csv` (day, picks,
  each criterion's W, R, matched days, C, basket net), print the statistics and the verdict.
- **Deliverables:** the script, its results, the verdict in this Log, and
  `research/options/common/rotation-confidence.md` (status Tested) with a line from
  `research/options/common/rotation-ranking.md`.
- **Done when:** the verdict is written here with the numbers for both books, the halves and the
  forward set.
- **Result (2026-11-05, `research/bl210/confidence_2026-11-05.json`):** **killed.** 423 research
  days per book (2025-01-10 → 2026-10-09; the T1 track's results are backfilled over the same days).

  | Book | ρ(C, net) [90 %] | Top − bottom tercile ₹/day [90 %] | Tercile means ₹/day (bottom · mid · top) | C range |
  |---|---|---|---|---|
  | Core | +0.081 [+0.008, +0.152] | +741 [−44, +1,734] | 846 · 1,053 · 1,587 | 51–96, mean 83 |
  | T1 | +0.066 [−0.010, +0.144] | +689 [−260, +1,687] | 1,322 · 2,168 · 2,011 | 60–97, mean 86 |

  Halves: Core ρ +0.040 [−0.061, +0.139] then +0.123 [+0.018, +0.229]; T1 +0.023 [−0.090,
  +0.136] then +0.089 [−0.012, +0.192], its first-half spread −₹544. Forward (18 days, held out):
  Core ρ +0.216 [−0.183, +0.476], T1 +0.366 [−0.066, +0.728], spread +₹6,372 [+846, +9,585] on T1.
  The skip rule (C < 40) fired on no day: C never fell below 50. Reading: a small, consistently
  positive lead that the registered test does not confirm, and a figure whose scale (₹3,000, the
  50 % rupee floor) never reads "bad". Rescaling it is a sweep this item ruled out.

### Phase 2 — Shadow (only on a pass)
- **Tasks:** compute C(D) each morning beside the picks into a side file (never the journal's
  hash-chained entry), for 60 forward days; the same two statistics on them.
- **Done when:** 60 forward days scored and the same pass rule read on them.

### Phase 3 — Show, then decide a rule (only on a Phase 2 pass)
- **Tasks:** one line in the 16:00 message and the Rotation page; then, as its own item, a
  pre-registered sizing or skip rule with a kill switch like BL-122's.

## Risks

- **Universe in-sample** (above): a pass on the research set says less than it would on a
  universe chosen elsewhere; the forward set and Phase 2 carry the real weight.
- **Lag:** the recent and matched windows describe the last weeks; by the time C is low a bad
  patch may be half over. BL-115 and BL-180 found little in conditioning picks on recent
  conditions. Expect a small effect; the pass rule is set so a small effect that is reliably
  signed still passes.
- **Slow evidence for a gate:** a rule skipping ~15 % of days gives ~9 judged days in 60 forward
  days; hence the shadow phase and no rule in Phase 1.

## Open questions

Answered 2026-11-05 (owner): blend of win rate and rupees; basket's own days; the ranking's own
windows; a POC as research only, nothing shown.

## Log

- 2026-11-05 — created from the owner's question; questions answered; Phase 0 registered.
- 2026-11-05 — Phase 1 run once (one definition, no sweeps): killed on both books; numbers above and
  on `research/options/common/rotation-confidence.md`. Phases 2–3 not started. Found while building it:
  `explain.load_snapshot` reads every variant from the live results folder, so it cannot take a
  track's names (the script reads through `store.load_matrix` instead); noted, not changed.
