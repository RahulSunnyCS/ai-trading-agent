# Options: closing the directional strategies at 14:55 instead of 15:28

**Status:** Tested (re-scored, not forward) · **Last updated:** 2026-10-21

## What it is

The owner's idea ([BL-147][bl147]): after about 15:00 the market often turns around a little, which can eat
into a directional position, so close the Dir-family strategies (Dir ATM and Dir ITM1: short ATM or ITM1 CE
and PE, 21% stop per leg, one re-entry at cost, ₹3,000 overall stop) at 14:55. Tested by rerunning each
variant with only the exit time changed and comparing with its stored 15:28 result, per lot, gross, no
charges. The harness was checked first: 4,025 unchanged reruns reproduced the stored results exactly.

- **A, the picks:** every Dir pick of T1 (360 pick-days) and Core (350), 2025-01-10 to 2026-10-19 (the
  journal's entry where it has one, else re-scored). T1's picks up to 2025-10-08 are in-sample for its
  settings.
- **B, breadth:** all 161 Dir variants (Core-298's `N_dir`, `N_ditm1`, `S_dir`, `S_ditm1` and T1's `N_dir`,
  `N_ditm1`, `S_ditm1` relatives) over 79,396 variant-days, 2024-10-09 to 2026-10-19.

## Live value

None. The directional strategies exit at 15:28 as before.

## Tested

Pre-registered (BL-147 Phase 0) before any figure. Delta = result with the 14:55 exit minus the 15:28 result.

| Population | Mean delta per trade-day [90%] | Share of days up | Total, 15:28 → 14:55 | Max drawdown, 15:28 → 14:55 |
|---|---|---|---|---|
| A pooled (T1 + Core), 710 pick-days | **−122 [−168, −76]** | 31% | +₹436,602 → +₹350,112 | −₹33,379 → −₹41,322 |
| A, T1 only | −141 | 31% | | |
| A, Core only | −102 | 30% | | |
| T1 inside its selection window / after it | −96 / −174 | | | |
| B, all 161 variants | −103 | | | |

Every family loses: Dir ATM (Core, Nifty) −88, Dir ITM1 (Core, Nifty) −115, Sensex Dir ATM −85, Sensex ITM1
−103, T1's directional relatives −110. **0 of 161 variants** have a positive mean delta. The 14:55 exit
changed the result on 83% to 89% of trade-days (the legs were still open).

Verdict under the registered rule: **closing at 14:55 hurts.** The interval of the mean delta is entirely below
zero, the drawdown is deeper and no variant improves.

**The owner's pattern** (down day = NIFTY or Sensex down 0.3% or more from the open to 14:55; recovery = a
rally of 0.1% or more after that):

| Day type (A: pick-days) | Share of NIFTY days | Pick-days | Mean delta |
|---|---|---|---|
| Down day, then a recovery | 8.9% | 52 | **+219** |
| Down day, no recovery | | 178 | −228 |
| Up day, then a fade | 7.3% | 58 | **+217** |
| Up day, no fade | | 140 | −202 |
| Flat day | | 282 | −148 |

## What we know

Descriptive; leads, not findings.

- **The owner's instinct is right on those days, but they are rare.** When a down day recovers late, an early
  exit saves about ₹219 per trade; when a day fades late, about ₹217. These patterns are about 9% and 7% of
  days.
- **On the other 80% of days the early exit costs ₹150 to ₹230 per trade.** The legs are short options that
  keep decaying until the close, and a day that keeps going in the same direction is where the stops, not
  the last 33 minutes, decide the result.
- **Knowing the trend at 14:55 does not rescue it.** The trend is known by then, but only about 1 down day
  in 4 recovers: all down days together average −127 per trade and all up days −79. An exit that applied only
  on down days would still lose. (Read from the registered table; a conditional exit rule was not tested.)
- **It makes no difference whether the trade was winning.** Delta is about −101 (Core) and −140 (T1) both for
  trades in profit and in loss at 14:55.

## Open questions

- Whether a tighter version, such as moving the stop up after 14:55 or taking profit only in recovery-prone
  conditions, adds value. Not tested; the exit time alone does not.
- Whether the last 33 minutes behave the same on expiry days, where decay is fastest. Not split here.

[bl147]: ../../../backlog/BL-147-directional-early-exit.md
