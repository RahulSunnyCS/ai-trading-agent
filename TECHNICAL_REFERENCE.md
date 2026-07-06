# AI Trading Agent — Technical Reference

## System Architecture

### Overview

The system is a **real-time event-driven pipeline** composed of four layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  DATA INGESTION  →  EVENT PROCESSING  →  SIGNAL GENERATION  →  EXECUTION & RETROSPECTION
└─────────────────────────────────────────────────────────────────┘
```

### Layer Breakdown

```
┌────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: DATA INGESTION                                               │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────┐           │
│  │ NSE/BSE Feed │  │ Quantiply API    │  │ India VIX     │           │
│  │ (WebSocket)  │  │ (Paper Trading)  │  │ External Sig. │           │
│  └──────┬───────┘  └────────┬─────────┘  └──────┬────────┘           │
│         └──────────────────┬┘                   │                    │
│                            ▼                                          │
│  LAYER 2: EVENT PROCESSING                                            │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Redis Streams                                               │    │
│  │  Topics: market.ticks | straddle.values | signals.generated  │    │
│  └──────────────────────────────────┬───────────────────────────┘    │
│                                     ▼                                 │
│  LAYER 3: SIGNAL GENERATION                                           │
│  ┌─────────────────┐  ┌─────────────┐  ┌──────────────────────────┐ │
│  │ Straddle Calc   │→ │  ROC Engine │→ │ Signal Generator         │ │
│  │ (ATM CE+PE)     │  │ (Accel/     │  │ (Peak Detection)         │ │
│  │                 │  │  Decel)     │  │ → Personality Router     │ │
│  └─────────────────┘  └─────────────┘  └──────────────────────────┘ │
│                                                                       │
│  LAYER 4: EXECUTION & RETROSPECTION                                   │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Conservative Bot │ Balanced Bot │ Aggressive Bot              │  │
│  │          ↓               ↓              ↓                      │  │
│  │           Paper Trades (Quantiply API)                         │  │
│  │                    ↓                                           │  │
│  │           EOD Retrospection (BullMQ)                           │  │
│  │                    ↓                                           │  │
│  │           Parameter Evolution                                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| **Language** | TypeScript | 5.x | Type safety for financial logic, compile-time error catching |
| **Runtime** | Bun | Latest | 4× faster startup than Node.js, native TS, better perf |
| **Web Framework** | Fastify | 4.x | 5× faster than Express, schema validation, ~2ms p99 latency |
| **Message Queue** | Redis Streams | — | Simpler than Kafka, sub-ms latency, sufficient throughput |
| **Primary DB** | PostgreSQL | 16 | ACID guarantees, JSONB support, mature ecosystem |
| **Time-Series DB** | TimescaleDB | 2.x | Auto-partitioning, continuous aggregates, 10–100× faster time queries |
| **Cache** | Redis | 7 | Sub-ms reads, pub/sub, optional persistence |
| **Task Queue** | BullMQ | Latest | Redis-backed job processing for EOD retrospection |
| **Frontend** | React + Vite | 18 | Real-time dashboards, HMR, fast build |
| **Charts** | Lightweight Charts | — | Professional OHLC trading charts |
| **State Management** | Zustand | — | Minimal boilerplate, real-time subscriptions |
| **Styling** | Tailwind CSS | 3.x | Rapid UI development |
| **Testing** | Vitest + Playwright | — | Fast unit tests, E2E browser coverage |
| **Deployment** | Docker + Railway/Fly.io | — | Auto-scaling, cost-effective cloud deployment |

---

## Signal Generation Engine

### Momentum Exhaustion Algorithm

The core signal type. Detects when straddle expansion has peaked by measuring deceleration of rate-of-change.

#### Inputs
- ATM CE and PE LTP (last traded price), polled every 15 seconds
- EMA windows: 8-min, 5-min, 10-min
- India VIX value

#### Computation Pipeline

```
1. straddle_value = ATM_CE_LTP + ATM_PE_LTP

2. expansion_pct = (straddle_value - open_straddle_value) / open_straddle_value × 100

3. roc = (straddle_value[t] - straddle_value[t-1]) / straddle_value[t-1]

4. acceleration = roc[t] - roc[t-1]   // second derivative

5. ema_8   = EMA(straddle_value, 8min window)
   ema_20  = EMA(straddle_value, 20min window)  // used in option_ticks

6. exhaustion_score = f(expansion_pct, roc, acceleration, ema_crossover)
```

