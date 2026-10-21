"""
Minimal Fyers v3 history client (stdlib HTTP, no SDK).

Throttled to stay under Fyers' published per-minute limit; 429s back off and
retry. Auth failures raise FyersCredentialsError so a run stops at the first
one instead of logging hundreds of identical errors.
"""

from __future__ import annotations

import collections
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from .auth import Credentials, FyersCredentialsError

DATA_API = "https://api-t1.fyers.in/data"
HISTORY_URL = f"{DATA_API}/history"
EXPIRED_EXPIRIES_URL = f"{DATA_API}/history/fno/expired/expiry-dates"
EXPIRED_CONTRACTS_URL = f"{DATA_API}/history/fno/expired/underlying-symbols"
EXPIRED_HISTORY_URL = f"{DATA_API}/history/fno/expired/historical-data"
# Fyers' gateway rejects Python's default "Python-urllib" User-Agent with a 403.
USER_AGENT = "Mozilla/5.0 (option-backtesting)"
# ~180 requests/minute — under Fyers' 200/min history limit with headroom.
MIN_INTERVAL_S = 0.34


class RateLimitedError(RuntimeError):
    """Fyers answered 429 more often than the caller allows. Fyers blocks an account for the
    rest of the day after repeated per-minute breaches, so a bulk job stops rather than retry."""


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
    def __init__(
        self,
        creds: Credentials,
        min_interval_s: float = MIN_INTERVAL_S,
        *,
        per_minute: int | None = None,
        max_rate_limit_hits: int | None = None,
    ) -> None:
        self._creds = creds
        self._min_interval_s = min_interval_s
        self._last_call = 0.0
        #: Opt-in rolling cap (requests in any 60 s) and the number of 429s tolerated before
        #: `RateLimitedError`; both None for the daily collector's long-standing behaviour.
        self._per_minute = per_minute
        self._max_rate_limit_hits = max_rate_limit_hits
        self._recent: collections.deque[float] = collections.deque()
        self.rate_limit_hits = 0
        self.calls = 0
        #: Optional hook given (symbol, params, raw response body) for every history
        #: call — collect_day uses it to keep the verbatim responses (raw/fyers/).
        self.on_response: Callable[[str, dict, dict], None] | None = None

    def _throttle(self) -> None:
        wait = self._last_call + self._min_interval_s - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        if self._per_minute is not None:
            now = time.monotonic()
            while self._recent and now - self._recent[0] >= 60:
                self._recent.popleft()
            if len(self._recent) >= self._per_minute:
                time.sleep(max(0.0, 60 - (now - self._recent[0])))
                self._recent.popleft()
            self._recent.append(time.monotonic())
        self._last_call = time.monotonic()

    def _get(self, params: dict[str, str | int], *, endpoint: str = HISTORY_URL) -> dict:
        url = f"{endpoint}?{urllib.parse.urlencode(params)}"
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
                if error.code == 429 and self._max_rate_limit_hits is not None:
                    self.rate_limit_hits += 1
                    if self.rate_limit_hits >= self._max_rate_limit_hits:
                        raise RateLimitedError(
                            f"Fyers rate-limited {self.rate_limit_hits} times; stopping to avoid "
                            "the day-long block"
                        ) from None
                    time.sleep(65)  # let the per-minute window clear, then retry once
                    continue
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

    @staticmethod
    def _raise_for_error(body: dict, label: str) -> None:
        if body.get("s") == "ok":
            return
        message = str(body.get("message") or body)
        if any(word in message.lower() for word in ("token", "auth", "unauthor", "login")):
            raise FyersCredentialsError(f"Fyers rejected the token: {message}")
        raise RuntimeError(f"{label}: {message}")

    def expired_expiries(self, symbol: str, start: date, end: date) -> list[date]:
        """Expired option expiry dates in the requested window."""
        body = self._get(
            {
                "symbol": symbol,
                "range_from": start.isoformat(),
                "range_to": end.isoformat(),
                "date_format": 1,
            },
            endpoint=EXPIRED_EXPIRIES_URL,
        )
        self._raise_for_error(body, f"{symbol} expiries {start}..{end}")
        values = body.get("data", {}).get("expiry_dates", {}).get("options", [])
        return [date.fromisoformat(value) for value in values]

    def expired_contracts(self, symbol: str, expiry: date) -> list[str]:
        """All option symbols Fyers exposes for one expired expiry."""
        body = self._get(
            {"symbol": symbol, "expiry_date": expiry.isoformat()},
            endpoint=EXPIRED_CONTRACTS_URL,
        )
        self._raise_for_error(body, f"{symbol} contracts for {expiry}")
        return list(body.get("data", {}).get("contracts", {}).get("options", []))

    def expired_history_response(self, symbol: str, start: date, end: date) -> tuple[dict, dict]:
        """Raw expired-F&O response plus its request params, for durable caching."""
        params: dict[str, str | int] = {
            "symbol": symbol,
            "resolution": "1",
            "date_format": 1,
            "range_from": start.isoformat(),
            "range_to": end.isoformat(),
            "include_oi": 1,
            "include_greeks": 0,
        }
        body = self._get(params, endpoint=EXPIRED_HISTORY_URL)
        if self.on_response is not None:
            self.on_response(symbol, params, body)
        if body.get("s") not in ("ok", "no_data"):
            self._raise_for_error(body, f"{symbol} {start}..{end}")
        return body, params

    @staticmethod
    def candles_from_response(body: dict) -> list[Candle]:
        """Normalise either live-history or expired-history candle rows.

        The expired-F&O response names its `columns` (optional ones such as open_interest and
        the greeks follow the six core fields), so a body that carries them is read by name;
        the live History API has none and is read by position.
        """
        names = body.get("columns")
        if names:
            index = {name: i for i, name in enumerate(names)}
            missing = {"timestamp", "open", "high", "low", "close", "volume"} - set(index)
            if missing:
                raise RuntimeError(f"candle columns lack {sorted(missing)}: {names}")
            oi_at = index.get("open_interest")
        else:
            index = {"timestamp": 0, "open": 1, "high": 2, "low": 3, "close": 4, "volume": 5}
            oi_at = 6

        def row_to_candle(row: list) -> Candle:
            oi = row[oi_at] if oi_at is not None and len(row) > oi_at else None
            return Candle(
                epoch=int(row[index["timestamp"]]),
                open=float(row[index["open"]]),
                high=float(row[index["high"]]),
                low=float(row[index["low"]]),
                close=float(row[index["close"]]),
                volume=float(row[index["volume"]]),
                oi=float(oi) if oi is not None else None,
            )

        # Index symbols come back with every minute duplicated (observed 2026-09-29: 750
        # rows, 375 distinct identical pairs) - key by epoch.
        by_epoch = {c.epoch: c for c in map(row_to_candle, body.get("candles") or [])}
        return [by_epoch[epoch] for epoch in sorted(by_epoch)]

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
        return self.candles_from_response(body)
