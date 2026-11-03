# Options: correlation between strategies

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

How the strategies' daily P&L move together (Pearson and Spearman), how often they lose on the same
day, and how a basket's drawdown compares with its parts added up. The point (owner, 2026-10-10): a
basket should hold strategies that are not alike, so its drawdown is smaller. Earlier items had
named the risk without a number: "five nearby times is one bet" ([BL-054][bl054]), fewer larger picks
mean less spread ([BL-065][bl065]), closest-premium variants are near-copies of Widesl
([BL-080][bl080]).

## Live value

No correlation rule in any list, and none is planned: the registered cap was killed on the research
history ([BL-090][bl090] Phase 3, 2026-10-28). The tool exists: `obt rotation corr` / `corr-list` / `corr-pick`,
the API route and Options Lab › Correlation ([BL-090][bl090]). `corr-pick` is a diagnostic and ranks
in-sample.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-090 Phases 1–2b | The 09:17 set of ten strategies | 486 common days, 2024-10-09 → 2026-10-09, in-sample, gross | Descriptive (below) | [BL-090][bl090] |
| BL-090 Phase 3 | Cap "no two picks above trailing correlation c" in `score.select` at 0.5 / 0.6 / 0.7 (63-day Pearson) on lists A / B / C / REF, 248 variants | BL-075's P1, P2, P3 (P3 NIFTY only), before charges, lists in-sample | **Killed** for all 12 cap x list cells (pass needed 2 of 3 periods; best was 1); the forward hold-out is not read | [BL-090][bl090], `research/bl090/phase3_history_2026-10-28.json` |
| BL-101 | Long ATM straddle vs the fixed base | NIFTY, 2024-01 → 2026-10, after charges | Correlation −0.46, yet the hedge made the tail worse; **killed** | [BL-101][bl101] |

First read on the 09:17 ten ([BL-090][bl090] Log):

| Pair | Pearson |
|---|---|
| NIFTY Widesl OTM1 / ₹80 / ₹100 (within family) | 0.86–0.92 |
| SENSEX Widesl OTM2 / ₹250 / ₹320 | 0.85–0.90 |
| Dir vs Widesl | NIFTY 0.23, SENSEX 0.22 |
| NIFTY Dir vs SENSEX Dir | 0.57 |
| Buy vs Widesl | NIFTY −0.33, SENSEX −0.25 |

The equal-lot basket of all ten drew down ₹1,64,531 against ₹3,19,113 for the parts added up (ratio
0.52). Mean pairwise correlation was 0.30 in early 2025 and 0.08–0.15 in each 63-day block since late
2025.

## What we know

- Widesl variants of one index are nearly the same bet; Dir is close to independent of Widesl; Buy is
  the only family that moves against Widesl. This is in-sample and gross.
- Low or negative correlation is not enough: the long straddle was −0.46 with the base and still made
  every tail measure worse, because it paid little on the base's bad days and lost its premium on the
  quiet ones ([BL-101][bl101]). Loss-day overlap matters more than average correlation; `corr` prints it
  beside Pearson for that reason.
- A trailing-correlation cap on the lists cuts drawdown more often than not (22 of 36 list x cap x
  period cells at least 10% shallower) but costs net: only 5 of 36 keep net within 5%, and in P2
  (Jan–Aug 2025) every cap loses 28% to 105% of net. Killed under the registered rule for every list and
  cap ([BL-090][bl090] Phase 3; before charges, in-sample lists, P3 NIFTY only). Forcing look-alikes out
  pushes the ranking down to picks it scores lower, and that cost more than the spread saved.
- One `corr-pick` draw (09:17, k = 3, cap 0.6) cost P&L and did not cut drawdown against the uncapped
  pick (net ₹5,10,846 / −₹59,504 vs ₹5,53,053 / −₹47,545). One draw, not evidence; Phase 3 above is
  the test.
- Buy's negative correlation may be why the Buy add-on helps the rotation's gross even though Buy
  loses alone; that link has not been tested ([Buy](../strategies/buy-breakout/README.md)).

## Not yet tested

- A cap on loss-day overlap rather than Pearson, or a cap on the 298-variant forward universe: not
  registered (BL-090's Phase 0 rules out other measures for that test); a new item would need its own
  pre-registration.
- Whether to keep Buy as a named hedge or let the cap decide (BL-090 open question).

## Related

- [Rotation ranking](rotation-ranking.md), [long straddle hedge](../strategies/long-straddle-hedge/README.md).
- Code: `src/option_backtesting/analytics/correlation.py`, `rotation/series.py`, `api/correlation_routes.py`.

[bl054]: ../../../backlog/BL-054-weekly-strategy-slot-rotation.md
[bl065]: ../../../backlog/BL-065-drb-two-lots-per-strategy.md
[bl080]: ../../../backlog/BL-080-drb-wider-closest-premium-families.md
[bl090]: ../../../backlog/BL-090-strategy-correlation-and-diverse-baskets.md
[bl101]: ../../../backlog/BL-101-early-long-straddle-hedge.md
