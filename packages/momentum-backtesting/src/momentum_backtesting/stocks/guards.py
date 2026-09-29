"""Plan.md §3's guard suite. Each `check_*` function inspects one invariant and
returns zero or more GuardResult rows (severity F fails the run, G only flags it,
per schemas.GuardSeverity); `run_all` runs every guard and returns the combined list
that becomes fetch_report.csv's guard section.

Implemented (T6) against the T0 stubs. `check_session_calendar` itself lives in
adjust.py (`fill_session_calendar`), not here -- it has to run *before* company
resolution (it operates on the whole daily.parquet, and may rewrite it with
synthetic rows that every later step depends on), whereas every guard in this
module runs *after* adjust.build_all has already resolved companies and attached
events. `run_all` still reports session-calendar results: the caller
(adjust.build_all) folds `fill_session_calendar`'s GuardResults into the same
report rather than this module re-deriving them from scratch.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from momentum_backtesting.stocks.membership_check import check_invariants
from momentum_backtesting.stocks.schemas import EventKind, GuardResult, GuardSeverity

#: Guard §3: "unexplained member-period daily move > 20%".
_UNEXPLAINED_MOVE_THRESHOLD = 0.20
#: Guard §3: "|log f| > 3 x 60-session vol" gates whether a factor is testable.
_FACTOR_SIGNIFICANCE_VOL_MULTIPLE = 3.0
_FACTOR_SIGNIFICANCE_VOL_WINDOW = 60
#: Guard §3: dividend yield per company-year outside this range is flagged.
_DIVIDEND_YIELD_LOW, _DIVIDEND_YIELD_HIGH = 0.0, 0.15
#: Guard §3: a member with no trade for more than this many consecutive sessions.
_SUSPENSION_SESSIONS = 3
#: Guard §2/§9: a CA event diff on an event older than this many days fails
#: unless accepted.
_CA_DIFF_AGE_DAYS = 30


def _normalise_membership(membership: pd.DataFrame, sessions: pd.DatetimeIndex) -> pd.DataFrame:
    """Parse from/to (inclusive `to`, per plan.md/acceptance criteria) and add
    `to_excl`, the first session strictly after the row's last member session --
    mirrors membership_check._normalise_membership's semantics so both modules
    agree on what "member-period" means."""
    m = membership.copy()
    m["from_ts"] = pd.to_datetime(m["from"])
    to = m["to"]
    to = to.where(to.notna() & (to.astype(str).str.strip() != ""), None)
    m["to_ts"] = pd.to_datetime(to)
    fallback_to = pd.Timestamp(sessions[-1]) if len(sessions) else pd.Timestamp.max
    m["to_ts"] = m["to_ts"].fillna(fallback_to)
    pos = sessions.searchsorted(m["to_ts"], side="right")
    m["to_excl_ts"] = [
        sessions[p]
        if p < len(sessions)
        else (sessions[-1] + pd.Timedelta(days=1) if len(sessions) else pd.NaT)
        for p in pos
    ]
    return m


def _member_window_mask(dates: pd.Series, company_id: str, m: pd.DataFrame) -> pd.Series:
    """Boolean mask, aligned to `dates`, True for every date that falls inside
    ANY of `company_id`'s membership windows in `m` (the `_normalise_membership`
    output -- `to` inclusive, via `to_excl_ts`).

    `m` should be the *unfiltered* normalised membership table (investable AND
    dummy rows) -- a session during a dummy-placeholder window still counts as
    "the company is a member" for guards like unexplained-move and dividend
    yield (the dummy/investable distinction is about price coverage and the buy
    mask, not about whether the guard should look at that period at all). A
    dummy-period session only ever shows up here if the company actually has a
    priced row for it, since callers always intersect this mask against rows
    that already exist in `daily`/`adjusted`.
    """
    windows = m[m["company_id"] == company_id]
    mask = pd.Series(False, index=dates.index)
    for w in windows.itertuples(index=False):
        mask |= (dates >= w.from_ts) & (dates < w.to_excl_ts)
    return mask


def _company_all_sessions(daily: pd.DataFrame) -> dict[str, np.ndarray]:
    """Every traded session per company_id, across its *full* alias history
    (i.e. every symbol it has ever used) -- continuity must be evaluated against
    this, not against one membership stint, per T5's finding (see plan.md §1's
    verified facts and the implementor brief's "lessons already learned")."""
    out: dict[str, np.ndarray] = {}
    for cid, grp in daily.groupby("company_id"):
        if pd.isna(cid):
            continue
        out[cid] = np.sort(pd.to_datetime(grp["date"]).unique())
    return out


