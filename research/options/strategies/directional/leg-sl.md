# Directional: leg stop

**Status:** Descriptive · **Last updated:** 2026-10-23

## What it is

The stop on each short leg, as a rise over that leg's entry premium (21% closes the leg at 1.21 × the
entry price). Set by `legs[].stop_loss: { percent: 21 }`. With partial square-off only the stopped leg
closes; with RE COST ×1 it can be re-sold once (see [re-entry](re-entry.md)).

## Live value

21% on both legs, in the live file, the fixed base and all 100 rotation Dir files.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-096 primary | 10, 15, 21, 25, 30, 35% × MTM ₹2,000–₹4,000 × exit 14:50–15:28, all 100 Dir bases (15,000 cells) | fit 2024-10-09 → 2025-10-08, holdout 2025-10-09 → 2026-10-09, 488 sessions | Descriptive (registered as descriptive) | [BL-096][bl096] |
| BL-096 charged shortlist | 21% / 25% / 30% with ₹3,000–₹4,000 | holdout, **after charges** (₹20 an order + statutory), no slippage | Descriptive; shortlist chosen after viewing the holdout | [BL-096][bl096] |

Charged shortlist, mean over the 100 bases, ₹ per day net (before charges in brackets) ([BL-096][bl096]):

| Leg stop / MTM | Net ₹/day |
|---|---|
| 21% / ₹3,000 (live baseline) | 151 (313) |
| 25% / ₹3,500 | 175 (331) |
| 25% / ₹4,000 | 184 (341) |
| 30% / ₹4,000 | 170 (320) |
| 30% / ₹4,000 + trail [10,5]% | 187 (344) |
| BL-156 Amendment 1 | Leg stop checked on every tick (the engine: bar high / low) vs at the 1-minute close (exit at that close), crossed with the MTM rule | T1's Adaptive picks, 2025-01-10 → 2026-10-22, 1 lot, after brokerage | **Tick is better**: candle-close leg stops cost −₹429 a day on the book (−₹588 to −₹270), in every half-year; Dir (21 % stop): −₹220 a pick | [BL-156][bl156] |

Post-charge band leaders use leg stops of 21–35%: NIFTY 30% (09:15–11:00), 25% (11:00–13:00), 35%
(13:00–15:30); SENSEX 25%, 21%, 35% ([BL-096 post-charge][bl096pc]).

## What we know

- The live 21% / ₹3,000 is the weakest of the shortlisted cells; 25% / ₹4,000 makes about ₹33 a day more
  after charges with a shallower drawdown (BL-096).
- No single leg stop wins everywhere. The band leaders scatter from 21% to 35%, and at single start times
  the pre-charge leaders run from 10% to 35% ([15k exact-time list][bl096x]).
- Wider stops cut the stop frequency but can deepen the tail; the item asks for return to be read with
  stop rate, CVaR, drawdown and Ulcer Index.
- The shortlist was revised after viewing holdout results, so its numbers are optimistic. One holdout
  year; nothing is adopted.

## Not yet tested

- A chosen leg stop confirmed on days not used to choose it (NIFTY 2022–24 is in the lake).
- CE/PE-asymmetric stops (out of scope by registration). CE contributed more than PE in all three
  pre-charge shortlist candidates (about ₹58,616 vs ₹24,925 for the first).

## Related

- [Widesl leg stop](../widesl/leg-sl.md); [Dir MTM stop](mtm-sl.md); [trail](trail.md).
- Results: `research/bl096/results/` (`primary_summary.csv`, `diagnostic_metrics.csv`,
  `shortlist_charged.csv`, `primary_diagnostics_charged.csv`), git-ignored. `research/bl096/run_enriched.py`
  regenerates the diagnostic and charged files (`--full-primary` for all 15,000 cells); the script behind
  the first primary and secondary summaries is not in the repo.

[bl096]: ../../../../backlog/BL-096-directional-parameter-sweep.md
[bl096pc]: ../../../../backlog/BL-096-directional-qualified-list-post-charge.md
[bl096x]: ../../../../backlog/BL-096-directional-qualified-list-primary-15k-exact-times.md
[bl156]: ../../../../backlog/BL-156-mtm-stop-tick-vs-candle-close.md
