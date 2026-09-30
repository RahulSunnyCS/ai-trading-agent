"""
trading-data — the local research database shared by option-backtesting and
momentum-backtesting.

Everything lives under one folder, TRADING_DATA_ROOT (default ~/TradingData), so
moving it to an external disk is one env var:

    catalog.duckdb   tables: instruments, reference data, ingest runs, strategies,
                     backtest results (migrations/*.sql)
    lake/            immutable Parquet price data, read through views
                     (bars_1m_option, bars_1m_index, bars_1m_future, symbol_master)
    raw/             gzipped verbatim vendor responses, for re-processing

Price bars are files, not table rows: they are written once, compress 5-10x,
never block the catalog's single writer, and back up incrementally. See
DECISIONS.md in this package.
"""
