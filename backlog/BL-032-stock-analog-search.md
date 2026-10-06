# BL-032 — "Stocks like this": analog-path search for six-month stock outcomes

| | |
|---|---|
| **Priority** | P2 — BL-022's idea applied to stocks; the data layer makes it cheap, the prior for beating momentum is modest |
| **Status** | Idea |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | BL-010, BL-015; shares nearest-neighbour machinery with BL-022 (whichever lands first makes the other cheaper) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner's idea (2026-10-06): the morning-to-evening analog idea for options (BL-022) applied
to stocks — if a stock's recent path looks like past paths, what did those do over the next six
months, and what shape usually precedes a run-up? Split from the same discussion as BL-035,
BL-031 and BL-033.

Assessment: this is nearest-neighbour forecasting over normalised return paths. The
survivorship-free, corporate-action-adjusted stock layer (`packages/momentum-backtesting/stocks/`)
is exactly what it needs, and weekly bars are the right resolution for a six-month horizon.
Honest prior: shape-only neighbours for six-month returns usually turn out to be a noisier
restatement of momentum and reversal, so the test is whether it adds anything *beyond* the
existing momentum score, not whether it predicts at all.

## Goal

At any week, for any stock, the nearest past stock-paths and the distribution of their forward
market-relative returns; and a pre-registered answer to whether that distribution adds
information beyond the Broad Momentum score.

## Out of scope

- Learned embeddings or time-series foundation models until v0 shows something.
- Live use as a signal (BL-033 decides integration).

## Plan

### Phase 0 — Pre-register (BL-015)
- **Tasks:** fix the path window (26 and 52 weeks), normalisation (market-relative, z-scored),
  distance, k, horizons (3 and 6 months), the baseline (momentum score alone), the walk-forward
  window and the pass rule (incremental rank information).
- **Done when:** committed before any run.

### Phase 1 — Path table
- **Tasks:** per stock-week, the normalised market-relative path and the forward outcomes;
  earlier-dates-only search pool.
- **Done when:** a test proves no path or outcome reads past its own date.

### Phase 2 — Search and test
- **Tasks:** k-nearest neighbours over earlier dates only; significance blocked by stock and
  time (adjacent weeks of one stock are nearly the same sample); judge against Phase 0.
- **Done when:** pass or fail recorded.

### Phase 3 — Show it
- **Tasks:** Momentum tab view: the 20 nearest paths overlaid, outcome distribution; an API
  endpoint on `mbt serve`.
- **Done when:** usable for research; labelled "not a signal" if Phase 2 failed.

## Risks

- Market factor: in a broad rally every stock looks alike — matching on raw returns rediscovers
  "the index went up".
- Overlapping windows inflate naive significance several-fold.

## Open questions

1. Pool across all stocks, or same-stock history only? (All stocks gives samples; same-stock
   gives comparability.)
2. Build on BL-022's code or the reverse — which starts first?

## Log

- 2026-10-06 — created from the owner's analog-for-stocks idea.
