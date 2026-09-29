"""T3's membership check (plan.md §4.2): rebuild the NIFTY50 Equal Weight *price*
index from raw member prices and compare it with the published index, day by day.

Status: a WARNING, not a pass/fail gate (user decision, 2026-09-28) — the residual
statistics are reported and used to catch wrong effective dates, but nothing fails
on the 5 bp / 95% figure. The hard requirements are the membership invariants in
`check_invariants` (50 members per session, 51 inside dated dummy periods, open rows
== the current constituent list).

Why this works as a membership check: the EW price index is, by construction, the
equal-weighted basket of exactly the Nifty 50 members, reset to equal weights on
known dates and left to drift in between. If `curated/nifty50_membership.csv` has a
wrong member, or a right member with a wrong effective date, the rebuilt daily return
misses the published one by roughly (2% weight) x (that stock's return gap) — several
basis points on a typical day. With the right membership the residual is a rounding
error (~0.01 bp). A wrong effective date therefore shows up as a burst of residuals
starting on that date.

Inputs are deliberately raw (plan.md §4.2): `daily.parquet` rows (close/prevclose),
the curated membership, and the EW price index. Nothing here depends on adjust.py
(T6); T7 re-runs this module as part of its wider validation.

Index mechanics — NSE Indices, "NIFTY50 Equal Weight Index – Methodology Document"
(August 2019), https://www.niftyindices.com/methodology/nifty50_equal_weight_methodology.pdf :
  - same companies as NIFTY 50, "equal weight ... at the time of review";
  - weights are reset to equal "on a quarterly basis and implemented from the first
    working day after F&O expiry of March, June, September and December", "considering
    the closing prices of the index constituents 5 working days prior to the effective
    date";
  - "ad-hoc rebalancing and reconstitution" when a constituent leaves NIFTY 50;
  - splits/bonuses do not move the index (price and shares both adjusted); rights and
    special dividends are price-adjusted with a divisor change;
  - in a spin-off the new security is carried in the index until it is replaced.

The document describes one timing rule; the published index itself shows the timing
changed over the years. `rebalance_schedule` encodes three eras, each calibrated on
the published index (see `_lag_sessions` / `quarterly_effective_date`) — the 2018-2020
era is exactly the documented "first working day after F&O expiry, prices 5 working
days prior" rule.

Corporate-action days: close/prevclose is not a clean return on the ex-date of a
split, bonus, rights issue, demerger or special dividend (bhavcopy PREVCLOSE is never
adjusted — plan.md §1). Such member-days are passed in as `event_days`; the check
does not score them (they are "excluded"), and to keep the weights right afterwards
it solves that member's return from the published index return (exact when a day has
one such member; a shared value otherwise, flagged in `reason`).
"""

from __future__ import annotations

import itertools
from collections.abc import Iterable
from datetime import date

import numpy as np
import pandas as pd

from .schemas import MembershipKind

#: Launch date of the NIFTY50 Equal Weight index ("Launch Date April 13, 2017", base
#: date November 03, 1995 — https://www.niftyindices.com/Factsheet/Factsheet_NIFTY50_Equal_Weight.pdf).
#: Earlier values are NSE back-calculations, not observed levels; `run` flags them in
#: `back_calculated` so the report can show them separately.
EW_LAUNCH_DATE = date(2017, 4, 13)

#: Residual target from plan.md §4.2.
TARGET_BP = 5.0
TARGET_SHARE = 0.95

#: Dividend yield (dividend / prevclose) at or above which a member's ex-date is
#: treated as an event day. The index price-adjusts "special" dividends; the
#: threshold has varied (the 2019 document says 5% of price, while the published
#: index shows ~2% dividends being adjusted in 2025-26), so rather than guess each
#: era's rule the check does not score any member day with a dividend of 1% or more.
DIVIDEND_EVENT_YIELD = 0.01

_REBALANCE_MONTHS = (3, 6, 9, 12)

#: Scheduled quarterly resets the published index shows it did NOT make (the
#: residual is flat without them and jumps with them). 2012-03-30: the March 2012
#: review was implemented with the constituent change on 2012-04-27 instead.
CALIBRATED_SKIPS = ("2012-03-30", "2017-07-03", "2020-03-27")

