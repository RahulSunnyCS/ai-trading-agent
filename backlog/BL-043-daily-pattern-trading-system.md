# BL-043 — Daily pattern trading system: scored entries, stop-loss, target, a health switch

| | |
|---|---|
| **Priority** | P2 — this month's goal is Momentum with real money (BL-010, BL-024, BL-025); this is the next research line, separate from it |
| **Status** | In progress |
| **Type** | research |
| **Area** | momentum (the `patterns/` module; a separate sleeve, not the momentum ranking) |
| **Created** | 2026-10-07 |
| **Depends on** | BL-042 (detectors, quality and learned scores, hold-out guard); BL-015 (pre-registration); BL-025 before any real money |
| **TODO.md row** | [§3.21](../TODO.md) |

## Context

BL-042 tested chart patterns as a tweak to the Broad Momentum ranking and killed all three. The
event study found no excess over momentum-matched peers, and the ranking test had a PBO of 0.57
over 24 trials. The owner then asked where that test entered a trade. It entered at a Friday
close in any detected week (mostly while the base was still forming), with no stop and no
target. The ranking test bought a week later still and exited on momentum rank. Neither is how a
pattern trader works.

An exploratory per-stage breakdown (BL-042 Log; post-hoc, 27 looks, not evidence) found:
- breakouts bought at the next Friday close earned nothing;
- buying the pullback inside a tight range or flag near the highs beat momentum peers by
  +3.3% (13 weeks, t 2.7) and +2.2% (4 weeks, t 3.1).

**The owner's idea (2026-10-07):** treat patterns as their own system, separate from momentum.
- **Learn from history:** for each pattern, how often it worked, and which entry, stop-loss
  and target worked best. Also whether the stock was above or below its 50-day average.
- **Daily scan:** at every close, score each possible entry 0–100 and enter the best ones
  above a cut-off. Check the stop-loss and target every day, and exit at the close when either
  is hit.
- **Timing rule:** usually enter on Friday at a score of 70+; enter midweek only at 83–85+.
- **Health switch:** if patterns have mostly failed over the last 60 days, stay in cash.

**Owner's answers (2026-10-07):**
- **Fills:** the next day's open. A scan after the close cannot act at that close. The
  same-day close is reported as the optimistic case.
- **The Friday rule** is one tested option, not built in.
- **Sizing:** at most 10 open trades, 10% each, ₹5 lakh capital.

**Assessment given to the owner:**
- **The risk is overfitting.** Learning the best entry, stop and target over many combinations
  is how backtests fool people (BL-010's best configs lost 22–25 points when tested properly).
  Every choice comes from a small grid fixed in Phase 0, is selected year by year on earlier
  data only, passes a PBO check, and gets one run on the sealed 2024–26 hold-out.
- **Difficulty: medium.** Detection, scores, guards and the walk-forward/PBO machinery exist in
  `momentum_backtesting/patterns/`. The new piece is a daily trade simulator.

## Goal

A pre-registered answer to whether a daily, scored, pattern-based swing system makes money after
costs and beats the Nifty 500 TRI and cash on 2024–26 data no step was tuned on. If it does,
3–6 months of live paper tracking follows before the owner decides on real money.

## Out of scope

- Placing orders. Nothing in this repo trades; signals go to Telegram and the journal.
- Changing the Momentum ranking or its weekly signal.
- Intraday bars; options; shorting.
- Sending signals to anyone but the owner. Sharing them falls under SEBI's research-analyst
  rules (`business.md`).

## Plan

### Phase 0 — Pre-register (committed before any run)
- **Tasks:** write `search_spaces/bl043_criteria.json` and an Experiments block. Fix each of
  these:
  - **Universe:** the point-in-time `turnover_rank` universe with the Broad tradability gate.
  - **Patterns:** tight range, flag, cup and handle, using BL-042's frozen detectors evaluated
    daily.
  - **Entry types (small grid):** breakout close above the pivot; pullback into the lower part
    of the base.
  - **Stops (small grid):** below the base low; 1.5× ATR; a fixed 8%.
  - **Targets (small grid):** 2R; 3R; none (trailing stop or time exit).
  - **Time stop:** 13 weeks.
  - **Features:** above or below the 50-day average, quality third, pattern state.
  - **Score:** 0–100 = the causal past success of similar setups (BL-042's learned-score
    machinery, extended).
  - **Cut-offs (small grid):** 60 / 70 / 80, plus the owner's Friday rule (70 on Friday, 83+
    midweek) as one option.
  - **Health switch:** off; on, with the 60-day success rate of closed trades below its
    long-run median meaning cash.
  - **Fills:** next open (primary); same close (reported).
  - **Costs:** itemised delivery costs plus 15 bps slippage.
  - **Sizing:** 10 slots × 10%, ₹5 lakh.
  - **Comparators:** Nifty 500 TRI, Nifty Smallcap 250 TRI, cash.
  - **Pass / kill rules:** walk-forward on 2012–2023 with a 13-week embargo; PBO ≤ 0.3; then
    one hold-out run. The hold-out bar is a CAGR at least 5 points over the Nifty 500 TRI after
    costs, a drawdown no worse than the index's, and positive returns in the majority of years.
  - **Trial count:** fixed and reported; keep it small.
