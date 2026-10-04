# BL-006 — Momentum Scores table: responsive sort and filter

| | |
|---|---|
| **Priority** | P3 — usable today, but sorting and filtering lag by a third of a second |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | dashboard |
| **Created** | 2026-10-05 |
| **Depends on** | none |
| **TODO.md row** | — (filled in when started) |

## Context

`components/momentum/MomentumScoresView.tsx` renders all 744 scored stocks at once: about
9,900 DOM nodes, each row with several score pills. Measured with the Event Timing API on a
production build (2026-10-04):

- Sort-header click: 328–344 ms per interaction.
- Filter typing: 152 ms on the first keystroke, and up to 480 ms when the filter is cleared
  (all 744 rows come back).
- Opening the section: one long task of ~200–350 ms to mount the table. Since `c04ec51` the
  data comes from the cache on a revisit, so this render is most of what is left (~0.5 s).

Each keystroke re-filters, re-sorts and re-renders every row synchronously.

## Goal

Sort, filter and lookback changes respond in < 100 ms. The table mounts with < 2,000 DOM
nodes.

## Out of scope

- The scores computation and API payload (a server-side `fields=` slimming could follow
  separately).

## Plan

### Phase 1 — Keep input responsive
- **Tasks:** `useDeferredValue` for the filter query and sort key. Extract a memoised
  `StockRow` (`React.memo`) so unchanged rows skip re-rendering.
- **Done when:** keystrokes measure < 50 ms in Event Timing; results are identical.

### Phase 2 — Render only what is visible
- **Tasks:** windowed rendering. Either a virtual list such as `@tanstack/react-virtual`, kept
  compatible with the table's sticky header and the expandable detail rows, or simple paging
  ("Show 100 more"). Keep the "N matching stocks" count accurate.
- **Done when:** sort and lookback clicks are < 100 ms, the DOM is < 2,000 nodes, and the
  `e2e/momentum-chart.spec.ts` "Momentum Scores exposes stock and sector details" test passes.

## Risks

- Virtualisation breaks in-page find (Ctrl+F) over all stocks. Paging keeps it partly;
  decide in Phase 2.

## Open questions

- Virtual scrolling or paging?

## Log

- 2026-10-05 — created from the Momentum UI performance review (2026-10-04 session).
