# BL-152 — Five-minute breakout, hold and 1-minute entry: a 192-variant grid

| | |
|---|---|
| **Priority** | P2 — a new intraday entry idea from the owner; useful evidence, nothing waits on it |
| **Status** | Done: killed, no variant passes (2026-10-22) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-22 |
| **Depends on** | BL-120 (the rule tester; PR #281's Supertrend, `exit_when`, `control_when` and premium-% strike) |
| **TODO.md row** | 3.10.35 |

## Context

The owner's idea (2026-10-22, in chat): when a 5-minute candle breaks out of a level with at least
60% of its body (the candle without its wicks) beyond the level, and no 1-minute candle then closes
back below the level, take the trade when a 1-minute candle closes above the breakout candle. The
owner left the breakout level, the stop loss, the trade and the exit open, was given four, four,
three and four options, and asked for **every combination** to be tested: 4 x 4 x 3 x 4 = 192
variants. "Let's log it as a BL. Let's do it overnight."

The owner said there are **two** ideas; the second never came through. It gets its own Phase 0 here
(or its own item) when it arrives; nothing about it is run.

What exists: the BL-120 rule tester (`ruletest/`, a condition grammar over the 375-minute grid, the
event study with placebo, random-time controls, slippage, charges and a tested-strategies ledger),
which since PR #281 also has Supertrend, Bollinger bands, a rule-level `exit_when`, trend-matched
`control_when` and a premium-%-of-spot strike. It cannot yet say "the value at the breakout candle",
"since the breakout" or anything relative to the trade's own entry; Phase 1 adds those.

## Goal

A registered verdict for the idea on NIFTY: does any of the 192 variants earn money after charges,
beat entering at a random trend-matched minute, survive the multiple-testing guard and a plateau
check, and hold on the locked confirmation period. Every variant is counted in the ledger.

## Out of scope

- SENSEX, other indices, stocks.
- Other parameter values than the ones registered below (no SL %, ATR multiple, range length or
  time-exit sweep): a later item, if this one finds something.
- More than one trade a day, re-entry after a stop, scaling in.
- Idea 2 (not received).
- Any live or paper trading. A passing variant becomes a forward-tracking proposal, nothing more.

## Plan

### Phase 0 — Pre-register (committed before any run)

**Hypothesis.** Entering in the breakout's direction on the first 1-minute close beyond a 5-minute
breakout candle whose body is at least 60% beyond the level, with no 1-minute close back through the
level in between, earns more after charges than entering the same trade at a random minute after
the same breakout while the index is still beyond the level.

**The rule (up side; the down side is the mirror: lows, `<`, PE for CE).**
All values are on NIFTY index 1-minute bars; a 5-minute candle is 09:15 + 5k ... + 4 (stamp j where
j + 1 is a multiple of 5), its open `lag(open, 4)`, high `roll_max(high, 5)`, low `roll_min(low, 5)`.

1. **Breakout candle:** the first 5-minute candle of the session that opens below the level `L`,
   closes above it, and has at least 60% of its body above it: `(close - L) / (close - open5) >= 0.6`.
   Its close must be at or before 13:59 (the 13:55 candle).
2. **Frozen level:** `L` is taken at that candle and held for the rest of the day (a rolling level does
   not move after the breakout).
3. **Hold:** no 1-minute close below the frozen `L` from the breakout candle on. A close below cancels
   the up side for the day.
4. **Entry:** the first 1-minute close above the breakout candle's high (while the hold stands); the
   trade enters the next minute (the BL-083 / BL-120 convention: the fill is that signal minute's close).
5. At most one trade a day: the first of the up or down entries. The rule's window is 09:19-14:15.

**The four breakout levels.**
| Id | Level | Up `L` | Extra condition |
|---|---|---|---|
| `or30` | Opening range | `cum_max(high)` at 09:44 (09:15-09:44), so breakouts from the 09:45 candle | — |
| `roll30` | Rolling 30-minute range | the high of the 30 one-minute bars before the candle: `lag(roll_max(high, 30), 5)` | — |
| `held30` | Day high, held 30 minutes | the day's high before the candle: `lag(cum_max(high), 5)` | that high was already the day's high 30 minutes earlier: `lag(cum_max(high), 5) <= lag(cum_max(high), 35)` |
| `prevday` | Previous day | the previous session's high | — |

**The four stop losses.**
| Id | Stop |
|---|---|
| `lvl` | a 1-minute index close back below the frozen level `L` |
| `cndl` | a 1-minute index close below the breakout candle's low |
| `prem30` | the option's premium moves 30% against the leg (legwise `stop_loss: {percent: 30}`) |
| `atr03` | a 1-minute index close below the entry close minus 0.3 x ATR-14 (the previous 14 sessions' mean daily true range) |

**The three trades** (1 lot, nearest weekly expiry, today's lot size, as every BL-120 test).
| Id | Trade |
|---|---|
| `atm` | buy the ATM CE on an up entry, the ATM PE on a down entry |
| `pct1` | buy the CE / PE whose premium is nearest 1% of the index at entry (`premium_pct_of_spot: 1.0`) |
| `sellopp` | sell the ATM PE on an up entry, the ATM CE on a down entry |

**The four exits** (besides the stop; every trade is out by 15:15).
| Id | Exit |
|---|---|
| `eod` | hold to 15:15 |
| `trail` | the 5-minute Supertrend (10, 3) turns against the trade |
| `tgt2r` | a target of twice the risk: index stops `lvl` / `cndl` / `atr03` — a 1-minute close at or above entry close + 2 x (entry close - the stop level at entry); `prem30` — a 60% premium target on the leg |
| `t60` | 60 minutes after entry |

Note on `trail`: the chat table proposed "move the stop 10% for every 10% gain on the option". The
legwise trail only trails a premium stop, so it could not apply to the three index-stop variants;
the registered trail is the Supertrend flip, the same for all four stops. The owner may supersede
this before the run with a dated rule below.

**Controls (trend-matched, `control_when`).** Up side: a placebo day or random minute counts only where
the frozen level exists and the index closes at or above it the minute before entry (down: at or below
the frozen low). So the random-time control is "enter the same trade at a random 5-minute-grid minute
after the same breakout, while still beyond the level", the placebo is the same minute on the 20 nearest
other days that also had a breakout and were still beyond their level, and each control uses the same
stop and exit from its own entry.

**Universe and data.** NIFTY index 1-minute bars and NIFTY weekly options from the trading-data lake;
days `data_quality` excludes are skipped (`backtest_days`). The index has no constituents to be
survivorship-biased; the option chain is the collected/imported chain of each day, expired contracts
included.

**Look-ahead check.**
- Every new operator (Phase 1) reads only stamps <= j and earlier sessions; the grammar's causality test
  (scramble everything after a stamp and every later session) is extended to each.
- The opening range is used only from 09:44 on; the rolling level ends 5 minutes before the candle; the
  held-high check uses only earlier stamps; the previous-day level and ATR-14 use earlier sessions only.
- Trade-relative values (`at_entry`, `minutes_in_trade`) are read only in `exit_when`, from the minute the
  trade's entry is decided.
- Entry fills at the signal minute's close (as BL-083); slippage of 0.5% and 1% per fill is reported as a
  sensitivity on every variant's events.

**Pass / kill rule** (learning period, NIFTY 2024-10-09 to 2026-10-08, all 192 variants):
1. A variant with fewer than 40 events is **thin** and cannot advance.
2. A **candidate** has, after charges: mean net per trade > 0; a t-statistic of net per trade >= 2.0;
   and the event mean at or above the 90th percentile of its 200 random-time draws.
3. **Multiple testing:** CSCV / PBO over the 192 variants' daily net series (a day with no trade = 0),
   8 and 16 contiguous blocks. If PBO > 0.5 for either, **no variant advances** and the grid is reported
   as overfit. The deflated Sharpe of the best variant is reported beside it.
4. **Plateau:** a candidate advances only if at least 60% of its 11 one-setting neighbours (the same
   variant with one of level / stop / trade / exit changed) have a positive mean net.
5. At most **three** advancing variants (highest t first) are taken to the **confirmation period**
   (NIFTY 2022-01-03 to 2024-10-08), revealed once each (`obt rule reveal`). A variant **passes** there
   with mean net > 0, t >= 2.0 and the random-time percentile >= 0.90.
6. **Verdict:** *passed* if at least one variant passes confirmation (it becomes a forward-tracking
   proposal, a new item); *killed* if no variant is a candidate, the grid fails the PBO check, or none
   passes confirmation; *inconclusive* if most variants are thin.

Every number is after the BL-063 charges, one lot, today's lot size. The verdict is what the rule says;
no variant, threshold or period is changed after a result is seen. The criteria are also in
`packages/option-backtesting/research/bl152/criteria.json`.

**Hold-out.** The confirmation period (2022-01-03 to 2024-10-08) stays locked until step 5. Sessions after
2026-10-08 are forward only and never tested here.

**Will not run** (each needs `override: <reason>` in the Log): SENSEX; any parameter value other than
those above; the confirmation period for a variant that did not advance; a second look at the
confirmation period for any variant.

### Phase 1 — Rule grammar for the breakout (BL-120 extension)
- **Tasks:** add to `ruletest/expr.py`: `max` / `min` of two numbers; `{at_first: {x, when}}` (x at the
  first stamp of the session where `when` holds, held after; NaN before); `{min_since_first: {x, when}}` /
  `{max_since_first: ...}` (running min / max of x from that stamp); trade-relative `{at_entry: x}` and
  `minutes_in_trade`, allowed only in `exit_when` (and only under elementwise operators), evaluated per
  trade by `study.exit_minutes`. A rule whose exit uses them must give `control_when`. Tests, the
  causality test for each, `ruletest-acceptance.py` still OK.
- **Deliverables:** the grammar, tests, package `CLAUDE.md` updated.
- **Done when:** the 192 specs validate and read back, unit tests and the acceptance check pass.

### Phase 2 — The grid (learning period)
- **Tasks:** `research/bl152/specs.py` writes the 192 rule specs; `research/bl152/run_grid.py` loads the
  index frame once and runs each variant through the tester's own study (learning period only), records
  each test in the ledger (192 tries), and keeps per-variant summaries and daily net series under
  `research/bl152/out/` (git-ignored); a pilot of 2 variants times the run first.
- **Deliverables:** `out/summary.csv` (one row per variant), `out/series.npy`, the ledger rows.
- **Done when:** all 192 variants have a result or a recorded error.

### Phase 3 — Judge, confirm, write up
- **Tasks:** `research/bl152/judge.py` applies steps 1-6 (PBO with `research/common/cscv.py`), reveals
  and tests at most three variants on the confirmation period, and prints the verdict. Update this
  item's Log and Result, `INDEX.md`, `TODO.md` and the findings page
  `research/options/strategies/breakout/five-minute-breakout.md`.
- **Done when:** the verdict is in the Log with its numbers, and the findings page cites it.

## Risks

- **192 tries:** the best variant will look good by chance; steps 2-5 exist for that, and the confirmation
  period is the real test.
- **Fill optimism:** a breakout entry fills at the signal minute's close; a real market order in a fast
  minute can fill worse. The 0.5% / 1% slippage rows show how much of any edge survives.
- **One trade a day:** a later, better setup on the same day is never taken; the result is for the first.
- **Placebo thinness:** only days that also broke out count as placebo days, so some events may have too
  few (they are reported, not judged; the random-time control is the primary comparator).

## Open questions

- Idea 2: the owner's second idea never arrived in chat. The index-support follow-up (Bank Nifty, Nifty IT, Reliance) was
  handled as [BL-153](BL-153-breakout-support-from-bank-it-reliance.md); anything else needs its own item.
- The trail (Supertrend flip instead of a premium trail): kept as registered; the owner did not supersede it.

## Result

**Killed: no candidate.** All 192 variants ran on the learning period (NIFTY, 2024-10-09 to 2026-10-08, BL-063 charges,
one lot) and were judged by the rule registered in Phase 0 (`research/bl152/judge.py`):

- Events per level: `or30` 200, `roll30` 370, `held30` 52, `prevday` 113. No variant is thin (all at least 40).
- **Candidates: 0.** The best t-statistic is 1.65 (`roll30_prem30_sellopp_trail`, 370 trades, +₹156 a trade), then
  1.57 and 1.49 (both `held30`, 52 trades). The registered bar is t >= 2.0 with the event mean at or above the 90th
  percentile of random entries.
- 77 of 192 variants have a positive mean net; by trade type `atm` −₹71 (15 of 64 positive), `pct1` −₹16 (22),
  `sellopp` +₹59 (40); by level `or30` −₹157 (8 of 48), `roll30` −₹52 (14), `prevday` −₹97 (13), `held30` +₹267 (42).
  At 0.5% slippage 49 variants stay positive, at 1% 28.
- **Multiple testing:** PBO 0.514 over 8 blocks (limit 0.5: fails) and 0.418 over 16; deflated Sharpe of the best
  variant 0.265.
- **Confirmation period (2022-01-03 to 2024-10-08): never opened.** Nothing advanced, so no reveal, no test.
- All 192 tests are in the ledger exactly once (the run was paused and resumed once; a finished variant was never rerun).

Findings pages: `research/options/strategies/breakout/`.

## Log

- 2026-10-22 — created from the owner's request ("test all", 192 variants; "log it as a BL, do it
  overnight"). Phase 0 registered and committed before any code or run. Next: Phase 1.
- 2026-10-22 — **Phase 1 built** (PR #281's grammar plus `max` / `min`, `at_first`, `min_since_first`, `max_since_first`,
  trade-relative `at_entry` and `minutes_in_trade` in `exit_when`, with `control_when` required for such an exit; the
  causality test covers each; `ruletest-acceptance.py` OK) and **Phase 2 run**: `specs.py` writes the 192 specs (all
  compile to distinct rules), `run_grid.py` ran them (2 pilot variants, then a run paused for the owner's request and
  resumed on 2 workers, with the worker count re-read per variant), about 2 hours in all.
- 2026-10-22 — **Phase 3 judged: killed** (see Result). No override was needed and none was used.

