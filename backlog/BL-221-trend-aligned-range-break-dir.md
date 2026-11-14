# BL-221 — Trend-aligned range-break Dir: sell one leg, only with the higher-timeframe trend, only after the morning range breaks

| | |
|---|---|
| **Priority** | P2 — the owner's idea (2026-11-15); the nearest earlier tests (BL-152, BL-083 pivot-with-trend) mostly killed or did not hold out of sample, so low prior odds, but cheap to test on the engine we already have |
| **Status** | In progress (Phase 0 amended and answered 2026-11-15; Phase 1 building; nothing run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-15 |
| **Depends on** | the legwise engine's `range_breakout` (underlying source), BL-120 rule tester (events vs placebo, ledger), BL-058 (the fixed base Dir leg as the comparator) |
| **TODO.md row** | 3.11.30 |

## Context

Today's Dir ([page](../research/options/strategies/directional/README.md)) sells **both** an ATM (or ITM1)
call and put at a fixed minute (09:24 for the base), each with a 21% leg stop and one re-entry at cost. It
takes no view: it is a short straddle that keeps the surviving leg when the market moves.

The owner's idea (2026-11-15), in their words made precise:

1. Do **not** enter at a fixed minute. Wait for the morning range to break: mark the high and low of
   **09:17 to 10:00** on the index, and take a trade when the high or the low is broken.
2. Take only the break that agrees with a **higher-timeframe trend**. The owner's example: hourly candles,
   20 EMA above 50 EMA = up-trend, so only up-breaks are taken (and the reverse for a down-trend). The owner
   was unsure of the timeframe ("hourly should be fine").
3. When it triggers: **ATM, leg stop 21%**, and **re-entry once when the price comes back to cost**, as Dir
   does today. The owner first said a ₹2,000 stop and withdrew it: no overall rupee stop in the first
   version.

So the change from Dir is three things at once: one leg instead of two, entry on a break instead of at a
clock minute, and a trend gate on which side may trade. Which leg to sell is not stated (see open question 1).

### What the repo already knows (checked 2026-11-15, per the research-pages rule)

- **Breakout entries have been tested and mostly killed.** BL-152 (NIFTY 5-minute breakout, hold, 1-minute
  entry, 192 variants): none passed (best t 1.65, PBO 0.51); **selling the opposite side was the best trade
  type (+₹59 a trade, not distinguishable from zero), buying lost**. BL-164 (gap-and-go opening-range band):
  killed. BL-124 (opening-range break of the straddle): killed. BL-153: confirmation by Bank Nifty / IT /
  Reliance added nothing.
- **A trend gate on a Dir entry has a mixed record.** BL-083 "pivot with trend" → Dir: +₹754 per lot (t 3.5) on
  the explore years, **−₹20 (t −0.1) on the 2022–24 confirmation**: the edge appears from mid-2024 and is
  regime-dependent. BL-081 found no state variable (including trend since open ÷ ATR) that holds in all
  three periods.
- **Waiting helps Dir.** BL-053: a later start (10:00) lifted Dir from ₹56,583 to ₹96,628 in that year, and
  most of it was the later start, not the VIX switch. A 10:00 break entry inherits some of that for free,
  which the study must separate from the break and the trend.
- **Dir's own knobs are mapped:** 21% is the weakest shortlisted leg stop (25–30% did better after charges),
  re-entry at cost ×1 is net-neutral, an overall stop costs more than it saves (BL-105). The first version
  keeps the owner's 21% / ×1 and varies none of them.
- **Engine support exists.** `legwise/schema.py` already has `range_breakout: {until, side: high|low,
  source: underlying, gap_percent, valid_until}` (the Buy family uses it). What it does not have is a
  per-day trend gate; the gate is a day filter computed outside the engine (see Phase 1).

## Goal

Know, on the same days and after the same charges and slippage, whether (a) a one-sided trend-aligned break
sale beats the base Dir leg as traded, and (b) the trend gate adds anything over the same break taken in
both directions. A positive answer is only a candidate for a forward paper track (the BL-219 pattern), not a
live strategy.

## Out of scope

Buying options (BL-152 and BL-164 already show the buy loses; a one-line variant only if the owner asks),
any live order or upload, any change to the Rotation lists or Adaptive's ranking, stock options, MCX, tuning
the 21% stop, re-entry count or exit time, and any intraday EMA timeframe other than the registered ones.

## Plan

### Phase 0 — Pre-register (draft: to be confirmed with the owner before any run)

- **Hypothesis:** selling the option **opposite** to the break (sell PE on an up-break, CE on a down-break),
  only when the higher-timeframe trend points the same way, earns more per lot-day after charges and 0.5%
  slippage than the fixed-minute two-leg base Dir, and more than the same break taken regardless of trend.
- **Rule (draft, frozen on confirmation):**
  - Index: NIFTY first; SENSEX second only if NIFTY clears the rule (open question 3).
  - Range: index 1-minute high and low over **09:17–10:00**. Breaks count from 10:01 (strictly after the
    range closes: no minute that also forms the range), valid until a registered cut-off (open question 4).
  - Trend state, point in time: hourly bars built from index 1-minute bars **completed before 10:00**
    (so the latest one is the previous session's 14:15–15:15, plus the 15:15–15:30 stub kept out); **up** =
    EMA(20) > EMA(50) of hourly closes, **down** = below. "Crossing" is read as the **state** after the
    cross, not the cross event, which would fire on a handful of days a year (open question 2).
  - Trade: one lot, sell ATM weekly option opposite to the break, leg stop 21%, re-entry once at cost
    (`reentry_on_sl: {mode: cost, count: 1}`), exit 15:28 with partial square-off, no overall stop.
    ATM taken at the break minute from the index price then.
  - One trade a day; a day with no break, or a break against the trend, is a no-trade day (₹0, counted).
- **Comparators (all on the same days, same charges, 0.5% slippage and 1%):** (1) the fixed base Dir leg
  `N_dir_atm_0924` as traded; (2) the same two-leg Dir started at 10:01 (isolates "later start"); (3) the
  break taken in **both** directions with no trend gate (isolates the gate); (4) the same trade with a
  **placebo trend** (random up/down state with the real up/down frequency, 1,000 draws, via the BL-120
  rule tester) and a random-minute entry; (5) the trend-aligned break **bought** instead of sold, reported
  only, never a candidate.
- **Universe and look-ahead:** every NIFTY session with collected 1-minute option bars (2024-10-09 → latest,
  ~490 sessions) with `data_quality` usable; the expiry used is that session's weekly. EMA state uses only
  bars ended before 10:00; EMA(50) needs about 8 sessions of hourly bars, so the first 8 sessions are not
  scored. The break uses the 1-minute bar's close, filled at the next minute's open (the engine's
  convention for the underlying range break; confirm in Phase 1 and record it). The trend state is shown
  against a shifted-by-one-session placebo to prove it carries no future bar.
- **Pass / kill rule (proposed):** the candidate must (i) beat comparator 1 and comparator 3 by a 90%
  block-bootstrap interval that excludes zero in ₹ per lot-day after 0.5% slippage on the fit window;
  (ii) beat 95% of placebo-trend draws; (iii) hold the same sign in at least 3 of 4 quarters of the fit
  window and on the 2022-01 → 2024-10 confirmation (NIFTY vendor history, run once, only if (i) and (ii)
  pass); (iv) keep a maximum drawdown no worse than comparator 1's, since fewer trading days can hide risk.
  Anything else: killed. Every variant counted in the rule tester's ledger; the grid is the six below only.
- **Grid (registered, nothing outside it):** range window {09:17–10:00, 09:17–09:45, 09:17–10:30} × EMA pair
  {20/50 hourly, 20/50 daily} × valid-until {12:00, 14:00} = 12 cells, plus the 09:17–10:00 / hourly / 12:00
  cell with and without the trend gate. A trend EMA on 15-minute bars is a later, separate test.
- **Hold-out:** the fit window is 2024-10-09 → 2026-04-30; **2026-05-01 → latest is kept unseen** until the
  verdict is written; the 2022–24 confirmation is read once. Both are unread until a candidate passes the
  fit rule.
- **Will not run:** a stop other than 21%, more than one re-entry, a target, a trail, an overall rupee stop,
  ITM or OTM strikes, an EMA pair other than 20/50, buying as a candidate, SENSEX before NIFTY clears.
  Any of these needs `override: <reason>` in the Log.


### Phase 0 — Amendment 1 (2026-11-15, owner, before any run)

The owner accepted every recommendation made in the discussion and asked for the test over **the last two
years**. Answers, and what they change (the draft above stays; this supersedes it where they differ):

- **Direction (Q1):** sell the option opposite to the break (PE on an up-break, CE on a down-break). Accepted.
- **Trend (Q2):** the state (EMA 20 above EMA 50), not the cross event. Accepted.
- **Index (Q3):** NIFTY only; SENSEX only if NIFTY clears the rule. Weekly expiry of the session, every
  weekday. **Cut-off (Q4):** the registered {12:00, 14:00} grid. **Re-entry (Q5):** the engine's `cost`, once.
- **One trade a day (Q6):** the first break only; a later break the other way is skipped.
- **Overall stop (Q7):** none in the first version. The worst day and the worst week are reported beside every
  figure. A ₹3,000 stop is an `override:` only.
- **Break buffer:** none in the first version (`gap_percent` 0); range width is recorded per trade for a
  descriptive look afterwards, not used as a filter.
- **Window ("last 2 years"):** the fit window is **2024-10-09 → 2026-10-08** (the repo's learning period, the
  same two years `obt rule` calls always-open). This replaces the draft's 2024-10-09 → 2026-04-30 fit with a
  2026-05 hold-out: the owner wants the whole two years read. The unseen data that remains is **sessions after
  2026-10-08** (forward only, never read here) and the **2022-01 → 2024-10-08 NIFTY confirmation**, opened once and
  only if the fit passes. Reason for the change: the options data worth testing is these two years and a
  five-month hold-out inside them would leave too few trades; the older vendor years are the honest hold-out.
- **Entry mechanics (found reading the engine, 2026-11-15):** the legwise engine's `range_breakout` picks the
  strike at the leg's `entry_time` (09:17), not at the break, so an up-break PE sold at the break would be the
  09:17 ATM, not the ATM then. To sell the ATM at the break as the owner described, the runner computes each
  day's break from the index 1-minute bars itself: range = high and low over 09:17 to the range end (exclusive);
  the first bar after it whose **high exceeds the range high (low below the range low)** is the break bar; the
  trade enters at the **next minute** (the engine's `price_at` is the previous bar's close, so the fill is the
  close of the break bar: nothing after the decision) as an ordinary one-leg Dir (ATM from the index at that
  minute, 21% stop, re-entry at cost ×1, exit 15:28). Every trade is simulated by the verified engine
  (`simulate_day`); only the entry minute is chosen outside it. The range-end bar itself never breaks.
- **Costs:** ₹20 an order plus 18% GST (₹23.6) and 0.5% slippage on every fill as the primary reading, 1% and 0%
  beside it; `lot_sizing: current`.
- **Counted tests:** no rule-tester ledger (the tester does not support a per-leg range break); instead every
  cell run is listed in this item's Log with its count, and the grid above is the whole family (13 cells).


### Phase 0 — Amendment 2 (2026-11-15, before the full run; the 12-day smoke run read no results)

Declared so no choice is made after seeing numbers:

- **Primary cell:** range 09:17 to 10:00, **hourly** EMA 20/50, break valid until **12:00**. The pass rule
  (below, unchanged) is judged on this cell only. The other 11 cells (range end 09:45 / 10:30, daily EMA 20/50,
  cut-off 14:00) are sensitivity rows: a lead in another cell alone is not a pass.
- **Which break the trend takes:** the first break **in the trend's direction** (up-trend: the first bar whose high
  is above the range high; down-trend: the first bar whose low is below the range low). Breaks against the trend are
  ignored; one trade a day; no second trade after it, whichever way the market then moves. No-gate comparator
  (C3): the first break either way, a same-bar double break skipped.
- **Break bar and fill:** break bar = first bar after the range-end bar with high > range high (low < range low);
  entry = the next minute's engine fill (the break bar's close), ATM from the index close of that bar.