#### Trigger Conditions
- `expansion_pct >= min_expansion_percent` (configurable: 5–25%, default 10%)
- `acceleration < acceleration_threshold` (configurable: -2.0 to -0.1)
- ROC has declined for at least `roc_decline_window` candles
- `confirmation_candles` consecutive confirming bars (default: 2–5)

#### Probability Calculation

```
base_probability = 0.55

adjustments:
  + vix_adjustment   (higher VIX → lower probability)
  + time_of_day_adj  (9:20–9:45 AM → higher)
  + day_of_week_adj  (Monday/Friday → lower)

final_probability = clamp(base_probability + Σ adjustments, 0.0, 1.0)
```

### Additional Signal Types

| Signal Type | Trigger | Use Case |
|-------------|---------|---------|
| **Scheduled Entry** | Fixed time (9:17 AM, 9:24 AM) | Fallback when no momentum signal fires |
| **Pullback Entry** | 2% retrace from detected peak | Higher-confidence entry after initial peak |

---

## Multi-Personality Decision Engine

Each personality independently evaluates every signal through a 5-stage filter:

```
Signal Received
      │
      ▼
┌─────────────────────────────────────────────┐
│ STAGE 1: HARD FILTERS                       │
│  • strategy_id in personality.allowed_strats│
│  • underlying in allowed_underlyings        │
│  • current_time in [market_open, cutoff]    │
│  • date not in blocked_dates                │
└──────────────────────┬──────────────────────┘
                       │ PASS
                       ▼
┌─────────────────────────────────────────────┐
│ STAGE 2: STATE CHECKS                       │
│  • daily_trade_count < max_daily_trades     │
│  • daily_pnl > -max_daily_loss              │
│  • consecutive_losses < max_consec_losses   │
└──────────────────────┬──────────────────────┘
                       │ PASS
                       ▼
┌─────────────────────────────────────────────┐
│ STAGE 3: CONTEXT CHECKS                     │
│  • current_vix in [min_vix, max_vix]        │
│  • market_regime in allowed_regimes         │
└──────────────────────┬──────────────────────┘
                       │ PASS
                       ▼
┌─────────────────────────────────────────────┐
│ STAGE 4: SIGNAL QUALITY                     │
│  • signal.probability >= min_probability    │
└──────────────────────┬──────────────────────┘
                       │ PASS
                       ▼
┌─────────────────────────────────────────────┐
│ STAGE 5: PROFIT GATE (optional)             │
│  • recent_pnl(last 5 days) > profit_gate    │
└──────────────────────┬──────────────────────┘
                       │ PASS
                       ▼
                  EXECUTE TRADE
```

### Personality Parameter Reference

| Parameter | Conservative | Balanced | Aggressive | Type |
|-----------|-------------|----------|------------|------|
| `min_probability` | 0.75 | 0.60 | 0.50 | float |
| `max_daily_trades` | 2 | 4 | 8 | int |
| `max_daily_loss` | ₹5,000 | ₹10,000 | ₹20,000 | int |
| `max_vix` | 18 | 25 | 35 | float |
| `min_vix` | 10 | 8 | 0 | float |
| `entry_delay_seconds` | 300 (5 min) | 120 (2 min) | 30 | int |
| `position_size_multiplier` | 1.0 | 1.0 | 1.5 | float |
| `require_profit_gate` | true | false | false | bool |
| `profit_gate_amount` | ₹5,000 | — | — | int |
| `profit_gate_lookback_days` | 5 | — | — | int |
| `allow_reentry` | false | false | true | bool |
| `allowed_regimes` | LOW_VOL | LOW_VOL, HIGH_VOL, RANGING | ALL | enum[] |

**Configurable ranges for evolution:**
- `min_probability`: 0.40 – 0.90
- `max_daily_trades`: 1 – 15
- `entry_delay_seconds`: 0 – 600
- `max_daily_loss`: ₹2K – ₹25K
- `position_size_multiplier`: 0.25 – 2.5

