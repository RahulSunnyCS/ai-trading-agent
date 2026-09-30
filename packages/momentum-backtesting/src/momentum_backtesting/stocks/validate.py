"""Plan.md §4 post-hoc validation: the dividend verifier (§4.1) and the Yahoo
adjclose cross-check (§4.3). Unlike guards.py, every result here is a review flag,
never a run-failing assertion — validate.py runs after adjust.py has already
produced its output.

(§4.2's membership/timing check is owned by T3 — see membership_check.py — because
it only needs raw daily.parquet + membership + the EW price index, not adjust.py's
output; T7 just re-runs it as part of the same validation pass.)

Non-obvious decision (T7): the T0 stub's `dividend_check(tri_index, price_index,
events, membership)` signature has no way to reach per-company prices, and
plan.md §4.1's expected spread is `sum(w_i,t-1 * D_i / P_i,t-1)`, which needs both
the reconstructed EW weights *and* each member's own close price. Widening the
signature to add a `daily: pd.DataFrame` parameter (grepped the tree first --
nothing else calls `dividend_check` yet) is the same kind of documented deviation
`benchmarks.cash_weekly` already made from its T0 stub for the same reason (a
frozen signature that was missing a value the acceptance criteria requires).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from momentum_backtesting.stocks.membership_check import (
    EW_LAUNCH_DATE,
    _growth_by_company,
    _normalise_membership,
    rebalance_schedule,
)
from momentum_backtesting.stocks.schemas import EventKind

#: plan.md §4.1: no-event-day spread floor and the ex-date residual floor, in basis
#: points (a day's spread this small is NSE/our own rounding noise, not a signal).
NO_EVENT_FLOOR_BP = 0.3
EX_DATE_FLOOR_BP = 0.3
#: plan.md §4.1: ex-date residual tolerance as a fraction of the expected spread
#: (the greater of this and EX_DATE_FLOOR_BP applies).
EX_DATE_TOLERANCE_FRACTION = 0.15
#: plan.md §4.1: per-year summed-spread tolerance, as a fraction of the summed
#: expected spread for that year.
YEARLY_TOLERANCE_FRACTION = 0.05
#: plan.md §4.1: a dividend above this fraction of the prior close is a "special"
#: dividend (NSE divisor-adjusts those) -- exempt from the expected sum, but still
#: flagged for review.
SPECIAL_DIVIDEND_PRICE_FRACTION = 0.10

#: events.parquet `kind` values that carry a per-share dividend amount.
_DIVIDEND_KINDS = frozenset({EventKind.DIVIDEND, EventKind.COMBINED_DIVIDEND_BONUS})
#: events.parquet `kind` values that are pure share-count changes (no value
#: transfer) -- these move a member's raw close/prevclose ratio without moving the
#: index, so the weight-walk below neutralises them the same way
#: membership_check.run does, instead of letting them distort reconstructed weight.
_SHARE_COUNT_KINDS = frozenset({EventKind.SPLIT, EventKind.BONUS})

_DAY_COLUMNS = ["date", "observed_spread_bp", "expected_spread_bp", "verdict", "tag"]


# --------------------------------------------------------------------------
# EW weight reconstruction (§4.1: "using our reconstructed EW weights")
# --------------------------------------------------------------------------


def _member_close_pivot(
    daily: pd.DataFrame, m: pd.DataFrame, sessions: pd.DatetimeIndex
) -> tuple[list[str], np.ndarray]:
    """Close price per company, aligned to `sessions`, stitched across a company's
    dated symbol rows in `m` (membership_check._normalise_membership's output) the
    same way membership_check._growth_by_company stitches its close/prevclose
    ratio. Needed alongside that function's growth ratios because §4.1's expected
    spread also needs the absolute price P_i,t-1, not just a day's return.
    """
    d = daily[["date", "symbol", "close"]].copy()
    d["date"] = pd.to_datetime(d["date"])
    d = d[d["symbol"].isin(set(m["symbol"]))]
    piv = d.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    piv = piv.reindex(sessions)
    companies = sorted(m["company_id"].unique())
    price = np.full((len(sessions), len(companies)), np.nan)
    for j, cid in enumerate(companies):
        rows = m[m["company_id"] == cid].sort_values("from").reset_index(drop=True)
        col = np.full(len(sessions), np.nan)
        for k, r in rows.iterrows():
            lo = 0 if k == 0 else sessions.searchsorted(r["from"])
            hi = (
                len(sessions)
                if k == len(rows) - 1
                else sessions.searchsorted(rows.loc[k + 1, "from"])
            )
            if r["symbol"] in piv.columns:
                col[lo:hi] = piv[r["symbol"]].to_numpy()[lo:hi]
        price[:, j] = col
    return companies, price


def _reconstruct_ew_weights(
    daily: pd.DataFrame, events: pd.DataFrame, membership: pd.DataFrame, sessions: pd.DatetimeIndex
) -> tuple[list[str], np.ndarray]:
    """Approximate w_i,t-1 for every member company and session (plan.md §4.1:
    "partly circular, but a +/-10% weight error stays under the thresholds").

    Reuses membership_check.rebalance_schedule (the calibrated reset-date/
    price-date table -- do not re-derive it) and membership_check's private
    close/prevclose growth-pivot + membership-normalisation helpers (import, not
    modify, per the T7 brief) to avoid re-deriving ~60 lines of dated-symbol
    stitching that module already gets right. What is NOT reused is
    membership_check.run's day-by-day state machine: that function resolves each
    corporate-action day's growth against the *published index return* so its own
    reconstructed_return tracks the index -- exactly the dividend/other-event
    signal T7 needs to measure, so folding it in here would erase what this
    function is trying to detect. This walk instead only neutralises pure
    share-count events (split/bonus, via each event's `factor`) so a member's
    weight does not jump on those value-neutral days, and lets every other event
    (dividend, rights, demerger, ...) flow through as an ordinary price move --
    the resulting weight series is the "partly circular" approximation plan.md
    §4.1 explicitly accepts.

    Returns (companies, weights) where weights[t, j] is company j's fraction of
    the EW basket as of the close *before* session t (i.e. the w_i,t-1 used when
    scoring session t), and a company outside the index on a given day is 0.
    """
    m = _normalise_membership(membership, sessions)
    companies, growth = _growth_by_company(daily, m, sessions)
    cpos = {c: i for i, c in enumerate(companies)}
    n_t, n_c = len(sessions), len(companies)

    share_count = events[events["kind"].isin([k.value for k in _SHARE_COUNT_KINDS])]
    for row in share_count.itertuples(index=False):
        if row.company_id not in cpos or not row.factor or row.factor <= 0:
            continue
        t = pd.Timestamp(row.session)
        if t in sessions:
            growth[sessions.get_loc(t), cpos[row.company_id]] /= float(row.factor)

    member = np.zeros((n_t, n_c), dtype=bool)
    for cid, start, stop in zip(m["company_id"], m["from"], m["to_excl"], strict=True):
        a, b = sessions.searchsorted(start), sessions.searchsorted(stop)
        member[a:b, cpos[cid]] = True

    rebalances = rebalance_schedule(sessions, membership)
    resets: dict[int, int] = {}
    for r in rebalances.itertuples(index=False):
        e, c = pd.Timestamp(r.effective), pd.Timestamp(r.price_date)
        if e in sessions and c in sessions:
            resets[sessions.get_loc(e)] = sessions.get_loc(c)

    weights = np.zeros((n_t, n_c))
    first = int(np.argmax(member.any(axis=1)))
    cur = member[first].astype(float)  # equal weight among members at the first covered close
    for t in range(first, n_t):
        weights[t] = cur / cur.sum() if cur.sum() > 0 else cur
        if t + 1 >= n_t:
            break
        mem, nxt = member[t], member[t + 1]
        total = cur.sum()
        if (t + 1) in resets:
            price_pos = resets[t + 1]
            nw = np.zeros(n_c)
            if total > 0 and nxt.any():
                nw[nxt] = growth[price_pos + 1 : t + 1, nxt].prod(axis=0)
            cur = nw / nw.sum() * total if nw.sum() > 0 else nw
        else:
            leavers = np.where(mem & ~nxt)[0]
            entrants = np.where(nxt & ~mem)[0]
            freed = cur[leavers].sum()
            cur[leavers] = 0.0
            if len(entrants) and freed > 0:
                cur[entrants] = freed / len(entrants)
            elif freed > 0 and cur[nxt].sum() > 0:
                cur[nxt] *= total / cur[nxt].sum()
            cur[nxt] = cur[nxt] * growth[t + 1, nxt]
            cur[~nxt] = 0.0
    return companies, weights


# --------------------------------------------------------------------------
# 4.1 -- dividend verifier
# --------------------------------------------------------------------------


def dividend_check(
    tri_index: pd.Series,
    price_index: pd.Series,
    events: pd.DataFrame,
    membership: pd.DataFrame,
    daily: pd.DataFrame,
) -> pd.DataFrame:
    """Plan.md §4.1: verify the reconstructed dividend events against the
    NIFTY50 EQUAL WEIGHT TRI-vs-price spread.

    For each day: observed = TRI return - price return; expected = sum of
    w_i,t-1 * D_i / P_i,t-1 over our reconstructed EW weights and events. Flags a
    day where |observed - expected| exceeds max(0.3bp, 15% of expected) on an
    ex-date, or 0.3bp on a no-event day; flags a year where the summed observed and
    expected spreads differ by more than 5%. A special dividend above 10% of price
    is exempt (NSE divisor-adjusts those) but still flagged for review. Days before
    the EW TRI's live start are tagged `back-calc`.

    Returns one row per day: date, observed_spread_bp, expected_spread_bp, verdict
    (pass/flag), and a `tag` column (comma-joined, e.g. "back-calc",
    "special-dividend-exempt", "year-imbalance") where applicable.
    """
    tri = tri_index.sort_index()
    price = price_index.sort_index()
    if not tri.index.equals(price.index):
        raise ValueError(
            "tri_index and price_index must share an identical date index "
            "(see benchmarks.assert_same_session_set)"
        )
    sessions = pd.DatetimeIndex(price.index)

    observed = (tri.pct_change() - price.pct_change()) * 1e4  # bp
    observed = observed.reindex(sessions)

    div_events = events[events["kind"].isin([k.value for k in _DIVIDEND_KINDS])].copy()
    div_events["session"] = pd.to_datetime(div_events["session"])
    div_events = div_events[div_events["session"].isin(sessions)]

    companies, weights = _reconstruct_ew_weights(daily, events, membership, sessions)
    _, close = _member_close_pivot(daily, _normalise_membership(membership, sessions), sessions)
    cpos = {c: i for i, c in enumerate(companies)}

    expected = pd.Series(0.0, index=sessions)
    tags: dict[pd.Timestamp, list[str]] = {}
    for row in div_events.itertuples(index=False):
        if row.company_id not in cpos:
            continue
        ti = sessions.get_loc(row.session)
        if ti == 0:
            continue  # no t-1 to price against
        j = cpos[row.company_id]
        p_prev = close[ti - 1, j]
        w_prev = weights[ti - 1, j]
        dividend = row.dividend
        if not (np.isfinite(p_prev) and p_prev > 0 and np.isfinite(dividend) and w_prev > 0):
            continue
        day = sessions[ti]
        if dividend / p_prev > SPECIAL_DIVIDEND_PRICE_FRACTION:
            tags.setdefault(day, []).append("special-dividend-exempt")
            continue
        expected.loc[day] += w_prev * dividend / p_prev * 1e4  # bp

    for day in sessions:
        if day < pd.Timestamp(EW_LAUNCH_DATE):
            tags.setdefault(day, []).append("back-calc")

    event_days = set(div_events["session"]) - {
        d for d, t in tags.items() if "special-dividend-exempt" in t and expected.get(d, 0.0) == 0.0
    }

    verdict = pd.Series("pass", index=sessions)
    for day in sessions:
        obs = observed.get(day, np.nan)
        exp = expected.get(day, 0.0)
        if not np.isfinite(obs):
            continue
        residual = abs(obs - exp)
        if day in event_days:
            threshold = max(EX_DATE_FLOOR_BP, EX_DATE_TOLERANCE_FRACTION * abs(exp))
        else:
            threshold = NO_EVENT_FLOOR_BP
        if residual > threshold:
            verdict.loc[day] = "flag"

    # Yearly reconciliation: sum(observed) vs sum(expected) per calendar year.
    year_obs = observed.dropna().groupby(observed.dropna().index.year).sum()
    year_exp = expected.groupby(expected.index.year).sum()
    for year in sorted(set(year_obs.index) | set(year_exp.index)):
        o, e = year_obs.get(year, 0.0), year_exp.get(year, 0.0)
        # When the expected sum is ~0 (no recorded dividend events at all that
        # year), "within 5%" is degenerate -- fall back to the no-event floor as an
        # absolute tolerance instead of skipping the year outright, so a year with
        # genuinely missing events (observed spread with nothing to explain it)
        # still gets caught.
        threshold = max(YEARLY_TOLERANCE_FRACTION * abs(e), NO_EVENT_FLOOR_BP)
        if abs(o - e) > threshold:
            for day in sessions[sessions.year == year]:
                tags.setdefault(day, []).append("year-imbalance")
                verdict.loc[day] = "flag"

    out = pd.DataFrame(
        {
            "date": sessions,
            "observed_spread_bp": observed.reindex(sessions).to_numpy(),
            "expected_spread_bp": expected.reindex(sessions).to_numpy(),
            "verdict": verdict.reindex(sessions).to_numpy(),
            "tag": [",".join(tags.get(d, [])) for d in sessions],
        }
    )
    return out[_DAY_COLUMNS]


# --------------------------------------------------------------------------
# 4.3 -- Yahoo adjclose cross-check (deferrable)
# --------------------------------------------------------------------------


def yahoo_adjclose_check(
    daily: pd.DataFrame, membership: pd.DataFrame, yahoo_exceptions: pd.DataFrame
) -> pd.DataFrame:
    """Plan.md §4.3: weekly residual between our reconstructed total-return series
    and Yahoo Finance's `adjclose`, current members only (Yahoo has no delisted
    tickers, so this check is not independent of survivorship and is flag-only).

    Rows already covered by curated/yahoo_exceptions.csv are marked reviewed rather
    than re-flagged. Returns one row per (company_id, week) with the residual and a
    pass/flag verdict.

    Network access to Yahoo is best-effort and never fatal: a symbol that errors
    (blocked, rate-limited, delisted on Yahoo, ...) is skipped with a `skip_reason`
    row rather than raising, per the T7 brief ("never let it fail the run"). A
    completely unreachable Yahoo (all symbols skipped) still returns a DataFrame,
    just with every row a skip -- callers should check `verdict.eq("skip").all()`
    to detect that case, e.g. to log "Yahoo check deferred: no reachable symbols".
    """
    from momentum_backtesting.sources import yahoo_daily

    exceptions = {
        (str(r.company_id), str(r.symbol)) for r in yahoo_exceptions.itertuples(index=False)
    }

    today = pd.Timestamp.today().normalize()
    current = membership[
        (pd.to_datetime(membership["to"].replace("", pd.NaT)).isna())
        | (pd.to_datetime(membership["to"].replace("", pd.NaT)) >= today)
    ]

    d = daily[["date", "symbol", "close"]].copy()
    d["date"] = pd.to_datetime(d["date"])

    rows: list[dict] = []
    for member in current.itertuples(index=False):
        company_id, symbol = str(member.company_id), str(member.symbol)
        ours = d[d["symbol"] == symbol].set_index("date")["close"].sort_index()
        if ours.empty:
            continue
        ours_weekly = ours.resample("W-FRI").last().dropna()
        try:
            yahoo_close = yahoo_daily(f"{symbol}.NS", ours_weekly.index.min().date())
        except Exception as exc:  # noqa: BLE001 - Yahoo is best-effort, never fatal
            rows.append(
                {
                    "company_id": company_id,
                    "symbol": symbol,
                    "week": pd.NaT,
                    "residual_bp": np.nan,
                    "verdict": "skip",
                    "skip_reason": str(exc),
                }
            )
            continue
        yahoo_weekly = yahoo_close.resample("W-FRI").last().dropna()
        aligned = pd.concat(
            [ours_weekly.pct_change(), yahoo_weekly.reindex(ours_weekly.index).pct_change()],
            axis=1,
            keys=["ours", "yahoo"],
        ).dropna()
        reviewed = (company_id, symbol) in exceptions
        for week, r in aligned.iterrows():
            residual_bp = float((r["ours"] - r["yahoo"]) * 1e4)
            verdict = "reviewed" if reviewed else ("flag" if abs(residual_bp) > 50.0 else "pass")
            rows.append(
                {
                    "company_id": company_id,
                    "symbol": symbol,
                    "week": week,
                    "residual_bp": residual_bp,
                    "verdict": verdict,
                    "skip_reason": None,
                }
            )

    return pd.DataFrame(
        rows, columns=["company_id", "symbol", "week", "residual_bp", "verdict", "skip_reason"]
    )
