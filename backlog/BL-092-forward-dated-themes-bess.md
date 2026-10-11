# BL-092 — Forward-dated themes: BESS first, then the other pending themes

| | |
|---|---|
| **Priority** | P2 — keeps the owner's own-research themes usable going forward without touching the validated Momentum results (BL-010, BL-001 come first) |
| **Status** | In progress |
| **Type** | feature |
| **Area** | momentum |
| **Created** | 2026-10-11 |
| **Depends on** | BL-010 Phase 3 step 3 (launch-dated taxonomy; this is its forward-only slice), BL-024 (forward journal), BL-001 (goldens prove existing output is unchanged) |
| **TODO.md row** | 3.9.27 |

## Context

`categories/curated/pending_themes.csv` holds five own-research themes (BESS 16, Semiconductors
10, Nuclear Supply Chain 9, Optic Fibre 8, Data Centre Power & Cooling 7). No code reads it. They
were set aside on 2026-10-06 because `category_extras.csv` applies every tag to **all years**, so
a 2026-popular theme would be ranked across 2017–2025 (BL-010 finding F2, hindsight).

BL-010 (2026-10-06) and BL-074 already say these themes are "tracked forward only", but nothing in
`resolve.py` / `compose.py` can express "selectable only from date D".

## Correction found while starting (2026-10-11)

The first plan put `launch_date` on `category_extras.csv`. That file feeds **Custom Index** only
(`resolve.py`, `compose.py`) and works by year. The live headline, Broad Momentum, takes its
categories from `curated/stock_groups.csv` (`parent_group :: subgroup`) through
`broad.load_stock_groups` and scores them week by week in `ordered_categories_by_week`. So the
launch date lives in a new file, `stock_groups_dated.csv`, read only by the Broad run path.
`category_extras.csv` and Custom Index are untouched; BESS is not selectable there.

## Goal

A Broad run treats a category listed in `stock_groups_dated.csv` as selectable only for weeks
labelled on or after its `launch_date`. BESS is added with launch date **2026-10-12** (Monday), so
the first week that can hold it is the Friday-labelled week of 2026-10-16. Every earlier week,
every saved result before that week and every golden is unchanged, and nothing that is displayed
about the past names the theme (trade explanations included).

## Out of scope

- Any backtest, search or comparison that includes BESS (it has no history to test on).
- Custom Index (`category_extras.csv`, year-based): not changed, BESS is not selectable there.
- The Momentum Scores page, the hold-out and the residual score read `stock_groups.csv` only, so
  they never show BESS.
- Changing the frozen ensemble (BL-010 Phase 6) beyond what the owner chose: BESS is selectable
  in the live signal from the launch week.
- Dating the existing 113 themes (BL-010 Phase 3 step 3 proper).

## Plan

### Phase 1 — Launch-dated groups (built 2026-10-11)
- **Tasks:** `curated/stock_groups_dated.csv` (`stock_groups.csv` columns plus `launch_date`);
  `broad.load_stock_groups(..., dated=True)` and `broad.load_group_launches`;
  `ordered_categories_by_week(..., launches)` scores a dated category NaN before its week and the
  launch dates are part of its cache key; `run_broad_backtest` asks for the dated rows; the result
  rendering in `api._broad_parts` reads the same merged membership (held categories, exit reasons)
  and `exit_reasons.explain_exits(..., launches)` never names a category before its launch week.
- **Deliverables:** code, `tests/categories/test_dated_groups.py`, an API test and an exit-reason
  test, Guide and package `CLAUDE.md` notes.
- **Done when:** the goldens and the full suite are unchanged (done: 1,540 passed on the first
  build) and the tests show a dated category is absent the week before launch and present from it.
  **Still to run by the owner, on live data:** `scripts/result-baseline.py capture` before and
  `compare` after, to confirm saved favourites do not move for any week before 2026-10-16.

### Phase 2 — Add BESS (built 2026-10-11)
- **Tasks:** the 16 vetted BESS rows moved from `pending_themes.csv` into `stock_groups_dated.csv`
  with `launch_date = 2026-10-12`; `pending_themes.md` updated; no backtest run.
- **Deliverables:** data change; the journal records BESS from the first week it is selectable.
- **Done when:** the 2026-10-16 weekly signal lists BESS as a candidate category (needs the live
  data; the coverage floor may keep it out, see Risks) and every earlier week's output is unchanged.

### Phase 3 — Remaining pending themes (optional, one commit per theme)
- **Tasks:** same move for Semiconductors, Nuclear Supply Chain, Optic Fibre and Data Centre Power
  & Cooling, each with its own launch date; verify each theme's exposure first.
- **Done when:** the owner has approved each theme.

## Risks

- A new category changes the live ranking from the launch date, so a frozen ensemble's output
  moves; mitigated by open question 1.
- Coverage: a category is scored only if at least `coverage_floor` (default 0.40) of its members are
  ranked that week, so BESS needs about 7 of its 16 names in the pool at once; five carry no curated
  tag. An absent BESS in the first journal entries is this, not a bug.
- Small baskets (BESS has 16 names, some order-book-only) rank noisily; the journal records it
  forward without a backtest to lean on.
- Stocks with no price history (ORIANA, BONDADA, MAXVOLT, ATCENERGY) stay excluded.

## Open questions

1. BESS as a **shadow arm only** (journal, no effect on the live-money signal) or **selectable in
   the live signal** from the launch date?
2. Membership: add Shilchar, TCPL Packaging, SPML Infra (tickers to confirm)? Keep Hindalco and
   Gujarat Fluorochemicals out (BESS is a small side business there)?
3. Launch date: 2026-10-12, or the first Friday signal after it?

## Log

- 2026-10-11 — owner answers: BESS **selectable in the live signal**; launch **Monday 2026-10-12**
  (first selectable week: the Friday-labelled week of 2026-10-16); membership left to Claude's
  recommendation: keep the 16 vetted names, keep Hindalco and Gujarat Fluorochemicals out, hold
  SHILCTECH / TCPLPACK / SPMLINFRA (tickers confirmed in `stock_groups_wide.csv`) in
  `pending_themes.csv` as unverified candidates, because their BESS share of revenue is unchecked and
  this now moves the live signal.
- 2026-10-11 — Phases 1–2 built: `stock_groups_dated.csv` (16 BESS rows), `load_group_launches`,
  `load_stock_groups(dated=True)`, `launches` through `ordered_categories_by_week` and
  `compute_category_selection_mass_exit`; BESS rows moved out of `pending_themes.csv`;
  `tests/categories/test_dated_groups.py`; Guide and package CLAUDE.md updated.
- 2026-10-11 — PR 188 review: Codex found the result rendering loaded the groups without the dated
  rows (fixed, 2d2c82b); a second review found exit explanations named BESS for trades before the
  launch, a hindsight leak in displayed history (fixed: `explain_exits(launches=...)`, test added).
- 2026-10-11 — created from the owner's request to add BESS for forward use only; recommended
  option A (launch-date column) chosen by the owner. The three open questions were answered the
  same day (first Log entry).
