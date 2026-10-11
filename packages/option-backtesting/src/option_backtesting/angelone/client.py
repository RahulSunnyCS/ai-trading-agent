"""
Angel One SmartAPI historical client, shaped like fyers.client.FyersClient so
`fyers.daily.collect_day` can drive it unchanged (`minute_candles`, `calls`, `on_response`,
and an optional `bind_contracts` hook).

What differs from Fyers, measured on 2026-10-09 (research/bl078) and handled here:
  * a bar only for a minute that traded -> F&O minutes are carried forward from the first trade
    to 15:29 (flat bar at the last close, volume 0, last OI), and counted in `flags`;
  * volume is in lots -> multiplied back by the contract's lot size;
  * OI is a separate call (`getOIData`), available for NFO only (BFO rejects it, AB1012);
  * the index feed has no bars 15:15-15:28 and zero volume -> NOT filled, counted in `flags`
    (owner's rule: flag the day, do not invent index prices).
"""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone

from ..fyers.client import Candle
from .auth import AngelCredentialsError, Post, Session, post_json, request_headers
from .symbols import Target

IST = timezone(timedelta(hours=5, minutes=30))
CANDLE_PATH = "/rest/secure/angelbroking/historical/v1/getCandleData"
OI_PATH = "/rest/secure/angelbroking/historical/v1/getOIData"
#: SmartAPI's historical limit is about 3 requests a second; one call every 0.4 s stays under it.
MIN_INTERVAL_S = 0.4
OPEN_MINUTE, LAST_MINUTE = (9, 15), (15, 29)
_AUTH_CODES = {"AG8001", "AG8002", "AG8003", "AB8051"}  # invalid / expired token
_RATE_WORDS = ("exceeding access rate", "rate limit", "too many")


def _minute_epochs(day: date) -> list[int]:
    start = datetime(day.year, day.month, day.day, *OPEN_MINUTE, tzinfo=IST)
    end = datetime(day.year, day.month, day.day, *LAST_MINUTE, tzinfo=IST)
    out, cur = [], start
    while cur <= end:
        out.append(int(cur.timestamp()))
        cur += timedelta(minutes=1)
    return out


