# Buy: days to expiry

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

Calendar days from the trading day to the weekly contract's expiry (0 = expiry day). Not a setting:
every Buy file trades the nearest weekly (`expiry: weekly`) every day. The question is whether Buy does
better on some days of the expiry week, which a day filter or the rotation's days-to-expiry criterion
could use.

## Live value

Trades every day; no days-to-expiry filter. The rotation lists weight a days-to-expiry fit at 25–35%
of the composite ([rotation ranking](../../common/rotation-ranking.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-056 | Days to expiry 0–6 (7+ pooled), from the lake's contract expiries | 2025-09-01 → 2026-10-08 (one expiry regime per index), 11 start times 09:17–11:47, before charges | Descriptive; about 1,100 cells looked at | [BL-056][bl056] |
| BL-059 | Same tables for the 13 later start times | same window | Descriptive; agrees with BL-056 for morning starts | [BL-059][bl059] |

In this window NIFTY expired every Tuesday and SENSEX every Thursday, so weekday and days to expiry are
the same split ([BL-056][bl056]). NIFTY Buy, family mean ₹ per day per lot, read from its weekday row
(Tue = 0, Mon = 1, Fri = 4, Thu = 5, Wed = 6 days):

| Days to expiry | 0 | 1 | 4 | 5 | 6 |
|---|---|---|---|---|---|
| NIFTY Buy | −43 | −88 | −6 | 287 | 64 |

SENSEX Buy by weekday (Thursday is expiry day): Mon −17, Tue −17, Wed 87, Thu 61, Fri 56.
Holiday weeks shift a few days between cells; the exact per-day-to-expiry cells are in
`research/bl056/out/{nifty,sensex}_by_dte.csv` (git-ignored; regenerate with `research/bl056/analyse.py`).

## What we know

- No cell is clearly different. BL-056 puts a weekday cell's standard error at about ₹300–400 a day,
  so differences under about ₹700 are noise; the NIFTY 5-days-out cell (+₹287) is inside that.
- NIFTY Widesl shows a steady fall away from expiry (₹616 → −₹52); Buy shows no matching mirror
  image.
- All figures are before charges, on one year already used to build the rotation.

## Not yet tested

- A days-to-expiry rule for Buy, pre-registered, on 2022–24 NIFTY.
- The earlier expiry regime (2024-10-09 → 2025-08-31), which BL-056 left for later.

## Related

- [Widesl days to expiry](../widesl/days-to-expiry.md), [Directional days to expiry](../directional/days-to-expiry.md),
  [weekday](weekday.md), [rotation ranking](../../common/rotation-ranking.md).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
