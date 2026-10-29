# BL-191 — T1 without its SL150% NIFTY Widesl (or with it on expiry days only)

| | |
|---|---|
| **Priority** | P1 — the owner trades T1 with real money and is uneasy about this setting |
| **Status** | Done |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-29 |
| **Depends on** | BL-113 (T1 track), BL-167 (the universe replay this reuses) |
| **TODO.md row** | 3.10.54 |

## Context

Owner, 2026-10-29: T1's tentative picks for Fri 30 Oct hold two copies of `N_wide-t1s4`
(`N_widesl_OTM1 · SL150% · TSL25%/15% · RECOST1 · MTMSL4000`, at 10:17 and 10:32), and a 150%
leg stop "looks a bit scary". Is there research that it is good?

`N_wide-t1s4` is one of T1's nine time-generic settings (BL-113), 25 variants (one per rotation
start time). It was chosen on 2024-10-09 → 2025-10-08 only, as the NIFTY Widesl expiry-day winner.
The research behind T1 tests the nine settings together (T1 beat Adaptive on the next year by
+₹223 a lot-day); no test has removed this one. The Widesl leg-stop page
(`research/options/strategies/widesl/leg-sl.md`) has no result in favour of a 150% stop on its own.

What was looked at before this registration (so not a clean hold-out): on 2026-10-29 the standalone
daily results of `N_wide-t1s4_1017` / `_1032` against `N_wide_1017` / `_1032` (SL115%), split by NIFTY
expiry / non-expiry day, over 2024-10-09 → 2026-10-29. On non-expiry days the SL150% variants averaged
about the same (+₹155–157 against +₹167–212 a day per lot) with a deeper tail (5th-percentile day
about −₹4,200 against −₹2,900) and three to four times as many days below −₹3,000; the two start
times correlate at 0.82. That look covered both periods below, and is why the hypothesis exists.

## Goal

Say, on the registered rule, whether Adaptive over T1 is as good without `N_wide-t1s4` (arm A) or with
it allowed only on NIFTY expiry days (arm B), and whether either makes the book safer.

## Out of scope

- A version of the setting with a different leg stop (needs 25 new engine runs; a follow-up if asked).
- Any other T1 setting. The live T1 track is not changed by this item (BL-113 tracks T1 unchanged);
  any change to what is traded is the owner's decision after reading the result.

## Plan

### Phase 0 — Pre-register (2026-10-29, before any run)

- **Hypothesis:** Adaptive (list C) over T1 earns the same without `N_wide-t1s4`, or with it only on
  NIFTY expiry days, and has a shallower tail.
- **Arms** (all list C, `pick.score_history`, the function the 09:16 job calls; 3 core picks a day,
  1 lot each, net after brokerage `lot_plans.brokerage`; the Buy add-on is not counted, as BL-167):
  - **T1** — Core-298 plus the 223 T1 variants, as BL-113 / BL-167 replay it (`daylog.reconstruction`).
  - **A (drop)** — T1 minus the 25 `N_wide-t1s4_*` columns on every day.
  - **B (expiry only)** — T1, but on a day whose NIFTY days-to-expiry label is not `0` the 25
    `N_wide-t1s4_*` columns are left out of that day's ranking (their history stays for expiry days).
- **Universe:** the fixed Core-298 + T1-223 variant list (defined 2026-10-16, before both periods were
  re-read here); stored one-lot results in `TRADING_DATA_ROOT/rotation/`. No survivorship: the list
  does not depend on any later result.
- **Look-ahead check:** each day ranks on the days before it only (`assert all(d < day ...)`, as
  BL-167); the VIX band is the day's 09:15 open and the DTE label the one known at 09:16 (both from
  `days.csv`); arm B's filter uses only the day's own DTE label. Parity: the T1 arm's daily net must
  equal BL-167's T1 base series on every common day (re-derived here, not copied).
- **Periods:** 63-session warm-up from 2024-10-09. **P1** 2024-10-09 → 2025-10-08 (the setting was
  chosen on it, so T1 is favoured; reported only). **P2** 2025-10-09 → 2026-10-09 decides.
  **Forward** 2026-10-12 → the last scored day: reported only (too few days).
