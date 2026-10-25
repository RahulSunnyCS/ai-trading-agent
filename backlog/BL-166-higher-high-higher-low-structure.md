# BL-166 — Higher-high / higher-low structure on 5-minute NIFTY bars: buy the break of the last swing (one rule)

| | |
|---|---|
| **Priority** | P2 — the owner's idea (2026-10-25); one registered test; the repo's prior is against intraday option buying (BL-152, BL-164), so the value is a clean verdict |
| **Status** | In progress (pre-registration committed before any code or run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-25 |
| **Depends on** | BL-120 (the rule tester, its controls, ledger and locked confirmation period), BL-063 (charges), BL-164 / BL-165 (the grammar additions this branch stacks on) |
| **TODO.md row** | 3.10.45 |

## Context

The owner (2026-10-25): "can you find out the higher high and lower low structure". Nothing in the repo
has tested trend structure intraday: BL-042's `pivots.py` is a weekly-stock zigzag for Momentum, BL-031
is an untested stock-pattern idea, and BL-091 counts the straddle's own higher highs during a spike.
The owner chose every setting below except the strike and the backstop stop, which were fixed here
(2026-10-25) and are part of the registration.

The prior is against it: buying NIFTY options on an intraday breakout lost after charges in BL-152 (−₹71
a trade buying ATM), and BL-164's gap-and-go was killed (+₹111, t 0.33). What structure adds is a
condition on the *shape* of the morning (two rising swing highs and two rising swing lows) before the
break, which none of those had.

## Goal

A registered verdict on NIFTY: does buying the weekly ATM option on the first 1-minute close through the
latest confirmed swing high, once the structure is up (higher high and higher low, mirrored for puts),
earn money after charges, beat the same trade at a random later minute, survive slippage, and hold on
the locked 2022–24 period.

## Out of scope

- SENSEX; any other bar size, swing rule, strike, stop, window or exit; scaling in or re-entry; more
  than one trade a day; combining it with BL-164's gap rules. A later item if this one passes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis (S1):** on NIFTY, after a higher swing high and a higher swing low on 5-minute bars,
  buying the weekly ATM call on the first 1-minute close above the latest swing high (the put, after a
  lower swing high and a lower swing low, on the first close below the latest swing low), exiting on a
  close back through the latest swing low (high), earns more after charges than the same trade entered
  at a random later minute.
- **Swings (owner's choices: 5-minute bars, fractal 2 each side).** 5-minute bars from 09:15 (the
  grammar's `_bars`: high = max, low = min, close = the fifth minute's close). Bar k is a **swing high**
  if its high is strictly above the highs of the two bars before and the two after it; a **swing low**
  likewise with lows. Only bars of the same session, so the first possible swing bar is the third
  (09:25) and a swing is **confirmed at the close of bar k + 2**, the 1-minute stamp (k + 3) × 5 − 1;
  before that stamp it does not exist. Swings do not carry across sessions.
- **Structure.** At a stamp, `sh0` / `sh1` are the latest and the one-before confirmed swing highs, `sl0`
  / `sl1` the same for lows. **Up:** sh0 > sh1 and sl0 > sl1. **Down:** sh0 < sh1 and sl0 < sl1.
- **Entry (owner: break of the last swing high).** Up event: structure up and the 1-minute close above
  sh0. Down event: structure down and the close below sl0. The first such stamp in the window 09:40–14:00
  is the event; the trade enters the next minute (BL-120 convention: filled at the signal minute's
  close). If both could hold at one stamp (impossible, since up needs close > sh0 > ... and down close
  < sl0 < sh0) the up side is taken.
- **Exit (owner: structure break + time).** Call: exit the minute after the first 1-minute close below
  the latest confirmed swing low (sl0 as it is at that minute, so a new higher low tightens it); put:
  the first close above the latest swing high. Backstop: a −30% stop on the premium (the engine's
  default tick check). Time exit 15:15.
- **Option (fixed here):** the weekly ATM (`strike_type: ATM`, nearest expiry), one lot, today's lot
  size, BL-063 charges.
- **Universe:** NIFTY index 1-minute bars and the weekly option chain from the trading-data lake, days
  `data_quality` excludes skipped and counted. No constituents, so no survivorship.
- **Look-ahead check:** the swing operator (Phase 1) exposes a swing only from its confirmation stamp
  and reads only bars of the same session up to it; it joins the grammar's causality test. A pilot month
  (Phase 2) recomputes the events in plain Python, bar by bar, and must match the grammar on every
  session.
- **Controls:** placebo days (the 20 nearest no-event days, same entry minute and side) and 200
  random-time draws; with `exit_when` and no `control_when` the tester uses a control minute only where
  the exit condition does not already hold.
- **Pass / kill rule** (learning period, NIFTY 2024-10-09 → 2026-10-08, after charges, one lot):
  1. Fewer than 40 events is **thin**: inconclusive.
  2. A **candidate** has mean net > 0, t ≥ 2.0, the event mean at or above the 90th percentile of its
     random-time draws, and mean net > 0 at 0.5% slippage.
  3. A candidate is revealed once on the confirmation period (NIFTY 2022-01-03 → 2024-10-08) and
     **passes** with mean net > 0, t ≥ 2.0 and random-time percentile ≥ 0.90 there.
  4. **Verdict:** passed, killed (not a candidate, or fails confirmation) or inconclusive (thin).
- **Hold-out:** the confirmation period stays locked unless step 3 applies. Forward sessions are never
  tested.
- **Will not run** (each needs `override: <reason>` in the Log): any setting in Out of scope; a second
  look at the confirmation period.

### Phase 1 — The swing operator
- **Tasks:** `ruletest/expr.py`: `{swing: {kind: high | low, back: 0 | 1, minutes: 5, n: 2}}`, the value
  of the latest (`back: 0`) or the one-before (`back: 1`) confirmed swing of the session, NaN before;
  causality-test row; unit tests on a hand-built session.
- **Done when:** the spec validates and reads back.

### Phase 2 — Pilot and run
- **Tasks:** `packages/option-backtesting/research/bl166/`: `specs.py`, `pilot.py` (one month, plain-
  Python swings and events against the grammar), `run.py` (the one ledger test, the pass rule, the reveal
  only on a candidate). Outputs under `research/bl166/out/` (git-ignored).
- **Done when:** the verdict is in the Log and Result, and a findings page cites it.

## Risks

- **Few events:** a full HH + HL sequence needs four confirmed swings, the earliest about 09:40; many
  days will have none by 14:00.
- **Choppy days:** structure flips often on 5-minute bars; the first break may come late, close to the
  swing high, with a stop (the swing low) that is near.
- **ATM buying has lost before** (BL-152); a structure filter must do better than that, not only beat
  random minutes.

## Log

- 2026-10-25 — created from the owner's request and answers (5-minute bars, fractal 2 each side, buy the
  break of the last swing high, exit on the structure break plus time). Strike (weekly ATM) and the −30%
  backstop fixed here before any run. Nothing run.
