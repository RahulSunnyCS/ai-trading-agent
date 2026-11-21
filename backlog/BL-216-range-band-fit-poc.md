# BL-216 — Range-band fit in Adaptive's ranking: a POC on T1 and Core

| | |
|---|---|
| **Priority** | P3 — the owner's question; the descriptive look (BL-111 Log, 2026-11-07) found no money link to the range known at 09:17 |
| **Status** | Done — killed: the range fit lowered both books |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-08 |
| **Depends on** | BL-110 (range persistence), BL-111 (the 2026-11-07 range look), BL-058 (list C), BL-113 (T1) |
| **TODO.md row** | 3.10.67 |

## Context

Owner (2026-11-08, chat): "Can we do a POC on the T1 after adding the range also? What it impact on the T1 and
the core adaptive last 1 or 2 years?" This follows the 2026-11-07 look recorded in BL-111's Log: the day
range persists (correlation with the last-5 mean 0.40 over the last two years), the books earn most on
calm days by the day's **own** range, but by the **last-5** range (what is known at 09:17) the books' daily
mean is flat and the win share only a little lower after wide weeks. By family, Dir earned after calm weeks
in 2024-26 and the opposite in 2023-24.

The ranking (list C, `rotation/score.py`) already fits each variant to the day's weekday, days to expiry and
VIX band (`skewed_fit`: its average result on past matching days, lookbacks 5 / 21 / 63 blended). This POC
adds the range the same way.

## Goal

The money impact on T1 and Core Adaptive, over the last one and two years, of a range-band fit in list C's
composite, against list C as it ranks today.

## Out of scope

Any change to the live lists, weights, journals or messages. Today's own range (not known at 09:17).
BL-111's H1 / H2 (lots by rank or by range regime). The book stop, Dir ×2 and the account split.

## Plan

### Phase 0 — Pre-register
Committed before any run (decisions taken by the assistant at the owner's request; the owner may overrule
them before the run).

- **Hypothesis:** adding a range-band fit to list C's composite raises T1's and Core's net per day.
- **Range:** an index's high − low from 09:17 to 15:29 as % of the 09:17 open, from the lake's 1-minute index
  bars. `last5(D)` = the mean over the 5 index sessions before D. The band of D = calm / mid / wide by the
  1/3 and 2/3 quantiles of `last5` over the 250 index sessions before D (no session on or after D). A NIFTY
  variant uses NIFTY's band, a SENSEX variant SENSEX's (as `dte_matrix` does for days to expiry).
- **Criterion:** `range` = `score.skewed_fit` over the days whose band equals D's, list C's lookbacks.
- **Arms:** `base` = list C as live (own 15 / weekday 30 / dte 30 / VIX 20 / family-band 5). **`R20`
  (primary)** = range 0.20, the others × 0.80. `R10` (secondary) = range 0.10, the others × 0.90.
- **Books:** T1 (Core-298 + the T1 track's variants) and Core (Core-298), list C, picked day by day from the
  stored one-lot results before each day (unslipped, as the ranking reads them). The live rules apply by date
  and alike in every arm: BL-122's expiring-index filter from 2026-10-19 and BL-192's SL150 % cap from
  2026-10-30 (T1 only; Core has no such variant). The Widesl minimum and Buy add-on as `score.select`.
- **Money:** each pick at one lot, net after costs and 0.5 % slippage (the slippage copies), summed per day.
- **Windows:** 2 years = 2025-01-10 (the first day after the 63-day warm-up of the store, which starts
  2024-10-09) to 2026-11-06; 1 year = 2025-11-07 to 2026-11-06.
- **Metric:** mean daily (arm − base) net, a circular 5-day block bootstrap (2,000 resamples, seed 20261108,
  90 % interval, `readout.block_bootstrap_mean`); beside it each arm's total, win share, average, worst day,
  max drawdown, and the share of days whose picks differ from base.
- **Pass rule (per book, arm R20):** over 2 years the interval's lower bound > 0, **and** over 1 year the mean
  difference > 0, **and** the 2-year max drawdown no more than 10 % deeper than base's. Anything else: no gain,
  the range is not added. R10 is reported and can never pass the idea on its own (a lead at most).
- **Look-ahead check:** the band of D reads index sessions before D only; the fit reads results of days
  before D only (`composite` never reads its last row). The script asserts the band of every day is
  unchanged when the index ranges are cut to the days before it. The `base` arm must reproduce the
  journals' list C picks (core + Buy) on their recorded days (Core from 2026-10-12, T1 from 2026-10-19);
  a mismatch is listed with its day, and below 90 % agreement the run stops for a look before any result is read.
- **Hold-out:** none blind. The 2026-11-07 look already read these two years by range, so this is in-sample.
  A pass earns only a forward paper track with its own registered rule, never a change to the live ranking.
- **Survivorship:** the universe is today's Core-298 and T1 variants, every one with results on every store
  day (none was dropped for its results).
- **Will not run:** other weights, other band counts or windows, today's own range, a Dir-only range gate.
  Running one needs `override: <reason>` in the Log.

### Phase 1 — Run and record
- **Tasks:** `research/bl216/range_fit.py` (the bands, the arms, the replay, the read-out); run it; record.
- **Deliverables:** the results JSON beside the script; this Log; the findings page.
- **Done when:** the pass rule is read for both books and recorded here, in `INDEX.md`, `TODO.md` and
  `research/options/common/rotation-ranking.md`.

## Risks

- The range band is close to the VIX band (BL-110: VIX halves the previous range's coefficient), so the new
  fit may mostly duplicate the VIX fit; the share of days whose picks change says how much it moves.

## Log

- 2026-11-08 — created at the owner's request; Phase 0 registered before any run.
- 2026-11-08 — **Run (Phase 1). Killed: adding the range lowered both books.** `research/bl216/range_fit.py`,
  results `range_fit_2026-11-08.json`. The base arm reproduced the journals' list C on every recorded day (T1 14 of 14,
  Core 19 of 19); the look-ahead assert passed. Bands over the 505 store days (NIFTY): calm 207, mid 110, wide 188
  (the trailing 250-session cuts: the last two years ran calmer and wider than the year before them). Per day, one lot
  a pick, after costs and 0.5 % slippage; arm − base mean with the 90 % block-bootstrap interval:

  | Book | Window | Base avg / win / max DD | R20 − base | R10 − base | Days R20 changed |
  |---|---|---|---|---|---|
  | T1 | 2 years (442 d) | +1,343 / 64 % / −32,386 | **−257 [−460, −43]** | −110 [−275, +51] | 67 % |
  | T1 | 1 year (240 d) | +1,263 / 65 % / −32,386 | −296 [−564, −37] | −196 [−395, −4] | 69 % |
  | Core | 2 years | +730 / 56 % / −38,991 | −150 [−353, +44] | −183 [−344, −19] | 65 % |
  | Core | 1 year | +702 / 57 % / −38,991 | −107 [−347, +126] | −200 [−377, −14] | 62 % |

  Pass rule (R20): T1 fails (2-year lower bound −460, 1-year mean −296; drawdown −33,497 within 10 %); Core fails
  (lower bound −353, 1-year mean −107, drawdown −48,118 deeper than 10 %). R10 was worse too. The range fit changed
  the picks on two days in three and moved them to worse ones: T1's two-year total +₹5.94 L → +₹4.80 L, win share
  64 % → 60 %. Reading: the range band known at 09:17 carries no information the ranking can use beyond what
  weekday, days to expiry and VIX already give; adding it dilutes those. Not added; no forward track.
