# BL-156 — Leg stop and MTM stop, on the tick or the candle close: track all four combinations every day

| | |
|---|---|
| **Priority** | P1: real money runs on Quantiply (leg and MTM checked on the tick) while the paper engine checks MTM on the candle close. In-sample, the leg check is worth ₹350–450 a day. Only forward days can show whether that edge holds and whether the MTM check matters |
| **Status** | Planned |
| **Type** | research (Phases 1–3 build the daily record) |
| **Area** | options |
| **Created** | 2026-10-23 |
| **Depends on** | BL-058 (the journal's recorded picks), BL-139 (the Quantiply upload), BL-141 (the 15:40 live capture, the ground truth for combination ④) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner compared four ways of checking the stops on the same picks, 2026-10-23. The figures
are **in-sample** over about 431 days (₹6.58 lakh ÷ ₹1,526). The script that produced them is not
in the repo yet, and neither is the method behind "significantly".

| Combination | Per day | Total | Max drawdown | vs live today |
|---|---|---|---|---|
| ① Leg candle close + MTM candle close | +₹1,112 | +₹4.79 lakh | −₹33,413 | −₹354/day, significantly worse |
| ② Leg candle close + MTM tick | +₹1,021 | +₹4.40 lakh | −₹34,211 | −₹444/day, significantly worse |
| ③ Leg tick + MTM candle close (paper today) | +₹1,526 | +₹6.58 lakh | −₹25,806 | +₹60/day, not significant |
| ④ Leg tick + MTM tick (Quantiply live today) | +₹1,466 | +₹6.32 lakh | −₹29,367 | baseline |

How the table reads: the leg-stop check is what matters (③/④ beat ①/②). The MTM check does not
(③ − ④ = +₹60/day, not significant).

**What the engine does today** (`legwise/engine.py`, module docstring):
- A leg's SL / target is checked against each 1-minute bar's high/low, so it fires within the
  bar. It fills at the trigger, or at the open if the bar gapped through. This is "leg tick".
- The overall stop / target is checked on the combined MTM at each bar's **close**. This is
  "MTM candle close".

So the stored rotation results, the ranking and the 16:00 paper P&L are all ③. Quantiply runs ④
(both checked on the tick).

**The bias this item has to correct for.** The 09:16 ranking scores variants on their ③ history.
Ranking on ③ selects picks that did well under ③, so the in-sample table is tilted towards ③.
Forward days are the honest test: the picks are recorded before 09:17 and are the same under all
four combinations, so only the stop checking differs.

**A 1-minute model of "tick" is an approximation.**
- Leg tick (bar high/low) is exact about whether the stop is touched. It is only approximate
  about the order in which things happen inside the bar.
- MTM tick has no exact form on 1-minute bars. The two short legs' adverse extremes in one bar
  need not happen at the same moment, so summing them overstates the worst MTM (a conservative
  bound).

The daily Quantiply capture (BL-141) is the real ④. Comparing it with the modelled ④ every day
measures how wrong the model is.

## Goal

- Every trading day, the day's recorded Adaptive picks are scored under all four combinations,
  one lot per pick, net of the same costs.
- The four results are stored beside the real Quantiply result for the same picks.
- A pre-registered read-out at the 60th scored forward day answers three questions:
  1. Does leg tick still beat leg candle close (③ − ①, ④ − ②)?
  2. Does the MTM check matter (③ − ④)?
  3. Is the modelled ④ close enough to the real Quantiply result to trust the other three?

## Out of scope

- Changing any live setting on Quantiply or AlgoTest. A change after the read-out is the
  owner's decision, recorded in the Log.
- Changing the ranking's inputs: the 09:16 pick keeps reading ③.
- Ticks finer than 1-minute bars: no tick data is collected.
- Re-picking per combination (that is a different question).

## Plan

### Phase 0 — Pre-register (commit before any forward run)
- **Hypothesis:**
  - Checking the leg stop on the tick beats checking it on the 1-minute candle close, by a
    positive amount per day, on forward days.
  - Checking the MTM stop on the tick versus the candle close makes no difference that can be
    told apart from zero.
- **Universe:** the live journal's list C (Adaptive, Core-298) recorded picks, one lot each,
  from the first forward day this phase is committed before. Late entries (not before 09:17)
  and days with any pick unscored are excluded and counted.
  - T1 (`--track t1`) is recorded the same way and reported separately. It is never pooled
    with Core.
- **Look-ahead check:**
  - The picks are read from the hash-chained journal entry, which was recorded before 09:17.
  - A combination changes only how stops are checked inside the day: its inputs are the day's
    own bars after each entry.
  - A test pins that, with the defaults, the scorer reproduces each pick's stored result.
- **Pass / kill rule.** Each comparison is the mean per day of combination X minus combination
  Y on the same picks, with a circular 5-day block bootstrap 90% interval (2,000 resamples,
  seed 20261023; `readout.block_bootstrap_mean`):
  - **Leg check:** ③ − ① and ④ − ② both have intervals above zero → leg tick holds its edge
    (keep live on the tick). Either interval below zero → the in-sample edge was selection;
    log it and put the platform setting to the owner.
  - **MTM check:** ④ − ③ with an interval that includes zero → no action. An interval
    entirely above or below zero → the better MTM check is put to the owner as a platform
    setting, if the platform offers it (open question 2).
  - **Model check:** real Quantiply ④ minus modelled ④, per lot. A mean gap whose interval
    excludes zero, or whose size exceeds a third of the ③ − ④ gap being tested, means the
    MTM-tick model is not good enough. The MTM-check verdict is then "not decided" until the
    model is fixed.
  - Max drawdown per lot is reported for each combination; it is not part of the rule.
- **Hold-out:**
  - The ~431 in-sample days (the table above) are already seen; they are context only.
  - The forward days from the commit date to the 60th scored day are the test. Nothing is read
    out before day 60, apart from the daily figures, which are descriptive.
- **Will not run:**
  - No per-day switching between combinations by VIX, weekday or days to expiry.
  - No sweep of other check intervals (5-minute candles and the like).
  - Running one needs `override: <reason>` in the Log.

### Phase 1 — Make the four combinations reproducible
- **Tasks:**
  - Add two execution options to the leg-wise schema, with today's behaviour as the default so
    every stored result and golden is unchanged:
    - `leg_check: tick | candle_close`. `candle_close` fires when the bar closes through the
      level and fills at that close.
    - `mtm_check: candle_close | tick`. `tick` uses the bar's worst-case combined MTM (each open
      leg at its adverse extreme), the conservative bound in Context. It exits at the stop
      level, or the bar's open if it gapped through.
  - Document both in `engine.py`'s docstring next to the existing bar conventions.
  - Add `research/bl156/reproduce.py`: the in-sample table above from the stored picks under the
    four combinations, with the method used for "significantly" written down.