class AngelClient:
    def __init__(
        self,
        session: Session,
        min_interval_s: float = MIN_INTERVAL_S,
        post: Post = post_json,
        master_loader: Callable[[], list[dict]] | None = None,
    ) -> None:
        self._session = session
        self._min_interval_s = min_interval_s
        self._post = post
        self._master_loader = master_loader
        self._last_call = 0.0
        self.calls = 0
        self.on_response: Callable[[str, dict, dict], None] | None = None
        self.targets: dict[str, Target] = {}
        #: per underlying: what was missing or synthesised on this day (stored on the run)
        self.flags: dict[str, dict] = defaultdict(
            lambda: {
                "index_missing_minutes": 0,
                "minutes_filled": 0,
                "thin_contracts": 0,
                "oi_unavailable": False,
                "oi_failed": 0,
                "unmapped": 0,
            }
        )

    # -- wiring ---------------------------------------------------------------------------
    def bind_contracts(self, contracts, specs) -> None:
        """Called by collect_day once the day's contracts are known."""
        from ..fyers.daily import VIX_NAME, VIX_SYMBOL
        from .symbols import build_targets, download_master

        index_symbols = {s.index_symbol: s.name for s in specs} | {VIX_SYMBOL: VIX_NAME}
        master = (self._master_loader or download_master)()
        self.targets = build_targets(master, contracts, index_symbols)

    # -- HTTP -----------------------------------------------------------------------------
    def _call(self, path: str, body: dict) -> dict:
        headers = request_headers(self._session.api_key, self._session.public_ip, self._session.jwt)
        for attempt in range(5):
            wait = self._last_call + self._min_interval_s - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()
            self.calls += 1
            status, payload = self._post(path, body, headers)
            message = str(payload.get("message") or "")
            limited = status == 429 or any(w in message.lower() for w in _RATE_WORDS)
            if limited and attempt < 4:
                time.sleep(2**attempt)
                continue
            if status == 0 and attempt < 4:  # network error
                time.sleep(2**attempt)
                continue
            return payload
        raise AssertionError("unreachable: the last attempt always returns")  # pragma: no cover

    @staticmethod
    def _check(payload: dict, what: str) -> None:
        if payload.get("status"):
            return
        message = str(payload.get("message") or payload)
        code = str(payload.get("errorcode") or "")
        if code in _AUTH_CODES or "invalid token" in message.lower():
            raise AngelCredentialsError(f"Angel One rejected the session: {code} {message}"[:200])
        raise RuntimeError(f"{what}: {code} {message}"[:200])

    # -- data -----------------------------------------------------------------------------
    def minute_candles(self, symbol: str, day: date) -> list[Candle]:
        """1-minute candles for one trading day, in the Fyers `Candle` shape. [] when the
        contract has no Angel One match or no trades."""
        target = self.targets.get(symbol)
        if target is None:
            self.flags[self._underlying_of(symbol)]["unmapped"] += 1
            return []
        body = {
            "exchange": target.exchange,
            "symboltoken": target.token,
            "interval": "ONE_MINUTE",
            "fromdate": f"{day.isoformat()} 09:15",
            "todate": f"{day.isoformat()} 15:30",
        }
        payload = self._call(CANDLE_PATH, body)
        if self.on_response is not None:
            self.on_response(symbol, body, payload)
        self._check(payload, f"{symbol} {day}")
        rows = payload.get("data") or []
        bars: dict[int, list[float]] = {}
        for r in rows:
            epoch = int(datetime.fromisoformat(str(r[0])).timestamp())
            bars[epoch] = [float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
        if not bars:
            return []
        flags = self.flags[target.underlying]
        oi = self._oi(symbol, target, body, flags)
        grid = _minute_epochs(day)
        if target.kind == "index":
            flags["index_missing_minutes"] = max(
                flags["index_missing_minutes"], sum(1 for e in grid if e not in bars)
            )
            return [Candle(e, *bars[e][:4], bars[e][4], None) for e in sorted(bars)]
        out: list[Candle] = []
        last_close: float | None = None
        last_oi: float | None = None
        filled = 0
        for epoch in grid:
            if epoch in bars:
                o, h, lo, c, v = bars[epoch]
                last_close = c
                out.append(Candle(epoch, o, h, lo, c, v * target.lot_size, oi.get(epoch, last_oi)))
            elif last_close is not None:
                out.append(
                    Candle(
                        epoch,
                        last_close,
                        last_close,
                        last_close,
                        last_close,
                        0.0,
                        oi.get(epoch, last_oi),
                    )
                )
                filled += 1
            if epoch in oi:
                last_oi = oi[epoch]
        if filled:
            flags["minutes_filled"] += filled
            flags["thin_contracts"] += 1
        return out

    def _oi(self, symbol: str, target: Target, body: dict, flags: dict) -> dict[int, float]:
        if target.kind == "index":
            return {}
        if target.exchange != "NFO":  # BFO: getOIData answers AB1012 for every contract
            flags["oi_unavailable"] = True
            return {}
        payload = self._call(OI_PATH, body)
        if self.on_response is not None:
            self.on_response(symbol + "#oi", body, payload)
        if not payload.get("status"):
            if str(payload.get("errorcode") or "") in _AUTH_CODES:
                self._check(payload, f"{symbol} oi")
            flags["oi_failed"] += 1
            return {}
        out: dict[int, float] = {}
        for r in payload.get("data") or []:
            t, v = (r["time"], r["oi"]) if isinstance(r, dict) else (r[0], r[1])
            out[int(datetime.fromisoformat(str(t)).timestamp())] = float(v)
        return out

    def _underlying_of(self, symbol: str) -> str:
        from ..fyers.daily import UNDERLYINGS, VIX_NAME, VIX_SYMBOL

        index_names = {s.index_symbol: s.name for s in UNDERLYINGS.values()} | {
            VIX_SYMBOL: VIX_NAME
        }
        if symbol in index_names:
            return index_names[symbol]
        name = symbol.split(":", 1)[-1]
        return name.split("2", 1)[0] or "UNKNOWN"
