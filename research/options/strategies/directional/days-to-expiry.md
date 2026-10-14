# Directional: days to expiry

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

Calendar days from the trading day to the expiry of the weekly contract being sold: 0 = expiry day, read
from the contract expiries in the lake ([BL-056][bl056]). No YAML field sets it: a days-to-expiry rule
would be a gate or a sizing rule outside the strategy, or an ingredient of the rotation's ranking.

Expiry weekdays in the window: NIFTY Tuesday (Tue = 0, Mon = 1, Fri = 4, Thu = 5, Wed = 6); SENSEX
Thursday (Thu = 0, Wed = 1, Tue = 2, Mon = 3, Fri = 6). Both changed around Aug–Sep 2025, which is why the
window starts 2025-09-01.

## Live value

None: the live Dir trades every day. The forward journal's lists weight a days-to-expiry fit heavily: A 33%, B 35%, C 30%, REF 25%
(`packages/option-backtesting/src/option_backtesting/rotation/lists.py`); in A and B it is one of the
two largest weights. See [rotation ranking](../../common/rotation-ranking.md).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-056 | DTE 0–6, NIFTY and SENSEX Dir **ATM**, family mean over the 11 start times 09:17–11:47 | 2025-09-01 → 2026-10-08, about 53 days a cell, 1 lot, ₹ per day, **before charges** | Descriptive, no verdict | [BL-056][bl056] |
| BL-059 | Same tables for start times 12:02–15:02 | same | Descriptive; morning patterns agree with BL-056 | [BL-059][bl059] |

BL-056's Result prints the Dir row by weekday only. Mapped to days to expiry, ₹ per day per lot:

| NIFTY Dir ATM | DTE 0 (Tue) | 1 (Mon) | 4 (Fri) | 5 (Thu) | 6 (Wed) |
|---|---|---|---|---|---|
| ₹ per day | 602 | 563 | 355 | 392 | −67 |

| SENSEX Dir ATM | DTE 0 (Thu) | 1 (Wed) | 2 (Tue) | 3 (Mon) | 6 (Fri) |
|---|---|---|---|---|---|
| ₹ per day | 436 | 213 | 829 | 260 | 318 |

For NIFTY Widesl the printed days-to-expiry row differs a little from its weekday row (616 vs 673 on expiry
day), so these mapped Dir figures are close to, not equal to, the Dir days-to-expiry table in
`research/bl056/out/`.

## What we know

- **NIFTY Dir is strongest on expiry day and the day before** (₹602, ₹563), positive 4–5 days out, and
  negative only 6 days out (Wednesday, the day after expiry). Unlike Widesl, it does not fade steadily.
- **SENSEX Dir peaks two days before expiry** (Tuesday, ₹829) and is positive on every day.
- **All of it is inside the noise.** A weekday cell's standard error is roughly ₹300–400 a day, so gaps
  under about ₹700 are not distinguishable. NIFTY's largest gap (DTE 0 vs 6, ₹669) and SENSEX's (DTE 2 vs
  1, ₹616) are both under it. About 1,100 cells were looked at; the two indices share market days.
- SENSEX Dir keeps NIFTY's rupee stops on a smaller lot, so its rupee figures are not comparable with
  NIFTY's.
- As a ranking ingredient (all families pooled) the days-to-expiry fit is small and unstable; the
  evidence is on the [Widesl days-to-expiry page](../widesl/days-to-expiry.md) and in
  [rotation ranking](../../common/rotation-ranking.md).

## Not yet tested

- A pre-registered DTE gate or sizing rule for Dir (for example: more lots at DTE ≤ 1, none at DTE 6),
  judged on days not used to find it.
- The NIFTY 2022–24 hold-out (Thursday expiry then): Dir ATM results for those days exist from BL-071 and
  Dir ITM1 from BL-080, so it needs analysis, not new backtests. Check the expiry weekday per day first
  (BL-071's caveat and BL-056's Log disagree on when it changed).
- Dir **ITM1** by days to expiry (BL-056 ran ATM only); the earlier regime 2024-10 → 2025-08.

## Related

- [Weekday](weekday.md); [Widesl days to expiry](../widesl/days-to-expiry.md).
- Tables: `research/bl056/out/{nifty,sensex}_by_dte.csv`, `research/bl059/out/` (git-ignored; regenerate
  with `research/bl056/analyse.py`, `research/bl059/analyse.py`).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
