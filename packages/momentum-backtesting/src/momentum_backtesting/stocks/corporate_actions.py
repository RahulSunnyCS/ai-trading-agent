"""Fetch NSE's whole-market corporate-actions feed and parse subjects into typed events.

The feed (plan.md §1) re-keys all history to the *current* symbol/ISIN/face-value —
TATAMOTORS shows as TMPV, an old split row shows today's face value, etc. That makes
company resolution unsafe to do here: this module only fetches and parses; adjust.py
(T6) is where a parsed event gets attached to a company_id and session.

Automatic parsing (plan.md §2) covers exactly three kinds — bonus a:b, split/
sub-division/consolidation, and Rs/Re dividend amounts — via anchored regexes,
subject capped at 500 chars. Everything else (rights, demerger, scheme of
arrangement, bonus debentures, preference shares, capital reduction, amount-less
dividends, combined dividend+bonus subjects, %-of-face-value dividends) comes back
tagged MANUAL_ONLY for actions_manual.csv (T5) to cover, cited, by hand — this
module never guesses a factor or dividend for those.

Implemented (T2) against the T0 stubs in nse.py / schemas.py.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Iterator
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

from momentum_backtesting.stocks.nse import NseClient
from momentum_backtesting.stocks.schemas import EventKind, ParsedEvent

CA_API_URL = "https://www.nseindia.com/api/corporates-corporateActions"

#: Referer NSE's bot-detection expects for the corporate-actions feed (plan.md §1).
CA_REFERER = "https://www.nseindia.com/companies-listing/corporate-filings-actions"

#: Subjects longer than this are truncated before parsing/hashing (plan.md §2) —
#: a defence against a pathological feed row, not an expected case.
MAX_SUBJECT_CHARS = 500

#: Fields every CA feed row must carry (plan.md §1's verified shape). A row missing
#: any of these fails the schema check in fetch_snapshot rather than being silently
#: half-used downstream.
REQUIRED_FIELDS = ("symbol", "series", "isin", "faceVal", "exDate", "recDate", "subject")

#: The row columns fetch_snapshot returns, in a fixed order (plan.md: "output keyed
#: by feed symbol + isin + snapshot date" — no company resolution happens here).
OUTPUT_COLUMNS = (*REQUIRED_FIELDS, "comp")

# --------------------------------------------------------------------------
# Date parsing — fixed English month map, never `%b` (plan.md §2, QA F04): a
# non-English/Indic system locale silently breaks strptime's %b, not raises.
# --------------------------------------------------------------------------

_MONTH_ABBR = {
    "Jan": 1,
    "Feb": 2,
    "Mar": 3,
    "Apr": 4,
    "May": 5,
    "Jun": 6,
    "Jul": 7,
    "Aug": 8,
    "Sep": 9,
    "Oct": 10,
    "Nov": 11,
    "Dec": 12,
}


def parse_ca_date(value: str | None) -> date | None:
    """Parse an NSE CA-feed date string (`DD-Mon-YYYY`, e.g. `03-Jan-2011`).

    Returns None for the feed's own "no value" placeholder (`-`, empty, or None).
    Uses a fixed English month-abbreviation map rather than `strptime("%b")`, which
    is locale-dependent and silently parses wrong (or raises) under a non-English
    system locale (QA F04).
    """
    if not value or value == "-":
        return None
    parts = value.strip().split("-")
    if len(parts) != 3:
        raise ValueError(f"unrecognised CA date {value!r}: expected DD-Mon-YYYY")
    day_str, mon_str, year_str = parts
    month = _MONTH_ABBR.get(mon_str.strip().title())
    if month is None:
        raise ValueError(f"unrecognised month abbreviation {mon_str!r} in CA date {value!r}")
    return date(int(year_str), month, int(day_str))


# --------------------------------------------------------------------------
# Subject classification regexes (plan.md §2). Case-insensitive; applied to the
# subject *after* truncation to MAX_SUBJECT_CHARS so a pathological row can't
# blow up regex time or hash a different string than what a human reviewer sees.
# --------------------------------------------------------------------------

_SCHEME_RE = re.compile(r"scheme\s+of\b", re.IGNORECASE)
_DEMERGER_RE = re.compile(r"\bdemerger\b", re.IGNORECASE)
_RIGHTS_RE = re.compile(r"\brights\b", re.IGNORECASE)
_CAPITAL_REDUCTION_RE = re.compile(r"capital\s+reduction", re.IGNORECASE)
_DEBENTURE_OR_PREFERENCE_RE = re.compile(r"debenture|preference|\bncrps\b", re.IGNORECASE)
_BONUS_WORD_RE = re.compile(r"\bbonus\b", re.IGNORECASE)
_SPLIT_WORD_RE = re.compile(
    r"face\s+value\s+split|sub-division|sub\s+division|consolidation|\bfv\s+splt\b",
    re.IGNORECASE,
)
# The feed itself carries real typos for this word ("Divdend", "Dividned", "Divided",
# "Dividiend") and sometimes glues it straight onto the previous clause with no space
# ("...Meetingdividend..."), so the match is intentionally not anchored on the left
# with \b and tolerates the observed misspellings rather than silently dropping a
# real dividend event (found in ca_2011.json..ca_2026.json across 2011-2026).
_DIVIDEND_WORD_RE = re.compile(
    r"dividend|divdend|divided|dividned|dividiend|\bdiv\b", re.IGNORECASE
)

# Equity bonus ratio, e.g. "Bonus 1:1", "Bonus  1:4", "Bonus 1: 1", "Bonus 25:202".
_BONUS_RATIO_RE = re.compile(r"\bbonus\b\s*(\d+)\s*:\s*(\d+)", re.IGNORECASE)

# Face-value split/sub-division/consolidation, e.g. "From Rs 10/- Per Share To Rs
# 2/- Per Share", "Rs.10/- To Re.1/-", "From Re 1 Per Share To Rs 10 Per Share".
# Matches the "from" and "to" face values regardless of whether "From"/"Per Share"
# literally appear — only the two Rs|Re amounts either side of "To" are required.
_SPLIT_RE = re.compile(
    r"R[se]\.?\s*(\d+(?:\.\d+)?)\s*/?-?\s*(?:Per\s+Share\s*)?to\s+R[se]\.?\s*(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)

# Every Rs|Re|Rs. amount, e.g. "Rs 22", "Rs.70/-", "Re 0.20", "Re.0.10". Anchored on
# a leading word boundary so it never matches inside "Per", "Revised", "Record" etc.
_DIVIDEND_AMOUNT_RE = re.compile(r"\bR[se]\.?\s*(\d+(?:\.\d+)?)", re.IGNORECASE)

# A %-of-face-value annotation with no Rs/Re amount alongside it, e.g. "@ 12%" or
# "(22.5%)" used purely as an informational note is *not* this — that case still has
# a Rs/Re amount and is parsed normally. This only fires when no amount was found.
_PERCENT_RE = re.compile(r"@?\s*\(?\s*(\d+(?:\.\d+)?)\s*%\s*\)?", re.IGNORECASE)


def normalise_subject(subject: str) -> str:
    """Collapse whitespace and case for stable hashing/matching. Truncates to
    MAX_SUBJECT_CHARS first (plan.md §2).
    """
    truncated = subject[:MAX_SUBJECT_CHARS]
    return re.sub(r"\s+", " ", truncated).strip().lower()


def subject_sha1(subject: str) -> str:
    """sha1 hex digest of normalise_subject(subject) — the second half of the
    fetch_report.csv diff key `(company_id, ex_date, sha1(normalised subject))`
    (plan.md §2).
    """
    return hashlib.sha1(normalise_subject(subject).encode("utf-8")).hexdigest()  # noqa: S324


def _manual(note: str, *, dividend_basis: str | None = None) -> ParsedEvent:
    return ParsedEvent(
        kind=EventKind.MANUAL_ONLY,
        factor=None,
        dividend=None,
        dividend_basis=dividend_basis,
        note=note,
    )


def parse_subject(subject: str, face_value: float) -> list[ParsedEvent]:
    """Parse one CA subject string into zero or more ParsedEvent rows.

    `face_value` is the row's current (re-keyed) faceVal. It is accepted for the
    signature plan.md §2 specifies but is not needed to compute a split factor here:
    every real split/sub-division/consolidation subject observed in the feed states
    both the "from" and "to" face values inline (`_SPLIT_RE`), so the factor is
    derived from the subject text alone rather than from the row's own (re-keyed,
    and therefore only ever "to"-side-correct) faceVal.

    Recognises, via anchored regexes:
      - equity bonus `a:b` -> factor = b/(a+b); rejected (-> MANUAL_ONLY) if the
        subject mentions Debenture, Preference, or Ncrps (plan.md §2);
      - split / sub-division / consolidation (face value X->Y) -> factor = Y/X;
      - dividend: every `Rs|Re|Rs.` amount in a dividend clause, summed into one
        ParsedEvent(kind=DIVIDEND, dividend=...).

    Same-date bonus+split rows are returned as two ParsedEvents when a *single*
    subject string states both (e.g. "Bonus 1:1/Face Value Split ..."). Two
    *separate* same-date CA rows (e.g. BAJFINANCE 2025-06-16's "Bonus 4:1" row and
    its "Face Value Split ..." row) each go through parse_subject independently and
    each yields one ParsedEvent; combining same-date rows across the feed is T6's
    job (QA C12), not this function's.

    Subjects carrying no price-affecting corporate action at all (plain "Annual
    General Meeting", "Postal Ballot", etc., alone or as noise alongside a real
    clause already extracted) contribute nothing and are not returned as an event.

    Anything the regexes don't recognise as bonus/split/dividend (rights, demerger,
    scheme of arrangement, bonus debentures, preference shares, capital reduction,
    amount-less dividends, combined dividend+bonus, %-of-face-value dividends) comes
    back as a single ParsedEvent(kind=MANUAL_ONLY, factor=None, dividend=None,
    note=<why>).
    """
    del face_value  # see docstring: not needed given the feed's own inline values

    s = subject[:MAX_SUBJECT_CHARS]

    has_scheme = bool(_SCHEME_RE.search(s))
    has_demerger = bool(_DEMERGER_RE.search(s))
    has_rights = bool(_RIGHTS_RE.search(s))
    has_capital_reduction = bool(_CAPITAL_REDUCTION_RE.search(s))
    has_debenture_or_pref = bool(_DEBENTURE_OR_PREFERENCE_RE.search(s))
    has_bonus = bool(_BONUS_WORD_RE.search(s))
    has_split = bool(_SPLIT_WORD_RE.search(s))
    has_dividend = bool(_DIVIDEND_WORD_RE.search(s))

    # Priority 1: kinds that are always manual-only regardless of what else the
    # subject also mentions (plan.md §2's explicit manual-only list).
    if has_scheme:
        return [_manual("scheme of arrangement - manual only")]
    if has_demerger:
        return [_manual("demerger - manual only")]
    if has_rights:
        return [_manual("rights issue - manual only")]
    if has_capital_reduction:
        return [_manual("capital reduction - manual only")]
    if has_bonus and has_debenture_or_pref:
        return [_manual("bonus debenture/preference share - manual only")]
    if has_bonus and has_dividend:
        return [_manual("combined dividend+bonus - manual only")]

    events: list[ParsedEvent] = []

    if has_bonus:
        m = _BONUS_RATIO_RE.search(s)
        if not m:
            return [_manual("bonus ratio not recognised - manual only")]
        a, b = int(m.group(1)), int(m.group(2))
        if a + b == 0:
            return [_manual("bonus ratio not recognised - manual only")]
        events.append(ParsedEvent(kind=EventKind.BONUS, factor=b / (a + b), dividend=None))

    if has_split:
        m = _SPLIT_RE.search(s)
        if not m or float(m.group(1)) == 0:
            return [_manual("split face value not recognised - manual only")]
        split_factor = float(m.group(2)) / float(m.group(1))
        events.append(ParsedEvent(kind=EventKind.SPLIT, factor=split_factor, dividend=None))

    if events:
        return events

    if has_dividend:
        amounts = [float(x) for x in _DIVIDEND_AMOUNT_RE.findall(s)]
        if not amounts:
            pct = _PERCENT_RE.search(s)
            basis = f"{pct.group(1)}%" if pct else None
            return [_manual("dividend amount not stated - manual only", dividend_basis=basis)]
        return [ParsedEvent(kind=EventKind.DIVIDEND, factor=None, dividend=round(sum(amounts), 6))]

    return []


# --------------------------------------------------------------------------
# Fetching (plan.md §2 "Reproducibility": "Each run fetches the CA history in
# full, by quarter, into raw/corporate_actions/<fetch-date>/").
# --------------------------------------------------------------------------


def _atomic_write_json(path: Path, data: object) -> None:
    """Write `data` as JSON to `path` via a tmp file + rename (plan.md §5)."""
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp_path, path)


def _validate_row_schema(row: dict) -> None:
    if not isinstance(row, dict):
        raise ValueError(f"CA feed row is not an object: {row!r}")
    missing = [f for f in REQUIRED_FIELDS if f not in row]
    if missing:
        raise ValueError(f"CA feed row missing required fields {missing}: {row!r}")


def fetch_snapshot(
    from_date: date, to_date: date, raw_dir: Path, client: NseClient
) -> pd.DataFrame:
    """Fetch one quarter's corporate-actions rows (`index=equities`) from CA_API_URL
    and write the raw JSON into `raw_dir/corporate_actions/<fetch-date>/`.

    Returns the raw feed rows as a DataFrame (symbol, series, isin, faceVal, exDate,
    recDate, subject) exactly as NSE returns them — unresolved to any company_id.
    Exact duplicate rows (plan.md §2: "14 exact duplicate rows" observed) are
    dropped here since they carry no information the caller needs twice.
    """
    params = {
        "index": "equities",
        "from_date": from_date.strftime("%d-%m-%Y"),
        "to_date": to_date.strftime("%d-%m-%Y"),
    }
    payload = client.get_json(CA_API_URL, params=params, referer=CA_REFERER)

    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
        rows = payload["data"]
    else:
        raise ValueError(f"unexpected CA feed payload shape: {type(payload)!r}")

    for row in rows:
        _validate_row_schema(row)

    fetch_dir = raw_dir / "corporate_actions" / date.today().isoformat()
    fetch_dir.mkdir(parents=True, exist_ok=True)
    out_path = fetch_dir / f"{from_date.isoformat()}_{to_date.isoformat()}.json"
    _atomic_write_json(out_path, rows)

    if rows:
        df = pd.DataFrame(rows, columns=list(OUTPUT_COLUMNS))
    else:
        df = pd.DataFrame(columns=OUTPUT_COLUMNS)
    return df.drop_duplicates(ignore_index=True)


def iter_quarters(start: date, end: date) -> Iterator[tuple[date, date]]:
    """Yield calendar-quarter-aligned `(from_date, to_date)` pairs covering
    `[start, end]`, clipped to that range at both ends.
    """
    if start > end:
        return
    year = start.year
    quarter = (start.month - 1) // 3 + 1
    while True:
        q_start_month = (quarter - 1) * 3 + 1
        q_start = date(year, q_start_month, 1)
        if q_start_month == 10:
            q_end = date(year, 12, 31)
        else:
            q_end = date(year, q_start_month + 3, 1) - timedelta(days=1)

        clipped_start = max(q_start, start)
        clipped_end = min(q_end, end)
        if clipped_start <= clipped_end:
            yield clipped_start, clipped_end

        if q_end >= end:
            return
        quarter += 1
        if quarter > 4:
            quarter = 1
            year += 1


def check_month_completeness(df: pd.DataFrame, quarter_start: date, quarter_end: date) -> list[str]:
    """Return the `YYYY-MM` months within `[quarter_start, quarter_end]` that have
    zero CA rows by `exDate` (plan.md §2 completeness guard, QA F05).
    """
    months = set()
    cursor = date(quarter_start.year, quarter_start.month, 1)
    while cursor <= quarter_end:
        months.add(cursor.strftime("%Y-%m"))
        cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)

    present = set()
    for raw_ex_date in df.get("exDate", []):
        parsed = parse_ca_date(raw_ex_date)
        if parsed is not None:
            present.add(parsed.strftime("%Y-%m"))

    return sorted(months - present)


def fetch_quarter_checked(
    from_date: date, to_date: date, raw_dir: Path, client: NseClient
) -> pd.DataFrame:
    """fetch_snapshot for one quarter, with the completeness guard: if any month in
    the quarter comes back empty, refetch once; if it is still empty, raise
    (plan.md §2/§3, QA F05: "refetch once, then F").
    """
    df = fetch_snapshot(from_date, to_date, raw_dir, client)
    missing = check_month_completeness(df, from_date, to_date)
    if missing:
        df = fetch_snapshot(from_date, to_date, raw_dir, client)
        missing = check_month_completeness(df, from_date, to_date)
        if missing:
            raise ValueError(
                f"CA feed incomplete for {from_date}..{to_date}: "
                f"empty months {missing} after one refetch"
            )
    return df


def _is_dividend_subject(subject: str) -> bool:
    return bool(_DIVIDEND_WORD_RE.search(subject[:MAX_SUBJECT_CHARS]))


def check_dividend_year_counts(df: pd.DataFrame) -> list[str]:
    """Check each year's dividend-subject row count against the mean of its
    immediate neighbouring years, where both neighbours are present in `df` (plan.md
    §2/§3, QA F05: "dividend rows per year within ±30% of the neighbours' mean").

    Boundary years (no earlier or no later neighbour in `df` — e.g. 2011, or the
    current partial year) are skipped rather than flagged: there is nothing to
    compare them against. Returns a list of human-readable problem descriptions;
    empty means the guard passed.
    """
    subjects = df.get("subject", pd.Series(dtype=str))
    ex_dates = df.get("exDate", pd.Series(dtype=str))
    is_dividend = subjects.map(_is_dividend_subject)
    years = ex_dates[is_dividend].map(parse_ca_date).dropna().map(lambda d: d.year)

    counts: dict[int, int] = years.value_counts().to_dict()
    problems = []
    for year in sorted(counts):
        prev_count = counts.get(year - 1)
        next_count = counts.get(year + 1)
        if prev_count is None or next_count is None:
            continue
        neighbour_mean = (prev_count + next_count) / 2
        if neighbour_mean == 0:
            continue
        if not (0.7 * neighbour_mean <= counts[year] <= 1.3 * neighbour_mean):
            problems.append(
                f"{year}: {counts[year]} dividend rows vs "
                f"neighbouring-year mean {neighbour_mean:.1f}"
            )
    return problems


def fetch_history(
    raw_dir: Path,
    client: NseClient,
    *,
    start: date = date(2011, 1, 1),
    end: date | None = None,
) -> pd.DataFrame:
    """Fetch the full CA history from `start` to `end` (default: today) by calendar
    quarter (plan.md §2), writing each quarter's raw JSON under
    `raw_dir/corporate_actions/<fetch-date>/`.

    Applies the per-quarter month-completeness guard (one refetch then raise) and,
    across the whole concatenated history, the per-year dividend-row-count guard
    (plan.md §3, QA F05). Returns the concatenated, de-duplicated DataFrame.
    """
    end = end or date.today()
    client.warm_up()

    frames = [
        fetch_quarter_checked(quarter_start, quarter_end, raw_dir, client)
        for quarter_start, quarter_end in iter_quarters(start, end)
    ]
    full = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=OUTPUT_COLUMNS)
    full = full.drop_duplicates(ignore_index=True)

    problems = check_dividend_year_counts(full)
    if problems:
        raise ValueError("CA dividend-row-count guard failed: " + "; ".join(problems))

    return full
