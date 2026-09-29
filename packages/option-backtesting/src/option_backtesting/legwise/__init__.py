"""
Leg-wise engine — AlgoTest-style strategies (per-leg SL / target / trail SL,
re-entry, range-breakout entry, closest-premium strikes, overall MTM stop)
simulated minute by minute over the Fyers 1-minute concrete-contract data
(`fyers/`).

Deliberately separate from `engine/`: that engine sums every leg into one
premium series with one side and is pinned to the golden fixture to the
rupee; AlgoTest strategies manage each leg independently (mixed buy/sell,
independent exits and re-entries), which is a different state machine, not
an extension of that one. See DECISIONS.md ("Leg-wise engine").

The YAML schema mirrors AlgoTest's strategy page field for field, so an
AlgoTest PDF/screen can be transcribed directly — `schema.py`. Every intrabar
ordering assumption the 1-minute bars force on us is listed in `engine.py`'s
docstring.
"""
