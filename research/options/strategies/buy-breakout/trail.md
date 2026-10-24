# Buy: trail

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

AlgoTest's two trail numbers `[X, Y]`: every X in the leg's favour (from the entry price to the
highest high since entry) moves the leg stop up by Y; it never loosens. Set by
`trail_sl: { points: [X, Y] }` or `{ percent: [X, Y] }`. Updated after the bar's stop check.

## Live value

`points: [1, 1]` on both legs (each full ₹1 of premium rise lifts the stop ₹1), live and rotation.
Bought at ₹50, the stop starts at ₹37.50 and then stays about ₹12.50 below the highest high.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | none, `[0.5, 0.5]`, `[2, 1]`, `[3, 1]` points (base `[1, 1]`) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; no trail row in a top-three list | [BL-097][bl097], [report][bl097q] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ net | Holdout Δ net | Holdout Δ drawdown | Files ≥ base | Files net > 0 |
|---|---|---|---|---|---|---|
| none | 48 | −5,661 | +2,753 | −8,788 (deeper) | 54% | 14 |
| `[0.5, 0.5]` | 48 | −408 | +120 | +225 | 67% | 3 |
| `[2, 1]` | 48 | −3,712 | −38 | −4,607 | 52% | 9 |
| `[3, 1]` | 48 | −4,181 | +355 | −7,356 | 54% | 11 |

## What we know

- Every looser trail (none, `[2, 1]`, `[3, 1]`) loses in the fit year and is about flat or up in the
  holdout, with a deeper holdout drawdown. No trail beats `[1, 1]` in both periods.
- Removing the trail lets winners run: more files end positive (14 of 48 against 3) but the
  drawdown is ₹8.8k deeper a file. It is a variance change, not an edge.
- Charges do not move (the trail adds no trades).

## Not yet tested

- The trailing-percent rows reserved for BL-097 Phase 3, now BL-104 (`[5, 2.5]`, `[10, 5]`, `[15, 5]`), to be
  run only if point trailing shows a stable signal; it has not.
- Trail × exit time (a BL-097 Phase 3 interaction, now BL-104).

## Related

- [Widesl trail](../widesl/trail.md), [Directional trail](../directional/trail.md), [leg stop](leg-sl.md).

[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md