- **Done when:** committed before any run.

### Phase 1 — Daily detection
- **Tasks:** run the detectors at every daily close, not only week ends. Record each candidate
  entry with its features, using bars up to that day only.
- **Deliverables:** a daily candidates table for 2012–2023; a truncation test at three cut dates.
- **Done when:** the truncation test passes.

### Phase 2 — Trade simulator
- **Tasks:** `patterns/trader.py`:
  - next-open fills (same-close option);
  - stop and target checked on daily closes;
  - a gap through the stop fills at that day's price, not at the stop;
  - time stop; max 10 positions at 10%; the best scores fill first; no re-entry while held;
  - itemised costs and slippage;
  - a trade log with MAE/MFE (worst dip and best gain while open).
- **Deliverables:** unit tests on hand-built price paths (stop hit, target hit, gap through the
  stop, time exit, full slots).
- **Done when:** the tests pass and a hand-checked trade matches.

### Phase 3 — Playbook from history
- **Tasks:** for every candidate, the outcome under each stop/target choice. Per pattern ×
  features, record the win rate, average R, and MAE/MFE spread. Stops and targets are chosen
  from the grid **on earlier years only**, year by year.
- **Done when:** the causal playbook table exists for every walk-forward year.

### Phase 4 — Entry score
- **Tasks:** score 0–100 per candidate from the playbook as known on that day. Check that it is
  calibrated (do higher scores win more often, on years not used to build it?).
- **Done when:** a calibration table is recorded.

### Phase 5 — Rules test on 2012–2023
- **Tasks:** cut-offs, the Friday-rule option and the health switch, through the simulator.
  Walk-forward picks, joined years, PBO over all trials. Report against the comparators.
- **Done when:** pass or kill recorded; if pass, one rule set chosen by the pre-registered pick.

### Phase 6 — Hold-out (one run)
- **Tasks:** the chosen rule set on 2024-01-01 → the latest bar, once, through a claim-first
  runner like BL-042's.
- **Done when:** recorded; nothing tuned afterwards.

### Phase 7 — Live paper tracking
- **Tasks:** a scheduler job after the daily stock-data sync scans, scores and sends the ranked
  entries, stops and targets to Telegram. Each signal goes into a journal (BL-024 style); track
  for 3–6 months.
- **Done when:** the owner decides on real money under BL-025's rules.

## Risks

- **Overfitting the playbook.** Many knobs across stops, targets, entries, cut-offs and
  features. Defences: the small fixed grid, walk-forward, PBO, one hold-out run.
