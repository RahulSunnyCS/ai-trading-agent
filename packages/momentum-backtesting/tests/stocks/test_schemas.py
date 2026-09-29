"""T0 acceptance: curated CSV headers match schemas.py, company_id validation,
and the curated-files-tracked-or-untracked-but-present check (plan.md §6/§7)."""

import subprocess
from pathlib import Path

import pytest

from momentum_backtesting.stocks.schemas import (
    CURATED_HEADERS,
    DAILY_SCHEMA,
    EVENTS_SCHEMA,
    company_id_from_sequence,
    is_valid_company_id,
    validate_company_id,
)

CURATED_DIR = Path(__file__).resolve().parents[2] / "src/momentum_backtesting/stocks/curated"
REPO_ROOT = Path(__file__).resolve().parents[4]


def _git_tracked(path: Path) -> bool:
    """True if `path` is tracked by git (run from REPO_ROOT)."""
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", str(path)],
        cwd=REPO_ROOT,
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def _package_has_any_tracked_file() -> bool:
    result = subprocess.run(
        ["git", "ls-files", "packages/momentum-backtesting"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


# --------------------------------------------------------------------------
# Curated CSV headers
# --------------------------------------------------------------------------


@pytest.mark.parametrize("filename", sorted(CURATED_HEADERS))
def test_curated_header_matches_schema(filename):
    path = CURATED_DIR / filename
    assert path.exists(), f"{filename} is listed in CURATED_HEADERS but missing on disk"
    first_line = path.read_text().splitlines()[0]
    header = tuple(first_line.split(","))
    assert header == CURATED_HEADERS[filename]


def test_curated_files_start_with_their_frozen_header():
    for filename in CURATED_HEADERS:
        lines = (CURATED_DIR / filename).read_text().splitlines()
        assert lines, f"{filename} should not be empty"
        header = tuple(lines[0].split(","))
        assert header == CURATED_HEADERS[filename], (
            f"{filename}'s first line does not match its frozen header"
        )


def test_continuity_exceptions_header_is_fixed_by_the_task_contract():
    # T0's acceptance criteria pins this exact header independently of the rest of
    # CURATED_HEADERS, so a regression here is caught even if someone edits the dict.
    assert CURATED_HEADERS["continuity_exceptions.csv"] == (
        "company_id",
        "session",
        "reason",
        "source",
    )


def test_every_curated_file_is_tracked_or_untracked_but_present():
    if not _package_has_any_tracked_file():
        pytest.skip("momentum-backtesting has no tracked files yet; skipping tracking assertion")
    for filename in CURATED_HEADERS:
        path = CURATED_DIR / filename
        assert path.exists(), f"{filename} must exist on disk (tracked or not)"
        # Tracked or untracked-but-present both satisfy T0's acceptance criteria;
        # _git_tracked is informational (no assertion) since a fresh T0 run is
        # expected to leave these new files untracked until a human commits them.
        _git_tracked(path)


# --------------------------------------------------------------------------
# company_id
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["C0001", "C0042", "C9999", "C0000"])
def test_valid_company_ids(value):
    assert is_valid_company_id(value)
    assert validate_company_id(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "c0001",  # lowercase
        "C001",  # too few digits
        "C00001",  # too many digits
        "0001",  # missing prefix
        "CX001",  # non-digit
        "C 001",  # whitespace
        "",
    ],
)
def test_invalid_company_ids(value):
    assert not is_valid_company_id(value)
    with pytest.raises(ValueError):
        validate_company_id(value)


def test_company_id_from_sequence():
    assert company_id_from_sequence(1) == "C0001"
    assert company_id_from_sequence(42) == "C0042"
    assert company_id_from_sequence(9999) == "C9999"


@pytest.mark.parametrize("n", [0, -1, 10000])
def test_company_id_from_sequence_out_of_range(n):
    with pytest.raises(ValueError):
        company_id_from_sequence(n)


# --------------------------------------------------------------------------
# parquet schemas
# --------------------------------------------------------------------------


def test_daily_schema_columns():
    assert DAILY_SCHEMA.names == [
        "date",
        "symbol",
        "series",
        "isin",
        "open",
        "high",
        "low",
        "close",
        "prevclose",
        "volume",
        "turnover",
        "synthetic_close",
    ]
    assert DAILY_SCHEMA.field("isin").nullable
    assert not DAILY_SCHEMA.field("close").nullable


def test_events_schema_columns():
    assert EVENTS_SCHEMA.names == [
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
    assert EVENTS_SCHEMA.field("factor").nullable
    assert EVENTS_SCHEMA.field("dividend").nullable
    assert not EVENTS_SCHEMA.field("company_id").nullable
