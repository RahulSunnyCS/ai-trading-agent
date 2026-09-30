"""
Fyers 1-minute collector — daily capture of index, VIX, futures and option
OHLC(+OI) for the day's traded range, written as Parquet under
TRADING_DATA_ROOT (packages/trading-data: Parquet lake + DuckDB catalog).

Forward-only by design: Fyers' history API does not serve contracts that
have already expired, so an expiring contract must be captured on its expiry
day or it is gone. See DECISIONS.md ("Fyers collector is forward-only").
"""
