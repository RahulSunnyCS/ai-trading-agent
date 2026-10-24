# Widesl with bought wings (iron condor), for margin

**Status:** Descriptive · **Last updated:** 2026-10-24

## What it is

The live NIFTY Widesl OTM1 09:17 file with a bought CE and a bought PE added, one lot each, no stops on the
wings, everything else unchanged. The idea (BL-159 read 6): the wings cost a small part of the premium and
cut the margin by more, so the **return on margin** rises even if rupees per lot fall. Wings at **OTM4** (150
points beyond the sold strike at a 50-point step) and **OTM6** (250 points). Run through the legwise engine
with BL-063 charges, no slippage, `lot_sizing: current` (NIFTY 65). The symmetric Widesl re-run through the
same engine is the control. Script: `packages/option-backtesting/research/bl159/engine_runs.py`.

## Live value

Not live; not in the rotation universe. The live Widesl has no wings.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-159 read 6 | Widesl OTM1 09:17 + wings at OTM4 and at OTM6 vs the naked file | NIFTY, 2024-10-09 → 2026-10-08, 489 engine days, after BL-063 charges, no slippage | Screen, **no lead** (bar: net ÷ margin at least 50% above the naked file's, with the condor's own mean-net t ≥ 2) | [BL-159][bl159] |

| ₹ net per day | Mean | t |
|---|---|---|
| Naked Widesl (control) | +270 | 2.00 |
| Condor, OTM4 wings | −146 | −1.62 |
| Condor, OTM6 wings | −22 | −0.24 |

## What we know

- **The wings lose money.** The OTM4 condor averages −₹146 a day (t −1.62) and the OTM6 condor −₹22
  (t −0.24), against +₹270 (t 2.00) for the naked file on the same days. With the assumed margins the
  condors' return on margin is negative, so the margin saving cannot rescue them.
- **The margin is assumed, not measured.** The naked file takes the reference row's ₹1,40,000 a lot
  (`reference/margin.csv`, the one NIFTY short-straddle row); a hedged side takes its maximum loss, width ×
  lot, so a condor's margin is 2 × width × 65 × 1.25 (OTM4 ₹24,375, OTM6 ₹40,625). It is not SPAN. A real
  figure from AlgoTest's margin calculator would replace it before anything is acted on; the read rests on
  the naked-to-hedged margin ratio.
- **Drawdown is large against the assumed margin:** the condors' maximum drawdown is 1.3 to 3.8 times their
  margin.
- One screen on one index and two years, among about 30 tests in the item. A negative result here is on the
  stated margins only.

## Not yet tested

- Other wing distances, wings with stops, SENSEX, the 2022–24 period (locked in BL-159).
- The real margin of the naked and hedged positions.

## Related

- [Long straddle hedge](../long-straddle-hedge/README.md) (a long hedge on the base, killed);
  [overnight straddle](../overnight-straddle/README.md) (hedged with OTM6 wings, killed);
  [Widesl strike and premium](../widesl/strike-premium.md); [charges](../../common/charges.md).
- Scripts: `research/bl159/engine_runs.py` and `report.py`; outputs git-ignored, regenerate with them.

[bl159]: ../../../../backlog/BL-159-eight-poc-reads.md