#: Resets whose "equal" prices were taken on a different session than the era's
#: lag rule gives (effective date -> price date), again read off the index.
CALIBRATED_PRICE_DATES = {"2014-09-26": "2014-09-18"}

#: Columns of the `event_days` frame `run` accepts.
EVENT_COLUMNS = ("company_id", "session", "kind", "factor", "dividend_yield")

#: A dividend at or above this yield is assumed price-adjusted when the day's
#: return cannot tell (a day that also has an "other" event): the methodology
#: document's "special dividend" threshold, "more than 5% of close price".
SPECIAL_DIVIDEND_YIELD = 0.05


# --------------------------------------------------------------------------
# Rebalance schedule
# --------------------------------------------------------------------------


def _fo_expiry(sessions: pd.DatetimeIndex, year: int, month: int) -> pd.Timestamp | None:
    """Monthly F&O expiry used by the pre-2021 timing rule: the month's last Thursday,
    or the previous trading session when that Thursday is a holiday."""
    last_day = pd.Timestamp(year, month, 1) + pd.offsets.MonthEnd(0)
    thursday = last_day - pd.Timedelta(days=(last_day.weekday() - 3) % 7)
    pos = sessions.searchsorted(thursday, side="right") - 1
    if pos < 0:
        return None
    candidate = sessions[pos]
    if candidate.year != year or candidate.month != month:
        return None
    return candidate


def _lag_sessions(effective: pd.Timestamp) -> int:
    """How many sessions before the effective date the "equal" prices are taken.

    Calibrated on the published index (the residual is ~0.01 bp only with this lag):
      - effective before 2017-12-01: the previous session's close (lag 1);
      - to the December 2020 review (effective 2021-01-01): 5 sessions — the
        methodology document's "5 working days prior";
      - from the March 2021 review: 3 sessions.
    """
    if effective < pd.Timestamp(2017, 12, 1):
        return 1
    if effective <= pd.Timestamp(2021, 1, 1):
        return 5
    return 3


def quarterly_effective_date(
    sessions: pd.DatetimeIndex, year: int, month: int
) -> pd.Timestamp | None:
    """Effective date of the March/June/September/December equal-weight reset
    (`month` is the review month). Calibrated on the published index:

      - reviews up to September 2017 (mostly NSE's back-calculated history; the index
        was launched 2017-04-13): June and December resets on the first session of
        the following month, March and September ones on the first session after
        the F&O expiry (the semi-annual review date);
      - December 2017 to December 2020: the first session after that month's F&O
        expiry — the methodology document's rule;
      - from March 2021: the last session of the review month.

    A review that also changes constituents takes effect on the changes' date
    instead; `rebalance_schedule` adds those as separate resets.
    """
    if (year, month) <= (2017, 9) and month in (6, 12):
        after = sessions[sessions > pd.Timestamp(year, month, 1) + pd.offsets.MonthEnd(0)]
        return after[0] if len(after) else None
    if year >= 2021:
        in_month = sessions[(sessions.year == year) & (sessions.month == month)]
        month_complete = len(in_month) and sessions[-1] > in_month[-1]
        return in_month[-1] if month_complete else None
    expiry = _fo_expiry(sessions, year, month)
    if expiry is None:
        return None
    pos = sessions.get_loc(expiry) + 1
    return sessions[pos] if pos < len(sessions) else None


def _normalise_membership(membership: pd.DataFrame, sessions: pd.DatetimeIndex) -> pd.DataFrame:
    """Parse from/to, fill open-ended `to` with the last session, and add `to_excl`,
    the first session after the row's last member session."""
    m = membership.copy()
    m["from"] = pd.to_datetime(m["from"])
    to = m["to"].replace("", np.nan) if m["to"].dtype == object else m["to"]
    m["to"] = pd.to_datetime(to).fillna(sessions[-1])
    if "kind" not in m:
        m["kind"] = MembershipKind.INVESTABLE.value
    pos = sessions.searchsorted(m["to"], side="right")
    m["to_excl"] = [
        sessions[p] if p < len(sessions) else sessions[-1] + pd.Timedelta(days=1) for p in pos
    ]
    return m


