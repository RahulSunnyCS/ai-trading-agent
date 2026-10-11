"""BL-078: MCX commodity 1-minute check, Fyers vs Angel One (Shoonya added once its keys exist).
Read-only; prints counts and equality only. Run: uv run python research/bl078/commodity_spike.py 2026-10-09"""

from __future__ import annotations

import csv
import io
import json
import statistics as st
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import angel_spike as A  # noqa: E402  (loads .env, TOTP and the signed POST helper)

IST = timezone(timedelta(hours=5, minutes=30))
DAY = A.DAY
NAMES = ["CRUDEOIL", "GOLDM", "SILVERM", "NATURALGAS", "COPPER"]
FYERS_MASTER = "https://public.fyers.in/sym_details/MCX_COM.csv"
PSQL = "/opt/homebrew/opt/postgresql@16/bin/psql"


def fyers_token() -> tuple[str, str]:
    env = A.ENV
    sql = (
        "SELECT app_id || ' ' || pgp_sym_decrypt(dearmor(access_token), '"
        + env["FYERS_APP_SECRET"].replace("'", "''")
        + "') FROM broker_tokens WHERE broker='fyers' AND expires_at > now()"
    )
    out = subprocess.run([PSQL, env["DATABASE_URL"], "-At", "-c", sql], capture_output=True, text=True)
    app_id, _, token = out.stdout.strip().partition(" ")
    if not token:
        raise SystemExit("no valid Fyers token stored; log in from the dashboard first")
    return app_id, token


def fyers_candles(app_id: str, token: str, symbol: str) -> list[list]:
    q = urllib.parse.urlencode({
        "symbol": symbol, "resolution": "1", "date_format": "1", "cont_flag": "1", "oi_flag": "1",
        "range_from": DAY.isoformat(), "range_to": DAY.isoformat(),
    })
    request = urllib.request.Request(
        f"https://api-t1.fyers.in/data/history?{q}",
        headers={"Authorization": f"{app_id}:{token}", "User-Agent": "Mozilla/5.0 (research)"},
    )
    time.sleep(0.4)
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            body = json.load(r)
    except Exception as e:  # noqa: BLE001
        return [["error", A.scrub(e)]]
    if body.get("s") != "ok":
        return [["error", A.scrub(body.get("message") or body.get("s"))]]
    return body.get("candles") or []


