# BL-156 — Overall MTM stop: check it on every tick, or only at the 1-minute candle close?

| | |
|---|---|
| **Priority** | P1 — it decides how the live platforms should be set, and how far paper overstates live |
| **Status** | Done (2026-10-23): keep leg stops on tick; the MTM rule makes no significant difference |
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

### Phase 0 — Amendment 1 (2026-10-23, before any run): leg stop × MTM stop, four combinations

Owner (2026-10-23, after reading the Result): "do the permutation of both … leg candle close or tick,
MTM candle close or tick … four combinations of T1, and tell if there is a significant edge". The
original Phase 0 and its verdict stand; this adds a second, separately registered question.

- **Hypothesis (two-sided):** at least one combination's mean daily net differs from today's live
  setting (④ below).
- **The two switches:**
  - **Leg stop at candle close:** each leg's stop is checked against the 1-minute **close** (sell:
    close ≥ stop; buy: close ≤ stop), and the leg exits at that close. The trail moves on closes.
  - **Leg stop on tick:** the engine as it is (the bar's high/low; fill at the stop, or at the open
    on a gap).
  - **MTM stop:** "close" and "tick" exactly as in Phase 0 (tick: two index-driven scenarios, 2%
    overshoot, open on a gap; never fires with no leg open).
  - Re-entries (RE COST) and targets keep the engine's rule in all four combinations.
- **Order within a minute when the leg stop is at candle close:** the tick MTM check runs first,
  inside the minute, then the leg checks at the close, then the close MTM check. With leg stops on
  tick, the engine's order holds: legs, then MTM.
- **The four combinations:**
  - ① leg close + MTM close;
  - ② leg close + MTM tick;
  - ③ leg tick + MTM close (paper today);
  - ④ leg tick + MTM tick (Quantiply live today).
- **Universe, period, money:** as in Phase 0. T1's Adaptive picks, 2025-01-10 → 2026-10-22, 1 lot a
  pick, brokerage ₹20 + GST per order. Core is reported, not deciding.
- **Parity check:** ③ must reproduce every stored result, as Phase 2 did.
- **Pass rule:**
  - **The three tests:** ① − ④, ② − ④ and ③ − ④, each as the mean daily Δ. Two-sided bootstrap
    p-value from 2,000 circular 5-session-block resamples, p = 2 × min(share ≤ 0, share ≥ 0).
  - **Holm across the three at α = 0.10** (a 90% interval, as in Phase 0).
  - **Read-out:** a combination that passes is a **significant edge** over today's live setting;
    otherwise there is no significant edge.
  - **Also reported:** all six pairwise differences, the two main effects (leg: mean of ① − ③ and
    ② − ④; MTM: mean of ① − ② and ③ − ④), per-combination total, worst day and maximum drawdown,
    half-years, and the 0% / 5% overshoot sensitivity.
- **Platform note (not part of the test):**
  - **Quantiply:** checks leg stops and the MTM stop on LTP and has no candle-close option for
    either, so ① – ③ are not settable there.
  - **AlgoTest:** its Candle Close monitoring covers the overall stop. Whether it covers premium leg
    stops is unclear.
- **Will not run:** other stop levels, per-family or per-index choices made after seeing results,
  5-minute candles for the leg stop.

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

**T1's Adaptive picks, 1 lot a pick, 2025-01-10 → 2026-10-22 (431 days; the rules differ on 126):**

| Rule | ₹ / day net | Total | Worst day | Max drawdown |
|---|---|---|---|---|
| Candle close (paper today) | **+1,526** | +6,57,708 | −14,092 | **−25,806** |
| Tick, 2% overshoot (live today) | +1,466 | +6,31,635 | **−12,896** | −29,367 |
| **Close − tick** | **+60**, 90% [−14, +149] | +26,073 | | |

- **By half-year (close − tick, ₹ / day):** 2025H1 +57, 2025H2 −23, 2026H1 +156, 2026H2 +53.
- **Verdict under the registered rule: the interval includes zero, so there is no meaningful
  difference; keep live as it is.**

**Sensitivity (reported, not deciding), close minus each:**

