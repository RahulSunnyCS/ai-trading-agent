# BL-022 — "Days like today": analog-day search for intraday options

| | |
|---|---|
| **Priority** | P2 — promising for option sellers but speculative; needs BL-009's clean data first |
| **Status** | Idea |
| **Type** | research |
| **Area** | options (+ trading-data, dashboard) |
| **Created** | 2026-10-06 |
| **Depends on** | BL-009 Phase 2 (vendor 1-minute history ingested), BL-015 (pre-registration) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner's idea (2026-10-06): traders read how the market is moving and anticipate what comes
next, a bit like an LLM predicting the next token from similar past contexts. Describe each day
as a vector; when a similar day comes, show what happened on the most similar past days, using
price, India VIX and other context.

Assessment from the same discussion:

- This is a known technique (analog or nearest-neighbour forecasting). It fits an option
  seller: predicting the rest-of-day *range* (volatility) is far more tractable than direction.
- The LLM comparison breaks down: about 2,400 NIFTY sessions, non-stationary rules (expiry
  weekdays, lot sizes, SEBI changes), and patterns that get traded away. An LLM should be the
  interface ("show me days like today and summarise"), via the existing `obt-mcp` server, not
  the predictor.
- Options Lab already has day forensics, day anatomy and market regimes to build on.

## Goal

At any cut-off time in the session (a regular grid — see open question 1), find the most similar
past sessions up to that time and test whether their rest-of-day outcomes predict today's better
than a simple baseline.

## Out of scope

- Learned embeddings or time-series foundation models until v0 shows something.
- Using it as a live trade signal.

## Plan

### Phase 0 — Pre-register (BL-015)
- **Tasks:** fix the cut-off grid (open question 1), the feature list, the outcome (rest-of-day high−low as % of spot,
  straddle decay), the baseline (VIX-implied move for the rest of the day), the test window
  (2021–2024, walk-forward), and the pass rule.
- **Done when:** committed before any run.

### Phase 1 — Day features up to the cut-off
- **Tasks:** per session, using only data up to the cut-off: gap %, opening-range size against
  recent average range, the first-30-minute path (normalised, resampled), India VIX level and
  change, prior-day range, 5- and 20-day trend, days to expiry, ATM straddle price against the
  VIX-implied value.
- **Done when:** a feature table exists for every ingested session, with a test that no feature
  reads past the cut-off.

### Phase 2 — Search and walk-forward test
- **Tasks:** standardise features; k-nearest-neighbours over *earlier days only*; score against
  the baseline per Phase 0.
- **Done when:** a pass or fail recorded against the pre-registered rule.

### Phase 3 — Show it (whatever Phase 2 says)
- **Tasks:** Options Lab view of the 20 nearest days: rest-of-day charts overlaid, outcome
  distribution; an MCP tool `similar_days`.
- **Done when:** usable for research; labelled "not a signal" if Phase 2 failed.

## Risks

- Look-ahead: any feature that reads past the cut-off, or an analog pool that includes later
  days, makes the test meaningless.
- Rule changes make old days incomparable; test whether pre-2020 days help or add noise.

## Open questions

1. **Cut-off times — to discuss.** Owner wants this generic rather than one fixed time: run the
   search at a regular grid of cut-offs (e.g. every 30 minutes, 09:45 → 15:00) and predict the
   rest of the day from each, including a first-half → second-half view (about 12:30). Open
   points: the grid step (15 / 30 / 60 min); whether the pass rule is judged per cut-off or
   across all of them (more cut-offs = more chances to pass by luck, so the rule must account
   for it); and whether the feature set changes with the time of day.
2. Is the India VIX 1-minute series complete in the vendor data (BL-009 found 2019 missing in
   the sample)?

## Log

- 2026-10-06 — created from the owner's idea and the discussion of it.
- 2026-10-06 — owner: make it generic over the time of day (e.g. every 30 minutes, including a
  first-half → second-half prediction) rather than one fixed cut-off; grid to be discussed.
