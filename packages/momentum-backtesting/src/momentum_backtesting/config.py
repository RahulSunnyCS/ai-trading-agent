"""Paths and settings. Credentials come from the repo-root .env shared with apps/server."""

import os
from datetime import date
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PACKAGE_ROOT.parents[1]
DATA_DIR = Path(os.environ.get("MOMENTUM_DATA_DIR", PACKAGE_ROOT / "data"))
UNIVERSE_CSV = Path(__file__).with_name("universe.csv")

# A year before the 2017 backtest start, so 52-week momentum is defined from Jan 2017.
HISTORY_START = date(2016, 1, 1)


def load_repo_env() -> None:
    """Load the repo-root .env into os.environ without overriding values already set."""
    path = REPO_ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        value = value.split(" #", 1)[0].strip().strip('"').strip("'")
        os.environ.setdefault(key, value)