---

## Database Schema

### Hypertables (TimescaleDB)

#### `market_ticks`
Raw WebSocket tick data. Partitioned by time.

```sql
CREATE TABLE market_ticks (
  time            TIMESTAMPTZ NOT NULL,
  symbol          TEXT NOT NULL,
  underlying      TEXT NOT NULL,   -- NIFTY, BANKNIFTY, SENSEX
  expiry          DATE,
  strike          INTEGER,
  option_type     CHAR(2),         -- CE | PE
  ltp             NUMERIC(10,2),
  bid             NUMERIC(10,2),
  ask             NUMERIC(10,2),
  volume          BIGINT,
  oi              BIGINT
);
SELECT create_hypertable('market_ticks', 'time');
```

#### `straddle_snapshots`
Pre-computed straddle values every 15 seconds. Core input for signal generation.

```sql
CREATE TABLE straddle_snapshots (
  time            TIMESTAMPTZ NOT NULL,
  underlying      TEXT NOT NULL,
  expiry          DATE NOT NULL,
  atm_strike      INTEGER NOT NULL,
  ce_ltp          NUMERIC(10,2),
  pe_ltp          NUMERIC(10,2),
  straddle_value  NUMERIC(10,2),   -- ce_ltp + pe_ltp
  straddle_change_pct NUMERIC(8,4),
  roc             NUMERIC(10,6),   -- rate of change
  acceleration    NUMERIC(10,6),   -- second derivative of roc
  vix             NUMERIC(6,2)
);
SELECT create_hypertable('straddle_snapshots', 'time');
ALTER TABLE straddle_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'underlying, expiry'
);
```

#### `option_ticks`
Per-strike OHLC and derived values.

```sql
CREATE TABLE option_ticks (
  time              TIMESTAMPTZ NOT NULL,
  symbol            TEXT NOT NULL,
  underlying        TEXT NOT NULL,
  expiry            DATE NOT NULL,
  strike            INTEGER NOT NULL,
  option_type       CHAR(2) NOT NULL,
  open              NUMERIC(10,2),
  high              NUMERIC(10,2),
  low               NUMERIC(10,2),
  close             NUMERIC(10,2),
  volume            BIGINT,
  oi                BIGINT,
  price_ema8        NUMERIC(10,4),
  price_ema20       NUMERIC(10,4),
  price_ema40       NUMERIC(10,4),
  delta             NUMERIC(8,4),
  gamma             NUMERIC(8,6),
  theta             NUMERIC(8,4),
  vega              NUMERIC(8,4),
  exhaustion_score  NUMERIC(6,4)   -- 0.0–1.0, used in peak detection
);
SELECT create_hypertable('option_ticks', 'time');
```

### Standard Tables

#### `straddle_signals`
Output of the peak detection engine.

```sql
CREATE TABLE straddle_signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  underlying        TEXT NOT NULL,
  expiry            DATE NOT NULL,
  signal_time       TIMESTAMPTZ NOT NULL,
  signal_type       TEXT NOT NULL,       -- MOMENTUM_EXHAUSTION | SCHEDULED | PULLBACK
  atm_strike        INTEGER NOT NULL,
  straddle_value    NUMERIC(10,2),
  expansion_pct     NUMERIC(8,4),
  probability       NUMERIC(5,4),        -- 0.0–1.0
  confidence_tier   TEXT,                -- LOW | MEDIUM | HIGH
  trigger_layer     TEXT,                -- which rule layer triggered
  status            TEXT DEFAULT 'pending',
  -- Outcome tracking (filled post-hoc)
  actual_peak_value NUMERIC(10,2),
  actual_peak_time  TIMESTAMPTZ,
  signal_to_peak_gap_pct NUMERIC(8,4)   -- how close was the signal to actual peak?
);
```

#### `external_signals`
Flexible storage for external market context data.

```sql
CREATE TABLE external_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signal_date   DATE NOT NULL,
  signal_type   TEXT NOT NULL,   -- FII_DII | GLOBAL_CUES | SENTIMENT | CALENDAR
  source        TEXT,
  data          JSONB NOT NULL,  -- flexible schema per signal_type
  relevance     NUMERIC(4,2)     -- 0.0–1.0 relevance score
);
CREATE INDEX ON external_signals (signal_date, signal_type);
```

