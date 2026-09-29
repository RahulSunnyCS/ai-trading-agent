"""Frozen schemas for the stock data layer (T0 — plan.md §6/§7).

This module is the single source of truth for:
  - the `daily.parquet` and `events.parquet` column layouts (as pyarrow schemas, so
    every writer in T1/T2/T6 produces byte-identical dtypes);
  - the header row of every curated CSV under `stocks/curated/` (CURATED_HEADERS);
  - the `company_id` format and its validator;
  - the shared enums (EventKind, EventSource, MembershipKind, GuardSeverity) and the
    small dataclasses (ParsedEvent, GuardResult) that later tasks' public functions
    return, so two tasks implemented in parallel still agree on shapes.

Nothing here does I/O. Downstream modules import from here rather than redefining
any of this — see CLAUDE.md's "one fact lives in exactly one file" discipline,
applied inside the package too.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

import pyarrow as pa

# --------------------------------------------------------------------------
# company_id
# --------------------------------------------------------------------------

# 'C' + 4 digits, e.g. "C0001". Fixed-width so it sorts and pads predictably in
# every curated CSV and in daily.parquet/events.parquet.
COMPANY_ID_RE = re.compile(r"^C\d{4}$")


def is_valid_company_id(value: str) -> bool:
    """True if `value` matches the frozen company_id format ('C' + 4 digits)."""
    return bool(COMPANY_ID_RE.match(value))


def validate_company_id(value: str) -> str:
    """Return `value` unchanged if it is a valid company_id, else raise ValueError.

    Every curation/resolution step that mints or consumes a company_id should route
    it through this function rather than re-implementing the 'C' + 4-digit check.
    """
    if not is_valid_company_id(value):
        raise ValueError(f"invalid company_id {value!r}: expected 'C' followed by 4 digits")
    return value


def company_id_from_sequence(n: int) -> str:
    """Mint the company_id for sequence number `n` (1 -> 'C0001', 42 -> 'C0042').

    Raises ValueError if `n` doesn't fit in 4 digits (n < 1 or n > 9999).
    """
    if not 1 <= n <= 9999:
        raise ValueError(f"company_id sequence out of range (1-9999): {n}")
    return f"C{n:04d}"


# --------------------------------------------------------------------------
# Enums shared across the stocks subpackage
# --------------------------------------------------------------------------


class EventKind(StrEnum):
    """`events.parquet.kind` / `actions_manual.csv.kind` values.

    BONUS, SPLIT and DIVIDEND are auto-parsed from the CA feed subject (plan.md §2).
    Every other member is manual-only: corporate_actions.parse_subject never assigns
    them a factor/dividend itself, it only flags the row as MANUAL_ONLY for
    actions_manual.csv to cover with a cited, human-entered value.
    """

    BONUS = "bonus"
    SPLIT = "split"
    DIVIDEND = "dividend"
    RIGHTS = "rights"
    DEMERGER = "demerger"
    SCHEME_OF_ARRANGEMENT = "scheme_of_arrangement"
    BONUS_DEBENTURE = "bonus_debenture"
    PREFERENCE_SHARE = "preference_share"
    CAPITAL_REDUCTION = "capital_reduction"
    COMBINED_DIVIDEND_BONUS = "combined_dividend_bonus"
    MERGER_EXIT = "merger_exit"  # actions_manual.csv only (last_session/acquirer_id/swap_ratio)
    MANUAL_ONLY = "manual_only"  # parse_subject's catch-all pending an actions_manual.csv row


class EventSource(StrEnum):
    """`events.parquet.source`: did the factor/dividend come from the CA feed or a
    hand-curated actions_manual.csv row?"""

    FEED = "feed"
    MANUAL = "manual"


class MembershipKind(StrEnum):
    """`nifty50_membership.csv.kind` (plan.md §2 "Membership").

    INVESTABLE counts toward the buy mask and price coverage. DUMMY is a demerger
    placeholder (e.g. a listed-but-not-yet-tradeable spinoff row): it counts toward
    the 50/51-member total but is excluded from price coverage and the buy mask.
    """

    INVESTABLE = "investable"
    DUMMY = "dummy"


class GuardSeverity(StrEnum):
    """guards.py result severity (plan.md §3): F fails the run, G only flags it."""

    F = "F"
    G = "G"


# --------------------------------------------------------------------------
# Shared dataclasses
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ParsedEvent:
    """One event parsed out of a single CA subject string, before company/session
    resolution (that's adjust.resolve_company's job, not corporate_actions.parse_subject's).

    `factor` is set for BONUS/SPLIT, `dividend` for DIVIDEND (rupees per pre-event
    share), `dividend_basis` only for the rare %-of-face-value case that is
    manual-only per plan.md §2. `note` carries the reason for MANUAL_ONLY events
    (e.g. "rights issue - manual only"), for the actions_manual.csv reviewer.
    """

    kind: EventKind
    factor: float | None
    dividend: float | None
    dividend_basis: str | None = None
    note: str | None = None


@dataclass(frozen=True)
class GuardResult:
    """One row of guards.run_all's report (feeds fetch_report.csv's guard section).

    `company_id`/`session` are optional because some guards (e.g. membership
    invariants) are run-wide rather than per-company-per-day.
    """

    guard: str
    severity: GuardSeverity
    message: str
    company_id: str | None = None
    session: str | None = None  # ISO date string; kept as str so this stays JSON-friendly


# --------------------------------------------------------------------------
# daily.parquet / events.parquet (pyarrow schemas)
# --------------------------------------------------------------------------

DAILY_SCHEMA = pa.schema(
    [
        pa.field("date", pa.date32(), nullable=False),
        pa.field("symbol", pa.string(), nullable=False),
        pa.field("series", pa.string(), nullable=False),
        pa.field("isin", pa.string(), nullable=True),
        pa.field("open", pa.float64(), nullable=False),
        pa.field("high", pa.float64(), nullable=False),
        pa.field("low", pa.float64(), nullable=False),
        pa.field("close", pa.float64(), nullable=False),
        pa.field("prevclose", pa.float64(), nullable=False),
        pa.field("volume", pa.int64(), nullable=False),
        pa.field("turnover", pa.float64(), nullable=False),
        pa.field("synthetic_close", pa.bool_(), nullable=False),
    ]
)
"""Every EQ/BE/BZ symbol, 2011 onward (plan.md §6). One row per (symbol, date).
`isin` is nullable because the earliest bhavcopy header (2011) has no ISIN column.
`synthetic_close` is true for the single-session archive-gap fill described in
plan.md §3's session-calendar guard."""

