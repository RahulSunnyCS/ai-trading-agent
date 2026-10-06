"""Company resolution and total-return/price-only adjustment (plan.md §2, T6).

adjust.build is where daily.parquet rows, parsed events, the alias chain and the
membership table come together into per-company return series. It is the one place
in the data layer that applies plan.md §2's return formula:

    r_t = (P_t / f_t + D_t) / P_{t-1}

where f_t is the product of all share-count factors on session t and D_t is the sum
of dividends per pre-event share on session t. Chaining r_t gives the pre-tax
total-return series; chaining with D_t = 0 gives the price-only series.

`build_all` is the single entry point (plan.md §7, T8's CLI calls it): it runs
every step of the pipeline -- company resolution, event parsing/attachment, return
computation, every plan.md §3 guard, the outputs under data/stocks/, and the CA
event-diff/baseline/manifest-pin logic -- entirely from the already-downloaded raw
cache, with no network access except the optional cash NAV backfill.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from momentum_backtesting.stocks import benchmarks, corporate_actions, schemas
from momentum_backtesting.stocks.nse import atomic_write_bytes, extract_single_member
from momentum_backtesting.stocks.schemas import EventKind, GuardResult, GuardSeverity

# --------------------------------------------------------------------------
# Curated-file loading
# --------------------------------------------------------------------------


def load_curated(curated_dir: Path) -> dict[str, pd.DataFrame]:
    """Load every curated/*.csv named in schemas.CURATED_HEADERS as a DataFrame,
    keyed by filename. A missing file loads as an empty frame with the frozen
    header -- every curated file except events_baseline.csv.gz is expected to
    exist, but an empty *_rows-style exception file (0 data rows) is normal.
    """
    out: dict[str, pd.DataFrame] = {}
    for name, header in schemas.CURATED_HEADERS.items():
        path = curated_dir / name
        if path.exists():
            out[name] = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""])
        else:
            out[name] = pd.DataFrame(columns=list(header))
    return out


def _load_events_baseline(curated_dir: Path) -> pd.DataFrame | None:
    path = curated_dir / "events_baseline.csv.gz"
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return pd.read_csv(f, dtype=str, keep_default_na=False, na_values=[""])


def _write_events_baseline(
    curated_dir: Path, events: pd.DataFrame, membership: pd.DataFrame
) -> None:
    """Write curated/events_baseline.csv.gz -- member companies only (plan.md §2:
    "small: member companies only")."""
    member_ids = set(membership["company_id"])
    baseline_cols = [
        "company_id",
        "ex_date",
        "kind",
        "factor",
        "dividend",
        "source",
        "subject_sha1",
        "symbol_at_ex",
    ]
    subset = events[events["company_id"].isin(member_ids)][baseline_cols].copy()
    subset = subset.sort_values(["company_id", "ex_date", "kind"]).reset_index(drop=True)
    path = curated_dir / "events_baseline.csv.gz"
    buf_text = subset.to_csv(index=False)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write(buf_text)


# --------------------------------------------------------------------------
# Local (no-network) raw-cache loaders
# --------------------------------------------------------------------------


def load_ca_feed_local(raw_dir: Path) -> pd.DataFrame:
    """Load the already-fetched CA feed under raw_dir/corporate_actions/ -- no
    network. These files are the whole-market CA feed exactly as
    corporate_actions.fetch_snapshot (T2) or fetch_history (T8's `mbt stocks
    fetch`) writes it, just read back rather than re-fetched, so build_all can
    run entirely from the raw cache.

    T8 non-obvious decision (the one adjust.py edit the T8 contract allows):
    two on-disk shapes exist for this directory. T6 was built and tested
    against the pre-downloaded yearly snapshots (`ca_YYYY.json`, directly under
    `corporate_actions/`), but `corporate_actions.fetch_history` (T2's fetch
    path, wired up by T8's CLI) writes quarterly snapshots one directory per
    fetch date instead: `corporate_actions/<fetch-date>/<from>_<to>.json`. Both
    are literally the CA feed's `rows` list dumped as JSON (same shape,
    `fetch_snapshot` writes exactly that), so this function now prefers the
    newest fetch-date subdirectory when one exists (its ISO-date name sorts
    chronologically) and falls back to the flat `ca_*.json` files only when no
    subdirectory is present -- so a fresh `mbt stocks fetch` run is used
    instead of silently continuing to read a stale pre-downloaded snapshot.
    """
    ca_dir = raw_dir / "corporate_actions"
    frames: list[pd.DataFrame] = []

    snapshot_dirs = sorted(p for p in ca_dir.glob("*") if p.is_dir())
    if snapshot_dirs:
        paths = sorted(snapshot_dirs[-1].glob("*.json"))
    else:
        paths = sorted(ca_dir.glob("ca_*.json"))

    for path in paths:
        rows = json.loads(path.read_text(encoding="utf-8"))
        if rows:
            frames.append(pd.DataFrame(rows))
    if not frames:
        return pd.DataFrame(columns=list(corporate_actions.OUTPUT_COLUMNS))
    combined = pd.concat(frames, ignore_index=True)
    keep = [c for c in corporate_actions.OUTPUT_COLUMNS if c in combined.columns]
    return combined[keep].drop_duplicates(ignore_index=True)


def load_tri_local(raw_dir: Path, filename: str) -> pd.Series:
    """Parse an already-fetched niftyindices TRI JSON snapshot (raw_dir/benchmarks/
    <filename>) via sources.parse_niftyindices_tri -- the same parser
    benchmarks.fetch_tri uses, just fed a local file instead of a live request.
    """
    from momentum_backtesting.sources import parse_niftyindices_tri

    rows = json.loads((raw_dir / "benchmarks" / filename).read_text(encoding="utf-8"))
    return parse_niftyindices_tri(rows)


def load_ew_price_local(raw_dir: Path) -> pd.Series:
    """NIFTY50 Equal Weight *price* index, from the already-downloaded
    raw_dir/benchmarks/NIFTY50_EQUAL_WEIGHT_PRICE.csv (already parsed to
    date,close by the out-of-band probe that produced it -- no JSON row shape to
    replay here, unlike the TRI files)."""
    df = pd.read_csv(
        raw_dir / "benchmarks" / "NIFTY50_EQUAL_WEIGHT_PRICE.csv", parse_dates=["date"]
    )
    return df.set_index("date")["close"].sort_index()


# --------------------------------------------------------------------------
# Company resolution
# --------------------------------------------------------------------------


def resolve_company(
    symbol: str, isin: str | None, session: date, aliases: pd.DataFrame
) -> str | None:
    """Resolve a (symbol, isin, session) row from bhavcopy to a company_id, via the
    hand-curated alias chain (curated/aliases.csv, dated symbol ranges).

    `isin` is accepted (and kept in the signature, per the T0 stub) but not used
    here: curated/aliases.csv carries no ISIN column -- it is a dated *symbol*
    chain, not an ISIN chain -- so bhavcopy resolution is symbol+date only. ISIN-
    first resolution genuinely happens (plan.md §2), but for the CA feed's rows,
    via `build_ca_lookups`/`resolve_ca_company` below, which derive an isin ->
    company_id map *from* bhavcopy's own (symbol, isin, date) rows once they are
    resolved this way. Reported as a non-obvious decision: the T0 stub's docstring
    describes the isin-first rule as if it applied to this function too, but
    plan.md §2 is explicit that the rule is about CA rows, not bhavcopy rows.
    """
    del isin
    session_ts = pd.Timestamp(session)
    match = aliases[aliases["symbol"] == symbol]
    if match.empty:
        return None
    from_ts = pd.to_datetime(match["from"])
    to_ts = pd.to_datetime(match["to"])
    in_range = match[(from_ts <= session_ts) & (to_ts.isna() | (to_ts >= session_ts))]
    if in_range.empty:
        return None
    return str(in_range.iloc[0]["company_id"])


def resolve_daily_companies(daily: pd.DataFrame, aliases: pd.DataFrame) -> pd.Series:
    """Vectorised resolve_company over every row of `daily`: one boolean mask per
    alias row (curated/aliases.csv has ~110 rows total, so this is ~110 passes over
    `daily` rather than one Python-level call per row -- the only way this stays
    fast against a multi-million-row daily.parquet).

    Rows whose symbol never appears in aliases.csv (the overwhelming majority --
    aliases.csv only covers the 95 ever-Nifty50-member companies, not the whole
    market) resolve to <NA>, which is expected: nothing downstream needs a
    company_id for a stock that was never a member.
    """
    dates = pd.to_datetime(daily["date"])
    symbols = daily["symbol"]
    out = pd.Series(pd.array([None] * len(daily), dtype="object"), index=daily.index)

    al = aliases.copy()
    al["from_ts"] = pd.to_datetime(al["from"])
    al["to_ts"] = pd.to_datetime(al["to"])

    for row in al.itertuples(index=False):
        mask = (symbols.to_numpy() == row.symbol) & (dates >= row.from_ts).to_numpy()
        if pd.notna(row.to_ts):
            mask &= (dates <= row.to_ts).to_numpy()
        out.loc[mask] = row.company_id
    return out


def symbol_at(company_id: str, when: date, aliases: pd.DataFrame) -> str:
    """The symbol `company_id` traded under on `when`, from curated/aliases.csv.

    Falls back to the company's most recent (highest `from`) alias row if `when`
    falls outside every dated range -- e.g. a manual event dated after the
    company's last recorded alias `to` (shouldn't normally happen, but
    events.parquet's symbol_at_ex column is non-nullable, so this never raises).
    """
    when_ts = pd.Timestamp(when)
    rows = aliases[aliases["company_id"] == company_id].copy()
    if rows.empty:
        raise ValueError(f"no alias rows at all for company_id {company_id!r}")
    rows["from_ts"] = pd.to_datetime(rows["from"])
    rows["to_ts"] = pd.to_datetime(rows["to"])
    in_range = rows[
        (rows["from_ts"] <= when_ts) & (rows["to_ts"].isna() | (rows["to_ts"] >= when_ts))
    ]
    if not in_range.empty:
        return str(in_range.iloc[0]["symbol"])
    return str(rows.sort_values("from_ts").iloc[-1]["symbol"])


def build_ca_lookups(
    daily_resolved: pd.DataFrame, aliases: pd.DataFrame
) -> tuple[dict[str, str], dict[str, str]]:
    """Build the two lookups CA-feed rows resolve through (plan.md §2: "ISIN first,
    symbol as the fallback").

    `isin_to_company`: isin -> company_id, derived from bhavcopy rows that were
    already resolved to a company_id via `resolve_daily_companies` (symbol+date
    against aliases.csv). ISIN is stable across a symbol rename (it is the split
    that changes a company's ISIN, one session later -- plan.md §1), which is
    exactly why the CA feed's ISIN-first resolution can land a re-keyed row (e.g.
    TATAMOTORS's 2011 split, filed under today's symbol TMPV) back on the right
    company regardless of what symbol the feed shows today.

    `symbol_to_company_latest`: company_id's most-recently-started alias symbol ->
    company_id -- the fallback for CA rows whose ISIN isn't in `isin_to_company`
    (e.g. a 2011-era bhavcopy row with no ISIN column at all). The CA feed always
    shows a row under the company's *current* (or, for a delisted/merged company,
    its *last*) symbol, so matching against each company's latest alias entry is
    the correct fallback, not matching against the symbol active on the event's
    own ex-date (the feed's re-keying means that symbol is often wrong for old
    events, as the TMPV example above shows).
    """
    resolved = daily_resolved[daily_resolved["company_id"].notna() & daily_resolved["isin"].notna()]
    isin_to_company: dict[str, str] = {}
    if not resolved.empty:
        counts = resolved.groupby(["isin", "company_id"]).size().reset_index(name="n")
        counts = counts.sort_values("n", ascending=False)
        for row in counts.itertuples(index=False):
            isin_to_company.setdefault(row.isin, row.company_id)

    al = aliases.copy()
    al["from_ts"] = pd.to_datetime(al["from"])
    symbol_to_company_latest: dict[str, str] = {}
    for company_id, grp in al.groupby("company_id"):
        latest = grp.sort_values("from_ts").iloc[-1]
        symbol_to_company_latest[str(latest["symbol"])] = str(company_id)

    return isin_to_company, symbol_to_company_latest


def resolve_ca_company(
    isin: str | None,
    symbol: str,
    isin_to_company: dict[str, str],
    symbol_to_company_latest: dict[str, str],
) -> str | None:
    """ISIN-first, symbol-fallback company resolution for one CA feed row
    (plan.md §2)."""
    if isin and isin in isin_to_company:
        return isin_to_company[isin]
    return symbol_to_company_latest.get(symbol)


# --------------------------------------------------------------------------
# Neutral ex-day classification (plan.md §9) -- re-derives which manual-only
# kind a subject is, from the subject text itself, since parse_subject only
# tags these MANUAL_ONLY (it does not distinguish the reason beyond `note`).
# --------------------------------------------------------------------------

_DEBENTURE_RE = re.compile(r"debenture", re.IGNORECASE)
_PREFERENCE_RE = re.compile(r"preference|\bncrps\b", re.IGNORECASE)

#: kind values whose ex-date sessions get the plan.md §9 neutral-ex-day rule
#: (r_t = 0 instead of a researched factor) rather than a hard fail.
NEUTRAL_EXDAY_KINDS = frozenset(
    {
        EventKind.DEMERGER,
        EventKind.RIGHTS,
        EventKind.SCHEME_OF_ARRANGEMENT,
        EventKind.BONUS_DEBENTURE,
        EventKind.PREFERENCE_SHARE,
        EventKind.CAPITAL_REDUCTION,
    }
)


def classify_neutral_kind(subject: str, note: str | None) -> EventKind | None:
    """For a MANUAL_ONLY ParsedEvent, decide whether it is one of the plan.md §9
    neutral-ex-day kinds (demerger / rights / scheme of arrangement / bonus
    debenture / preference share / capital reduction) and, if so, which.

    Returns None for every other MANUAL_ONLY reason (amount-less dividend,
    combined dividend+bonus, an unrecognised bonus/split ratio) -- those stay
    hard-fail-until-covered-by-actions_manual.csv, per plan.md §2/§9 (the neutral
    rule only ever applies to the six kinds above; it never substitutes for a
    missing dividend/bonus/split amount).
    """
    note = note or ""
    if "demerger" in note:
        return EventKind.DEMERGER
    if "rights issue" in note:
        return EventKind.RIGHTS
    if "scheme of arrangement" in note:
        return EventKind.SCHEME_OF_ARRANGEMENT
    if "capital reduction" in note:
        return EventKind.CAPITAL_REDUCTION
    if "bonus debenture/preference" in note:
        if _DEBENTURE_RE.search(subject):
            return EventKind.BONUS_DEBENTURE
        if _PREFERENCE_RE.search(subject):
            return EventKind.PREFERENCE_SHARE
        return EventKind.BONUS_DEBENTURE
    return None


# --------------------------------------------------------------------------
# Event construction: feed + manual, combined
# --------------------------------------------------------------------------


@dataclass
class EventBuildResult:
    events: (
        pd.DataFrame
    )  # company_id, symbol_at_ex, ex_date, kind, factor, dividend, source, subject_sha1
    report_rows: list[GuardResult] = field(default_factory=list)


_EVENT_COLUMNS = [
    "company_id",
    "symbol_at_ex",
    "ex_date",
    "kind",
    "factor",
    "dividend",
    "source",
    "subject_sha1",
]


def build_feed_events(
    ca_raw: pd.DataFrame,
    isin_to_company: dict[str, str],
    symbol_to_company_latest: dict[str, str],
    aliases: pd.DataFrame,
) -> EventBuildResult:
    """Parse every CA feed row into zero or more events resolved to a company_id.

    A row is "relevant" (i.e. plausibly about one of our 95 ever-member
    companies) if its ISIN or its symbol appears anywhere in the resolution
    lookups; an ever-member's row that is relevant but still doesn't resolve is
    QA C08's F ("unresolved CA row for an ever-member"). A row that resolves to
    no company and isn't relevant is simply not one of ours (the CA feed is
    whole-market) and is silently skipped.
    """
    known_isins = set(isin_to_company)
    known_symbols_all = set(aliases["symbol"])

    events: list[dict] = []
    report_rows: list[GuardResult] = []

    if ca_raw.empty:
        return EventBuildResult(pd.DataFrame(columns=_EVENT_COLUMNS), report_rows)

    for row in ca_raw.itertuples(index=False):
        isin = getattr(row, "isin", None)
        symbol = getattr(row, "symbol", None)
        subject = getattr(row, "subject", None) or ""
        raw_face = getattr(row, "faceVal", None)
        ex_date = corporate_actions.parse_ca_date(getattr(row, "exDate", None))
        if ex_date is None or not symbol:
            continue

        company_id = resolve_ca_company(isin, symbol, isin_to_company, symbol_to_company_latest)
        is_relevant = bool(isin) and isin in known_isins or symbol in known_symbols_all
        if company_id is None:
            if is_relevant:
                report_rows.append(
                    GuardResult(
                        guard="ca_coverage",
                        severity=GuardSeverity.F,
                        message=(
                            f"unresolved CA row for an ever-member: symbol={symbol!r} "
                            f"isin={isin!r} exDate={ex_date} subject={subject[:120]!r}"
                        ),
                        company_id=None,
                        session=None,
                    )
                )
            continue

        try:
            face_value = float(raw_face) if raw_face not in (None, "", "-") else 0.0
        except ValueError:
            face_value = 0.0

        s_hash = corporate_actions.subject_sha1(subject)
        for parsed in corporate_actions.parse_subject(subject, face_value):
            if parsed.kind == EventKind.MANUAL_ONLY:
                neutral_kind = classify_neutral_kind(subject, parsed.note)
                if neutral_kind is not None:
                    events.append(
                        {
                            "company_id": company_id,
                            "symbol_at_ex": symbol,
                            "ex_date": ex_date,
                            "kind": neutral_kind.value,
                            "factor": None,
                            "dividend": None,
                            "source": "neutral_exday",
                            "subject_sha1": s_hash,
                        }
                    )
                else:
                    events.append(
                        {
                            "company_id": company_id,
                            "symbol_at_ex": symbol,
                            "ex_date": ex_date,
                            "kind": EventKind.MANUAL_ONLY.value,
                            "factor": None,
                            "dividend": None,
                            "source": "feed",
                            "subject_sha1": s_hash,
                        }
                    )
            else:
                events.append(
                    {
                        "company_id": company_id,
                        "symbol_at_ex": symbol,
                        "ex_date": ex_date,
                        "kind": parsed.kind.value,
                        "factor": parsed.factor,
                        "dividend": parsed.dividend,
                        "source": "feed",
                        "subject_sha1": s_hash,
                    }
                )

    return EventBuildResult(pd.DataFrame(events, columns=_EVENT_COLUMNS), report_rows)


def build_manual_events(actions_manual: pd.DataFrame) -> pd.DataFrame:
    """curated/actions_manual.csv -> events rows in the same shape as
    build_feed_events' output.

    `dividend_basis` is normalised away here rather than carried through to
    events.parquet: schemas.EVENTS_SCHEMA (frozen by T0) has no dividend_basis
    column, so a "post_bonus"-basis dividend is converted to the formula's
    per-pre-event-share basis (D_pre = D_post / factor) at this point, once,
    using the row's own factor -- the only place both values are still
    together. Every actions_manual.csv row currently on disk uses "pre_bonus"
    (the formula's native basis), so this conversion is presently a no-op in
    practice but is implemented for correctness / future rows.
    kind == "merger_exit" rows are excluded: they carry no factor/dividend and
    are consumed by the exit-rule logic (`compute_exit_rule`), not by the
    return-series formula.
    """
    if actions_manual.empty:
        return pd.DataFrame(columns=_EVENT_COLUMNS)

    rows = []
    for r in actions_manual.itertuples(index=False):
        if r.kind == EventKind.MERGER_EXIT.value:
            continue
        ex_date = date.fromisoformat(r.ex_date)
        factor = float(r.factor) if pd.notna(r.factor) and r.factor not in ("",) else None
        dividend = float(r.dividend) if pd.notna(r.dividend) and r.dividend not in ("",) else None
        basis = r.dividend_basis if pd.notna(r.dividend_basis) else None
        if dividend is not None and basis == "post_bonus" and factor:
            dividend = dividend / factor
        rows.append(
            {
                "company_id": r.company_id,
                "symbol_at_ex": None,  # filled in by combine_manual_over_feed via symbol_at()
                "ex_date": ex_date,
                "kind": r.kind,
                "factor": factor,
                "dividend": dividend,
                "source": "manual",
                "subject_sha1": None,
            }
        )
    return pd.DataFrame(rows, columns=_EVENT_COLUMNS)


def combine_manual_over_feed(
    events_feed: pd.DataFrame, events_manual: pd.DataFrame, aliases: pd.DataFrame
) -> pd.DataFrame:
    """Merge feed-derived and manual events: a curated actions_manual.csv row for
    a given (company_id, ex_date) replaces *every* feed-derived event at that same
    (company_id, ex_date) -- whatever it was (a MANUAL_ONLY placeholder that
    failed to parse, or even a successfully-parsed feed row) -- rather than being
    added alongside it. This is what plan.md's "manual rows override/complete feed
    rows for the same company+ex_date" means in practice: T5's curated dividend
    rows exist specifically to correct T2 regex misses (e.g. "Rs -7.65" not
    matching `_DIVIDEND_AMOUNT_RE`), so the manual value must win outright, not
    merely fill a gap next to a wrong or absent feed value.
    """
    events_manual = events_manual.copy()
    if not events_manual.empty:
        events_manual["symbol_at_ex"] = events_manual.apply(
            lambda r: symbol_at(r["company_id"], r["ex_date"], aliases), axis=1
        )

    if events_feed.empty:
        combined = events_manual
    elif events_manual.empty:
        combined = events_feed
    else:
        manual_keys = set(zip(events_manual["company_id"], events_manual["ex_date"], strict=True))
        keep_feed = events_feed[
            ~events_feed.apply(lambda r: (r["company_id"], r["ex_date"]) in manual_keys, axis=1)
        ]
        combined = pd.concat([keep_feed, events_manual], ignore_index=True)

    if combined.empty:
        return combined
    combined = combined.drop_duplicates(
        subset=["company_id", "ex_date", "kind", "factor", "dividend", "source"],
        ignore_index=True,
    )
    return combined


# --------------------------------------------------------------------------
# Event attachment (ex_date -> first traded session)
# --------------------------------------------------------------------------


def _session_lag(market_dates: np.ndarray, ex_ts: pd.Timestamp, session_ts: pd.Timestamp) -> int:
    idx_ex = int(np.searchsorted(market_dates, ex_ts, side="left"))
    idx_session = int(np.searchsorted(market_dates, session_ts, side="left"))
    return idx_session - idx_ex


def attach_events(
    events: pd.DataFrame, daily: pd.DataFrame, max_lag_sessions: int = 5
) -> pd.DataFrame:
    """Attach each already-company-resolved event to the company's first traded
    session on or after its ex_date.

    "Sessions later" (plan.md §2: "more than 5 sessions later -> fail") is
    measured against the *whole market's* session calendar (every date that
    appears anywhere in `daily`), not the company's own trading days: a
    suspended/illiquid company's own next trading day is, by construction,
    always its very next trading day (lag 0 under a company-local calendar),
    so only a market-wide calendar can tell "attached a bit late because
    ex_date fell on a holiday" apart from "attached suspiciously late because
    the company didn't trade for two weeks around its own ex-date".

    Raises ValueError for the first event whose first eligible session is more
    than `max_lag_sessions` sessions after ex_date, or whose company has no
    trading session on/after ex_date at all -- the caller (guards.py via
    build_all) turns that into an F, this function just refuses to silently
    attach it somewhere wrong.
    """
    if events.empty:
        return events.assign(session=pd.Series(dtype="object"))

    market_dates = np.sort(pd.to_datetime(daily["date"]).unique())
    comp_dates_by_company: dict[str, np.ndarray] = {
        cid: np.sort(pd.to_datetime(grp["date"]).unique())
        for cid, grp in daily.groupby("company_id")
        if pd.notna(cid)
    }

    sessions: list[date] = []
    for row in events.itertuples(index=False):
        comp_dates = comp_dates_by_company.get(row.company_id)
        if comp_dates is None or len(comp_dates) == 0:
            raise ValueError(f"{row.company_id}: no trading sessions found to attach events to")
        ex_ts = pd.Timestamp(row.ex_date)
        idx = int(np.searchsorted(comp_dates, ex_ts, side="left"))
        if idx >= len(comp_dates):
            raise ValueError(f"{row.company_id}: no trading session on/after ex_date {row.ex_date}")
        session_ts = pd.Timestamp(comp_dates[idx])
        lag = _session_lag(market_dates, ex_ts, session_ts)
        if lag > max_lag_sessions:
            raise ValueError(
                f"{row.company_id}: event at ex_date {row.ex_date} attaches {lag} "
                f"market sessions later (session {session_ts.date()}), exceeds "
                f"max_lag_sessions={max_lag_sessions}"
            )
        sessions.append(session_ts.date())

    out = events.copy()
    out["session"] = sessions
    return out


def attach_events_tolerant(
    events: pd.DataFrame, daily: pd.DataFrame, max_lag_sessions: int = 5
) -> tuple[pd.DataFrame, list[GuardResult]]:
    """Same rule as attach_events, but collects every violation as an F
    GuardResult and drops just that event, instead of raising on the first one --
    used by build_all so one bad event doesn't abort the whole run's reporting.
    """
    if events.empty:
        return events.assign(session=pd.Series(dtype="object")), []

    market_dates = np.sort(pd.to_datetime(daily["date"]).unique())
    comp_dates_by_company: dict[str, np.ndarray] = {
        cid: np.sort(pd.to_datetime(grp["date"]).unique())
        for cid, grp in daily.groupby("company_id")
        if pd.notna(cid)
    }

    rows = []
    failures: list[GuardResult] = []
    for row in events.itertuples(index=False):
        comp_dates = comp_dates_by_company.get(row.company_id)
        if comp_dates is None or len(comp_dates) == 0:
            failures.append(
                GuardResult(
                    guard="event_attach",
                    severity=GuardSeverity.F,
                    message=f"no trading sessions found for {row.company_id}",
                    company_id=row.company_id,
                    session=None,
                )
            )
            continue
        ex_ts = pd.Timestamp(row.ex_date)
        idx = int(np.searchsorted(comp_dates, ex_ts, side="left"))
        if idx >= len(comp_dates):
            failures.append(
                GuardResult(
                    guard="event_attach",
                    severity=GuardSeverity.F,
                    message=f"no trading session on/after ex_date {row.ex_date}",
                    company_id=row.company_id,
                    session=None,
                )
            )
            continue
        session_ts = pd.Timestamp(comp_dates[idx])
        lag = _session_lag(market_dates, ex_ts, session_ts)
        if lag > max_lag_sessions:
            failures.append(
                GuardResult(
                    guard="event_attach",
                    severity=GuardSeverity.F,
                    message=(
                        f"event at ex_date {row.ex_date} attaches {lag} market sessions "
                        f"later (session {session_ts.date()}) > max_lag_sessions={max_lag_sessions}"
                    ),
                    company_id=row.company_id,
                    session=str(session_ts.date()),
                )
            )
            continue
        d = dict(zip(events.columns, row, strict=True))
        d["session"] = session_ts.date()
        rows.append(d)

    out = pd.DataFrame(rows, columns=[*events.columns, "session"])
    return out, failures


# --------------------------------------------------------------------------
# Return-series computation
# --------------------------------------------------------------------------


def compute_return_series(
    company_daily: pd.DataFrame, company_events: pd.DataFrame
) -> pd.DataFrame:
    """Per-company session-by-session r_t (plan.md §2 formula) for one company's
    daily rows and its attached events.

    Returns a DataFrame indexed by session with columns `total_return_factor`
    (chained r_t) and `price_only_factor` (chained r_t with D_t=0), plus the raw
    per-session f_t/D_t used, for guards.py and validate.py to re-derive spreads
    without recomputing the chain.

    A session with a neutral_exday event (plan.md §9) gets r_t = 1.0 (0% return)
    for *both* series regardless of any other factor/dividend also attached that
    session (a coincidence not observed in the real data, but a deliberate,
    documented choice rather than an unhandled case if it ever occurs) -- the
    whole point of the rule is that this session's raw price move is not a
    reliable signal, so nothing derived from it (factor or dividend) is trusted
    either.
    """
    d = company_daily.sort_values("date").reset_index(drop=True).copy()
    d["date"] = pd.to_datetime(d["date"])

    ev_by_session: dict[pd.Timestamp, tuple[bool, float, float]] = {}
    if company_events is not None and not company_events.empty:
        for session, grp in company_events.groupby("session"):
            session_ts = pd.Timestamp(session)
            is_neutral = (grp["source"] == "neutral_exday").any()
            if is_neutral:
                ev_by_session[session_ts] = (True, 1.0, 0.0)
                continue
            factor = 1.0
            dividend = 0.0
            for r in grp.itertuples(index=False):
                if r.factor is not None and pd.notna(r.factor):
                    factor *= float(r.factor)
                if r.dividend is not None and pd.notna(r.dividend):
                    dividend += float(r.dividend)
            ev_by_session[session_ts] = (False, factor, dividend)

    n = len(d)
    r_total = np.ones(n)
    r_price = np.ones(n)
    f_used = np.ones(n)
    d_used = np.zeros(n)

    closes = d["close"].to_numpy()
    dates = d["date"]

    for i in range(1, n):
        prev_close = closes[i - 1]
        p_t = closes[i]
        ev = ev_by_session.get(dates.iloc[i])
        if ev is not None and ev[0]:
            r_total[i] = 1.0
            r_price[i] = 1.0
            f_used[i] = 1.0
            d_used[i] = 0.0
            continue
        f = ev[1] if ev is not None else 1.0
        div = ev[2] if ev is not None else 0.0
        f_used[i] = f
        d_used[i] = div
        r_price[i] = (p_t / f) / prev_close if prev_close else np.nan
        r_total[i] = r_price[i] + (div / prev_close if prev_close else 0.0)

    out = pd.DataFrame(
        {
            "session": d["date"].dt.date,
            "r_t": r_total,
            "f_t": f_used,
            "d_t": d_used,
            "total_return_factor": np.cumprod(r_total),
            "price_only_factor": np.cumprod(r_price),
        }
    )
    return out.set_index("session")


def build(
    daily: pd.DataFrame,
    events: pd.DataFrame,
    aliases: pd.DataFrame,
    membership: pd.DataFrame,
) -> pd.DataFrame:
    """End-to-end: resolve every daily/events row to a company_id, attach events to
    sessions, and compute each company's total-return and price-only factor series.

    Returns one row per (company_id, session) with the adjusted daily.parquet
    columns plus `total_return_factor`/`price_only_factor`. This is the DataFrame
    guards.run_all and validate.dividend_check both consume.
    """
    del membership  # not needed directly here; kept in the signature (T0 contract)
    d = daily.copy()
    if "company_id" not in d.columns:
        d["company_id"] = resolve_daily_companies(d, aliases)
    resolved = d[d["company_id"].notna()].copy()
    if resolved.empty:
        return resolved.assign(total_return_factor=[], price_only_factor=[], r_t=[], f_t=[], d_t=[])

    frames = []
    for company_id, grp in resolved.groupby("company_id"):
        comp_events = (
            events[events["company_id"] == company_id]
            if events is not None and not events.empty
            else pd.DataFrame(columns=[*_EVENT_COLUMNS, "session"])
        )
        rs = compute_return_series(grp, comp_events)
        grp_sorted = grp.sort_values("date").reset_index(drop=True)
        rs = rs.reset_index(drop=True)
        merged = pd.concat(
            [grp_sorted, rs[["total_return_factor", "price_only_factor", "r_t", "f_t", "d_t"]]],
            axis=1,
        )
        frames.append(merged)
    return pd.concat(frames, ignore_index=True)


# --------------------------------------------------------------------------
# Session-calendar guard + synthetic_close fill (plan.md §3)
# --------------------------------------------------------------------------


def fill_session_calendar(
    daily: pd.DataFrame, tri_dates: pd.DatetimeIndex
) -> tuple[pd.DataFrame, list[GuardResult]]:
    """Compare daily.parquet's session calendar (the set of dates present, market-
    wide) against the TRI date set, bounded at min(max TRI, max bhavcopy)
    (plan.md §3). A single missing session gets `synthetic_close` rows (one per
    symbol that traded both immediately before and after the gap) derived from
    the next session's PREVCLOSE; two or more *consecutive* missing sessions
    fail (F).

    Returns (new synthetic rows as a DataFrame in daily.parquet's column shape,
    guard results). Does not mutate `daily`; the caller concatenates and rewrites
    daily.parquet if any synthetic rows were produced.
    """
    bhav_dates = pd.DatetimeIndex(sorted(pd.to_datetime(daily["date"]).unique()))
    if bhav_dates.empty:
        return pd.DataFrame(columns=daily.columns), [
            GuardResult(
                guard="session_calendar",
                severity=GuardSeverity.F,
                message="daily.parquet has no rows",
            )
        ]

    upper = min(tri_dates.max(), bhav_dates.max())
    tri_bounded = tri_dates[tri_dates <= upper].sort_values()
    missing = tri_bounded.difference(bhav_dates)

    if missing.empty:
        return pd.DataFrame(columns=daily.columns), [
            GuardResult(
                guard="session_calendar",
                severity=GuardSeverity.G,
                message=f"session calendar matches TRI date set ({len(tri_bounded)} sessions)",
            )
        ]

    tri_pos = {d: i for i, d in enumerate(tri_bounded)}
    missing_sorted = list(missing.sort_values())
    groups: list[list[pd.Timestamp]] = [[missing_sorted[0]]]
    for d in missing_sorted[1:]:
        if tri_pos[d] == tri_pos[groups[-1][-1]] + 1:
            groups[-1].append(d)
        else:
            groups.append([d])

    guard_results: list[GuardResult] = []
    synthetic_rows: list[dict] = []
    daily_by_date = {
        ts: grp for ts, grp in daily.assign(_dt=pd.to_datetime(daily["date"])).groupby("_dt")
    }

    for g in groups:
        if len(g) > 1:
            guard_results.append(
                GuardResult(
                    guard="session_calendar",
                    severity=GuardSeverity.F,
                    message=f"{len(g)} consecutive missing sessions: {g[0].date()}..{g[-1].date()}",
                )
            )
            continue

        gap_date = g[0]
        pos = tri_pos[gap_date]
        if pos == 0 or pos + 1 >= len(tri_bounded):
            guard_results.append(
                GuardResult(
                    guard="session_calendar",
                    severity=GuardSeverity.F,
                    message=(
                        f"missing session {gap_date.date()} at the edge of the TRI range; "
                        "cannot synthesise"
                    ),
                )
            )
            continue
        prev_date, next_date = tri_bounded[pos - 1], tri_bounded[pos + 1]
        prev_rows = daily_by_date.get(prev_date)
        next_rows = daily_by_date.get(next_date)
        if prev_rows is None or next_rows is None:
            guard_results.append(
                GuardResult(
                    guard="session_calendar",
                    severity=GuardSeverity.F,
                    message=(
                        f"missing session {gap_date.date()}: neighbouring session also "
                        "absent, cannot synthesise"
                    ),
                )
            )
            continue

        prev_by_symbol = prev_rows.set_index("symbol")
        next_by_symbol = next_rows.set_index("symbol")
        common = prev_by_symbol.index.intersection(next_by_symbol.index)
        for sym in common:
            prev_close = float(prev_by_symbol.loc[sym, "close"])
            close_val = float(next_by_symbol.loc[sym, "prevclose"])
            synthetic_rows.append(
                {
                    "date": gap_date.date(),
                    "symbol": sym,
                    "series": prev_by_symbol.loc[sym, "series"],
                    "isin": prev_by_symbol.loc[sym, "isin"],
                    "open": close_val,
                    "high": close_val,
                    "low": close_val,
                    "close": close_val,
                    "prevclose": prev_close,
                    "volume": 0,
                    "turnover": 0.0,
                    "synthetic_close": True,
                }
            )
        guard_results.append(
            GuardResult(
                guard="session_calendar",
                severity=GuardSeverity.G,
                message=f"synthetic_close inserted for {gap_date.date()}: {len(common)} symbols",
                session=str(gap_date.date()),
            )
        )

    synth_df = (
        pd.DataFrame(synthetic_rows, columns=list(daily.columns))
        if synthetic_rows
        else pd.DataFrame(columns=daily.columns)
    )
    return synth_df, guard_results


def _write_daily_parquet(daily: pd.DataFrame, path: Path) -> None:
    ordered = daily[[f.name for f in schemas.DAILY_SCHEMA]].reset_index(drop=True)
    table = pa.Table.from_pandas(ordered, schema=schemas.DAILY_SCHEMA, preserve_index=False)
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink)
    atomic_write_bytes(path, sink.getvalue().to_pybytes())


# --------------------------------------------------------------------------
# Exit rule (plan.md §9)
# --------------------------------------------------------------------------


def compute_last_trade(daily_resolved: pd.DataFrame, companies: pd.DataFrame) -> pd.DataFrame:
    """last_trade.csv: company_id, last_session, last_close -- every ever-member's
    actual last traded session and close (plan.md §9's exit rule: "a company
    whose symbol stops trading, with no alias continuation, is valued to its
    last traded close"). Harmless for a still-actively-traded company (its
    "last session" is simply the most recent date in the dataset); the file's
    only real consumers are companies whose trading genuinely ended.
    """
    rows = []
    for company_id in companies["company_id"]:
        comp_rows = daily_resolved[daily_resolved["company_id"] == company_id]
        if comp_rows.empty:
            continue
        last_idx = pd.to_datetime(comp_rows["date"]).idxmax()
        rows.append(
            {
                "company_id": company_id,
                "last_session": comp_rows.loc[last_idx, "date"],
                "last_close": comp_rows.loc[last_idx, "close"],
            }
        )
    return pd.DataFrame(rows, columns=["company_id", "last_session", "last_close"])


# --------------------------------------------------------------------------
# CA event diff / baseline (plan.md §2 "Reproducibility")
# --------------------------------------------------------------------------


def diff_ca_events(events: pd.DataFrame, baseline: pd.DataFrame | None) -> pd.DataFrame:
    """Compare this run's events (member companies only) against
    curated/events_baseline.csv.gz. Diff key = (company_id, ex_date,
    subject_sha1); compared values = factor/dividend (plan.md §2), plus
    symbol_at_ex purely to detect a symbol/ISIN-only change: if factor and
    dividend are unchanged but symbol_at_ex differs, that is a `re-key` report
    row (never a `changed`/F-eligible row, per plan.md: "a change to a row's
    symbol or ISIN alone is a report-only re-key, never a failure"). Returns a
    DataFrame with columns (company_id, ex_date, subject_sha1, change, detail,
    age_days); empty if there is no baseline to compare against (first run) or
    nothing changed.
    """
    key_cols = ["company_id", "ex_date", "subject_sha1"]
    cur = events[[*key_cols, "kind", "factor", "dividend", "symbol_at_ex"]].copy()
    cur["ex_date"] = cur["ex_date"].astype(str)
    cur = cur.drop_duplicates(subset=key_cols)

    if baseline is None:
        return pd.DataFrame(
            columns=["company_id", "ex_date", "subject_sha1", "change", "detail", "age_days"]
        )

    base = baseline.copy()
    base["ex_date"] = base["ex_date"].astype(str)
    base["factor"] = pd.to_numeric(base["factor"], errors="coerce")
    base["dividend"] = pd.to_numeric(base["dividend"], errors="coerce")
    if "symbol_at_ex" not in base.columns:
        base["symbol_at_ex"] = None
    base = base.drop_duplicates(subset=key_cols)

    merged = cur.merge(
        base, on=key_cols, how="outer", suffixes=("_cur", "_base"), indicator="merge_ind"
    )

    today = date.today()
    rows = []
    for r in merged.itertuples(index=False):
        age_days = (today - date.fromisoformat(r.ex_date)).days
        if r.merge_ind == "left_only":
            change = "added"
            detail = f"kind={r.kind_cur} factor={r.factor_cur} dividend={r.dividend_cur}"
        elif r.merge_ind == "right_only":
            change = "removed"
            detail = f"kind={r.kind_base} factor={r.factor_base} dividend={r.dividend_base}"
        else:
            factor_changed = not _close_or_both_nan(r.factor_cur, r.factor_base)
            dividend_changed = not _close_or_both_nan(r.dividend_cur, r.dividend_base)
            symbol_changed = r.symbol_at_ex_cur != r.symbol_at_ex_base
            if not (factor_changed or dividend_changed or symbol_changed):
                continue
            if not (factor_changed or dividend_changed) and symbol_changed:
                change = "re-key"
                detail = f"symbol_at_ex {r.symbol_at_ex_base} -> {r.symbol_at_ex_cur}"
                rows.append(
                    {
                        "company_id": r.company_id,
                        "ex_date": r.ex_date,
                        "subject_sha1": r.subject_sha1,
                        "change": change,
                        "detail": detail,
                        "age_days": age_days,
                    }
                )
                continue
            change = "changed"
            detail = (
                f"factor {r.factor_base}->{r.factor_cur}, "
                f"dividend {r.dividend_base}->{r.dividend_cur}"
            )
        rows.append(
            {
                "company_id": r.company_id,
                "ex_date": r.ex_date,
                "subject_sha1": r.subject_sha1,
                "change": change,
                "detail": detail,
                "age_days": age_days,
            }
        )
    return pd.DataFrame(
        rows, columns=["company_id", "ex_date", "subject_sha1", "change", "detail", "age_days"]
    )


def _close_or_both_nan(a, b) -> bool:
    a_nan = a is None or (isinstance(a, float) and pd.isna(a))
    b_nan = b is None or (isinstance(b, float) and pd.isna(b))
    if a_nan and b_nan:
        return True
    if a_nan != b_nan:
        return False
    return abs(float(a) - float(b)) < 1e-9


# --------------------------------------------------------------------------
# Raw manifest (bhavcopy zips + CA/benchmark snapshots actually used)
# --------------------------------------------------------------------------


def compute_raw_manifest(raw_dir: Path, daily_manifest_path: Path | None = None) -> pd.DataFrame:
    """One row per raw file this run actually read (file, fetched_at, zip_sha256,
    content_sha256, rows) -- bhavcopy zips (from bhavcopy_manifest.csv's `ok`
    rows), CA feed snapshots, and benchmark snapshots. `content_sha256` is the
    hash of the *decompressed* payload (or the raw bytes for a non-zip file), so
    an NSE re-zip with different timestamps doesn't show as a changed file
    (plan.md §2).
    """
    import csv

    rows: list[dict] = []

    manifest_path = daily_manifest_path or (raw_dir / "bhavcopy_manifest.csv")
    if manifest_path.exists():
        with manifest_path.open(newline="") as f:
            for r in csv.DictReader(f):
                if r.get("status") != "ok" or not r.get("file"):
                    continue
                path = raw_dir / "bhavcopy" / r["file"]
                if not path.exists():
                    path = raw_dir / r["file"]
                if not path.exists():
                    continue
                zip_bytes = path.read_bytes()
                try:
                    content = extract_single_member(zip_bytes)
                except Exception:  # noqa: BLE001 - a corrupt file is still reported, not fatal
                    content = b""
                rows.append(
                    {
                        "file": path.name,
                        "fetched_at": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
                        "zip_sha256": hashlib.sha256(zip_bytes).hexdigest(),
                        "content_sha256": hashlib.sha256(content).hexdigest(),
                        "rows": max(content.count(b"\n") - 1, 0),
                    }
                )

    ca_dir = raw_dir / "corporate_actions"
    for path in sorted(ca_dir.glob("ca_*.json")):
        content = path.read_bytes()
        try:
            n_rows = len(json.loads(content))
        except json.JSONDecodeError:
            n_rows = 0
        rows.append(
            {
                "file": f"corporate_actions/{path.name}",
                "fetched_at": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
                "zip_sha256": "",
                "content_sha256": hashlib.sha256(content).hexdigest(),
                "rows": n_rows,
            }
        )

    bench_dir = raw_dir / "benchmarks"
    if bench_dir.exists():
        for path in sorted(bench_dir.iterdir()):
            if not path.is_file():
                continue
            content = path.read_bytes()
            if path.suffix == ".json":
                try:
                    n_rows = len(json.loads(content))
                except json.JSONDecodeError:
                    n_rows = 0
            else:
                n_rows = max(content.count(b"\n") - 1, 0)
            rows.append(
                {
                    "file": f"benchmarks/{path.name}",
                    "fetched_at": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
                    "zip_sha256": "",
                    "content_sha256": hashlib.sha256(content).hexdigest(),
                    "rows": n_rows,
                }
            )

    return pd.DataFrame(
        rows, columns=["file", "fetched_at", "zip_sha256", "content_sha256", "rows"]
    )


def diff_raw_manifest(
    manifest: pd.DataFrame, pinned: pd.DataFrame, member_session_files: set[str]
) -> list[GuardResult]:
    """Compare `manifest`'s content hashes against curated/raw_manifest.pinned.csv
    (plan.md §2). A changed content hash for a file tied to a member-session
    bhavcopy is F; any other change is G. `member_session_files` is the set of
    bhavcopy filenames covering at least one member-period session -- computed by
    the caller, since this function has no membership context.
    """
    if pinned.empty:
        return []
    pinned_by_file = pinned.set_index("file")["content_sha256"].to_dict()
    results: list[GuardResult] = []
    for row in manifest.itertuples(index=False):
        old_hash = pinned_by_file.get(row.file)
        if old_hash is None or old_hash == row.content_sha256:
            continue
        severity = GuardSeverity.F if row.file in member_session_files else GuardSeverity.G
        results.append(
            GuardResult(
                guard="raw_manifest",
                severity=severity,
                message=f"content hash changed for {row.file}: {old_hash} -> {row.content_sha256}",
            )
        )
    return results


# --------------------------------------------------------------------------
# Weekly / benchmark outputs
# --------------------------------------------------------------------------


def _weekly_wide(adjusted: pd.DataFrame, value_col: str) -> pd.DataFrame:
    wide = adjusted.pivot_table(
        index="date", columns="company_id", values=value_col, aggfunc="last"
    )
    wide.index = pd.to_datetime(wide.index)
    return wide.sort_index().resample("W-FRI").last()


def build_weekly_outputs(adjusted: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """nifty50_weekly_tr / nifty50_weekly_price: week x company_id, Friday-labelled
    (via the same W-FRI last-of-week resample sources.weekly uses), NaN outside a
    company's listing life -- the natural result of pivoting `adjusted` (which
    only has rows for a company's actual trading dates) before resampling.
    """
    tr = _weekly_wide(adjusted, "total_return_factor")
    price = _weekly_wide(adjusted, "price_only_factor")
    return tr, price


def build_membership_weekly(
    membership: pd.DataFrame, market_dates: pd.DatetimeIndex
) -> pd.DataFrame:
    """nifty50_membership_weekly.csv: week x company_id boolean, investable rows
    only -- "a week counts if the company is a member at that week's last
    session" (plan.md acceptance criteria). The week's "last session" is the
    actual last *trading* date in that week (from `market_dates`), not literally
    the calendar Friday, so a week ending in a holiday still resolves to a real
    session.
    """
    sessions = pd.Series(market_dates, index=market_dates).sort_index()
    week_last_session = sessions.resample("W-FRI").last()

    m = membership[membership["kind"] == "investable"].copy()
    m["from_ts"] = pd.to_datetime(m["from"])
    m["to_ts"] = pd.to_datetime(m["to"])

    company_ids = sorted(m["company_id"].unique())
    out = pd.DataFrame(index=week_last_session.index, columns=company_ids, dtype="boolean")
    out[:] = False
    for row in m.itertuples(index=False):
        for week_label, last_session in week_last_session.items():
            if pd.isna(last_session):
                continue
            if row.from_ts <= last_session and (pd.isna(row.to_ts) or last_session <= row.to_ts):
                out.loc[week_label, row.company_id] = True
    return out


def build_benchmarks_weekly(raw_dir: Path) -> pd.DataFrame:
    """benchmarks_weekly.csv: Nifty 50 TRI, Nifty200 Momentum 30 TRI (+
    back_calculated flag), Nifty50 Equal Weight TRI -- parsed from the already-
    downloaded raw_dir/benchmarks/*.json via the same parsers benchmarks.py's
    fetch_tri wraps (sources.parse_niftyindices_tri), just fed local files so no
    network call is made (plan.md acceptance criteria).
    """
    from momentum_backtesting.sources import weekly

    nifty50 = load_tri_local(raw_dir, "NIFTY_50_TRI.json")
    momentum30 = load_tri_local(raw_dir, "NIFTY200_MOMENTUM_30_TRI.json")
    ew = load_tri_local(raw_dir, "NIFTY50_EQUAL_WEIGHT_TRI.json")

    back_calc = benchmarks.is_back_calculated(momentum30.index)

    out = pd.DataFrame(
        {
            "nifty50_tri": weekly(nifty50),
            "nifty200_momentum30_tri": weekly(momentum30),
            "nifty50_ew_tri": weekly(ew),
        }
    )
    out["nifty200_momentum30_back_calculated"] = (
        weekly(back_calc.astype(float)).round().astype("boolean")
    )
    extra = build_extra_benchmarks_weekly(raw_dir)
    return out.join(extra, how="outer") if not extra.empty else out


def build_extra_benchmarks_weekly(raw_dir: Path, as_of: date | None = None) -> pd.DataFrame:
    """The comparison-only TRI columns (benchmarks.EXTRA_TRI_INDICES) as Friday-labelled weekly
    closes, from whichever raw_dir/benchmarks/*.json snapshots exist - a missing file just means
    that column is absent (never an error; the series are optional everywhere downstream).

    Weeks labelled after `as_of` (default today) are dropped: `weekly()` labels a part-week by
    its coming Friday, and a half-finished week must not read as a completed weekly close.
    """
    from momentum_backtesting.sources import weekly

    cutoff = pd.Timestamp(as_of or date.today())
    columns = {}
    for column, (_name, filename) in benchmarks.EXTRA_TRI_INDICES.items():
        if not (raw_dir / "benchmarks" / filename).exists():
            continue
        series = weekly(load_tri_local(raw_dir, filename))
        columns[column] = series[series.index <= cutoff]
    return pd.DataFrame(columns)


def merge_extra_benchmarks_csv(data_dir: Path, as_of: date | None = None) -> pd.DataFrame:
    """Add (or refresh) only the comparison-only TRI columns in data_dir/benchmarks_weekly.csv
    from the raw snapshots, leaving every other column as it was. Returns the extra columns."""
    extra = build_extra_benchmarks_weekly(data_dir / "raw", as_of)
    if extra.empty:
        return extra
    path = data_dir / "benchmarks_weekly.csv"
    existing = pd.read_csv(path, index_col=0, parse_dates=True)
    kept = existing.drop(columns=[c for c in extra.columns if c in existing.columns])
    kept.join(extra, how="outer").to_csv(path)
    return extra


# --------------------------------------------------------------------------
# build_all -- the single entry point (T8's CLI calls this)
# --------------------------------------------------------------------------


@dataclass
class BuildReport:
    guard_results: list[GuardResult]
    event_counts: dict[str, int]
    ca_diff: pd.DataFrame
    baseline_created: bool
    elapsed_seconds: float
    outputs_written: list[str]
    cash_weekly_skipped: str | None = None

    def n_failures(self) -> int:
        return sum(1 for g in self.guard_results if g.severity == GuardSeverity.F)


def _write_fetch_report(rows: list[GuardResult], path: Path) -> None:
    df = pd.DataFrame(
        [
            {
                "guard": r.guard,
                "severity": r.severity.value,
                "company_id": r.company_id or "",
                "session": r.session or "",
                "message": r.message,
            }
            for r in rows
        ],
        columns=["guard", "severity", "company_id", "session", "message"],
    )
    df.to_csv(path, index=False)


def build_all(data_dir: Path, curated_dir: Path, accept_ca_diff: Path | None = None) -> BuildReport:
    """End-to-end pipeline (plan.md §7 T6): company resolution, event parsing/
    attachment, return computation, every plan.md §3 guard, and every
    data/stocks/ output -- entirely from the already-downloaded raw cache
    (`data_dir/raw/`), with no network access except the optional cash NAV
    backfill (which degrades to a G guard + a skipped output on failure, never a
    hard failure of the run).

    `accept_ca_diff`, if given, is a CSV of previously-reviewed (company_id,
    ex_date, subject_sha1) rows: a diff older than 30 days matching one of these
    keys does not fail the run, and the baseline is advanced to this run's
    events afterwards (plan.md §2: "the accepted state moves forward").
    """
    start = time.monotonic()
    raw_dir = data_dir / "raw"
    daily_path = data_dir / "daily.parquet"

    curated = load_curated(curated_dir)
    aliases = curated["aliases.csv"]
    membership = curated["nifty50_membership.csv"]
    companies = curated["companies.csv"]
    actions_manual = curated["actions_manual.csv"]
    crash_allowlist = curated["crash_allowlist.csv"]
    continuity_exceptions = curated["continuity_exceptions.csv"]
    no_ca_rows = curated["no_ca_rows.csv"]

    guard_results: list[GuardResult] = []

    daily = pd.read_parquet(daily_path)

    # 1. Session calendar + synthetic_close fill.
    tri_series = load_tri_local(raw_dir, "NIFTY_50_TRI.json")
    synthetic_rows, calendar_guards = fill_session_calendar(daily, tri_series.index)
    guard_results.extend(calendar_guards)
    outputs_written: list[str] = []
    if not synthetic_rows.empty:
        daily = pd.concat([daily, synthetic_rows], ignore_index=True)
        daily = daily.sort_values(["symbol", "date"]).reset_index(drop=True)
        _write_daily_parquet(daily, daily_path)
        outputs_written.append(str(daily_path))

    # 2. Company resolution.
    daily["company_id"] = resolve_daily_companies(daily, aliases)
    isin_to_company, symbol_to_company_latest = build_ca_lookups(daily, aliases)

    # 3. Events: feed + manual, combined.
    ca_raw = load_ca_feed_local(raw_dir)
    feed_result = build_feed_events(ca_raw, isin_to_company, symbol_to_company_latest, aliases)
    guard_results.extend(feed_result.report_rows)
    manual_events = build_manual_events(actions_manual)
    combined_events = combine_manual_over_feed(feed_result.events, manual_events, aliases)

    # 4. Attach events to sessions (tolerant: collects F rather than raising).
    attached_events, attach_failures = attach_events_tolerant(combined_events, daily)
    guard_results.extend(attach_failures)

    # 5. Unresolved manual-only events for a member company -> F (guards.py).
    #    (checked below via guards.check_unparsed_subjects, over `attached_events`)

    # 6. Adjust: per-company return series.
    adjusted = build(daily, attached_events, aliases, membership)

    # 7. Exit rule.
    last_trade = compute_last_trade(daily[daily["company_id"].notna()], companies)

    # 8. Guards.
    from momentum_backtesting.stocks import guards as guards_mod

    current_symbols_path = raw_dir / "nifty50_current.csv"
    current_symbols = (
        set(pd.read_csv(current_symbols_path)["Symbol"]) if current_symbols_path.exists() else None
    )

    accepted_df = pd.read_csv(accept_ca_diff) if accept_ca_diff else None
    fetch_report_so_far = pd.DataFrame(
        [
            {
                "guard": r.guard,
                "severity": r.severity.value,
                "company_id": r.company_id,
                "session": r.session,
                "message": r.message,
            }
            for r in guard_results
        ]
    )
    guard_results.extend(
        guards_mod.run_all(
            adjusted,
            attached_events,
            membership,
            aliases,
            {
                "crash_allowlist.csv": crash_allowlist,
                "continuity_exceptions.csv": continuity_exceptions,
                "no_ca_rows.csv": no_ca_rows,
                "actions_manual.csv": actions_manual,
                "nifty50_current_symbols": current_symbols,
            },
            fetch_report_so_far,
        )
    )

    # 9. CA diff / baseline lifecycle.
    baseline = _load_events_baseline(curated_dir)
    baseline_created = baseline is None
    ca_diff = diff_ca_events(attached_events, baseline)
    guard_results.extend(guards_mod.check_ca_diff_age(ca_diff, accepted_df))

    if baseline_created:
        _write_events_baseline(curated_dir, attached_events, membership)
        guard_results.append(
            GuardResult(guard="ca_diff", severity=GuardSeverity.G, message="baseline created")
        )
    elif accept_ca_diff is not None:
        _write_events_baseline(curated_dir, attached_events, membership)
        guard_results.append(
            GuardResult(
                guard="ca_diff", severity=GuardSeverity.G, message="baseline advanced (accepted)"
            )
        )

    # 10. Raw manifest vs pinned (if a pinned manifest is committed).
    raw_manifest = compute_raw_manifest(raw_dir)
    pinned_path = curated_dir / "raw_manifest.pinned.csv"
    if pinned_path.exists():
        pinned = pd.read_csv(pinned_path, dtype=str)
        member_files = (
            set()
        )  # best-effort: without a bhavcopy-file<->session map here, leave empty (G only)
        guard_results.extend(diff_raw_manifest(raw_manifest, pinned, member_files))

    # 11. Outputs.
    data_dir.mkdir(parents=True, exist_ok=True)

    events_out = attached_events.copy()
    if not events_out.empty:
        events_out = events_out[
            [
                "company_id",
                "symbol_at_ex",
                "session",
                "ex_date",
                "kind",
                "factor",
                "dividend",
                "source",
                "subject_sha1",
            ]
        ]
        events_table = pa.Table.from_pandas(
            events_out, schema=schemas.EVENTS_SCHEMA, preserve_index=False
        )
    else:
        events_table = schemas.EVENTS_SCHEMA.empty_table()
    sink = pa.BufferOutputStream()
    pq.write_table(events_table, sink)
    events_path = data_dir / "events.parquet"
    atomic_write_bytes(events_path, sink.getvalue().to_pybytes())
    outputs_written.append(str(events_path))

    weekly_tr, weekly_price = build_weekly_outputs(adjusted)
    weekly_tr.to_csv(data_dir / "nifty50_weekly_tr.csv")
    weekly_price.to_csv(data_dir / "nifty50_weekly_price.csv")
    outputs_written += [
        str(data_dir / "nifty50_weekly_tr.csv"),
        str(data_dir / "nifty50_weekly_price.csv"),
    ]

    market_dates = pd.DatetimeIndex(sorted(pd.to_datetime(daily["date"]).unique()))
    membership_weekly = build_membership_weekly(membership, market_dates)
    membership_weekly.to_csv(data_dir / "nifty50_membership_weekly.csv")
    outputs_written.append(str(data_dir / "nifty50_membership_weekly.csv"))

    last_trade.to_csv(data_dir / "last_trade.csv", index=False)
    outputs_written.append(str(data_dir / "last_trade.csv"))

    benchmarks_weekly = build_benchmarks_weekly(raw_dir)
    benchmarks_weekly.to_csv(data_dir / "benchmarks_weekly.csv")
    outputs_written.append(str(data_dir / "benchmarks_weekly.csv"))

    cash_weekly_skipped = None
    try:
        cash_series, ratio = benchmarks.cash_weekly(date(2011, 1, 1))
        cash_series.to_frame("close").to_csv(data_dir / "cash_weekly.csv", index_label="date")
        outputs_written.append(str(data_dir / "cash_weekly.csv"))
        guard_results.append(
            GuardResult(
                guard="cash_weekly",
                severity=GuardSeverity.G,
                message=f"cash_weekly built, splice level ratio={ratio:.6f}",
            )
        )
    except Exception as e:  # noqa: BLE001 - network/data failure degrades to a flag, never fatal
        cash_weekly_skipped = str(e)
        guard_results.append(
            GuardResult(
                guard="cash_weekly",
                severity=GuardSeverity.G,
                message=f"cash_weekly skipped: {e}",
            )
        )

    raw_manifest.to_csv(data_dir / "raw_manifest.csv", index=False)
    outputs_written.append(str(data_dir / "raw_manifest.csv"))

    _write_fetch_report(guard_results, data_dir / "fetch_report.csv")
    outputs_written.append(str(data_dir / "fetch_report.csv"))

    event_counts: dict[str, int] = {}
    if not attached_events.empty:
        for (kind, source), n in attached_events.groupby(["kind", "source"]).size().items():
            event_counts[f"{kind}/{source}"] = int(n)

    return BuildReport(
        guard_results=guard_results,
        event_counts=event_counts,
        ca_diff=ca_diff,
        baseline_created=baseline_created,
        elapsed_seconds=time.monotonic() - start,
        outputs_written=outputs_written,
        cash_weekly_skipped=cash_weekly_skipped,
    )
