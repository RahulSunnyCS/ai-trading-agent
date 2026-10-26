# BL-165 — Evening prediction against the 09:16 pick: does the open change the return?

| | |
|---|---|
| **Priority** | P2 — decides whether the evening upload (16:40) is enough or the 09:18 top-up earns its place |
| **Status** | In progress |
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