| Comparison | T1 | Core |
|---|---|---|
| Tick, no overshoot | +38 [−36, +132] | +13 [−64, +109] |
| Tick, 5% overshoot | +95 [+20, +187] | +83 [+10, +175] |
| Pessimistic tick (every leg at its extreme at once) | +254 [+92, +463] | +385 [+225, +561] |
| 5-minute close | +43 [+9, +79] | −16 [−80, +42] |
| Tick, 2% overshoot (Core's headline) | — | +41 [−33, +133] |

Core: close +₹917 against tick +₹876 a day; max drawdown −₹38,572 against −₹36,603.

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

## Result, Amendment 1 (2026-10-23): keep leg stops on tick; the MTM rule does not matter

T1's picks over 431 days, 1 lot a pick. The paper combination ③ reproduced every stored result.

| Combination | ₹ / day | Total | Worst day | Max DD | vs live ④, 90% [interval], Holm |
|---|---|---|---|---|---|
| ① Leg close + MTM close | +1,112 | +4,79,168 | −13,660 | −33,413 | **−354** [−526, −180], **significantly worse** |
| ② Leg close + MTM tick | +1,021 | +4,40,125 | −12,570 | −34,211 | **−444** [−619, −272], **significantly worse** |
| ③ Leg tick + MTM close (paper) | **+1,526** | **+6,57,708** | −14,092 | **−25,806** | +60 [−14, +155], not significant |
| ④ Leg tick + MTM tick (live) | +1,466 | +6,31,635 | −12,896 | −29,367 | — |

**Verdict under the registered rule:**
- ① and ② are **significantly worse** than live, so there is no significant edge over it.
- ③ does not differ from it.

**Main effects (T1, ₹ / day):**
- **Leg stop, close − tick: −429** [−588, −270], in every half-year (the leg-close combinations sit
  −121 to −638 a day below live).
- **MTM stop, close − tick: +76** [−0, +172], p 0.10: borderline, not significant.

**Where the leg-close loss comes from** (T1, ① − ③, descriptive):

| Family | Picks | Total | Per pick |
|---|---|---|---|
| Dir (21% stop) | 363 | −₹79,833 | −₹220 |
| Widesl | 930 | −₹88,459 | −₹95 |
| Buy | 52 | −₹10,248 | −₹197 |

A stop checked at the minute's close exits after the option has run through the stop, so the fill
is worse. That cost is larger than the losses saved on spikes that come back.

**Core (reported):** no significant difference from live. Leg close − tick main effect −182
[−317, −46]; MTM +31 [−47, +125]. ① −152, ② −172, ③ +41.

**What it means for the platforms:**
- **Leg stops:** keep them on tick (LTP), as Quantiply and AlgoTest do now. Do **not** switch them to
  candle close.
- **The overall MTM stop:** the candle close is slightly ahead but not proven. Switching it is
  optional and would only be possible on AlgoTest.
- **If AlgoTest's "Candle Close" monitoring also moves premium leg stops to candle close,** it would
  cost more on the legs than it gains on the MTM. Check this before ever turning it on.

**Evidence:**
- `research/bl156/rules.py` (`leg_rule`), `replay4.py` and `test_rules.py` (8 tests);
- `out/result4.json` and `out/sims4.json` (git-ignored; regenerate with `replay4.py`).

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
- 2026-10-23 — Phase 2 run. The calibration passed. **T1: close − tick +₹60 / day, 90% [−14, +149]:
  no meaningful difference**, so keep live as it is. Core +₹41 [−33, +133]. Close is clearly better
  under a 5% overshoot or the pessimistic model (Result). Item closed.
- 2026-10-23 — self-review fix: the tick model now never fires once every leg is closed (it had
  replaced a realised loss beyond the stop with −stop × 1.02, which flattered tick). Re-run: T1 +₹60
  [−14, +149] (was +₹56), Core +₹41; the verdict is unchanged. Numbers above are the corrected run.
- 2026-10-23 — Amendment 1 registered before any run: leg stop (candle close / tick) × MTM stop
  (candle close / tick), four combinations on T1, Holm over the three comparisons with today's live
  setting.
- 2026-10-23 — Amendment 1 run. On T1, the leg-close combinations are significantly worse than live
  (① −₹354, ② −₹444 a day); paper (③) +₹60 is not significant. Leg stop close − tick −₹429 a day in
  every half-year; MTM close − tick +₹76, borderline. Core: no significant difference. Recommendation:
  keep leg stops on tick; the MTM rule is optional (AlgoTest only), and check first whether AlgoTest's
  Candle Close mode also moves leg stops. Item closed.
