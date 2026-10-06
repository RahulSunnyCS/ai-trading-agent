#!/usr/bin/env python3
"""Download Drive `options` folder in batches (one expiry folder at a time),
convert each batch to one Parquet file, verify, delete the batch's CSVs.

Resumable: finished batches are recorded in OUT/_done.jsonl and skipped.
Layout in : STAGE/<section>/<unit>/<expiry-folder>/<contract>.csv   (section = index | stocks)
Layout out: OUT/<section>/<unit>/<expiry-folder>.parquet
A batch's CSVs are deleted only after: (1) remote file list == local file list (names+sizes),
(2) parquet row count == independent CSV line count, (3) parquet read-back is clean.
"""
import argparse
import json
import os
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import duckdb

ROOT = "/Volumes/RAHUL'S SSD/Stock Market Data"
STAGE = f"{ROOT}/options"
OUT = f"{ROOT}/parquet/options"
DRIVE_ROOT = "1TR3HCVvV35q63fZ5DA4SE-cKkrZArJ2N"
MIN_FREE_GB = 8
JUNK = ("._", ".DS_Store")
# Files the owner decided to drop (differs from its original; owner chose the original). key = section/unit/folder/file
SKIP_FILES = {"index/nifty/2024-10-31/NIFTY_24500_PE_31_OCT_24 - Copy.csv"}
lock = threading.Lock()


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def rc(args, retries=6, filt=True):
    cmd = ["rclone", *args, f"--drive-root-folder-id={DRIVE_ROOT}"]
    if filt:
        cmd += ["--exclude", "._*", "--exclude", ".DS_Store", "--exclude", "__MACOSX/**"]
    for i in range(retries):
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout
        time.sleep(10 * (i + 1))
    raise RuntimeError(f"rclone failed: {' '.join(args)}\n{p.stderr[-600:]}")


def lsd(path):
    out = rc(["lsf", f"gdrive:{path}", "--dirs-only"])
    return sorted(x.rstrip("/") for x in out.splitlines() if x.strip())


def remote_files(path, depth_limited=False):
    args = ["lsf", f"gdrive:{path}", "--files-only", "--format", "ps", "--separator", ";"]
    args += ["--max-depth", "1"] if depth_limited else ["-R"]
    d = {}
    for line in rc(args).splitlines():
        if not line.strip():
            continue
        name, size = line.rsplit(";", 1)
        d[name] = int(size)
    return d


def local_files(base):
    d = {}
    for dp, _, fs in os.walk(base):
        for f in fs:
            if f.startswith(JUNK) or f == ".DS_Store":
                continue
            p = os.path.join(dp, f)
            d[os.path.relpath(p, base)] = os.path.getsize(p)
    return d


def free_gb():
    s = os.statvfs(ROOT)
    return s.f_bavail * s.f_frsize / 2**30


def count_rows(path):
    with open(path, "rb") as f:
        data = f.read()
    if not data.strip():
        return 0
    lines = data.count(b"\n") + (0 if data.endswith(b"\n") else 1)
    blank = data.count(b"\n\n")
    return lines - 1 - blank


SQL_PARSE = r"""
  regexp_extract(filename, '([^/]+)[.]csv$', 1) AS contract
"""


