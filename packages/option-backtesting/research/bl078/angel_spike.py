"""BL-078 Phase 1 spike. Read-only: one SmartAPI login, a handful of candle calls, a diff
against the Fyers lake. Prints counts and equality only; never a token, PIN or secret."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[4]
LAKE = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData")) / "lake" / "bars_1m"
DAY = date.fromisoformat(sys.argv[1] if len(sys.argv) > 1 else "2026-10-09")
SCRATCH = Path(__file__).parent / "out"  # git-ignored scratch (raw responses, scrip master)
SCRATCH.mkdir(exist_ok=True)
BASE = "https://apiconnect.angelone.in"
MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip().removeprefix("export ").strip()] = value
    return out


ENV = load_env(ROOT / ".env")
SECRETS = [v for k, v in ENV.items() if v and any(t in k for t in ("PIN", "SECRET", "TOTP", "KEY", "PASSWORD", "MPIN"))]


def scrub(text: object) -> str:
    s = str(text)
    for secret in SECRETS:
        if len(secret) >= 4:
            s = s.replace(secret, "<redacted>")
    return s[:200]


def totp(secret: str) -> str:
    key = base64.b32decode(secret.replace(" ", "").replace("-", "").upper() + "=" * (-len(secret) % 8))
    counter = struct.pack(">Q", int(time.time()) // 30)
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 15
    return f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def post(path: str, body: dict, headers: dict[str, str]) -> tuple[int, dict]:
    request = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        raw, status = error.read(), error.code
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {"status": False, "message": f"non-JSON HTTP {status}: {raw[:80]!r}"}


def main() -> int:
    api_key = ENV["ANGELONE_API_KEY"]
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": ENV.get("PUBLIC_IP", "0.0.0.0"),
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": api_key,
    }
    # --- one login attempt ------------------------------------------------------------------
    wait = 30 - int(time.time()) % 30
    if wait < 4:  # do not use a code about to expire
        time.sleep(wait + 0.5)
    status, body = post(
        "/rest/auth/angelbroking/user/v1/loginByPassword",
        {
            "clientcode": ENV["ANGELONE_CLIENT_CODE"],
            "password": ENV["ANGELONE_MPIN"],
            "totp": totp(ENV["ANGELONE_TOTP_SECRET"]),
        },
        headers,
    )
    data = body.get("data") or {}
    login = {
        "http": status,
        "ok": bool(body.get("status")),
        "errorcode": body.get("errorcode"),
        "message": scrub(body.get("message")),
        "got_jwt": bool(data.get("jwtToken")),
    }
    print("LOGIN", json.dumps(login))
    if not login["got_jwt"]:
        return 2
    auth = {**headers, "Authorization": f"Bearer {data['jwtToken']}"}

    # --- tokens from the public scrip master ------------------------------------------------
    master_path = SCRATCH / "scrip_master.json"
    if not master_path.exists():
        with urllib.request.urlopen(MASTER_URL, timeout=120) as response:
            master_path.write_bytes(response.read())
    master = json.loads(master_path.read_text())

    def expiry_of(row: dict) -> date | None:
        try:
            return datetime.strptime(row["expiry"], "%d%b%Y").date()
        except (KeyError, ValueError):
            return None

    index_row = next(r for r in master if r["exch_seg"] == "NSE" and r["symbol"] == "Nifty 50" and r["instrumenttype"] == "AMXIDX")
    vix_row = next(r for r in master if r["exch_seg"] == "NSE" and r["symbol"] == "India VIX" and r["instrumenttype"] == "AMXIDX")
    futs = sorted(
        (r for r in master if r["exch_seg"] == "NFO" and r["instrumenttype"] == "FUTIDX"
         and r["name"] == "NIFTY" and (expiry_of(r) or date.min) >= DAY),
        key=expiry_of,
    )
    opts = [r for r in master if r["exch_seg"] == "NFO" and r["instrumenttype"] == "OPTIDX"
            and r["name"] == "NIFTY" and (expiry_of(r) or date.min) >= DAY]
    near_expiry = min(expiry_of(r) for r in opts)

    # --- Fyers lake for the same day --------------------------------------------------------
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")

    def lake(sub: str) -> str:
        return str(LAKE / sub / f"date={DAY.isoformat()}" / "data.parquet")

    def minutes(sql: str) -> dict[str, tuple]:
        """minute 'HH:MM' -> (open, high, low, close, volume, oi); first row wins."""
        out_: dict[str, tuple] = {}
        for row in con.execute(sql).fetchall():
            out_.setdefault(row[0], tuple(row[1:]))
        return out_

    cols = "open, high, low, close, volume, oi"
    idx = minutes(f"SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lake('asset=index/symbol=NIFTY')}') ORDER BY ts")
    spot = float(idx["11:00"][3])
    atm = round(spot / 50) * 50
    lake_opt = {
        kind: minutes(
            f"""SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lake('asset=option/underlying=NIFTY')}')
                WHERE strike = {atm} AND expiry = DATE '{near_expiry.isoformat()}' AND option_type = '{kind}'
                ORDER BY ts"""
        )
        for kind in ("CE", "PE")
    }

    out: dict[str, object] = {"day": DAY.isoformat(), "spot_11:00": spot, "atm": atm, "expiry": near_expiry.isoformat()}

    def candles(exchange: str, token: str, label: str) -> list[list]:
        time.sleep(0.5)
        status, body = post(
            "/rest/secure/angelbroking/historical/v1/getCandleData",
            {
                "exchange": exchange,
                "symboltoken": token,
                "interval": "ONE_MINUTE",
                "fromdate": f"{DAY.isoformat()} 09:15",
                "todate": f"{DAY.isoformat()} 15:30",
            },
            auth,
        )
        rows = body.get("data") or []
        out[f"{label}_call"] = {"http": status, "ok": body.get("status"), "rows": len(rows),
                                "errorcode": body.get("errorcode"), "message": scrub(body.get("message"))}
        return rows

    def compare(label: str, rows: list[list], ref: dict[str, tuple]) -> None:
        if not rows:
            return
        (SCRATCH / f"raw_{label}.json").write_text(json.dumps(rows))
        ang = {r[0][11:16]: r[1:6] for r in rows}  # "2026-10-09T09:15:00+05:30" -> "09:15"

        def mod(m: str) -> int:
            return int(m[:2]) * 60 + int(m[3:])

        def label_of(n: int) -> str:
            return f"{n // 60:02d}:{n % 60:02d}"

        result: dict[str, object] = {
            "angel_minutes": len(ang), "fyers_minutes": len(ref),
            "angel_first_last": [min(ang), max(ang)], "fyers_first_last": [min(ref), max(ref)],
        }
        # Try aligning angel minute m to fyers minute m+shift, to expose a timestamp convention gap.
        for shift in (-1, 0, 1):
            pairs = [(m, label_of(mod(m) + shift)) for m in ang]
            pairs = [(a, f) for a, f in pairs if f in ref]
            eq = sum(1 for a, f in pairs if all(abs(float(ang[a][i]) - float(ref[f][i])) < 0.011 for i in range(4)))
            veq = sum(1 for a, f in pairs if ref[f][4] is not None and abs(float(ang[a][4]) - float(ref[f][4])) < 0.5)
            result[f"shift{shift:+d}"] = {"pairs": len(pairs), "ohlc_equal": eq, "volume_equal": veq}
        # a few raw samples, as numbers only
        sample = [m for m in ("09:15", "10:00", "13:00") if m in ang and m in ref]
        result["samples"] = {m: {"angel": ang[m], "fyers": ref[m][:5]} for m in sample}
        out[f"{label}_diff"] = result

    compare("index", candles("NSE", index_row["token"], "index"), idx)
    vix = minutes(f"SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lake('asset=index/symbol=INDIAVIX')}') ORDER BY ts")
    compare("vix", candles("NSE", vix_row["token"], "vix"), vix)
    try:
        fut_ref = minutes(f"SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lake('asset=future/underlying=NIFTY')}') ORDER BY instrument_id, ts")
    except Exception as error:  # noqa: BLE001
        fut_ref, out["future_lake_error"] = {}, scrub(error)
    if futs:
        out["future_symbol_expiry"] = expiry_of(futs[0]).isoformat()
        compare("future", candles("NFO", futs[0]["token"], "future"), fut_ref)

    for kind in ("CE", "PE"):
        row = next((r for r in opts if expiry_of(r) == near_expiry and r["symbol"].endswith(kind)
                    and abs(float(r["strike"]) / 100 - atm) < 0.01), None)
        if row is None:
            out[f"{kind}_error"] = "no contract in scrip master"
            continue
        rows = candles("NFO", row["token"], kind)
        ref = lake_opt[kind]
        compare(kind, rows, ref)
        time.sleep(0.5)
        status, body = post(
            "/rest/secure/angelbroking/historical/v1/getOIData",
            {"exchange": "NFO", "symboltoken": row["token"], "interval": "ONE_MINUTE",
             "fromdate": f"{DAY.isoformat()} 09:15", "todate": f"{DAY.isoformat()} 15:30"},
            auth,
        )
        oi_rows = body.get("data") or []
        entry = {"http": status, "ok": body.get("status"), "rows": len(oi_rows),
                 "errorcode": body.get("errorcode"), "message": scrub(body.get("message")),
                 "fyers_oi_rows": sum(1 for v in ref.values() if v[5] is not None)}
        if oi_rows:
            sample = oi_rows[0]
            entry["row_shape"] = [type(x).__name__ for x in sample] if isinstance(sample, dict) is False else list(sample)
            def minute_of(t):
                return str(t)[11:16] if len(str(t)) > 16 else str(t)[:5]
            pairs = []
            for r in oi_rows:
                t, v = (r["time"], r["oi"]) if isinstance(r, dict) else (r[0], r[1])
                m = minute_of(t)
                if m in ref and ref[m][5] is not None:
                    pairs.append((float(v), float(ref[m][5])))
            entry["oi_compared"] = len(pairs)
            entry["oi_equal"] = sum(1 for a, b in pairs if abs(a - b) < 0.5)
            entry["oi_within_1pct"] = sum(1 for a, b in pairs if b and abs(a - b) / abs(b) <= 0.01)
            entry["oi_sample"] = [list(p) for p in pairs[:3]]
            entry["oi_first_time_sample"] = str(oi_rows[0] if not isinstance(oi_rows[0], dict) else list(oi_rows[0].values()))[:60]
        out[f"{kind}_oi"] = entry

    print("RESULT", json.dumps(out, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
