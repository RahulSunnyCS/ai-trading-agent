# BL-120 — Late-day straddle give-back: after 14:30, a held rise in the rolling ATM straddle that gives back 15 points starts a Widesl with a ₹1,000 stop

| | |
|---|---|
| **Priority** | P1 — the owner's own rule (2026-10-18), the first rule-triggered intraday test that is not a re-entry habit; cheap to run |
| **Status** | In progress (Phase 0 pre-registered; nothing run when this block was committed) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-091 (rolling-ATM series, held-spike idea, Widesl runner, periods), BL-083 (event-versus-placebo method, nightly trigger scoring for any forward shadow) |
| **TODO.md row** | — (added with the result) |

## Context

Owner, 2026-10-18, asked to test whether "exhaustion of momentum" works **after 14:30**: each day
from 14:30, on NIFTY and SENSEX, watch the rolling ATM straddle; if it is up by NIFTY 20 / SENSEX 50
points, stays up for at least 5 minutes, and then is down 15 points, start a Widesl with a ₹1,000
stop.

What the repo already says, read before registering:

- **BL-091** tested a held rise (NIFTY ≥ 25, SENSEX ≥ 90 points, 5 minutes) with five re-entry rules
  and a ladder of ₹650 / ₹1,300 / ₹1,950 stops, then 13 time-gate variants. 31 arms in all; none
  passed its registered screen. **F1450** (enter at the held-spike minute, no earlier than 14:50, ₹650)
  met the screening bar on P2 + P3 as a post-hoc lead. BL-091 also recorded that its comparator is
  **not causal** (placebo days were chosen with knowledge of the rest of the day) and that a later
  registration must use a causal one.
- This rule differs from BL-091's arms in four ways: observation starts at **14:30**, the rise is
  smaller (**20 / 50**), the entry is on a **15-point give-back** from the high (not at the end of the
  hold), and the stop is **₹1,000**. It is a new rule, so it gets this pre-registration; it is not an
  extension of BL-091 and needs no `override` there.
- **The honest prior.** BL-091 found that most episodes decay by the close and that decay often comes
  late; selling Widesl late in the day earns theta whether or not anything fired. The test is
  therefore against the same Widesl at the same minute on days the rule had not fired, not against zero.
- **The owner's 14:30 and size ideas came after seeing BL-091's P2 + P3 results**, so P2 + P3 are
  **not clean** for this rule. P1 is the only period this lineage has not read.

## Goal

A verdict, under a rule written first, on whether starting a Widesl after a held rise has given back 15
points beats the same Widesl at the same minute on ordinary days and beats a random minute on the
event days, after charges, and whether it survives one read of P1.

## Out of scope

- Re-entry ladders, other templates (Dir, Buy), other stops, other gates, any parameter search.
- Any change to the lists, the journal, BL-091's registered arms, or BL-119.
- Live or forward running (a forward shadow is a later dated block; see Phase 3).

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** a held rise in the rolling ATM straddle after 14:30 that gives back 15 points marks a
  better moment to sell a Widesl than the same minute on days with no such pattern.
- **Index and period cells (judged):** NIFTY in P2 (2025-01-10 → 2025-08-29) and in P3 (2022-04-05 →
  2024-10-08); SENSEX in P2 only (SENSEX has no P3 data). **P1 (2025-12-03 → 2026-10-08), the days
  between P2 and P1, and every day after 2026-10-08 are not read** until Phase 2's gate is met.
- **Series:** the rolling ATM straddle of the nearest weekly, one value per minute, exactly as BL-091
  E.1 builds it (`level(rolling_straddle(chain)).x`: whatever strike is ATM that minute, each leg priced
  from its last trade at most 5 minutes old, an unpriced minute holds the last value). A strike switch
  counts as movement, as in the owner's example.
- **Definitions (one each; any other value is a new dated block):**
  - *Observation* starts at 14:30 (minute index 315, 09:15 = 0). Only values from 14:30 on are read.
  - *Low* L(t) = the lowest series value from 14:30 to minute t. *High* H(t) = the highest from 14:30
    to t. *Rise* R(t) = x(t) − L(t).
  - *Held:* R(t) ≥ **20** (NIFTY) or **50** (SENSEX) for **5 consecutive** minutes. The hold completes
    at the fifth such minute, h.
  - *Fire:* the first completed bar j ≥ h with H(j) − x(j) ≥ **15** points (both indices; the owner
    gave one figure). One event per index per day, the first.
  - *Entry:* the minute after j (entry time = label of j + 1; the engine prices an entry at T with the
    close of the bar ending at T). An event whose entry would be 15:13 or later is dropped (BL-091's
    rule).
  - *Trade:* the live `{N|S}_wide_1202` Widesl (NIFTY OTM1, SENSEX OTM2; 115 % leg stops trailed 15/10;
    exit 15:28; 1 lot a leg) with an **overall (MTM) stop of ₹1,000 per strategy** (the figure the owner
    called "1000 sl", read as BL-091 reads ₹650). Legwise engine, `lot_sizing: current`, sizing date
    2026-10-12, the early reference wrapper for 2022–24, cost ₹20 per order (`research/common/charges`
    convention of BL-091 / BL-096). Statutory charges are not included; named as a limit.
