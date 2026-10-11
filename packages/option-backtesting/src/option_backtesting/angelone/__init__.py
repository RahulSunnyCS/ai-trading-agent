"""
Angel One SmartAPI 1-minute collector (BL-078/BL-079) — the fallback source when no Fyers
token is valid. It plugs into `fyers.daily.collect_day` as a drop-in client: Fyers tickers stay
the instrument identity, so the lake, the catalog and the data-quality judge are shared.
Forward-only, like Fyers: Angel One lists live contracts only.
"""
