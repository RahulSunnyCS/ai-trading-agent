# BL-030 — Consolidation tightness as a Momentum ranking feature (the cheap "flag")

| | |
|---|---|
| **Priority** | P1 — cheapest test of the owner's pattern idea; uses data and engine that already exist |
| **Status** | Idea |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | BL-010 (trust the evaluation arithmetic first), BL-015 (pre-registration) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner's idea (2026-10-06): famous chart patterns (head and shoulders, tight flags, cup and
handle) on daily or weekly stock data, and "what shape does a stock make before it runs up".
Discussion split it into four items: BL-030 (this), BL-031 (visual pattern detectors), BL-032
(stock analogues), BL-033 (feeding the results into the ranking).

Assessment: a tight flag is momentum plus volatility contraction — a sharp run-up followed by a
narrow, quiet range. That does not need a shape detector; it is a numeric feature that the
survivorship-free stock layer (`packages/momentum-backtesting/stocks/`, daily and weekly bars)
and the Broad Momentum engine (`categories/broad.py`, `compute_universe_ranking`) can already
compute and test. Momentum combined with low recent volatility is a known factor pairing, so the
prior that it adds something is reasonable; the question is whether it adds anything *here*,
after costs, on Indian stocks.

## Goal

A pre-registered answer to: does ranking the Broad Momentum pool by momentum **and** recent
consolidation tightness pick better than momentum alone?

## Out of scope

- Pivot-based shape detection (BL-031).
- Any change to the live weekly signal before the test passes and BL-025's rules allow it.

## Plan

### Phase 0 — Pre-register (BL-015)
- **Tasks:** fix the tightness definition (candidates: last-N-week high−low range as a fraction
  of price, or daily ATR, each relative to the preceding run-up or to the stock's own longer
  history), the lookback lengths, the combination rule (rank blend or filter), the baseline
  (current Broad Momentum ranking), the test window and walk-forward split, and the pass rule
  (incremental rank information or CAGR/drawdown over the baseline, after turnover costs).
- **Done when:** committed before any run.

### Phase 1 — Feature
- **Tasks:** compute tightness per stock per week from `daily.parquet`, point-in-time (no
  future bars); expose it next to the momentum score.
- **Deliverables:** a feature column, a unit test that it reads nothing past the week end.
- **Done when:** the feature exists for every stock-week the ranking covers.

### Phase 2 — Test
- **Tasks:** run baseline vs momentum-plus-tightness through the existing engine under the
  pre-registered rule; record the result either way.
- **Done when:** pass or fail recorded in this file and the research log.

### Phase 3 — If it passes
- **Tasks:** hand over to BL-033 (ranking integration); show the feature in the Momentum Scores
  table.
- **Done when:** BL-033 picked up or this closed as "informative, not adopted".

## Risks

- Tuning the lookbacks after seeing results — the pre-registration is the only defence.
- Tightness and low volatility overlap; the test must say whether this is more than the
  known low-volatility effect.

## Open questions

1. One definition or two (range-based and ATR-based) tested side by side, with a correction for
   the extra chance of passing?
2. Blend into the score, or use as a filter on the top-N candidates? Filter is simpler to read.

## Log

- 2026-10-06 — created from the owner's chart-pattern idea; split out as the cheap first test.
