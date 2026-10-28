"""`expiry_day`'s loader (BL-165): the simulator's expiry rule over a small lake, cached with a stamp
of each day's files, so a repaired day is worked out again and a day without an option file is not
saved."""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from trading_data import lake

from option_backtesting.legwise.market import listed_expiries
from option_backtesting.ruletest import expr as E
from option_backtesting.ruletest import frame as F

D1, D2, D3 = date(2024, 10, 16), date(2024, 10, 17), date(2024, 10, 18)


def write_options(root: Path, day: date, expiries: list[date]) -> None:
    path = lake.bars_1m_path(root, "option", "NIFTY", day)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table({"expiry": expiries}), path)


def frame_of(days: list[date]) -> E.Frame:
    z = np.zeros((len(days), E.N_BARS))
    return E.Frame(days=[d.isoformat() for d in days], O=z, H=z, L=z, C=z)


def test_expiry_day_follows_the_listed_expiries_and_skips_missing_files(tmp_path):
    write_options(tmp_path, D1, [D2, date(2025, 12, 30)])  # the day before expiry
    write_options(tmp_path, D2, [D2, date(2024, 10, 24)])  # expiry day
    # D3 has no option file
    fr = frame_of([D1, D2, D3])
    assert listed_expiries(tmp_path, "NIFTY", D3) is None
    flags = F.ExpiryDayLoader(tmp_path, "NIFTY", fr)()
    assert flags.tolist() == [False, True, False]
    with np.load(F.store.features_dir(tmp_path) / "expiry_day_NIFTY.npz") as z:
        assert z["days"].tolist() == [D1.isoformat(), D2.isoformat()]  # D3 not saved


def test_a_repaired_day_is_worked_out_again(tmp_path):
    write_options(tmp_path, D2, [date(2024, 10, 24)])  # the expiring weekly missing
    fr = frame_of([D2])
    assert F.ExpiryDayLoader(tmp_path, "NIFTY", fr)().tolist() == [False]
    write_options(tmp_path, D2, [D2, date(2024, 10, 24)])  # repaired
    path = lake.bars_1m_path(tmp_path, "option", "NIFTY", D2)
    os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 10**9))
    assert F.ExpiryDayLoader(tmp_path, "NIFTY", fr)().tolist() == [True]