EVENTS_SCHEMA = pa.schema(
    [
        pa.field("company_id", pa.string(), nullable=False),
        pa.field("symbol_at_ex", pa.string(), nullable=False),
        pa.field("session", pa.date32(), nullable=False),
        pa.field("ex_date", pa.date32(), nullable=False),
        pa.field("kind", pa.string(), nullable=False),
        pa.field("factor", pa.float64(), nullable=True),
        pa.field("dividend", pa.float64(), nullable=True),
        pa.field("source", pa.string(), nullable=False),
        pa.field("subject_sha1", pa.string(), nullable=True),
    ]
)
"""One row per resolved corporate-action event (plan.md §6). `session` is the
company's first traded session on/after `ex_date` that the event attaches to
(plan.md §2); `subject_sha1` is null for MANUAL source rows that have no feed
subject to hash. `kind` stores an EventKind.value string, `source` an
EventSource.value string."""


# --------------------------------------------------------------------------
# Curated CSV headers (plan.md §6) — the tuple order is the on-disk column order
# --------------------------------------------------------------------------

CURATED_HEADERS: dict[str, tuple[str, ...]] = {
    "companies.csv": ("company_id", "name"),
    "aliases.csv": ("company_id", "symbol", "from", "to", "source"),
    "nifty50_membership.csv": (
        "company_id",
        "symbol",
        "from",
        "to",
        "kind",
        "source",
        "source2",
    ),
    "actions_manual.csv": (
        "company_id",
        "ex_date",
        "kind",
        "factor",
        "dividend",
        "dividend_basis",
        "last_session",
        "acquirer_id",
        "swap_ratio",
        "source",
    ),
    # A member with genuinely zero CA-feed rows over its whole membership (e.g. ETERNAL)
    # gets an entry here instead, so guards.check_ca_coverage can tell "no rows fetched
    # yet" apart from "this company never had one".
    "no_ca_rows.csv": ("company_id", "symbol", "reason", "source"),
    # Cited exceptions to the >20% unexplained-move guard (plan.md §3).
    "crash_allowlist.csv": ("company_id", "session", "reason", "source"),
    # Cited exceptions to the PREVCLOSE-continuity guard (plan.md §3) — header fixed
    # by T0's acceptance criteria.
    "continuity_exceptions.csv": ("company_id", "session", "reason", "source"),
    # Reviewed exceptions to the Yahoo adjclose cross-check (plan.md §4.3).
    "yahoo_exceptions.csv": ("company_id", "symbol", "reason", "source"),
}