def convert(files, base, out_path):
    """files: list of relative paths. Returns (rows, parquet_bytes)."""
    groups = {}
    corrupt = []
    for rel in files:
        p = os.path.join(base, rel)
        if os.path.getsize(p) == 0:
            continue
        with open(p, "rb") as f:
            head = f.read(4096)
        if head.strip(b"\x00") == b"":
            corrupt.append(rel)      # all-NUL file: corrupt at source (seen identical in Drive and the zip)
            continue
        hdr = head.decode("utf-8-sig", errors="replace").split("\n", 1)[0].strip().lower().replace(" ", "")
        groups.setdefault(hdr, []).append(p)
    convert.last_corrupt = corrupt
    if not groups:
        raise RuntimeError("no non-empty CSVs")
    con = duckdb.connect()
    parts, params = [], []
    for hdr, plist in groups.items():
        cols = hdr.split(",")
        if "timestamp" in cols:
            ts = "CAST(timestamp AS TIMESTAMPTZ)"
        elif "date" in cols and "time" in cols:
            ts = "CAST(strptime(trim(\"date\") || ' ' || trim(\"time\"), '%d-%m-%Y %H:%M') AS TIMESTAMP) AT TIME ZONE 'Asia/Kolkata'"
        else:
            raise RuntimeError(f"unknown header: {hdr}")
        need = {"open", "high", "low", "close"}
        if not need <= set(cols):
            raise RuntimeError(f"missing price cols: {hdr}")
        vol = "TRY_CAST(volume AS BIGINT)" if "volume" in cols else "CAST(NULL AS BIGINT)"
        oi = "TRY_CAST(oi AS DOUBLE)" if "oi" in cols else "CAST(NULL AS DOUBLE)"
        colspec = "{" + ",".join(f"'{c}': 'VARCHAR'" for c in cols) + "}"
        parts.append(f"""
          SELECT regexp_extract(filename, '([^/]+)[.]csv$', 1) AS contract,
                 {ts} AS ts,
                 CAST(open AS DOUBLE) AS open, CAST(high AS DOUBLE) AS high,
                 CAST(low AS DOUBLE) AS low, CAST(close AS DOUBLE) AS close,
                 {vol} AS volume, {oi} AS oi
          FROM read_csv(?, header=true, columns={colspec}, filename=true, ignore_errors=false)""")
        params.append(plist)
    union = " UNION ALL ".join(parts)
    pat = r"^(.+?)_(\d+(?:[.]\d+)?)_(CE|PE)_(\d{2})_([A-Za-z]{3})_(\d{2})$"
    q = f"""
      SELECT regexp_extract(contract, '{pat}', 1) AS underlying,
             contract,
             TRY_CAST(regexp_extract(contract, '{pat}', 2) AS DOUBLE) AS strike,
             regexp_extract(contract, '{pat}', 3) AS option_type,
             TRY_CAST(try_strptime(regexp_extract(contract, '{pat}', 4) || '-' ||
                      upper(regexp_extract(contract, '{pat}', 5)) || '-' ||
                      regexp_extract(contract, '{pat}', 6), '%d-%b-%y') AS DATE) AS expiry,
             ts, open, high, low, close, volume, oi
      FROM ({union}) ORDER BY contract, ts"""
    tmp = out_path + ".tmp"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    con.execute(f"CREATE TEMP TABLE batch AS {q}", params)
    t = tmp.replace("'", "''")
    con.execute(f"COPY batch TO '{t}' (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 6)")
    rows, null_ts, unparsed = con.execute(
        f"SELECT count(*), count(*) FILTER (WHERE ts IS NULL), "
        f"count(*) FILTER (WHERE underlying = '' OR expiry IS NULL) FROM read_parquet('{t}')").fetchone()
    if null_ts:
        raise RuntimeError(f"{null_ts} rows with NULL ts")
    return rows, unparsed, tmp


ZIP_PATH = f"{ROOT}/_zip_check/stocks/stock options.zip"
ZIPIDX = {}


def build_zip_index():
    import zipfile
    d = {}
    with zipfile.ZipFile(ZIP_PATH) as z:
        for i in z.infolist():
            n = i.filename
            p = n.split("/")
            if n.endswith("/") or "__MACOSX" in n or p[-1].startswith("._") or len(p) != 3 or not n.lower().endswith(".csv"):
                continue
            d.setdefault((p[0], p[1]), {})[p[2]] = n
    return d


def remote_files_h(path):
    args = ["lsf", f"gdrive:{path}", "--files-only", "-R", "--format", "psh", "--hash", "MD5", "--separator", ";"]
    d = {}
    for line in rc(args).splitlines():
        if line.strip():
            name, size, h = line.rsplit(";", 2)
            d[name] = (int(size), h)
    return d



