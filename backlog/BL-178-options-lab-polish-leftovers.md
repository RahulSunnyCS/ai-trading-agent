# BL-178 — Options Lab polish left over from the redesign: run bars, Builder keys and YAML view, dead code

| | |
|---|---|
| **Priority** | P3 — cheap polish; the redesign (BL-102) is in daily use without it |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | dashboard |
| **Created** | 2026-10-28 |
| **Depends on** | BL-102 (Done 2026-10-28) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-102 (the Options Lab redesign) was closed by the owner on 2026-10-28 (asked in chat). Its Log lists
what was planned and not built; those items move here so the closed item does not hide them:

- **Correlation and Regimes** still keep their controls inline. Phase 2's last bullet ("only if time
  allows") was to move them into a run bar plus a settings drawer, as Heatmap, Runs and Today have.
- **Builder (Phase 1c, PR #227):** no arrow-key movement between grid cells (a cell edits with click or
  Enter, Tab moves on); no read-only "View as YAML"; lot size (`execution.lot_sizing`) is not exposed; the
  planned round-trip test (every saved strategy, YAML → grid → YAML byte-identical) was not written.
- **Dead code:** after Daily results was retired (2026-10-15), the Daily-results parts of
  `lib/legwiseResults.ts` / `lib/legwiseJoin.ts` and the anatomy chips were left unused. The anatomy code
  (`components/optionslab/anatomy.tsx`) is still imported by Regimes and DayForensics, so only the parts
  with no reader go.

## Goal

Correlation and Regimes follow the Analytics page pattern (run bar plus drawer); the Builder grid moves
with the arrow keys, shows its strategy as read-only YAML, sets the lot sizing, and a test proves the
round trip for all five strategies; no unused Daily-results or anatomy code is left.

## Out of scope

- New Options Lab features (BL-103).
- Changing any result, route or stored strategy.

## Plan

### Phase 1 — Correlation and Regimes run bars
- **Tasks:** move each page's inline controls into a run bar plus a settings drawer (`apps/dashboard/CLAUDE.md`
  → Analytics page pattern); URL state kept; Guide pages updated in the same commit.
- **Deliverables:** the two pages, their tests, Guide pages.
- **Done when:** both pages open with the same results for the same URL as before, and their controls sit
  in the run bar and drawer only.

### Phase 2 — Builder keys, YAML view, lot sizing, round trip
- **Tasks:** arrow keys move between grid cells; a read-only "View as YAML" of the strategy being edited;
  `execution.lot_sizing` (current / historical) in the Run panel; a round-trip test over the saved
  strategies (BL-102 Phase 1c's done-when: all five saved then load and serialise back byte-identical).
- **Deliverables:** the Builder changes, unit tests, the Guide's Builder page.
- **Done when:** the round-trip test passes for every saved strategy, and a cell can be reached and
  edited with the keyboard alone.

### Phase 3 — Remove the unused code
- **Tasks:** list what in `lib/legwiseResults.ts`, `lib/legwiseJoin.ts` and the anatomy chips has no reader
  (search and typecheck), delete it with its tests.
- **Deliverables:** the deletion, typecheck and tests green.
- **Done when:** nothing removed is imported anywhere and the dashboard tests pass.

## Risks

- Moving controls changes URLs a bookmark may use: keep the old query names readable.

## Open questions

- None yet; ask when started.

## Log

- 2026-10-28 — created from BL-102's leftovers when the owner closed BL-102 (owner, asked in chat,
  2026-10-28). P3.
