# Options: the two-session sweep (half-day Widesl and Dir sets)

**Status:** Tested · **Last updated:** 2026-10-29

## What it is

A T1-style sweep for sets with **two entries and two exits** (a morning half and an afternoon half, each its
own set, lot and overall stop): the base grid of ten strikes (ITM3 to OTM3 and three closest premiums) × leg
stop × trail × re-entry, per cohort (wide-stop and tight-stop) and entry slot, simulated once with the
engine's per-minute P&L path recorded; the overall stop and the exit time applied to the paths; winners picked
per band and day type (expiry day, other day) on a selection year only, and tested by an Adaptive replay on
the next year. Code: `packages/option-backtesting/research/common/two_session/`.

## Live value

None: the live and T1 sets are whole-day (09:17 to 15:28 entries, 15:28 exit).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-185][bl185] | 28,800 base variants (360 cells × 20 slots × 2 cohorts × 2 indices); × 12 overall stops × exits 11:30 / 12:00 / 12:30 / 13:00 / 15:28 on the paths; 61 winners selected on 2024-10-09 → 2025-10-08; Adaptive (list C), three picks per pool: T1 as traded (A0), whole-day winners (A1), split three morning + three afternoon (A2), afternoon-only (A3) | selection 251 days, test 250 days (2025-10-09 → 2026-10-27), after charges, per margin lot-day | **A2 fails**: vs A0 −₹260 [−446, −85] net, drawdown −24,579 vs −8,536; vs A1 +₹16 [−201, +224]; A1 − A0 −₹276 [−419, −132] | BL-185 Result |

## What we know

- A split of Adaptive's picks into a morning and an afternoon set does not beat the same sweep's whole-day
  winners (+₹16 [−201, +224], gross +₹99), has a deeper drawdown, and at ₹20 an order is slightly behind:
  BL-182 and BL-184's conclusion again, with tuned sets and Adaptive choosing the slots.
- One year of selection over about 14,400 cells per cohort-slot did not produce a universe as good as T1:
  the sweep's whole-day winners earn ₹276 [−419, −132] a margin lot-day less than T1 as traded. The winners
  transferred at 46 % (selection-year ₹290 → test-year ₹133 a lot-day on average, 51 of 61 still positive);
  whole-day winners on **other days** fell most (NIFTY wide band A +502 → −81), expiry-day winners held about
  70 % (53–54 days, thin).
- By the pick's own index expiry day, per pick: whole-day winners +₹705 on expiry days and +₹75 on other days;
  the afternoon pool +₹338 and +₹243; the morning pool +₹155 and −₹11; T1 as traded +₹975 and +₹326. The
  afternoon set is the part that earns on other days (post-hoc, descriptive).
- The pool matters: Adaptive over T1 picks from Core-298 plus nine tuned settings; the sweep's pools
  contain only the new winners.

## Not yet tested

- **An expiry-aware book:** whole-day sets on expiry days, afternoon-only sets on other days (on the numbers
  above about ₹110 a margin lot-day over the whole-day winners). It comes from the test year, so it needs its
  own registration and the NIFTY 2022-24 days and a forward track.
- **A union universe:** T1 plus the new winners (not a registered arm in BL-185).
- The deferred checks (CSCV PBO, DTE / VIX concentration) on the finalists, the advisory NIFTY 2022-24 run
  and the forward track: all follow a pass, which did not happen.

## Related

- [Widesl › session split](../strategies/widesl/session-split.md), [Directional › session
  split](../strategies/directional/session-split.md) (BL-182 and BL-184, the fixed-file and Adaptive splits).
- [Rotation ranking](rotation-ranking.md) (list C's composite, T1).
- Outputs are git-ignored (`research/bl185/out/`); regenerate with `replay.py`, `diagnostics.py`.

[bl185]: ../../../backlog/BL-185-two-session-sweep.md