- **Look-ahead check:** the rule at minute j reads x(≤ j) only. A test runs the detector on the series
  truncated at j and on the full series and requires the same event, minute and entry; a second asserts
  no event uses a bar after its fire minute. Placebo selection (below) reads only bars up to the entry
  minute. Entry is at j + 1.
- **Comparators:**
  1. **Causal time-matched placebo:** the same Widesl, same index, same entry minute, on the 10 nearest
     days (5 before, 5 after) in the same period on which the rule had **not fired at or before the
     event's fire minute** (a day with no fire, or a later fire). Event minus placebo per event.
  2. **Random minute:** on the event days, the same Widesl at an entry minute drawn at random from the
     index-and-period pool of the events' own entry minutes (so the time-of-day distribution matches);
     200 draws, seed 20261018. The event mean is compared with the 95th percentile of the 200 draw means.
- **Pass / kill rule (the screening bar, BL-091's, plus one test):**
  1. mean **net** (after ₹20 per order) per event > 0;
  2. event minus the causal placebo > 0 with t ≥ 2.0 over events (one event per index-day, so the
     day-clustered t is the same);
  3. the event mean above the 95th percentile of the 200 random-minute means.
  **Screen pass for an index** = all three in P2, and tests 1 and 2 positive (same sign) in NIFTY's P3.
  **Kill** = test 1 or test 2 fails (wrong sign) in any judged cell. **Inconclusive** = a judged cell has
  fewer than 30 events, or tests 1 and 2 hold and 3 fails. SENSEX is judged on P2 alone and its verdict
  is labelled single-period.
- **Counted tries:** this item runs one rule in three cells (NIFTY P2, NIFTY P3, SENSEX P2). The
  lineage is disclosed: BL-091's 31 arms and BL-083's four triggers read these days first, and this
  rule's thresholds were suggested after the F1450 lead; a P2 + P3 pass is therefore a **screen**, and
  only the P1 read in Phase 2 is evidence.
- **Hold-out:** P1 only (Phase 2), read once. No parameter is fitted here, so nothing carries into it.
- **Will not run:** any other rise size, hold length, give-back, start time or stop; a scaled SENSEX
  give-back (a dated block if the owner wants it); the Dir or Buy template; re-entries; P1 or any other
  unread day before the gate; a per-expiry or per-VIX sweep (reported as description only).
- **Reported, not judged:** events by year and half-year, entry-minute distribution, win rate, mean
  winner and loser, share stopped out, expiry versus other days, strike switches inside the rise.
- **Done when:** this block is in a commit named in the Log, before `research/bl120/` holds a run.

### Phase 1 — Build, check, run P2 and P3

- **Tasks:** `research/common/straddle_series.py` (the series builder BL-091 uses, copied; BL-091 can be
  pointed at it later, since research code is not imported across item folders); `research/bl120/`:
  `rule.py` (the detector), `periods.py` (the read guard: P2 and P3 only until the gate is met),
  `selfcheck.py`, `run.py` (events, placebo and random-minute simulations, memoised by day and minute),
  `read.py` (the read-out).
- **Checks before any result is read:** the truncation test above; a hand-built series that must fire
  at a known minute and one that must not (the rise not held, the give-back inside the hold's first
  minutes, a strike-switch jump); five real events inspected against the raw bars; a Widesl at a fixed
  minute reproducing the BL-091 runner's number for the same day.
- **Deliverables:** the read-out (per cell: events, net mean, placebo mean, difference, t, random-minute
  P95, win rate, the reported items), the verdict per cell written in this item.
- **Done when:** all three cells are read once and the verdicts are in the Log.

### Phase 2 — P1, once (only if a cell screen-passed)

- **Gate:** the cell's screen passed in Phase 1. A kill or inconclusive cell does not read P1.
- **Tasks:** run the same rule, unchanged, on P1; the same three tests with t ≥ 2.0; no parameter moves.
- **Done when:** the P1 verdict is written. It stands.

### Phase 3 — Forward shadow (only if P1 passes; a separate dated block)

Register the rule as a trigger in the nightly scoring that BL-083 and BL-091 (C.12) describe; judged
after 60 sessions. Not started by this item.

## Risks

- **Late theta.** Selling Widesl after 14:30 pays because premium decays; only the placebo difference
  says whether the rule adds anything.
- **Few events.** A held 20-point rise after 14:30 may be rare in NIFTY; fewer than 30 events in a cell
  makes it inconclusive, not a pass.
- **The ₹1,000 stop is small on SENSEX's scale** (about 50 points of combined premium at today's lot of
  20 versus about 15 on NIFTY at 65); the two indices are read separately.
- **Late entries have little time.** An entry at 15:05 has 23 minutes; a stop or exit-time fill on a
  thin premium is the engine's weakest part (`widesl/exit-time.md`).
- **Tick versus bar.** 1-minute bars, bar-close fills; no slippage in the net figure.
- **Not clean data.** See Counted tries.

## Open questions

1. SENSEX give-back: 15 as said (default), or scaled to about 37? A dated block 2 if wanted.
2. Is "1000 sl" an overall ₹1,000 stop per Widesl strategy (default), or a per-leg figure?
3. After P2 + P3, should P1 be read straight away if a cell passes, or after the owner says so?

## Log

- 2026-10-18 — created from the owner's chat. Defaults above are mine (give-back 15 on both indices;
  ₹1,000 as the overall stop; the series, trade and periods from BL-091). Phase 0 committed before any
  run.
