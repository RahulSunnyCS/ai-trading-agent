# BL-156 — Overall MTM stop: check it on every tick, or only at the 1-minute candle close?

| | |
|---|---|
| **Priority** | P1 — it decides how the live platforms should be set, and how far paper overstates live |
| **Status** | Done: no meaningful difference — keep live as it is (2026-10-23) |
| **Type** | research |
| **Area** | options (rotation, Quantiply, AlgoTest) |
| **Created** | 2026-10-23 |
| **Depends on** | none (stored results, the lake, the legwise engine) |
| **TODO.md row** | 3.10.40 |

## Context

On 2026-10-23, Core's `N_p100_1217` (closest-premium ₹100 Widesl, ₹2,500 overall MTM stop) **stopped
out live at 13:45:04 for −₹2,554 but made +₹1,053 on paper.** The Angel One trade book shows the same
strikes and nearly the same entry: sold 22600 CE at 109.15 and 22400 PE at 102.05, against paper's
108.50 and 102.55. Both legs were bought back together at 13:45:04 (194.75 / 55.75).

NIFTY spiked from 13:37 to 13:45, and the CE went from 101 to 196. **Paper checks the overall stop
only at each 1-minute bar's close** (`legwise/engine.py`: "combined MTM … at each bar's CLOSE"). Its
worst close was −₹2,161 at 13:44, and 13:45 closed after a pullback (CE 169.2). **Quantiply checks
every tick.** At 13:45:04 the CE traded at about 195, its minute high was 195.9, and the stop fired.
The CE then fell back (121.8 by 15:28).

Over the last 12 months of paper Widesl results, about 4.9% of strategy-days came within ₹500 of the
stop at a minute close without hitting it. 483 of those ended positive on paper (average +₹888).

**The owner's question (2026-10-23):** using T1, should Quantiply and AlgoTest close **only on a
candle close** (as paper does), or **at the impulsive moment** (tick, as live does now)?

**Which way it cuts is not obvious:**
- **Candle close** rides through spikes that revert, as on 23 Oct, but can exit later and deeper on a
  real breakout.
- **Tick** caps every loss near the stop, but gets shaken out by spikes.

## Goal

A verdict, on T1's own picks, on which check earns more after charges. It also gives an estimate of
how much paper (close) overstates live (tick).

## Out of scope

- Changing the stop amount, the leg stops or the trail.
- Changing any platform setting. That needs a separate decision, and the platforms must support a
  candle-close MTM check at all (open question 1).

## Plan

### Phase 0 — Pre-register (committed 2026-10-23, before any run)

Owner's request (2026-10-23): "analyze through T1 whether we need to update Quantiply and the
algorithms so that we close only when there is a candle close, or at the impulsive moment".
Everything below is Claude's proposal, recorded before any run.

- **Hypothesis (two-sided):** for T1's Adaptive picks, the mean daily net P&L differs between
  checking the overall MTM stop at each 1-minute candle close and checking it on every tick.
- **Universe:**
  - **Picks:** T1's Adaptive picks (list C over Core-298 + `strategies/rotation_t1/`):
    - from **2026-10-19**, the T1 journal's recorded picks;
    - **before that**, picks reconstructed day by day with `rotation.pick.score_history` from the
      stored results before each day, without the BL-122 expiry rule (as reconstructed history
      always is).
    - Each core pick plus any Buy add-on is traded at **1 lot**, in the strategy's own file.
  - **Strategies affected:** only those with an overall `stop_loss_inr`. Any other strategy is
    identical under both rules and counts as Δ = 0.
  - **Reported, not deciding:** Core's Adaptive picks, the same way.
