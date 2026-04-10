# Options Trading Optimizer — Database Schema Design

## Architecture Decision: Narrow (Normalized) Tables

**Why narrow over wide:**
- Adding Sensex/FinNifty/MidcapNifty = zero schema changes
- Variable strike counts per index (Nifty has different step sizes than Sensex)
- TimescaleDB compression works dramatically better on narrow tables (~10-15× compression)
- Aggregation queries (GROUP BY strike_type, instrument) are natural
- Wide tables with 150+ columns become unmaintainable nightmares

---

## Data Volume Estimates (15-second intervals)

| Metric | Value |
|---|---|
| Intervals per day | 1,500 (6.25 hrs × 4/min) |
| Contracts per index | 38 (19 strikes × CE+PE) |
| Rows per index per day | 57,000 |
| Rows per day (2 indices) | ~114,000 |
| Rows per year (250 days) | ~28.5M |
| Estimated storage (compressed) | ~2-4 GB/year |

**Verdict:** Trivial for TimescaleDB. You could run 10 indices at tick-level and still be fine.

---

## Table 1: `instruments` (Reference/Dimension Table)

Stores metadata about each tradeable index. Rarely changes.

```sql
CREATE TABLE instruments (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20) NOT NULL UNIQUE,  -- 'NIFTY', 'BANKNIFTY', 'SENSEX'
    exchange        VARCHAR(10) NOT NULL,          -- 'NSE', 'BSE'
    lot_size        INTEGER NOT NULL,              -- 25 for Nifty, 10 for Sensex
    strike_step     NUMERIC NOT NULL,              -- 50 for Nifty, 100 for Sensex
    otm_strikes     INTEGER NOT NULL DEFAULT 9,    -- how many OTM strikes to track each side
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Table 2: `market_snapshots` (Core Time-Series — Index Level)

One row per index per 15-second interval. This is your "spine" table.

```sql
CREATE TABLE market_snapshots (
    ts              TIMESTAMPTZ NOT NULL,
    instrument_id   INTEGER NOT NULL REFERENCES instruments(id),
    
    -- Spot data
    spot_price      NUMERIC(12,2) NOT NULL,
    spot_open       NUMERIC(12,2),
    spot_high       NUMERIC(12,2),
    spot_low        NUMERIC(12,2),
    
    -- ATM reference
    atm_strike      NUMERIC(10,2) NOT NULL,
    
    -- VIX (India VIX for NSE, or instrument-specific if available)
    vix             NUMERIC(8,4),
    
    -- Straddle aggregate (precomputed for fast querying)
    atm_straddle_value      NUMERIC(10,2),  -- ATM CE LTP + ATM PE LTP
    atm_straddle_iv         NUMERIC(8,4),   -- weighted average IV of ATM straddle
    
    -- Put-Call Ratio (all tracked strikes)
    pcr_oi          NUMERIC(8,4),           -- total PE OI / total CE OI
    pcr_volume      NUMERIC(8,4),           -- total PE volume / total CE volume
    
    -- Advance-Decline of option chain (how many strikes CE > PE premium and vice versa)
    chain_sentiment_score   NUMERIC(6,4),   -- custom: normalized -1 to +1
    
    -- =============================================================
    -- STRADDLE-LEVEL MULTI-TIMEFRAME EMA DERIVATIVES
    -- Same 3-layer approach as option_ticks, but on straddle value.
    -- This is what your signal engine queries most frequently.
    -- =============================================================

    -- Straddle EMA values
    straddle_ema8           NUMERIC(10,2),
    straddle_ema20          NUMERIC(10,2),
    straddle_ema40          NUMERIC(10,2),

    -- Straddle velocity (ROC of EMA)
    straddle_roc_ema8       NUMERIC(10,6),
    straddle_roc_ema20      NUMERIC(10,6),          -- primary
    straddle_roc_ema40      NUMERIC(10,6),

    -- Straddle acceleration (ROC of ROC)
    straddle_accel_ema8     NUMERIC(10,6),           -- early warning
    straddle_accel_ema20    NUMERIC(10,6),           -- PRIMARY PEAK DETECTOR
    straddle_accel_ema40    NUMERIC(10,6),           -- regime confirmation

    -- VIX EMA derivatives (VIX acceleration = vol-of-vol signal)
    vix_ema20               NUMERIC(8,4),
    vix_roc_ema20           NUMERIC(10,6),
    vix_accel_ema20         NUMERIC(10,6),

    -- Composite exhaustion score (-1.0 to +1.0)
    -- Precomputed: weighted combination of all three timeframe accels
    -- Negative = exhaustion in progress, positive = expansion
    straddle_exhaustion_score NUMERIC(6,4),
    
    PRIMARY KEY (ts, instrument_id)
);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('market_snapshots', 'ts');

