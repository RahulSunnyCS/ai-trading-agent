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

A theme can carry a `launch_date`; a Broad / Custom Index run treats it as selectable only for
weeks on or after that date. BESS is added with launch date **2026-10-12** (next Monday).
Every existing result is byte-identical (goldens unchanged); no historical week sees BESS.

## Out of scope

- Any backtest, search or comparison that includes BESS (it has no history to test on).
- Changing the frozen ensemble (BL-010 Phase 6) unless the owner decides so (open question 1).
- Dating the existing 113 themes (BL-010 Phase 3 step 3 proper).

## Plan

### Phase 1 — Launch-date column
- **Tasks:** add an optional `launch_date` column to `category_extras.csv` (blank = today's
  behaviour); `resolve.py` / `compose.py` drop a row for any week before its date; tests for
  before/after/blank; Guide page and `technical.md` note updated in the same commit.
- **Deliverables:** code + tests.
- **Done when:** `scripts/update-goldens.py` and `result-baseline.py compare` show no change
  on live data; a unit test shows a BESS stock is untagged the week before and tagged the week after.

### Phase 2 — Add BESS
- **Tasks:** after owner confirms membership (open question 2), move the BESS rows from
  `pending_themes.csv` into `category_extras.csv` with `launch_date = 2026-10-12`; keep
  `pending_themes.md` in step; no backtest run.
- **Deliverables:** data change; the journal records BESS from the first week it is selectable.
- **Done when:** the 2026-10-16 weekly signal lists BESS as a candidate category; every earlier
  week's saved output is unchanged.

### Phase 3 — Remaining pending themes (optional)
- **Tasks:** same move for Semiconductors, Nuclear Supply Chain, Optic Fibre, Data Centre Power
  & Cooling, each with its own launch date, one commit each.
- **Done when:** owner has approved each theme.

## Risks

- A new category changes the live ranking from the launch date, so a frozen ensemble's output
  moves; mitigated by open question 1.
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
- 2026-10-11 — created from the owner's request to add BESS for forward use only; recommended
  option A (launch-date column) chosen by the owner. Questions above still open.
