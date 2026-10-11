# BL-090 — Strategy correlation and diverse baskets

| | |
|---|---|
| **Priority** | P2 — turns a risk written down three times (BL-054, BL-065, BL-080) into a number |
| **Status** | In progress |
| **Type** | feature |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-058 (the variant results under `TRADING_DATA_ROOT/rotation/`), BL-034 (legwise daily results in the catalog) |
| **TODO.md row** | 3.24 |

## Context

The rotation runs three strategy families (Widesl including the closest-premium variants, Dir, Buy) on
NIFTY and SENSEX at 25 start slots, and lists A / B / C / REF pick three of them a day. Nothing measured how
those strategies move together. BL-054 said "five nearby times is one bet, not five", BL-065 that fewer, larger
picks mean less diversification, BL-080 that 100 more closest-premium variants are near-copies of Widesl. The
owner (2026-10-10): a basket should hold strategies that are not alike, so the drawdown is smaller; build the
correlation first, show it in the UI later, and it must find a strategy created tomorrow without a code change.

## Goal

- `obt rotation corr`: for any set of strategies, the correlation of their daily P&L (Pearson and Spearman),
  loss-day overlap, basket drawdown against the sum of the parts, and correlation drift over time.
- Dynamic: a strategy is found because it has results (a new variant file after its first nightly run, a new
  legwise file after `obt daily`), by name, glob, `slot:`, `family:`, `index:` or `kind:`.
- `obt rotation corr-pick`: a basket of k strategies none of which are alike, with what the cap cost.
- Phase 3 prepared: whether a correlation cap on the forward lists cuts drawdown, pre-registered below.

## Out of scope

Changing lists A / B / C / REF or `score.select` (Phase 3, only after its pre-registration is committed and
the forward journal has days to be judged on); normalising each
strategy's P&L by its own volatility (1-lot rupee P&L is used, so bigger-swing families weigh more in basket
numbers; correlations themselves are scale-free).

## Plan

### Phase 1 — The measuring tool
- **Tasks:** `analytics/correlation.py` (numpy only; Spearman reuses `rotation.score.pct_rank`);
  `rotation/series.py` (enumerates variant CSVs and saved legwise results, selectors, stale-version rule);
  `legwise/store.load_daily_net` (net only, no trades); `obt rotation corr` and `corr-list`.
- **Deliverables:** the commands, 23 tests (`tests/unit/test_correlation.py`), CLAUDE.md and technical.md lines.
- **Done when:** the 09:17 ten print in under a second on the real data; a variant against the live file that
  reproduces it prints 1.00; a CSV added to the results folder is found with no code change. **Met 2026-10-10.**

### Phase 2 — Basket builder
- **Tasks:** `pick_diverse` (greedy in rank order, keep one only if below the cap with every kept one,
  `--require` pins names, short rather than padded, an incomputable correlation counts as not independent);
  `obt rotation corr-pick`.
