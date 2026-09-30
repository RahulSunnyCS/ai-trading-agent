-- 001: instruments, reference data, ingest bookkeeping, strategies and backtest results.
--
-- DuckDB dialect, kept close to plain SQL so a later move to Postgres is mechanical.
-- No FOREIGN KEY constraints on purpose: DuckDB checks them over-eagerly (an UPDATE of
-- any column on a referenced row can fail), so relations are documented here and kept
-- by the writers in trading_data/ instead. Price bars are NOT tables — they are Parquet
-- files under lake/, exposed as views by db.refresh_views().

CREATE TABLE schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Instruments: one row per tradable thing, derivatives point at their underlying.
-- instrument_key is the vendor-neutral identity, e.g.
--   NSE:IDX:NIFTY   NSE:FUT:NIFTY:2026-10-27   NSE:OPT:NIFTY:2026-10-06:22700:CE
--   NSE:STK:RELIANCE   NSE:OPT:RELIANCE:2026-10-27:1400:PE   (stock options: same shape)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE instrument_id_seq START 1;
CREATE TABLE instruments (
    instrument_id   BIGINT PRIMARY KEY DEFAULT nextval('instrument_id_seq'),
    instrument_key  TEXT NOT NULL UNIQUE,
    asset_class     TEXT NOT NULL CHECK (asset_class IN
                        ('index', 'stock', 'etf', 'fund', 'option', 'future', 'commodity')),
    exchange        TEXT NOT NULL,
    symbol          TEXT NOT NULL,      -- the root: NIFTY, RELIANCE, INDIAVIX
    underlying_id   BIGINT,             -- -> instruments.instrument_id (derivatives)
    expiry          DATE,
    strike          DOUBLE,
    option_type     TEXT CHECK (option_type IN ('CE', 'PE')),
    lot_size        INTEGER,
    tick_size       DOUBLE,
    isin            TEXT,
    company_id      TEXT,
    listed_on       DATE,
    delisted_on     DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A vendor's name for an instrument (Fyers' NSE:NIFTY26O0622700CE, Yahoo's RELIANCE.NS …).
CREATE TABLE instrument_aliases (
    vendor          TEXT NOT NULL,
    vendor_symbol   TEXT NOT NULL,
    instrument_id   BIGINT NOT NULL,
    valid_from      DATE NOT NULL DEFAULT DATE '1900-01-01',
    valid_to        DATE,
    PRIMARY KEY (vendor, vendor_symbol, valid_from)
);

-- ---------------------------------------------------------------------------
-- Reference data (master copy). Formerly option-backtesting's data/reference/*.csv;
-- those CSVs are now EXPORTED from here (`tdata reference export`) because the
-- TypeScript packages/market-reference and the Python ReferenceData loader read them.
-- ---------------------------------------------------------------------------
CREATE TABLE ref_lot_sizes (
    underlying      TEXT NOT NULL,
    lot_size        INTEGER NOT NULL,
    effective_date  DATE NOT NULL,
    PRIMARY KEY (underlying, effective_date)
);
CREATE TABLE ref_strike_steps (
    underlying      TEXT NOT NULL,
    step            DOUBLE NOT NULL,
    effective_date  DATE NOT NULL,
    PRIMARY KEY (underlying, effective_date)
);
CREATE TABLE ref_expiry_rules (
    underlying      TEXT NOT NULL,
    cadence         TEXT NOT NULL,      -- WEEKLY | MONTHLY
    weekday         INTEGER NOT NULL,   -- 0 = Monday
    effective_date  DATE NOT NULL,
    PRIMARY KEY (underlying, effective_date)
);
-- Keyed on (date, description): one day can close for two reasons (2025-10-02 was
-- both Gandhi Jayanti and Dussehra, and the committed CSV lists both).
CREATE TABLE ref_holidays (
    date            DATE NOT NULL,
    description     TEXT NOT NULL,
    PRIMARY KEY (date, description)
);
CREATE TABLE ref_margins (
    underlying      TEXT NOT NULL,
    strategy_type   TEXT NOT NULL,
    month           TEXT NOT NULL,      -- YYYY-MM
    margin_inr      DOUBLE NOT NULL,
    PRIMARY KEY (underlying, strategy_type, month)
);

-- ---------------------------------------------------------------------------
-- Ingest bookkeeping: one row per download run, plus anything the checks flagged.
-- ---------------------------------------------------------------------------
CREATE TABLE ingest_runs (
    run_id          TEXT PRIMARY KEY,   -- uuid4 hex
    source          TEXT NOT NULL,      -- fyers | nse | yahoo | amfi | algotest | migration
    dataset         TEXT NOT NULL,      -- e.g. bars_1m
    trading_day     DATE,
    scope           TEXT,               -- e.g. NIFTY, or ALL
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'ok', 'partial', 'failed')),
    requests        INTEGER,
    rows_written    BIGINT,
    errors          INTEGER,
    details         JSON
);
CREATE TABLE quality_issues (
    run_id          TEXT NOT NULL,
    instrument_id   BIGINT,
    trading_day     DATE,
    check_name      TEXT NOT NULL,
    detail          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Strategies and backtest results — shared by option-backtesting (legwise, DSL) and
-- momentum-backtesting. Every edit to a strategy is a new version (by content hash),
-- so a result always points at the exact settings that produced it.
-- ---------------------------------------------------------------------------
CREATE TABLE strategies (
    strategy_id     TEXT PRIMARY KEY,   -- e.g. nifty_widesl_917_otm1
    package         TEXT NOT NULL,      -- options_legwise | options_dsl | momentum
    name            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE strategy_versions (
    version_id      TEXT PRIMARY KEY,   -- strategy_id + ':' + spec_hash
    strategy_id     TEXT NOT NULL,
    spec_hash       TEXT NOT NULL,
    spec            JSON NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE backtest_runs (
    run_id          TEXT PRIMARY KEY,
    version_id      TEXT NOT NULL,
    kind            TEXT NOT NULL,      -- daily | adhoc | sweep | walkforward | weekly
    date_from       DATE,
    date_to         DATE,
    params          JSON,
    code_version    TEXT,               -- git sha
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    summary         JSON                -- net, max_drawdown, win_days, cagr, sharpe …
);
CREATE TABLE backtest_days (
    run_id          TEXT NOT NULL,
    day             DATE NOT NULL,
    gross           DOUBLE NOT NULL,
    costs           DOUBLE NOT NULL,
    net             DOUBLE NOT NULL,
    worst_mtm       DOUBLE,
    best_mtm        DOUBLE,
    stopped_by      TEXT,
    notes           JSON,
    PRIMARY KEY (run_id, day)
);
CREATE TABLE backtest_trades (
    run_id          TEXT NOT NULL,
    day             DATE NOT NULL,
    seq             INTEGER NOT NULL,
    leg             TEXT,
    instrument_id   BIGINT,
    side            TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    qty             DOUBLE NOT NULL,
    entry_ts        TIMESTAMPTZ,
    entry_price     DOUBLE,
    exit_ts         TIMESTAMPTZ,
    exit_price      DOUBLE,
    exit_reason     TEXT,
    pnl             DOUBLE,
    PRIMARY KEY (run_id, day, seq)
);