**JSONB payload examples:**
```json
// FII_DII
{ "fii_net": -1250.5, "dii_net": 876.3, "unit": "crore" }

// GLOBAL_CUES
{ "sgx_nifty": 22145.5, "dow_futures": 38920.0, "us_vix": 16.3, "gift_nifty": 22160.0 }

// CALENDAR
{ "event": "RBI Policy", "impact": "HIGH", "time": "10:00", "previous": "6.5%", "expected": "6.5%" }
```

#### `paper_trades`
One row per trade execution per personality.

```sql
CREATE TABLE paper_trades (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  personality_id        UUID REFERENCES personality_configs(id),
  signal_id             UUID REFERENCES straddle_signals(id),
  strategy_id           INTEGER NOT NULL,
  underlying            TEXT NOT NULL,
  expiry                DATE NOT NULL,
  entry_time            TIMESTAMPTZ NOT NULL,
  exit_time             TIMESTAMPTZ,
  status                TEXT DEFAULT 'open',   -- open | closed | stopped
  exit_reason           TEXT,                  -- TARGET | SL | TSL | EOD | MANUAL
  -- Legs
  entry_ce_strike       INTEGER,
  entry_ce_price        NUMERIC(10,2),
  exit_ce_price         NUMERIC(10,2),
  entry_pe_strike       INTEGER,
  entry_pe_price        NUMERIC(10,2),
  exit_pe_price         NUMERIC(10,2),
  lots                  INTEGER DEFAULT 1,
  position_multiplier   NUMERIC(4,2) DEFAULT 1.0,
  -- P&L
  gross_pnl             NUMERIC(12,2),
  net_pnl               NUMERIC(12,2),
  max_drawdown          NUMERIC(12,2),
  max_favorable_excursion NUMERIC(12,2),
  -- Context at entry
  vix_at_entry          NUMERIC(6,2),
  spot_at_entry         NUMERIC(10,2),
  straddle_at_entry     NUMERIC(10,2),
  market_regime         TEXT,
  has_event_flag        BOOLEAN DEFAULT FALSE
);
```

#### `personality_configs`
Version-controlled parameter sets for each personality.

```sql
CREATE TABLE personality_configs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,          -- clockwork | precision | scanner | adjuster | reducer | blitz | levelhead
  version             INTEGER NOT NULL,
  is_active           BOOLEAN DEFAULT TRUE,
  is_frozen           BOOLEAN DEFAULT FALSE,  -- TRUE for Clockwork — blocks all evolution rules
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Identity (fixed — changing these invalidates the experiment)
  entry_type          TEXT NOT NULL,          -- FIXED_TIME | MOMENTUM_EXHAUSTION | ANY_SIGNAL | SR_ANCHORED
  management_style    TEXT NOT NULL,          -- HOLD | ROLL | CUT_REENTER
  phase               INTEGER NOT NULL,       -- 1 = runs from day 1, 2 = Phase 2 only
  -- Core tunable parameters
  min_probability     NUMERIC(4,3) NOT NULL,
  max_daily_trades    INTEGER NOT NULL,
  max_daily_loss      NUMERIC(10,2) NOT NULL,
  entry_delay_secs    INTEGER NOT NULL,
  position_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  -- Management parameters (used by ROLL and CUT_REENTER styles)
  adjustment_trigger_points INTEGER,          -- index points before roll/cut fires
  max_open_legs             INTEGER,          -- hard cap on total open legs
  reentry_min_probability   NUMERIC(4,3),     -- min signal quality to re-enter
  -- VIX constraints
  min_vix             NUMERIC(5,2) DEFAULT 0,
  max_vix             NUMERIC(5,2) DEFAULT 100,
  -- Feature flags
  require_profit_gate BOOLEAN DEFAULT FALSE,
  profit_gate_amount  NUMERIC(10,2),
  profit_gate_days    INTEGER,
  allow_reentry       BOOLEAN DEFAULT FALSE,
  reentry_delay_mins  INTEGER,
  allowed_regimes     TEXT[],
  allowed_strategies  INTEGER[],
  -- Performance cache (30-day rolling)
  cached_win_rate     NUMERIC(5,4),
  cached_sharpe       NUMERIC(6,4),
  cached_total_trades INTEGER,
  cache_updated_at    TIMESTAMPTZ,
  -- Evolution metadata
  evolved_from        UUID REFERENCES personality_configs(id),
  evolution_reason    TEXT
);
```