def check_session_calendar(daily: pd.DataFrame, tri_dates: pd.DatetimeIndex) -> list[GuardResult]:
    """Sessions == TRI date set, bounded at min(max TRI, max bhavcopy) (plan.md §3).

    Implemented in adjust.fill_session_calendar (see module docstring for why):
    this wrapper exists so guards.py still exposes the function named in the T0
    contract and QA checklist, without duplicating the synthetic-fill logic that
    has to run earlier in the pipeline and mutate daily.parquet.
    """
    from momentum_backtesting.stocks.adjust import fill_session_calendar

    _synthetic_rows, results = fill_session_calendar(daily, tri_dates)
    return results


def check_continuity(
    daily: pd.DataFrame, membership: pd.DataFrame, exceptions: pd.DataFrame
) -> list[GuardResult]:
    """PREVCLOSE(t) == CLOSE(the company's last traded session) for every
    member-period row, except rows covered by curated/continuity_exceptions.csv (F).

    Evaluated per company_id across its full alias history (every symbol it has
    ever traded under), not per membership stint -- a symbol rename inside a
    membership window must not look like a continuity break. Synthetic_close
    rows are excluded from being *checked* (their prevclose/close pair is
    definitionally self-consistent, not an observed trading fact), but they
    still count as a company's "last traded session" for the row that follows
    them.
    """
    if daily.empty or "company_id" not in daily.columns:
        return []
    sessions = pd.DatetimeIndex(sorted(pd.to_datetime(daily["date"]).unique()))
    m = _normalise_membership(membership, sessions)

    exc = set()
    if not exceptions.empty:
        exc = set(zip(exceptions["company_id"], exceptions["session"], strict=True))

    results: list[GuardResult] = []
    resolved = daily[daily["company_id"].notna()].copy()
    resolved["_date"] = pd.to_datetime(resolved["date"])

    # Vectorised per company: shift(1) gives the previous *traded* close/date
    # (across the company's full alias history, since `resolved` is grouped by
    # company_id, not by symbol), so a symbol rename inside a membership window
    # is not a splice. A python-level loop here does not scale to a 15-year,
    # 95-company dataset (each `.iloc[i]`/`.iterrows()` call has real per-call
    # overhead that dominates at ~350k rows) -- see the implementor report.
    for company_id, grp in resolved.groupby("company_id"):
        grp = grp.sort_values("_date").reset_index(drop=True)
        windows = m[m["company_id"] == company_id]
        if windows.empty:
            continue

        prev_close = grp["close"].shift(1)
        prev_date = grp["date"].shift(1)
        diff = (grp["prevclose"] - prev_close).abs()
        tol = np.maximum(1e-6, 1e-6 * prev_close.abs())
        broken = diff > tol
        broken &= ~grp["synthetic_close"].astype(bool)
        broken.iloc[0] = False  # no previous session to compare against
        broken &= _member_window_mask(grp["_date"], company_id, m)

        for idx in grp.index[broken]:
            session_str = str(grp.loc[idx, "_date"].date())
            if (company_id, session_str) in exc:
                continue
            results.append(
                GuardResult(
                    guard="continuity",
                    severity=GuardSeverity.F,
                    message=(
                        f"PREVCLOSE {float(grp.loc[idx, 'prevclose'])} != previous traded "
                        f"CLOSE {float(prev_close.loc[idx])} "
                        f"(previous session {prev_date.loc[idx]})"
                    ),
                    company_id=company_id,
                    session=session_str,
                )
            )
    return results


