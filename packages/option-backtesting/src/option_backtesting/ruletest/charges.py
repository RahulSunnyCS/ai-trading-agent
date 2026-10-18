"""Brokerage and statutory charges on an option day's turnover: the BL-063 model of
`research/options/common/charges.md`, applied to the totals a simulation records.

Brokerage is ₹13 an order (every leg's entry and exit is one order each); STT is on the sell side's
premium (0.10%, 0.15% from 2026-04-01); the exchange fee is on both sides (NSE for NIFTY, BSE for
SENSEX); SEBI turnover and, on NSE only, the investor protection fund are on both sides; stamp duty
is on the buy side; GST is 18% of brokerage + exchange + SEBI + IPFT. Slippage and spread are NOT in
this model: the tester reports them as a separate sensitivity line.

One simplification is inherited from BL-063: STT is 0.10% for every day before 2026-04-01 (it was
lower before 2024-10-01), which slightly overstates 2022-24 charges.
"""

from __future__ import annotations

from dataclasses import dataclass

BROKERAGE_PER_ORDER = 13.0
STT_SELL = [("2000-01-01", 0.0010), ("2026-04-01", 0.0015)]
EXCHANGE = {"NIFTY": 0.0003503, "SENSEX": 0.000325}
SEBI = 0.000001
IPFT_NSE = 0.000005
STAMP_BUY = 0.00003
GST = 0.18


def stt_rate(day: str) -> float:
    return [rate for start, rate in STT_SELL if day >= start][-1]


@dataclass(frozen=True)
class Charges:
    brokerage: float
    stt: float
    exchange: float
    sebi_ipft: float
    stamp: float
    gst: float

    @property
    def total(self) -> float:
        return self.brokerage + self.stt + self.exchange + self.sebi_ipft + self.stamp + self.gst


def day_charges(
    underlying: str, day: str, orders: int, buy_value: float, sell_value: float
) -> Charges:
    """Charges for one strategy-day: `buy_value` / `sell_value` are the premium turnover in rupees
    (price x quantity) bought and sold, `orders` the entry and exit orders sent."""
    both = buy_value + sell_value
    brokerage = BROKERAGE_PER_ORDER * orders
    exchange = EXCHANGE[underlying] * both
    ipft = IPFT_NSE * both if underlying != "SENSEX" else 0.0
    return Charges(
        brokerage=brokerage,
        stt=stt_rate(day) * sell_value,
        exchange=exchange,
        sebi_ipft=SEBI * both + ipft,
        stamp=STAMP_BUY * buy_value,
        gst=GST * (brokerage + exchange + SEBI * both + ipft),
    )


def trade_values(trades) -> tuple[int, float, float]:
    """(orders, buy_value, sell_value) of a finished `DayResult.trades` list."""
    orders, buy, sell = 0, 0.0, 0.0
    for t in trades:
        if t.exit_price is None:
            continue
        orders += 2
        entry, exit_ = t.entry_price * t.qty, t.exit_price * t.qty
        if t.position == "buy":
            buy, sell = buy + entry, sell + exit_
        else:
            sell, buy = sell + entry, buy + exit_
    return orders, buy, sell