- **Pass / kill rule** (on P2, each of A and B against T1, same days, 5-day block bootstrap, 2,000
  resamples, seed 20261029, 90% interval):
  1. *Return:* mean daily difference (arm − T1) ≥ −₹50 **and** the interval's upper bound ≥ 0.
  2. *Risk:* max drawdown at least 10% shallower than T1's **or** the 5th-percentile day at least
     10% less negative.
  - Both hold → **pass**: the arm is no worse on return and safer; reported to the owner as an option.
  - 1 fails → **kill**: the setting earns its place in T1.
  - 1 holds, 2 fails → **no difference**: keep T1 as it is.
  - If both arms pass, the one with the higher mean difference is named first. Two arms: the
    intervals are not adjusted for it; a borderline pass is read with that in mind.
- **Hold-out:** none is clean. P2 has been read by BL-113, BL-145, BL-146, BL-167 and BL-180, and the
  standalone look above covered it. The forward days are the only unseen ones and are too few to
  decide; they are reported.
- **Reported, not deciding:** the same figures on P1, forward and P2's non-expiry days only; how often
  `N_wide-t1s4` is picked, on how many days twice; what the arms pick instead (by family); the five
  worst T1 days and the arms on them.
- **Will not run:** other settings removed, a re-tuned stop for this setting, the BL-122 expiry-only
  rule (not applied, as BL-113 / BL-167, so P1 / P2 are comparable with them). Running any needs
  `override: <reason>` in the Log.

### Amendment 1 — replace it on non-expiry days with a 115% Widesl at a ₹3,000 stop (2026-10-29, before any run)

Owner, 2026-10-29, after the result below: "Do one more study with Widesl 115 with 3k SL instead of
this in non expiries." The arms below are new; Phase 0's arms and rule are unchanged.

- **Hypothesis:** on non-expiry days, a Widesl at a 115% leg stop with a ₹3,000 overall stop in place of
  `N_wide-t1s4` earns as much as T1 with a shallower tail.
- **New variants** (NIFTY OTM1, the 25 rotation start times 09:17 → 15:17, stored-result format, run
  through the engine as `obt rotation update` runs them; files in `research/bl191/variants/`, git-ignored):
  - **C1** `N_wide-c1_<HHMM>` — the Core Widesl file `strategies/rotation/N_wide_<HHMM>.yaml`
    (SL115%, trail 15/10, no re-entry) with the overall stop **₹3,000** instead of ₹2,500. The owner's
    words read literally: the regular Widesl at 115% with a 3k stop. **Primary.**
  - **C2** `N_wide-c2_<HHMM>` — `N_wide-t1s4_<HHMM>` with only the leg stop **115%** (from 150%) and
    the overall stop **₹3,000** (from ₹4,000); trail 25/15 and RE cost ×1 kept. Secondary.
- **Engine parity first:** unchanged copies of `N_wide_<HHMM>` and `N_wide-t1s4_<HHMM>` run by the same
  script must equal the stored rotation results (net, every day, every slot) before C1 / C2 are read.
- **Arms** (as Phase 0: list C, 3 core picks, 1 lot each, net after brokerage):
  - **C1 arm** — on a NIFTY expiry day T1 as it is; on any other day the 25 `N_wide-t1s4_*` columns
    are left out and the 25 C1 columns put in their place (each with its full stored history, as the
    ranking would have it).
  - **C2 arm** — the same with the C2 columns.
- **Look-ahead check:** as Phase 0 (each day ranks on earlier days only; the day's DTE label decides
  which columns are in). The new settings were not chosen on any period, but they were proposed after
  reading Phase 1's result and the standalone figures, which cover P1 and P2.
- **Pass / kill rule:** Phase 0's, on P2, each arm against T1: return (mean ≥ −₹50 a day and upper bound
  ≥ 0) and risk (max drawdown or 5th-percentile day at least 10% better). Pass / kill / no difference
  as there. Also reported, not deciding: each arm against arm B (non-expiry days without any
  replacement), P1, forward, all days, how often C1 / C2 are picked and on how many non-expiry days
  twice.
- **Will not run:** other stops or trails, a C1 / C2 on SENSEX, a one-copy cap. `override: <reason>`
  in the Log for any.

### Amendment 2 — at most one SL150% Widesl a day (2026-10-29, before any run)

Owner, 2026-10-29, after Amendment 1: "Or let's do one more research: at max only 150% Widesl per day."
Phase 0's rule and Amendment 1 are unchanged.

