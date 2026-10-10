# Accepted changes to the frozen results

## 2026-10-05 (on top of `b664542`)

First freeze: the engine as merged in b664542, before the Phase 2 fixes E10 to E13.

| Scenario | CAGR | Max drawdown |
|---|---|---|
| etf_default | n/a -> 24.58% | n/a -> -30.51% |
| etf_slots_ranked_weighted_delayed | n/a -> 17.45% | n/a -> -31.45% |
| etf_filter_taxed_itemised | n/a -> 15.52% | n/a -> -42.00% |
| etf_traded_at_monday_open_tilted | n/a -> 31.34% | n/a -> -24.56% |
| etf_fortnightly_make_room_sized | n/a -> 19.81% | n/a -> -25.81% |
| stock_default | n/a -> 10.78% | n/a -> -28.97% |
| stock_voladj_monthly | n/a -> 13.70% | n/a -> -16.00% |
| stock_blend_slots | n/a -> 6.77% | n/a -> -29.50% |
| custom_index_default | n/a -> 22.71% | n/a -> -29.20% |
| custom_index_inner_and_copies | n/a -> 15.76% | n/a -> -25.90% |
| broad_default | n/a -> 18.29% | n/a -> -26.72% |
| broad_category_mode_off | n/a -> 37.62% | n/a -> -27.73% |
| broad_one_category_three_picks_four_weekly | n/a -> 32.13% | n/a -> -35.20% |
| broad_eight_categories_one_pick | n/a -> 26.32% | n/a -> -27.29% |
| broad_gates_loosened_and_tilted | n/a -> 9.34% | n/a -> -27.78% |
| broad_two_categories_three_picks_fortnightly_taxed | n/a -> 13.94% | n/a -> -18.09% |

## 2026-10-05 (on top of `b664542`)

Custom Index scenario now sets inner_top_n to 3 so the coverage test has a non-default value; no code change.

| Scenario | CAGR | Max drawdown |
|---|---|---|
| custom_index_inner_and_copies | 15.76% -> 16.55% | -25.90% -> -19.37% |

## 2026-10-06 (on top of `e26a479`)

Holdings within a week are now compared in name order: equal weights tie-broke differently on Linux CI. No code or result change.

| Scenario | CAGR | Max drawdown |
|---|---|---|
| etf_default | 24.58% -> 24.58% | -30.51% -> -30.51% |
| etf_slots_ranked_weighted_delayed | 17.45% -> 17.45% | -31.45% -> -31.45% |
| etf_filter_taxed_itemised | 15.52% -> 15.52% | -42.00% -> -42.00% |
| etf_traded_at_monday_open_tilted | 31.34% -> 31.34% | -24.56% -> -24.56% |
| etf_fortnightly_make_room_sized | 19.81% -> 19.81% | -25.81% -> -25.81% |
| stock_default | 10.78% -> 10.78% | -28.97% -> -28.97% |
| stock_voladj_monthly | 13.70% -> 13.70% | -16.00% -> -16.00% |
| stock_blend_slots | 6.77% -> 6.77% | -29.50% -> -29.50% |
| custom_index_default | 22.71% -> 22.71% | -29.20% -> -29.20% |
| custom_index_inner_and_copies | 16.55% -> 16.55% | -19.37% -> -19.37% |
| broad_default | 18.29% -> 18.29% | -26.72% -> -26.72% |
| broad_category_mode_off | 37.62% -> 37.62% | -27.73% -> -27.73% |
| broad_one_category_three_picks_four_weekly | 32.13% -> 32.13% | -35.20% -> -35.20% |
| broad_eight_categories_one_pick | 26.32% -> 26.32% | -27.29% -> -27.29% |
| broad_gates_loosened_and_tilted | 9.34% -> 9.34% | -27.78% -> -27.78% |
| broad_two_categories_three_picks_fortnightly_taxed | 13.94% -> 13.94% | -18.09% -> -18.09% |

## 2026-10-06 (on top of `9ea65a6`)

BL-010 E10 to E12. E10: a stock with no session in a week can be neither bought nor sold when circuit locks are respected. E11: a price series that has ended leaves the pool at once, not at the next quarter. E12: selling everything at the end of a taxed run pays one depository charge per stock, not per lot.