- **Placebo trend:** per day, up with probability = the share of up days in the fit window, down otherwise, 2,000
  draws, seed 20261115; the candidate must beat 95% of draws' mean net per day.
- **Bootstrap:** circular 5-day blocks, 2,000 resamples, seed 20261115, on the paired daily difference (candidate
  minus comparator, no-trade days = 0), 90% interval = 5th to 95th percentile; "excludes zero" = 5th percentile > 0.
- **"3 of 4 quarters" (pass rule iii)** is read literally: the fit days split into 4 equal consecutive blocks; the
  candidate's mean net per day is above zero **and** above C1's in at least 3 of the 4.
- **Per-day unit:** ₹ per strategy-day (one lot of the one-leg candidate; the base Dir is one lot of a two-leg
  strategy, as everywhere in the rotation). A per-leg figure (base ÷ 2) is printed beside it, descriptive only.
- **Buy variant (C5):** the same entry, buying the same-direction ATM with a 21% stop, no re-entry, reported only.
- **Cost:** ₹23.6 an order, 0.5% slippage primary, 0% and 1% beside it. Sessions the engine cannot run are left
  out of every series (listed in the result).

### Phase 1 — Trend state and the rule as code

- **Tasks:** build the point-in-time trend state (hourly resample of index 1-minute bars, EMA 20/50, the
  shifted placebo) in `packages/option-backtesting/research/bl221/trend.py`; write two legwise YAMLs
  (sell PE on `range_breakout side: high`, sell CE on `side: low`, `source: underlying`, ATM, 21%, re-entry
  cost ×1) and a runner that, per session, runs the YAML the trend selects; confirm the engine's break
  fill convention and that `until` / `valid_until` behave as written (golden-style check on three known
  days, by hand against the 1-minute bars).