def rebalance_schedule(
    sessions: Iterable, membership: pd.DataFrame, skip: Iterable = ()
) -> pd.DataFrame:
    """Every equal-weight reset: the quarterly ones plus an ad-hoc reset on each
    session where the investable member set changes outside a quarterly date.

    Returns columns `effective` (first session priced with the new weights),
    `price_date` (session whose closing prices define "equal") and `kind`
    ("quarterly" or "ad hoc"). `skip` adds quarterly effective dates to ignore on
    top of CALIBRATED_SKIPS; CALIBRATED_PRICE_DATES overrides the lag rule.
    """
    sess = pd.DatetimeIndex(pd.to_datetime(list(sessions))).sort_values()
    skip_set = {pd.Timestamp(s) for s in (*CALIBRATED_SKIPS, *skip)}
    overrides = {pd.Timestamp(k): pd.Timestamp(v) for k, v in CALIBRATED_PRICE_DATES.items()}
    rows: dict[pd.Timestamp, str] = {}
    for year in range(sess[0].year, sess[-1].year + 1):
        for month in _REBALANCE_MONTHS:
            eff = quarterly_effective_date(sess, year, month)
            if eff is not None and eff > sess[0] and eff not in skip_set:
                rows[eff] = "quarterly"
    m = _normalise_membership(membership, sess)
    inv = m[m["kind"] == MembershipKind.INVESTABLE.value]
    for day in sorted(set(inv["from"]) | set(inv["to_excl"])):
        if day in rows or day <= sess[0] or day > sess[-1]:
            continue
        before = set(inv[(inv["from"] < day) & (inv["to_excl"] >= day)]["company_id"])
        after = set(inv[(inv["from"] <= day) & (inv["to_excl"] > day)]["company_id"])
        if before != after and before and after:
            rows[day] = "ad hoc"
    out = []
    for eff, kind in sorted(rows.items()):
        pos = sess.get_loc(eff)
        lag = _lag_sessions(eff)
        price_date = overrides.get(eff, sess[pos - lag] if pos - lag >= 0 else None)
        if price_date is not None and price_date in sess:
            out.append({"effective": eff, "price_date": price_date, "kind": kind})
    return pd.DataFrame(out, columns=["effective", "price_date", "kind"])


# --------------------------------------------------------------------------
# Event days
# --------------------------------------------------------------------------


def event_days_from_corporate_actions(
    ca_rows: pd.DataFrame,
    membership: pd.DataFrame,
    aliases: pd.DataFrame,
    daily: pd.DataFrame,
) -> pd.DataFrame:
    """Member-days whose close/prevclose is not a clean price return.

    `ca_rows` is the raw corporate-actions feed (columns symbol, exDate, subject).
    The feed re-keys history to the *current* symbol (plan.md §1), so a row is matched
    to a company through aliases.csv (any symbol the company ever used) and attached
    to the company's first traded session on or after the ex-date (at most 10 days
    later). Returns EVENT_COLUMNS: `kind` is "split"/"bonus" (with `factor`, the
    share-count factor f in r = P_t / (f * P_t-1)), "dividend" (with
    `dividend_yield`, only when >= DIVIDEND_EVENT_YIELD) or "other" (rights,
    demerger, scheme, ... — the return is solved from the index).
    """
    from .corporate_actions import parse_ca_date, parse_subject
    from .schemas import EventKind

    sym_to_company = dict(zip(aliases["symbol"], aliases["company_id"], strict=True))
    members = set(membership["company_id"])
    d = daily[["date", "symbol", "prevclose"]].copy()
    d["date"] = pd.to_datetime(d["date"])
    d = d[d["symbol"].isin(set(aliases["symbol"]))]
    d["company_id"] = d["symbol"].map(sym_to_company)
    traded = {cid: grp.sort_values("date") for cid, grp in d.groupby("company_id")}
    out = []
    for r in ca_rows.itertuples(index=False):
        cid = sym_to_company.get(r.symbol)
        if cid is None or cid not in members or cid not in traded:
            continue
        ex = parse_ca_date(r.exDate)
        events = parse_subject(str(r.subject), 0.0) if ex is not None else []
        if not events:
            continue
        grp = traded[cid]
        hit = grp[grp["date"] >= pd.Timestamp(ex)]
        if hit.empty or (hit["date"].iloc[0] - pd.Timestamp(ex)).days > 10:
            continue
        session, prevclose = hit["date"].iloc[0], float(hit["prevclose"].iloc[0])
        for ev in events:
            if ev.kind == EventKind.DIVIDEND:
                y = (ev.dividend or 0.0) / prevclose if prevclose > 0 else 0.0
                if y >= DIVIDEND_EVENT_YIELD:
                    out.append((cid, session, "dividend", np.nan, y))
            elif ev.kind in (EventKind.SPLIT, EventKind.BONUS) and ev.factor:
                out.append((cid, session, str(ev.kind), float(ev.factor), np.nan))
            else:
                out.append((cid, session, "other", np.nan, np.nan))
    return pd.DataFrame(out, columns=EVENT_COLUMNS)


