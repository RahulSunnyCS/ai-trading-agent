# Architecture Reference

The stack list, essential commands, repository layout, conventions and
environment variables live in `.claude/project/technical.md`, which is
auto-loaded into every session. This file is the deep reference underneath it:
the schema, the engine internals, and the reasoning behind the choices.

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


## Why These Technologies

Versions live in `.claude/project/technical.md`; this table is the reasoning.


| Layer | Technology | Rationale |
| ------- | ----------- | ----------- |
| **Language** | TypeScript | Type safety for financial logic, compile-time error catching |
| **Runtime** | Bun | 4× faster startup than Node.js, native TS, better perf |
| **Web Framework** | Fastify | 5× faster than Express, schema validation, ~2ms p99 latency |
| **Message Queue** | Redis Streams | Simpler than Kafka, sub-ms latency, sufficient throughput |
| **Primary DB** | PostgreSQL | ACID guarantees, JSONB support, mature ecosystem |
| **Time-Series DB** | TimescaleDB | Auto-partitioning, continuous aggregates, 10–100× faster time queries |
| **Cache** | Redis | Sub-ms reads, pub/sub, optional persistence |
| **Task Queue** | BullMQ | Redis-backed job processing for EOD retrospection |
| **Frontend** | React + Vite | Real-time dashboards, HMR, fast build |
| **Charts** | Lightweight Charts | Professional OHLC trading charts |
| **State Management** | Zustand | Minimal boilerplate, real-time subscriptions |
| **Styling** | Tailwind CSS | Rapid UI development |
| **Testing** | Vitest + Playwright | Fast unit tests, E2E browser coverage |
| **Deployment** | Docker + Railway/Fly.io | Auto-scaling, cost-effective cloud deployment |

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


## Research Governance

Before any parameter change becomes permanent:

1. **Experiment Card** — Document: hypothesis, parameter being changed, sample size required, holdout design, falsification condition
2. **Minimum Sample** — 30+ trades before evaluation, 50+ before significant changes
3. **Statistical Test** — Use two-sample t-test or Mann-Whitney U for win rate comparison (p < 0.05)
4. **Holdout Validation** — Reserve last 2 weeks of data; evolution must not use this period
5. **Change Log** — Every parameter change recorded with: date, old value, new value, triggering metrics, approver

---

*Product reasoning and the personality reference: [docs/product.md](./product.md).*

---

## Historical data, backfill & replay (M3a)

### Backfill — load historical market data

The backfill writer (`apps/server/src/ingestion/historical/backfill.ts`) populates the database with historical OHLCV candles from Fyers. Call `runBackfill()` with a date range and symbol; it fetches candles and writes them into market_ticks and option_ticks hypertables.

**Key properties:**
- **Resumable:** if interrupted by auth failure (FyersAuthError), subsequent calls with the same options resume from the last checkpoint saved in backfill_ranges table.
- **Idempotent:** partial unique indexes prevent duplicate re-ingestion; re-running a completed range writes zero duplicates (INSERT ... ON CONFLICT DO NOTHING).
- **Fail-loud:** missing option legs (CE or PE contracts at any step) throw MissingLegError immediately — never interpolated or skipped.
- **Time-bounded:** all hypertable writes respect TimescaleDB's partitioning discipline — queries always include time-range filters.

### Replay — deterministic history simulation

Run the trading pipeline against historical data with a deterministic virtual clock:

```bash
# Against a scratch database (safe, no confirmation needed)
DATABASE_URL=postgresql://user:pass@localhost:5432/test_db \
  bun run replay --from 2024-01-25T03:45:00Z --to 2024-01-25T10:00:00Z --underlying NIFTY

# Against the live database (requires explicit acknowledgement)
bun run replay --from 2024-01-25T03:45:00Z --to 2024-01-25T10:00:00Z --underlying NIFTY --against-live
```

**Safety guard:** `bun run replay` refuses to connect to the live DATABASE_URL unless you pass `--against-live` (or set `REPLAY_CONFIRM_LIVE=true`), because the PositionMonitor can close real open paper trades. Point at a scratch database for normal use — no flag needed in that case.

**Flags:**
- `--from <ISO>`: replay window start (required)
- `--to <ISO>`: replay window end (required)
- `--underlying NIFTY|BANKNIFTY|SENSEX`: index to replay (default: NIFTY)
- `--speed <multiplier>`: virtual-time acceleration for log output (default: 1.0)
- `--verbose`: log each emitted tick (very noisy for long windows)
- `--dry-run`: load ticks without starting the pipeline (no paper-trade writes)
- `--against-live`: explicit opt-in to run against the live database
- `--regenerate-fixture`: developer-only; regenerate golden test fixtures (never in CI)