- **Deliverables:** `research/bl221/` with the state builder, the runner and a look-ahead test that fails
  if any EMA input bar ends after 10:00.
- **Done when:** the runner reproduces the base Dir leg's stored results to the rupee on its own days, and
  the look-ahead test passes.

### Phase 2 — The registered grid on the fit window

- **Tasks:** run the 13 cells and the five comparators, the placebo draws and the bootstrap, all through
  the rule-tester ledger; judge only against the Phase 0 rule.
- **Deliverables:** a results table (₹ per lot-day, per trade, win rate, no-trade share, max drawdown) and
  the pass / kill verdict, written into this item's Log.
- **Done when:** the verdict is recorded and the findings pages are updated.

### Phase 3 — Confirmation (only if Phase 2 passes)

- **Tasks:** open the hold-out and the 2022–24 confirmation once; if both hold, propose a forward paper
  track in the BL-219 style (frozen rule, hash-chained journal, no orders) as a new item.
- **Deliverables:** the confirmation result, the findings pages, a proposal or a kill.
- **Done when:** the owner has read the verdict.

## Risks

- **Thin sample.** One trade a day on at most the days that break and agree with the trend: perhaps 25–35%
  of sessions, so 120–170 trades over the fit window. The rule judges per lot-day over all days so the
  no-trade days are counted, but the interval will be wide.