- **The two rules, per strategy-day, on the same 1-minute data and engine** (`legwise.engine`, the
  stored results' sizing date):
  - **Close (candle):** the engine as it is. The stop is checked at each bar's close, and on a hit
    every open leg exits at that close.
  - **Tick (impulsive), modelled:** there are no ticks, so each minute's high and low stand in for
    the path.
    - **Two index-driven scenarios per minute:** the index at the minute's high (calls at their high,
      puts at their low) and at its low (calls at their low, puts at their high).
    - **Firing:** if the worse scenario's combined MTM (realised + open legs) is at or below
      −stop, the stop fires in that minute.
    - **Day result:** −stop × **1.02**, the overshoot seen live on 23 Oct (−₹2,554 at a ₹2,500
      stop). If the combined MTM at the minute's **open** is already at or below −stop (a gap), the
      day result is that open MTM instead.
    - Legs that entered intrabar that minute count at the close. Leg stops are processed as the
      engine does, before the MTM check.
- **Calibration check (before the comparison):** the tick model must fire `N_p100_1217` on
  2026-10-23 at **13:45**, and the close model must not fire it. If not, the model is wrong: stop
  and report.
- **Money:** gross from the engine minus brokerage of ₹20 + 18% GST per order, 2 orders × the day's
  trades (BL-135's model; the order count is the same under both rules unless a stop changes the
  trades). STT and exchange fees are left out, as in the rotation store. No slippage beyond the
  stop overshoot.
- **Look-ahead check:**
  - Both rules read only bars up to the minute being decided.
  - The pick for day `t` uses stored results before `t` (`score_history`), so neither rule's
    result can feed back into its own picks.
  - A unit test on a synthetic day: the tick model fires at the first minute whose
    high-scenario crosses the stop and ignores later bars; the close model fires only on a close
    crossing.
- **Pass / kill rule:**
  - **Period:** 2025-01-10 (after the 63-day warm-up) → 2026-10-22, all of it, as one period.
  - **Measure:** the mean daily Δ = close − tick (₹ per day, the T1 book at 1 lot per pick), with a
    90% block-bootstrap interval (5-session blocks, 2,000 resamples).
  - **Interval above 0:** candle close is better; recommend switching the platforms to it if they
    support it.
  - **Interval below 0:** tick is better; keep live as it is, and correct paper toward tick.
  - **Interval includes 0:** no meaningful difference; keep live as it is (tick, the platforms'
    default).
  - Also reported for both rules: the number of days the two rules differ, the total, the worst day
    and the maximum drawdown. Results are split by half-year so one episode cannot hide.
- **Hold-out:** none; the forward T1 journal days are inside the period. This is a choice between
  two execution rules, not a new strategy, and the verdict is read once.
- **Sensitivity (reported, never deciding):**
  - overshoot 0% and 5%;
  - a pessimistic intrabar model (every short leg at its adverse extreme at once);
  - a **5-minute** candle close;
  - Core's Adaptive picks.
- **Will not run:** other stop amounts, other lists, per-strategy rule choices (choosing close for
  some families and tick for others after seeing the results). Running one needs
  `override: <reason>` in the Log.

### Phase 1 — The two rules
- **Tasks:** `packages/option-backtesting/research/bl156/`:
  - a `_DaySim` subclass that adds the tick check (the engine itself is unchanged);
  - the calibration check;
  - the unit test.
- **Done when:** the calibration passes and the test passes.

### Phase 2 — Replay T1 (and Core)
- **Tasks:** reconstruct the picks, simulate every affected pick-day under both rules, and compute the
  measure and the sensitivity.
- **Done when:** the verdict is recorded here.

### Phase 3 — Write-up
- **Tasks:**
  - Result and Log here; INDEX and TODO;
  - `research/options/strategies/widesl/mtm-sl.md`;
  - a note in `research/options/common/` on how far paper overstates live.
- **Done when:** merged with a code-review result on the PR.

## Result (2026-10-23): no meaningful difference

**Calibration passed.** On 2026-10-23, `N_p100_1217`:
- **tick model:** fires at **13:45**, −₹2,550 (live: 13:45:04, −₹2,554.50);
- **close model:** does not fire, +₹1,053 (the stored paper result exactly).

The close rule reproduced every stored result (0 mismatches over 2,271 strategy-days).

