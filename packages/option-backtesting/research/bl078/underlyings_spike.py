"""BL-079 Phase 1: the other underlyings (BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) on Angel One
against the Fyers lake. Read-only; one login; prints counts and equality only.
Run: uv run python research/bl078/underlyings_spike.py 2026-10-09"""

from __future__ import annotations

import json
import statistics as st
import sys
import time
from datetime import date, datetime
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).parent))
import angel_spike as A  # noqa: E402

DAY = A.DAY
CONFIG = {
    # underlying: (index symbol in master, index exchange, option/future exchange)
    "BANKNIFTY": ("Nifty Bank", "NSE", "NFO"),
    "FINNIFTY": ("Nifty Fin Service", "NSE", "NFO"),
    "MIDCPNIFTY": ("NIFTY MID SELECT", "NSE", "NFO"),
    "SENSEX": ("SENSEX", "BSE", "BFO"),
}


def main() -> int:
    env = A.ENV
    headers = {"Content-Type": "application/json", "Accept": "application/json", "X-UserType": "USER",
               "X-SourceID": "WEB", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "0.0.0.0",
               "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": env["ANGELONE_API_KEY"]}
    wait = 30 - int(time.time()) % 30
    if wait < 4:
        time.sleep(wait + 0.5)
    status, body = A.post("/rest/auth/angelbroking/user/v1/loginByPassword",
                          {"clientcode": env["ANGELONE_CLIENT_CODE"], "password": env["ANGELONE_MPIN"],
                           "totp": A.totp(env["ANGELONE_TOTP_SECRET"])}, headers)
    jwt = (body.get("data") or {}).get("jwtToken")
    print("LOGIN", status, body.get("message"), bool(jwt))
    if not jwt:
        return 2
    auth = {**headers, "Authorization": f"Bearer {jwt}"}
    master = json.loads((A.SCRATCH / "scrip_master.json").read_text())
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    L = A.LAKE
    calls = 0

    def lf(sub: str) -> str:
        return str(L / sub / f"date={DAY.isoformat()}" / "data.parquet")

    def minutes(sql: str) -> dict[str, tuple]:
        o: dict[str, tuple] = {}
        for row in con.execute(sql).fetchall():
            o.setdefault(row[0], tuple(row[1:]))
        return o

    def fetch(path: str, exch: str, token: str, frm="09:15", to="15:30") -> dict[str, list]:
        nonlocal calls
        calls += 1
        time.sleep(0.5)
        _, b = A.post(path, {"exchange": exch, "symboltoken": token, "interval": "ONE_MINUTE",
                             "fromdate": f"{DAY.isoformat()} {frm}", "todate": f"{DAY.isoformat()} {to}"}, auth)
        got: dict[str, list] = {}
        for r in b.get("data") or []:
            if isinstance(r, dict):  # getOIData rows are {"time": ..., "oi": ...}
                got[str(r["time"])[11:16]] = [r["oi"]]
            else:
                got[str(r[0])[11:16]] = r[1:]
        if not got:
            got["__error__"] = [A.scrub(b.get("message")), b.get("errorcode")]
        return got

    def cmp(a: dict, ref: dict, price_scale: float) -> dict:
        err = a.pop("__error__", None)
        if err or not a:
            return {"error": err or "no rows"}
        both = [m for m in a if m in ref]
        dm = [max(abs(float(a[m][i]) - float(ref[m][i])) for i in range(4)) for m in both]
        return {
            "angel_minutes": len(a), "fyers_minutes": len(ref), "common": len(both),
            "missing_in_angel": len([m for m in ref if m not in a and "09:15" <= m <= "15:29"]),
            "ohlc_equal": sum(1 for d in dm if d < 1e-6),
            "within_0.1pct_of_price": sum(
                1 for m, d in zip(both, dm, strict=False) if d <= 0.001 * max(float(ref[m][3]), 1e-9)),
            "median_max_diff": round(st.median(dm), 4) if dm else None,
        }

    cols = "open, high, low, close, volume, oi"
    result: dict[str, object] = {"day": DAY.isoformat()}
    for und, (idx_symbol, idx_exch, fo_exch) in CONFIG.items():
        r: dict[str, object] = {}
        idx_row = next((x for x in master if x["exch_seg"] == idx_exch and x["symbol"] == idx_symbol
                        and x["instrumenttype"] == "AMXIDX"), None)
        if idx_row is None:
            r["error"] = f"index {idx_symbol!r} not in master"
            result[und] = r
            continue
        r["index_token"] = idx_row["token"]
        idx_ref = minutes(f"SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{lf(f'asset=index/symbol={und}')}') ORDER BY ts")
        r["index"] = cmp(fetch("/rest/secure/angelbroking/historical/v1/getCandleData", idx_exch, idx_row["token"]),
                         idx_ref, 1)
        # options: nearest expiry present in both the master and the lake
        opt_file = lf(f"asset=option/underlying={und}")
        lake_exp = {d for (d,) in con.execute(f"SELECT DISTINCT expiry FROM read_parquet('{opt_file}')").fetchall()}
        opts = [x for x in master if x["exch_seg"] == fo_exch and x["instrumenttype"] == "OPTIDX" and x["name"] == und]
        def exp_of(x):
            try:
                return datetime.strptime(x["expiry"], "%d%b%Y").date()
            except ValueError:
                return None
        common = sorted({exp_of(x) for x in opts if exp_of(x) in lake_exp})
        if not common:
            r["options"] = {"error": f"no expiry shared by master and lake (lake: {sorted(lake_exp)[:4]})"}
            result[und] = r
            continue
        expiry = common[0]
        spot = float(idx_ref["11:00"][3]) if "11:00" in idx_ref else float(next(iter(idx_ref.values()))[3])
        strikes = sorted({float(s) for (s,) in con.execute(
            f"SELECT DISTINCT strike FROM read_parquet('{opt_file}') WHERE expiry = DATE '{expiry}'").fetchall()})
        atm = min(strikes, key=lambda s: abs(s - spot))
        r["option_expiry"], r["atm"], r["lake_strikes"] = expiry.isoformat(), atm, len(strikes)
        for kind in ("CE", "PE"):
            row = next((x for x in opts if exp_of(x) == expiry and x["symbol"].endswith(kind)
                        and abs(float(x["strike"]) / 100 - atm) < 0.01), None)
            if row is None:
                r[kind] = {"error": "contract not in master"}
                continue
            ref = minutes(f"""SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{opt_file}')
                              WHERE strike = {atm} AND expiry = DATE '{expiry}' AND option_type = '{kind}' ORDER BY ts""")
            got = fetch("/rest/secure/angelbroking/historical/v1/getCandleData", fo_exch, row["token"])
            entry = cmp(dict(got), ref, 1)
            vol = [float(got[m][4]) / float(ref[m][4]) for m in got if m in ref and float(ref[m][4]) and m != "__error__"]
            entry["lot_size_master"] = row["lotsize"]
            entry["median_volume_ratio_angel_over_fyers"] = round(st.median(vol), 5) if vol else None
            oi = fetch("/rest/secure/angelbroking/historical/v1/getOIData", fo_exch, row["token"])
            err = oi.pop("__error__", None)
            pairs = [(float(oi[m][0]), float(ref[m][5])) for m in oi if m in ref and ref[m][5] is not None]
            entry["oi_rows"] = len(oi)
            entry["oi_equal"] = f"{sum(1 for a, b in pairs if abs(a - b) < 0.5)}/{len(pairs)}"
            if err:
                entry["oi_error"] = err
            r[kind] = entry
        # nearest future
        fut_file = lf(f"asset=future/underlying={und}")
        futs = sorted((x for x in master if x["exch_seg"] == fo_exch and x["instrumenttype"] == "FUTIDX"
                       and x["name"] == und and (exp_of(x) or date.min) >= DAY), key=exp_of)
        if futs:
            sym_part = exp_of(futs[0]).strftime("%y%b").upper()
            try:
                ref = minutes(f"SELECT strftime(ts,'%H:%M'), {cols} FROM read_parquet('{fut_file}') "
                              f"WHERE vendor_symbol LIKE '%{und}{sym_part}FUT' ORDER BY ts")
                r["future"] = cmp(fetch("/rest/secure/angelbroking/historical/v1/getCandleData", fo_exch, futs[0]["token"]), ref, 1)
            except Exception as e:  # noqa: BLE001
                r["future"] = {"error": A.scrub(e)}
        result[und] = r
    result["angel_calls"] = calls
    (A.SCRATCH / "underlyings.json").write_text(json.dumps(result, indent=1, default=str))
    print("RESULT", json.dumps(result, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