-- Compression policy (compress chunks older than 7 days)
ALTER TABLE market_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'instrument_id',
    timescaledb.compress_orderby = 'ts DESC'
);
SELECT add_compression_policy('market_snapshots', INTERVAL '7 days');
```

---

## Table 3: `option_ticks` (Core Time-Series — Per Strike)

One row per strike per 15-second interval. This is your highest-volume table.

```sql
CREATE TABLE option_ticks (
    ts              TIMESTAMPTZ NOT NULL,
    instrument_id   INTEGER NOT NULL REFERENCES instruments(id),
    
    -- Strike identification
    strike_price    NUMERIC(10,2) NOT NULL,
    option_type     CHAR(2) NOT NULL,           -- 'CE' or 'PE'
    expiry_date     DATE NOT NULL,
    strike_offset   INTEGER NOT NULL,           -- 0=ATM, 1=OTM1, -1=ITM1, etc.
    
    -- OHLC
    open            NUMERIC(10,2),
    high            NUMERIC(10,2),
    low             NUMERIC(10,2),
    close           NUMERIC(10,2),              -- LTP at this interval
    
    -- Volume & OI
    volume          BIGINT,
    oi              BIGINT,
    delta_oi        BIGINT,                     -- change from previous interval
    
    -- Self-computed Greeks (Black-76 model)
    iv              NUMERIC(8,6),               -- implied volatility
    delta           NUMERIC(8,6),
    gamma           NUMERIC(8,6),
    theta           NUMERIC(8,6),
    vega            NUMERIC(8,6),
    
    -- =============================================================
    -- MULTI-TIMEFRAME EMA DERIVATIVES
    -- Raw 15-sec derivatives are too noisy (microstructure noise).
    -- Pure 300-sec SMA lags too much for 3-5 min exhaustion windows.
    -- Solution: EMA at 3 timeframes for noise filtering + confirmation.
    --
    -- EMA-8  (8 × 15s = 2 min)  → early warning, noisier
    -- EMA-20 (20 × 15s = 5 min) → PRIMARY signal, best noise/lag balance
    -- EMA-40 (40 × 15s = 10 min)→ regime filter, confirms trend vs exhaustion
    --
    -- PEAK DETECTION SIGNAL:
    --   EMA-40 price_accel flattening
    --   + EMA-20 price_accel flips negative
    --   + EMA-8 price_accel already negative
    --   = HIGH CONFIDENCE EXHAUSTION
    -- =============================================================

    -- EMA values (smoothed base for derivative computation)
    price_ema8      NUMERIC(10,4),
    price_ema20     NUMERIC(10,4),
    price_ema40     NUMERIC(10,4),
    iv_ema8         NUMERIC(10,6),
    iv_ema20        NUMERIC(10,6),
    iv_ema40        NUMERIC(10,6),
    theta_ema20     NUMERIC(10,6),
    vega_ema20      NUMERIC(10,6),

    -- First-order derivatives (ROC of EMA — velocity)
    -- EMA-8: early warning layer
    price_roc_ema8  NUMERIC(10,6),
    iv_roc_ema8     NUMERIC(10,6),

    -- EMA-20: primary signal layer
    price_roc_ema20 NUMERIC(10,6),              -- PRIMARY velocity signal
    iv_roc_ema20    NUMERIC(10,6),
    theta_roc_ema20 NUMERIC(10,6),
    vega_roc_ema20  NUMERIC(10,6),

    -- EMA-40: regime filter layer
    price_roc_ema40 NUMERIC(10,6),
    iv_roc_ema40    NUMERIC(10,6),

    -- Second-order derivatives (ROC of ROC — acceleration)
    -- EMA-8: early flip detection
    price_accel_ema8  NUMERIC(10,6),
    iv_accel_ema8     NUMERIC(10,6),

    -- EMA-20: PRIMARY peak detector
    price_accel_ema20 NUMERIC(10,6),            -- THIS is your peak detector signal
    iv_accel_ema20    NUMERIC(10,6),
    theta_accel_ema20 NUMERIC(10,6),
    vega_accel_ema20  NUMERIC(10,6),

    -- EMA-40: trend exhaustion confirmation
    price_accel_ema40 NUMERIC(10,6),
    iv_accel_ema40    NUMERIC(10,6),

    -- Cross-timeframe composite signal (precomputed for fast querying)
    -- -1.0 to +1.0: negative = exhaustion, positive = momentum building
    exhaustion_score  NUMERIC(6,4),
    
    PRIMARY KEY (ts, instrument_id, strike_price, option_type, expiry_date)
);

