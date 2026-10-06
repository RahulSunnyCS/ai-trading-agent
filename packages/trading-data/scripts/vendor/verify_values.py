"""Cell-by-cell check of the lake against the ORIGINAL vendor CSVs.

Samples random contract CSVs from sources that are independent of the conversion pipeline:
  - the vendor's zips on the SSD (NIFTY 2025 / 2026, stocks)       -> read locally
  - Drive itself via rclone (SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50)
and, for spot and India VIX, random days of the vendor's CSVs.
Every row of every sampled file is compared with the lake: same minute, same open/high/low/close/
volume/oi. Reports rows compared, equal, different, only-in-CSV, only-in-lake — per source."""
import os, random, re, subprocess, sys, tempfile, zipfile
from pathlib import Path
import duckdb

SEED = int(os.environ.get("SEED", "20261007"))
random.seed(SEED)
LAKE = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData")) / "lake" / "bars_1m"
SSD = Path("/Volumes/RAHUL'S SSD/Stock Market Data")
DRIVE_ROOT = "1TR3HCVvV35q63fZ5DA4SE-cKkrZArJ2N"
con = duckdb.connect()
con.execute("SET TimeZone='Asia/Kolkata'")
con.execute("""CREATE TABLE src (grp VARCHAR, underlying VARCHAR, contract VARCHAR, ts TIMESTAMPTZ,
    open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE, oi DOUBLE)""")
tmp = Path(tempfile.mkdtemp(prefix="verify-values-"))
PAT = re.compile(r"^(?P<u>.+)_(?P<k>[\d.]+)_(?P<t>CE|PE)_(?P<d>\d{2})_(?P<m>[A-Za-z]{3})_(?P<y>\d{2})$")


def add_csv(grp, path: Path, name: str):
    stem = name[:-4]
    m = PAT.match(stem)
    if not m:
        return False
    hdr = path.open("r", encoding="utf-8-sig").readline().strip().lower().replace(" ", "")
    cols = hdr.split(",")
    if "timestamp" in cols:
        ts = "TRY_CAST(timestamp AS TIMESTAMPTZ)"
    elif "date" in cols and "time" in cols:
        ts = "CAST(strptime(trim(\"date\") || ' ' || trim(\"time\"), '%d-%m-%Y %H:%M') AS TIMESTAMP) AT TIME ZONE 'Asia/Kolkata'"
    else:
        return False
    oi = "TRY_CAST(oi AS DOUBLE)" if "oi" in cols else "CAST(NULL AS DOUBLE)"
    vol = "TRY_CAST(volume AS DOUBLE)" if "volume" in cols else "CAST(NULL AS DOUBLE)"
    con.execute(f"""INSERT INTO src SELECT ?, ?, ?, {ts}, TRY_CAST(open AS DOUBLE), TRY_CAST(high AS DOUBLE),
        TRY_CAST(low AS DOUBLE), TRY_CAST(close AS DOUBLE), {vol}, {oi}
        FROM read_csv(?, header=true, all_varchar=true) WHERE {ts} IS NOT NULL""", [grp, m["u"], stem, str(path)])
    return True


def sample_zip(grp, zpath, n, keep=lambda name: True):
    z = zipfile.ZipFile(zpath)
    names = [i.filename for i in z.infolist() if i.filename.endswith(".csv") and "__MACOSX" not in i.filename
             and not Path(i.filename).name.startswith("._") and keep(i.filename)]
    got = 0
    for n_ in random.sample(names, min(n, len(names))):
        out = tmp / Path(n_).name
        out.write_bytes(z.read(n_).rstrip(b"\x00") or z.read(n_))
        got += add_csv(grp, out, Path(n_).name)
    return got


def sample_drive(grp, section, unit, n):
    base = ["rclone"]
    args = ["lsf", f"gdrive:{section}/{unit}", "--files-only", "-R", "--exclude", "._*", f"--drive-root-folder-id={DRIVE_ROOT}"]
    names = [x for x in subprocess.run(base + args, capture_output=True, text=True).stdout.splitlines() if x.endswith(".csv")]
    picks = random.sample(names, min(n, len(names)))
    lst = tmp / f"{unit}.list"; lst.write_text("\n".join(picks) + "\n")
    dest = tmp / f"drive_{unit}"; dest.mkdir()
    subprocess.run(base + ["copy", f"gdrive:{section}/{unit}", str(dest), "--files-from", str(lst), "--no-traverse",
                           f"--drive-root-folder-id={DRIVE_ROOT}"], capture_output=True, text=True)
    got = 0
    for p in picks:
        f = dest / p
        if f.exists():
            got += add_csv(grp, f, f.name)
    return got