### Market regime tagging (M3a)

Historical days are automatically tagged with market regimes (RANGING, TRENDING_STRONG, VOLATILE_REVERTING, EVENT_DAY, UNCLASSIFIED) based on intraday straddle behavior and a deterministic event calendar.

**Causal/point-in-time:** regime classification uses only data observable at 14:30 IST — the same cutoff a real trader would use to decide whether to enter a position. No lookahead, no future bars consulted.

**Deterministic:** classification thresholds are compile-time constants (no learned values). Same input data always produces the same regime label.

**Event calendar:** EVENT_DAY dates (RBI policy days, Union Budgets, F&O expiry mornings, NSE holidays) are checked into the `event_calendar` table (seeded in migration 008). Operators can extend the table with new events via migrations; no env var needed for reproducible backtests.

### Database migrations (M3a)

Migrations 007, 008, and 009 support historical backfill and regime tagging:

- **007_historical_backfill.sql** — backfill checkpoint tracking and unique indexes for idempotent candle writes
- **008_regime_tagging.sql** — daily regime tags table, event calendar, and `resolution` column on straddle_snapshots
- **009_straddle_snapshots_unique.sql** — unique index on (time, symbol, strike, expiry) to enforce snapshot uniqueness in reconstruction

Apply all three with `bun run migrate`. 

**Note on 009:** if your straddle_snapshots table has duplicates from dev testing, dedup them before applying the migration (it will fail on duplicate rows). For a fresh dev database, this is not a concern.

---

## Deployment

> Folded in from the former `docs/setup.md` (deleted 2026-09-19). The
> day-to-day local commands live in `.claude/project/technical.md` →
> Essential Commands, which is auto-loaded; only the parts that file does
> not cover were kept.




#### Infrastructure Requirements

| Component | Requirement | Notes |
|-----------|------------|-------|
| **Database** | PostgreSQL 16 + TimescaleDB 2.x | Standard `postgres:16` images will NOT work; use `timescale/timescaledb:latest-pg16` |
| **Cache / Queue** | Redis 7+ | BullMQ uses Redis Streams features not in Redis 6 |
| **Runtime** | Bun 1.0+ | The backend is a Bun process; Node.js is not used |
| **Frontend** | Static file server or CDN | Build output goes to `dist/` via `bun run build` |
| **Compute** | Single server or PaaS (Railway, Fly.io) | No horizontal scaling needed for Phase 1 |

#### Railway Deployment

Railway is the recommended PaaS for this stack. It supports custom Dockerfiles, managed PostgreSQL add-ons, and Redis add-ons.

##### 1. Create a New Railway Project

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
```

##### 2. Add PostgreSQL + TimescaleDB

Railway's built-in PostgreSQL plugin does not include TimescaleDB. Use a custom database service:

```bash
railway add --name timescaledb
```

Set the image to `timescale/timescaledb:latest-pg16` in the service settings. Railway will expose `DATABASE_URL` automatically.

Alternatively, use [Aiven](https://aiven.io) or [Timescale Cloud](https://cloud.timescale.com) for a managed TimescaleDB — both offer free tiers.

##### 3. Add Redis

```bash
railway add --name redis
```

Use Railway's native Redis plugin. It exposes `REDIS_URL` automatically.

##### 4. Create a Dockerfile

Railway can build from a Dockerfile. Create one at the repository root:

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build frontend
RUN bun run build

# Run migrations then start the server
CMD ["sh", "-c", "bun run migrate && bun start"]
```

> The `bun run build` step compiles the Vite frontend into `dist/`. The Fastify server must be configured to serve `dist/` as static files in production (see Frontend Build section below).

##### 5. Set Environment Variables in Railway

In the Railway dashboard → your service → Variables, set:

```
NODE_ENV=production
PORT=3000
DATABASE_URL=<from Railway TimescaleDB service>
REDIS_URL=<from Railway Redis service>
SIMULATE=false
FYERS_APP_ID=<your app id>
FYERS_ACCESS_TOKEN=<daily token — see Fyers Token Refresh>
EVOLUTION_REQUIRE_APPROVAL=true
LOG_LEVEL=info
```