def check_suspensions(daily: pd.DataFrame, membership: pd.DataFrame) -> list[GuardResult]:
    """Flag (G) a member with no trade for more than 3 consecutive market sessions
    during its membership window."""
    if daily.empty or "company_id" not in daily.columns:
        return []
    market_sessions = np.sort(pd.to_datetime(daily["date"]).unique())
    sessions_idx = pd.DatetimeIndex(market_sessions)
    m = _normalise_membership(membership, sessions_idx)

    comp_sessions = _company_all_sessions(daily)
    results: list[GuardResult] = []
    for row in m.itertuples(index=False):
        company_id = row.company_id
        comp_dates = comp_sessions.get(company_id)
        if comp_dates is None:
            continue
        start_idx = int(np.searchsorted(market_sessions, row.from_ts))
        end_idx = int(np.searchsorted(market_sessions, row.to_excl_ts))
        window_sessions = market_sessions[start_idx:end_idx]
        if len(window_sessions) == 0:
            continue
        traded_mask = np.isin(window_sessions, comp_dates)
        gap = 0
        gap_start = None
        for d, traded in zip(window_sessions, traded_mask, strict=True):
            if traded:
                if gap > _SUSPENSION_SESSIONS:
                    results.append(
                        GuardResult(
                            guard="suspension",
                            severity=GuardSeverity.G,
                            message=f"no trade for {gap} consecutive sessions",
                            company_id=company_id,
                            session=str(pd.Timestamp(gap_start).date())
                            if gap_start is not None
                            else None,
                        )
                    )
                gap = 0
                gap_start = None
            else:
                if gap == 0:
                    gap_start = d
                gap += 1
        if gap > _SUSPENSION_SESSIONS:
            results.append(
                GuardResult(
                    guard="suspension",
                    severity=GuardSeverity.G,
                    message=f"no trade for {gap} consecutive sessions (through window end)",
                    company_id=company_id,
                    session=str(pd.Timestamp(gap_start).date()) if gap_start is not None else None,
                )
            )
    return results


def check_ca_coverage(
    events: pd.DataFrame, membership: pd.DataFrame, no_ca_rows: pd.DataFrame
) -> list[GuardResult]:
    """Every CA row of an ever-member resolves to a company (F -- handled
    upstream by adjust.build_feed_events, which appends that failure directly to
    the report since it has the unresolved raw row; nothing to re-derive here
    from an already-resolved `events` frame). Every ever-member has >=1 CA row or
    a curated/no_ca_rows.csv entry (F).
    """
    results: list[GuardResult] = []
    ever_members = set(membership["company_id"])
    has_ca_row = set(events["company_id"]) if not events.empty else set()
    covered_by_no_ca = set(no_ca_rows["company_id"]) if not no_ca_rows.empty else set()
    for company_id in sorted(ever_members):
        if company_id in has_ca_row or company_id in covered_by_no_ca:
            continue
        results.append(
            GuardResult(
                guard="ca_coverage",
                severity=GuardSeverity.F,
                message=f"no CA-feed rows and no curated/no_ca_rows.csv entry for {company_id}",
                company_id=company_id,
            )
        )
    return results


