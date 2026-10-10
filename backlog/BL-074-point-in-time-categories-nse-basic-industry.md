# BL-074 — Point-in-time categories from NSE's Basic Industry classification

| | |
|---|---|
| **Priority** | P1 — the stock universe is point in time now (BL-029) but the categories are still today's themes, and the gap is 4–11 points of CAGR on the favourites |
| **Status** | Planned |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-10 |
| **Depends on** | BL-036 Phase 1 (the companion figure shows the gap), BL-010 Phase 3 step 3 |
| **TODO.md row** | — (filled in when started) |

## Context

Broad Momentum ranks stocks inside categories. Three tag sets exist today:

- **Curated** (`stock_groups.csv`): 113 hand-made themes over today's 755 Total Market names.
  A stock that later left the index can be ranked but never picked through a category, and a theme
  such as Defence or Semiconductors is selectable in 2019 although nobody would have had that label.
- **Extended** (`stock_groups_wide.csv`): BSE's current four-level classification for about 1,100
  more liquid stocks, folded into the curated categories where they match. Stocks BSE does not list
  (NSE-only, delisted) stay untagged.
- Neither is point in time. Yesterday's check (BL-010 log, 2026-10-10) put the extended figure 4–11
  points of CAGR and 7–14 points of drawdown below the saved headline for the five best favourites,
  and BL-036's default run 9.1 points below (33.3% against 24.2%).

The exchange classifies every listed company at four levels: Macro-Economic Sector (12), Sector
(22), Industry (59) and Basic Industry (about 197). It publishes today's classification only, but
a classification says what a company does, not how it did, so applying it to every year is a small
and accepted hindsight, unlike hand-picked themes. New themes (Sugar, BESS) stay usable going forward
through the journal (BL-024), tracked from the day they are added.

## Goal

A Broad run can rank within **NSE Basic Industry** groups for every stock in the point-in-time
universe, delisted names included, and the favourites are re-measured on it, so the headline and the
companion stop disagreeing about what the categories are.

## Out of scope

- Dating each hand-made theme by its index launch (BL-010 Phase 7); this replaces the question.
- Intraday or per-year reclassification history (not published).

## Owner decisions (2026-10-10)

- Separate item, started right after BL-036 Phase 1.
- Level: **NSE Basic Industry**, falling back to Industry where a Basic Industry has too few liquid
  members in a year.
- The first check is **coverage of delisted companies**: the point-in-time universe holds names the
  current classification may not carry.

## Plan

### Phase 0 — Pre-register
- **Tasks:** commit, before any run, the member floor for the fallback, the favourites to
  re-measure, and the pass line (BL-010 research gate; `_EXPERIMENT.md` block).
- **Done when:** the thresholds are committed with a hash.

### Phase 1 — Coverage audit
- **Tasks:** fetch NSE's Basic Industry by ISIN for every stock in the point-in-time universe 2016 →
  today; for each year, the share of the universe tagged, and the delisted names without one; try the
  BSE fetch already in `wide_tags.py` as a fallback.
- **Deliverables:** a coverage table per year and a list of untagged names with their weight.
- **Done when:** the table exists and the owner has seen the untagged share.

### Phase 2 — Tag file and loader
- **Tasks:** `categories/nse_industry.py` building a tag file, `category_tags="nse_basic_industry"`
  in `run_broad_backtest` and `BacktestRequest`, a frozen scenario (BL-001), the guide page.
- **Done when:** a run with the new tags reproduces the golden on the fixture and the coverage test
  passes.

### Phase 3 — Re-measure
- **Tasks:** the five favourites and the frozen four on the new tags; the companion figure in the
  UI becomes this one if it holds.
- **Done when:** the table is in the log and the dashboard shows it.

## Risks

- A delisted company has no current classification: the audit may find a large untagged share in
  early years, which biases the result towards survivors again. Report it before building.
- About 197 Basic Industries is finer than the 113 themes in some places and coarser in others;
  stock-level picks inside a category change.

## Log

- 2026-10-10 — created from the BL-036 planning conversation. Owner chose a separate item, the
  Basic Industry level, and delisted coverage as the first check.