#### `retrospection_results`
Daily EOD analysis output. One row per personality per day.

```sql
CREATE TABLE retrospection_results (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_date         DATE NOT NULL,
  personality_id        UUID REFERENCES personality_configs(id),
  run_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Regime context (critical for all comparisons)
  market_regime         TEXT NOT NULL,   -- RANGING | TRENDING_STRONG | VOLATILE_REVERTING | EVENT_DAY
  vix_open              NUMERIC(6,2),
  index_move_pct        NUMERIC(6,4),    -- % move from open to close
  -- Aggregate metrics
  total_trades          INTEGER,
  winning_trades        INTEGER,
  losing_trades         INTEGER,
  win_rate              NUMERIC(5,4),
  total_pnl             NUMERIC(12,2),
  avg_pnl_per_trade     NUMERIC(10,2),
  max_drawdown          NUMERIC(12,2),
  sharpe_ratio          NUMERIC(8,4),
  -- Clockwork comparison (filled for all non-Clockwork personalities)
  clockwork_pnl_today   NUMERIC(12,2),  -- what Clockwork made on the same day
  beat_clockwork_by     NUMERIC(12,2),  -- positive = beat, negative = lost to
  -- Signal calibration (filled for signal-based personalities)
  signals_received      INTEGER,
  signals_acted_on      INTEGER,
  signal_brier_score    NUMERIC(6,4),   -- lower = better calibrated
  -- Management effectiveness (filled for Adjuster, Reducer, Blitz)
  adjustments_made      INTEGER,
  mgmt_pnl_delta        NUMERIC(12,2),  -- P&L vs estimated hold baseline
  mgmt_verdict          TEXT,           -- HELPED | HURT | NEUTRAL
  -- Comparison integrity check
  threshold_drift_flag  BOOLEAN DEFAULT FALSE,  -- true if entry threshold diverged from peers
  evolution_paused      BOOLEAN DEFAULT FALSE,
  -- Insights and suggestions
  insights              JSONB,
  suggested_changes     JSONB,
  applied               BOOLEAN DEFAULT FALSE,
  applied_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX ON retrospection_results (analysis_date, personality_id);
CREATE INDEX ON retrospection_results (market_regime, personality_id);
```

**`insights` JSONB structure:**
```json
{
  "regime": "RANGING",
  "beat_clockwork_pnl": 1110.0,
  "beat_clockwork_pct": 60.3,
  "best_entry_offsets": [{ "offset_min": 5, "win_rate": 0.68 }],
  "win_rate_by_hour":   { "09": 0.55, "10": 0.61 },
  "vix_sweet_spots":    [{ "min": 12, "max": 16, "win_rate": 0.72 }],
  "strategy_breakdown": [{ "strategy_id": 1, "trades": 8, "win_rate": 0.625 }],
  "signal_calibration": {
    "signals_at_70_plus": 2,
    "actual_win_rate_at_70_plus": 1.0,
    "brier_score": 0.12
  },
  "management_effectiveness": {
    "adjustments_made": 1,
    "pnl_delta_vs_hold_baseline": -750.0,
    "verdict": "roll_hurt_on_ranging_day"
  }
}
```

### Continuous Aggregates

```sql
-- 1-minute OHLC for charting
CREATE MATERIALIZED VIEW straddle_1min
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  underlying,
  expiry,
  first(straddle_value, time)   AS open,
  max(straddle_value)           AS high,
  min(straddle_value)           AS low,
  last(straddle_value, time)    AS close
FROM straddle_snapshots
GROUP BY bucket, underlying, expiry;
```

### Data Volume Estimates

