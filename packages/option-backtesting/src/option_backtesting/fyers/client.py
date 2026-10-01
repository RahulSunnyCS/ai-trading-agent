"""
Minimal Fyers v3 history client (stdlib HTTP, no SDK).

Throttled to stay under Fyers' published per-minute limit; 429s back off and
retry. Auth failures raise FyersCredentialsError so a run stops at the first
one instead of logging hundreds of identical errors.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from .auth import Credentials, FyersCredentialsError

HISTORY_URL = "https://api-t1.fyers.in/data/history"
# Fyers' gateway rejects Python's default "Python-urllib" User-Agent with a 403.
USER_AGENT = "Mozilla/5.0 (option-backtesting)"
# ~180 requests/minute — under Fyers' 200/min history limit with headroom.
MIN_INTERVAL_S = 0.34


@dataclass(frozen=True)
class Candle:
    epoch: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    oi: float | None


class FyersClient:
    def __init__(self, creds: Credentials, min_interval_s: float = MIN_INTERVAL_S) -> None:
        self._creds = creds
        self._min_interval_s = min_interval_s
        self._last_call = 0.0
        self.calls = 0
        #: Optional hook given (symbol, params, raw response body) for every history
        #: call — collect_day uses it to keep the verbatim responses (raw/fyers/).
        self.on_response: Callable[[str, dict, dict], None] | None = None

    def _throttle(self) -> None:
        wait = self._last_call + self._min_interval_s - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def _get(self, params: dict[str, str | int]) -> dict:
        url = f"{HISTORY_URL}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"{self._creds.app_id}:{self._creds.access_token}",
                "User-Agent": USER_AGENT,
            },
        )
        for attempt in range(5):
            self._throttle()
            self.calls += 1
            try:
                return json.load(urllib.request.urlopen(request, timeout=30))
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt < 4:
                    time.sleep(2**attempt * 5)
                    continue
                try:
                    return json.loads(error.read().decode() or "{}")
                except (ValueError, OSError):
                    return {"s": "error", "message": f"HTTP {error.code}"}
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt < 4:
                    time.sleep(2**attempt)
                    continue
                return {"s": "error", "message": f"network: {error}"}
        return {"s": "error", "message": "rate limited"}

    def minute_candles(self, symbol: str, day: date) -> list[Candle]:
        """1-minute candles for one trading day. Empty list on `no_data`."""
        return self.minute_candles_range(symbol, day, day)

    def minute_candles_range(self, symbol: str, start: date, end: date) -> list[Candle]:
        """1-minute candles for [start, end] inclusive (Fyers allows ~100 calendar
        days per request at this resolution). Empty list on `no_data`."""
        params: dict[str, str | int] = {
            "symbol": symbol,
            "resolution": "1",
            "date_format": 1,
            "range_from": start.isoformat(),
            "range_to": end.isoformat(),
            "cont_flag": 1,
            "oi_flag": 1,
        }
        body = self._get(params)
        if self.on_response is not None:
            self.on_response(symbol, params, body)
        status = body.get("s")
        if status == "no_data":
            return []
        if status != "ok":
            message = str(body.get("message") or body)
            if any(word in message.lower() for word in ("token", "auth", "unauthor", "login")):
                raise FyersCredentialsError(f"Fyers rejected the token: {message}")
            raise RuntimeError(f"{symbol} {start}..{end}: {message}")
        # Index symbols come back with every minute duplicated (observed
        # 2026-09-29: 750 rows, 375 distinct identical pairs) — key by epoch.
        by_epoch = {
            int(row[0]): Candle(
                epoch=int(row[0]),
                open=float(row[1]),
                high=float(row[2]),
                low=float(row[3]),
                close=float(row[4]),
                volume=float(row[5]),
                oi=float(row[6]) if len(row) > 6 and row[6] is not None else None,
            )
            for row in body.get("candles") or []
        }
        return [by_epoch[epoch] for epoch in sorted(by_epoch)]
