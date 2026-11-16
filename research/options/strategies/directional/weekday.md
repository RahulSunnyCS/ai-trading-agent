# Directional: weekday

**Status:** Descriptive · **Last updated:** 2026-11-12

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
| BL-159 read 8 (Monday group) | Mondays vs the other days, the base Dir ATM 09:24 (stored rotation results, gross per lot) | NIFTY, 2024-10-09 → 2026-10-08 | Screen, **no lead**: Monday was not a skip for both base strategies (bar: mean in group minus out of group of −₹500 or worse with t ≤ −2 for both) | [BL-159][bl159] |
| BL-221 | Fridays vs the other weekdays, every Dir ATM and Dir ITM1 in Core-298 and T1's extras, by session window, exit, premium, entry time; three expiry regimes | 2024-10-09 → 2026-11-12 (2026-11-06 left out), replayed at 0.5 % slippage, means over sessions | Descriptive | [BL-221][bl221] |
| BL-220 Phase 1 | Fridays vs the other weekdays, BL-071's NIFTY variants (Dir ATM among them) | NIFTY 2022-04-05 → 2024-10-08, 618 sessions, gross at 0 % slippage (hold-out) | Registered mechanism test: pass (all 124: gap ₹111, p 0.012) | [BL-220][bl220] |

₹ per day per lot, family mean ([BL-056][bl056]): NIFTY Mon 563, Tue 602, Wed −67, Thu 392, Fri 355;
SENSEX Mon 260, Tue 829, Wed 213, Thu 436, Fri 318.

## What we know

- **Fridays on NIFTY 2022–24 (BL-220 Phase 1, hold-out).** NIFTY Dir ATM on a Friday made ₹214 ± 76 a strategy-day,
  mid-table (Monday ₹2, Thursday expiry ₹469); the all-variant Friday shortfall there came from Widesl, unlike
  2025–26 where it is the SENSEX Dirs (BL-221).
- **Fridays (BL-221).** The Friday shortfall is mostly Dir on SENSEX: far from expiry (Jan 2025 on) Dir ITM1 SENSEX
  nets +₹1 ± 107 a strategy-day on Fridays against +₹199 ± 53 on other days (about 1.7 SE), Dir ATM SENSEX +₹2 against
  +₹154; the NIFTY Dirs about ₹50–67 lower (under 0.5 SE). It sits in 13:00 to the close (Dir ITM1 SENSEX −₹66
  against +₹152) and in late starts; early Dir (09:17–10:00) was not worse on Fridays. Friday Dir hits its leg SL
  less (36–41 % of trades against 49–54 %) and re-enters less. Descriptive,
  already-read days; BL-220 tests a Friday rule on unseen days.
- Over two years a weekday mixes expiry regimes, so a weekday pattern from before Sep 2025 does not carry
  over; BL-056 kept one regime for that reason.
- Within the regime the weekday table adds nothing beyond days to expiry. Gaps under about ₹700 a day are
  noise.
- **Calendar groups (BL-159 read 8).** No calendar group met the skip bar for both base strategies. Dir did
  better, not worse, on the trading day *before a holiday*: +₹1,175 against other days (t 1.87, one of
  about 30 tests; descriptive). BL-159 lists the Fed-morning days as a Dir 09:24 test: −₹208, t −0.31
  over 15 days; the RBI days as a Dir 10:02 test: +₹119, t 0.14 over 13 days (both no lead, thin).

## Not yet tested

- Any weekday skip or sizing rule (would need its own pre-registered item, BL-056).

## Related

- [Widesl weekday](../widesl/weekday.md).
- Tables: `research/bl056/out/{nifty,sensex}_by_weekday.csv` (git-ignored; regenerate with
  `research/bl056/analyse.py`).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl159]: ../../../../backlog/BL-159-eight-poc-reads.md
[bl221]: ../../../../backlog/BL-221-friday-by-family.md
[bl220]: ../../../../backlog/BL-220-friday-size-down.md
