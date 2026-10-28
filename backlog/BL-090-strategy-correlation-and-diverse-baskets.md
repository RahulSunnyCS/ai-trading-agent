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
- 2026-10-28 — **Phase 3, research history: red-team before the run** (written and committed before any
  capped run is scored; the pre-registration is the Phase 0 block above, committed in `ed3616f3` on
  2026-10-10, unchanged). Scope: the research history only; the forward journal (from 2026-10-12) stays
  unread until a cap passes here.
  - **Look-ahead.** Day i's picks read only rows before i: the composite is `rotation/score.py`'s
    (row i contributes only its weekday, VIX band and days to expiry, known before 09:15), and the cap's
    correlation is `analytics/correlation.analyse(start = day i-63, end = day i-1)` on the trailing 63
    trading days of the period's own rows. Day i's P&L is used only to score the list. The replay at
    cap = off must reproduce rotate.py's recorded picks (the `scripts/rotation-parity.py` check, run inside
    the runner so the hold-out is never loaded; the script itself loads every stored day) for every
    picks file the BL-075 runs left (A, B, C, REF in P1; REF in P2 and P3), and BL-075's gross and max
    drawdown for A, B and C in all three periods (`research/bl075/out/runs/o{5,0,15}_f5_baseline_P*.txt`).
    Any difference stops the run before a cap is scored.
  - **Hold-out.** The loader drops every row after 2026-10-08 (BL-075's P1 end) while reading, and
    asserts no later day is held; nothing from 2026-10-09 on enters any computation.
  - **Survivorship.** The universe is the fixed 248 variant files (the pre-registration's; the 50 Dir
    ITM1 and 100 extension closest-premium variants are out), none dropped or added by outcome. P3 is
    NIFTY-only (124 variants) because SENSEX options are not in the lake before 2024-10: a coverage
    limit BL-075 already had, not a selection, but the cap there chooses among half as many variants.
  - **Data-snooping.** The cap grid (0.5 / 0.6 / 0.7), the 63-day window, the measure (Pearson of daily
    net P&L) and the pass rule were fixed on 2026-10-10 before any capped run; 12 cap x list tests are
    run and all are reported, so one pass in 12 is weak on its own (the hold-out is the guard). The lists'
    weights were themselves chosen on these three periods (BL-075), so the history is in-sample for the
    lists; the comparison is capped against uncapped on the same in-sample lists, which shares that bias
    but does not remove it. Variants carry no costs: "net" is before charges, for both arms.
  - **Mechanical clarifications (the rule leaves them open; none chosen from a result):**
    1. Periods are BL-075's exactly: P1 history 2025-09-01 to 2026-10-08, selections 2025-12-03 on (202
       days); P2 history 2024-10-09 to 2025-08-29, selections 2025-01-10 on (157); P3 NIFTY-only history
       2022-01-03 to 2024-10-08 (`research/bl071/results`), selections 2022-04-05 on (618). The first 63
       rows of each period are the warm-up of both the composite and the cap.
    2. The cap goes inside `score.select`: the non-Buy variants in composite order, each kept only when its
       trailing Pearson with every pick already kept is below c (Phase 2's `pick_diverse` rule: an equal
       or incomputable correlation blocks); then the Widesl minimum as now (the lowest Dir dropped, the
       next-best Widesl added), the added Widesl also under the cap with every remaining pick. When nothing
       qualifies the list holds fewer picks that day (short, never padded, as Phase 2); short days are
       counted and reported.
    3. The Buy add-on is unchanged and never compared with the core (the pre-registration's "will not
       run: applying a cap to the Buy add-on").
    4. "Lower by at least 10%" = capped max drawdown no deeper than 0.9 x the uncapped; "no more than 5%
       lower" = capped net >= uncapped net - 0.05 x |uncapped net|; both in the same period, in at least
       two of P1 / P2 / P3. Drawdown is on the cumulative 2-lot list P&L from 0 over the selection days.
  - Result goes once to `packages/option-backtesting/research/bl090/phase3_history_2026-10-28.json`.