- **The gate is multi-day, not intraday.** EMA 20/50 on hourly bars spans roughly 3 and 7 sessions, so it
  is a multi-day trend filter. It may mostly track yesterday's direction; the shifted placebo and the
  comparator 3 are there to show whether it adds anything.
- **Regime dependence.** BL-083's pivot-with-trend Dir lead vanished on 2022–24. The confirmation is
  mandatory, and a lead that appears only from mid-2024 is a regime lead, not a pass.
- **Fewer trading days can look better than they are.** A break-only rule trades less; the drawdown and
  per-lot-day (not per-trade) readings guard against that.
- **Selling at the break is selling after a move.** On an up-break the PE premium has already shrunk and
  the CE has grown; a gap-up open already breaking the 09:17 range can trigger at 10:01 with an ATM that
  is far from the day's start. The first-version rule takes ATM at the break minute.
- **Overlap with BL-083 / BL-152 / BL-164** means the same days and the same few regimes decide again;
  every one of those was an in-sample exercise on this data.

## Open questions

To put to the owner when this is started (step 3 of the workflow), not settled now:

1. **Which leg is sold on an up-break?** I assumed the opposite option (sell PE on an up-break) because Dir
   sells and BL-152 found selling the opposite side the best trade type. If the owner meant selling the
   same-side option (sell CE into the up-break) or buying, the hypothesis changes.
