# Options: holiday-shifted expiry days

**Status:** Tested · **Last updated:** 2026-10-18

## What it is

When a weekly expiry falls on a holiday its expiry moves to the previous trading day (NIFTY: 13 times
since 2022 and 7 for SENSEX, for example the Dussehra move to Monday 19 Oct 2026). The rotation never
looks at whether an expiry was moved. [BL-121][bl121] asks whether the strategies, and Adaptive on
Core-298 and on T1, earn less on those days than on ordinary expiry days of the same index.

## Live value

None. Nothing in the rotation reads it.

## Tested

Moved minus normal expiry days, gross ₹ per lot-day, 90 % bootstrap interval (5,000 resamples).

| Question | Moved days | Moved minus normal | Reading |
|---|---|---|---|
| Adaptive on Core-298, 2025-01-10 → 2026-10-16 | 11 (6 NIFTY, 5 SENSEX) | +217 [-1,014, +1,618] | Inconclusive |
| Adaptive on T1, same window | 11 | +457 [-1,057, +2,021] | Inconclusive |
| NIFTY Widesl, 2022 → 2026 | 12 | +277 [-201, +732] | Inconclusive |
| NIFTY Dir | 12 | +175 [-173, +543] | Inconclusive |
| NIFTY Buy | 12 | -167 [-340, +12] | Inconclusive |
| All NIFTY variants | 12 | +95 [-157, +328] | Inconclusive |

## What we know

Leads, not findings.

- No evidence that moved expiry days earn less; also no evidence that they earn the same or more. The
  intervals are about ±₹1,000 to 1,500 for Adaptive because there are only 11 such days.
- One day, NIFTY 2025-04-09 (+₹8,506 for Adaptive), carries most of the NIFTY moved-day mean. Without it
  the other five NIFTY moved days average about +₹188 against ₹507 on normal expiry days.
- NIFTY Buy is the only family whose point estimate is clearly negative (-₹167), with an interval that just
  reaches zero.

## Not yet tested

- Whether the rotation should treat a moved expiry day differently (a new registered test).
- Monday 2026-10-19, the live forward event, is read out after the day.

## Related

- [Rotation ranking](rotation-ranking.md) (the days-to-expiry fit), [BL-111](../../../backlog/BL-111-range-regime-strategy-mix.md)
  (the expiry-day basket arm).
- Scripts: `packages/option-backtesting/research/bl121/` (`events.py`, `moved_expiry.py`) and their JSON.

[bl121]: ../../../backlog/BL-121-moved-expiry-days.md
