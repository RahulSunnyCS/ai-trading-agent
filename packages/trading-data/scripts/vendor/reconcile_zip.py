#!/usr/bin/env python3
"""Reconcile `stock options.zip` against the converted Parquet files.

For every expiry folder that already has a Parquet file, compare per-contract row counts:
  zip rows  > parquet rows  -> the Drive copy was short/empty: patch that contract from the zip
  zip has a contract that parquet lacks entirely -> add it
  parquet rows > zip rows   -> reported only (Drive is newer/longer; nothing changed)
Folders not converted yet are skipped; re-run later. Idempotent.
Writes: OUT/_reconcile_report.csv (every difference) and OUT/_reconcile.jsonl (per folder actions).
"""
import argparse
import collections
import csv
import json
import os
import shutil
import sys
import time
import zipfile

import duckdb

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from options_to_parquet import OUT, ROOT, STAGE, convert

ZIP = f"{ROOT}/_zip_check/stocks/stock options.zip"
TMP = f"{STAGE}/_recon"


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="prefix like HDFCBANK/2024-10-31")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    done_f = f"{OUT}/_reconcile.jsonl"
    already = set()
    if os.path.exists(done_f):
        already = {json.loads(l)["key"] for l in open(done_f) if l.strip()}
    z = zipfile.ZipFile(ZIP)
    folders = collections.defaultdict(list)
    for i in z.infolist():
        n = i.filename
        p = n.split("/")
        if n.endswith("/") or "__MACOSX" in n or p[-1].startswith("._") or len(p) != 3 or not n.lower().endswith(".csv"):
            continue
        folders[(p[0], p[1])].append(i)
    keys = sorted(folders)
    if a.only:
        keys = [k for k in keys if f"{k[0]}/{k[1]}".startswith(a.only)]
    done_conv = set()
    if os.path.exists(f"{OUT}/_done.jsonl"):
        done_conv = {json.loads(l)["key"] for l in open(f"{OUT}/_done.jsonl") if l.strip()}
    rep = open(f"{OUT}/_reconcile_report.csv", "a", newline="")
    w = csv.writer(rep)
    if rep.tell() == 0:
        w.writerow(["folder", "contract", "zip_rows", "parquet_rows", "action"])
    stats = collections.Counter()
    con = duckdb.connect()
    for (unit, folder) in keys:
        key = f"stocks/{unit}/{folder}"
        if key not in done_conv:
            stats["pending (not converted yet)"] += 1
            continue
        if key in already and not a.only:
            stats["already reconciled"] += 1
            continue
        pq = f"{OUT}/stocks/{unit}/{folder}.parquet"
        have = dict(con.execute("SELECT contract, count(*) FROM read_parquet(?) GROUP BY 1", [pq]).fetchall())
        zrows = {}
        for i in folders[(unit, folder)]:
            c = os.path.basename(i.filename)[:-4]
            zrows[c] = (i, count_rows_bytes(z.read(i)))
        patch = [c for c, (_, r) in zrows.items() if r > have.get(c, 0)]
        shorter = [c for c, (_, r) in zrows.items() if r < have.get(c, 0)]
        for c in patch:
            w.writerow([key, c, zrows[c][1], have.get(c, 0), "patched" if not a.dry_run else "would patch"])
        for c in shorter:
            w.writerow([key, c, zrows[c][1], have.get(c, 0), "kept parquet (longer)"])
        stats["folders checked"] += 1
        stats["contracts patched"] += len(patch)
        stats["contracts parquet-longer"] += len(shorter)
        if patch and not a.dry_run:
            work = f"{TMP}/{unit}__{folder}"
            shutil.rmtree(work, ignore_errors=True)
            os.makedirs(work)
            rels = []
            for c in patch:
                i = zrows[c][0]
                dst = os.path.join(work, c + ".csv")
                with open(dst, "wb") as f:
                    f.write(z.read(i))
                rels.append(c + ".csv")
            newrows, _, newtmp = convert(rels, work, f"{work}/new.parquet")
            exp_new = sum(zrows[c][1] for c in patch)
            if newrows != exp_new:
                log(f"FAIL {key}: patched rows {newrows} != expected {exp_new}")
                stats["FAILED"] += 1
                continue
            old_rows = sum(have.values())
            old_patched = sum(have.get(c, 0) for c in patch)
            m = duckdb.connect()
            m.execute("CREATE TEMP TABLE p(contract VARCHAR)")
            m.executemany("INSERT INTO p VALUES (?)", [(c,) for c in patch])
            q = (f"SELECT * FROM read_parquet('{pq.replace(chr(39), chr(39)*2)}') "
                 f"WHERE contract NOT IN (SELECT contract FROM p) "
                 f"UNION ALL SELECT * FROM read_parquet('{newtmp.replace(chr(39), chr(39)*2)}')")
            out_tmp = pq + ".patch.tmp"
            m.execute(f"COPY (SELECT * FROM ({q}) ORDER BY contract, ts) TO '{out_tmp.replace(chr(39), chr(39)*2)}' "
                      f"(FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 6)")
            got = m.execute(f"SELECT count(*) FROM read_parquet('{out_tmp.replace(chr(39), chr(39)*2)}')").fetchone()[0]
            if got != old_rows - old_patched + exp_new:
                log(f"FAIL {key}: merged rows {got} != {old_rows - old_patched + exp_new}")
                os.remove(out_tmp)
                stats["FAILED"] += 1
                continue
            os.replace(out_tmp, pq)
            shutil.rmtree(work, ignore_errors=True)
            log(f"PATCHED {key}: {len(patch)} contracts, +{exp_new - old_patched} rows")
        if not a.dry_run:
            with open(done_f, "a") as f:
                f.write(json.dumps(dict(key=key, patched=len(patch), parquet_longer=len(shorter))) + "\n")
    rep.close()
    log("summary: " + json.dumps(dict(stats)))


def count_rows_bytes(data):
    if not data.strip():
        return 0
    lines = data.count(b"\n") + (0 if data.endswith(b"\n") else 1)
    return lines - 1 - data.count(b"\n\n")


if __name__ == "__main__":
    main()
