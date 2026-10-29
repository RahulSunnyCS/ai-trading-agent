# BL-187 — Cut the Directional in the afternoon and start the strongest late Widesl in its place

| | |
|---|---|
| **Priority** | P1 — the owner trades Core and T1 with real money, picks a Dir on most days, and asked this directly |
| **Status** | Done 2026-10-29: the registered verdict is **FAIL** for both books. R14 (the Dir cut two minutes before the strongest Widesl that starts after 14:00, that Widesl run in its place) reads +₹32 [−11, +74] net per margin lot-day on T1's 434 pick days with a deeper drawdown, and the gain is gone at ₹115 of late-fill cost per swapped-in Widesl. The Widesl added is worth having (+₹75 [+44, +106]) and the Dir's last hour is worth keeping (−₹43 [−68, −20] when cut); the ranking beats a random late Widesl by +₹44 [+8, +79]. Lead: a fixed 14:00 cut with the 14:02 Widesl, +₹40 [−2, +82], +₹50 [+7, +92] at ₹5 an order. Stage 2 not run. |
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

### Phase 1 — Build and parity gates (done 2026-10-29)
`research/bl187/`: picks and rankings from the A0 CSVs; Dir files derived with `exit_time` changed; the engine runs on the picked Dir days only; the arms; the gates above.

### Phase 2 — Run, read, record (done 2026-10-29)
All arms, both books, the sensitivities; findings page `research/options/strategies/directional/exit-time.md` and `widesl/entry-time.md` rows; item closed.

## Result (2026-10-29)

Gates 1 to 3 passed before any arm was read (Log). 3,613 Dir cut runs; the picks equal BL-185's A0 replay exactly. Everything below is per margin lot-day (book ÷ 3), net after ₹13 an order, 434 pick days 2025-01-10 → 2026-10-27, 90 % 5-day block bootstrap.

**T1 book (primary)**

| Arm | Net | Gross | Net at ₹5 | Net at ₹20 | Swap days | Max drawdown |
|---|---|---|---|---|---|---|
| B (as picked) | +505 | +617 | +553 | +464 | 0 | −8,536 |
| **R14** (strongest Widesl from 14:02) | +538 | +672 | +595 | +487 | 362 | −9,642 |
| F1400 (cut 14:00, Widesl 14:02) | +545 | +679 | +603 | +495 | 358 | −9,758 |
| X14 (cut, nothing added) | +462 | +572 | +509 | +422 | 362 | −9,523 |
| P14 (cut + a random eligible Widesl) | +493 | +627 | +551 | +443 | 366 | −9,400 |

| Difference to B | Net | Gross | ₹5 | First period (184 days) | Second period (250) |
|---|---|---|---|---|---|
| R14 | +32 [−11, +74] | +55 [+12, +97] | +42 [−1, +84] | +60 [+6, +116] | +12 [−45, +73] |
| R1430 | +13 [−18, +47] | +37 [+6, +70] | +24 [−7, +57] | +35 [+1, +69] | −2 [−50, +48] |
| R1500 | +2 [−18, +22] | +26 [+6, +46] | +12 [−8, +32] | 0 [−16, +17] | +3 [−28, +36] |
| F1400 | +40 [−2, +82] | +62 [+20, +104] | +50 [+7, +92] | +56 [+1, +113] | +28 [−33, +87] |
| F1430 | +18 [−12, +48] | +41 [+12, +72] | +28 [−1, +58] | +32 [−3, +68] | +8 [−32, +52] |
| F1500 | −13 [−33, +7] | +11 [−9, +31] | −2 [−22, +18] | −11 [−32, +9] | −14 [−45, +18] |
| X14 | −43 [−68, −20] | −45 [−70, −22] | −44 [−69, −21] | −18 [−50, +17] | −62 [−95, −28] |
| P14 | −12 [−29, +4] | +10 [−7, +26] | −2 [−19, +14] | −3 [−26, +20] | −18 [−42, +4] |

