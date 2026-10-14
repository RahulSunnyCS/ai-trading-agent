# Momentum: tax and the tax hold

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `tax` / `TaxRules` | off; slab 0.30, cess 0.04, equity STCG 0.20, LTCG 0.125, long-term after 365 days | Per-lot tax on each sale, loss set-off, carry-forward. Each purchase (including a top-up) is its own lot | M, TODO 3.9.23 |
| `tax_hold_band` / `tax_hold_weeks` | 0 / 0 = off (Config, buffer rule with tax on) | Keep a gaining holding whose oldest lot turns long-term within `tax_hold_weeks` while its rank is within `exit_rank + tax_hold_band` | M, TODO 3.9.23 |

Rates are settings, not facts. Not modelled: the 1.25 lakh LTCG exemption, surcharge, the 8-year
carry-forward limit.

## Live value

Tax is off in `live_config.toml` and in the search (pre-tax ranking). BL-084 to BL-086 judged
their levers after tax at Rs 5 lakh with `TaxRules()` defaults
([`bl085_criteria.json`](../../../packages/momentum-backtesting/search_spaces/bl085_criteria.json)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | tax on vs off | ETF live strategy, 2017-01 to 2026-09 | About 4.9 points of CAGR go to tax; still ahead | After tax 20.9% / 0.77 / -30.5%, still +8.3 over Nifty 50 TRI |
| TODO 3.9.23 dry run | tax hold, band 3, 8 weeks, vs the tax-on baseline | ETF, 28 rolling 3-year windows | Neutral | 21.0% / 0.78 / -30.0%, rolling 57 / 39 / 25%, median +0.1. Average holds are about 9 weeks, so few lots ever get near 365 days |
| [BL-085](../../../backlog/BL-085-momentum-improvement-levers.md) baseline | tax at Rs 5 lakh | 11 Broad strategies, every phase blended | Tax costs 8 to 9 points a year: the largest single drag measured | FY2018-22: 38.3% before, 29.9% after tax. FY2023-26: 41.2% before, 32.4% after ([write-up](../../../packages/momentum-backtesting/docs/bl085-levers-2026-10-09.md)) |
| BL-085 L1 | tax hold band 2, 8 weeks, at cadences 4 / 6 / 8 / 13 | same | Killed; the hold never fires in Broad | Every Broad sale is an "ineligible" exit (the stock left its category or the pool); the hold only delays a sale caused by a rank slip ([`bl085_result.json`](../../../packages/momentum-backtesting/search_spaces/bl085_result.json)) |

## What we know

- Tax is the biggest lever left on Broad (8-9 points a year), and the existing tax-hold rule
  cannot touch it there. Cutting it would need a different rule, for example keeping a nearly
  year-old winner when its category drops out (BL-085 write-up; not tested).
- On ETFs almost every gain is short-term because holds average about 9 weeks.
- Today's tax rates are applied from 2017, a conservative bias (BL-010 F16).
- BL-010's minimum bar is Nifty200 Momentum 30 TRI + 5 points after tax; the after-tax re-check
  of the Phase 5 choices at Rs 5 lakh is parked in BL-010 Phase 7 (P3).

## Not yet tested

- A Broad tax rule that keeps a nearly long-term winner whose category dropped out.
- The LTCG exemption, surcharge and carry-forward limit.

## In plain words

**Tax (off by default).** When on, each purchase is its own tax lot. Gains held up to a year on
equity are taxed at 20%, longer than a year at 12.5%, plus 4% cess. Gold, silver,
international and bond funds use your income-tax rate for short holds. Average holds are about
9 weeks, so almost everything is short-term. Measured: tax takes about 5 points a year off the
ETF strategy (25.8% to 20.9%), which still beats Nifty with dividends by about 8 points. Waiting
a few extra weeks for a winner to become long-term did not help: hardly any holding lives that
long (TODO 3.9.23).

## Related

- [Costs](costs.md), [cadence](cadence.md) (trading less often), [caps](caps.md) (the cap band
  avoids small taxable trims).
