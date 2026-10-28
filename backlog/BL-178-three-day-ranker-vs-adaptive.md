# BL-178 — A three-day ranker against Adaptive, on Core and on T1

| | |
|---|---|
| **Priority** | P2 — a direct owner question about the live ranking; one fixed rule, no search |
| **Status** | Done (killed) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-058 (the rotation lists and stored results), BL-113 (the T1 track) |
| **TODO.md row** | — |

## Context

The owner (2026-10-28): rank each strategy by only three results, a third each: the previous
two sessions and the same weekday last week (on a Wednesday: Tuesday, Monday and last
Wednesday). Run it on the Core pool and on the T1 (Adaptive tuned) pool and compare with what
Adaptive picks.

Adaptive (list C) ranks on a composite of recent form (15%), weekday fit (30%), days-to-expiry
fit (30%), VIX-band fit (20%) and family-band form (5%), each a percentile rank over up to 126
earlier days (`rotation/score.py`, `rotation/lists.py`).

## Goal

For each pool, the three-day ranker's daily net per lot beside Adaptive's over the same days,
with the same selection and costs, and a verdict under the rule below.

## Out of scope

Changing the live pick. Any other weighting, lookback or selection (each would be a new,
dated block).

## Plan

### Phase 0 — Pre-register

#### 2026-10-28 — Three-day ranker vs Adaptive
- **Hypothesis:** ranking by the plain average of the last two sessions' and last week's
  same-weekday result picks better strategies than Adaptive's composite.
- **Ranker:** score = mean of the strategy's one-lot net on (a) the previous session, (b) the
  session before it, (c) the latest earlier session with the same weekday within the previous
  14 calendar days. When (c) does not exist (a holiday), the score is the mean of (a) and (b).
  Raw rupees, no percentile rank. Ties broken by name, as `score.select`.
- **Selection, identical for both rankers:** `score.select` (top 3 non-Buy, at least 2 Widesl,
  the Buy add-on when a Buy ranks in the overall top 10), then the expiring-index rule
  (`expiry.filter_picks`) on the days it applies live (from 2026-10-19). Adaptive's picks are
  re-scored with `pick.score_history` on the history before each day, as the 09:16 job does;
  checked against the journal on the recorded days.
- **Universe:** Core = Core-298 (`variants.variant_names()`); T1 = Core-298 plus the T1 track's
  variants (`variants.track_names("t1")`), as `pick --track t1`. Stored one-lot results under
  `TRADING_DATA_ROOT/rotation/`; every variant of a pool existed before the period (no later
  additions ranked over days before they were defined).
- **Measure:** per day, the sum of the 3 core picks' one-lot net, minus estimated brokerage
  (`lot_plans.brokerage`: 2 orders a trade × ₹20 × 1.18). The Buy add-on is reported apart.
- **Period:** every session in `rotation/days.csv` with results for every variant of the pool,
  from 2025-10-28 to 2026-10-27 (the last year).
- **Look-ahead check:** both rankers read only rows before the day (the three-day ranker reads
  three of them); the day's own row is read only to score the picks. Adaptive's re-scored picks
  must equal the journal's list C on every recorded day of the period.
- **Pass / kill rule (per pool):** difference = three-day minus Adaptive daily net. Pass: mean
  difference > 0 and its 5-day block-bootstrap 90% interval (5,000 resamples, seed 178) above
  zero. Kill: mean difference ≤ 0. Otherwise inconclusive. Not adopted live without a pass.
- **Hold-out:** none. The period was already looked at (the Wide SL entry-window table of
  2026-10-28), and Adaptive's weights were chosen on P1 (Dec 2025 – Oct 2026), most of this
  period, so the comparison favours Adaptive. The T1 settings were chosen on 2024-10-09 –
  2025-10-08, before it.
- **Will not run:** other weights (50/25/25 and so on), longer windows, percentile-rank
  scoring, other periods. Each needs a new block, or `override: <reason>` in the Log.

#### Result
**Kill on both pools** (2026-10-28). 239 sessions, 2025-10-28 → 2026-10-27; net after estimated
brokerage, the 3 core picks at one lot each. Adaptive's re-scored picks equalled the journal's list
C on every recorded day checked (7 Core, 6 T1). 3 days had no same-weekday session in the previous
14 days and used the two previous sessions only.

| Pool | Ranker | Net a day | Per lot-strategy | Year | Days up | Max drawdown |
|---|---|---|---|---|---|---|
| Core | Adaptive | ₹993 | ₹331 | ₹2,37,394 | 60% | −₹35,929 |
| Core | Three-day | ₹779 | ₹260 | ₹1,86,274 | 59% | −₹68,924 |
| T1 | Adaptive | ₹1,674 | ₹558 | ₹4,00,100 | 68% | −₹25,672 |
| T1 | Three-day | ₹821 | ₹274 | ₹1,96,174 | 62% | −₹43,435 |

- Three-day minus Adaptive, per day: Core −₹214 [−₹632, +₹208] (mean ≤ 0: kill); T1 −₹853
  [−₹1,324, −₹376] (wholly negative: kill).
- The two rankers rarely agree: the same three picks on 4 (Core) and 3 (T1) days; 0.6 and 0.5 of
  the three picks shared on an average day.
- Buy add-on, apart: Core Adaptive +₹4,192 (35 days) vs three-day −₹4,501 (48); T1 −₹8,064 (32)
  vs −₹4,908 (52).
- Descriptive only, not tested: on Core the three-day ranker was ahead on NIFTY expiry days
  (₹2,381 vs ₹1,913 a day, 52 days) and behind on SENSEX expiry days (₹566 vs ₹1,961, 50 days); on
  T1 it was behind on every weekday except Friday.
- Bias: Adaptive's weights were chosen on P1 (Dec 2025 – Oct 2026), most of this year, which favours
  it; the T1 gap (interval wholly below zero) is larger than that bias is likely to explain, the Core
  one is not.
- Script and per-day picks: the session's scratchpad (`bl178/run.py`, `Core_daily.json`,
  `T1_daily.json`), not committed.

## Risks

One year, one rule; a pass would still need forward days before any live change.

## Log

- 2026-10-28 — created and pre-registered at the owner's request.
- 2026-10-28 — run; killed on both pools (Result above); `research/options/common/rotation-ranking.md` updated.
