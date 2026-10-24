# Options: closing the directional strategies at 14:55 instead of 15:28

**Status:** Tested (re-scored, not forward) · **Last updated:** 2026-10-24

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
changed the result on 82% to 89% of trade-days (the legs were still open).

Verdict under the registered rule: **closing at 14:55 hurts.** The interval of the mean delta is entirely below
zero, the drawdown is deeper and no variant improves.

**The owner's pattern** (down day = NIFTY or Sensex down 0.3% or more from the open to 14:55; recovery = a
rally of 0.1% or more after that):

| Day type (A: pick-days) | Share of NIFTY days | Pick-days | Mean delta |
|---|---|---|---|
| Down day, then a recovery | 8.9% | 52 | **+219** |
| Down day, no recovery | | 178 | −228 |
| Up day, then a fade | 7.3% | 58 | **+217** (picks only; B's fade days average −64) |
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
  on down days would still lose. (Read from the registered table; the conditional exit actually run is the
  post-hoc addendum below.)
- **It makes no difference whether the trade was winning.** Delta is about −101 (Core) and −140 (T1) both for
  trades in profit and in loss at 14:55.

## Addendum: exit at 14:55 only when the index is down 0.6% or more

**Post-hoc, exploratory.** Phase 0 listed "conditioning an exit on the trend" under "Will not run", no owner
`override:` line was recorded when this ran, and the idea came after the owner had seen the down-day breakdown
on the same data. The owner should confirm or retract it (BL-147 Log, 2026-10-24).

Its rule was registered before its own figures were computed (BL-147 Log, 2026-10-21): a Dir strategy exits at 14:55 only if its own
index (Nifty for the N variants, Sensex for the S variants) is down 0.6% or more from the open to 14:55, and
holds to 15:28 otherwise. Computed from the same 14:55 reruns.

| Down 0.6% or more | From the open | From the previous close |
|---|---|---|
| Variant-days that trigger | 15.4% | 20.2% |
| Picks (T1 + Core): triggered pick-days (days) | 101 (54) | 143 (75) |
| Mean change per triggered pick-day [90%] | **−153 [−336, +15]** | **−222 [−341, −108]** |
| Total of the picks, hold → conditional | +₹436,602 → +₹421,178 | → +₹404,791 |
| Max drawdown, hold → conditional | −₹33,379 → −₹45,260 | → −₹43,590 |
| Dir variants with a positive mean on triggered days | 2.5% (4 of 161) | 0% |
| T1 / Core mean change | −233 / −68 | −265 / −177 |

Verdict under the registered rule: **not better.** From the open the interval just reaches zero (+15) but
the mean is negative, the drawdown is deeper and only 4 of 161 variants gain; from the previous close the
interval is entirely below zero. Even on days when the index is down 0.6% or more by 14:55, holding to the
close did better on average: only about a quarter of those triggered trades improved by exiting.

## Caveats from the 2026-10-24 review

No number above was changed. The drawdown figures come from a function that drops the zero starting peak
(`run.py:190-192`), so they can be understated; the verdicts do not depend on them (the "hurts" verdict rests
on the mean-delta interval, and the addendum fails two conditions regardless). The "from the previous close"
reading skips the weekend Budget sessions. Details: BL-147 Log. Earlier evidence that a 14:50 or 15:00 exit is
worse after charges: [BL-096][bl096] ([directional exit time](../strategies/directional/exit-time.md)). The
result files (`research/bl147/out/`) are git-ignored; regenerate with `research/bl147/run.py` then
`conditional.py` (needs the TradingData volume).

## Open questions

- Whether a tighter version, such as moving the stop up after 14:55 or taking profit only in recovery-prone
  conditions, adds value. Not tested; the exit time alone does not.
- Whether the last 33 minutes behave the same on expiry days, where decay is fastest. Not split here.

[bl147]: ../../../backlog/BL-147-directional-early-exit.md
[bl096]: ../../../backlog/BL-096-directional-parameter-sweep.md
