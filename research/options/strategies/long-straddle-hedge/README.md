# Long straddle as a hedge for the base

**Status:** Tested — killed · **Last updated:** 2026-10-14

## What it is

Buy one NIFTY ATM call and one ATM put at 09:16 on the nearest weekly expiry, hold both to 15:28, no
stops, trail, VIX or breakout filter. The idea (owner, 2026-10-12): a two-sided long-volatility sleeve
should pay on the days fast moves hurt the short-premium book. Files:
`packages/option-backtesting/research/bl101/nifty_long_straddle_916.yaml` and, as a registered
variant, `nifty_long_strangle_otm4_916.yaml` (OTM4 call and put, same times).

It is not the Buy breakout: no range, no stop, and it always trades.

## Live value

Not live; not in the rotation universe.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-101 | 1 lot ATM straddle added to the base (2 lots as sensitivity) | NIFTY, 2024-01-01 → 2026-10-09, 680 sessions, after charges (BL-096 model), slippage 0 / 1% / 2% | **Killed**: all four registered rules fail | [BL-101][bl101] |
| BL-101 Phase 0b | 1 lot OTM4 strangle instead (owner's override, second trial) | same | **Killed**: all four rules fail | [BL-101][bl101] |

The base is the journal's fixed base: 2 × NIFTY Widesl OTM1 09:17 + 1 × Dir ATM 09:24
([BL-058][bl058]). Pass required B+L to cut the base's 95% expected shortfall (ES95) and maximum
drawdown by at least 15% each, to beat a carry-matched smaller base on both, in both halves, and
under 2% slippage.

Net of charges, slippage 0 ([BL-101][bl101]; OTM4 row from the committed `research/bl101/report_otm4.txt`):

| | Mean / day | ES95 | Max drawdown | Worst day |
|---|---|---|---|---|
| B (base) | 829 | −9,831 | −1,24,096 | −11,407 |
| B + ATM straddle | 263 | −12,874 | −1,73,423 | −20,572 |
| B + OTM4 strangle | 406 | −11,757 | −1,64,776 | −17,668 |
| 0.75 × B | 622 | −7,373 | −93,072 | −8,555 |
| ATM straddle alone | −566 | −9,783 | −4,21,202 | −25,500 |
| OTM4 strangle alone | −423 | −6,358 | −3,18,649 | −18,823 |

## What we know

- The straddle correlates −0.46 with the base (strangle −0.42) but pays too little on the bad days:
  +₹277 on average on the base's worst 5% of days (+₹1,962 on the worst 10) against −₹566 a day of
  carry. The strangle averages −₹4 on the base's worst 5%.
- Adding it makes both tail measures worse (ES95 −31%, drawdown −40% for the straddle), in both halves
  and every year. Simply running less of the base (0.75 B) gives a better tail.
- With 1% slippage on every fill the base itself turns negative (−₹57 a day; −₹1,033 at 2%,
  `report_otm4.txt`), so the carry-matched comparator degenerates to cash. That is a warning about
  the base's own sensitivity to fills, not only about the hedge.
- The base's own rules were picked in-sample on part of this window, so only the with / without
  difference is evidence.

## Not yet tested

Needs a dated `override:` in BL-101 to run: smaller straddle sizes (1 lot is about a ₹20k premium
against a base whose worst day is about ₹11k), a conditional entry, other strike depths.

## Related

- [Correlation](../../common/correlation.md) (why a negatively correlated sleeve was expected to
  help), [Buy breakout](../buy-breakout/README.md) (the conditional long-option family),
  [charges](../../common/charges.md).
- Scripts and outputs (committed): `research/bl101/run.py`, `report.txt`, `report_otm4.txt`,
  `daily.csv`, `daily_otm4.csv`.

[bl058]: ../../../../backlog/BL-058-options-rotation-forward-journal-and-ui.md
[bl101]: ../../../../backlog/BL-101-early-long-straddle-hedge.md
