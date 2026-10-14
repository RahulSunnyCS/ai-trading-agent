# Momentum lab: parameter reference

Moved to [`research/momentum/`](../research/momentum/README.md) on 2026-10-14: one page per
parameter, each with its default, mechanism, measured verdict and evidence grade, plus the later
backlog results (BL-010, BL-035, BL-042, BL-043, BL-050, BL-084 to BL-088).

Where each old section went:

| Old section | New page |
|---|---|
| Purpose, evidence grades, "How the 2026-10-01 numbers read" | [research/momentum/README.md](../research/momentum/README.md#how-to-read-the-numbers) |
| ETF baseline | [ETF rotation](../research/momentum/strategies/etf-rotation/README.md) |
| Broad baseline | [Broad](../research/momentum/strategies/broad/README.md) |
| 1. Universe and data: `start`, `end`, `universe` / `include_optional`, weekly close | [Universe](../research/momentum/common/universe.md) |
| 1. `benchmark`, comparison lines | [Benchmarks](../research/momentum/common/benchmarks.md) |
| 2. `lookbacks`, `weights`, tie-break | [Lookbacks](../research/momentum/common/lookbacks.md) |
| 2. Skip-month ranksum, `voladj_skip_recent_month` | [Skip-month](../research/momentum/common/skip-month.md) |
| 2. `score` | [Score](../research/momentum/common/score.md) |
| 3. `top_n`, `exit_rank`, zero-cost check | [Top N and exit rank](../research/momentum/common/top-n-exit-rank.md) |
| 4. `portfolio`, `entry` | [Portfolio rule and entry](../research/momentum/common/portfolio-entry.md) |
| 4. `max_position`, `cap_band`, `max_group`, `max_stock_price`, `MIN_TRADE` | [Caps](../research/momentum/common/caps.md) |
| 4. `exclude_high_vol` | [Gates](../research/momentum/common/gates.md) |
| 4. `commodity_copies`, `debt_copies` | [Custom Index inner and outer rotation](../research/momentum/strategies/custom-index/inner-outer-rotation.md) |
| 5. `defensive`, 52-week-high, smoothness, trend / breadth gates | [Gates](../research/momentum/common/gates.md) |
| 5. `momentum_sizing`, `mass_exit_*`, vol targeting, dispersion timing | [Sizing](../research/momentum/common/sizing.md) |
| 6. `cost_pct`, `cost_model` | [Costs](../research/momentum/common/costs.md) |
| 6. `tax` / `TaxRules`, `tax_hold_band` / `tax_hold_weeks` | [Tax](../research/momentum/common/tax.md) |
| 7. `signal_delay`, `execution`, `track`, `premium_warn_pct` | [Execution](../research/momentum/common/execution.md) |
| 7. `rebalance`, `rebalance_every` / `rebalance_offset`, overlapping tranches | [Cadence](../research/momentum/common/cadence.md) |
| 8. `min_ranked` | [Broad: simulate every week](../research/momentum/strategies/broad/min-ranked.md) |
| 8. Pool, coverage floor, category and pick settings, off-mode, cold-start caveat | [Broad funnel](../research/momentum/strategies/broad/funnel.md) |
| 9. Custom Index tab | [Custom Index inner and outer rotation](../research/momentum/strategies/custom-index/inner-outer-rotation.md) |
| 10. Reversal / turnaround sleeve | [Reversal sleeve](../research/momentum/common/reversal-sleeve.md) |
| 11. Dry-run appendix: reproduce commands, what the study supports | [research/momentum/README.md](../research/momentum/README.md#the-2026-10-01-dry-run) |
| 11. One real Friday (2026-09-18) | [ETF rotation](../research/momentum/strategies/etf-rotation/README.md#a-real-friday-2026-09-18) |