_unit_locks = {}
_unit_cache = {}
_unit_guard = threading.Lock()


def unit_listing(section, unit):
    """folder -> {filename: (size, md5)} for a whole unit, from ONE rclone call (cached on disk).
    rc() raises on a non-zero exit, so a truncated listing can never be cached silently."""
    k = (section, unit)
    with _unit_guard:
        lk = _unit_locks.setdefault(k, threading.Lock())
    with lk:
        if k in _unit_cache:
            return _unit_cache[k]
        cf = f"{OUT}/_remote/{section}__{unit}.json"
        if os.path.exists(cf):
            _unit_cache[k] = json.load(open(cf))
            return _unit_cache[k]
        out = rc(["lsf", f"gdrive:{section}/{unit}", "--files-only", "-R", "--format", "psh",
                  "--hash", "MD5", "--separator", ";"])
        d = {}
        for line in out.splitlines():
            if not line.strip():
                continue
            name, size, h = line.rsplit(";", 2)
            folder, _, fname = name.partition("/")
            d.setdefault(folder, {})[fname] = (int(size), h)
        os.makedirs(os.path.dirname(cf), exist_ok=True)
        json.dump(d, open(cf + ".tmp", "w"))
        os.replace(cf + ".tmp", cf)
        _unit_cache[k] = d
        return d


def stage_from_drive(rpath, base):
    remote = remote_files(rpath)
    os.makedirs(base, exist_ok=True)
    rc(["copy", f"gdrive:{rpath}", base, "--transfers", "8", "--checkers", "8",
        "--retries", "5", "--low-level-retries", "20"], retries=3)
    local = local_files(base)
    if local != remote:
        miss = set(remote) - set(local)
        extra = set(local) - set(remote)
        raise RuntimeError(f"file mismatch: missing {len(miss)} extra {len(extra)} "
                           f"size-diff {sum(1 for k in set(local)&set(remote) if local[k]!=remote[k])}")
    return dict(source="drive")


def stage_from_zip(unit, folder, rpath, base):
    """Stage the better of (zip copy, Drive copy) of every contract file, downloading only
    the Drive files whose MD5 differs from the zip's (or that the zip lacks)."""
    import hashlib
    import zipfile
    remote = {n: tuple(v) for n, v in unit_listing('stocks', unit).get(folder, {}).items()}
    if not remote:
        raise RuntimeError('empty Drive listing for folder (unit listing incomplete?)')
    zmap = ZIPIDX[(unit, folder)]
    dl_dir = f"{STAGE}/_dl/{unit}__{folder}"
    subprocess.run(["rm", "-rf", dl_dir, base], capture_output=True)
    os.makedirs(base, exist_ok=True)
    zb = {}
    notes_pad = []
    with zipfile.ZipFile(ZIP_PATH) as z:
        for name, zn in zmap.items():
            raw = z.read(zn)
            zb[name] = raw.rstrip(b"\x00") if raw.rstrip(b"\x00") else raw   # zip pads some files with NULs to a 256 KiB block
            if len(zb[name]) != len(raw):
                notes_pad.append(name)
    need = [n for n, (sz, h) in remote.items() if n not in zb or hashlib.md5(zb[n]).hexdigest() != h]
    drv = {}
    if need:
        os.makedirs(dl_dir, exist_ok=True)
        lst = f"{dl_dir}/_list.txt"
        with open(lst, "w") as f:
            f.write("\n".join(need) + "\n")
        rc(["copy", f"gdrive:{rpath}", dl_dir, "--files-from", lst, "--no-traverse", "--transfers", "8",
            "--retries", "5", "--low-level-retries", "20"], retries=3, filt=False)
        for n in need:
            data = open(os.path.join(dl_dir, n), "rb").read()
            if hashlib.md5(data).hexdigest() != remote[n][1]:
                raise RuntimeError(f"md5 mismatch after download: {n}")
            drv[n] = data.rstrip(b"\x00") or data
    notes = dict(source="zip+drive", zip_nul_padded=len(notes_pad), from_zip=0, from_drive=0, zip_longer=0, drive_longer=0, tie_differ=0, zip_only=0)
    for name in set(zb) | set(remote):
        zd, dd = zb.get(name), drv.get(name)
        if name in remote and dd is None:        # identical to zip (md5 equal) -> use zip bytes
            pick = zd; notes["from_zip"] += 1
        elif zd is not None and dd is not None:
            rz, rd = count_rows_bytes(zd), count_rows_bytes(dd)
            if rz > rd: pick = zd; notes["zip_longer"] += 1
            elif rd > rz: pick = dd; notes["drive_longer"] += 1
            else: pick = dd; notes["tie_differ"] += 1
        elif dd is not None:
            pick = dd; notes["from_drive"] += 1
        else:
            pick = zd; notes["zip_only"] += 1
        with open(os.path.join(base, name), "wb") as f:
            f.write(pick)
    subprocess.run(["rm", "-rf", dl_dir], capture_output=True)
    return notes