| Source | Rate | Daily Rows | Annual Rows | Compressed Size |
|--------|------|-----------|------------|-----------------|
| `straddle_snapshots` | 1/15s × 2 indices × 38 contracts | ~114K | ~28.5M | ~1–2 GB |
| `option_ticks` | 1/min × all strikes | ~50K | ~12M | ~500 MB |
| `market_ticks` | Raw WebSocket | ~500K+ | ~125M+ | ~5–10 GB |

---

## Evolution Engine

### Core Constraint: What Can Never Change

Before any evolution rule runs, the engine checks two hard locks:

```typescript
const FROZEN_PERSONALITIES = ['clockwork'];  // never touched by any rule

const FROZEN_ATTRIBUTES = [
  'entry_type',        // FIXED_TIME | MOMENTUM_EXHAUSTION | ANY_SIGNAL | SR_ANCHORED
  'management_style',  // HOLD | ROLL | CUT_REENTER
];
// These define the personality's identity. Changing them creates a different experiment.
```

If a rule targets a frozen personality or a frozen attribute, the rule is rejected with a `FROZEN_VIOLATION` error — not silently skipped, so it's visible in logs.

---

### Comparison Integrity Enforcement

Precision, Adjuster, and Reducer all use the same entry style (momentum exhaustion). Their `min_probability` thresholds must stay within 8 percentage points of each other for the management comparison to be valid.

```typescript
function checkComparisonIntegrity(configs: PersonalityConfig[]): IntegrityResult {
  const group = configs.filter(p =>
    p.entry_type === 'MOMENTUM_EXHAUSTION' && p.name !== 'clockwork'
  );
  const thresholds = group.map(p => p.min_probability);
  const drift = Math.max(...thresholds) - Math.min(...thresholds);

  if (drift > 0.08) {
    const outlier = group.find(p => p.min_probability === Math.max(...thresholds));
    return { valid: false, pause_evolution_for: outlier.id, drift };
  }
  return { valid: true };
}
```

This runs before any evolution rule is applied. If integrity is violated, the outlier's evolution is paused until alignment is restored.

---

### Phase 1: Rule-Based Evolution

Pre-defined rules trigger parameter adjustments when performance thresholds are crossed. Rules are **regime-aware** — a rule triggered on a RANGING day may not apply on a TRENDING day.

```typescript
type EvolutionRule = {
  id: string;
  applicable_to: string[];          // personality names this rule applies to
  regime_filter?: RegimeTag[];      // only trigger in these regimes (null = all)
  min_sample_size: number;          // minimum trades before rule can fire
  condition: (metrics: PerformanceMetrics) => boolean;
  adjustment: (config: PersonalityConfig) => Partial<PersonalityConfig>;
  cooldown_days: number;
  max_applications: number;
  requires_approval: boolean;
};
```

**Entry tuning rules** (apply to all non-Clockwork personalities):

| Rule | Min Samples | Condition | Adjustment |
|------|------------|-----------|------------|
| `low_win_rate` | 30 | win_rate < 0.40 | increase `min_probability` by 0.05 |
| `high_win_rate` | 30 | win_rate > 0.65 | decrease `min_probability` by 0.03 |
| `excessive_drawdown` | 20 | max_drawdown > ₹20K | reduce `max_daily_trades` by 1 |
| `severe_drawdown` | 10 | max_drawdown > ₹25K | reduce `max_daily_trades` by 2 + requires_approval |
| `vix_losses` | 20 | loss_rate when VIX > 20 > 60% | reduce `max_vix` by 3 |

**Management tuning rules** (Adjuster, Reducer, Blitz only):

| Rule | Min Samples | Regime Filter | Condition | Adjustment |
|------|------------|--------------|-----------|------------|
| `roll_hurts_ranging` | 10 RANGING days | RANGING | roll_pnl_delta_vs_hold < -₹500 avg | increase `roll_trigger_points` by 20 |
| `roll_hurts_trending` | 10 TRENDING days | TRENDING | roll_pnl_delta_vs_hold < -₹500 avg | increase `roll_trigger_points` by 30 |
| `cut_too_early_ranging` | 10 RANGING days | RANGING | cut_pnl_delta_vs_hold < -₹400 avg | increase `cut_trigger_points` by 20 |
| `reentry_missing_moves` | 10 any | any | re_entry_pnl < 0 on avg | increase re-entry signal threshold by 0.05 |
| `whipsaw_detection` | 15 | any | avg_hold < 10min AND win_rate < 0.45 | increase `entry_delay_secs` by 60 |

