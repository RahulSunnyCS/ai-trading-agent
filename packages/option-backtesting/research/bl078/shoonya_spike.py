"""BL-078 Phase 1c: Shoonya (Noren) 1-minute data vs the Fyers files. Read-only; prints counts and
equality only. One login attempt per run. Run: uv run python research/bl078/shoonya_spike.py 2026-10-09"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import statistics as st
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).parent))
import angel_spike as A  # noqa: E402
import commodity_spike as C  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
DAY = A.DAY
HOST = "https://api.shoonya.com/NorenWClientTP"
MASTERS = "https://api.shoonya.com"


def noren(route: str, data: dict, key: str | None = None) -> object:
    payload = "jData=" + json.dumps(data) + (f"&jKey={key}" if key else "")
    request = urllib.request.Request(f"{HOST}/{route}", data=payload.encode(), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    try:
        return json.loads(raw)
    except ValueError:
        return {"stat": "Not_Ok", "emsg": f"non-JSON: {raw[:80]!r}"}


def master(exch: str) -> list[dict]:
    cache = A.SCRATCH / f"shoonya_{exch}.csv"
    if not cache.exists():
        with urllib.request.urlopen(f"{MASTERS}/{exch}_symbols.txt.zip", timeout=60) as r:
            z = zipfile.ZipFile(io.BytesIO(r.read()))
            cache.write_bytes(z.read(z.namelist()[0]))
    return list(csv.DictReader(io.StringIO(cache.read_text())))


def main() -> int:
    env = A.ENV
    uid = env["SHOONYA_CLIENT_ID"]
    secret = env["SHOONYA_API_KEY"]
    vc = env.get("SHOONYA_VENDOR_CODE") or f"{uid}_U"
    imei = env.get("SHOONYA_IMEI") or "ata-research-1"
    wait = 30 - int(time.time()) % 30
    if wait < 4:
        time.sleep(wait + 0.5)
    res = noren("QuickAuth", {
        "source": "API", "apkversion": "1.0.0", "uid": uid,
        "pwd": hashlib.sha256(env["SHOONYA_PASSWORD"].encode()).hexdigest(),
        "factor2": A.totp(env["SHOONYA_TOTP_SECRET"]), "vc": vc,
        "appkey": hashlib.sha256(f"{uid}|{secret}".encode()).hexdigest(), "imei": imei,
    })
    r = res if isinstance(res, dict) else {}
    tok = r.get("susertoken")
    print("SHOONYA LOGIN", json.dumps({"stat": r.get("stat"), "emsg": A.scrub(r.get("emsg")),
                                       "got_token": bool(tok), "vendor_code_used": "env" if env.get("SHOONYA_VENDOR_CODE") else "uid_U"}))
    if not tok:
        return 2

    def series(exch: str, token: str, frm: str, to: str, label: str, out: dict) -> dict[str, tuple]:
        def ep(hm: str) -> int:
            return int(datetime.fromisoformat(f"{DAY.isoformat()} {hm}").replace(tzinfo=IST).timestamp())
        time.sleep(0.5)
        rows = noren("TPSeries", {"ordersource": "API", "uid": uid, "exch": exch, "token": token,
                                  "st": str(ep(frm)), "et": str(ep(to)), "intrv": "1"}, tok)
        if not isinstance(rows, list):
            out[f"{label}_call"] = {"error": A.scrub(rows.get("emsg") if isinstance(rows, dict) else rows)}
            return {}
        got: dict[str, tuple] = {}
        for c in rows:
            if c.get("stat") not in (None, "Ok"):
                continue
            m = datetime.strptime(c["time"], "%d-%m-%Y %H:%M:%S").strftime("%H:%M")
            got[m] = (float(c["into"]), float(c["inth"]), float(c["intl"]), float(c["intc"]),
                      float(c.get("intv") or 0), float(c["intoi"]) if c.get("intoi") not in (None, "") else None)
        out[f"{label}_call"] = {"rows": len(rows), "keys": sorted(rows[0].keys()) if rows else []}
        return got

    def compare(label: str, got: dict[str, tuple], ref: dict[str, tuple], out: dict) -> None:
        both = [m for m in got if m in ref]
        if not both:
            out[f"{label}_diff"] = {"shoonya_minutes": len(got), "fyers_minutes": len(ref), "common": 0}
            return
        dm = [max(abs(got[m][i] - float(ref[m][i])) for i in range(4)) for m in both]
        vr = [got[m][4] / float(ref[m][4]) for m in both if ref[m][4]]
        oi = [(got[m][5], float(ref[m][5])) for m in both if got[m][5] is not None and ref[m][5] is not None]
        out[f"{label}_diff"] = {
            "shoonya_minutes": len(got), "fyers_minutes": len(ref), "common": len(both),
            "first_last": [min(got), max(got)],
            "shoonya_only": sorted(set(got) - set(ref))[:3], "fyers_only": sorted(set(ref) - set(got))[:3],
            "ohlc_equal": sum(1 for d in dm if d < 1e-6), "within_0.25": sum(1 for d in dm if d <= 0.251),
            "median_max_diff": round(st.median(dm), 4),
            "median_volume_ratio": round(st.median(vr), 4) if vr else None,
            "oi_compared": len(oi), "oi_equal": sum(1 for a, b in oi if abs(a - b) < 0.5),
            "oi_nonzero": sum(1 for a, _ in oi if a),
        }

    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    L = A.LAKE
    cols = "open, high, low, close, volume, oi"

    def lake(sql: str) -> dict[str, tuple]:
        o: dict[str, tuple] = {}
        for row in con.execute(sql).fetchall():
            o.setdefault(row[0], tuple(row[1:]))
        return o

    def lf(sub: str) -> str:
        return str(L / sub / f"date={DAY.isoformat()}" / "data.parquet")

    out: dict[str, object] = {"day": DAY.isoformat()}
    nse = master("NSE")
    nfo = master("NFO")
    mcx = master("MCX")
    idx_row = next(r for r in nse if r["Symbol"] == "Nifty 50" or r["TradingSymbol"] == "Nifty 50")
    vix_row = next(r for r in nse if r["TradingSymbol"] in ("India VIX", "INDIA VIX"))
    out["tokens"] = {"nifty": idx_row["Token"], "vix": vix_row["Token"]}

    idx_ref = lake(f"SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lf('asset=index/symbol=NIFTY')}') ORDER BY ts")
    compare("index", series("NSE", idx_row["Token"], "09:15", "15:30", "index", out), idx_ref, out)
    vix_ref = lake(f"SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lf('asset=index/symbol=INDIAVIX')}') ORDER BY ts")
    compare("vix", series("NSE", vix_row["Token"], "09:15", "15:30", "vix", out), vix_ref, out)

    # NIFTY nearest weekly ATM CE/PE and the October future, from the NFO master
    def exp(r: dict) -> date | None:
        try:
            return datetime.strptime(r["Expiry"], "%d-%b-%Y").date()
        except (KeyError, ValueError):
            return None

    opts = [r for r in nfo if r["Symbol"] == "NIFTY" and r["Instrument"] == "OPTIDX" and (exp(r) or date.min) >= DAY]
    near = min(exp(r) for r in opts)
    spot = float(idx_ref["11:00"][3])
    atm = round(spot / 50) * 50
    for kind in ("CE", "PE"):
        row = next((r for r in opts if exp(r) == near and r["OptionType"] == kind
                    and abs(float(r["StrikePrice"]) - atm) < 0.01), None)
        if row is None:
            out[f"{kind}_error"] = "no contract in NFO master"
            continue
        ref = lake(f"""SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lf('asset=option/underlying=NIFTY')}')
                       WHERE strike = {atm} AND expiry = DATE '{near.isoformat()}' AND option_type = '{kind}' ORDER BY ts""")
        got = series("NFO", row["Token"], "09:15", "15:30", kind, out)
        out[f"{kind}_lot_size_in_master"] = row["LotSize"]
        compare(kind, got, ref, out)
    futs = sorted((r for r in nfo if r["Symbol"] == "NIFTY" and r["Instrument"] == "FUTIDX" and (exp(r) or date.min) >= DAY), key=exp)
    if futs:
        sym = f"NSE:NIFTY{exp(futs[0]).strftime('%y%b').upper()}FUT"
        ref = lake(f"SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lf('asset=future/underlying=NIFTY')}') WHERE vendor_symbol='{sym}' ORDER BY ts")
        compare("future", series("NFO", futs[0]["Token"], "09:15", "15:30", "future", out), ref, out)

    # MCX commodities against the Fyers history API
    app_id, ftoken = C.fyers_token()
    for name in C.NAMES:
        futs = sorted((r for r in mcx if r["Symbol"] == name and r["Instrument"] == "FUTCOM" and (exp(r) or date.min) >= DAY), key=exp)
        if not futs:
            out[f"mcx_{name}"] = "no contract in MCX master"
            continue
        sym = f"MCX:{name}{exp(futs[0]).strftime('%y%b').upper()}FUT"
        fc = C.fyers_candles(app_id, ftoken, sym)
        if fc and fc[0][0] == "error":
            out[f"mcx_{name}_fyers_error"] = fc[0][1]
            continue
        ref = {datetime.fromtimestamp(c[0], IST).strftime("%H:%M"): tuple(c[1:7]) for c in fc}
        compare(f"mcx_{name}", series("MCX", futs[0]["Token"], "09:00", "23:59", f"mcx_{name}", out), ref, out)

    print("RESULT", json.dumps(out, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