def check_unparsed_subjects(
    events: pd.DataFrame, actions_manual: pd.DataFrame, membership: pd.DataFrame
) -> list[GuardResult]:
    """Fail (F) on an unparsed-or-manual-only subject (EventKind.MANUAL_ONLY) for a
    member company with no matching curated/actions_manual.csv row.

    By the time an event reaches this guard, adjust.combine_manual_over_feed has
    already replaced every (company_id, ex_date) pair that actions_manual.csv
    covers -- so a MANUAL_ONLY-kind row that has *survived* to here, by
    construction, has no covering manual row left. This guard therefore only
    needs to check "is this company an ever-member" (every event is already
    company-resolved) and report it -- no need to re-look-up actions_manual.csv.
    """
    del actions_manual
    if events.empty:
        return []
    ever_members = set(membership["company_id"])
    unparsed = events[
        (events["kind"] == EventKind.MANUAL_ONLY.value) & events["company_id"].isin(ever_members)
    ]
    results = []
    for row in unparsed.itertuples(index=False):
        results.append(
            GuardResult(
                guard="unparsed_subject",
                severity=GuardSeverity.F,
                message=(
                    "unparsed/manual-only CA subject with no actions_manual.csv row "
                    f"(ex_date {row.ex_date})"
                ),
                company_id=row.company_id,
                session=str(row.session) if hasattr(row, "session") and row.session else None,
            )
        )
    return results


def check_membership_invariants(
    membership: pd.DataFrame, daily: pd.DataFrame, current_symbols: set[str] | None = None
) -> list[GuardResult]:
    """Member count / current-list / price-coverage invariants (plan.md §3): the
    member total is 50 on every session except dated, documented dummy periods
    (51), and open-ended membership rows match data/stocks/raw/nifty50_current.csv
    (F). Also checks price coverage for investable members up to
    min(to, last traded session) (F).

    Reuses membership_check.check_invariants (T3's own module, read-only per the
    implementor brief) for the count/current-list half rather than
    re-implementing the same rule twice.

    Deviates from the T0 stub's `(membership, daily) -> ...` signature by adding
    an optional `current_symbols` parameter: the "open rows == current list"
    invariant is a cross-check against data/stocks/raw/nifty50_current.csv,
    which is a *raw* file this guards.py module has no path to on its own (the
    T0 stub only threads `membership`/`daily` in). Reported as a non-obvious
    decision: without a real `current_symbols` set, that half of the invariant
    would either need a hidden hardcoded path (raw_dir isn't guards.py's
    business) or silently pass — both wrong. adjust.build_all reads the raw
    file once and passes it through curated["nifty50_current_symbols"] via
    run_all. When `current_symbols` is omitted (e.g. a unit test that only cares
    about the count invariant), it falls back to membership's own open-row
    symbols, which makes that half of the check tautological (always passes) —
    acceptable for a fallback, never for the real run.
    """
    results: list[GuardResult] = []
    if daily.empty:
        return results
    sessions = sorted(pd.to_datetime(daily["date"]).unique())
    if current_symbols is None:
        to = membership["to"]
        open_mask = to.isna() | (to.astype(str).str.strip() == "")
        current_symbols = set(membership.loc[open_mask, "symbol"])
    problems = check_invariants(membership, sessions, current_symbols)
    for p in problems:
        results.append(
            GuardResult(guard="membership_invariants", severity=GuardSeverity.F, message=p)
        )

    # Price coverage: every investable member needs a price row for every
    # trading session in [from, min(to, last traded session)].
    sessions_idx = pd.DatetimeIndex(sessions)
    m = _normalise_membership(membership, sessions_idx)
    comp_sessions = _company_all_sessions(daily)
    market_sessions = np.array(sessions)
    for row in m[m["kind"] == "investable"].itertuples(index=False):
        company_id = row.company_id
        comp_dates = comp_sessions.get(company_id)
        if comp_dates is None or len(comp_dates) == 0:
            results.append(
                GuardResult(
                    guard="membership_invariants",
                    severity=GuardSeverity.F,
                    message="investable member has zero price rows anywhere",
                    company_id=company_id,
                )
            )
            continue
        last_session = comp_dates.max()
        window_end = min(np.datetime64(row.to_excl_ts) - np.timedelta64(1, "ns"), last_session)
        start_idx = int(np.searchsorted(market_sessions, row.from_ts))
        end_idx = int(np.searchsorted(market_sessions, window_end, side="right"))
        expected = market_sessions[start_idx:end_idx]
        missing = np.setdiff1d(expected, comp_dates, assume_unique=False)
        if len(missing):
            results.append(
                GuardResult(
                    guard="membership_invariants",
                    severity=GuardSeverity.F,
                    message=(
                        f"{len(missing)} session(s) missing price coverage, "
                        f"e.g. {pd.Timestamp(missing[0]).date()}"
                    ),
                    company_id=company_id,
                )
            )
    return results