All rules have:
- **Minimum sample size** — rules cannot fire on thin data
- **Cooldown period** — minimum days between applications (prevents thrashing)
- **Max applications** — caps cumulative drift on any single parameter
- **Approval gate** — high-impact rules flag for human confirmation before applying

### Phase 2: Bayesian Optimization (Planned)

Use a Gaussian Process to model the performance surface over the parameter space and sample efficiently toward the optimum. Requires ~200+ trade samples for reliable estimation.

### Phase 3: Genetic Algorithms (Planned)

```
Population: [personality_configs]
Fitness:    sharpe_ratio × win_rate_bonus - drawdown_penalty
Selection:  Top 50% survive
Crossover:  Mix parameters from two parents
Mutation:   ±small random perturbation within allowed ranges
Generations: Run weekly on accumulated data
```

---

## API Endpoints (Planned)

### Signal Management

```http
POST   /signals                          # Manually trigger signal evaluation
GET    /signals/{id}                     # Get signal details + outcome
GET    /signals?underlying=NIFTY&date=   # List signals with filters
```

### Personality Management

```http
GET    /personalities                    # List all personalities + current params
GET    /personalities/{id}/performance   # Performance metrics
POST   /personalities/{id}/evolve        # Trigger manual parameter evolution
PUT    /personalities/{id}/config        # Update parameters (with audit log)
```

### Trade Operations

```http
POST   /paper-trades                     # Execute paper trade
GET    /paper-trades/{id}                # Trade detail
GET    /paper-trades?personality=&date=  # List trades with filters
```

### Retrospection

```http
POST   /retrospection/run                # Trigger EOD analysis manually
GET    /retrospection/results/{date}     # Get analysis for a date
GET    /timing-analysis?underlying=      # Aggregated timing performance
```

### Dashboard Data

```http
GET    /dashboard/live                   # Real-time straddle + active signals
GET    /dashboard/summary                # Today's P&L across personalities
WebSocket /ws/ticks                      # Live tick stream for frontend
```

---

## Performance & Latency Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Tick-to-straddle calculation | < 5ms | In-memory Redis |
| Signal-to-decision latency p50 | < 50ms | Per personality |
| Signal-to-decision latency p99 | < 200ms | All 5 filter stages |
| Paper trade placement | < 500ms | Quantiply API round-trip |
| EOD retrospection runtime | < 5 min | BullMQ job, off critical path |
| Dashboard WebSocket latency | < 100ms | Redis pub/sub → React |

---

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Cloud (Railway / Fly.io)                                   │
│                                                             │
│  ┌────────────────┐    ┌────────────────┐                  │
│  │ API Server     │    │ Signal Worker  │                  │
│  │ (Fastify/Bun)  │    │ (Bun process)  │                  │
│  └───────┬────────┘    └───────┬────────┘                  │
│          │                     │                           │
│          └──────────┬──────────┘                           │
│                     ▼                                       │
│  ┌──────────────────────────────────────┐                  │
│  │  Redis 7 (Streams + Cache + BullMQ)  │                  │
│  └──────────────────────────────────────┘                  │
│                     │                                       │
│  ┌──────────────────────────────────────┐                  │
│  │  PostgreSQL 16 + TimescaleDB         │                  │
│  └──────────────────────────────────────┘                  │
│                                                             │
│  ┌────────────────┐                                        │
│  │ React Frontend │ ← served via CDN / static hosting      │
│  └────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

### Docker Compose Services

```yaml
services:
  api:         # Fastify application server
  worker:      # Signal generation + personality bots
  retrospect:  # BullMQ EOD job processor
  postgres:    # PostgreSQL 16 + TimescaleDB extension
  redis:       # Redis 7 (Streams + cache + BullMQ)
  frontend:    # Vite dev server (dev) / nginx (prod)
```

---

## Configuration Reference

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/trading
REDIS_URL=redis://host:6379

# Market Data
NSE_WEBSOCKET_URL=...
QUANTIPLY_API_KEY=...
QUANTIPLY_API_URL=...