def count_rows_bytes(data):
    if not data.strip():
        return 0
    lines = data.count(b"\n") + (0 if data.endswith(b"\n") else 1)
    return lines - 1 - data.count(b"\n\n")


def process(task, done, deadline, errfile):
    section, unit, folder = task
    key = f"{section}/{unit}/{folder}"
    if key in done:
        return "skip"
    if time.time() > deadline:
        return "deadline"
    if free_gb() < MIN_FREE_GB:
        log(f"LOW DISK ({free_gb():.1f} GiB) - skipping {key}")
        return "lowdisk"
    try:
        rpath = f"{section}/{unit}/{folder}"
        base = f"{STAGE}/{rpath}"
        if section == "stocks" and (unit, folder) in ZIPIDX:
            notes = stage_from_zip(unit, folder, rpath, base)
            local = local_files(base)
        else:
            notes = stage_from_drive(rpath, base)
            local = local_files(base)
        csvs = sorted(k for k in local if k.lower().endswith(".csv"))
        others = [k for k in local if not k.lower().endswith(".csv")]
        if others:
            raise RuntimeError(f"non-csv files present: {others[:3]}")
        skipped = [k for k in csvs if f"{key}/{k}" in SKIP_FILES]
        csvs = [k for k in csvs if k not in skipped]
        name_ok = re.compile(r"^.+_\d+(?:\.\d+)?_(CE|PE)_\d{2}_[A-Za-z]{3}_\d{2}\.csv$")
        dups = []
        for k in [k for k in csvs if not name_ok.match(os.path.basename(k))]:
            orig = re.sub(r"\s*(-\s*Copy|\(\d+\))(\s*\(\d+\))?\.csv$", ".csv", k, flags=re.I)
            if orig != k and orig in local and open(os.path.join(base, k), "rb").read() == open(os.path.join(base, orig), "rb").read():
                dups.append(k)   # byte-identical copy of another file in the same folder
            else:
                raise RuntimeError(f"unrecognised/non-identical file name: {k}")
        csvs = [k for k in csvs if k not in dups]
        out_path = f"{OUT}/{section}/{unit}/{folder}.parquet"
        rows, unparsed, tmp = convert(csvs, base, out_path)
        corrupt = list(getattr(convert, 'last_corrupt', []))
        csv_rows = sum(count_rows(os.path.join(base, k)) for k in csvs if k not in corrupt)
        if rows != csv_rows:
            raise RuntimeError(f"row mismatch: csv {csv_rows} parquet {rows}")
        os.replace(tmp, out_path)
        size = os.path.getsize(out_path)
        csv_bytes = sum(local.values())
        for _ in range(3):
            subprocess.run(["rm", "-rf", base], capture_output=True)
            if not os.path.exists(base):
                break
            time.sleep(1)
        else:
            log(f"WARN could not fully remove {base}")
        rec = dict(key=key, files=len(csvs), identical_copies_skipped=len(dups), owner_skipped=skipped, corrupt_skipped=corrupt, rows=rows, csv_bytes=csv_bytes,
                   parquet_bytes=size, unparsed_contract_rows=unparsed, t=int(time.time()), **notes)
        with lock:
            with open(f"{OUT}/_done.jsonl", "a") as f:
                f.write(json.dumps(rec) + "\n")
            done.add(key)
        extra = ""
        if notes.get("source") == "zip+drive":
            extra = (f" [zip {notes['from_zip']}, drive-dl {notes['from_drive']}, zip-longer {notes['zip_longer']}, "
                     f"drive-longer {notes['drive_longer']}, zip-only {notes['zip_only']}]")
        if corrupt:
            extra += f" [CORRUPT (all-NUL) skipped: {corrupt}]"
        log(f"OK {key}: {len(csvs)} files, {rows} rows, {csv_bytes/2**20:.1f} MiB csv -> {size/2**20:.1f} MiB parquet" + extra
            + (f"  [unparsed contract names: {unparsed}]" if unparsed else ""))
        return "ok"
    except Exception as e:
        with lock, open(errfile, "a") as f:
            f.write(f"{time.strftime('%F %T')} {key}: {e}\n")
        log(f"FAIL {key}: {str(e)[:300]}")
        return "fail"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-minutes", type=float, default=105)
    ap.add_argument("--only", help="key prefix, e.g. index/banknifty/2026-02-24")
    ap.add_argument("--list", action="store_true", help="only list tasks")
    ap.add_argument("--refresh", action="store_true", help="rebuild the cached task list from Drive")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    done = set()
    if os.path.exists(f"{OUT}/_done.jsonl"):
        done = {json.loads(l)["key"] for l in open(f"{OUT}/_done.jsonl") if l.strip()}
    errfile = f"{OUT}/_errors.log"
    if os.path.exists(ZIP_PATH):
        ZIPIDX.update(build_zip_index())
        log(f"zip index: {len(ZIPIDX)} stock expiry folders available locally")
    deadline = time.time() + a.max_minutes * 60
    tasks = []
    cache = f"{OUT}/_tasks.json"
    if os.path.exists(cache) and not a.refresh:
        tasks = [tuple(t) for t in json.load(open(cache))]
        log(f"loaded {len(tasks)} expiry folders from cache")
    else:
        for section in ("index", "stocks"):
            out = rc(["lsf", f"gdrive:{section}", "--dirs-only", "-R", "--max-depth", "2"])
            dirs = sorted(x.rstrip("/") for x in out.splitlines() if x.strip())
            loose = rc(["lsf", f"gdrive:{section}", "--files-only", "-R", "--max-depth", "2"]).split()
            if loose:
                log(f"WARNING: {len(loose)} loose files at depth<=2 under {section}/ e.g. {loose[:3]}")
            for d in dirs:
                if d.count("/") == 1:
                    unit, folder = d.split("/")
                    tasks.append((section, unit, folder))
            log(f"{section}: {len([t for t in tasks if t[0]==section])} expiry folders")
        json.dump(tasks, open(cache, "w"))
    if a.only:
        tasks = [t for t in tasks if "/".join(t).startswith(a.only)]
    todo = [t for t in tasks if "/".join(t) not in done]
    log(f"{len(tasks)} expiry folders total, {len(tasks)-len(todo)} done, {len(todo)} to do")
    if a.list:
        return
    res = {}
    with ThreadPoolExecutor(a.workers) as ex:
        for r in ex.map(lambda t: process(t, done, deadline, errfile), todo):
            res[r] = res.get(r, 0) + 1
    log(f"finished pass: {res}; free {free_gb():.1f} GiB")


if __name__ == "__main__":
    main()