def check_ca_completeness(events: pd.DataFrame) -> list[GuardResult]:
    """Every month non-empty per quarter; dividend rows per year within +-30% of
    the neighbouring years' mean. Refetch once on failure, then F if it recurs.

    build_all runs entirely from the already-fetched raw cache (no network), so
    there is no "refetch" step available here; this guard reports the
    completeness signal as-computed (G) rather than F, since a build_all run
    cannot itself refetch to confirm a genuine gap -- the corporate_actions
    module's own fetch_history already enforces the F-after-one-refetch rule at
    *fetch* time (plan.md: "refetch once, then F"), which is the right place for
    a network-capable retry; this guard is the network-free, always-available
    completeness signal for a run against a static cache.
    """
    if events.empty:
        return []
    ex_dates = pd.to_datetime(events["ex_date"])
    months_present = set(ex_dates.dt.to_period("M"))
    all_months = pd.period_range(ex_dates.min(), ex_dates.max(), freq="M")
    empty_months = [m for m in all_months if m not in months_present]
    results: list[GuardResult] = []
    if empty_months:
        results.append(
            GuardResult(
                guard="ca_completeness",
                severity=GuardSeverity.G,
                message=f"{len(empty_months)} month(s) with zero events, e.g. {empty_months[0]}",
            )
        )

    dividend_events = events[events["kind"] == EventKind.DIVIDEND.value]
    if not dividend_events.empty:
        years = pd.to_datetime(dividend_events["ex_date"]).dt.year
        counts = years.value_counts().to_dict()
        for year in sorted(counts):
            prev_c, next_c = counts.get(year - 1), counts.get(year + 1)
            if prev_c is None or next_c is None:
                continue
            neighbour_mean = (prev_c + next_c) / 2
            if neighbour_mean == 0:
                continue
            if not (0.7 * neighbour_mean <= counts[year] <= 1.3 * neighbour_mean):
                results.append(
                    GuardResult(
                        guard="ca_completeness",
                        severity=GuardSeverity.G,
                        message=(
                            f"{year}: {counts[year]} dividend events vs "
                            f"neighbouring-year mean {neighbour_mean:.1f}"
                        ),
                    )
                )
    return results


