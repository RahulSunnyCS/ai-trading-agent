"""T3: Nifty 50 membership curation + the EW-index membership check (QA C18, F12).

Unit tests run on small synthetic fixtures built here (no files, no network).
Data-dependent tests read the gitignored raw cache under data/stocks/ and skip when
it is absent (fresh clone / CI).
"""

from __future__ import annotations

import csv
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.stocks import membership_check as mc
from momentum_backtesting.stocks.schemas import CURATED_HEADERS, is_valid_company_id

PKG = Path(__file__).resolve().parents[2]
CURATED = PKG / "src/momentum_backtesting/stocks/curated"
DATA = PKG / "data/stocks"
RAW = DATA / "raw"


# --------------------------------------------------------------------------
# Synthetic fixture: 4 stocks, an equal-weight index over 3 of them
# --------------------------------------------------------------------------


def _synthetic(n_days: int = 60, seed: int = 7):
    """Prices for A-D and an EW index that holds A,B,C, swaps C->D on day 30 with an
    equal-weight reset on the same day (price date = previous session)."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2024-01-01", periods=n_days)
    rets = pd.DataFrame(rng.normal(0, 0.02, size=(n_days, 4)), index=days, columns=list("ABCD"))
    rets.iloc[0] = 0.0
    close = 100 * (1 + rets).cumprod()
    rows = []
    for s in close.columns:
        prev = close[s].shift(1).fillna(close[s].iloc[0])
        for d in days:
            rows.append((d.date(), s, float(close.at[d, s]), float(prev.at[d])))
    daily = pd.DataFrame(rows, columns=["date", "symbol", "close", "prevclose"])

    change = 30
    w = np.array([1.0, 1.0, 1.0])
    level = [1000.0]
    held = ["A", "B", "C"]
    for t in range(1, n_days):
        if t == change:
            held = ["A", "B", "D"]
            w = np.ones(3) * sum(w) / 3.0
        g = (1 + rets.iloc[t][held]).to_numpy()
        level.append(level[-1] * float((w * g).sum() / w.sum()))
        w = w * g
    index = pd.Series(level, index=days)
    membership = pd.DataFrame(
        {
            "company_id": ["C0001", "C0002", "C0003", "C0004"],
            "symbol": ["A", "B", "C", "D"],
            "from": [str(days[0].date())] * 3 + [str(days[change].date())],
            "to": ["", "", str(days[change - 1].date()), ""],
            "kind": ["investable"] * 4,
        }
    )
    rebalances = pd.DataFrame(
        {
            "effective": [days[change]],
            "price_date": [days[change - 1]],
            "kind": ["ad hoc"],
        }
    )
    return daily, membership, index, rebalances, days


def test_correct_membership_reproduces_the_index():
    daily, membership, index, reb, _ = _synthetic()
    res = mc.run(daily, membership, index, rebalances=reb)
    summary = mc.summarize(res)
    assert summary["meets_target"]
    assert summary["median_abs_bp"] < 0.01
    assert res["residual_bp"].abs().max() < 0.01


def test_shifted_effective_date_is_detected():
    """QA F12: a wrong effective date must show up as residuals from that date."""
    daily, membership, index, reb, days = _synthetic()
    shifted = membership.copy()
    shifted.loc[shifted.symbol == "C", "to"] = str(days[39].date())
    shifted.loc[shifted.symbol == "D", "from"] = str(days[40].date())
    reb2 = reb.assign(effective=[days[40]], price_date=[days[39]])
    res = mc.run(daily, shifted, index, rebalances=reb2)
    bad = res.loc[days[30] : days[39], "residual_bp"].abs()
    assert (bad > 5).mean() > 0.5
    assert mc.summarize(res)["share_below_target"] < 1.0


def test_split_event_is_adjusted_not_scored():
    daily, membership, index, reb, days = _synthetic()
    # a 1:2 split on A on day 10: price halves in the raw data, index is unaffected
    d10 = days[10].date()
    mask_after = (daily.symbol == "A") & (daily.date >= d10)
    daily.loc[mask_after, "close"] /= 2
    daily.loc[mask_after & (daily.date > d10), "prevclose"] /= 2
    ev = pd.DataFrame([("C0001", days[10], "split", 0.5, np.nan)], columns=list(mc.EVENT_COLUMNS))
    res = mc.run(daily, membership, index, rebalances=reb, event_days=ev)
    assert bool(res.loc[days[10], "excluded"])
    assert res.loc[days[11] :, "residual_bp"].abs().max() < 0.01


def test_rebalance_schedule_eras():
    sess = pd.bdate_range("2016-01-01", "2026-09-30")
    m = pd.DataFrame(
        {
            "company_id": ["C0001"],
            "symbol": ["X"],
            "from": ["2016-01-01"],
            "to": [""],
            "kind": ["investable"],
        }
    )
    reb = mc.rebalance_schedule(sess, m).set_index("effective")
    # from 2021: last session of the review month, 3-session lag
    assert pd.Timestamp("2025-09-30") in reb.index
    assert reb.at[pd.Timestamp("2025-09-30"), "price_date"] == pd.Timestamp("2025-09-25")
    # 2018-2020: first session after the F&O expiry, 5-session lag (methodology doc)
    assert pd.Timestamp("2019-09-27") in reb.index
    assert reb.at[pd.Timestamp("2019-09-27"), "price_date"] == pd.Timestamp("2019-09-20")
    # calibrated skip
    assert pd.Timestamp("2020-03-27") not in reb.index


# --------------------------------------------------------------------------
# Invariants (QA C18)
# --------------------------------------------------------------------------


def _members(n: int, start="2024-01-01", to="") -> list[dict]:
    return [
        {
            "company_id": f"C{i + 1:04d}",
            "symbol": f"S{i + 1}",
            "from": start,
            "to": to,
            "kind": "investable",
        }
        for i in range(n)
    ]


def test_invariants_accept_50_and_a_dated_dummy_period():
    sess = pd.bdate_range("2024-01-01", periods=20)
    rows = _members(50)
    rows.append(
        {
            "company_id": "C0099",
            "symbol": "DUMMY",
            "from": str(sess[5].date()),
            "to": str(sess[8].date()),
            "kind": "dummy",
        }
    )
    m = pd.DataFrame(rows)
    assert mc.check_invariants(m, sess, [f"S{i + 1}" for i in range(50)]) == []


@pytest.mark.parametrize("n", [49, 52])
def test_invariants_reject_wrong_member_count(n):
    sess = pd.bdate_range("2024-01-01", periods=5)
    m = pd.DataFrame(_members(n))
    problems = mc.check_invariants(m, sess, [f"S{i + 1}" for i in range(n)])
    assert any("members" in p for p in problems)


def test_invariants_reject_open_rows_not_matching_current_list():
    sess = pd.bdate_range("2024-01-01", periods=5)
    m = pd.DataFrame(_members(50))
    current = [f"S{i + 1}" for i in range(49)] + ["OTHER"]
    problems = mc.check_invariants(m, sess, current)
    assert any("open rows" in p for p in problems)


# --------------------------------------------------------------------------
# Committed curated files (no raw data needed)
# --------------------------------------------------------------------------


def _read(name: str) -> pd.DataFrame:
    with open(CURATED / name, newline="") as f:
        header = next(csv.reader(f))
    assert tuple(header) == CURATED_HEADERS[name]
    return pd.read_csv(CURATED / name, dtype=str, keep_default_na=False)


def test_curated_files_are_consistent():
    companies = _read("companies.csv")
    aliases = _read("aliases.csv")
    membership = _read("nifty50_membership.csv")
    assert companies["company_id"].is_unique
    assert all(is_valid_company_id(c) for c in companies["company_id"])
    known = set(companies["company_id"])
    assert set(aliases["company_id"]) == known
    assert set(membership["company_id"]) <= known
    assert set(membership["kind"]) <= {"investable", "dummy"}
    # every membership symbol is an alias of the same company, within its date range
    al = aliases.assign(
        f=pd.to_datetime(aliases["from"]), t=pd.to_datetime(aliases["to"].replace("", None))
    )
    for r in membership.itertuples(index=False):
        rows = al[(al.company_id == r.company_id) & (al.symbol == r.symbol)]
        assert len(rows) == 1, (r.company_id, r.symbol)
        if r.kind == "investable":
            assert rows.f.iloc[0] <= pd.Timestamp(r[2]), r
    # every membership change row carries a source or is labelled UNVERIFIED
    assert all(s.strip() for s in membership["source"])
    assert membership["from"].min() <= "2011-01-03"


# --------------------------------------------------------------------------
# Data-dependent (skip without the raw cache)
# --------------------------------------------------------------------------

needs_raw = pytest.mark.skipif(
    not (RAW / "nifty50_current.csv").exists()
    or not (RAW / "benchmarks/NIFTY50_EQUAL_WEIGHT_PRICE.csv").exists(),
    reason="raw data cache not present",
)


@needs_raw
def test_real_membership_invariants():
    """Counts are checked over every session. The current-list half compares the snapshot with
    the members on the day it was downloaded, not with the open-ended rows: a reshuffle is
    curated once announced (BSE for WIPRO, effective 2026-09-30), so the committed curation can
    run ahead of the hand-downloaded snapshot. `mbt stocks fetch`'s guard still compares the
    open rows and fails until the snapshot is refreshed (BL-018)."""
    membership = _read("nifty50_membership.csv")
    sessions = pd.read_csv(RAW / "benchmarks/NIFTY50_EQUAL_WEIGHT_PRICE.csv")["date"]
    open_rows = membership.loc[membership["to"] == "", "symbol"]
    assert mc.check_invariants(membership, sessions, open_rows) == []

    snapshot = RAW / "nifty50_current.csv"
    taken = date.fromtimestamp(snapshot.stat().st_mtime).isoformat()
    on_that_day = (membership["from"] <= taken) & (
        (membership["to"] == "") | (membership["to"] >= taken)
    )
    assert set(membership.loc[on_that_day, "symbol"]) == set(pd.read_csv(snapshot)["Symbol"])


@pytest.mark.skipif(not (DATA / "daily.parquet").exists(), reason="daily.parquet absent")
@needs_raw
def test_real_membership_check_runs_and_is_mostly_exact():
    """Warning-level check: reported, not a gate. Guards only against gross breakage
    (a whole-period misalignment would push the median residual far above 1 bp)."""
    daily = pd.read_parquet(
        DATA / "daily.parquet", columns=["date", "symbol", "close", "prevclose"]
    )
    ew = pd.read_csv(RAW / "benchmarks/NIFTY50_EQUAL_WEIGHT_PRICE.csv", parse_dates=["date"])
    membership = _read("nifty50_membership.csv")
    res = mc.run(daily, membership, ew.set_index("date")["close"])
    summary = mc.summarize(res)
    assert summary["median_abs_bp"] < 1.0
