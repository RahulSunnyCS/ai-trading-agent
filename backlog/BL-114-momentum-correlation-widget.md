# BL-114 — Momentum correlation widget: how alike are the strategies we follow?

| | |
|---|---|
| **Priority** | P1 — this month's goal is choosing what Momentum money follows (BL-010, BL-025); the saved strategies measure as about one bet, and nothing in the UI says so |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum / dashboard |
| **Created** | 2026-10-16 |
| **Depends on** | BL-052 (saved strategies, `runs_store.group_blend`), BL-024 (forward journal), BL-087 (all-Fridays groups). Pattern: BL-090 (the Options Lab correlation page) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner (2026-10-16) asked for a correlation widget between Momentum strategies, built to answer "what
should we check, given what is in our database". Up to 8 favourites can be Paper or Invested, and the Saved
runs table now shows each group's own curve and numbers, but nothing says how alike they are. BL-090 did this
for the options rotation (daily P&L correlation, loss-day overlap, drift, a basket builder with a cap); this is
the Momentum counterpart, on weekly equity curves and on what each strategy holds.

**What the saved runs say today** (measured 2026-10-16 on the 11 saved groups' blended curves, 2017 to
9 Oct 2026; in-sample, a description and not evidence):

| Measure | Result |
|---|---|
| Weekly return correlation, 55 pairs | median 0.90, range 0.78 to 0.97 |
| Same, in the worst 10% of weeks | median 0.82, lowest pair 0.68 |
| Weeks both in a fall of more than 10% (overlap of drawdown periods) | median 0.64, lowest 0.50 |
| Effective independent bets (eigenvalues of the correlation matrix) | **1.23 of 11**; the first factor carries 90% of the variance |
| ETF rotation runs against the Broad groups | 0.62 to 0.76: the only real diversifier here, and it earns 25% a year against 38 to 45% |
| Correlation after removing the groups' common factor | median -0.11, range -0.42 to +0.57 |

So the raw matrix will read "one bet" for almost every pair, which is true and not very useful. The widget's
value is (1) saying that plainly, (2) showing where the strategies *differ* once the shared factor is removed,
and (3) showing what they hold, which a return correlation cannot.

## Goal

- One page that answers: for the strategies I follow (or could follow), how alike are they, in what way, and
  which one adds the most that the others lack.
- Every figure comes from data already in the catalog, labelled as in-sample or forward, with its sample size.
- A strategy saved tomorrow appears with no code change.

## Out of scope

Changing what the weekly signal, the headline or the live-money rules do. Picking what money follows: a picker
built here is a description; using one to choose live money needs a pre-registration under the research gate
(Phase 0 of a new item) because the curves are in-sample. Intraday or daily correlation (the engine is weekly).

## What to measure, and where each comes from

| Question | Measure | Source in our database |
|---|---|---|
| Do they move together? | Weekly return Pearson and Spearman, full window and last 3 years | `backtest_runs.summary` curves (`strategy` + `dates`); a group uses `runs_store.group_blend` |
| Is it only the market? | **Excess correlation**: returns minus the benchmark's (Nifty 50 TRI or Nifty200 Momentum 30 TRI, the existing benchmark picker), or minus the group average | `stock_weekly_series` (TRIs), `momentum_prices` |
| Do they fall together? | Correlation in the worst 10% of weeks; share of weeks both in a >10% fall; same trough date; correlation of underwater curves | the same curves |
| Do they rise together? | Correlation in the best 10% of weeks | the same curves |
| Is it stable? | Rolling 52-week correlation for one pair; correlation by financial year | the same curves |
| Do they hold the same things? | **Weight overlap** (sum of the smaller weight per name, 0 to 100%), name overlap (Jaccard), sector or category overlap, top-name concentration of the pair combined | now: `momentum_forward_journal` (`target_weights`, `holdings_before`; groups through `groups.combine`); history: weekly weights per saved run (Phase 2) |
| Do they trade together? | Share of one week's buys and sells that the other makes in the same week (a crowded exit is a liquidity risk for stocks) | trade logs (Phase 2) |
| Why are two alike or different? | The settings that differ (cadence, top N, tilt, exit rank, universe) | `strategies` config, `saved_identity.explain` |
| How many real bets? | Effective N (eigenvalue share), the first factor's share, diversification ratio | derived from the matrix |
| Which ones add something? | Each strategy's correlation with the rest of the followed basket, and the basket's drawdown with and without it | derived |
| Is it a near-copy? | A pair above 0.98 (flagged *near-copy*); a sleeve against its own group (flagged *same family*, not a finding) | derived |