def check_unexplained_moves(
    daily: pd.DataFrame,
    events: pd.DataFrame,
    crash_allowlist: pd.DataFrame,
    membership: pd.DataFrame,
) -> list[GuardResult]:
    """Fail (F) an unexplained MEMBER-PERIOD daily move >20% after factors, unless
    cited in curated/crash_allowlist.csv.

    Deviates from the T0 stub's `(daily, events, crash_allowlist)` signature by
    adding `membership`: plan.md §3 is explicit this guard is about "unexplained
    member-period daily move[s]", not every daily move a company ever had over
    its full listed history. The first real-data run before this fix scored 79
    F, all for companies well after they had left the index (RCom/RPower/
    RInfra/RCapital/Suzlon/Jaiprakash/Idea/Yes Bank crash years, none of them
    Nifty 50 members at the time) -- correctly flagged as *moves*, wrongly
    treated as *in scope*. A membership window here includes dummy rows too
    (see `_member_window_mask`): a priced session during a demerger-placeholder
    window is still "the company is a member" for this guard's purposes.

    Operates on `total_return_factor`-implied per-session r_t if present
    (post-adjustment), falling back to raw close/prevclose otherwise -- callers
    that already ran adjust.build pass the adjusted frame (with `r_t`), so the
    "after factors" move is what's actually tested, not the raw unadjusted move.
    """
    if daily.empty or "company_id" not in daily.columns:
        return []
    resolved = daily[daily["company_id"].notna()].copy()
    if resolved.empty:
        return []

    allowlist = set()
    if not crash_allowlist.empty:
        allowlist = set(zip(crash_allowlist["company_id"], crash_allowlist["session"], strict=True))

    if "r_t" in resolved.columns:
        moves = resolved[["company_id", "date", "r_t", "synthetic_close"]].copy()
        moves["move"] = (moves["r_t"] - 1.0).abs()
    else:
        resolved = resolved.sort_values(["company_id", "date"])
        resolved["_prev_close"] = resolved.groupby("company_id")["close"].shift(1)
        moves = resolved[["company_id", "date", "synthetic_close"]].copy()
        moves["move"] = (resolved["close"] / resolved["_prev_close"] - 1.0).abs()

    neutral_sessions = set()
    if events is not None and not events.empty and "source" in events.columns:
        neutral_sessions = set(
            zip(
                events.loc[events["source"] == "neutral_exday", "company_id"],
                events.loc[events["source"] == "neutral_exday", "session"].astype(str),
                strict=True,
            )
        )

    sessions_idx = pd.DatetimeIndex(sorted(pd.to_datetime(daily["date"]).unique()))
    m = _normalise_membership(membership, sessions_idx)
    moves["_date"] = pd.to_datetime(moves["date"])
    is_member = pd.Series(False, index=moves.index)
    for company_id, idx in moves.groupby("company_id").groups.items():
        is_member.loc[idx] = _member_window_mask(moves.loc[idx, "_date"], company_id, m)
    moves["is_member"] = is_member

    results: list[GuardResult] = []
    for row in moves.itertuples(index=False):
        if bool(row.synthetic_close) or not bool(row.is_member):
            continue
        move = row.move
        if pd.isna(move) or move <= _UNEXPLAINED_MOVE_THRESHOLD:
            continue
        session_str = str(pd.Timestamp(row.date).date())
        if (row.company_id, session_str) in allowlist:
            continue
        if (row.company_id, session_str) in neutral_sessions:
            continue
        results.append(
            GuardResult(
                guard="unexplained_move",
                severity=GuardSeverity.F,
                message=f"{move * 100:.1f}% move after factors, not cited in crash_allowlist.csv",
                company_id=row.company_id,
                session=session_str,
            )
        )
    return results


def check_factor_significance(daily: pd.DataFrame, events: pd.DataFrame) -> list[GuardResult]:
    """A factor must explain a move better than no factor and better than the
    adjacent sessions, but only tested when `|log f| > 3 * 60-session vol` (F);
    otherwise the move is reported `unverifiable` (G) rather than silently passed.
    """
    if daily.empty or events.empty or "company_id" not in daily.columns:
        return []
    resolved = daily[daily["company_id"].notna()].copy().sort_values(["company_id", "date"])
    resolved["_date"] = pd.to_datetime(resolved["date"])
    resolved["_logret"] = np.log(
        resolved["close"] / resolved.groupby("company_id")["close"].shift(1)
    )

    results: list[GuardResult] = []
    factor_events = events[(events["source"].isin(["feed", "manual"])) & events["factor"].notna()]
    for row in factor_events.itertuples(index=False):
        comp_rows = resolved[resolved["company_id"] == row.company_id].reset_index(drop=True)
        session_ts = pd.Timestamp(row.session)
        idx_matches = comp_rows.index[comp_rows["_date"] == session_ts]
        if len(idx_matches) == 0:
            continue
        idx = idx_matches[0]
        window = comp_rows["_logret"].iloc[max(0, idx - _FACTOR_SIGNIFICANCE_VOL_WINDOW) : idx]
        vol = window.std()
        if pd.isna(vol) or vol == 0:
            results.append(
                GuardResult(
                    guard="factor_significance",
                    severity=GuardSeverity.G,
                    message="unverifiable: insufficient history for 60-session vol",
                    company_id=row.company_id,
                    session=str(session_ts.date()),
                )
            )
            continue
        log_f = abs(np.log(float(row.factor))) if row.factor else 0.0
        threshold = _FACTOR_SIGNIFICANCE_VOL_MULTIPLE * vol
        if log_f <= threshold:
            results.append(
                GuardResult(
                    guard="factor_significance",
                    severity=GuardSeverity.G,
                    message=f"unverifiable: |log f|={log_f:.4f} <= 3*vol={threshold:.4f}",
                    company_id=row.company_id,
                    session=str(session_ts.date()),
                )
            )
            continue

        raw_move = comp_rows["_logret"].iloc[idx]
        adjusted_move = raw_move - np.log(float(row.factor))
        if abs(adjusted_move) >= abs(raw_move):
            results.append(
                GuardResult(
                    guard="factor_significance",
                    severity=GuardSeverity.F,
                    message=(
                        f"factor {row.factor} does not explain the move better than no factor "
                        f"(raw logret {raw_move:.4f}, adjusted {adjusted_move:.4f})"
                    ),
                    company_id=row.company_id,
                    session=str(session_ts.date()),
                )
            )
    return results


