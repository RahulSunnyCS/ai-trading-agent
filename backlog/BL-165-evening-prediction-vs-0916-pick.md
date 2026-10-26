# BL-165 — Evening prediction against the 09:16 pick: does the open change the return?

| | |
|---|---|
| **Priority** | P2 — decides whether the evening upload (16:40) is enough or the 09:18 top-up earns its place |
| **Status** | Done |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-26 |
| **Depends on** | BL-058 (rotation journal), BL-125 (evening message), BL-137 / BL-139 (evening uploads and 09:18 top-ups) |
| **TODO.md row** | — |

## Context

The owner asked (2026-10-26): "any change in return due to change in strategy due to 9:16, or the
previous day prediction worked?"

Each evening the result message names tomorrow's strategies (`rotation/tomorrow.py`,
`expected_picks`): the 09:16 ranking re-run on the stored results with the market's last close
standing in for tomorrow's opening VIX. The 09:16 job (`rotation/pick.py`) does the same ranking
with the real 09:15 VIX open. The two share the stored history through the previous session and
the days to expiry. The ONLY difference is the VIX input, and so the VIX band
(`score.vix_band`). The evening AlgoTest and Quantiply uploads (16:40 / 16:45) act on the
prediction; the 09:18 / 09:19 top-ups act on the real pick.

## Goal

Say, with numbers: how often the open moves the picks, and whether the picks the open produces
earn more than the evening prediction on the same day.

## Out of scope

Any other input to the ranking, other VIX proxies (pre-market indicative, GIFT Nifty), changing the
lists or the upload times, the expiry-only rule (BL-122: it only exists from 2026-10-19 and the
research history never applies it).

## Plan

### Phase 0 — Pre-register
Written and committed **before any run**.

- **Hypothesis:** the 09:16 pick, which sees the real open, earns more per day than the evening
  prediction, which sees only the previous close. The null: the difference is zero.
- **Arms, per trading day D:** *predicted* = `pick.score_history` with the VIX close of the
  previous session (`attrs.vix_close_from_lake`); *actual* = the same call with D's stored
  09:15 VIX open (`days.csv`). Same history (`pick.load_history(D)`), same weekday and days to
  expiry labels, list **C** (Adaptive, the public list), `expiry_only=None` on every day.
- **Universe:** Core-298 (`variants.variant_names()`), as the live list ranks. Repeated on Core-298
  plus the T1 track's variants (`track_names("t1")`) as a second universe, labelled in-sample.
  Window: every day from 2025-01-10 (the first day with 63 days of warm-up) to the last stored
  day, 2026-10-23, that has a lake VIX close for the previous session. A day without one is
  dropped and counted, never filled.
- **Outcome per day:** net ₹ at 1 lot per CORE strategy (the Buy add-on is left out, as in
  `lot_plans`), after costs of ₹20 x 1.18 x 2 per trade (`n_trades` of each stored result).
- **Primary metric:** the mean over days of (actual net - predicted net), with the 90% circular
  block-bootstrap interval (`readout.block_bootstrap_mean`, 5-day blocks, 2,000 resamples, seed
  20261026), Core-298.
