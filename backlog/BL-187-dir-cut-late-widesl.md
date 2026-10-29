# BL-187 — Cut the Directional in the afternoon and start the strongest late Widesl in its place

| | |
|---|---|
| **Priority** | P1 — the owner trades Core and T1 with real money, picks a Dir on most days, and asked this directly |
| **Status** | Phase 0 registered 2026-10-29, before any run |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-29 |
| **Depends on** | BL-185 (A0: Core-298 and T1 re-simulated with charges, `research/common/two_session/replay.py`, `split_replay.py`), BL-113 / BL-122 (T1, the expiry-only rule), BL-063 (charges), BL-182 / BL-184 (what the afternoon looked like) |
| **TODO.md row** | 3.10.50 |

## Context

The owner (2026-10-29): "stop the dir at 2, 2:30 or 3 and put a widesl during then. What would be result. Take the strongest widesl after 2 according to core adaptive or T1, let's say it's at 2:17, we will stop the dir at 2:15 and start the widesl at 2:17."

Adaptive picks three core strategies each morning, at least two of them Widesl, so at most one is a Dir. On the A0 replay (BL-185) a Dir is among the picks on 366 of 434 pick days (T1) and 356 (Core). The idea: the Dir's last hour is a poor use of its margin lot; end it early and let the Widesl that the same morning ranking likes best among the late starts use the lot.

What earlier items say about the afternoon, all on seen data and after our charges (BL-182, BL-184, BL-185): the afternoon Widesl pair earned about as much as the whole day at a shallower drawdown; the afternoon Dir alone earned most of the whole-day Dir; the one consistent signal in BL-185 was an afternoon Widesl pick earning on non-expiry days. Each of those readings came from the same 2024-10-09 → 2026-10-27 data this item uses, so **this item can end at a lead, not an adoption** (see Data-snooping).

## Goal

Measure, per margin lot-day and after charges, what the book earns when the picked Dir is ended two minutes before the strongest late Widesl enters and that Widesl runs from there to 15:28, against the book as picked.

## Out of scope

Any change to Adaptive's ranking or picks; the Buy add-on; the book stops (Core ₹8k / T1 ₹9k); the live plumbing (exports, uploaders). A pass here starts nothing live.

## Plan

### Phase 0 — Pre-register (registered 2026-10-29, before any run; frozen)

**Data and books.** The stored 521 re-simulated variants of BL-185's A0 (Core-298 plus T1's 223, 1 lot each, charges from `ruletest/charges.py`, ₹13 an order), NIFTY and SENSEX, 2024-10-09 → 2026-10-27. Pick days are the 434 days from 2025-01-10 (63-day warm-up). Two books: **T1** (primary: the pool of 521) and **Core** (the 298; secondary, reported, never decides). Picks are list C's composite on gross (`score.composite`, history before the day only), `score.select` (three core picks, Widesl minimum two), no Buy add-on, no expiry-only rule, as A0 had them. The baseline book **B** is those three picks held to their own exits, 1 lot each.

**The swap.** On a day whose picks contain a Dir:
1. Rank every Widesl (`score.is_wide`) in the book's pool by the same day's composite, highest first, over the slots whose entry is at or after `T + 2 minutes`, leaving out any already among the day's three picks. The strongest is **S\***; its entry slot is `s*`.
2. The Dir's exit moves to `s* − 2 minutes` (14:17 → 14:15, 14:02 → 14:00, 15:17 → 15:15), by changing only `exit_time` in its strategy file and re-running the engine. A Dir whose own entry is at or after that cut is left alone and the day is not swapped.
3. S\* is added at its stored slot, 1 lot, held to its own exit (15:28 or its stop). A day without a Dir pick is unchanged. The Dir having already stopped out earlier does not cancel the swap.

Margin: the Dir's lot is the Widesl's lot, so the book is still three lots and **per margin lot-day = book ÷ 3**, as in BL-185.

**Arms** (T = earliest cut, so the earliest allowed Widesl slot is T+2):

| Arm | What | Role |
|---|---|---|
| B | the picks as they are | baseline |
| **R14** | strongest late Widesl among slots from 14:02, Dir cut two minutes before it | **primary** |
| R1430, R1500 | same with slots from 14:32 / 15:02 | secondary |
| F1400, F1430, F1500 | Dir cut at 14:00 / 14:30 / 15:00 and the strongest Widesl at exactly 14:02 / 14:32 / 15:02 | secondary (the owner's fixed-time reading) |
| X14 | R14's cut with nothing added (the value of the Dir's last hour) | decomposition |
| P14 | R14's cut but a uniformly random eligible Widesl instead of the strongest (the average over all eligible, each with its own cut) | does the ranking matter? |

