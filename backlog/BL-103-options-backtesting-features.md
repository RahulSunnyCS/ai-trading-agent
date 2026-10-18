# BL-103 — Options backtesting features: "is this real?", breakdowns, smarter builder, real costs

| | |
|---|---|
| **Priority** | P2 — makes the builder's results trustworthy and closer to AlgoTest; follows BL-102's builder |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options |
| **Created** | 2026-10-14 |
| **Depends on** | BL-102 Phase 1c (leg grid) and Phase 2 (result widgets) |
| **TODO.md row** | — (filled in when started) |

## Context

Owner (2026-10-14): "also think of what are new things we can add in backtesting", then chose all
four groups below. A review of the engine against the dashboard found that all 44 HTTP routes are
called, so the gaps are elsewhere:

- **CLI and MCP only:** walk-forward, sweeps and the overfit guard (PBO, deflated Sharpe)
  (`analytics/walkforward.py`, `sweep.py`, `overfit.py`) work only on the older YAML engine.
- **Never asked for:** the bootstrap confidence interval. `POST /runs` supports it, but the
  dashboard never sends the flag.
- **Not modelled in leg-wise:**
  - delta- or width-based strikes
  - entry filters
  - overall trailing or lock-profit (only rotation baskets have it, `rotation/portfolio.py`)
  - itemised Indian charges (`engine/costs.py` is a flat charge)
  - margin or return on margin (the DSL engine has `engine/margin.py`)
- **Data with no screen:** the IV, greeks and chain tables in `derived/` (`iv_daily`,
  `chain_snapshots_5m`) and the stock options in the lake.

## Goal

Every builder result says how much to trust it, when it works, and what it costs, and the builder
can express the common AlgoTest rules.

## Out of scope

The UI layout itself (BL-102), and any change to the rotation's registered rules.

## Plan

One phase per group, in this order:

### Phase 1 — "Is this real?" (#1, #12)
- **Tasks:** for leg-wise strategies, a panel showing walk-forward in-sample vs out-of-sample,
  parameter sweep with the overfit guard (PBO, deflated Sharpe) on by default, a bootstrap 90%
  range of net, and Monte Carlo drawdowns from shuffling the order of trading days.
- **Done when:** a builder result shows the four lines, each linked to its Guide explanation.

### Phase 2 — Breakdowns and compare (#2, #3)
- **Tasks:** results by weekday, DTE (calendar days), VIX/IV band and opening gap, with thin
  buckets greyed. Compare two runs: overlaid equity and a diff of their settings. Favourites from
  BL-102 are the default picks.

### Phase 3 — Smarter builder (#4, #5, #6)
- **Tasks:**
  - strikes by delta, by premium ≥/≤, and by straddle width
  - entry filters: weekday, DTE, VIX/IV band, and several entry times
  - an overall trailing stop or lock-profit, and trail-to-cost

  Each is a schema field in `legwise/schema.py`, an engine rule, and a builder column or token.

### Phase 4 — Real costs and margin (#7, #8)
- **Tasks:** itemised charges (brokerage, STT, exchange, GST, stamp, SEBI), calibrated against
  `packages/contract-notes`; margin and return on margin for leg-wise strategies.

### Phase 5 — Lower priority (#9–#11)
- **Tasks:** an AlgoTest parity check in the UI (`obt legwise compare`); stock options and
  NIFTYNXT50 in the builder; a "Re-run stale strategies" button. The 5-minute bars and
  excluded-days switches ship earlier, in BL-102 Phase 1c.

## Risks

- **Research gate.** Phases 1 and 2 run new comparisons. The sweep UI must keep the overfit
  guard visible, and any study run through it needs its pre-registration committed first
  (CLAUDE.md research gate).
- **Engine changes.** Phases 3 and 4 change engine output, so the legwise goldens
  (`tests/golden/test_legwise_scenarios.py`) must stay identical for the existing strategies.

## Open questions

- Where should Monte Carlo cut the series: shuffle whole days, or blocks of days?
- What brokerage per order should the charges default to?

Both are to be asked when the item starts.

## Log

- 2026-10-14 — created with BL-102. The owner wants all four groups; phase order 1 → 2 → 3 → 4 → 5.
