# BL-238 — T1 from scratch: re-simulate every strategy, re-rank every day, no stored result

| | |
|---|---|
| **Priority** | P1 — T1 is what real money trades; its return and drawdown should be reproducible from raw bars |
| **Status** | Done — does not match on the registered rule (rule 3, picks 92.6%); return and drawdown agree |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-20 |
| **Depends on** | BL-113 (the T1 track), BL-122 / BL-192 (expiry-only rule, SL150% cap), the slippage-copy fix (`fix-slippage-copy-path`) |
| **TODO.md row** | — |

## Context

Every T1 figure quoted so far (₹5.91 lakh after 0.5% slippage, ₹8.11 lakh before it, deepest
drawdown ₹36.6k / ₹32.2k over 448 days from 2025-01-10) is built on stored files: per-variant result
CSVs, `days.csv`, the journal for the days it covers, the slippage copies and a replayed-path
cache. The owner (2026-11-20) asks for the whole thing again from nothing: take a 3-month buffer,
rank every day from the 4th month on using only what came before it, run the picked strategies
fresh, and check that return and drawdown still match.

T1 = Adaptive (list C) over the T1 pool, Core-298 plus the 223 frozen `strategies/rotation_t1/`
files, three picks a day (at least two Widesl, a Buy add-on when one ranks in the top ten).

## Goal

One answer, read once: do the return and drawdown of T1 re-derived from the lake's 1-minute bars
and the strategy files alone agree with the stored figures, and if not, which cells differ and why.

## Out of scope

Any change to the ranking, the pool, the settings or the book stop; any other window or arm; a
live change. It audits what exists; it does not look for something better.

## Plan

### Phase 0 — Pre-register (committed before any run, 2026-11-20)

- **Hypothesis:** the stored T1 figures are reproducible from raw inputs.
- **Inputs allowed (and nothing else):** the lake's 1-minute option, index and India VIX bars and
  symbol masters under `TRADING_DATA_ROOT`; the strategy files (`strategies/rotation/`,
  `strategies/rotation_t1/`); the reference CSVs (lot sizes, expiry calendar); the
  `data_quality` verdict that excludes a day (a judgment about the raw day, not a result).
  **Never read:** `rotation/results/**`, `rotation/track_t1/**`, `days.csv`, any journal, the
  slippage copies, `ATA_PORTFOLIO_CACHE_DIR`, `standing.csv`, the live capture. The script reads
  the stored results only after its own figures are written, to compare.
- **Window:** the usable days in the lake (a weekday with option and index bars for NIFTY and
  SENSEX, an India VIX bar, and no `data_quality` exclusion) from the first such day to
  2026-11-19. The first 63 sessions are the buffer (the ranking's `WARMUP`, also its longest
  fast lookback; the owner's "3 months"); picks start on the 64th. The lake has no usable day
  before 2024-09-20, so the buffer cannot start two years back: the trading window is about 22
  months, as in the stored figures. Stated, not worked around.
- **From-scratch run:** every variant of the pool simulated on every usable day with the nightly
  update's own call (`simulate_day`, the same strategy files, `SIZING_DATE`); day attributes
  (weekday, 09:15 India VIX open and its band, days to the nearest listed expiry, weekday basis)
  derived from the bars; each day ranked by `pick.score_history` on the fresh results of the days
  before it, with the BL-122 expiry-only rule from 2026-10-19 and the BL-192 cap from 2026-10-30
  (as the stored book has them); the picked strategies' fresh minute paths run under the T1 book
  stop (₹9,000 a lot); slippage by the fixed method (fills moved against the trade, path kept).
- **Look-ahead check:** `score_history` reads only rows before the target day; the target day's
  weekday, expiry distance and 09:15 VIX open are known before the 09:17 entry. The script asserts
  the history it passes holds no row of the target day and that no label is derived from a result.
  The 09:15 VIX open is the day's own, as every reconstructed day in the store (since 2026-11-09
  the live pick uses the previous close; not rerun here).
- **Survivorship / selection (disclosed, not removable):** the 223 T1 files were chosen on
  2024-10-09 → 2025-10-08 with the stored results, so the pool is in-sample for that period. A
  from-scratch replay shows the figures are reproducible, not that they would have been found
  without hindsight.
- **Data snooping:** one run, nothing tuned, nothing chosen after seeing a result.
- **Measure:** per day the three picks (and Buy add-on), their fresh one-lot net, the book under
  the ₹9k stop; totals, mean ₹ per lot-day and deepest drawdown at 0% and at 0.5% slippage,
  for the whole window and for the stored figures' own window (2025-01-10 → 2026-11-19).
- **Agreement rule (read once, fixed now):** *match* when, on 2025-01-10 → 2026-11-19, (1) the
  fresh total net is within 2% of the stored one at 0% slippage, (2) the deepest drawdown is
  within 10% of the stored one, and (3) the fresh picks equal the stored picks on at least 95% of
  days. Anything else is *does not match*, and the cells that differ are listed (variants,
  days, size). Fresh-versus-stored result cells that differ by more than ₹1 are counted and
  grouped, whatever the verdict.
