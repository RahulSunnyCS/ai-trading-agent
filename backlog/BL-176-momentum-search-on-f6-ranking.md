# BL-176 — Momentum: re-run the strategy search on the F6-fixed (point-in-time) ranking

| | |
|---|---|
| **Priority** | P1 — the followed strategy and the favourites were chosen on a ranking with a hindsight-bearing cross-section; the selection itself may carry it |
| **Status** | Planned |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-28 |
| **Depends on** | BL-001's F6 fix (PRs #318 → #319 → #322) merged; [BL-010](BL-010-momentum-evaluation-review.md) (the search and its criteria files) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-001's F6 finding: Broad's `voladj` score z-scored members against every stock column in the frame, including stocks that only joined a later year's `turnover_rank` list, and filled internal gaps depending on the end of the data. The fix ranks over each week's point-in-time members only. On live data it moves the followed strategy (Four Sectors Monthly, No Tilt) from 42.93% to 35.03% CAGR and most favourites by 3.5–10 points (`packages/momentum-backtesting/docs/lookahead-requests-2026-10-24.md`). BL-010's search, which picked these strategies, ran on the old ranking.

## Goal

A pre-registered re-run of the BL-010 selection on the fixed ranking says whether Four Sectors Monthly, No Tilt is still a reasonable choice, and which favourites keep their place.

## Plan

- **Phase 0 — Pre-register.** Before any run (research gate): which search space, which BL-010 criteria file(s) apply unchanged, what counts as "the followed strategy still holds" (e.g. still within the top quartile of the basket and above Mom30 TRI by the BL-010 margin), the hold-out. Commit it.
- **Phase 1 — Run and read.** Run the registered search; record the verdict; update `research/momentum/` pages. **Done when:** the verdict is in the Log and the owner has decided whether the money keeps following Four Sectors.

## Log

- 2026-10-28 — created when the owner closed its parent item (2026-10-28). Status `Planned`.