SELECT create_hypertable('option_ticks', 'ts');

ALTER TABLE option_ticks SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'instrument_id, strike_price, option_type',
    timescaledb.compress_orderby = 'ts DESC'
);
SELECT add_compression_policy('option_ticks', INTERVAL '7 days');

-- Critical indexes for your peak detection queries
CREATE INDEX idx_option_ticks_atm ON option_ticks (instrument_id, ts, strike_offset)
    WHERE strike_offset = 0;

CREATE INDEX idx_option_ticks_instrument_strike ON option_ticks (instrument_id, strike_price, option_type, ts DESC);
```

---

## Table 4: `straddle_signals` (Derived — Your Peak Detection Output)

Populated by your signal engine. One row per signal event.

```sql
CREATE TABLE straddle_signals (
    id                  BIGSERIAL PRIMARY KEY,
    ts                  TIMESTAMPTZ NOT NULL,
    instrument_id       INTEGER NOT NULL REFERENCES instruments(id),
    
    -- Straddle state at signal time (multi-timeframe snapshot)
    straddle_value      NUMERIC(10,2) NOT NULL,
    
    -- EMA state at signal (for retrospection: which timeframe was most predictive?)
    straddle_roc_ema8   NUMERIC(10,6),
    straddle_roc_ema20  NUMERIC(10,6),
    straddle_roc_ema40  NUMERIC(10,6),
    straddle_accel_ema8 NUMERIC(10,6),
    straddle_accel_ema20 NUMERIC(10,6),         -- primary signal value
    straddle_accel_ema40 NUMERIC(10,6),
    straddle_exhaustion_score NUMERIC(6,4),      -- composite score at signal time
    
    -- Signal metadata
    signal_type         VARCHAR(20) NOT NULL,   -- 'EXHAUSTION_DETECTED', 'PEAK_CONFIRMED', 'FALSE_SIGNAL'
    trigger_layer       VARCHAR(10),            -- 'EMA8', 'EMA20', 'EMA40' — which layer triggered first
    confidence          NUMERIC(5,4),           -- 0.0 to 1.0
    vix_at_signal       NUMERIC(8,4),
    vix_accel_ema20     NUMERIC(10,6),          -- vol-of-vol context
    spot_move_pct       NUMERIC(6,4),           -- how much spot moved to trigger this
    
    -- Outcome (filled by retrospection engine EOD)
    actual_peak_ts      TIMESTAMPTZ,            -- when the actual peak was (hindsight)
    signal_to_peak_gap  INTERVAL,               -- how early/late the signal was
    pnl_if_entered      NUMERIC(10,2),          -- theoretical P&L if entered at signal
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

SELECT create_hypertable('straddle_signals', 'ts');
```

---

## Table 5: `external_signals` (Future-Proof Data Lake)

This is the "collect now, analyze in 3 years" table. Semi-structured by design.

```sql
CREATE TABLE external_signals (
    ts              TIMESTAMPTZ NOT NULL,
    signal_source   VARCHAR(50) NOT NULL,       -- see categories below
    signal_key      VARCHAR(100) NOT NULL,       -- specific metric name
    signal_value    NUMERIC(15,6),               -- numeric value if applicable
    signal_text     TEXT,                         -- text/JSON payload for unstructured data
    metadata        JSONB,                        -- flexible additional context
    
    PRIMARY KEY (ts, signal_source, signal_key)
);

SELECT create_hypertable('external_signals', 'ts');
```

### What to Collect in `external_signals`:

#### Category 1: Institutional Flow (High Value)
| signal_source | signal_key | What it captures |
|---|---|---|
| `FII_DII` | `fii_index_futures_net` | FII net buy/sell in index futures (₹Cr) |
| `FII_DII` | `fii_index_options_net` | FII net buy/sell in index options |
| `FII_DII` | `dii_cash_net` | DII net in cash segment |
| `FII_DII` | `fii_long_short_ratio` | FII long/short ratio in index futures |

**Why:** FII positioning is the #1 predictor of overnight gap direction. If FIIs are heavily short on futures + your straddle exhaustion signal fires = very high conviction entry.

**Source:** NSE publishes daily. Scrape from `nseindia.com/reports` at 8:30 PM.

#### Category 2: Global Cues (High Value)
| signal_source | signal_key | What it captures |
|---|---|---|
| `GLOBAL` | `sgx_nifty` | SGX Nifty futures (pre-market) |
| `GLOBAL` | `dow_futures` | Dow futures |
| `GLOBAL` | `vix_us` | CBOE VIX |
| `GLOBAL` | `dxy` | Dollar index |
| `GLOBAL` | `crude_brent` | Brent crude price |
| `GLOBAL` | `us_10y_yield` | US 10-year treasury yield |
| `GLOBAL` | `gift_nifty` | GIFT Nifty (replaced SGX) |

**Why:** Pre-market GIFT Nifty + US VIX gives you gap-up/gap-down expectation. If expected gap is >0.5%, your Strategy 2 (directional straddle) entry timing changes completely.

**Source:** Free APIs — Yahoo Finance, TradingView webhooks, or simply scrape at 8:45 AM before market open.

#### Category 3: Social/News Sentiment (Medium Value, High Future Value)
| signal_source | signal_key | What it captures |
|---|---|---|
| `TWITTER` | `nifty_mention_velocity` | Tweets/min mentioning Nifty/BankNifty |
| `TWITTER` | `nifty_sentiment_score` | Sentiment polarity (-1 to +1) |
| `TWITTER` | `top_fintwit_alerts` | Key accounts posting alerts (JSON) |
| `NEWS` | `breaking_news_flag` | Binary: major news detected |
| `NEWS` | `rbi_policy_flag` | RBI announcement day marker |
| `NEWS` | `us_fed_flag` | US Fed decision day marker |
| `TELEGRAM` | `trading_group_signal_count` | Signals from popular trading Telegram groups |

**Why:** Twitter velocity spike on "Nifty" correlates with volatility expansion events. In 3 years with enough data, you can build a pre-signal: "social velocity spiking → straddle expansion likely → prepare for exhaustion trade."

**Source:** Twitter/X API (paid now, ~$100/month for basic), or use a free RSS-to-sentiment pipeline via NewsAPI + simple NLP.

#### Category 4: Economic Calendar & Events (High Value)
| signal_source | signal_key | What it captures |
|---|---|---|
| `CALENDAR` | `event_type` | 'RBI_POLICY', 'GDP', 'IIP', 'CPI', 'FED_FOMC', 'EXPIRY', 'BUDGET' |
| `CALENDAR` | `event_impact` | 'HIGH', 'MEDIUM', 'LOW' |
| `CALENDAR` | `minutes_to_event` | Countdown to event release |
| `CALENDAR` | `is_weekly_expiry` | Boolean — expiry day flag |
| `CALENDAR` | `is_monthly_expiry` | Boolean |
| `CALENDAR` | `days_to_expiry` | DTE for tracked contracts |

**Why:** Your straddle strategies behave completely differently on expiry days vs non-expiry. RBI policy days have a known pattern: IV crush post-announcement. This is pure gold for your retrospection engine — segment all performance by event type.

**Source:** Static calendar, updated monthly. Investing.com economic calendar can be scraped.

#### Category 5: Market Microstructure (Medium Value)
| signal_source | signal_key | What it captures |
|---|---|---|
| `MICROSTRUCTURE` | `bid_ask_spread_atm_ce` | Spread in ATM CE |
| `MICROSTRUCTURE` | `bid_ask_spread_atm_pe` | Spread in ATM PE |
| `MICROSTRUCTURE` | `total_market_volume` | Total options volume across all strikes |
| `MICROSTRUCTURE` | `atm_volume_ratio` | ATM volume / total volume |

**Why:** Wide bid-ask spreads = low liquidity = dangerous to enter. Your personality system should factor this in — Conservative personality should refuse entry when spread > 2% of premium.

**Source:** Broker API (if available), or compute from OHLC approximation.

#### Category 6: Sector & Breadth (Low Priority, High Future Value)
| signal_source | signal_key | What it captures |
|---|---|---|
| `BREADTH` | `advance_decline_ratio` | NSE advance/decline |
| `BREADTH` | `new_high_low_diff` | New 52W highs minus lows |
| `BREADTH` | `sector_rotation_score` | Custom: which sectors leading/lagging |
| `BREADTH` | `bank_nifty_nifty_ratio` | BankNifty/Nifty relative strength |

**Why:** When advance-decline diverges from Nifty direction, reversals are more likely. Feeds into your directional strategy's confidence score.

---

## Table 6: `paper_trades` (Personality Trading Log)

```sql
CREATE TABLE paper_trades (
    id                  BIGSERIAL PRIMARY KEY,
    ts_entry            TIMESTAMPTZ NOT NULL,
    ts_exit             TIMESTAMPTZ,
    instrument_id       INTEGER NOT NULL REFERENCES instruments(id),
    personality         VARCHAR(20) NOT NULL,   -- 'CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'
    strategy            VARCHAR(20) NOT NULL,   -- 'NON_DIRECTIONAL', 'DIRECTIONAL', 'MOMENTUM_BUY'
    
    -- Entry details
    signal_id           BIGINT REFERENCES straddle_signals(id),
    entry_strike_ce     NUMERIC(10,2),
    entry_strike_pe     NUMERIC(10,2),
    entry_premium_ce    NUMERIC(10,2),
    entry_premium_pe    NUMERIC(10,2),
    entry_straddle_val  NUMERIC(10,2),
    position_size       INTEGER NOT NULL DEFAULT 1,  -- lots
    
    -- Exit details
    exit_premium_ce     NUMERIC(10,2),
    exit_premium_pe     NUMERIC(10,2),
    exit_reason         VARCHAR(30),            -- 'SL_HIT', 'TSL_HIT', 'TARGET', 'EOD', 'MANUAL'
    
    -- P&L
    pnl                 NUMERIC(12,2),
    pnl_per_lot         NUMERIC(10,2),
    max_drawdown        NUMERIC(10,2),          -- worst point during trade
    max_favorable       NUMERIC(10,2),          -- best point during trade
    
    -- Context at entry (denormalized for fast retrospection)
    vix_at_entry        NUMERIC(8,4),
    spot_at_entry       NUMERIC(12,2),
    minutes_since_open  INTEGER,
    is_expiry_day       BOOLEAN,
    event_flag          VARCHAR(50),            -- any active event from calendar
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_paper_trades_personality ON paper_trades (personality, ts_entry DESC);
CREATE INDEX idx_paper_trades_strategy ON paper_trades (strategy, ts_entry DESC);
```

---

## Table 7: `retrospection_results` (EOD Analysis Output)

```sql
CREATE TABLE retrospection_results (
    id                  BIGSERIAL PRIMARY KEY,
    analysis_date       DATE NOT NULL,
    instrument_id       INTEGER NOT NULL REFERENCES instruments(id),
    personality         VARCHAR(20) NOT NULL,
    
    -- Daily aggregates
    total_trades        INTEGER,
    winning_trades      INTEGER,
    total_pnl           NUMERIC(12,2),
    max_drawdown        NUMERIC(10,2),
    sharpe_daily        NUMERIC(8,4),
    
    -- Pattern insights (JSON for flexibility)
    insights            JSONB,
    /*
    Example insights JSON:
    {
        "best_entry_offset_from_peak": -12,     // points below peak
        "avg_gap_signal_to_peak_min": 3.5,      // minutes
        "win_rate_by_hour": {"9": 0.45, "10": 0.62, "11": 0.58},
        "vix_sweet_spot": {"min": 12, "max": 18},
        "avoid_pattern": "back_to_back_loss_recovery",
        "suggested_param_changes": {
            "sl_pct": 118,                       // current 115, suggesting 118
            "tsl_move": 12                       // current 15, suggesting 12
        }
    }
    */
    
    -- Parameter evolution tracking
    params_before       JSONB,                   -- personality params at start of day
    params_after        JSONB,                   -- suggested params for next day
    evolution_applied   BOOLEAN DEFAULT FALSE,   -- was the suggestion accepted?
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Continuous Aggregates (TimescaleDB Materialized Views)

For dashboard performance — pre-aggregate common queries:

```sql
-- 1-minute OHLC from 15-second ticks (for charting)
CREATE MATERIALIZED VIEW option_ticks_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', ts) AS ts_1m,
    instrument_id,
    strike_price,
    option_type,
    expiry_date,
    first(open, ts) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, ts) AS close,
    sum(volume) AS volume,
    last(oi, ts) AS oi,
    last(iv, ts) AS iv,
    last(delta, ts) AS delta,
    last(theta, ts) AS theta,
    last(vega, ts) AS vega
FROM option_ticks
GROUP BY ts_1m, instrument_id, strike_price, option_type, expiry_date;

-- 5-minute straddle summary (for dashboard + retrospection)
CREATE MATERIALIZED VIEW straddle_5m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', ts) AS ts_5m,
    instrument_id,
    last(atm_straddle_value, ts) AS straddle_value,
    max(atm_straddle_value) AS straddle_high,
    min(atm_straddle_value) AS straddle_low,
    last(straddle_ema20, ts) AS straddle_ema20,
    last(straddle_accel_ema20, ts) AS straddle_accel_ema20,
    last(straddle_exhaustion_score, ts) AS exhaustion_score,
    last(vix, ts) AS vix,
    last(vix_accel_ema20, ts) AS vix_accel_ema20,
    last(pcr_oi, ts) AS pcr_oi
FROM market_snapshots
GROUP BY ts_5m, instrument_id;

-- Refresh policies
SELECT add_continuous_aggregate_policy('option_ticks_1m',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '15 seconds',
    schedule_interval => INTERVAL '1 minute');

SELECT add_continuous_aggregate_policy('straddle_5m',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '15 seconds',
    schedule_interval => INTERVAL '1 minute');
```

---

## Data Retention Policy

```sql
-- Keep raw 15-second data for 6 months
SELECT add_retention_policy('option_ticks', INTERVAL '6 months');

-- Keep 1-min aggregates for 2 years
SELECT add_retention_policy('option_ticks_1m', INTERVAL '2 years');

-- Keep external signals forever (they're small)
-- No retention policy on external_signals

-- Keep market_snapshots for 3 years
SELECT add_retention_policy('market_snapshots', INTERVAL '3 years');
```

---

## Entity Relationship Summary

```
instruments (1) ──────< (N) market_snapshots
     │                         │
     │                         │ (same ts + instrument_id)
     │                         │
     └──────< (N) option_ticks ┘
                    │
                    │ (derived from)
                    ▼
            straddle_signals (1) ──────< (N) paper_trades
                                               │
                                               │ (aggregated into)
                                               ▼
                                      retrospection_results

external_signals ──── independent, joined by timestamp when needed
```

---

## Key Query Patterns Your System Will Run

### 1. Peak Detection (every 15 seconds)
```sql
-- Multi-timeframe exhaustion check
-- Signal fires when: EMA-40 flattening + EMA-20 flipped negative + EMA-8 already negative
SELECT ts, atm_straddle_value,
       straddle_exhaustion_score,
       straddle_accel_ema8,
       straddle_accel_ema20,
       straddle_accel_ema40,
       CASE
           WHEN straddle_accel_ema8 < 0
                AND straddle_accel_ema20 < 0
                AND ABS(straddle_accel_ema40) < 0.05  -- flattening, not necessarily negative
           THEN 'HIGH_CONFIDENCE_EXHAUSTION'
           WHEN straddle_accel_ema8 < 0
                AND straddle_accel_ema20 < 0
           THEN 'EARLY_EXHAUSTION'
           WHEN straddle_accel_ema8 < 0
                AND straddle_roc_ema20 > 0            -- EMA-20 still rising but EMA-8 flipped
           THEN 'APPROACHING'
           ELSE 'NO_SIGNAL'
       END AS signal_state
FROM market_snapshots 
WHERE instrument_id = 1 AND ts > NOW() - INTERVAL '10 minutes'
ORDER BY ts DESC
LIMIT 1;
```

### 2. Personality Entry Check
```sql
-- Conservative: Has this personality made ₹5K in last 5 days?
SELECT COALESCE(SUM(pnl), 0) AS recent_pnl
FROM paper_trades
WHERE personality = 'CONSERVATIVE' 
  AND instrument_id = 1
  AND ts_entry > NOW() - INTERVAL '5 days';
```

### 3. Retrospection: Best entry offset analysis
```sql
-- For all exhaustion signals, what was the optimal entry point?
SELECT 
    signal_type,
    trigger_layer,
    AVG(EXTRACT(EPOCH FROM signal_to_peak_gap)) AS avg_gap_seconds,
    AVG(pnl_if_entered) AS avg_pnl,
    COUNT(*) AS sample_size
FROM straddle_signals
WHERE instrument_id = 1 AND actual_peak_ts IS NOT NULL
GROUP BY signal_type, trigger_layer;
```

### 4. Retrospection: Which EMA timeframe is most predictive?
```sql
-- Compare signal accuracy by trigger layer over rolling 30 days
SELECT 
    trigger_layer,
    COUNT(*) AS total_signals,
    COUNT(*) FILTER (WHERE signal_to_peak_gap < INTERVAL '2 minutes') AS accurate_signals,
    ROUND(
        COUNT(*) FILTER (WHERE signal_to_peak_gap < INTERVAL '2 minutes')::NUMERIC / COUNT(*), 3
    ) AS accuracy_rate,
    AVG(pnl_if_entered) AS avg_pnl
FROM straddle_signals
WHERE instrument_id = 1 
  AND ts > NOW() - INTERVAL '30 days'
  AND actual_peak_ts IS NOT NULL
GROUP BY trigger_layer
ORDER BY accuracy_rate DESC;
-- Use this to auto-tune which layer your personalities trust most
```