**T1's Adaptive picks, 1 lot a pick, 2025-01-10 → 2026-10-22 (431 days; the rules differ on 124):**

| Rule | ₹ / day net | Total | Worst day | Max drawdown |
|---|---|---|---|---|
| Candle close (paper today) | **+1,526** | +6,57,708 | −14,092 | **−25,806** |
| Tick, 2% overshoot (live today) | +1,470 | +6,33,626 | **−12,896** | −29,367 |
| **Close − tick** | **+56**, 90% [−17, +143] | +24,082 | | |

- **By half-year (close − tick, ₹ / day):** 2025H1 +57, 2025H2 −28, 2026H1 +144, 2026H2 +53.
- **Verdict under the registered rule: the interval includes zero, so there is no meaningful
  difference; keep live as it is.**

**Sensitivity (reported, not deciding), close minus each:**

| Comparison | T1 | Core |
|---|---|---|
| Tick, no overshoot | +33 [−41, +127] | +11 [−67, +106] |
| Tick, 5% overshoot | +90 [+14, +183] | +81 [+8, +174] |
| Pessimistic tick (every leg at its extreme at once) | +250 [+86, +460] | +383 [+221, +559] |
| 5-minute close | +43 [+9, +79] | −16 [−80, +42] |
| Tick, 2% overshoot (Core's headline) | — | +39 [−35, +131] |

Core: close +₹917 against tick +₹878 a day; max drawdown −₹38,572 against −₹36,388.

**Reading:**
- **The candle close leans ahead but is not proven.** It rides through spikes that come back, as on
  23 Oct, and so ends higher in three of four half-years.
- **Tick caps the worst day better** (−₹12.9k against −₹14.1k on T1), but its drawdown is deeper.
- **The size of the overshoot matters.** At 5%, or if the stop fires as often as the pessimistic
  model, the candle close is clearly better. The forward live captures (BL-141's `live-compare`)
  will show the real overshoot.
- **How far paper overstates live:** about ₹40–55 a day for the book, so roughly 3–4%. That is the
  close − tick gap.

**Platforms** (checked 2026-10-23, read-only):
- **AlgoTest:** has "Trade monitoring: on LTP / on Candle Close" in the deploy sheet (1-minute; the
  overall stop is checked at candle close in that mode) (`docs/algotest-execution.md`, AlgoTest's
  "candle close implementation" blog).
- **Quantiply:** no candle-close mode for the overall stop (`stoploss: TOTAL_AMOUNT` only). Its
  candle-close switches cover re-entry and "journey" only.

**Evidence:** `packages/option-backtesting/research/bl156/`:
- `rules.py` (the engine's day loop with the stop check switched), `replay.py`, `test_rules.py`
  (5 tests, including the 23 Oct calibration);
- `out/result.json` and `out/sims.json` (git-ignored; regenerate with `replay.py`, about 10 minutes
  with 6 workers).

## Risks

- **High/low is not the tick path.** The two-scenario model assumes the calls' high and the puts'
  low happen together (an index-driven move). This holds for a spike; it is less exact for a
  volatility jump that lifts both legs. The pessimistic model brackets it.
- **The 2% overshoot is one day's figure.** The 0% and 5% sensitivities bracket it.

## Open questions

1. Do Quantiply and AlgoTest support evaluating the overall MTM stop on candle close at all? Check
   before acting on a "close" verdict.

## Log

- 2026-10-23 — created from the 23 Oct live stop on `N_p100_1217` and the owner's request. Phase 0
  committed before any run.
- 2026-10-23 — owner, while it was being built: it matters whether the platforms can be told to check
  on candle close when the strategies are created. Checked: AlgoTest yes (deploy sheet), Quantiply no.
- 2026-10-23 — Phase 2 run. The calibration passed. **T1: close − tick +₹56 / day, 90% [−17, +143]:
  no meaningful difference**, so keep live as it is. Core +₹39 [−35, +131]. Close is clearly better
  under a 5% overshoot or the pessimistic model (Result). Item closed.