Add Razorpay variables if payment is enabled:
```
RAZORPAY_KEY_ID=<live key>
RAZORPAY_KEY_SECRET=<live secret>
RAZORPAY_WEBHOOK_SECRET=<webhook secret>
```

##### 6. Deploy

```bash
railway up
```

Railway builds the Docker image, runs migrations via `CMD`, and starts the app.

---

#### Fly.io Deployment

Fly.io is an alternative PaaS with native support for Bun.

##### 1. Install and Authenticate

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

##### 2. Create a Fly App

```bash
cd ai-trading-agent
fly launch --no-deploy
```

This creates `fly.toml`. Edit it:

```toml
app = "ai-trading-agent"
primary_region = "bom"   # Mumbai — nearest to NSE/BSE

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "8080"
  LOG_LEVEL = "info"
  SIMULATE = "false"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [services.concurrency]
    type = "requests"
    hard_limit = 200

[checks]
  [checks.health]
    grace_period = "30s"
    interval = "15s"
    method = "get"
    path = "/health"
    port = 8080
    timeout = "5s"
    type = "http"
```

##### 3. Provision Database (Timescale Cloud or Aiven)

Fly does not provide TimescaleDB. Use an external managed service:

- **Timescale Cloud**: [cloud.timescale.com](https://cloud.timescale.com) — managed TimescaleDB, free tier available. Select the Mumbai (ap-south-1) region for lowest latency.
- **Aiven**: [aiven.io](https://aiven.io) — managed PostgreSQL + TimescaleDB add-on.

Copy the connection string and set it as a Fly secret:
```bash
fly secrets set DATABASE_URL="postgresql://user:pass@host:5432/dbname?sslmode=require"
```

##### 4. Provision Redis (Upstash)

[Upstash](https://upstash.com) provides serverless Redis compatible with Fly.io:

```bash
fly secrets set REDIS_URL="rediss://default:token@host:6379"
```

##### 5. Set All Secrets

```bash
fly secrets set \
  FYERS_APP_ID="XXXXXXXXXXXX-100" \
  FYERS_ACCESS_TOKEN="<token>" \
  EVOLUTION_REQUIRE_APPROVAL="true" \
  RAZORPAY_KEY_ID="<key>" \
  RAZORPAY_KEY_SECRET="<secret>" \
  RAZORPAY_WEBHOOK_SECRET="<secret>"
```

##### 6. Deploy

```bash
fly deploy
```

---

#### Production Environment Variables

Complete reference for production deployments. Never commit these to version control.

```bash
# ── Core ──────────────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000              # or 8080 for Fly.io
LOG_LEVEL=warn         # reduce noise in prod; use info for first launch
SIMULATE=false         # must be false in production

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@host:5432/dbname?sslmode=require
# TimescaleDB must be installed — vanilla PostgreSQL will fail on migration

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL=redis://default:token@host:6379
# Redis 7+ required; use rediss:// (TLS) for managed providers

# ── Fyers Broker ──────────────────────────────────────────────────────────────
FYERS_APP_ID=XXXXXXXXXXXX-100
FYERS_ACCESS_TOKEN=<daily_oauth_token>   # Must be refreshed every day before 09:00 IST

# ── Angel One Broker (fallback, optional) ─────────────────────────────────────
ANGEL_API_KEY=
ANGEL_CLIENT_ID=
ANGEL_TOTP_SECRET=

# ── Payment (Razorpay) ────────────────────────────────────────────────────────
RAZORPAY_KEY_ID=rzp_live_XXXXXXXXXX     # Omit to run in free/open mode
RAZORPAY_KEY_SECRET=<secret>
RAZORPAY_WEBHOOK_SECRET=<webhook_signing_secret>

# ── Safety Guards ─────────────────────────────────────────────────────────────
EVOLUTION_REQUIRE_APPROVAL=true   # Never set false in prod

# ── Optional Overrides ────────────────────────────────────────────────────────
ENTRY_WINDOW_START_IST=09:15
ENTRY_WINDOW_END_IST=09:45
EOD_SQUAREOFF_IST=15:25
SIGNAL_MIN_EXPANSION_PCT=0.10
SIGNAL_CONFIRMATION_SNAPSHOTS=3
```

---

#### Database Setup in Production

Run migrations once before first launch. Subsequent deployments are idempotent.

```bash
# Run from within your production environment / CI step
bun run migrate
```

The migration runner:
- Applies all pending migrations in `apps/server/src/db/migrations/` in `NNN_` order
- Records each applied version in `schema_migrations`
- Is idempotent — safe to re-run on every deployment
- Creates TimescaleDB hypertables and continuous aggregates

**Never edit applied migration files.** Always add a new `NNN_description.sql` file for schema changes.

**Verify the database after first deploy:**
```bash
bun -e "
import { pool } from './apps/server/src/db/client.ts';
const r = await pool.query('SELECT hypertable_name FROM timescaledb_information.hypertables;');
console.log('Hypertables:', r.rows.map(r=>r.hypertable_name));
await pool.end();
"
```
Expected: `market_ticks`, `straddle_snapshots`, `option_ticks`

---

#### Frontend Build & Serving

In production, build the React frontend into static files and serve them from Fastify.

##### Build

```bash
bun run --filter @ata/dashboard build
# Output: apps/dashboard/dist/ (index.html + hashed JS/CSS bundles)
```

##### Configure Fastify to Serve Static Files

Ensure `apps/server/src/server/index.ts` registers the static plugin:

```typescript
import fastifyStatic from '@fastify/static';
import path from 'path';

// In production, serve the built frontend
if (process.env.NODE_ENV === 'production') {
  await server.register(fastifyStatic, {
    root: path.join(import.meta.dirname, '../../../dashboard/dist'),
    prefix: '/',
    decorateReply: false,
  });

  // SPA fallback — serve index.html for all non-API routes
  server.setNotFoundHandler((_req, reply) => {
    return reply.sendFile('index.html');
  });
}
```

> In development, Vite handles frontend serving on `:5173` and proxies API calls to Fastify on `:3000`. In production, Fastify serves everything on a single port.

---

#### Health Checks & Monitoring

##### Health Endpoint

The server exposes `GET /health`. Use this for load balancer and PaaS health checks:

```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","db":"connected","redis":"connected"}
```

##### Key Metrics to Monitor

| Metric | Where to check | Alert threshold |
|--------|---------------|----------------|
| Straddle snapshot cadence | `SELECT count(*), max(time) FROM straddle_snapshots WHERE time > NOW() - INTERVAL '5 minutes';` | Alert if `count < 5` during market hours (09:15–15:30 IST) |
| Redis stream lengths | `XLEN straddle.values` | Alert if not growing during market hours |
| Open paper trades at EOD | `SELECT count(*) FROM paper_trades WHERE status = 'open' AND entry_time < '15:25 IST today';` | Alert if > 0 at 15:30 IST (EOD squareoff should have fired) |
| Fyers WS connection | Log lines | Alert on `[fyers] WebSocket disconnected` that is not followed by reconnect within 60s |

##### Log Aggregation

Set `LOG_LEVEL=info` (or `debug` for troubleshooting). All logs are structured JSON when `NODE_ENV=production`. Pipe to your preferred aggregator (Datadog, Grafana Loki, Railway's built-in log viewer):

```bash
# Railway: view logs live
railway logs

# Fly.io: view logs live
fly logs
```

---

#### Fyers Token Refresh (Critical)

**The Fyers access token expires every day at midnight IST.** If the token is stale, the WebSocket silently disconnects with no retry. This is the most common cause of production outages.

##### Manual Daily Process (Pre-automation)

Before 09:00 IST every market day:

1. Open the Fyers auth URL in a browser:
   ```bash
   bun -e "
   import { FyersAuthHelper } from './src/ingestion/brokers/fyers-auth.ts';
   const h = new FyersAuthHelper(process.env.FYERS_APP_ID!);
   console.log(h.getAuthUrl());
   "
   ```

2. Log in and copy the `auth_code` from the redirect URL

3. Exchange for a token:
   ```bash
   bun -e "
   import { FyersAuthHelper } from './src/ingestion/brokers/fyers-auth.ts';
   const h = new FyersAuthHelper(process.env.FYERS_APP_ID!);
   const token = await h.exchangeCode('PASTE_CODE');
   console.log(token);
   "
   ```

4. Update the secret in your PaaS:
   ```bash
   # Railway
   railway variables set FYERS_ACCESS_TOKEN="<new_token>"

   # Fly.io
   fly secrets set FYERS_ACCESS_TOKEN="<new_token>"
   ```

5. Restart the app to pick up the new token.

##### Automated Token Refresh (Planned)

Token automation is a pre-production blocker. The flow requires storing the Fyers refresh token (or TOTP secret) securely and triggering a refresh job at 08:45 IST via a cron job or BullMQ scheduled task. Until this is built, do not operate in live mode unattended.

---

#### Secrets Management

**Never commit secrets to git.** The repository has a pre-commit hook (lefthook) that blocks commits containing obvious secrets.

##### Local Development
- Store secrets in `.env` (git-ignored)
- `.env.example` documents all variables with safe defaults

##### Production
- Use your PaaS secret management:
  - **Railway**: Settings → Variables (encrypted at rest)
  - **Fly.io**: `fly secrets set KEY=VALUE` (encrypted, not in `fly.toml`)
- Rotate `RAZORPAY_WEBHOOK_SECRET` and `FYERS_ACCESS_TOKEN` regularly
- The app masks secrets in logs (only first 4 characters are logged)

##### What to Rotate

| Secret | Rotation trigger |
|--------|----------------|
| `FYERS_ACCESS_TOKEN` | Every day (mandatory) |
| `RAZORPAY_WEBHOOK_SECRET` | On suspected compromise |
| `RAZORPAY_KEY_SECRET` | On suspected compromise or quarterly |
| Database password | On suspected compromise or quarterly |

---

#### Pre-Launch Checklist

Work through this before going live with real broker data.

##### Infrastructure

```
[ ] TimescaleDB 2.x confirmed on prod database (not vanilla PG)
[ ] All 9 migrations applied: SELECT count(*) FROM schema_migrations; → 9
[ ] 3 hypertables exist: SELECT hypertable_name FROM timescaledb_information.hypertables;
[ ] straddle_1min continuous aggregate exists
[ ] Redis is Redis 7+: docker exec redis redis-cli info server | grep redis_version
[ ] GET /health returns {"status":"ok","db":"connected","redis":"connected"}
```

##### Application

```
[ ] bun run --bun tsc --noEmit produces zero output
[ ] bun run test:unit — all tests pass
[ ] bun run test:integration — all tests pass (run against a staging DB)
[ ] 10 personality_configs rows: SELECT count(*) FROM personality_configs;
[ ] Clockwork is frozen: SELECT is_frozen FROM personality_configs WHERE name='Clockwork'; → true
[ ] EVOLUTION_REQUIRE_APPROVAL=true confirmed in prod env
[ ] Simulation mode was tested for ≥1 full market day before live mode
```

##### Broker Connectivity

```
[ ] Fyers App ID format verified (ends in -100)
[ ] Fyers access token generated today (not yesterday's)
[ ] WebSocket connects and first tick arrives within 60s of startup
[ ] Test with: docker exec redis redis-cli XLEN market.ticks → growing count
[ ] Angel One fallback tested in simulation before relying on it in live mode
```

##### Payment (if RAZORPAY_KEY_ID is set)

```
[ ] Razorpay is in LIVE mode (key starts with rzp_live_, not rzp_test_)
[ ] Webhook URL configured in Razorpay dashboard: https://your-domain.com/webhooks/razorpay
[ ] RAZORPAY_WEBHOOK_SECRET matches the value in Razorpay dashboard
[ ] GET /pricing returns correct plan amounts
[ ] Test payment flow end-to-end in Razorpay test mode before going live
```

##### Operations

```
[ ] Log aggregation is set up and receiving logs
[ ] Health check endpoint is configured in the PaaS
[ ] Alerting set up for: straddle snapshot staleness, WS disconnect, EOD squareoff failures
[ ] Fyers token refresh process documented and tested (manual or automated)
[ ] Rollback plan exists: docker compose down -v + restore DB from backup
[ ] Database backup schedule confirmed (TimescaleDB has continuous archiving options)
```

---



---

## Local setup — paths beyond Docker Compose

The default path (`docker compose up -d` + `bun run migrate`) is in
`.claude/project/technical.md`. These are the cases it does not cover.

### Path B — Local install (no Docker)

#### PostgreSQL 16 + TimescaleDB

TimescaleDB is a PostgreSQL extension. Install both together using the official packages.

**macOS (Homebrew)**

```bash
brew install postgresql@16
brew install timescaledb

# Enable the extension
timescaledb-tune --quiet --yes   # adjusts postgresql.conf

# Add to postgresql.conf (Homebrew path shown):
echo "shared_preload_libraries = 'timescaledb'" >> /opt/homebrew/var/postgresql@16/postgresql.conf

brew services restart postgresql@16

# Create the database and user — run each line separately, do NOT paste as a block.
# Using -c flags avoids the \c meta-command paste-parsing bug.
psql postgres -c "CREATE USER trading WITH PASSWORD 'trading';"
psql postgres -c "CREATE DATABASE trading OWNER trading;"
psql trading  -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
psql postgres -c "GRANT ALL PRIVILEGES ON DATABASE trading TO trading;"
```

**Ubuntu / Debian**

```bash
# Add TimescaleDB repo (installs PostgreSQL 16 + extension together)
sudo apt install -y gnupg postgresql-common apt-transport-https lsb-release wget
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh

# TimescaleDB repo
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | sudo apt-key add -

sudo apt update
sudo apt install -y timescaledb-2-postgresql-16

sudo timescaledb-tune --quiet --yes
sudo systemctl restart postgresql

sudo -u postgres psql -c "CREATE USER trading WITH PASSWORD 'trading';"
sudo -u postgres psql -c "CREATE DATABASE trading OWNER trading;"
sudo -u postgres psql trading  -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
sudo -u postgres psql postgres -c "GRANT ALL PRIVILEGES ON DATABASE trading TO trading;"
```

**Windows**

Use [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) and follow the Ubuntu steps above. Native Windows PostgreSQL + TimescaleDB installers exist but WSL 2 is simpler for development.

#### Redis 7

**macOS**
```bash
brew install redis
brew services start redis
```

**Ubuntu**
```bash
# Redis 7 is in the official Ubuntu 22.04+ repos; for older Ubuntu use the Redis repo
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
```

#### .env for local install

```
DATABASE_URL=postgresql://trading:trading@localhost:5432/trading
REDIS_URL=redis://localhost:6379
```

#### Then run

```bash
bun run migrate
SIMULATE=true bun run sim
```

---



### Path C — Hosted services (no local services at all)

Use free-tier cloud databases. Zero installation, but requires a network connection while developing.

#### PostgreSQL + TimescaleDB — Timescale Cloud

1. Sign up at [console.cloud.timescale.com](https://console.cloud.timescale.com) — free trial, no credit card required for the first 30 days.
2. Create a service (PostgreSQL 16, TimescaleDB pre-installed).
3. Copy the connection string from the dashboard.

```
DATABASE_URL=postgresql://tsdbadmin:<password>@<host>.tsdb.cloud:5432/tsdb?sslmode=require
```

#### Redis — Upstash

1. Sign up at [upstash.com](https://upstash.com) — free tier: 10 000 commands/day.
2. Create a Redis database, choose the region closest to you.
3. Copy the Redis URL from the console.

```
REDIS_URL=rediss://default:<password>@<host>.upstash.io:6379
```

Note the `rediss://` (with double `s`) — Upstash requires TLS.

#### Then run

```bash
bun run migrate              # applies migrations to the hosted DB
SIMULATE=true bun run sim    # runs fully on your laptop, data goes to the cloud DBs
```

---



### Corporate / restricted network (JFrog proxy)

If your organisation routes all npm traffic through a JFrog Artifactory proxy and
`@biomejs/biome` is not cached there, `bun install` will fail with an error like:

```
error: GET https://<proxy>/artifactory/api/npm/.../biome-1.9.4.tgz
```

Biome is NOT in `devDependencies` for this reason — it is installed as a standalone
binary instead.

**One-time setup (run after cloning):**

```bash
bash scripts/install-biome.sh   # downloads ./tools/biome from GitHub Releases
```

`bun run lint` and the pre-commit hook both check for `./tools/biome` first; they
skip gracefully if it is absent (you can still develop, lint just won't run locally).

**If GitHub Releases is also blocked:** download the binary on a machine with internet
access from `https://github.com/biomejs/biome/releases/tag/cli/v1.9.4`, place it at
`./tools/biome`, then `chmod +x ./tools/biome`.

**Permanent fix:** ask your JFrog admin to add these packages to the virtual npm repo
as proxied from `https://registry.npmjs.org`:
- `@biomejs/biome`
- `@biomejs/cli-linux-x64`
- `@biomejs/cli-linux-arm64`
- `@biomejs/cli-darwin-arm64`
- `@biomejs/cli-darwin-x64`
- `@biomejs/cli-win32-x64`

Once they are available, run `bun install` and restore `@biomejs/biome` to
`devDependencies`; the standalone-binary path can then be removed.

---