- **Pass / kill rule:**
  - *The open helps* if the primary interval lies entirely above zero AND the mean difference is
    positive in both calendar halves (2025-01-10 to 2025-12-31, 2026-01-01 on).
  - *The prediction is good enough* if the primary interval lies inside +/- ₹150 a day (about one
    day's brokerage on three strategies) AND the share of days with identical picks is reported
    beside it.
  - Anything else is *inconclusive* and is reported as such.
- **Secondary, fixed now, descriptive only:** share of days the band differs; share with
  identical pick sets; mean number of the 3 strategies that differ; the two arms' mean net and
  win rate over all days, over changed days only and over unchanged days; by size of the VIX gap
  (previous close to open: |gap| under 0.5, 0.5 to 1, over 1 point); the T1 universe; the
  forward subset (the live journal's recorded days, 2026-10-12 on, 9 days, no statistics).
- **Look-ahead check:** both arms read results through the previous session only; the predicted
  arm adds the previous close (known the evening before), the actual arm the 09:15 open (known
  at 09:15, before the 09:16 record). The outcome day's own result is never in either input.
  `tests/unit` already holds `score_history` to the 09:16 job's call; the study calls that
  function. A check in the script asserts every history row is dated before D.
- **Known bias, stated now:** list C's weights were chosen as "best 2025-26" with the VIX band
  taken from the real open, so the actual arm is the one the weights were tuned for. The
  predicted arm is the out-of-design one. The paired difference therefore leans towards the open.
  The T1 universe is in-sample as well. Neither makes the comparison a forecast.
- **Hold-out:** none unseen; the 2026 half is the check on the 2025 half (rule above).
- **Will not run:** lists A, B and REF; other windows; other VIX proxies; any sweep of the band
  edges. Running one needs `override: <reason>` in the Log.

### Phase 1 — Run and report
- **Tasks:** `packages/option-backtesting/research/bl165/study.py`; write the numbers into this
  item's Log and a findings page under `research/options/`.
- **Deliverables:** the script, its output table, the page.
- **Done when:** every number in the pre-registration is in the Log, whatever it shows.

## Risks

- The prediction in the evening message may be re-derived later than it was sent (results for
  the day may be repaired afterwards); the study uses the stored results as they stand.
- Few days with a different band means a wide interval; the rule then says inconclusive.

## Open questions

None blocking.

## Log

- 2026-10-26 — created from the owner's question; Phase 0 written and committed before any run.
- 2026-10-26 — run (`packages/option-backtesting/research/bl165/study.py`, output `results/study.json`, git-ignored). Window 2025-01-10 → 2026-10-23, 432 days, none dropped (every day had a lake VIX close and every pick a stored result). **Core-298:** the band differs on 3.5% of days, the three picks on 13 days (97.0% identical); predicted ₹880.9 a day, actual ₹879.8; primary mean difference **−₹1.1**, 90% interval **−₹47.9 to +₹47.9**; halves 2025 −₹4.4 [−74.4, +65.4], 2026 +₹3.0 [−52.1, +65.7]; on the 13 changed days predicted −₹619 and actual −₹655 a day; by gap: 428 days under 0.5 points (−₹4.9), 2 between 0.5 and 1 (−₹525), 2 over 1 (+₹1,331). **Verdict by the registered rules:** the open helps — rejected (interval includes zero, halves differ in sign); the prediction is good enough — yes (interval inside ±₹150, 97% identical picks). **T1 universe (in-sample):** 14 changed days (96.8% identical); predicted ₹1,574.8, actual ₹1,509.9; mean **−₹64.9**, interval **−₹129.2 to −₹5.7**; halves −₹37.5 [−121.2, +49.4] and −₹99.2 [−201.7, −22.3]; changed days predicted +₹1,716 and actual −₹288 a day. The open helps — rejected; good enough — yes by the margin rule, with the caution that 14 days carry it. **Forward subset (9 recorded days):** prediction and actual picks are the same set on all 9; the reconstructed actual equals the journal entry on 7, the two mismatches are 19 and 22 October (BL-122 expiry days, rule not applied here). Page: `research/options/common/evening-prediction-vs-0916.md`.
- 2026-10-26 — **correction after review** (PR 326). The first run took `rec.days[i - 1]`, the previous STORED day, as the previous session; 2026-09-25 follows a September data gap (its previous stored day is 10 days earlier), so its prediction used a stale close and history. This is a fix to match the registered meaning ("the VIX close of the previous session"), found by code review and made after the first result was seen; it changes one day, and the first run's output is kept locally as `results/study_v1_before_adjacency_fix.json` (git-ignored). The script now requires the true previous trading day (holidays skipped) and drops a day whose stored history stops short (`history_not_current`: 1 day). Also: the cost is `lot_plans.brokerage` (same numbers), the forward check reuses the Core run, and a broken forward check now fails the run. **Corrected result, same rules:** Core-298, 431 days, band differs on 14 (3.2%), picks differ on 12 (97.2% identical); predicted ₹878.5 a day, actual ₹879.8; primary mean **+₹1.3**, 90% interval **−₹45.0 to +₹50.0**; halves 2025 −₹4.4 [−74.4, +65.4], 2026 +₹8.5 [−46.1, +72.4]; changed days predicted −₹830, actual −₹782 a day; gaps: 428 days under 0.5 points (−₹4.9), 1 between 0.5 and 1 (₹0), 2 over 1 (+₹1,331). Verdicts unchanged: the open helps — rejected (interval includes zero, halves differ in sign); the prediction is good enough — yes. T1 (in-sample): 13 changed days (97.0% identical); predicted ₹1,578.6, actual ₹1,516.2; mean **−₹62.3**, interval **−₹126.6 to −₹6.9**; halves −₹37.5 [−121.2, +49.4] and −₹93.5 [−196.3, −16.2]; changed days predicted +₹1,851, actual −₹215; verdicts unchanged. Forward subset unchanged (7 of 9 equal; the two differences are BL-122 days).