- **Hypothesis:** capping T1 at one `N_wide-t1s4` pick a day keeps its return and removes the
  doubled-strangle days (8 non-expiry days in Phase 1, −₹4,208 on average; T1's worst day among them).
- **The cap** (a filter of the same ranking, the way BL-122's `expiry.filter_picks` works): T1's list C
  composite is computed as today over every column, never recomputed. If the selected core holds two or
  more `N_wide-t1s4_*`, the one with the highest composite stays and the others leave the candidate pool;
  `score.select` then chooses the three core picks from what is left (the same top-3, at least two
  Widesl rule).
- **Arms:** **D1** — the cap on every day (primary, the owner's words). **D2** — the cap on non-expiry
  NIFTY days only (the setting was chosen as the expiry-day winner), secondary.
- **Pass / kill rule:** Phase 0's, on P2, each arm against T1. Reported, not deciding: P1, forward, all
  days; the days the cap changes the picks and the mean difference on those days; against Amendment 1's
  C2 arm. The cap touches few days (15 of 435 had two copies), so the interval will be narrow and the
  risk bar (10% better drawdown or 5th-percentile day) may not be reachable; that is accepted as
  registered.
- **Look-ahead check:** as Phase 0; the cap uses only the day's own composite and DTE label. The idea
  comes from the post-hoc two-copy figure, which covers both periods: P2 is not clean for it either.
- **Will not run:** a cap on other settings, a cap of one Widesl of any kind per start time, a cap
  per index. `override: <reason>` in the Log for any.

### Phase 1 — Replay and read-out

- **Tasks:** `research/bl191/study.py` (reuses BL-167's replay), `--check` smoke, full run, figures here.
- **Deliverables:** `research/bl191/results/study.json` (git-ignored), the Result section below, the
  findings page `research/options/strategies/widesl/leg-sl.md` row, TODO and INDEX.
- **Done when:** the rule above is applied and recorded.

## Result (2026-10-29)

`research/bl191/study.py`; output `results/study.json` and `results/daily.json` (git-ignored). 435
sessions, 2025-01-10 → 2026-10-29, per arm. **Parity:** the T1 arm over BL-167's window is 431 days
and ₹653,498, equal to BL-167's T1 base. List C, 3 core picks, 1 lot each, net after brokerage, ₹ a day.

| Period | T1 mean | A drop: diff [90%] | A max DD / p5 day | B expiry only: diff [90%] | B max DD / p5 day | T1 max DD / p5 day |
|---|---|---|---|---|---|---|
| **P2 (decides)**, 238 days | +1,672 | **−116 [−365, +96]** | 24,188 / −7,448 | **+55 [−92, +198]** | 24,188 / −6,986 | 24,435 / −6,340 |
| P1 (chosen on it), 184 days | +1,242 | −212 [−489, +28] | 29,885 / −8,354 | −120 [−256, +17] | 27,187 / −8,782 | 25,887 / −8,782 |
| P2 non-expiry days only, 187 (A = B here) | +1,171 | +70 [−121, +263] | — / −7,279 | (same as A) | — / −7,279 | — / −6,576 |
| Forward, 13 days | +1,826 | +98 [−38, +234] | 10,472 / −8,626 | +97 [−38, +233] | 10,479 / −8,628 | 10,479 / −8,628 |
| All 435 days | +1,495 | −150 [−324, +16] | 29,885 / −7,935 | −18 [−118, +86] | 27,187 / −7,907 | 25,887 / −7,573 |

**By the registered rule (P2):**
- **A (drop): kill.** Mean −₹116 a day, below the −₹50 bar. The setting earns its place in T1 on the
  whole: without it P1 is −₹212 and all days −₹150, with a deeper drawdown.
- **B (expiry only): no difference.** Return holds (+₹55, interval includes zero) but the book is not
  safer: drawdown 1% shallower (bar 10%), 5th-percentile day 10% worse (−₹6,986 vs −₹6,340). Keep T1
  as it is.

**Reported, not deciding:**
- Use: `N_wide-t1s4` is 131 of 1,305 core picks (10%); 44 of them on expiry days. Days with one copy:
  101; with two or more: 15 (8 of them non-expiry days).
- Swaps: without it, 131 SL150 picks leave and other Widesl (153) and a few Dir enter; the picks differ
  on 154 days (A) and 111 days (B).
- On P2's non-expiry days alone the arms are the same (B leaves the setting out there by
  construction): +₹70 [−121, +263] with a worse 5th-percentile day. No drawdown is given for a subset
  of days: it would join days that were not consecutive.
- **Two or more copies on a non-expiry day (post hoc, small):** 8 days in all. T1 averaged **−₹4,208**
  (3 of 8 positive, worst −₹14,092 on 2026-09-11); the same days without the setting −₹1,148 (worst
  −₹9,276). P2: 5 days, −₹6,795 against −₹2,307. T1's worst day of all (2026-09-11, two SL150 copies
  plus `N_wide_1002`) and its fourth worst (2026-06-12, the same shape) are such days. One copy on a
  non-expiry day is fine (71 days, +₹1,421 against +₹1,269 without). This was found after the run, on
  8 days, and decides nothing; a cap of one SL150 copy on non-expiry days needs its own registration.
- Five worst T1 days: −14,092 (two SL150), −13,223, −12,277, −11,060 (two SL150), −10,479; the arms
  differ only on the two SL150 days (−9,276 and −8,161).

**Caveats:** P2 is not a clean hold-out (read by BL-113, 145, 146, 167, 180 and by the look that
prompted this item); no spread or slippage; the Buy add-on and the BL-122 expiry-only rule are not
in the replay. Nothing live changes.

## Result, Amendment 1 (2026-10-29)

`research/bl191/make_variants.py`, `run_batch.py` (BL-181's runner, NIFTY), `amend1.py`; output
`results/amend1.json`, `amend1_daily.json` (git-ignored). 100 variants x 503 NIFTY days (2024-10-09 →
2026-10-29). **Engine parity:** the unchanged copies equal the stored results on every day
(`N_wide_*` 12,575 slot-days, `N_wide-t1s4_*` 12,525, 0 differ); the replay's T1 arm equals Phase 1's
day for day.

| Period | T1 mean | C1 (115%, ₹3,000, trail 15/10): vs T1 [90%] | C2 (115%, ₹3,000, trail 25/15, RE): vs T1 [90%] | C1 / C2 max DD | C1 / C2 p5 day | T1 max DD / p5 day |
|---|---|---|---|---|---|---|
| **P2 (decides)**, 238 days | +1,672 | **+24 [−95, +144]** | **+25 [−90, +136]** | 23,110 / 23,110 | −6,805 / −6,805 | 24,435 / −6,340 |
| P1, 184 days | +1,242 | −74 [−239, +105] | −79 [−214, +57] | 25,701 / 26,925 | −8,917 / −8,917 | 25,887 / −8,782 |
| Forward, 13 days | +1,826 | +121 [0, +241] | +9 [0, +18] | 10,479 / 10,479 | −8,628 / −8,628 | 10,479 / −8,628 |
| All 435 days | +1,495 | −15 [−115, +83] | −19 [−104, +66] | 25,701 / 26,925 | −7,974 / −7,767 | 25,887 / −7,573 |

Against arm B (the setting out on non-expiry days, nothing in its place), P2: C1 −31 [−103, +45],
C2 −30 [−104, +46]; all days +3 / −2.

**By the registered rule (P2): C1 and C2 both "no difference".** Return holds (+₹24 / +₹25, the
intervals include zero); the book is not 10% safer: drawdown 5% shallower, 5th-percentile day 7% worse.
Keep T1 as it is.

**Reported, not deciding:**
- Non-expiry picks over all days: T1's SL150% 87 (on 8 days two or more, those days −₹4,208); C1 64
  (one day with two, −₹8,883); C2 72 (5 days with two, −₹3,384).
- For Fri 2026-10-30 (VIX close 15.12, NIFTY 2 to expiry), the C1 and C2 arms both pick
  `S_ditm1-t1s44_0917`, `N_wide_1032` and `N_p100_1032` (Core's 115% / ₹2,500 Widesl, not C1 or C2
  itself) where T1 picks the Dir and two SL150% copies. At a 14.5 open: the NIFTY Dir 09:32 with
  `N_wide-c1_1347` (or `-c2_`) and `N_wide_1347`.

## Result, Amendment 2 (2026-10-29)

`research/bl191/amend2.py`; output `results/amend2.json`, `amend2_daily.json` (git-ignored). The T1 arm
equals Phase 1's day for day.

| Period | T1 mean | D1 (cap every day): vs T1 [90%] | D2 (cap on non-expiry days): vs T1 [90%] | D1 / D2 max DD | D1 / D2 p5 day | T1 max DD / p5 day |
|---|---|---|---|---|---|---|
| **P2 (decides)**, 238 days | +1,672 | **+15 [−43, +65]** | **+40 [+8, +77]** | 23,110 / 23,110 | −6,340 / −6,340 | 24,435 / −6,340 |
| P1, 184 days | +1,242 | −43 [−156, +45] | −3 [−24, +14] | 25,887 / 25,887 | −8,354 / −8,782 | 25,887 / −8,782 |
| Forward, 13 days | +1,826 | 0 (no day capped) | 0 | 10,479 | −8,628 | 10,479 / −8,628 |
| All 435 days | +1,495 | −10 [−68, +39] | +20 [0, +42] | 25,887 / 25,887 | −7,439 / −7,573 | 25,887 / −7,573 |

**By the registered rule (P2): D1 and D2 both "no difference".** Return holds for both; the book is not
10% safer (drawdown 5% shallower, 5th-percentile day unchanged). As registered, the cap touches too few
days to move the risk bar. Keep T1 as it is unless the owner chooses otherwise.

**Reported, not deciding:**
- Days changed: D1 15 of 435 (7 expiry, 8 non-expiry), D2 8. On the changed days D2 gains +₹1,100 on
  average (7 of 8 better: 2026-10-01 +4,326, 2026-09-11 +1,956, 2026-05-29 +1,524,
  2026-06-12 +1,449, 2025-05-02 +1,281; 2025-07-16 −1,914). On expiry days the cap hurts (2025-01-30
  −11,670, 2026-02-03 −5,925): D1's extra expiry days cost more than they save.
- D2 on P2 is the only figure in this item whose interval is wholly above zero (+₹40 [+8, +77]); it is one
  of six arms, the intervals are not adjusted, and the idea came from a post-hoc look at these days.
- Against Amendment 1's C2 arm: D1 −11 / D2 +14 a day on P2, +9 / +40 over all days.
- For Fri 2026-10-30 at a 15.12 open: D1 / D2 keep `S_ditm1-t1s44_0917` and `N_wide-t1s4_1017` and put
  `N_wide_1032` (SL115%, trail 15/10, MTM ₹2,500) in place of `N_wide-t1s4_1032`. At a 14.5 open T1 holds
  one copy only, nothing changes.

## Risks

- The decision period is not truly unseen (above). A pass is a reason to look forward, not proof.
- Removing 25 columns also changes the family-band pools of the ranking for every other Widesl
  variant. That is what production would do, so it is part of the arm.

## Log

- 2026-10-29 — created and pre-registered from the owner's question (Phase 0 committed before any run).
- 2026-10-29 — run (`research/bl191/study.py`), parity with BL-167 exact. P2: A (drop) killed, −₹116 a day [−365, +96]; B (expiry only) no difference, +₹55 [−92, +198], drawdown 1% shallower and the 5th-percentile day worse. T1 stays as it is. Post hoc: the 8 non-expiry days with two or more SL150 copies averaged −₹4,208 (−₹1,148 without); a one-copy cap is a separate registration if wanted.
- 2026-10-29 — after review (PR 388): only P2 carries a verdict in `study.json`; the non-expiry subset compares A only (B equals A there) and gives no drawdown (over non-consecutive days it is not one); the 5th-percentile rule is written by size (`+ 10% of |p5|`), so it cannot flip on a positive base. Figures and verdicts unchanged. Not done: the replay helpers shared with BL-167 are still copied, not moved to `research/common/`.
- 2026-10-29 — Amendment 1 registered before any run (owner): C1 = Core Widesl 115% at a ₹3,000 stop, C2 = `N_wide-t1s4` at 115% and ₹3,000, each in place of `N_wide-t1s4` on non-expiry days.
- 2026-10-29 — Amendment 1 run: engine parity exact (0 of 25,100 slot-days differ). P2: C1 +₹24 a day [−95, +144], C2 +₹25 [−90, +136], both no difference (drawdown 5% shallower, 5th-percentile day 7% worse). T1 stays as it is.
- 2026-10-29 — Amendment 2 registered before any run (owner): at most one `N_wide-t1s4` pick a day (D1 every day, D2 non-expiry days only), as a filter of the same composite.
- 2026-10-29 — Amendment 2 run. P2: D1 (cap every day) +₹15 a day [−43, +65], D2 (non-expiry days) +₹40 [+8, +77]; both no difference by the rule (drawdown 5% shallower, 5th-percentile day unchanged). D2 changes 8 of 435 days, +₹1,100 on them; capping expiry days costs. T1 unchanged pending the owner.
