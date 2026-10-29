# BL-193 — Every Core Widesl at a ₹3,000 overall stop instead of ₹2,500 (standalone and in Adaptive)

| | |
|---|---|
| **Priority** | P1 — the owner trades these stops with real money and asked |
| **Status** | Done |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-30 |
| **Depends on** | BL-191 (the replay and its engine-parity method), BL-070 / BL-098 (earlier MTM-stop looks) |
| **TODO.md row** | 3.10.56 |

## Context

Owner, 2026-10-30 (night of BL-191): "analyse MTMSL increasing to 3k", then "check for all Widesl which
is currently 2.5k to 3k". All 150 Core Widesl variants (NIFTY OTM1, ₹80, ₹100; SENSEX OTM2, ₹250, ₹320;
25 start times each) use a ₹2,500 overall stop (`overall.stop_loss_inr`). T1's own Widesl settings
(₹3,000 / ₹4,000) are not part of this item.

Before this registration, for NIFTY OTM1 only (BL-191 Amendment 1's files, 25 slots x 503 days), a
descriptive look: ₹3,000 averaged +₹9 a strategy-day over ₹2,500 (P1 +19, P2 −3), the 5th-percentile
day was 15% deeper (−₹3,195 vs −₹2,772), the stop fired 24% less. That look covered both periods for one
family of six. The findings page (`research/options/strategies/widesl/mtm-sl.md`) has ₹3,000 only in
BL-098's descriptive sweep, never in Adaptive.

## Goal

Say, on the registered rule, whether Adaptive (list C) over Core-298, and over T1, earns more with every
Core Widesl at ₹3,000, without a deeper drawdown.

## Out of scope

Other levels (₹2,000, ₹3,500, ...), per-family levels, T1's own settings, any live change (the owner
decides after the result).

## Plan

### Phase 0 — Pre-register (2026-10-30, before any run)

- **Hypothesis:** with every Core Widesl at a ₹3,000 overall stop, Adaptive earns more a day than at
  ₹2,500, with a drawdown no more than 10% deeper.
- **Variants:** the 150 Core Widesl files with only `stop_loss_inr: 2500` → `3000`, named
  `<I>_<family>-m3k_<HHMM>`; and unchanged copies (`-m25_`) for engine parity. Run by the same engine
  and settings as `obt rotation update` (BL-181 / BL-191's runner), 2024-10-09 → the last collected day.
- **Engine parity first:** every unchanged copy equals the stored rotation result (net, every day).
- **Arms** (list C, `pick.score_history`, 3 core picks, 1 lot each, net after brokerage; the Buy add-on
  not counted, as BL-167 / BL-191):
  - **Core:** K0 = Core-298 as stored; K1 = Core-298 with each of the 150 Widesl columns replaced by its
    ₹3,000 version (history and P&L).
  - **T1:** T0 = Core-298 + T1-223 as stored; T1K = the same with Core's 150 Widesl columns replaced.
- **Periods:** as BL-191 (63-session warm-up from 2024-10-09). **P2** 2025-10-09 → 2026-10-09 decides;
  P1, forward and all days reported.
- **Rule** (P2, each universe, arm minus base, 5-day block bootstrap, 2,000 resamples, seed 20261030,
  90% interval):
  - **Adopt ₹3,000:** mean difference ≥ +₹50 a day **and** the interval's lower bound > 0 **and** max
    drawdown at most 10% deeper than the base's.
  - **Kill:** mean difference < 0.
  - Anything else: **no clear gain**, keep ₹2,500.
  - Two universes, not adjusted; Core and T1 are read separately.
- **Reported, not deciding:** standalone per family (mean, win rate, 5th-percentile day, worst day,
  how often the stop fires) by period and expiry / non-expiry; the 5th-percentile day of each arm.
- **Look-ahead check:** each day ranks on earlier days only (as BL-191); the variants differ only in a
  number fixed before the run.
- **Hold-out:** none clean; P2 has been read by many items and the NIFTY OTM1 look above covered it.
- **Will not run:** other levels, per-family levels. `override: <reason>` in the Log for any.

### Phase 1 — Simulate, replay, read out

- **Deliverables:** `research/bl193/` (make_variants.py, run_batch.py, study.py; output git-ignored),
  the result here, the findings page row, TODO and INDEX.
- **Done when:** the rule is applied and recorded.

## Result (2026-10-30)

`research/bl193/` (make_variants.py, run_batch.py, study.py); output `results/` (git-ignored). 300
variants x 503 days per index (2024-10-09 → 2026-10-29). **Engine parity:** the 150 unchanged copies
equal the stored rotation results on all 75,450 slot-days (0 differ).

**Adaptive (list C), ₹ a day, 1 lot a pick, net after brokerage:**

| Universe, period | ₹2,500 mean / max DD / p5 day | ₹3,000 mean / max DD / p5 day | Difference [90%] | Picks differ |
|---|---|---|---|---|
| **Core, P2 (decides)**, 238 days | +987 / 35,929 / −6,748 | +915 / 35,730 / −7,056 | **−72 [−204, +49]** | 122 days |
| Core, P1, 184 | +669 / 42,326 / −8,746 | +760 / 52,466 / −9,491 | +91 [−206, +418] | 116 |
| Core, all 435 | +852 / 42,326 / −8,090 | +863 / 52,466 / −8,267 | +11 [−142, +173] | 245 |
| **T1, P2 (decides)**, 238 days | +1,672 / 24,435 / −6,340 | +1,526 / 29,005 / −6,986 | **−146 [−241, −62]** | 69 |
| T1, P1, 184 | +1,242 / 25,887 / −8,782 | +1,286 / 28,663 / −9,536 | +45 [−186, +296] | 73 |
| T1, all 435 | +1,495 / 25,887 / −7,573 | +1,442 / 29,005 / −8,601 | −53 [−170, +71] | 147 |
| Forward (13 days): Core +390 [−345, +1,229], T1 +275 [−275, +839] | | | | |

**By the registered rule (P2): kill, for both.** Core −₹72 a day (the interval includes zero: not a significant loss, but no gain); T1 −₹146 a day with the interval wholly
below zero, a drawdown 19% deeper and a worse 5th-percentile day. Keep ₹2,500.

**Standalone, per family** (every slot-day from 2024-10-09; the expiry / non-expiry split in `study.json` covers the replay's days from 2025-01-10 only; ₹ per strategy-day, ₹2,500 → ₹3,000): the average rises by
₹2 to ₹11 (NIFTY OTM1 217 → 226, ₹80 182 → 185, ₹100 183 → 194; SENSEX OTM2 104 → 102, ₹250 99 → 103,
₹320 96 → 106); the 5th-percentile day is 14–16% deeper in every family (about −₹2,800 → −₹3,200); the
stop fires about 25% less. So each strategy alone gains a little and loses deeper on bad days, and the
ranking does worse with them: deeper losses on the days a picked strategy goes wrong cost more than the
small average gain.

## Log

- 2026-10-30 — created and pre-registered from the owner's request (Phase 0 committed before any run).
- 2026-10-30 — run; engine parity exact (75,450 slot-days). P2: Core −₹72 a day [−204, +49], T1 −₹146 [−241, −62]: kill for both, keep ₹2,500. Standalone +₹2 to +₹11 a strategy-day with a 14–16% deeper 5th-percentile day.