| Scenario | CAGR | Max drawdown |
|---|---|---|
| etf_filter_taxed_itemised | 15.52% -> 15.52% | -42.00% -> -42.00% |
| broad_default | 18.29% -> 18.67% | -26.72% -> -26.72% |
| broad_category_mode_off | 37.62% -> 36.99% | -27.73% -> -28.58% |
| broad_one_category_three_picks_four_weekly | 32.13% -> 32.13% | -35.20% -> -35.20% |
| broad_eight_categories_one_pick | 26.32% -> 26.32% | -27.29% -> -27.29% |
| broad_gates_loosened_and_tilted | 9.34% -> 9.34% | -27.78% -> -27.78% |
| broad_two_categories_three_picks_fortnightly_taxed | 13.94% -> 13.94% | -18.09% -> -18.09% |

## 2026-10-06 (on top of `d88066d`)

Nifty 50 Sep-2026 review (BSE in, Wipro out, effective 2026-09-30): BSE (C0096) now appears in the stock-mode companies list; no numeric result moved

| Scenario | CAGR | Max drawdown |
|---|---|---|
| stock_default | 10.78% -> 10.78% | -28.97% -> -28.97% |
| stock_voladj_monthly | 13.70% -> 13.70% | -16.00% -> -16.00% |
| stock_blend_slots | 6.77% -> 6.77% | -29.50% -> -29.50% |

## 2026-10-07 (on top of `6ecdefb`)

Add result.benchmarks: the dashboard benchmark picker's five dividend-inclusive indices (curve + headline stats) so the page can switch benchmark without a re-run. Additions only; no existing value changed.

| Scenario | CAGR | Max drawdown |
|---|---|---|
| etf_default | 24.58% -> 24.58% | -30.51% -> -30.51% |
| etf_slots_ranked_weighted_delayed | 17.45% -> 17.45% | -31.45% -> -31.45% |
| etf_filter_taxed_itemised | 15.52% -> 15.52% | -42.00% -> -42.00% |
| etf_traded_at_monday_open_tilted | 31.34% -> 31.34% | -24.56% -> -24.56% |
| etf_fortnightly_make_room_sized | 19.81% -> 19.81% | -25.81% -> -25.81% |
| stock_default | 10.78% -> 10.78% | -28.97% -> -28.97% |
| stock_voladj_monthly | 13.70% -> 13.70% | -16.00% -> -16.00% |
| stock_blend_slots | 6.77% -> 6.77% | -29.50% -> -29.50% |
| custom_index_default | 22.71% -> 22.71% | -29.20% -> -29.20% |
| custom_index_inner_and_copies | 16.55% -> 16.55% | -19.37% -> -19.37% |
| broad_default | 18.67% -> 18.67% | -26.72% -> -26.72% |
| broad_category_mode_off | 36.99% -> 36.99% | -28.58% -> -28.58% |
| broad_one_category_three_picks_four_weekly | 32.13% -> 32.13% | -35.20% -> -35.20% |
| broad_eight_categories_one_pick | 26.32% -> 26.32% | -27.29% -> -27.29% |
| broad_gates_loosened_and_tilted | 9.34% -> 9.34% | -27.78% -> -27.78% |
| broad_two_categories_three_picks_fortnightly_taxed | 13.94% -> 13.94% | -18.09% -> -18.09% |

## 2026-10-07 (on top of `b2a8385`)

response.benchmarks[].reason added for indices that are unavailable for a run (no data, starts late, ends early, or a gap over one week); aligned() now refuses a hole longer than one week instead of filling it flat. No existing value moved.