Guards, as in BL-090: a pair needs at least 52 common weeks (forward-only mode shows fewer, muted and labelled,
never read); a figure that cannot be computed is a dash with its reason, never zero; in-sample and forward are
never mixed in one number.

## Plan

### Phase 1 — Return correlation tool (backend)
- **Tasks:** `correlation.py` in `momentum_backtesting` (pure, numpy/pandas): pairwise matrix for the views
  Returns, Excess, Down weeks, Up weeks, Drawdown overlap; windows Full / 3y / Forward since the paper start;
  rolling drift for a pair; effective N; near-copy and same-family flags; sample guards. `GET /api/correlation`
  (ids, window, view, benchmark) reading saved strategies' curves (groups through `group_blend`) and the
  benchmark; Fastify proxy route with whitelisted params. `mbt corr` for the same in the terminal.
- **Deliverables:** module, route, proxy, CLI, tests (a clone reads 1.0, a hedge reads negative, a constant
  curve is a dash, a window with too few weeks is flagged), CLAUDE.md and technical.md lines.
- **Done when:** the 11 groups reproduce the table above to two decimals through the route, and a strategy
  saved after the build is listed with no code change.

### Phase 2 — Holdings and trades per week
- **Tasks:** keep each saved run's weekly weights and its trade list in compact form with the run (a few KB a
  run), so overlap over history needs no re-run; `mbt saved backfill-weights` re-runs the 59 existing runs once
  (ranking caches make it minutes, not hours). Weight overlap, name overlap, sector overlap
  (`category_membership`), trade-timing overlap, and the "what differs" settings.
- **Deliverables:** the stored weights, backfill command, the overlap measures in the route, tests.
- **Done when:** the forward journal's overlap for 9 and 16 Oct equals the stored-weights overlap for the same
  weeks, to the rounding.

### Phase 3 — The widget
- **Tasks:** Momentum › Correlation, following the analytics-page pattern (run bar, headline strip, one hero,
  widgets below): headline = effective bets, median pair, the most alike pair, the one that differs most;
  hero = the heatmap (rows grouped by dataset and status; the view switch Returns / Excess / Down weeks /
  Drawdowns / Overlap; colour is a band of the correlation, never a profit colour, as in BL-090); a pair readout
  (scatter of weekly returns, rolling correlation, the settings that differ, the names both hold); a
  "marginal" table (each followed strategy's correlation with the rest and the drop-one effect). A one-line
  strip on Saved runs ("Followed: 1.2 independent bets of 8") links to it. Guide page and registry entry.
- **Deliverables:** page, hooks on `usePolledResource`, view library in `lib/` (colour bands and wording, no
  maths in components), tests, guide page.
- **Done when:** checked in the browser on the real data, light and dark, and at phone width.

### Phase 4 — Basket builder (description only)
- **Tasks:** reuse BL-090's `pick_diverse` idea on weekly curves: "k strategies, none above this correlation",
  with what the cap cost in CAGR and drawdown, shown beside the uncapped top k; the 8 Paper and Invested places
  as the default k.
- **Deliverables:** route, panel, tests. Labelled in-sample; writes nothing.
- **Done when:** clones, pinned names and a short basket behave as in BL-090's tests.

## Risks

- **All curves are in-sample** and chosen after the results were seen, so their correlation is understated
  against how they will behave live; the forward window (journal, from 9 Oct) is the honest number and is tiny
  for now.
- **Group blends** are approximations of the account (equal capital, April reset, estimated Sharpe); a pair of
  a group and its own sleeve is not a finding.
- **Correlation moves** in a crash (0.90 median in all weeks, 0.82 in the worst, but pairs differ); one number
  hides that, hence the views and the drift chart.
- A **correlation cap** can pick the weaker strategy; the widget must show the cost beside the benefit.

## Open questions

1. Where should it live: its own Momentum sub-tab (proposed), or only inside Saved runs and Compare?
2. Phase 2 stores weights with every saved run and re-runs the 59 existing ones once: accept that?
3. Which benchmark removes the "common factor" by default: Nifty 50 TRI (the market), Nifty200 Momentum 30 TRI
   (the factor), or the average of the strategies themselves?
4. Include the ETF rotation runs next to the Broad groups? They are the only low-correlation pair today, but
   earn about 25% a year.
5. Should stock-level return correlation (the names held, from `bars_1d_stock`) be a later phase, to show
   concentration in the same few stocks (CUPID, NAZARA, PAYTM appear in nearly every list this week)?

## Log

- 2026-10-16 — created from the owner's request, with the measurements above. No code written.
