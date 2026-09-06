"""
`FixtureCache` — loads `fixture_15_sessions.json` straight into the same
shape `Cache` exposes (`get_opt_bars`/`get_cash_bars`/`get_greeks`), so
`engine.loop.run_backtest` and `features.evaluator.evaluate_features` accept
either interchangeably (structural typing — no shared base class needed,
matching the Provider Protocol pattern already used in
`data/providers/base.py`). Used only by the golden-fixture parity test; no
ingest/DuckDB round-trip needed since the fixture is already the right shape.

The fixture has no `cash`/`greeks` series — every committed golden-fixture
strategy (A/B/C/D) only ever declares `leg_sum` features over `ATM`/`OTM1`
legs, so `get_cash_bars`/`get_greeks` are never actually called by them;
they raise rather than silently returning `[]`, so a strategy that DID need
them would fail loudly instead of quietly producing wrong (empty) data.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

from option_backtesting.bartime import parse_bar_times
from option_backtesting.data.providers.base import Bar, SessionFlag

FIXTURE_PATH = Path(__file__).parent / "fixture_15_sessions.json"

_SERIES_KEY = {
    ("ATM", "CE"): "atm_ce",
    ("ATM", "PE"): "atm_pe",
    ("OTM1", "CE"): "otm1_ce",
    ("OTM1", "PE"): "otm1_pe",
}


class FixtureCache:
    def __init__(self, fixture_path: Path = FIXTURE_PATH) -> None:
        data = json.loads(fixture_path.read_text())
        self.meta = data["meta"]
        self._by_date = {date.fromisoformat(s["date"]): s for s in data["sessions"]}
        self.ordered_dates = sorted(self._by_date)
        self.bar_times = parse_bar_times(self._by_date[self.ordered_dates[0]]["times"])

    def dte(self, d: date) -> int:
        return self._by_date[d]["dte"]

    def get_opt_bars(
        self,
        underlying: str,
        timeframe: str,
        strike_rule: str,
        leg: str,
        start: date,
        end: date,
    ) -> list[Bar]:
        key = _SERIES_KEY.get((strike_rule, leg))
        if key is None:
            raise ValueError(f"Fixture has no series for {strike_rule}.{leg}")
        bars: list[Bar] = []
        for d in self.ordered_dates:
            if not (start <= d <= end):
                continue
            series = self._by_date[d][key]
            times = parse_bar_times(self._by_date[d]["times"])
            closes = series["closes"]
            for i, (t, c) in enumerate(zip(times, closes, strict=True)):
                open_ = series["open"] if i == 0 else closes[i - 1]
                bars.append(
                    Bar(
                        ts=datetime.combine(d, t),
                        open=open_,
                        high=max(open_, c),
                        low=min(open_, c),
                        close=c,
                        session=SessionFlag.REGULAR,
                    )
                )
        return bars

    def get_cash_bars(self, underlying: str, timeframe: str, start: date, end: date) -> list[Bar]:
        raise NotImplementedError("fixture_15_sessions.json has no cash series")

    def get_greeks(
        self,
        underlying: str,
        timeframe: str,
        strike_rule: str,
        leg: str,
        start: date,
        end: date,
    ) -> list:
        raise NotImplementedError("fixture_15_sessions.json has no greeks series")
