# BL-123 — Late-day straddle give-back: after 14:30, a held rise in the rolling ATM straddle that gives back 15 points starts a Widesl with a ₹1,000 stop

| | |
|---|---|
| **Priority** | P1 — the owner's own rule (2026-10-18), the first rule-triggered intraday test that is not a re-entry habit; cheap to run |
| **Status** | Parked (owner, 2026-10-18): block 2 inconclusive, +₹151 per Widesl on 36 NIFTY events, +₹126 over the causal placebo, t 0.94; about 160 events would be needed; P1 unread. Reopen only with a new reason |
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
- **Done when:** this block is in a commit named in the Log, before `research/bl123/` holds a run.

### Phase 0b — Block 2: the day's-low reading (registered 2026-10-18, after the event counts, before any placebo or trade P&L)

Owner, 2026-10-18, on seeing that rule A almost never fires: "at 14:30, if it is already up 20 points
from the day's low, that is also included." Rule A measured the rise only from 14:30 on, so it missed
exactly that case. Block 2 is the rule as the owner meant it. **Rule A stays registered, is
inconclusive by construction (4 / 8 / 7 tradable events), and is not run for P&L.** Everything in Phase 0
not restated here stands (series, trade, stop, costs, comparators, tests, read guard, P1 gate).

- **Why this block and not another:** the owner's own clarification. The event counts (Log) were seen
  before choosing among readings; no P&L of any reading has been computed. Counts of the readings not
  chosen (13:30, 13:00, halved rise) are in the Log and are not run.
