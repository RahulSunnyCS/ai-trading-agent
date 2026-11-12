"""MCX commodity option charges per closed trade (BL-218, BL-219), the MCX counterpart of the
BL-096 NSE/BSE model in research/bl202/run_grid.py. Lives here, not in research/, because the
forward paper test (`mcx_forward.py`) and the BL-218 sweep both use it.

Rates as published on https://zerodha.com/charges (Commodity › options), read 2026-11-11:
brokerage ₹20 an executed order; CTT 0.05% on the sell side; MCX transaction charge 0.0418%
(applied to premium turnover, as the NSE options charge is); SEBI ₹10 a crore; stamp duty
0.003% on the buy side; GST 18% on brokerage + SEBI + transaction charges. One schedule for the
whole window: the rates were not looked up back to 2024, so earlier days are charged at
today's rates (stated in the item's Phase 0).
"""

from __future__ import annotations

from typing import Any

BROKERAGE_PER_ORDER = 20.0
ORDERS_PER_TRADE = 2  # entry + exit
CTT_SELL = 0.0005
MCX_TRANSACTION = 0.000418
SEBI = 0.000001
STAMP_BUY = 0.00003
GST = 0.18


def trade_charges(trade: Any) -> float:
    """Rupees of charges on one closed trade (0 for one still open). `trade` has position
    ("buy"/"sell"), entry_price, exit_price and qty (premium points × qty = rupees)."""
    if trade.exit_price is None:
        return 0.0
    sell = (trade.entry_price if trade.position == "sell" else trade.exit_price) * trade.qty
    buy = (trade.exit_price if trade.position == "sell" else trade.entry_price) * trade.qty
    turnover = sell + buy
    brokerage = ORDERS_PER_TRADE * BROKERAGE_PER_ORDER
    transaction = MCX_TRANSACTION * turnover
    sebi = SEBI * turnover
    return (
        brokerage
        + transaction
        + sebi
        + CTT_SELL * sell
        + STAMP_BUY * buy
        + GST * (brokerage + transaction + sebi)
    )
