# Directional: weekday

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

The day of the week, Monday to Friday (weekend special sessions dropped). No YAML field sets it.

**Within one expiry regime, weekday and days to expiry are the same split** (NIFTY Tue = 0 days to
expiry, Mon = 1, Fri = 4, Thu = 5, Wed = 6; SENSEX Thu = 0, Wed = 1, Tue = 2, Mon = 3, Fri = 6). Read
[days to expiry](days-to-expiry.md) for the numbers and caveats.

## Live value

None. The rotation uses a weekday fit as one ranking criterion
([rotation ranking](../../common/rotation-ranking.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-056 | Mon–Fri, NIFTY and SENSEX Dir ATM, 11 morning start times | 2025-09-01 → 2026-10-08, 52–55 days a cell, before charges | Descriptive | [BL-056][bl056] |

₹ per day per lot, family mean ([BL-056][bl056]): NIFTY Mon 563, Tue 602, Wed −67, Thu 392, Fri 355;
SENSEX Mon 260, Tue 829, Wed 213, Thu 436, Fri 318.

## What we know

- Over two years a weekday mixes expiry regimes, so a weekday pattern from before Sep 2025 does not carry
  over; BL-056 kept one regime for that reason.
- Within the regime the weekday table adds nothing beyond days to expiry. Gaps under about ₹700 a day are
  noise.

## Not yet tested

- Any weekday skip or sizing rule (would need its own pre-registered item, BL-056).

## Related

- [Widesl weekday](../widesl/weekday.md).
- Tables: `research/bl056/out/{nifty,sensex}_by_weekday.csv` (git-ignored; regenerate with
  `research/bl056/analyse.py`).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
