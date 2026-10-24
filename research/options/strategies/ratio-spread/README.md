# Ratio spread (long ATM, short two further out)

**Status:** Descriptive · **Last updated:** 2026-10-24

## What it is

A payoff not run elsewhere in this repo (BL-159 read 7): buy 1 ATM CE and 1 ATM PE, sell 2 CE and 2 PE
further out, at **OTM2** (variant A) or **OTM3** (variant B). It keeps the premium of a quiet day, and the
ATM leg pays on a trend until the short strikes. Entry 09:24, exit 15:28, ₹3,000 overall stop, no leg stops,
`square_off: partial`. Run through the legwise engine with BL-063 charges, no slippage, NIFTY lot 65. The
comparator is the base Dir ATM 09:24 re-run through the same engine on the same days. Script:
`packages/option-backtesting/research/bl159/engine_runs.py`.

## Live value

Not live; not in the rotation universe.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-159 read 7 | Ratio spread A (OTM2 shorts) and B (OTM3 shorts), each against zero | NIFTY, 2024-10-09 → 2026-10-08, 489 engine days, after BL-063 charges, no slippage | Screen, **no lead** (bar: t of at least 2 with the hypothesised sign) | [BL-159][bl159] |

| ₹ net per day | Mean | t |
|---|---|---|
| Ratio spread A (OTM2) | +182 | 1.45 |
| Ratio spread B (OTM3) | +55 | 0.49 |
| Base Dir ATM 09:24, same days | +268 | 2.10 |

## What we know

- Neither variant clears the bar, and both earn less than the Dir ATM file they were compared against on the
  same days (+₹268, t 2.10). The nearer short strikes (OTM2) did better than the further ones (OTM3).
- One screen on one index and two years, among about 30 tests in the item, so a miss here is a weak
  negative and a hit would have been a lead only.

## Not yet tested

- Other short distances, other entry times or stops, SENSEX, the 2022–24 period (locked in BL-159).
- The margin of the position, which was not estimated.

## Related

- [Directional](../directional/README.md) (the comparator);
  [Widesl with bought wings](../condor/README.md); [charges](../../common/charges.md).
- Scripts: `research/bl159/engine_runs.py` and `report.py`; outputs git-ignored, regenerate with them.

[bl159]: ../../../../backlog/BL-159-eight-poc-reads.md