# Signals
SIGNAL_MIN_EXPANSION_PCT=10        # % expansion before peak detection activates
SIGNAL_ACCELERATION_THRESHOLD=-0.5 # second derivative cutoff
SIGNAL_CONFIRMATION_CANDLES=3      # bars needed to confirm

# Evolution
EVOLUTION_REQUIRE_APPROVAL=true    # require human sign-off on high-impact changes
EVOLUTION_COOLDOWN_DAYS=3          # minimum days between rule applications

# Runtime
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
```

### Peak Detection Configuration Object

```typescript
interface PeakDetectionConfig {
  minExpansionPercent:     number;    // 5–25, default 10
  accelerationThreshold:   number;    // -2.0 to -0.1
  rocDeclineWindowMinutes: number;    // lookback window
  confirmationCandles:     number;    // 2–5
  emaWindows: {
    fast:   number;   // default 8 min
    medium: number;   // default 5 min (option_ticks)
    slow:   number;   // default 10 min
  };
  baseProbability:     number;   // default 0.55
  vixAdjustmentFactor: number;
  timeOfDayFactors:    Record<string, number>;
  dayOfWeekFactors:    Record<number, number>;  // 0=Sun…6=Sat
}
```

---

## Known Technical Risks

### 1. Slippage Model Is Too Optimistic

The current static 0.5–0.8% slippage assumption is dangerous. During momentum exhaustion — the exact moment signals fire — real slippage on stop-losses can be **5–15%**.

**Mitigation required:**
- Dynamic slippage model: `f(roc, spread, volume, oi)`
- Validate against Level-2 tick data (bid/ask depth), not just LTP
- Stress-test P&L with tail slippage scenarios

### 2. Overfitting via Retrospection Loop

Continuous parameter adaptation can converge to patterns that no longer exist in the market (regime change, seasonality). The retrospection loop is effectively a lagged learning machine.

**Mitigation required:**
- Regime-conditional static playbooks (don't adapt mid-regime)
- Hold out a validation period not used in optimization
- Require statistical significance before applying evolution rules (min 30 trades, p < 0.05)

### 3. Probability Score Calibration

Current `final_probability` values lack empirical calibration. A score of 0.70 does not necessarily mean 70% of signals at that score result in winning trades.

**Mitigation required:**
- Track signal outcomes against stated probabilities
- Generate Brier scores and reliability diagrams
- Recalibrate with isotonic regression or Platt scaling

### 4. Personality Correlation at Portfolio Level

All personalities trade the same underlying simultaneously. Their risk is behaviorally different but economically identical. A large adverse move hits all three.

**Mitigation required:**
- Portfolio-level gamma/delta exposure aggregation
- Circuit breaker: if aggregate position > X gamma, pause all personalities
- Consider rotating which personalities are active based on regime

---

## Testing Strategy

### Unit Tests (Vitest)

- Peak detection algorithm correctness
- Decision engine filter stages (each stage independently)
- Evolution rule trigger conditions
- P&L calculation accuracy
- Parameter validation and clamping

### Integration Tests

- Signal → personality → paper trade full flow
- Redis Streams message passing
- TimescaleDB continuous aggregate correctness

### E2E Tests (Playwright)

- Dashboard renders live data
- Trade log updates in real-time
- Retrospection results display

### Backtesting

Before production deployment:
- Run against minimum **6 months** of historical tick data
- Separate training (parameter fitting) and test (out-of-sample) periods
- Report: signal accuracy, per-personality Sharpe, drawdown by regime

---

## Research Governance

Before any parameter change becomes permanent:

1. **Experiment Card** — Document: hypothesis, parameter being changed, sample size required, holdout design, falsification condition
2. **Minimum Sample** — 30+ trades before evaluation, 50+ before significant changes
3. **Statistical Test** — Use two-sample t-test or Mann-Whitney U for win rate comparison (p < 0.05)
4. **Holdout Validation** — Reserve last 2 weeks of data; evolution must not use this period
5. **Change Log** — Every parameter change recorded with: date, old value, new value, triggering metrics, approver

---

*For product overview, features, and trading strategy details, see [PRODUCT_OVERVIEW.md](./PRODUCT_OVERVIEW.md).*