**Statistics.** Net and gross per margin lot-day, max drawdown (net, cumulative per margin lot-day), swap-day count and mean per swap day, difference to B with the circular 5-day block bootstrap (2,000 resamples, seed 20261028, 90 % interval; `readout.block_bootstrap_mean`, `max_drawdown`) over all 434 pick days, the same difference in each of the two periods (2025-01-10 → 2025-10-08, 184 days; 2025-10-09 → 2026-10-27, 250 days) and in each half-year. Reported beside: net at ₹5 and ₹20 an order; by the Dir's index and by whether that index expires that day (`dte` label `0`); X14, P14 and R14 side by side; R14 with candidates at 14:47 left out (all Widesl and Dir curves jump at 14:47, BL-059); R14 with ₹100 and ₹300 added to every swapped-in Widesl as a late-fill allowance (BL-062: 1-minute bars, no spread).

**Pass rule (R14, T1 book only).** All of: (a) R14 − B has a 90 % lower bound above zero over the 434 days; (b) the point estimate is above zero in each of the two periods; (c) R14's max drawdown is no deeper than B's; (d) R14 − B is still above zero in point estimate with ₹300 added per swapped-in Widesl. Anything else is not adopted. Secondary arms and the Core book can only add leads.

**Parity gates (before any arm is read).** (1) The Dir re-run at its original exit reproduces A0's row for that day (gross within ₹1, orders equal). (2) For ten sampled days, a Dir cut at 14:15 books the original run's MTM at the bar the engine fills the exit on (within ₹1). (3) Charges on the cut Dir come from its own trades; the added Widesl's row is A0's, unchanged. A failed gate stops the item until fixed and logged.

**Red-team (the research gate).**
- *Look-ahead:* S\* and the Dir are both fixed by the morning ranking (history before the day); the Dir's cut time is a function of S\*'s slot only. The afternoon path is never read to choose.
- *Survivorship:* none; every variant has all its days, and a missing day drops out of both arms alike.
- *Data-snooping:* **nothing is tuned here** (one primary rule, thresholds fixed in advance, the owner's), but the idea sits next to a post-hoc lead from the same period (BL-185: afternoon Widesl picks earned on non-expiry days), so the 434 days are not clean for it. A pass is a **lead**. Stage 2 (below) is the only route to adoption.
- *Multiple arms:* seven arms are read; only R14 can pass, the rest are descriptive.
- *Not modelled:* book stops, the Buy add-on, the expiry-only rule, margin differences between NIFTY and SENSEX when the Dir and the Widesl are on different indices, real late-day spreads.

**Stage 2 (gated off).** Runs only if Stage 1 passes, or after the owner writes `override: <reason>`. NIFTY 2022-01 → 2024-10 (the lake), a NIFTY-only book (its own Adaptive over NIFTY's variants, same rule, nothing re-tuned). Needs 298 NIFTY variants simulated over about 700 days first.

### Phase 1 — Build and parity gates
`research/bl187/`: picks and rankings from the A0 CSVs; Dir files derived with `exit_time` changed; the engine runs on the picked Dir days only; the arms; the gates above.

### Phase 2 — Run, read, record
All arms, both books, the sensitivities; findings page `research/options/strategies/directional/exit-time.md` and `widesl/entry-time.md` rows; item closed.

## Risks

- Late Widesl results lean on 1-minute fills with no spread, and the 14:47 jump is unexplained (BL-059): the ₹100 / ₹300 allowance and the 14:47-out read are there for that.
- Dir and Widesl may be on different indices; margin is then only approximately equal.
- The result is on seen data.

## Open questions

None blocking. Defaults taken and stated above: T1 as the primary book, R14 as the primary arm, the Widesl chosen among all eligible slots, the Dir kept when it enters after the cut.

## Log

- 2026-10-29 Registered (Phase 0) before any run.
- 2026-10-29 Phase 1 built; gate (2) sharpened before any arm was read: instead of a Rs 1 match to one bar of the original curve, the cut run's MTM curve must equal the original's at every bar before the cut (the engine is deterministic), and the cut run's gross is reported against the original curve's last bar before the cut. Gates 1-3 pass: 40 of 40 original-exit runs equal A0 (largest gross difference Rs 0.00); 10 of 10 cut curves identical (largest difference Rs 0.0000), the cut gross equals the last bar's MTM exactly. 3,613 Dir cut runs (every picked Dir at every cut after its entry, both books) are cached in `research/bl187/out/dir_cuts.csv`.
