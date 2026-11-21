"""Angel One as the fallback source of the nightly MCX option collection (BL-148, Phase 4).

`fyers.mcx_daily.run` asks its client for `minute_candles_range(symbol, start, end)`; this
answers it from SmartAPI when Fyers cannot be used (no token, or one refused).  Identity stays
Fyers': a contract is matched to Angel One's by root, expiry, strike and side, and stored under
its Fyers symbol, like the NSE fallback.

Measured on 2026-11-11 (a live CRUDEOIL option, same minutes on both sources):

* `getCandleData` takes exchange `MCX` and returns the same minutes as Fyers' history (first
  trade to the close, flat bars after), at most about 8,000 rows a request, so a request spans
  at most `CHUNK_DAYS` days;
* `getOIData` also takes MCX (unlike BFO) and answers in units: Fyers' figure times the lot size
  (349,200 against 3,492 lots), so it is divided by the master's lot size;
* volume is in the same units as Fyers';
* open and low differ slightly between the two feeds and volume by a few percent: Angel's bars are
  an approximation of Fyers', which the next Fyers run overwrites for any contract still listed.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from ..fyers.client import Candle
from ..fyers.symbols import Contract
from .client import _AUTH_CODES, CANDLE_PATH, OI_PATH, AngelClient
from .symbols import _expiry

#: 895 bars a day at most; SmartAPI's cap of ~8,000 rows a request leaves room for 8 days
CHUNK_DAYS = 7
EXCHANGE = "MCX"


class AngelMcxClient(AngelClient):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        #: Fyers symbol -> (Angel token, lot size)
        self.mcx: dict[str, tuple[str, int]] = {}

    def bind_mcx(self, contracts: list[Contract]) -> int:
        """Match the Fyers contracts to Angel One's MCX option rows; returns how many matched."""
        from .symbols import download_master

        master = (self._master_loader or download_master)()
        index: dict[tuple, tuple[str, int]] = {}
        for row in master:
            symbol = row.get("symbol", "")
            if row.get("exch_seg") != EXCHANGE or row.get("instrumenttype") != "OPTFUT":
                continue
            side = symbol[-2:]
            expiry = _expiry(row)
            if side not in ("CE", "PE") or expiry is None:
                continue
            try:
                strike = round(float(row["strike"]) / 100, 2)  # SmartAPI scales strikes by 100
                lot = int(float(row.get("lotsize") or 1))
            except (KeyError, ValueError):
                continue
            index[(row["name"], expiry, strike, side)] = (row["token"], max(lot, 1))
        for c in contracts:
            hit = index.get((c.underlying, c.expiry, round(c.strike or 0.0, 2), c.option_type))
            if hit is None:
                self.flags[c.underlying]["unmapped"] += 1
            else:
                self.mcx[c.symbol] = hit
        return len(self.mcx)

    def minute_candles_range(self, symbol: str, start: date, end: date) -> list[Candle]:
        """1-minute candles for [start, end] in the Fyers `Candle` shape, OI in lots; [] when
        the contract has no Angel One match or no trades."""
        hit = self.mcx.get(symbol)
        if hit is None:
            return []
        token, lot = hit
        out: dict[int, Candle] = {}
        day = start
        while day <= end:
            last = min(day + timedelta(days=CHUNK_DAYS - 1), end)
            body = {
                "exchange": EXCHANGE,
                "symboltoken": token,
                "interval": "ONE_MINUTE",
                "fromdate": f"{day.isoformat()} 09:00",
                "todate": f"{last.isoformat()} 23:59",
            }
            payload = self._call(CANDLE_PATH, body)
            if self.on_response is not None:
                self.on_response(symbol, body, payload)
            self._check(payload, f"{symbol} {day}..{last}")
            rows = payload.get("data") or []
            oi = self._oi_lots(symbol, body, lot) if rows else {}
            for r in rows:
                epoch = int(datetime.fromisoformat(str(r[0])).timestamp())
                out[epoch] = Candle(
                    epoch, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]),
                    oi.get(epoch),
                )  # fmt: skip
            day = last + timedelta(days=1)
        return [out[e] for e in sorted(out)]

    def _oi_lots(self, symbol: str, body: dict, lot: int) -> dict[int, float]:
        payload = self._call(OI_PATH, body)
        if self.on_response is not None:
            self.on_response(symbol + "#oi", body, payload)
        if not payload.get("status"):
            if str(payload.get("errorcode") or "") in _AUTH_CODES:
                self._check(payload, f"{symbol} oi")
            self.flags[self._underlying_of(symbol)]["oi_failed"] += 1
            return {}
        out: dict[int, float] = {}
        for r in payload.get("data") or []:
            t, v = (r["time"], r["oi"]) if isinstance(r, dict) else (r[0], r[1])
            out[int(datetime.fromisoformat(str(t)).timestamp())] = float(v) / lot
        return out