# ---- sources -------------------------------------------------------------------------------------------
loaded_stocks = {p.name.split("=")[1] for p in (LAKE / "asset=option").glob("underlying=*")}
index_units = {"NIFTY", "SENSEX", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"}
counts = {}
z25 = SSD / "options/index/nifty/2025 nifty options.zip"
z26 = next((SSD / "options/index/nifty").glob("2026 nifty options*.zip"))
counts["NIFTY (zip 2025)"] = sample_zip("NIFTY (zip 2025)", z25, 40)
counts["NIFTY (zip 2026)"] = sample_zip("NIFTY (zip 2026)", z26, 20)
counts["STOCKS (zip)"] = sample_zip("STOCKS (zip)", SSD / "options/stocks/stock options.zip", 40,
                                    keep=lambda n: n.split("/")[0] in {u for u in loaded_stocks} | {"GMRINFRA", "LTIM", "TATAMOTORS", "ZOMATO"})
for unit in ("sensex", "banknifty", "finnifty", "midcpnifty", "niftynxt50"):
    g = f"{unit.upper()} (Drive)"
    counts[g] = sample_drive(g, "index", unit, 20)
print("CSV files sampled:", counts, flush=True)

# ---- compare options -----------------------------------------------------------------------------------
unders = [r[0] for r in con.execute("SELECT DISTINCT underlying FROM src").fetchall()]
contracts_by_u = {u: [r[0] for r in con.execute("SELECT DISTINCT contract FROM src WHERE underlying=?", [u]).fetchall()] for u in unders}
con.execute("""CREATE TABLE lake (underlying VARCHAR, contract VARCHAR, ts TIMESTAMPTZ, open DOUBLE, high DOUBLE,
    low DOUBLE, close DOUBLE, volume DOUBLE, oi DOUBLE)""")
for u in unders:
    d = LAKE / "asset=option" / f"underlying={u}"
    if not d.exists():
        print(f"!! no lake partition for underlying {u}"); continue
    cs = contracts_by_u[u]
    con.execute("INSERT INTO lake SELECT ?, vendor_symbol, ts, open, high, low, close, volume, oi FROM read_parquet(?, hive_partitioning=true) WHERE vendor_symbol IN (SELECT unnest(?))",
                [u, str(d / "*" / "data.parquet"), cs])

rows = con.execute("""
WITH j AS (
  SELECT s.grp, s.contract AS sc, l.contract AS lc, s.ts AS sts, l.ts AS lts,
         (s.open IS NOT DISTINCT FROM l.open AND s.high IS NOT DISTINCT FROM l.high AND s.low IS NOT DISTINCT FROM l.low
          AND s.close IS NOT DISTINCT FROM l.close AND s.volume IS NOT DISTINCT FROM l.volume AND s.oi IS NOT DISTINCT FROM l.oi) AS same
  FROM src s FULL OUTER JOIN lake l ON s.underlying = l.underlying AND s.contract = l.contract AND s.ts = l.ts)
SELECT coalesce(grp, '(lake rows of sampled contracts the CSV lacks)') g, count(*) FILTER (WHERE sts IS NOT NULL AND lts IS NOT NULL AND same) eq,
       count(*) FILTER (WHERE sts IS NOT NULL AND lts IS NOT NULL AND NOT same) diff,
       count(*) FILTER (WHERE sts IS NOT NULL AND lts IS NULL) only_csv,
       count(*) FILTER (WHERE sts IS NULL AND lts IS NOT NULL) only_lake,
       count(DISTINCT sc) files
FROM j GROUP BY 1 ORDER BY 1""").fetchall()
print("\nOPTIONS — every row of each sampled original CSV vs the lake")
print(f"{'source':<44}{'files':>6}{'rows equal':>14}{'differ':>8}{'csv only':>10}{'lake only':>11}")
tot = [0, 0, 0, 0]
for g, eq, diff, oc, ol, files in rows:
    print(f"{g:<44}{files:>6}{eq:>14,}{diff:>8,}{oc:>10,}{ol:>11,}")
    tot = [tot[0] + eq, tot[1] + diff, tot[2] + oc, tot[3] + ol]
print(f"{'TOTAL':<44}{'':>6}{tot[0]:>14,}{tot[1]:>8,}{tot[2]:>10,}{tot[3]:>11,}")
bad = con.execute("""SELECT s.grp, s.contract, s.ts::VARCHAR, s.open, l.open, s.close, l.close, s.volume, l.volume, s.oi, l.oi
   FROM src s JOIN lake l ON s.underlying=l.underlying AND s.contract=l.contract AND s.ts=l.ts
   WHERE NOT (s.open IS NOT DISTINCT FROM l.open AND s.high IS NOT DISTINCT FROM l.high AND s.low IS NOT DISTINCT FROM l.low
   AND s.close IS NOT DISTINCT FROM l.close AND s.volume IS NOT DISTINCT FROM l.volume AND s.oi IS NOT DISTINCT FROM l.oi) LIMIT 5""").fetchall()
for b in bad: print("  DIFF", b)
ol = con.execute("""SELECT l.underlying, l.contract, count(*) FROM lake l ANTI JOIN src s ON s.underlying=l.underlying AND s.contract=l.contract AND s.ts=l.ts GROUP BY 1,2 ORDER BY 3 DESC LIMIT 5""").fetchall()
for b in ol: print("  LAKE-ONLY", b)

# ---- compare spot / VIX --------------------------------------------------------------------------------
print("\nSPOT / VIX — every row of 25 random days per series vs the lake")
specs = [("NIFTY", SSD / "2014-2024/spot_data/nifty_spot.csv"), ("BANKNIFTY", SSD / "2014-2024/spot_data/banknifty_spot.csv"),
         ("SENSEX", SSD / "2014-2024/spot_data/sensex_spot.csv"), ("INDIAVIX", SSD / "India VIX/2567_INDIAVIX.csv")]
print(f"{'series':<12}{'days':>6}{'rows equal':>14}{'differ':>8}{'csv only':>10}{'lake only':>11}")
for sym, csv in specs:
    con.execute("DROP TABLE IF EXISTS sp")
    con.execute("""CREATE TABLE sp AS SELECT strptime("Date", '%Y-%m-%dT%H:%M:%S%z') AS ts, "Open" o, "High" h, "Low" lo, "Close" c, "Volume" v
        FROM read_csv(?, header=true, columns={'Date':'VARCHAR','Open':'DOUBLE','High':'DOUBLE','Low':'DOUBLE','Close':'DOUBLE','Volume':'DOUBLE'})""", [str(csv)])
    days = [r[0] for r in con.execute("SELECT DISTINCT CAST(ts AT TIME ZONE 'Asia/Kolkata' AS DATE) FROM sp").fetchall()]
    # days that the Fyers collector wrote are not vendor data: skip them
    pick = random.sample(days, 25)
    con.execute("DROP TABLE IF EXISTS spl")
    con.execute("CREATE TABLE spl (ts TIMESTAMPTZ, o DOUBLE, h DOUBLE, lo DOUBLE, c DOUBLE, v DOUBLE)")
    for d in pick:
        f = LAKE / "asset=index" / f"symbol={sym}" / f"date={d}" / "data.parquet"
        if f.exists():
            con.execute("INSERT INTO spl SELECT ts, open, high, low, close, volume FROM read_parquet(?)", [str(f)])
    con.execute("CREATE TEMP TABLE pk AS SELECT unnest(?::DATE[]) d", [pick])
    r = con.execute("""WITH a AS (SELECT * FROM sp WHERE CAST(ts AT TIME ZONE 'Asia/Kolkata' AS DATE) IN (SELECT d FROM pk)),
        j AS (SELECT a.ts ats, spl.ts lts, (a.o IS NOT DISTINCT FROM spl.o AND a.h IS NOT DISTINCT FROM spl.h AND a.lo IS NOT DISTINCT FROM spl.lo
              AND a.c IS NOT DISTINCT FROM spl.c AND a.v IS NOT DISTINCT FROM spl.v) same FROM a FULL OUTER JOIN spl ON a.ts = spl.ts)
        SELECT count(*) FILTER (WHERE ats IS NOT NULL AND lts IS NOT NULL AND same), count(*) FILTER (WHERE ats IS NOT NULL AND lts IS NOT NULL AND NOT same),
               count(*) FILTER (WHERE ats IS NOT NULL AND lts IS NULL), count(*) FILTER (WHERE ats IS NULL AND lts IS NOT NULL) FROM j""").fetchone()
    con.execute("DROP TABLE pk")
    print(f"{sym:<12}{len(pick):>6}{r[0]:>14,}{r[1]:>8,}{r[2]:>10,}{r[3]:>11,}")
import shutil; shutil.rmtree(tmp, ignore_errors=True)