# --------------------------------------------------------------------------
# Reconstruction
# --------------------------------------------------------------------------


def _growth_by_company(
    daily: pd.DataFrame, m: pd.DataFrame, sessions: pd.DatetimeIndex
) -> tuple[list[str], np.ndarray]:
    """Gross one-session return close/prevclose per company, stitched across the
    company's symbols (a renamed symbol's PREVCLOSE chains exactly — plan.md §1).
    Outside a company's rows the nearest row's symbol is used, so a new entrant has
    prices for the look-back to its equal-weight price date. No trade -> 1.0."""
    d = daily[["date", "symbol", "close", "prevclose"]].copy()
    d["date"] = pd.to_datetime(d["date"])
    d = d[d["symbol"].isin(set(m["symbol"]))]
    d["g"] = d["close"] / d["prevclose"]
    piv = d.pivot_table(index="date", columns="symbol", values="g", aggfunc="first")
    piv = piv.reindex(sessions)
    companies = sorted(m["company_id"].unique())
    g = np.ones((len(sessions), len(companies)))
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
        g[:, j] = np.where(np.isfinite(col) & (col > 0), col, 1.0)
    return companies, g


def _resolve_events(
    gt: np.ndarray,
    w: np.ndarray,
    mem: np.ndarray,
    divs: dict[int, float],
    other: set[int],
    target: float,
) -> np.ndarray:
    """Price relatives for one session with member corporate actions, chosen so the
    basket's value matches the published index (`target` = (1 + index return) x
    yesterday's basket value).

    Dividends: the index price-adjusts only "special" ones, so each member dividend
    is either adjusted (g / (1 - yield)) or not. With no "other" event that day, the
    combination that best matches the index is taken; otherwise dividends of
    SPECIAL_DIVIDEND_YIELD or more are assumed adjusted and the "other" members share
    one scale factor solved from the index (exact when there is one such member).
    """
    gt = gt.copy()
    d_idx = [i for i in divs if mem[i]]
    o_idx = [i for i in other if mem[i]]

    def value(adjusted: tuple[int, ...]) -> float:
        g = gt.copy()
        for i in adjusted:
            g[i] = g[i] / (1.0 - divs[i])
        return float((w[mem] * g[mem]).sum())

    if not o_idx:
        if d_idx:
            choices = [()]
            for k in range(1, min(len(d_idx), 6) + 1):
                choices += list(itertools.combinations(d_idx, k))
            best = min(choices, key=lambda c: abs(value(c) - target))
            for i in best:
                gt[i] = gt[i] / (1.0 - divs[i])
        return gt
    for i in d_idx:
        if divs[i] >= SPECIAL_DIVIDEND_YIELD:
            gt[i] = gt[i] / (1.0 - divs[i])
    known = [i for i in np.where(mem)[0] if i not in o_idx]
    base = float((w[known] * gt[known]).sum())
    wo = float((w[o_idx] * gt[o_idx]).sum())
    if wo > 0:
        scale = (target - base) / wo
        if scale > 0:
            gt[o_idx] = gt[o_idx] * scale
    return gt


