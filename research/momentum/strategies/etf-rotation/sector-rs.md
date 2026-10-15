# ETF rotation: sector score on its own relative-strength history

**Status:** Not tested · **Last updated:** 2026-10-14

## What it is

Every score the engine has today is cross-sectional: a sector is placed against the other sectors
that week. This idea places each sector's relative-strength line (sector / Nifty 50) within that
sector's own trailing history instead. A sector can top the cross-section and still sit at an
ordinary point of its own history.

Proposed signal ([BL-088](../../../../backlog/BL-088-own-history-sector-relative-strength.md),
reconstructed from the owner's summary of an X post, not yet confirmed against the post):

- `RS_t = ln(Sector_t / Nifty50_t)` on weekly closes, own trailing window W = 156 weeks.
- S1, RS level: the percentile of `RS_t` within its own last W weeks.
- S2, RS momentum: the 26-week change in RS, z-scored against the sector's own trailing
  distribution.
- Directions: continuation and reversal, each its own trial. Shapes: `replace` the ranking, or
  `tilt` (0.5 x live ranksum rank + 0.5 x score rank). 8 trials plus the baseline.
- Comparator: the live ETF config (25.8% / 0.99 / -30.5% on 2017-01 to 2026-09).

No code setting exists yet; Phase 1 would add a `rank_override` / `rank_tilt` hook, off by default.

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| — | — | — | Not run; status Idea, waiting on the post's exact rule (open question 1) | `search_spaces/bl088_criteria.json` does not exist yet |

## What we know

Prior own-history evidence collected in BL-088 (each covered on its own page):

- The cash hurdle (absolute momentum) was rejected twice ([gates](../../common/gates.md)).
- The 52-week-high gate was marginal ([gates](../../common/gates.md)).
- The grouped tilt, preferring the long-run beaten-down, won on ETFs and lost on Broad
  ([score](../../common/score.md)).
- `exclude_high_vol` is an ETF-only win ([gates](../../common/gates.md)).
- BL-050's R1 gate (26-week return must beat Nifty 500 TRI) passed its screen and failed the
  engine test on Broad ([Broad filters](../broad/filters.md)).

So the ETF / sector track is where own-history and contrarian signals have shown life; the item
starts there and reaches Broad's category layer only if the ETF test passes.

## Not yet tested

- Everything above. Proposed pass rule: rolling 3-year windows, median CAGR change at least +1.5
  points, CAGR and Sharpe win shares at least 70%, worst fall no more than 3 points deeper,
  deflated Sharpe at least 0.95, PBO below 0.5 over the 8 trials plus baseline; a sealed 2024-01
  to 2026-09 hold-out read once.
- Long sector history: an own-history window needs years of warm-up, so Phase 1 would backfill
  sector indices from niftyindices.com before 2016.

## In plain words

Instead of asking "which sector is strongest this week compared with the others?", ask "is this
sector strong compared with its own past few years?". It might pick sectors at a relative high
(continuation) or at a relative low (a turnaround). Nothing has been run yet.

## Related

- [ETF rotation](README.md), [score](../../common/score.md), [gates](../../common/gates.md).
