# BL-121 — Opening-range break of the rolling ATM straddle: after 09:30, a break of the 09:17–09:30 high that is 10 points up buys a long straddle (25% leg stop, trail 3:2)

| | |
|---|---|
| **Priority** | P1 — the owner's second rule test (2026-10-18); cheap; the first one on the long side of the straddle |
| **Status** | In progress (Phase 0 pre-registered; nothing run when this block was committed) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-120 (series builder, read guard, placebo design: copied, not imported), BL-091 (the rolling-ATM series), BL-083 (event-versus-placebo method) |
| **TODO.md row** | — (added with the result) |

## Context

Owner, 2026-10-18: "note the NIFTY rolling ATM straddle at 9:17, and if after 9:30 the high is broken and
10 points are moved up, then we take a long straddle with 25% stop loss on each leg with a TSL of 3:2."

What the repo already says, read before registering:

- **The opposite side is known and thin.** BL-101 bought a long ATM straddle from 09:16 to 15:28 with no
  stops as a hedge: killed (it cut the base's loss days but made its tail worse). Charges take 19–37 % of
  gross in the rotations and the Buy shape alone is negative after charges (`charges.md`); a long straddle
  pays four orders (₹80 here) and theta every minute it is held.
- **No straddle-based entry has passed.** BL-083's straddle turn (T3) found nothing for any template;
  BL-081's straddle move was one of 14 state variables that did not pass; BL-091's 31 arms sold the
  straddle after a spike. None bought it on a break.
- **A prior toward some movement.** BL-110: a wide opening range is followed by a wider rest-of-day range
  (top third 1.31× the norm, Spearman 0.30 in both periods). A long straddle is paid by movement; the
  placebo below says whether a break picks out the days and minutes that have it.
- **Two readings of the sentence.** "The high is broken and 10 points moved up" is either (R1) a break of
  the opening high **and** a rise of at least 10 points over the 09:17 value that was noted, or (R2) a
  break of the opening high **by** 10 points. Both are registered as arms; the owner may name one.

## Goal

A verdict, under a rule written first, on whether buying the long straddle after a break of the opening
straddle high beats the same straddle at the same minute on ordinary days and beats a random minute on
the event days, after charges, in two periods; and a decision whether to read P1.

## Out of scope

- Short straddles or any other template, a break to the downside, SENSEX, other windows or sizes.
- Any change to the lists, the journal, BL-119's or BL-120's rules.
- Live or forward running (a later dated block, only after a P1 pass).

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** a break of the early-morning high of the rolling ATM straddle marks a minute from which
  a long straddle with a tight trailing stop earns more than the same straddle entered at that minute on
  days with no such break.
- **Universe and cells (judged):** NIFTY, nearest weekly, weekday sessions that data_quality keeps. Cells:
  **P2** (2025-01-10 → 2025-08-29) and **P3** (2022-04-05 → 2024-10-08), each judged separately for each
  arm. **P1** (2025-12-03 → 2026-10-08), the days between P2 and P1, and every day after 2026-10-08 are
  **not read** until Phase 2's gate is met. SENSEX is not run (the owner named NIFTY).
- **Series:** the rolling ATM straddle at one value per minute, exactly as BL-091 E.1 / BL-120 build it
  (`level(rolling_straddle(chain)).x`; a strike switch counts as movement; each leg priced from a trade at
  most 5 minutes old, an unpriced minute holds the last value).
- **Definitions (one each; any other value is a new dated block):**
  - *Noted value:* S0 = x at 09:17 (minute index 2, 09:15 = 0). If the first priced minute is later, S0 is
    the value at the first priced minute and the day is flagged (counted, still used); a day with no priced
    minute by 09:30 is excluded and counted.
  - *Opening high:* H = the highest x from 09:17 to 09:30 (indices 2 to 15, the bars stamped 09:17 through
    09:30).
  - *Watch window:* completed bars j from 09:31 (index 16) to 14:00 (index 285); entry at j + 1, so the
    last entry is 14:01. One event per day: the first bar that meets the arm's condition.
  - *Arm R1:* x(j) > H **and** x(j) − S0 ≥ 10 points.
  - *Arm R2:* x(j) ≥ H + 10 points.
    (H ≥ S0, so R2 fires on the same bar as R1 or later; they are nested and correlated, not independent.)
  - *Trade:* a long ATM straddle: buy the ATM CE and the ATM PE of the nearest weekly at the entry minute
    (ATM from the index price at the entry minute, the engine's rule), 1 lot each, **stop-loss 25 % of each
    leg's entry premium**, **trailing stop [3, 2] in points** (every 3 points of favourable move moves the
    stop 2; points, as the owner's Buy 1:1 and Widesl 15/10 are), **no overall stop**, no re-entry, exit at
    **15:14** (the Buy family's exit; the owner gave none). Legwise engine, `lot_sizing: current`, sizing
    date 2026-10-12, the early reference wrapper for 2022–24, cost ₹20 per order (four orders, ₹80 per
    straddle). Statutory charges and slippage are not in the net figure; named as limits.
- **Look-ahead check:** the rule at bar j reads x(≤ j) only. A test runs the detector on the series
  truncated at j and on the full series and requires the same event; a second removes all bars after j
  from the chain and requires x(≤ j) unchanged; the placebo is chosen from bars up to the entry minute; an
  independent implementation must agree with the detector on real days. Entry is at j + 1.
- **Comparators:**
  1. **Causal time-matched placebo:** the same long straddle, same entry minute, on the 10 nearest days
     (5 before, 5 after) of the same period on which the arm had **not fired at or before the event's
     fire minute** (no fire, or a later one). Event minus placebo per event.
  2. **Random minute:** on the event days, the same straddle at an entry minute drawn at random from the
     cell's own event entry minutes; 200 draws, seed 20261018 plus a per-cell offset. The event mean is
     compared with the 95th percentile of the 200 draw means.
- **Pass / kill rule (two arms, so the t bar is 2.5; the screening bar of BL-091 / BL-120 otherwise):**
  1. mean **net** (after ₹20 an order) per event > 0;
  2. event minus the causal placebo > 0 with t ≥ **2.5** over events;
  3. the event mean above the 95th percentile of the 200 random-minute means.
  **Screen pass for an arm** = all three tests in P2 **and** in P3. **Kill** = mean net ≤ 0 or event minus
  placebo ≤ 0 in either cell. **Inconclusive** = a cell has fewer than 30 events, or anything else (for
  example tests 1 and 2's sign hold but t < 2.5, or test 3 fails).
- **Counted tries:** two arms in two cells (four judged cells, one trade template, no tuning). Lineage
  disclosed: BL-081 (14 state variables, one of them the straddle's move), BL-083 (four triggers incl. a
  straddle turn), BL-091 (31 straddle-sell arms), BL-101 (an unconditional long straddle), BL-120 (a late
  short-side rule) all read these days; the owner's rule was formed knowing some of those results, so a
  P2 + P3 pass is a **screen** and only a P1 read is evidence.
- **Hold-out:** P1 only (Phase 2), read once, only if an arm screen-passed. No parameter is fitted.
- **Will not run:** a different rise (10), hold, high window, window end, leg stop, trail, exit time or
  trail in percent; SENSEX; a short straddle after the same break; a break to the downside; P1 or any
  other unread day before the gate; per-expiry or per-VIX sweeps (description only).
- **Reported, not judged:** events by year, entry-time bands, share of straddles with 0 / 1 / 2 legs
  stopped, expiry versus other days, how many events had H − S0 ≥ 10 already at 09:30, days where the first
  priced minute was after 09:17, strike switches inside the window.
- **Done when:** this block is in a commit named in the Log, before any placebo or trade simulation exists.

### Phase 1 — Build, check, run P2 and P3

- **Tasks:** `research/common/long_straddle_trade.py` (the trade; done), `research/common/event_design.py`
  (placebo and random-minute selection, copied from BL-120's `design.py`); `research/bl121/`: `rule.py`,
  `periods.py` (the read guard), `events.py`, `design.py`, `selfcheck.py`, `run.py`, `read.py`.
- **Checks before any result is read:** synthetic series for each arm (break without the 10 points; 10
  points without a break; R1 fires where R2 has not; a break at 09:30 versus 09:31; a break after 14:00; a
  priced-late day); the truncation and causality tests; an independent implementation on real days; five
  real events inspected against the raw bars; the long straddle's legs re-simulated independently from the
  option bars (entry price, initial stop, trail steps, exit) on a sample of day-minute pairs and compared
  with the engine.
- **Deliverables:** the read-out per arm and cell, verdicts written in this item and on the findings page.
- **Done when:** all four cells are read once and the verdicts are in the Log.

### Phase 2 — P1, once (only if an arm screen-passed)

- **Gate:** the arm screen-passed in Phase 1. The same rule, unchanged, on P1; the same three tests with
  t ≥ 2.5. The verdict stands.

### Phase 3 — Forward shadow (only if P1 passes; a separate dated block)

Not started by this item.

## Risks

- **Theta.** A long straddle loses premium every minute; only the placebo difference says the break adds
  anything, and the Buy family and BL-101 argue against.
- **The rolling series moves when the strike moves.** A "10-point rise" can be the ATM switching (BL-120
  saw a median of about 30 switches in a day's window); the owner's definition counts it, and the share of
  events carried by switches is reported.
- **Tight stops, bar fills.** A 25 % stop with a 3:2 trail ratchets quickly; the engine fills stops at the
  stop level on 1-minute bars and has no slippage.
- **Overlap.** The two arms are nested; four judged cells come from two signals.
- **Not clean data.** See Counted tries.

## Open questions

1. R1 or R2 (or both): which did the owner mean? Both are registered.
2. The watch window end (14:00) and the exit time (15:14) are my choices; the owner gave neither.
3. Is "3:2" in points (assumed, like the owner's other strategies) or percent?

## Log

- 2026-10-18 — created from the owner's chat. Defaults are mine: the high window is 09:17–09:30, the watch
  window ends at 14:00, exit 15:14, trail in points, two arms for the two readings. Phase 0 committed
  before any run.
