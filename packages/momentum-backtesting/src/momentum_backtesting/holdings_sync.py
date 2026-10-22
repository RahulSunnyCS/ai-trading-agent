"""Read the owner's holdings from their broker (read-only) and keep them as a snapshot: Fyers
(BL-051 Phase 3) or Kite with its free cash (BL-142). Shared by `mbt orders run`, `mbt kite sync`,
the Kite login callback and the page's Sync button. Never places or changes an order."""

from __future__ import annotations

from typing import Any

from . import fyers, holdings_store, kite
from .db_read import open_catalog

#: A broker login is missing or expired: the owner has to log in again.
LOGIN_ERRORS = (fyers.FyersCredentialsError, kite.KiteCredentialsError)


def broker_source(holdings_source: str) -> str:
    """The broker a holdings source syncs from; the paper source keeps the old Fyers button."""
    return "kite" if holdings_source == "kite" else "fyers"


def sync(source: str) -> dict[str, Any]:
    """Store a new snapshot from `source` ('fyers' or 'kite') and return it. Raises one of
    LOGIN_ERRORS without a valid login, RuntimeError when the broker refuses or is unreachable."""
    cash = None
    if source == "kite":
        creds = kite.resolve_credentials()
        rows = kite.holdings(creds)
        cash = kite.free_cash(creds)
    elif source == "fyers":
        rows = fyers.holdings(fyers.resolve_credentials())
    else:
        raise ValueError(f"Unknown broker {source!r}")
    with open_catalog() as con:
        who = holdings_store.owner()
        holdings_store.save_holdings(con, who, source, rows, cash)
        return holdings_store.latest_holdings(con, who, (source,)) or {}