def main() -> int:
    app_id, token = fyers_token()
    # Angel login (one attempt)
    api_key = A.ENV["ANGELONE_API_KEY"]
    headers = {"Content-Type": "application/json", "Accept": "application/json", "X-UserType": "USER",
               "X-SourceID": "WEB", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "0.0.0.0",
               "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": api_key}
    wait = 30 - int(time.time()) % 30
    if wait < 4:
        time.sleep(wait + 0.5)
    status, body = A.post("/rest/auth/angelbroking/user/v1/loginByPassword",
                          {"clientcode": A.ENV["ANGELONE_CLIENT_CODE"], "password": A.ENV["ANGELONE_MPIN"],
                           "totp": A.totp(A.ENV["ANGELONE_TOTP_SECRET"])}, headers)
    jwt = (body.get("data") or {}).get("jwtToken")
    print("ANGEL LOGIN", status, body.get("message"), bool(jwt))
    auth = {**headers, "Authorization": f"Bearer {jwt}"}

    master = json.loads((A.SCRATCH / "scrip_master.json").read_text())
    with urllib.request.urlopen(FYERS_MASTER, timeout=60) as r:
        fy_rows = list(csv.reader(io.StringIO(r.read().decode())))

    def angel_series(path: str, token_: str, minutes_from: str, minutes_to: str) -> dict[str, list]:
        out: dict[str, list] = {}
        start = datetime.fromisoformat(f"{DAY.isoformat()} {minutes_from}")
        end = datetime.fromisoformat(f"{DAY.isoformat()} {minutes_to}")
        cur = start
        while cur < end:
            nxt = min(cur + timedelta(hours=4), end)
            time.sleep(0.5)
            _, b = A.post(path, {"exchange": "MCX", "symboltoken": token_, "interval": "ONE_MINUTE",
                                 "fromdate": cur.strftime("%Y-%m-%d %H:%M"),
                                 "todate": nxt.strftime("%Y-%m-%d %H:%M")}, auth)
            for row in b.get("data") or []:
                out[str(row[0])[11:16]] = row[1:]
            cur = nxt
        return out

    result: dict[str, object] = {"day": DAY.isoformat()}
    for name in NAMES:
        entry: dict[str, object] = {}
        # contracts: nearest future >= DAY on both sides
        a_futs = sorted((r for r in master if r["exch_seg"] == "MCX" and r["instrumenttype"] == "FUTCOM"
                         and r["name"] == name and A.datetime.strptime(r["expiry"], "%d%b%Y").date() >= DAY),
                        key=lambda r: A.datetime.strptime(r["expiry"], "%d%b%Y"))
        f_futs = sorted((r for r in fy_rows if len(r) > 16 and r[13] == name and r[16] == "XX"
                         and r[2] == "30" and datetime.fromtimestamp(int(r[8]), IST).date() >= DAY),
                        key=lambda r: int(r[8]))
        if not a_futs or not f_futs:
            entry["error"] = f"angel_contracts={len(a_futs)} fyers_contracts={len(f_futs)}"
            result[name] = entry
            continue
        a_exp = A.datetime.strptime(a_futs[0]["expiry"], "%d%b%Y").date()
        f_exp = datetime.fromtimestamp(int(f_futs[0][8]), IST).date()
        entry["contract"] = {"angel_expiry": a_exp.isoformat(), "fyers_expiry": f_exp.isoformat(),
                             "fyers_symbol": f_futs[0][9], "lot": a_futs[0]["lotsize"]}
        fc = fyers_candles(app_id, token, f_futs[0][9])
        if fc and fc[0][0] == "error":
            entry["fyers_error"] = fc[0][1]
            fc = []
        fy = {datetime.fromtimestamp(c[0], IST).strftime("%H:%M"): c[1:] for c in fc}
        an = angel_series("/rest/secure/angelbroking/historical/v1/getCandleData", a_futs[0]["token"], "09:00", "23:59")
        ao = angel_series("/rest/secure/angelbroking/historical/v1/getOIData", a_futs[0]["token"], "09:00", "23:59")
        both = [m for m in an if m in fy]
        stats = {
            "angel_minutes": len(an), "fyers_minutes": len(fy), "common": len(both),
            "angel_first_last": [min(an), max(an)] if an else None,
            "fyers_first_last": [min(fy), max(fy)] if fy else None,
            "angel_only": sorted(set(an) - set(fy))[:3], "fyers_only": sorted(set(fy) - set(an))[:3],
            "ohlc_equal": sum(1 for m in both if all(abs(float(an[m][i]) - float(fy[m][i])) < 1e-6 for i in range(4))),
        }
        if both:
            dm = [max(abs(float(an[m][i]) - float(fy[m][i])) for i in range(4)) for m in both]
            stats["median_max_ohlc_diff"] = round(st.median(dm), 4)
            vr = [float(an[m][4]) / float(fy[m][4]) for m in both if float(fy[m][4])]
            stats["median_volume_ratio_angel_over_fyers"] = round(st.median(vr), 4) if vr else None
        stats["fyers_has_oi_column"] = bool(fc) and len(fc[0]) >= 7
        stats["angel_oi_minutes"] = len(ao)
        if ao and fc and len(fc[0]) >= 7:
            fo = {datetime.fromtimestamp(c[0], IST).strftime("%H:%M"): c[6] for c in fc}
            bo = [m for m in ao if m in fo]
            stats["oi_equal"] = f"{sum(1 for m in bo if abs(float(ao[m][0]) - float(fo[m])) < 0.5)}/{len(bo)}"
        entry["futures"] = stats
        result[name] = entry
    print("RESULT", json.dumps(result, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
