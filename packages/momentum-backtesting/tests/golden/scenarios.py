"""The golden scenarios (BL-001): named backtest requests whose results are frozen.

Each starts from what a fresh dashboard run of its dataset sends (`$meta`: the API's own
defaults and default universe) and changes the settings under `with`. A setting left out keeps
its default, so a default that silently flips moves a result here and is caught.
tests/golden/test_coverage.py checks every request field is exercised by at least one of them.
"""

from __future__ import annotations

SCENARIOS: dict[str, dict] = {
    # --- ETF ----------------------------------------------------------------------------------
    "etf_default": {"$meta": "etf"},
    "etf_slots_ranked_weighted_delayed": {
        "$meta": "etf",
        "with": {
            "portfolio": "slots",
            "defensive": "ranked",
            "weights": [3, 2, 2, 1, 1],
            "signal_delay": 1,
            "top_n": 4,
            "exit_rank": 8,
        },
    },
    "etf_filter_taxed_itemised": {
        "$meta": "etf",
        "with": {
            "defensive": "filter",
            "filter_lookback": 26,
            "tax": True,
            "slab_rate": 0.2,
            "cost_model": "itemised",
            "capital": 500000,
            "slippage_bps": 10,
            "cost_pct": 0.2,
        },
    },
    "etf_traded_at_monday_open_tilted": {
        "$meta": "etf",
        "with": {
            "track": "etf",
            "execution": "mon_open",
            "reversal_tilt": 0.5,
            "reversal_screen_pct": 0.3,
            "exclude_high_vol": 0.2,
            "max_position": None,
            "start": "2019-01-01",
            "end": "2024-12-27",
        },
    },
    "etf_fortnightly_make_room_sized": {
        "$meta": "etf",
        "with": {
            "rebalance_every": 2,
            "rebalance_offset": 1,
            "sell_every_week": True,
            "momentum_sizing": True,
            "momentum_sizing_window": 6,
            "momentum_sizing_floor": 0.3,
            "entry": "make_room",
            "score": "blend",
            "cap_band": 0.02,
            "lookbacks": [4, 13, 26],
            "benchmark": "Nifty Midcap 150",
        },
    },
    # --- Nifty 50 stocks ----------------------------------------------------------------------
    "stock_default": {"$meta": "stock"},
    "stock_voladj_monthly": {
        "$meta": "stock",
        "with": {"score": "voladj", "voladj_skip_recent_month": False, "rebalance": "monthly"},
    },
    "stock_blend_slots": {
        "$meta": "stock",
        "with": {"score": "blend", "portfolio": "slots", "top_n": 5, "exit_rank": 10},
    },
    # --- Custom Index -------------------------------------------------------------------------
    "custom_index_default": {"$meta": "custom_index"},
    "custom_index_inner_and_copies": {
        "$meta": "custom_index",
        "with": {"inner_top_n": 3, "inner_exit_rank": 4, "commodity_copies": 2, "debt_copies": 2},
    },
    # --- Broad Momentum -----------------------------------------------------------------------
    "broad_default": {"$meta": "broad"},
    "broad_category_mode_off": {
        "$meta": "broad",
        "with": {
            "broad_category_mode": "off",
            "broad_off_top_n": 8,
            "broad_off_exit_rank": 16,
            "max_category": None,
            "broad_liquidity_filter": False,
            "broad_respect_circuits": False,
        },
    },
    "broad_one_category_three_picks_four_weekly": {
        "$meta": "broad",
        "with": {
            "broad_category_top_n": 1,
            "broad_category_exit_rank": 3,
            "broad_picks_per_category": 3,
            "rebalance_every": 4,
            "signal_delay": 1,
            "max_position": 0.5,
            "max_category": None,
            "cost_model": "itemised",
            "capital": 200000,
            "slippage_bps": 15,
        },
    },
    # BL-056: the same four-weekly config on all four Fridays, money split, reset each April.
    "broad_one_category_three_picks_four_weekly_all_fridays": {
        "$meta": "broad",
        "with": {
            "broad_category_top_n": 1,
            "broad_category_exit_rank": 3,
            "broad_picks_per_category": 3,
            "rebalance_every": 4,
            "split_fridays": True,
            "signal_delay": 1,
            "max_position": 0.5,
            "max_category": None,
            "cost_model": "itemised",
            "capital": 200000,
            "slippage_bps": 15,
        },
    },
    "broad_eight_categories_one_pick": {
        "$meta": "broad",
        "with": {
            "broad_category_top_n": 8,
            "broad_category_exit_rank": 12,
            "broad_picks_per_category": 1,
            "broad_coverage_floor": 0.1,
            "broad_pool_top_n": 80,
            "broad_pool_exit_rank": 120,
            "score": "voladj",
        },
    },
    "broad_gates_loosened_and_tilted": {
        "$meta": "broad",
        "with": {
            "broad_liquidity_filter": True,
            "broad_liq_min_turnover_cr": 5,
            "broad_liq_floor_ratio": 0.5,
            "broad_liq_min_price": 50,
            "broad_liq_circuit": False,
            "broad_liq_max_circuit_days": 5,
            "broad_respect_circuits": False,
            "max_stock_price": 5000,
            "max_category": 0.4,
            "broad_reversal_tilt": 0.5,
            "broad_reversal_screen_pct": 0.3,
            "broad_every_week": False,
            "broad_series_breaks": "legacy",
        },
    },
    "broad_two_categories_three_picks_fortnightly_taxed": {
        "$meta": "broad",
        "with": {
            "broad_category_top_n": 2,
            "broad_category_exit_rank": 6,
            "broad_picks_per_category": 3,
            "rebalance_every": 2,
            "rebalance_offset": 1,
            "broad_liq_circuit_run": 5,
            "tax": True,
            "entry": "make_room",
        },
    },
}