- **Deliverables:** the schema and engine options, unit tests per option, and the reproduce
  script with its output in the Log.
- **Done when:**
  - `tests/golden/test_legwise_scenarios.py` and `scripts/update-legwise-goldens.py` pass
    unchanged.
  - Each new option has a hand-checked scenario.
  - The reproduce script lands within ₹10/day of the table above, or the Log says why the
    figures differ.

### Phase 2 — The daily record
- **Tasks:**
  - Add `obt rotation check-modes [--day D] [--track t1]`. It scores the day's recorded picks
    under ①–④ with `update.py`'s own call and `SIZING_DATE`. It writes
    `TRADING_DATA_ROOT/rotation/check-modes/<day>.json` (idempotent; a rerun replaces only that
    day).
  - In the same file, add the real Quantiply ④ for the same picks from BL-141's
    `rotation/live/<day>.jsonl` when it exists. Mark it `not_captured` otherwise, never zero.
  - Run it as an isolated step of `obt rotation update` (as triggers are): a failure alerts and
    never fails the evening run. Add `--backfill` for the forward days already in the journal.
- **Deliverables:** the command, the day files, unit tests on a synthetic store
  (`tests/unit/rotation_synth.py`), and the technical.md command line.
- **Done when:** three consecutive trading days have a day file written by the scheduler, each
  with ①–④ and either a real ④ or `not_captured`.

### Phase 3 — See it daily
- **Tasks:**
  - Add `obt rotation check-modes-readout [--track t1] [--json]`: running totals per
    combination, the three differences with their intervals (descriptive until day 60), and
    the model gap.
  - Add one line to the owner's 16:00 message only, never the group's. For example:
    `Stops · leg tick +₹410 vs close · MTM tick −₹35 vs close · model gap ₹12`.
  - Add a "Stop checking" card on the Rotation page that reads
    `GET /legwise/rotation/check-modes`, and update its Guide page in the same commit.
- **Deliverables:** the CLI read-out, the message line, the route, card and Guide page.
- **Done when:** the owner reads that day's four combinations in the 16:00 message and on the
  page.

### Phase 4 — Read-out at day 60
- **Tasks:**
  - Apply the Phase 0 rule once, on the 60th scored forward day, and record the verdict in the
    Log.
  - Update `research/options/common/stop-check-mode.md` (a new page) in the same commit.
  - Put any platform-setting change to the owner.
- **Deliverables:** the verdict, the research page, and the owner's decision.
- **Done when:** the Log has the verdict and the decision, and the item is Done.

## Risks

- **The MTM-tick bound is too pessimistic**, so ④ looks worse than Quantiply really does. The
  model check catches this; the fix is a tighter bound, logged as a new dated rule.
- **Few MTM-stop days.** If the overall stop rarely binds, ③ − ④ is zero on most days and 60
  days decide little. Report how many days each check changed anything; extending the window
  is a dated rule change, not a quiet one.
- **The BL-141 capture misses days**, so the model check has fewer than 60 days. Report its own
  n, and fall back to "not decided" under 30.
- **Selection tilt towards ③** (Context) is real in-sample. Forward, all four use the same
  picks, so the comparison is fair, but the absolute levels are still those of picks chosen
  on ③.

## Open questions

1. Which book did the in-sample table use: Adaptive Core (list C), T1, or the fixed base? Was
   it one lot per pick, and over which dates?
2. Does Quantiply (and AlgoTest) let a strategy check its leg SL or overall MTM on the candle
   close instead of the tick? If neither does, the MTM verdict is informative only.
3. How was "significantly worse" computed: the bootstrap above, a t-test, or something else?
4. Should T1 get the same 16:00 line, or Core only?

## Log

- 2026-10-23 — created from the owner's four-combination comparison; status Planned, P1.
