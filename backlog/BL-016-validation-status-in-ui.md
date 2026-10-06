# BL-016 — Show validation status and known assumptions next to every result

| | |
|---|---|
| **Priority** | P2 — friends do not need access next week (owner, 2026-10-06); still needed before they do |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | momentum, dashboard |
| **Created** | 2026-10-06 |
| **Depends on** | BL-010 Phase 0 (favourites already marked "Candidate — unvalidated") |
| **TODO.md row** | — (filled in when started) |

## Context

Shortcuts accepted during development (today's index list as the universe, categories written in
2026, no dividends in broad prices) are recorded in BL-010 and in chat, but not on the screen
that shows the CAGR. The owner plans to share the Momentum tab with two or three friends this
month (BL-002).

## Goal

Every backtest result, favourite and weekly signal shows its validation status and the
assumptions that affect it, in plain English.

## Out of scope

- Fixing the assumptions themselves (BL-010 Phase 3).

## Plan

### Phase 1 — Assumptions register
- **Tasks:** `packages/momentum-backtesting/ASSUMPTIONS.md` — one row per accepted shortcut:
  what it is, which modes and datasets it affects, direction (flatters / hurts), the item that
  fixes it.
- **Deliverables:** the file, linked from the package README.
- **Done when:** every BL-010 finding still open has a row.

### Phase 2 — Status on screen
- **Tasks:** the API returns a `validation` block per result (status: unvalidated / pre-fix /
  validated, plus the assumption IDs that apply); the dashboard shows a badge and a short list
  under the headline numbers.
- **Deliverables:** API field, dashboard component, tests.
- **Done when:** a Broad result on today's universe shows "Unvalidated — today's stock list used
  for every year" next to its CAGR.

## Risks

- The status drifts from the truth if it is hand-set. Derive it from the run's settings and data
  snapshot where possible.

## Open questions

1. ~~Telegram status line?~~ **Yes** (owner, 2026-10-06): the weekly signal message carries the
   same status and assumption list.

## Log

- 2026-10-06 — created from the process review.
- 2026-10-06 — owner decisions on PR #27: lowered to P2; Telegram status line approved.