def run(
    daily: pd.DataFrame,
    membership: pd.DataFrame,
    ew_price_index: pd.Series,
    *,
    event_days: pd.DataFrame | None = None,
    rebalances: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Compare the EW price-index daily return with the equal-weighted, drifting mean
    of the members' raw `close/prevclose`.

    `rebalances` defaults to `rebalance_schedule(index dates, membership)`.
    `event_days` (EVENT_COLUMNS, e.g. from `event_days_from_corporate_actions`) are
    company-days with a price-affecting corporate action; member days among them are
    not scored (see the module docstring and `_resolve_events`).

    Returns one row per index session after the first covered one, with columns
    `index_return`, `reconstructed_return`, `residual_bp`, `excluded` (bool),
    `reason`, `n_members` (companies, dummies included) and `back_calculated`.
    The <5 bp on 95% of days target is evaluated by `summarize`, not here.
    """
    ew = ew_price_index.copy()
    ew.index = pd.to_datetime(ew.index)
    ew = ew.sort_index()
    sessions = pd.DatetimeIndex(ew.index)
    idx_ret = ew.pct_change().to_numpy()

    m = _normalise_membership(membership, sessions)
    companies, growth = _growth_by_company(daily, m, sessions)
    cpos = {c: i for i, c in enumerate(companies)}
    n_t, n_c = len(sessions), len(companies)

    member = np.zeros((n_t, n_c), dtype=bool)
    dummy = np.zeros((n_t, n_c), dtype=bool)
    for cid, start, stop, kind in zip(
        m["company_id"], m["from"], m["to_excl"], m["kind"], strict=True
    ):
        a, b = sessions.searchsorted(start), sessions.searchsorted(stop)
        member[a:b, cpos[cid]] = True
        if kind == MembershipKind.DUMMY.value:
            dummy[a:b, cpos[cid]] = True

    # corporate-action days: splits/bonuses are adjusted deterministically on every
    # day (members or not, so a later reset sees the right price relative);
    # dividends >= 1% and "other" events are resolved against the index on member days
    divs: dict[int, dict[int, float]] = {}
    other: dict[int, set[int]] = {}
    event_day = np.zeros((n_t, n_c), dtype=bool)
    if event_days is not None and len(event_days):
        ev = pd.DataFrame(event_days)
        for col in EVENT_COLUMNS[2:]:
            if col not in ev:
                ev[col] = "other" if col == "kind" else np.nan
        for cid, day, kind, factor, dy in zip(
            ev["company_id"],
            ev["session"],
            ev["kind"],
            ev["factor"],
            ev["dividend_yield"],
            strict=True,
        ):
            t = pd.Timestamp(day)
            if cid not in cpos or t not in sessions:
                continue
            ti, ci = sessions.get_loc(t), cpos[cid]
            event_day[ti, ci] = True
            if kind in ("split", "bonus") and np.isfinite(factor) and factor > 0:
                growth[ti, ci] /= factor
            elif kind == "dividend" and np.isfinite(dy) and 0 < dy < 1:
                divs.setdefault(ti, {})[ci] = divs.get(ti, {}).get(ci, 0.0) + dy
            else:
                other.setdefault(ti, set()).add(ci)

    if rebalances is None:
        rebalances = rebalance_schedule(sessions, membership)
    resets = {}
    for r in rebalances.itertuples(index=False):
        e, c = pd.Timestamp(r.effective), pd.Timestamp(r.price_date)
        if e in sessions and c in sessions:
            resets[sessions.get_loc(e)] = sessions.get_loc(c)

    hat = np.full(n_t, np.nan)
    excluded = np.zeros(n_t, dtype=bool)
    reason = [""] * n_t
    first = int(np.argmax(member.any(axis=1)))
    w = member[first].astype(float)  # equal weights at the first covered close
    for t in range(first + 1, n_t):
        mem, prev = member[t], member[t - 1]
        total = w.sum()
        if t in resets:
            nw = np.zeros(n_c)
            nw[mem] = growth[resets[t] + 1 : t, mem].prod(axis=0)
            w = nw / nw.sum() * total
        else:
            leavers = np.where(prev & ~mem)[0]
            entrants = np.where(mem & ~prev)[0]
            new_dummies = [i for i in entrants if dummy[t, i]]
            new_members = [i for i in entrants if not dummy[t, i]]
            freed = w[leavers].sum()
            w[leavers] = 0.0
            if new_members and freed > 0:
                # a change with no reset scheduled: entrants take the leavers' value
                w[new_members] = freed / len(new_members)
            elif freed > 0 and w[mem].sum() > 0:
                # e.g. a demerger dummy leaving: its value stays in the index pro rata
                w[mem] *= total / w[mem].sum()
            if new_dummies:
                # the spun-off entity enters at the value that keeps the index
                # continuous, so solve its weight from the published return
                gt = growth[t].copy()
                old = [i for i in np.where(mem)[0] if i not in new_dummies]
                known = float((w[old] * gt[old]).sum())
                w[new_dummies] = max((1.0 + idx_ret[t]) * total - known, 0.0) / len(new_dummies)
                w[old] = w[old] * gt[old]
                hat[t], excluded[t], reason[t] = idx_ret[t], True, "demerger dummy enters"
                continue
        gt = growth[t].copy()
        if event_day[t, mem].any():
            gt = _resolve_events(
                gt, w, mem, divs.get(t, {}), other.get(t, set()), (1.0 + idx_ret[t]) * w[mem].sum()
            )
            growth[t] = gt  # later resets use the resolved price relative
            hat[t], excluded[t], reason[t] = idx_ret[t], True, "corporate action"
        elif w[mem].sum() > 0:
            hat[t] = (w[mem] * gt[mem]).sum() / w[mem].sum() - 1.0
        w[mem] = w[mem] * gt[mem]
        w[~mem] = 0.0

    out = pd.DataFrame(
        {
            "index_return": idx_ret,
            "reconstructed_return": hat,
            "excluded": excluded,
            "reason": reason,
            "n_members": member.sum(axis=1),
            "back_calculated": sessions < pd.Timestamp(EW_LAUNCH_DATE),
        },
        index=sessions,
    )
    out["residual_bp"] = (out["index_return"] - out["reconstructed_return"]) * 1e4
    out.index.name = "date"
    return out.iloc[first + 1 :]


def summarize(result: pd.DataFrame, target_bp: float = TARGET_BP) -> dict:
    """Headline numbers: share of scored days under `target_bp`, median / p95
    absolute residual, and the worst days."""
    scored = result[~result["excluded"]].dropna(subset=["residual_bp"])
    a = scored["residual_bp"].abs()
    worst = a.sort_values(ascending=False).head(10)
    share = float((a < target_bp).mean()) if len(a) else float("nan")
    return {
        "days": int(len(result)),
        "scored_days": int(len(scored)),
        "excluded_days": int(result["excluded"].sum()),
        "share_below_target": share,
        "median_abs_bp": float(a.median()) if len(a) else float("nan"),
        "p95_abs_bp": float(a.quantile(0.95)) if len(a) else float("nan"),
        "meets_target": bool(len(a) > 0 and share >= TARGET_SHARE),
        "worst_days": [(d.date().isoformat(), round(float(v), 3)) for d, v in worst.items()],
    }


def check_invariants(
    membership: pd.DataFrame, sessions: Iterable, current_symbols: Iterable[str]
) -> list[str]:
    """Hard membership invariants (QA C18); returns a list of violations, empty if OK.

    - every session has exactly 50 member companies, or 51 when one dummy row
      (a demerger placeholder) is active that session;
    - the open-ended rows (`to` blank) are exactly `current_symbols`.
    """
    sess = pd.DatetimeIndex(pd.to_datetime(list(sessions))).sort_values()
    m = _normalise_membership(membership, sess)
    problems: list[str] = []
    counts = np.zeros(len(sess), dtype=int)
    dummies = np.zeros(len(sess), dtype=int)
    for start, stop, kind in zip(m["from"], m["to_excl"], m["kind"], strict=True):
        a, b = sess.searchsorted(start), sess.searchsorted(stop)
        counts[a:b] += 1
        if kind == MembershipKind.DUMMY.value:
            dummies[a:b] += 1
    for day, n, nd in zip(sess, counts, dummies, strict=True):
        if n != 50 + nd or nd > 1:
            problems.append(f"{day.date()}: {n} members ({nd} dummy)")
    to = membership["to"]
    open_rows = membership[to.isna() | (to.astype(str).str.strip() == "")]
    open_syms, current = set(open_rows["symbol"]), set(current_symbols)
    if open_syms != current:
        problems.append(
            f"open rows != current list: extra {sorted(open_syms - current)}, "
            f"missing {sorted(current - open_syms)}"
        )
    return problems
