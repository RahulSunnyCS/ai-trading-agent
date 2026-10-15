# Buy: weekday

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

The day of the week. Not a setting: Buy trades every day. The question is whether some weekdays are
reliably better, for a skip rule or for the rotation's weekday criterion.

## Live value

Trades every day. The rotation lists weight a weekday fit at 25–36% of the composite
([rotation ranking](../../common/rotation-ranking.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-056 | Monday to Friday (weekend sessions dropped) | 2025-09-01 → 2026-10-08, 52–55 days a cell, 11 start times 09:17–11:47, before charges | Descriptive | [BL-056][bl056] |
| BL-059 | Same tables for the 13 later start times | same window | Descriptive; agrees with BL-056 for morning starts | [BL-059][bl059] |

Buy family mean ₹ per day per lot:

| Index | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| NIFTY (expiry Tue) | −88 | −43 | 64 | 287 | −6 |
| SENSEX (expiry Thu) | −17 | −17 | 87 | 61 | 56 |

## What we know

- In this window weekday and days to expiry are the same split (one expiry weekday per index), so this
  page and [days to expiry](days-to-expiry.md) read the same cells.
- The spread between cells (−₹88 to +₹287) is inside BL-056's noise yardstick: a cell's standard
  error is about ₹300–400 a day, so differences under about ₹700 cannot be told apart.
- The weekday criterion inside the rotation is a different matter: it ranks all strategies together
  and was tested there (label shuffles, hold-out; see [rotation ranking](../../common/rotation-ranking.md)).
- Before charges, one year, already seen.

## Not yet tested

- The earlier expiry regime (2024-10-09 → 2025-08-31), left for later by BL-056.

## Related

- [Widesl weekday](../widesl/weekday.md), [Directional weekday](../directional/weekday.md).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
