"""The options rotation's forward paper journal (BL-058).

Picks for each registered list are written down before 09:17 on every trading day, scored from the
collected data every evening, and kept in an insert-only hash chain. The scoring here is a port of
`research/bl057/rotate.py` (`score_day` / `select_picks`), checked against it by
`scripts/rotation-parity.py`; nothing in this package places or changes a trade.

Modules: `lists` (the registered lists), `score` (the ranking), `variants` (the 248 strategy files),
`store` (per-variant results and per-day attributes under TRADING_DATA_ROOT/rotation),
`attrs` (weekday / VIX band / days to expiry from the lake), `live` (the 09:15 VIX open and the
calendar's days to expiry), `update` (the nightly one-day run of every variant), `journal` (the
chain) and `pick` (the morning entry).
"""