| Scenario | CAGR | Max drawdown |
|---|---|---|
| etf_default | 24.58% -> 24.58% | -30.51% -> -30.51% |
| etf_slots_ranked_weighted_delayed | 17.45% -> 17.45% | -31.45% -> -31.45% |
| etf_filter_taxed_itemised | 15.52% -> 15.52% | -42.00% -> -42.00% |
| etf_traded_at_monday_open_tilted | 31.34% -> 31.34% | -24.56% -> -24.56% |
| etf_fortnightly_make_room_sized | 19.81% -> 19.81% | -25.81% -> -25.81% |
| stock_default | 10.78% -> 10.78% | -28.97% -> -28.97% |
| stock_voladj_monthly | 13.70% -> 13.70% | -16.00% -> -16.00% |
| stock_blend_slots | 6.77% -> 6.77% | -29.50% -> -29.50% |
| custom_index_default | 22.71% -> 22.71% | -29.20% -> -29.20% |
| custom_index_inner_and_copies | 16.55% -> 16.55% | -19.37% -> -19.37% |
| broad_default | 18.67% -> 18.67% | -26.72% -> -26.72% |
| broad_category_mode_off | 36.99% -> 36.99% | -28.58% -> -28.58% |
| broad_one_category_three_picks_four_weekly | 32.13% -> 32.13% | -35.20% -> -35.20% |
| broad_eight_categories_one_pick | 26.32% -> 26.32% | -27.29% -> -27.29% |
| broad_gates_loosened_and_tilted | 9.34% -> 9.34% | -27.78% -> -27.78% |
| broad_two_categories_three_picks_fortnightly_taxed | 13.94% -> 13.94% | -18.09% -> -18.09% |

## 2026-10-09 (on top of `874fe2f`)

BL-056: new scenario for the All Fridays split; no existing scenario moved

| Scenario | CAGR | Max drawdown |
|---|---|---|
| broad_one_category_three_picks_four_weekly_all_fridays | n/a -> 17.88% | n/a -> -35.50% |

## 2026-10-09 (on top of `cc65bab`)

Broad results' This week section (latest) is now the engine's own decision for the run's last week (cadence, price ceiling, circuit locks), not the advisory panel; no backtest result moved

| Scenario | CAGR | Max drawdown |
|---|---|---|
| broad_default | 18.67% -> 18.67% | -26.72% -> -26.72% |
| broad_category_mode_off | 36.99% -> 36.99% | -28.58% -> -28.58% |
| broad_one_category_three_picks_four_weekly | 32.13% -> 32.13% | -35.20% -> -35.20% |
| broad_eight_categories_one_pick | 26.32% -> 26.32% | -27.29% -> -27.29% |
| broad_gates_loosened_and_tilted | 9.34% -> 9.34% | -27.78% -> -27.78% |
| broad_two_categories_three_picks_fortnightly_taxed | 13.94% -> 13.94% | -18.09% -> -18.09% |

## 2026-10-10 (on top of `c0619d6`)

BL-056 review: an All Fridays run has no combined signal. Its latest section is now a note with no rows (split: true) instead of signals judged against the union of every sleeve's holdings. No CAGR, drawdown or trade changes.

| Scenario | CAGR | Max drawdown |
|---|---|---|
| broad_one_category_three_picks_four_weekly_all_fridays | 17.88% -> 17.88% | -35.50% -> -35.50% |
## 2026-10-10 (on top of `3c31f81`)

BL-036 Phase 1: every category-mode Broad result carries the extended-tags companion (response.companion); the six Broad scenarios pin broad_universe=total_market now that a fresh dashboard run defaults to turnover_rank; no CAGR, drawdown or trade moved

| Scenario | CAGR | Max drawdown |
|---|---|---|
| broad_default | 18.67% -> 18.67% | -26.72% -> -26.72% |
| broad_category_mode_off | 36.99% -> 36.99% | -28.58% -> -28.58% |
| broad_one_category_three_picks_four_weekly | 32.13% -> 32.13% | -35.20% -> -35.20% |
| broad_eight_categories_one_pick | 26.32% -> 26.32% | -27.29% -> -27.29% |
| broad_gates_loosened_and_tilted | 9.34% -> 9.34% | -27.78% -> -27.78% |
| broad_two_categories_three_picks_fortnightly_taxed | 13.94% -> 13.94% | -18.09% -> -18.09% |

## 2026-10-10 (on top of `d35ef38`)

BL-036 companion on the All Fridays scenario: the extended-tags figure is the whole account's (every sleeve re-run with the extended tags and blended); same field main accepted for the six other Broad scenarios, no CAGR, drawdown or trade moved

| Scenario | CAGR | Max drawdown |
|---|---|---|
| broad_one_category_three_picks_four_weekly_all_fridays | 17.88% -> 17.88% | -35.50% -> -35.50% |
