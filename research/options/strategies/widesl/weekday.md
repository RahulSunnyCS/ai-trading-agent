# Widesl: weekday

**Status:** Descriptive · **Last updated:** 2026-11-12

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
| BL-159 read 8 (Monday group) | Mondays vs the other days, the live Widesl OTM1 09:17 (stored rotation results, gross per lot) | NIFTY, 2024-10-09 → 2026-10-08 | Screen, **no lead**: Monday was not a skip for both base strategies (bar: mean in group minus out of group of −₹500 or worse with t ≤ −2 for both) | [BL-159][bl159] |
| BL-221 | Fridays vs the other weekdays, every Widesl in Core-298 (closest premium included) and T1's extras, by session window, exit, premium, entry time; three expiry regimes | 2024-10-09 → 2026-11-12 (2026-11-06 left out), replayed at 0.5 % slippage, means over sessions | Descriptive | [BL-221][bl221] |
| BL-220 Phase 1 | Fridays vs the other weekdays, BL-071's NIFTY variants (Widesl among them) | NIFTY 2022-04-05 → 2024-10-08, 618 sessions, gross at 0 % slippage (hold-out) | Registered mechanism test: pass (all 124: gap ₹111, p 0.012) | [BL-220][bl220] |

₹ per day per lot, family mean ([BL-056][bl056]): NIFTY Mon 190, Tue 673, Wed −73, Thu −39, Fri 40;
SENSEX Mon −204, Tue 426, Wed 51, Thu 264, Fri −191.

## What we know

- **Fridays on NIFTY 2022–24 (BL-220 Phase 1, hold-out).** Over BL-071's NIFTY variants (2022-04 → 2024-10, Thursday
  expiry, gross at 0 % slippage), Widesl on a Friday made ₹46 ± 81 a strategy-day against ₹60–318 on the other
  weekdays; all 124 variants ₹81 against ₹192, a registered pass (gap ₹111, p 0.012). Monday, also far from
  expiry, was nearly as weak (₹103).
- **Fridays (BL-221).** Far from expiry (Jan 2025 on), Widesl on a Friday nets about the other days' level or a
  little below: NIFTY +₹44 ± 113 against +₹97 ± 52, SENSEX −₹37 ± 109 against +₹4 ± 54 (Core-298, a strategy-day at
  one lot, 0.5 % slippage, before brokerage; under 0.5 SE). The gap sits in 13:00 to the close (NIFTY +₹30 against
  +₹111) and in early starts (09:17–10:00: −₹211 / −₹270 against +₹213 / +₹137, wide bands). Friday Widesl hits its
  leg SL less (1–3 % of trades against 9 %) and runs to the time exit more; more premium is sold (SENSEX median 621
  against 524 points) for the same fractional decay. Descriptive, already-read days.
- Over two years a weekday mixes expiry regimes (NIFTY Thursday → Tuesday, SENSEX Friday → Tuesday →
  Thursday), so a weekday pattern from before Sep 2025 does not carry over. That is why BL-056 restricted
  the tables to one regime.
- Within the regime the weekday table adds nothing beyond days to expiry. Same noise yardstick: under
  about ₹700 a day between cells is not distinguishable.
- **Calendar groups (BL-159 read 8, a screen over seven groups and both base strategies).** Widesl did
  *better*, not worse, on scheduled-event days (RBI decision days, the two Budget days and the Indian session
  after a Fed decision): +₹1,774 a lot-day against the rest, Welch t 1.98 (about p 0.05 before any
  correction, one of about 30 tests; the item's quoted shuffle p of 0.002 is too small because the small
  event group is much more volatile than the rest). A handful of big days carry it: without the Budget days
  +₹1,587 (t 1.81), also without the best day (2025-04-09, +₹15,122) +₹1,095 (t 1.46). Those same 2024–26
  days are what BL-146 (PR #306) read for RBI days, so this is a second look at one sample, not
  corroboration. A follow-up has to use days neither item has read (NIFTY 2022–24).

## Not yet tested

- Any weekday skip or sizing rule. It would need its own pre-registered item (BL-056).

## Related

- [Directional weekday](../directional/weekday.md).
- Tables: `research/bl056/out/{nifty,sensex}_by_weekday.csv` (git-ignored; regenerate with
  `research/bl056/analyse.py`).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl159]: ../../../../backlog/BL-159-eight-poc-reads.md
[bl060]: ../../../../backlog/BL-060-sensex-widesl-closest-premium.md
[bl221]: ../../../../backlog/BL-221-friday-by-family.md
[bl220]: ../../../../backlog/BL-220-friday-size-down.md