2. **"20 EMA crossing 50 EMA"**: state (20 above 50) or the cross event only? The state is registered here;
   the event would trade on a few days a year.
3. **Index and expiry:** NIFTY first, then SENSEX? Weekly expiry of that session, on every weekday including
   expiry day?
4. **Break cut-off:** is a break at 14:30 still wanted? Registered as 12:00 or 14:00 for the grid.
5. **Re-entry "at cost":** same contract at the original premium (the engine's `cost`) — confirmed as
   Dir's existing meaning. After the re-entry's stop, nothing more that day?
6. **Both sides in one day:** if the up-break stops out and the market then breaks the low (still within an
   up-trend), is the down-break skipped (as registered) or traded?
7. **No overall stop** in the first version (the owner withdrew ₹2,000): confirm none, or ₹3,000 like Dir.

## Log

- 2026-11-15 — created from the owner's message; related findings read (directional, breakout, intraday-state
  pages; BL-152/153/164/124/083/081/053/105) and summarised above; engine support for `range_breakout` on
  the underlying confirmed in `legwise/schema.py`. Pre-registration drafted, nothing run; pending decisions
  stay here until the item is picked up.
- 2026-11-15 — started: owner accepted all recommendations and asked for the last two years; Amendment 1 written and committed before any run; TODO row 3.11.30; Phase 1 (trend state, break finder, runner) begins.
- 2026-11-15 — Amendment 2 written and committed before the full run (primary cell, which break the trend takes, placebo / bootstrap / quarter definitions). Runner `research/bl221/run.py` smoke-tested on 12 days (no results read); full fit-window run next.
- 2026-11-15 — `override: owner asked in chat, "look with buy also, then look with ITM2 also instead of ATM"` (the
  Phase 0 "Will not run" list named buying and ITM strikes). Run as **exploratory extras on the primary range
  only**, after the registered fit-window run: (a) the same breaks **bought** at ATM (already computed as C5),
  (b) **ITM2 sold** and (c) **ITM2 bought**, same 21% stop (sold: re-entry at cost ×1; bought: none), same
  entries, costs and slippage, trend-aligned and no-gate. They add 3 counted variants to the family (now 16) and
  are **never a pass**: the registered rule and primary cell are unchanged, and a lead in an extra is a new
  hypothesis that needs its own pre-registration and the 2022–24 confirmation. Script `research/bl221/run_itm2.py`.
- 2026-11-15 — `override: owner asked in chat, "after 10 ... the highest point is 24,500, then the 24,500 PE should be sold ... whichever the higher or lower point"` — a fourth extra (d): **sell the strike at the range edge**
  instead of the ATM at the break (up-break: the PE at the range high rounded to the nearest strike; down-break:
  the CE at the range low's strike; the owner wrote CE once and then "24,500 PE", read as the opposite option
  throughout). Same entries, 21% stop, re-entry at cost ×1, costs and slippage; written to the engine as the
  ITM/OTM offset from the ATM at the entry minute (`run_level.py`). Exploratory, counted (family now 17), never a
  pass.