- **A short hold-out.** 2024–26 is under three years, so a pass is suggestive. Paper tracking
  carries the rest.
- **Small-cap costs and gaps.** Next-open fills and gap-through-stop fills are in the simulator
  from the start.
- **Data:** the daily stock sync runs on Fridays today. Daily live use needs a daily sync
  (BL-012 scheduler).

## Open questions

Answered when the owner started the item (2026-10-07):

1. **Patterns:** tight range and flag only. Cup and handle can follow if these work.
2. **Health switch:** cash when the 60-day win rate is below its own long-run median (expanding,
   up to that day).
3. **Stop and target:** they trigger on the day's low and high, like a GTT order. A fill is at
   the stop or target price, or at the open when the day gaps through it. When both are touched
   on the same day, the stop is assumed first.
4. **Branch:** `feat/bl-043-daily-patterns`, stacked on PR #100 (BL-042) and retargeted to
   `main` once #100 merges.

## Experiments

### 2026-10-07 — Daily tight-range and flag swing system, scored entries, GTT-style exits
- **Hypothesis:** entering tight ranges and flags (breakout or pullback) at the next open,
  filtered by a causal score of how similar setups paid before, and exited by a stop, target or
  65-session time limit, makes money after costs and beats the Nifty 500 TRI.
- **Universe:** the point-in-time `turnover_rank` members each year, with ₹30 and ₹2 cr
  median-turnover gates on the signal day (sources: `turnover_rank_members_by_year`,
  `bars_1d_stock`).
- **Look-ahead check:**
  - signals use bars up to the signal day's close; fills are at the next open;
  - stops and targets are known at the signal;
  - scores and the health switch use only candidates already exited before the signal day;
  - a truncation test at three cut dates.
- **Pass / kill rule:** `packages/momentum-backtesting/search_spaces/bl043_criteria.json`.
  - Stage A, trade level: per pattern, 2 entries × 3 stops × 3 targets, walk-forward over
    2015–2023, PBO ≤ 0.3.
  - Stage B, portfolio: 3 cut-offs × health switch on/off, PBO ≤ 0.3, joined walk-forward CAGR
    above the Nifty 500 TRI.
  - Hold-out: at least 5 points over the Nifty 500 TRI, a drawdown no deeper than the index's,
    and beating it in at least 2 of 2024, 2025 and 2026. 42 trials in all.
- **Hold-out:** development data ends 2023-12-29; the unseen period is 2024-01-01 → the latest
  bar, one run.
- **Will not run:** any read of 2024 or later before Phase 6; anything outside the grids; a
  second hold-out run; cup and handle.
- **Result:** (after the run)

## Log

- 2026-10-07 — created from the owner's plan after BL-042 closed. Owner's answers recorded
  above (next-open fills, the Friday rule tested as an option, 10 × 10% of ₹5 lakh).
- 2026-10-07 — started. Owner's answers recorded under Open questions. TODO §3.21 added. Phase 0
  next.
- 2026-10-07 — Phase 0: `search_spaces/bl043_criteria.json` and the Experiments block committed
  before any run. Search is staged to keep the trial count small (42): trade-level stop/target/
  entry first, then the portfolio's cut-off and health switch.
- 2026-10-07 — Phase 1 done: `mbt swing candidates` (`patterns/swing/candidates.py`).
  - Daily-window forms of the BL-042 rules.
  - The flag check refactored into `flag.flag_at`; the weekly output was verified identical
    (686/686 flags on synthetic data) and BL-042's tests still pass.
  - Truncation test at three cut dates.
  - Development candidates (1,578 point-in-time symbols):

    | Pattern | Entry | Signal days | Bases |
    |---|---|---|---|
    | Tight range | Pullback | 8,131 | 2,408 |
    | Tight range | Breakout | 1,752 | 1,618 |
    | Flag | Pullback | 5,681 | 2,065 |
    | Flag | Breakout | 697 | 697 |
