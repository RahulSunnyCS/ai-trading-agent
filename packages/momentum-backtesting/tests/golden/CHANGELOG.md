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
