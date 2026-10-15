# Directional: trail

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

A trailing leg stop: with `[X, Y]`, every X% in the leg's favour moves its stop Y% (of the entry premium)
the same way. Set by `legs[].trail_sl: { percent: [X, Y] }`.

## Live value

None. The live file, the fixed base and every rotation Dir file run without a trail.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-096 secondary | none, [5,5]%, [10,5]%, [15,5]% on the shortlisted primary cells | holdout 2025-10-09 → 2026-10-09, before and **after charges** | Descriptive; exploratory (shortlist chosen after viewing the holdout) | [BL-096][bl096] |

| Configuration | Before charges (mean of 100 bases) | After charges |
|---|---|---|
| 30% / ₹4,000 / trail [10,5]% / RE COST ×1 | ₹82,490, ₹344 a day, drawdown −₹16,976, Ulcer ₹5,185, MTM stops 4.3% | ₹187 a day, drawdown −₹22.4k, Ulcer ₹8.6k |
| 25% / ₹4,000 / no trail / RE COST ×1 | ₹81,783, ₹341 a day, drawdown −₹18,650, Ulcer ₹5,967 | ₹184 a day |
| 30% / ₹4,000 / no trail / RE COST ×1 | ₹320 a day | ₹170 a day |

## What we know

- The trail helps only with the widest leg stop on the shortlist (30%): there it lifts net from ₹170 to ₹187 a day
  and gives the best balance of return and tail of the shortlist ("best balanced", BL-096).
- Elsewhere it is mixed: it hurts NIFTY morning entries at 21% and helps SENSEX morning entries.
- The trail [10,5]% appears in many pre-charge band and start-time leaders ([pre-charge list][bl096q]); the
  post-charge 15k lists ran without a trail, so they cannot show it.
- Exploratory, one holdout year, before slippage.

## Not yet tested

- A trail on the full 15k primary grid after charges (the extension kept "no trail" to stay at 15,000 rows).
- Point trails.

## Related

- [Widesl trail](../widesl/trail.md); [leg stop](leg-sl.md).
- Results: `research/bl096/results/` (git-ignored; `research/bl096/run_enriched.py` regenerates the
  diagnostic and charged shortlist files).

[bl096]: ../../../../backlog/BL-096-directional-parameter-sweep.md
[bl096q]: ../../../../backlog/BL-096-directional-qualified-list.md
