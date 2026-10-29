# BL-191 — T1 without its SL150% NIFTY Widesl (or with it on expiry days only)

| | |
|---|---|
| **Priority** | P1 — the owner trades T1 with real money and is uneasy about this setting |
| **Status** | In progress |
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

### Phase 1 — Replay and read-out

- **Tasks:** `research/bl191/study.py` (reuses BL-167's replay), `--check` smoke, full run, figures here.
- **Deliverables:** `research/bl191/results/study.json` (git-ignored), the Result section below, the
  findings page `research/options/strategies/widesl/leg-sl.md` row, TODO and INDEX.
- **Done when:** the rule above is applied and recorded.

## Risks

- The decision period is not truly unseen (above). A pass is a reason to look forward, not proof.
- Removing 25 columns also changes the family-band pools of the ranking for every other Widesl
  variant. That is what production would do, so it is part of the arm.

## Log

- 2026-10-29 — created and pre-registered from the owner's question (Phase 0 committed before any run).
