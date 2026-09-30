from datetime import date

from option_backtesting.fyers.client import Candle
from option_backtesting.fyers.daily import collect_chain, options_table, select_expiries
from option_backtesting.fyers.symbols import Contract, parse_master

TUE = date(2026, 9, 29)


def test_weekly_takes_current_and_next():
    listed = [date(2026, 9, 22), TUE, date(2026, 10, 6), date(2026, 10, 13)]
    assert select_expiries(listed, TUE, "weekly") == [TUE, date(2026, 10, 6)]


def test_monthly_takes_current_only_except_on_its_expiry_day():
    listed = [TUE, date(2026, 10, 27), date(2026, 11, 23)]
    assert select_expiries(listed, date(2026, 9, 28), "monthly") == [TUE]
    assert select_expiries(listed, TUE, "monthly") == [TUE, date(2026, 10, 27)]


def _candles(high: float) -> list[Candle]:
    return [Candle(0, high, high, high, high, 1.0, None)]


def _premium(strike: float, right: str, spot: float = 1000.0) -> float:
    """Toy chain: OTM premium decays 10/strike-step away from spot, ITM = intrinsic + 10."""
    distance = strike - spot if right == "CE" else spot - strike
    return max(0.0, 10.0 - distance / 10.0) if distance > 0 else -distance + 10.0


def test_chain_covers_range_and_walks_until_otm_is_cheap():
    strikes = [900.0 + 10 * i for i in range(21)]  # 900..1100
    fetched: list[tuple[float, str]] = []

    def fetch(strike: float, right: str) -> list[Candle]:
        fetched.append((strike, right))
        return _candles(_premium(strike, right))

    result = collect_chain(strikes, 995.0, 1005.0, fetch, premium_floor=5.0, max_extra=50)
    assert result.core == (990.0, 1010.0)
    # CE at 1060 has premium 4 (<5), 1070 has 3 -> two cheap in a row, stop at 1070.
    assert result.top_strike == 1070.0
    assert result.bottom_strike == 930.0
    assert {s for s, _ in fetched} == {s for s in strikes if 930.0 <= s <= 1070.0}
    assert all((s, r) in fetched for s in (990.0, 1000.0, 1010.0) for r in ("CE", "PE"))


def test_single_untraded_strike_does_not_end_walk():
    strikes = [1000.0, 1010.0, 1020.0, 1030.0, 1040.0]

    def fetch(strike: float, right: str) -> list[Candle]:
        return [] if strike == 1010.0 else _candles(50.0)

    result = collect_chain(strikes, 1000.0, 1000.0, fetch, premium_floor=5.0)
    assert result.top_strike == 1040.0 and not result.hit_cap_up


def test_walk_respects_cap():
    strikes = [float(s) for s in range(0, 1000, 10)]
    result = collect_chain(strikes, 500.0, 500.0, lambda s, r: _candles(100.0), max_extra=3)
    assert result.extra_up == 3 and result.hit_cap_up
    assert result.extra_down == 3 and result.hit_cap_down
    assert (result.bottom_strike, result.top_strike) == (470.0, 530.0)


def test_parse_master_reads_options_and_futures_only_for_requested_underlyings():
    text = "\n".join(
        [
            "1,NIFTY 06 Oct 26 22700 CE,14,65,0.05,,0915-1540|1815-1915:,2026-09-28,1791281400,"
            "NSE:NIFTY26O0622700CE,10,11,1,NIFTY,26000,22700.0,CE,1,None,0,0.0",
            "2,BANKNIFTY 29 Sep 26 FUT,11,30,0.2,,0915-1540|1815-1915:,2026-09-28,1790676600,"
            "NSE:BANKNIFTY26SEPFUT,10,11,2,BANKNIFTY,26009,-1.0,XX,1,None,0,0.0",
            "3,RELIANCE 29 Sep 26 FUT,11,500,0.1,,0915-1530:,2026-09-28,1790676600,"
            "NSE:RELIANCE26SEPFUT,10,11,3,RELIANCE,1,-1.0,XX,1,None,0,0.0",
        ]
    )
    contracts = parse_master(text, {"NIFTY", "BANKNIFTY"})
    assert contracts == [
        Contract("NSE:NIFTY26O0622700CE", "NIFTY", date(2026, 10, 6), 22700.0, "CE", 65),
        Contract("NSE:BANKNIFTY26SEPFUT", "BANKNIFTY", TUE, None, "FUT", 30),
    ]


def test_options_table_flattens_contract_columns():
    contract = Contract("NSE:X", "NIFTY", TUE, 22700.0, "PE", 65)
    table = options_table([(contract, 42, [Candle(1790653500, 1, 2, 0.5, 1.5, 10, 99)])])
    row = table.to_pylist()[0]
    assert (row["instrument_id"], row["vendor_symbol"], row["strike"], row["option_type"]) == (
        42,
        "NSE:X",
        22700.0,
        "PE",
    )
    assert (row["oi"], row["expiry"]) == (99, TUE)
