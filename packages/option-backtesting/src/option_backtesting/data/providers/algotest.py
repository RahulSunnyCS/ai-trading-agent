"""
AlgoTest adapter.

Transport: **Claude Routine via MCP** (see DECISIONS.md), not a live network
call from this module. The AlgoTest MCP tools (`get_ohlc_by_data_source`,
`fetch_greeks_by_data_source`) are only callable from inside a Claude Code
session — a plain Python process cannot reach them. The actual flow is:

    1. `plan_requests()` below builds the list of AlgoTest requests needed
       for a session (used by `obt ingest plan`).
    2. A Claude Code session (interactive or a scheduled Routine) calls the
       MCP tools for each planned request and writes the verbatim response
       to `data/raw/algotest/...` via `data.raw.write_raw`.
    3. `obt ingest` reads those raw files directly (`data.ingest`).

A future REST or Python-MCP-client transport would implement the
`MarketDataProvider` Protocol in `base.py`, so the ingest pipeline, resolver
and engine would not need to change.
"""

from __future__ import annotations

from datetime import date

# ---------------------------------------------------------------------------
# Request planning — the actual Phase-1 transport entry point
# ---------------------------------------------------------------------------

#: Strike rules pulled for every session, per the M-1 plan: OTM1/OTM2 give the
#: pyramid strategies' traded legs, ITM1/ITM2 give symmetric coverage for
#: future delta-neutral / condor strategies, ATM is the trigger series.
STRIKE_RULES: tuple[str, ...] = ("ITM2", "ITM1", "ATM", "OTM1", "OTM2")

#: Both OHLC timeframes ingested per the M-1 plan. 5m gives finer fill
#: interpolation for the trigger_level fill model; 15m matches the golden
#: fixture's granularity and keeps request volume bounded.
OHLC_TIMEFRAMES: tuple[str, ...] = ("5m", "15m")

#: Greeks are pulled only for the ATM leg — the trigger series is the one
#: place IV/delta matter for Phase-1 features (iv_pctile, open_iv).
GREEKS_TIMEFRAME = "15m"

#: CASH at 1m over a 90-day range is multiple MB of response — far more than
#: needed, since CASH is only used as an independent cross-check of the
#: resolved ATM strike near fix_time (see resolver.py), not for a
#: minute-by-minute feature. 5m keeps the same coverage at a fraction of the
#: size.
CASH_TIMEFRAME = "5m"

DEFAULT_FIX_TIME = "09:17"


def _opt_data_source(
    underlying: str,
    strike_rule: str,
    leg: str,
    *,
    fix_time: str = DEFAULT_FIX_TIME,
) -> dict:
    return {
        "underlying": underlying,
        "data_type": "OPT",
        "expiry": "ExpiryType.Weekly",
        "option": f"LegType.{leg}",
        "entry_kind": "EntryType.EntryByStrikeType",
        "strike_parameter": f"StrikeType.{strike_rule}",
        "data_mode": "FIXED",
        "fix_time": fix_time,
    }


def _cash_data_source(underlying: str) -> dict:
    return {"underlying": underlying, "data_type": "CASH"}


def plan_requests(
    underlying: str,
    start_date: date,
    end_date: date,
    *,
    strike_rules: tuple[str, ...] = STRIKE_RULES,
    fix_time: str = DEFAULT_FIX_TIME,
) -> list[dict]:
    """Build the full list of AlgoTest MCP requests needed to cover one
    underlying over [start_date, end_date]. Each entry has the shape:

        {
          "kind": "ohlc" | "greeks",
          "data_source": {...},          # passed to the MCP tool verbatim
          "timeframe": "5m" | "15m" | "1m",
          "start_date": "YYYY-MM-DD",
          "end_date": "YYYY-MM-DD",
          "raw_key": {...},              # underlying/timeframe/strike_rule/leg
                                          # — used to build the raw.py file path
        }

    ~25 requests per (underlying, single-day) call: 1 CASH + 5 strike_rules
    x 2 legs x 2 OHLC timeframes (20) + 2 Greeks (ATM CE/PE) = 23.
    """
    start_s = start_date.isoformat()
    end_s = end_date.isoformat()
    requests: list[dict] = []

    requests.append(
        {
            "kind": "ohlc",
            "data_source": _cash_data_source(underlying),
            "timeframe": CASH_TIMEFRAME,
            "start_date": start_s,
            "end_date": end_s,
            "raw_key": {
                "underlying": underlying,
                "timeframe": CASH_TIMEFRAME,
                "strike_rule": None,
                "leg": None,
                "data_kind": "cash",
            },
        }
    )

    for strike_rule in strike_rules:
        for leg in ("CE", "PE"):
            ds = _opt_data_source(underlying, strike_rule, leg, fix_time=fix_time)
            for timeframe in OHLC_TIMEFRAMES:
                requests.append(
                    {
                        "kind": "ohlc",
                        "data_source": ds,
                        "timeframe": timeframe,
                        "start_date": start_s,
                        "end_date": end_s,
                        "raw_key": {
                            "underlying": underlying,
                            "timeframe": timeframe,
                            "strike_rule": strike_rule,
                            "leg": leg,
                            "data_kind": "opt",
                        },
                    }
                )

    for leg in ("CE", "PE"):
        ds = _opt_data_source(underlying, "ATM", leg, fix_time=fix_time)
        requests.append(
            {
                "kind": "greeks",
                "data_source": ds,
                "timeframe": GREEKS_TIMEFRAME,
                "start_date": start_s,
                "end_date": end_s,
                "raw_key": {
                    "underlying": underlying,
                    "timeframe": GREEKS_TIMEFRAME,
                    "strike_rule": "ATM",
                    "leg": leg,
                    "data_kind": "greeks",
                },
            }
        )

    return requests