- **Definitions (one each):**
  - *Low and epoch:* L(t) is the lowest value of the rolling ATM straddle from 09:20 to minute t. A
    value strictly below every earlier one is a new low and starts a new **epoch**: the epoch high H(t)
    is the highest value since that low's minute, and the hold below restarts.
  - *Rise and hold:* rise R(t) = x(t) − L(t). **Held** when R(t) ≥ **20** (NIFTY) / **50** (SENSEX) for
    **5 consecutive** minutes inside the epoch; once held, the epoch stays held (the owner's "stays or
    stayed": the hold may complete before 14:30).
  - *Give-back state:* held and H(t) − x(t) ≥ **15** points (both indices, as in Phase 0).
  - *Fire:* the first minute m ≥ 14:30 (index 315) at which the give-back state **becomes** true: true
    at m, not true at m − 1 in the same epoch (a new epoch counts as not true before it). A give-back
    that was already in place at 14:29 does not fire at 14:30; only a later fresh crossing does. One
    event per index per day, the first.
  - *Entry, trade, stop, costs:* as Phase 0 (entry at m + 1, not tradable if 15:13 or later; the live
    Widesl, ₹1,000 overall stop, ₹20 an order).
- **Look-ahead check:** as Phase 0 (reads x(≤ m) only; truncation test; placebo chosen from bars up to
  the entry minute), plus: an independent implementation of block 2's rule must agree with this one
  on a sample of real days, and a day's epoch state at 14:30 must be computed from bars up to 14:30 only.
- **Judged cell:** **NIFTY, P2 and P3 pooled, as one cell** (the owner allowed pooling to reach the
  floor). **SENSEX P2 is reported and not judged** (its event count is below the floor). The placebo for
  an event is drawn within its own period (5 days each side), the random-minute pool is the pooled
  NIFTY events' entry minutes (200 draws, seed 20261018).
- **Pass / kill rule (Phase 0's three tests, applied to the pooled cell):**
  1. mean net (₹20 an order) per event > 0;
  2. event minus the causal placebo > 0 with t ≥ 2.0 over events;
  3. the event mean above the 95th percentile of the 200 random-minute means.
  **Pass** = all three, **and** tests 1 and the sign of test 2 positive in P2 and in P3 separately.
  **Kill** = mean net ≤ 0 or event minus placebo ≤ 0 in the pooled cell. **Inconclusive** = fewer than 30
  pooled tradable events, or anything else (for example tests 1 and 2 hold but t < 2, or test 3 or a
  period's sign fails).
- **Counted tries:** block 2 is one rule in one judged cell (plus the SENSEX report). Ledger of what was
  counted or run in this item: rule A (counts only); A from 13:30, A from 13:00, A with the rise halved
  (counts only); block 2 (this). BL-091's 31 arms and BL-083's four triggers read these days first.
- **Will not run:** a different rise, hold, give-back, stop or start time; the 13:30 / 13:00 / halved
  readings; firing on a give-back already in place at 14:30; the Dir or Buy template; re-entries; P1
  before the gate; a per-expiry or per-VIX sweep (descriptive only). A block 3 would be dated and
  committed before its P&L.
- **Done when:** this block is in a commit, named in the Log, before any placebo or trade simulation
  for block 2 is computed.

### Phase 1 — Build, check, run P2 and P3

- **Tasks:** `research/common/straddle_series.py` (the series builder BL-091 uses, copied; BL-091 can be
  pointed at it later, since research code is not imported across item folders); `research/bl123/`:
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
4. (2026-10-18) The rule as registered fires about once in 25 sessions on NIFTY (tradable once in 65),
   mostly at 15:12 or later.
   Which reading did the owner mean: (a) the rise, its 5-minute hold and the give-back all after 14:30
   (registered, too rare); (b) the rise measured from the day's low, possibly holding before 14:30,
   with the give-back at or after 14:30; (c) a window that starts earlier (13:30 or 13:00); or (d) a
   smaller rise? And may NIFTY P2 and P3 be pooled so a cell can reach 30 events?
   **Answered 2026-10-18 by the owner:** reading (b): a rise already up 20 from the day's low at 14:30
   counts. Pooling NIFTY P2 and P3 was offered with that reading and registered as block 2.

## Log

- 2026-10-18 — created from the owner's chat. Defaults above are mine (give-back 15 on both indices;
  ₹1,000 as the overall stop; the series, trade and periods from BL-091). Phase 0 committed before any
  run (commit 8e5918e4).
- 2026-10-18 — **Phase 1, build and checks.** `research/common/straddle_series.py` (BL-091's series
  builder, copied) and `widesl_trade.py` (BL-091's Widesl runner, copied); `research/bl123/`:
  `rule.py`, `periods.py` (read guard: only the three registered cells open), `design.py` (placebo and
  random-minute selection, written, not yet used), `events.py`, `selfcheck.py`. Checks, all passing:
  15 synthetic cases (known fire, rise held 4 minutes, give-back 14, rise 19, fall inside the hold,
  a strike-switch jump, fire at 15:12 versus 15:13, a rise before 14:30, SENSEX 30 versus 55, truncation);
  an independent numpy implementation of the rule agrees with `rule.detect` and with the scan on 400
  real days; truncation holds on every real event in that sample; the series at minutes up to the fire
  minute is unchanged when later bars are removed; a Widesl at 12:02 equals the stored `N_wide_1202`
  gross on 5 P2 days. `out/` is git-ignored: regenerate with `events.py`.
- 2026-10-18 — **Event counts (no P&L read).** The rule as registered fires on very few days.
  Fires (first event of the day) and, in brackets, those with an entry by 15:12:

  | cell | weekday sessions | fires | tradable | fires on expiry day |
  |---|---|---|---|---|
  | NIFTY P2 | 157 | 9 | 4 | 4 |
  | NIFTY P3 | 618 | 22 | 8 | 13 |
  | SENSEX P2 | 157 | 17 | 7 | 4 |

  All three cells are below the registered floor of 30, so under Phase 0 **each is inconclusive by
  construction** and nothing is judged. Most fires are late: 29 of the 48 fire at 15:12 or later, so
  their entry would fall at 15:13 or after (the same 29 are the not-tradable ones), and 21 of the 48
  are on expiry day. On expiry day the straddle's low is a median 10.6 points and its high 56.7, and
  the window holds a median of 7.5 ATM strike switches (7 on expiry day, 8 on other days), each of which
  re-prices the straddle; whether these rises are premium expanding or the strike moving was not
  separated. NIFTY: 31 fires in 775 sessions (one in 25), 12 tradable (one in 65). No placebo or trade
  P&L was computed, deliberately: the rule is not to be loosened after reading outcomes.
- 2026-10-18 — **Counts for other readings, counts only** (`counts_alt.py`, `out/counts_alt.csv`; none
  registered, none judged, listed here because choosing among them must rest on testability, not on
  results). Tradable events by cell:

  | reading | NIFTY P2 (157 d) | NIFTY P3 (618 d) | SENSEX P2 (157 d) | NIFTY P2 + P3 |
  |---|---|---|---|---|
  | A: registered (from 14:30) | 4 | 8 | 7 | 12 |
  | A from 13:30 | 17 | 27 | 24 | 44 |
  | A from 13:00 | 22 | 32 | 34 | 54 |
  | A with the rise halved (10 / 25) from 14:30 | 13 | 31 | 24 | 44 |
  | B: rise from the day's low since 09:20, give-back crosses 15 at or after 14:30 | 9 | 27 | 18 | 36 |

  No reading reaches 30 in NIFTY P2 alone; SENSEX P2 reaches it only from 13:00. Readings that reach 30
  need NIFTY P2 and P3 pooled (a change to Phase 0's per-cell judging) or an earlier start or a smaller
  rise (a different rule from the owner's). Four variants and one reading were counted besides A; any
  block 2 adds to the disclosure.
- 2026-10-18 — Status: waiting for the owner. A block 2 must be committed before any placebo or trade
  P&L is computed. The owner's answer to open question 4 below decides it.
- 2026-10-18 — **Block 2 registered** (Phase 0b), before any placebo or trade P&L: the day's-low reading,
  NIFTY P2 + P3 pooled as the judged cell, SENSEX reported only. Prompted by the owner: "at 14:30, if it
  is already up 20 points from the day's low, that is also included." Committed in this commit; the run
  follows.
- 2026-10-18 — **Block 2 build and checks** (before any simulation): `rule.detect_b`, `events.py
  --reading B`, `selfcheck_b.py`. 18 synthetic cases pass (a spike already given back before 14:30 does
  not fire; a rise held before 14:30 and given back after fires; a hold completing at 14:29 counts; a new
  low resets the epoch; a fresh crossing after an earlier give-back fires; rise 19, hold 4, give-back 14
  do not fire; 15:12 tradable, 15:13 not; SENSEX 30 versus 55; the rise is measured from the morning
  low; truncation). On real days an independently written implementation (epochs from the
  running-minimum records) agrees on 371 days (all 71 events and 300 no-event days), truncation holds on
  every event, the series up to the fire minute is unchanged without later bars, and the tradable counts
  equal those logged before registration (9 / 27 / 18). 35 of the 71 events completed their hold before
  14:30. The shared detector replaced a local copy in `counts_alt.py`; its counts re-ran identical.
- 2026-10-18 — **Block 2 result** (`run.py`: 1,708 simulations, 0 errors, 0 without an entry; `read.py`).
  Rupees per Widesl strategy, ₹1,000 stop, after ₹20 an order (cost is 4 orders, ₹80, so gross is ₹80
  higher). Causal placebo: 10 nearest days with no fire by the entry minute (median 10, minimum 6 per
  event).

  | cell | events | mean net | win rate | stopped | placebo mean | event − placebo | t | random-minute P95 |
  |---|---|---|---|---|---|---|---|---|
  | **NIFTY P2 + P3 pooled (judged)** | 36 | +151 | 61 % | 14 % | +25 | **+126** | **0.94** | 113 (event mean above 97 % of draws) |
  | NIFTY P2 (sign check) | 9 | +261 | 67 % | 11 % | +65 | +196 | 0.75 | 334 |
  | NIFTY P3 (sign check) | 27 | +114 | 59 % | 15 % | +11 | +103 | 0.65 | 97 |
  | SENSEX P2 (reported, not judged) | 18 | +247 | 44 % | 11 % | +143 | +104 | 0.37 | 323 |

  **Verdict under Phase 0b: inconclusive.** Test 1 (mean net > 0) holds, test 3 (above the random-minute
  P95) holds, both periods are positive, but **test 2 fails: t = 0.94 against the bar of 2.0**. Not a
  kill (nothing negative), not a pass. 90 % bootstrap interval of the mean net per event: [−69, +375];
  of event minus placebo: [−91, +347]; 67 % of events beat their own placebo. At this effect size and
  spread (standard deviation of event minus placebo ₹805) a t of 2 needs about **162 events, 4.5 times
  the 36 seen**, which at one tradable event per 22 sessions is about 14 years of NIFTY sessions. P1 is
  not read: the gate needs a screen pass.

  **Description only, not judged: many splits of 36 events, so leads at most.** Hold completed before 14:30: 20 events, +₹282 (placebo difference +255); at or after 14:30:
  16 events, −₹13 (−35). Entry before 14:45: 15 events, +₹418 (+397); 14:45 or later: 21 events, −₹40
  (−67). By year: 2022 −₹161 (4 events), 2023 −₹177 (10), 2024 +₹423 (13), 2025 +₹261 (9). Expiry day:
  4 events, +₹392; other days 32 events, +₹121. SENSEX is at 44 % wins with a larger average win
  (₹1,193) than loss (₹510); expiry day 3 events, all losses.
- 2026-10-18 — **Limits of this result.** Cost is brokerage only (₹20 an order); statutory charges and
  slippage are not in the figures, and bar-close fills on thin late-day premium are the engine's weakest
  part. The placebo is 6 to 10 days per event, so it is itself noisy. 2022 and 2023 are negative and 2024
  and 2025 positive on 4 to 13 events each, which cannot say whether the edge is regime-dependent. The
  series counts strike switches as movement (median 30 inside the window from 09:20), so a "rise" can be
  the strike moving. P2 + P3 are not clean for this rule (see Context); a pass would only have been a
  screen. Counted tries in this item: rule A (counts only), three other readings (counts only), block 2.
- 2026-10-18 — **Parked by the owner** ("park BL-120 and BL-121 as they stand"). **Renumbered from BL-120**: that number was taken on `main`'s line of work (BL-120 desk screens and strategy tester); nothing of this item had been pushed. Folder `research/bl120` is now `research/bl123`.