- **Deliverables:** the command; output shows the capped basket beside the uncapped top-k of the same size.
- **Done when:** tests for clones, `--require` and short baskets pass. **Met 2026-10-10.** The command is a
  diagnostic: it writes nothing to the journal, and its default rank (each strategy's own mean / std) is
  in-sample, so a basket it prints is a description, not evidence.

### Phase 2b — API route and dashboard heatmap
- **Tasks:** `api/correlation_routes.py` (`/legwise/correlation/available`, `/legwise/correlation`,
  `/legwise/correlation/pick`); three Fastify proxy routes with validated, whitelisted params;
  Options Lab › Correlation (heatmap, pair readout, strategy table, basket builder, drift chart); `a+b`
  selectors so the filters combine; a similarity order so look-alikes sit together; Guide page.
- **Deliverables:** the routes and tests (14 Python, 2 proxy, 21 view-logic), the tab, `guide/optionslab/correlation.md`.
- **Done when:** the tab renders the real 09:17 set with clusters, a click pins a pair and reads it in words,
  and the basket builder returns a basket. **Met 2026-10-10** (checked in the browser on live data, desktop and
  phone width).

### Phase 3 — Does a cap help the forward lists? (research; not run)

#### Phase 0 — Pre-register (filled in before any run; committed with this item, 2026-10-10)
- **Hypothesis:** adding "no two picks above trailing correlation c" to `score.select` lowers each list's
  maximum drawdown by more than it lowers its net P&L, relative to the same list without the cap.
- **Universe:** the 248 variants of `strategies/rotation/`, the four registered lists, as `rotation/lists.py`
  defines them. The 150 BL-080 extension variants are not in it.
- **Look-ahead check:** the correlation matrix for day d uses only days before d (`analyse(end=d - 1)`), over
  the trailing 63 trading days; replay reuses `rotation/score.py` and is checked with
  `scripts/rotation-parity.py` at cap = off (it must reproduce every recorded pick).
- **Pass / kill rule:** cap grid fixed now: 0.5, 0.6, 0.7 (trailing Pearson, 63 days), plus off. A cap passes
  for a list when, on the research history with the hold-out removed, its max drawdown is lower by at least
  10% of the uncapped drawdown AND its net P&L is no more than 5% lower, in at least two of the three periods
  BL-075 used. It is killed otherwise. Comparator: the same list, uncapped.
- **Hold-out:** the forward journal from 2026-10-12, read once, at least 60 trading days in, and only for a cap
  that passed.
- **Will not run:** any cap outside the grid; the matrix over the whole history; a different window length
  after seeing results; correlating on anything but daily net P&L; applying a cap to the Buy add-on.
- **Done when:** the table of three caps x four lists x three periods is in the Log, with the decision.

## Risks

- Correlation of daily P&L understates what matters on the day it goes wrong: the loss-day overlap and
  loss-day Pearson are printed beside it for that reason, and the first run shows they differ materially.
- A basket picked on the whole history looks better than it will: every `corr-pick` output says in-sample.
- Fewer than 40 common days is refused: the live legwise files have 12 days, so a variant-against-live
  comparison needs `--min-days`; it is a sanity check, not a result.
- Near-copies (p80 / p100 / wide) inflate the share of high correlations in `all`; read the groups, not the
  average.

## Open questions

- Is the Buy family wanted as a hedge by name (a `--require` that is always on), or should the cap decide?
- Should P&L be normalised by volatility for basket stats once the lots differ (Buy trades 2 lots)?

## Log

- 2026-10-10 — created from the owner's request; Phases 1 and 2 built the same day. First read on the 09:17 ten
  (486 common days, 2024-10-09 to 2026-10-09, in-sample): Pearson inside a family is high (N wide / p80 / p100
  0.86 to 0.92, S wide / p250 / p320 0.85 to 0.90); Buy against Widesl is negative (N -0.33, S -0.25); Dir sits
  near zero against Widesl (N 0.23, S 0.22) and 0.57 against its own SENSEX copy. The equal-lot basket of all
  ten draws down 164,531 against 319,113 for the parts added up (ratio 0.52). Rolling 63-day blocks: the most
  alike pair always includes a closest-premium variant; the mean pairwise correlation is 0.30 in early 2025 and
  0.08 to 0.15 in each block since late 2025. Informative only; no list changed.
- 2026-10-10 — `corr-pick slot:0917 --k 3 --max-corr 0.6 --require N_wide_0917` kept N_wide, S_dir, S_p320
  (net 510,846, drawdown -59,504) against the uncapped N_wide, S_dir, S_wide (net 553,053, drawdown -47,545):
  on this one in-sample draw the cap cost P&L and did not cut drawdown. One draw, not evidence; Phase 3 is the
  test.
- 2026-10-10 — API route and dashboard heatmap built (Phase 2b). The heatmap clusters the NIFTY Widesl family
  (wide / p80 / p100), the SENSEX one (wide / p250 / p320), the two Buy variants and the two Dir variants as
  blocks; Buy against Widesl shows as the only opposite-tinted cells. A request over 80 strategies is refused
  with advice to narrow by start time, family or index; 75 strategies answer in about 0.4 s and 200 KB.