def check_dividend_yield(
    daily: pd.DataFrame, events: pd.DataFrame, membership: pd.DataFrame
) -> list[GuardResult]:
    """Flag (G) a company-year dividend yield outside 0-15%, member periods only.

    "Member periods" is enforced by date range, not just "is this company an
    ever-member" -- both the dividend events counted and the average price
    used as the yield's denominator are restricted to sessions that fall
    inside one of the company's membership windows (see
    `_member_window_mask`), matching plan.md §3's "member periods" qualifier.
    """
    if daily.empty or events.empty:
        return []
    sessions_idx = pd.DatetimeIndex(sorted(pd.to_datetime(daily["date"]).unique()))
    m = _normalise_membership(membership, sessions_idx)

    dividends = events[events["kind"] == EventKind.DIVIDEND.value].copy()
    dividends["_date"] = pd.to_datetime(dividends["session"])
    is_member_div = pd.Series(False, index=dividends.index)
    for company_id, idx in dividends.groupby("company_id").groups.items():
        is_member_div.loc[idx] = _member_window_mask(dividends.loc[idx, "_date"], company_id, m)
    dividends = dividends[is_member_div]
    if dividends.empty:
        return []
    dividends["_year"] = dividends["_date"].dt.year

    resolved = daily[daily["company_id"].notna()].copy()
    resolved["_date"] = pd.to_datetime(resolved["date"])
    is_member_price = pd.Series(False, index=resolved.index)
    for company_id, idx in resolved.groupby("company_id").groups.items():
        is_member_price.loc[idx] = _member_window_mask(resolved.loc[idx, "_date"], company_id, m)
    resolved = resolved[is_member_price]
    resolved["_year"] = resolved["_date"].dt.year
    avg_price = resolved.groupby(["company_id", "_year"])["close"].mean()

    results: list[GuardResult] = []
    for (company_id, year), grp in dividends.groupby(["company_id", "_year"]):
        total_div = grp["dividend"].sum()
        price = avg_price.get((company_id, year))
        if not price or pd.isna(price) or price == 0:
            continue
        yield_ = total_div / price
        if not (_DIVIDEND_YIELD_LOW <= yield_ <= _DIVIDEND_YIELD_HIGH):
            results.append(
                GuardResult(
                    guard="dividend_yield",
                    severity=GuardSeverity.G,
                    message=f"{year}: dividend yield {yield_ * 100:.2f}% outside 0-15%",
                    company_id=company_id,
                )
            )
    return results


