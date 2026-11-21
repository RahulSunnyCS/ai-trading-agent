import json
import sys
from datetime import date
from pathlib import Path

import duckdb

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import base, candles, store

root = data_dir()
c = duckdb.connect()
c.execute("SET TimeZone='Asia/Kolkata'")


def ranges(sym):
    q = f"""select date, arg_min(open,ts) o, max(high) h, min(low) l, arg_max(close,ts) cl
    from read_parquet('/Volumes/TradingData/lake/bars_1m/asset=index/symbol={sym}/date=*/*.parquet', hive_partitioning=true)
    where (hour(ts)*60+minute(ts)) between 9*60+17 and 15*60+29 group by date order by date"""
    rows = c.sql(q).fetchall()
    return {
        d: dict(
            o=o, h=h, l=lo, cl=cl, rng=(h - lo) / o * 100, move=abs(cl - o) / o * 100, pts=h - lo
        )
        for d, o, h, lo, cl in rows
        if o
    }


R = {s: ranges(s) for s in ("NIFTY", "SENSEX")}
for s in R:
    print(s, len(R[s]), min(R[s]), max(R[s]))
# strategy series
ser = {}
S, E = date(2024, 10, 17), date(2026, 11, 6)
with store.slipped(0.5):
    for book in ("core", "t1"):
        pk = candles.picks_by_day(root, book, S, E)
        s = {}
        for d, p in pk.items():
            tot = 0
            ok = True
            for n, lots in p.names:
                v = store.read_net(n, root).get(d)
                if v is None:
                    ok = False
                    break
                tot += lots * v
            if ok:
                s[d] = tot
        ser[book] = s
wide = base.read_column(store.slip_path(store.result_path(base.WIDE_NAME, root), 0.5), "net")
dr = base.read_column(store.slip_path(base._path(root), 0.5), "net")
ser["base"] = {d: 2 * wide[d] + dr[d] for d in wide if d in dr and S <= d <= E}
out = {
    "R": {s: {str(d): v for d, v in R[s].items()} for s in R},
    "ser": {k: {str(d): v for d, v in s.items()} for k, s in ser.items()},
}
Path(sys.argv[1]).write_text(json.dumps(out))
print({k: len(v) for k, v in ser.items()})