- **Pass rule (R14, T1):** (a) lower bound above zero: no (−11); (b) positive in both periods: yes (+60, +12); (c) drawdown no deeper than B's: no (−9,642 against −8,536); (d) still above zero with ₹300 added per swapped-in Widesl: no (−51 [−95, −9]). **FAIL.** Core book: R14 − B +23 [−16, +62], drawdown −14,302 against −13,788, the same three failures. **FAIL.**
- **Decomposition (T1):** ending the Dir early costs −43 [−68, −20] (its last hour earns, as BL-147 found at 14:55); the strongest Widesl added gives +75 [+44, +106]; the strongest beats a random eligible Widesl by +44 [+8, +79] (Core +27 [+1, +54]). The ranking carries information; the net gain is the Widesl's earnings minus the Dir's tail.
- **Late-fill allowance:** with ₹100 added per swapped-in Widesl R14 − B is +4 [−39, +47]; with ₹300, −51 [−95, −9]. The break-even is about ₹115 a swapped-in lot (32 × 3 × 434 ÷ 362). The 14:47 slot is not the driver: leaving it out reads +27 [−18, +71].
- **Where the gain is (descriptive, 362 swap days):** the strongest Widesl entered at 14:02 on 179 days, 14:17 on 82, 14:47 on 51, 14:32 on 31, 15:17 on 13, 15:02 on 6. By the Dir's index: SENSEX Dir +104 a day (177 days), NIFTY Dir −23 (185); expiry days +60 (116), other days +29 (246). Half-years: +7,451, −1,995, +9,671, −1,111 (sum of daily differences per margin lot-day); two of four are negative.
- **Core book:** same shape, smaller: F1400 +34 [−5, +74], R14 +23, the ranking over random +27, SENSEX/NIFTY reversed (NIFTY Dir +36, SENSEX +20).

**Reading.** The idea is not worthless: the added late Widesl earns, the ranking picks better than chance, and at ₹5 an order the fixed 14:00 / 14:02 version has a 90 % interval above zero (+₹50 [+7, +92]). But the registered primary arm does not clear zero, deepens the drawdown, and its gain is smaller than ₹115 of late-fill cost per Widesl lot, which 1-minute bars with no spread cannot rule out. Seen data, nine arms read besides B.

**Not adopted. Stage 2 (NIFTY 2022-24) was not run:** its gate is a Stage 1 pass or the owner's `override: <reason>`. Leads for a later registration: the fixed 14:00 cut with the 14:02 Widesl; the SENSEX-Dir-only version; measuring the real late-entry slippage from the live capture (`obt rotation live-compare`) first, since the answer turns on a cost of about ₹100 a lot.

## Risks

- Late Widesl results lean on 1-minute fills with no spread, and the 14:47 jump is unexplained (BL-059): the ₹100 / ₹300 allowance and the 14:47-out read are there for that.
- Dir and Widesl may be on different indices; margin is then only approximately equal.
- The result is on seen data.

## Open questions

None blocking. Defaults taken and stated above: T1 as the primary book, R14 as the primary arm, the Widesl chosen among all eligible slots, the Dir kept when it enters after the cut.

## Log

- 2026-10-29 Registered (Phase 0) before any run.
- 2026-10-29 Phase 1 built; gate (2) sharpened before any arm was read: instead of a Rs 1 match to one bar of the original curve, the cut run's MTM curve must equal the original's at every bar before the cut (the engine is deterministic), and the cut run's gross is reported against the original curve's last bar before the cut. Gates 1-3 pass: 40 of 40 original-exit runs equal A0 (largest gross difference Rs 0.00); 10 of 10 cut curves identical (largest difference Rs 0.0000), the cut gross equals the last bar's MTM exactly. 3,613 Dir cut runs (every picked Dir at every cut after its entry, both books) are cached in `research/bl187/out/dir_cuts.csv`.
- 2026-10-29 Phase 2: all arms, both books. R14 FAIL on (a), (c), (d); Core likewise. Findings pages updated (Dir exit time, Widesl entry time, Dir early exit). Stage 2 not run (gated). Generated files (`out/`, `variants/`) are git-ignored; `out/summary.md` is the full printout.
- 2026-10-29 Count correction: Phase 0 said seven arms are read; the table lists eight besides B (R14, R1430, R1500, F1400, F1430, F1500, X14, P14) and the 14:47-out sensitivity. Only R14 could pass, so the rule is unaffected.
- 2026-10-29 Code review of PR 385 (10 findings): gate 2 now covers all six cut files (30 sampled runs, all identical before the cut, largest difference Rs 0.0000) instead of 14:15 only; clearer failures for a missing A0 folder or a skipped cut run (none were skipped: 3,613 of 3,613 written); the late-fill allowance is charged only where a Widesl was added; smaller clean-ups. All arms re-run after the changes and identical. A0 is regenerated with `research/common/two_session/a0.py` (BL-185). Not changed: `rank_book` still copies BL-185's replay to keep the composite (that file belongs to #383); the expiry split uses the stored `dte` labels, whose calendar comes from the lake's observed expiries from 2024-10 on.