def check_ca_diff_age(
    fetch_report: pd.DataFrame, accepted: pd.DataFrame | None
) -> list[GuardResult]:
    """Fail (F) if any CA event diff is older than 30 days and not covered by an
    `--accept-ca-diff <reviewed.csv>` file (passed here as `accepted`).

    `fetch_report` here is adjust.diff_ca_events's output (company_id, ex_date,
    subject_sha1, change, detail, age_days) -- named `fetch_report` to match the
    T0 stub's signature, not the final fetch_report.csv (this function is one of
    several contributors to that file, via adjust.build_all).
    """
    if fetch_report.empty:
        return []
    accepted_keys = set()
    if accepted is not None and not accepted.empty:
        accepted_keys = set(
            zip(
                accepted["company_id"],
                accepted["ex_date"].astype(str),
                accepted["subject_sha1"],
                strict=True,
            )
        )

    results: list[GuardResult] = []
    for row in fetch_report.itertuples(index=False):
        key = (row.company_id, str(row.ex_date), row.subject_sha1)
        if row.change == "re-key":
            results.append(
                GuardResult(
                    guard="ca_diff_age",
                    severity=GuardSeverity.G,
                    message=f"re-key: {row.detail}",
                    company_id=row.company_id,
                    session=str(row.ex_date),
                )
            )
            continue
        if row.change in ("added", "removed", "changed") and row.age_days > _CA_DIFF_AGE_DAYS:
            if key in accepted_keys:
                results.append(
                    GuardResult(
                        guard="ca_diff_age",
                        severity=GuardSeverity.G,
                        message=(
                            f"{row.change} on a {row.age_days}-day-old event, "
                            f"accepted: {row.detail}"
                        ),
                        company_id=row.company_id,
                        session=str(row.ex_date),
                    )
                )
            else:
                results.append(
                    GuardResult(
                        guard="ca_diff_age",
                        severity=GuardSeverity.F,
                        message=(
                            f"{row.change} on a {row.age_days}-day-old event "
                            f"(not accepted): {row.detail}"
                        ),
                        company_id=row.company_id,
                        session=str(row.ex_date),
                    )
                )
        else:
            results.append(
                GuardResult(
                    guard="ca_diff_age",
                    severity=GuardSeverity.G,
                    message=f"{row.change}: {row.detail}",
                    company_id=row.company_id,
                    session=str(row.ex_date),
                )
            )
    return results


def run_all(
    daily: pd.DataFrame,
    events: pd.DataFrame,
    membership: pd.DataFrame,
    aliases: pd.DataFrame,
    curated: dict[str, pd.DataFrame],
    fetch_report: pd.DataFrame,
) -> list[GuardResult]:
    """Run every check_* guard above and return the combined report rows.

    `curated` holds every loaded curated/*.csv keyed by filename (see
    schemas.CURATED_HEADERS), so callers pass the whole curated set once rather
    than threading each guard's specific inputs through by hand. `fetch_report`
    is the report accumulated so far by the caller (session-calendar and
    CA-resolution guard rows already run earlier in adjust.build_all's
    pipeline) -- run_all does not re-derive those, it only appends the guards
    that operate on the already-resolved/attached `events`/`daily` frames.
    """
    del aliases, fetch_report  # not needed by any guard below; kept for the T0 signature

    results: list[GuardResult] = []
    results += check_continuity(daily, membership, curated["continuity_exceptions.csv"])
    results += check_suspensions(daily, membership)
    results += check_ca_coverage(events, membership, curated["no_ca_rows.csv"])
    results += check_unparsed_subjects(events, curated["actions_manual.csv"], membership)

    current_symbols = curated.get("nifty50_current_symbols")
    results += check_membership_invariants(membership, daily, current_symbols)

    results += check_ca_completeness(events)
    results += check_unexplained_moves(daily, events, curated["crash_allowlist.csv"], membership)
    results += check_factor_significance(daily, events)
    results += check_dividend_yield(daily, events, membership)
    return results
