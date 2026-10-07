# BL-031 — Classical chart-pattern detectors on weekly and daily stock data

| | |
|---|---|
| **Priority** | P2 — achievable, but subjective definitions, thin samples and weak published evidence; do after BL-035 |
| **Status** | Idea |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | BL-035 (shows whether the cheap version carries anything), BL-015 |
| **TODO.md row** | — (filled in when started) |

## Context

The owner's idea (2026-10-06): detect head and shoulders, inverse head and shoulders, tight
flags and cup and handle on weekly or daily (not hourly) stock data. Split from the same
discussion as BL-035, BL-032 and BL-033.

Assessment:

- Detection is a known technique: smooth the series, find swing highs and lows, match the
  pivot sequence against a rule set (Lo, Mamaysky and Wang, 2000, did exactly these shapes).
  Flags are easy; head and shoulders and cup and handle are fuzzy, and the number of detected
  instances swings widely with the smoothing and tolerance parameters.
- Published evidence is weak: patterns shift return distributions slightly, little or no edge
  after costs, nothing specific to Indian large caps.
- Sample size at weekly resolution is thin — a few hundred stocks over ten years yields perhaps
  a few hundred clean head-and-shoulders instances. Enough to test, not enough to tune.

## Goal

For each pattern, a fixed detector and a pre-registered answer to whether completion of the
pattern predicts the next 1–6 months of market-relative return better than no information.

## Out of scope

- Hourly or intraday bars.
- Image-based or learned detectors.
- Using detections as a signal before BL-033.

## Plan

### Phase 0 — Pre-register (BL-015)
- **Tasks:** fix each pattern's rule set and parameters, the pivot method, the horizon(s), the
  baseline and the pass rule with a multiple-testing correction across patterns and horizons.
- **Done when:** committed before any run.

### Phase 1 — Pivots and detectors
- **Tasks:** swing-point extraction on weekly bars (daily for flags); detectors for tight flag,
  head and shoulders (both), cup and handle; a small hand-labelled set to check precision.
- **Deliverables:** a detections table (stock, date, pattern, parameters, geometry).
- **Done when:** detectors run over the whole survivorship-free universe and the hand-labelled
  check is recorded.

### Phase 2 — Outcome test
- **Tasks:** forward market-relative returns after each completion, blocked by stock and time
  to handle overlapping samples; judge against Phase 0.
- **Done when:** pass or fail recorded per pattern.

### Phase 3 — Show it
- **Tasks:** mark detections on the dashboard's stock charts (Momentum tab), labelled "not a
  signal" where Phase 2 failed.
- **Done when:** visible for research use.

## Risks

- Subjectivity: a detector tuned until it "finds the ones I see" is fitted to hindsight.
- Few samples per pattern; a single bull run can dominate the outcomes.

## Open questions

1. Which patterns in the first pass — flags and head and shoulders only, cup and handle later?
2. Weekly only, or weekly for shapes and daily for flag tightness?

## Log

- 2026-10-06 — created from the owner's chart-pattern idea.
- 2026-10-07 — the flag, high tight flag and cup and handle detectors are built and tested under
  [BL-041](BL-041-chart-pattern-poc.md) (POC). This item keeps head and shoulders and the rest of
  BL-041's pattern catalogue.
