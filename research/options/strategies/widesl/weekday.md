# Widesl: weekday

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

The day of the week, Monday to Friday (weekend special sessions dropped). No YAML field sets it; a weekday
rule would sit outside the strategy.

**Within one expiry regime, weekday and days to expiry are the same split** (NIFTY Tue = 0 days to
expiry, Mon = 1, Fri = 4, Thu = 5, Wed = 6; SENSEX Thu = 0, Wed = 1, Tue = 2, Mon = 3, Fri = 6). Read
[days to expiry](days-to-expiry.md) for the numbers and caveats; this page only adds what is
weekday-specific.

## Live value

None. The rotation uses a weekday fit as one ranking criterion (25% in the REF weights; see
[rotation ranking](../../common/rotation-ranking.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-056 | Mon–Fri, NIFTY OTM1 and SENSEX OTM2, 11 morning start times | 2025-09-01 → 2026-10-08, 52–55 days a cell, before charges | Descriptive | [BL-056][bl056] |
| BL-060 | Mon–Fri, SENSEX ₹250 / ₹320 / OTM2, 24 start times | same | Descriptive: Thursday best, Monday and Friday negative | [BL-060][bl060] |

₹ per day per lot, family mean ([BL-056][bl056]): NIFTY Mon 190, Tue 673, Wed −73, Thu −39, Fri 40;
SENSEX Mon −204, Tue 426, Wed 51, Thu 264, Fri −191.

## What we know

- Over two years a weekday mixes expiry regimes (NIFTY Thursday → Tuesday, SENSEX Friday → Tuesday →
  Thursday), so a weekday pattern from before Sep 2025 does not carry over. That is why BL-056 restricted
  the tables to one regime.
- Within the regime the weekday table adds nothing beyond days to expiry. Same noise yardstick: under
  about ₹700 a day between cells is not distinguishable.

## Not yet tested

- Any weekday skip or sizing rule. It would need its own pre-registered item (BL-056).

## Related

- [Directional weekday](../directional/weekday.md).
- Tables: `research/bl056/out/{nifty,sensex}_by_weekday.csv` (git-ignored; regenerate with
  `research/bl056/analyse.py`).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl060]: ../../../../backlog/BL-060-sensex-widesl-closest-premium.md
