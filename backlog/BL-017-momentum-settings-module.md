# BL-017 — Momentum: one settings module, and split `api.py`

| | |
|---|---|
| **Priority** | P2 — BL-010 fixes the current default mismatch (E9); this stops the next one |
| **Status** | Planned |
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

## Risks

- A refactor during BL-010 changes results silently. Run BL-001's goldens before and after.

## Open questions

1. Pydantic model or a frozen dataclass for the settings?

## Log

- 2026-10-06 — created from the codebase review.
