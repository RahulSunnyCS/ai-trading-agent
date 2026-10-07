# BL-017 — Momentum: one settings module, and split `api.py`

| | |
|---|---|
| **Priority** | P2 — BL-010 fixes the current default mismatch (E9); this stops the next one |
| **Status** | Ready |
| **Type** | improvement |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | BL-010 Phase 1 (E9 defaults) done first, so this is a pure refactor |
| **TODO.md row** | — (filled in when started) |

## Context

The API, the CLI and the search each set their own backtest defaults. That is how the live
preview drifted from the backtest (BL-010 F11, E9). `api.py` is 2,615 lines and `cli.py` 1,862,
and both were among the most-changed files in the week of 2026-09-29.

## Goal

One module defines every backtest setting and its default; the API, CLI, search and weekly
signal all read it. `api.py` is split by feature with no behaviour change.

## Out of scope

- Engine changes or new settings.

## Plan

### Phase 1 — Settings module
- **Tasks:** a typed settings object with defaults in one place; API, CLI, search and
  `weekly.py` build from it; a test that asserts the four entry points agree.
- **Deliverables:** module, call-site changes, parity test.
- **Done when:** the parity test passes and BL-001's goldens are unchanged.

### Phase 2 — Split `api.py`
- **Tasks:** move routes into per-feature modules (ETF, stocks, categories, broad, jobs, runs).
- **Deliverables:** smaller modules, same routes.
- **Done when:** the API tests pass unchanged and no module exceeds about 600 lines.

### Phase 3 — Data cache, CLI split, research modules (added 2026-10-07 from the whole-repo audit)
- **Tasks:**
  - `_Data` in `api.py` (3,229 lines by now): run the loaders `get()`, `get_stock()`, `fills()`
    and `references()` outside the single global `_Data._lock`, so one reload stops stalling
    every other request. Lock only the swap.
  - Bound `fill_tables` with an LRU.
  - `api.py` imports the 2,665-line `cli.py` just to run `stocks_sync`. Move that function into a
    module that both of them import.
  - Split `cli.py` by sub-app.
  - Move the CLI-only research modules (BL-010 records: `audit/*`, `phase5`, `phase6`, `robust`,
    `final`, `rescore`, `steady`, `pit_rerun`, `category_shuffle`, `holdout`, `choose`, `bias`,
    `method`, `tracker`, `sweep`; plus `tranches.py`, `reversal.py` and the 1 Oct experiment
    scripts, which the owner chose to keep on 2026-10-07) into a `research/` sub-package. Moved,
    not deleted.
  - `patterns/` (BL-042/BL-043) reaches into `api.DATA`, `api.DATA_DIR` and the private
    `holdout._dirty()`/`_commit()`. Give it a public data accessor and public holdout functions.
- **Done when:** `api.py` doesn't import `cli`; no module outside `api/` reads `api.DATA`;
  goldens are unchanged.

## Risks

- A refactor during BL-010 changes results silently. Run BL-001's goldens before and after.

## Open questions

1. ~~Pydantic or a frozen dataclass?~~ **Pydantic** (owner delegated to the recommendation, 2026-10-06): the package already uses it in `api.py`
   and `analysis.py`, and FastAPI validates requests with it, so one model serves both.

## Log

- 2026-10-06 — created from the codebase review.
- 2026-10-06 — owner delegated the remaining open questions to Claude's recommendations: Pydantic. Status Ready (still after BL-010 Phase 1).
- 2026-10-07: Phase 3 added from the whole-repo audit (data-cache lock, CLI split, `research/`
  sub-package, the `patterns/` coupling).