- **Will not run:** a different warm-up, window, pool, weights, stop, VIX stand-in or expiry rule;
  a second pass after seeing the differences. Each needs `override: <reason>` in the Log first.

### Phase 1 — Replay script
- **Tasks:** `packages/option-backtesting/research/bl238/run.py`: fresh simulations (resumable,
  written outside git), attributes, ranking, picks, fresh paths for the picks, the book under the
  stop, the comparison.
- **Done when:** the script runs end to end and writes its figures before it opens a stored file.

### Phase 2 — Run and record
- **Tasks:** run once; record the figures, the verdict and the differences here; update the
  findings page (`research/options/common/rotation-ranking.md`); `INDEX.md`.
- **Done when:** result and verdict are committed.

## Result (2026-11-20)

Run once, as registered. Fresh simulations of all 521 variants on 532 lake days (five, 20-26 Sep 2024,
could not be simulated for NIFTY: no lot size on file before the 26 Sep 2024 expiry; they are
dropped, leaving 527 days and a first pick on 2025-01-01, 464 pick days to 2026-11-19). Ranking by
`pick.score_history` on the fresh results only; picks re-run fresh; T1 book stop ₹9,000; engine costs
are zero. Figures one lot per strategy.

**Fresh, whole window (464 days):**

| | Net | Mean per lot-day | Deepest drawdown | Below its high now |
|---|---|---|---|---|
| 0% slippage, book stop | ₹8,16,255 | ₹1,759 | ₹33,553 | ₹15,722 |
| 0% slippage, no stop | ₹8,07,394 | ₹1,740 | ₹39,653 | ₹21,822 |
| 0.5% slippage, book stop | ₹5,76,828 | ₹1,243 | ₹37,812 | ₹24,057 |
| 0.5% slippage, no stop | ₹5,66,663 | ₹1,221 | ₹46,176 | ₹32,421 |

**Against the stored figures, on the stored window (2025-01-10 → 2026-11-17, 448 days):**

| | Fresh | Stored | Difference |
|---|---|---|---|
| Net, 0% slippage | ₹8,06,738 | ₹8,11,166 | −0.5% |
| Deepest drawdown, 0% | ₹33,553 | ₹32,223 | +4.1% |
| Net, 0.5% slippage | ₹5,76,089 | ₹5,90,870 | −2.5% |
| Deepest drawdown, 0.5% | ₹37,812 | ₹36,632 | +3.2% |
| Same three picks | 415 of 448 days | | 92.6% |

**Verdict by the registered rule: does not match.** Rule 1 (net within 2%) and rule 2 (drawdown
within 10%) hold; rule 3 (picks equal on at least 95% of days) fails at 92.6%. Return and drawdown
are reproduced; the pick lists are not quite.

**What differs.**
- *Result cells:* 266,482 of 267,273 comparable variant-days are the same within ₹1. The 791 that differ
  are all on two days: 2026-11-06 (402 cells, up to ₹10.8k, e.g. `S_ditm1_1002` fresh −3,096, stored
  +7,744) and 2026-11-18 (389 cells). Both days were collected from Angel One (the Fyers token was
  missing) and later overwritten from Fyers (the 9 Nov and 19 Nov repair runs); their stored results
  were computed on the Angel One bars and never re-scored. So the stored results of those two days
  are stale, not the fresh ones.
- *Picks, 33 days:* 10 in Jan-Mar 2025 (the fresh history starts 27 Sep 2024, eight sessions before
  the stored one, and the stored day file has SENSEX days-to-expiry `unknown` on five days of Oct
  2024 that the lake gives a value; likely, not isolated), 23 in Sep-Nov 2026 (10 of them on journal
  days from 19 Oct, where the live pick used the evening list; two, 11 and 16 Nov, follow the stale
  6 Nov cells; the rest not explained). Only 1 of the 33 days has a different weekday, VIX band
  or expiry label. A second pass to isolate the cause is on the registered will-not-run list.
- *The live list for Thu 19 Nov* (made on the evening of 18 Nov from the stale 18 Nov cells) holds
  `S_wide_0917` where the fresh ranking has `S_p320_0917`: one pick of three.

Caveats as registered: the 223 T1 files were chosen on 2024-10-09 → 2025-10-08, so this shows the
figures are reproducible, not that T1 would have been found without hindsight; the 09:15 VIX open is
used for every day (the live pick has used the previous close since 2026-11-09).

## Risks

- About 600 days × 521 variants of simulation: a long run on one laptop; it is resumable.
- Days stored under an older engine, or from Angel One and later repaired from Fyers, can differ
  from a fresh run: that is a finding, not an error.

## Open questions

None; the owner gave the method on 2026-11-20.

## Log

- 2026-11-20 — created from the owner's request; Phase 0 registered before any run.
- 2026-11-20 — amendment, no result read: the five days 20-26 Sep 2024 cannot be simulated for NIFTY (no lot size on file) and are dropped from the window.
- 2026-11-20 — run once; result and verdict above (rule 3 fails). Stored results of 6 and 18 Nov are stale (Angel One bars, repaired from Fyers, not re-scored).
