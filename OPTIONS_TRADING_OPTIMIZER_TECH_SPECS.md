# AI-Powered Options Trading Optimization System

## Technical Specification Document

**Version:** 1.0  
**Author:** Trading Systems Architecture  
**Target Market:** NSE (Nifty, BankNifty) & BSE (Sensex) Weekly Options  
**Document Status:** Draft  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Core Hypothesis](#3-core-hypothesis)
4. [System Architecture](#4-system-architecture)
5. [Technical Components](#5-technical-components)
6. [Data Models & Schema](#6-data-models--schema)
7. [Technology Stack](#7-technology-stack)
8. [Algorithm Design](#8-algorithm-design)
9. [Personality Bot Framework](#9-personality-bot-framework)
10. [Retrospection Engine](#10-retrospection-engine)
11. [API & Integration Layer](#11-api--integration-layer)
12. [Risk Management](#12-risk-management)
13. [Testing Strategy](#13-testing-strategy)
14. [Implementation Roadmap](#14-implementation-roadmap)
15. [Success Metrics](#15-success-metrics)
16. [Appendix](#16-appendix)

---

## 1. Executive Summary

### 1.1 Project Overview

This system is an **adaptive, multi-personality paper trading framework** designed to optimize entry timing for weekly index options strategies on Indian markets (Nifty, BankNifty, Sensex). The system monitors ATM straddle dynamics, detects momentum exhaustion patterns, and deploys multiple trading "personalities" with varying risk appetites to discover optimal entry parameters through continuous retrospection.

### 1.2 Key Objectives

| Objective | Description | Success Metric |
|-----------|-------------|----------------|
| **Timing Optimization** | Identify statistically superior entry times for each strategy | >15% improvement in win rate vs baseline |
| **Risk-Adjusted Returns** | Balance aggression with capital preservation | Sharpe ratio > 1.5 |
| **Adaptive Learning** | Evolve trading rules based on market regime | Parameter drift < 20% month-over-month |
| **Strategy Attribution** | Understand which personality performs in which conditions | Clear regime-performance mapping |

### 1.3 Scope

**In Scope:**
- Real-time straddle monitoring and rate-of-change analysis
- Multi-personality paper trading execution via Quantiply
- End-of-day retrospection and parameter evolution
- Time-staggered entry analysis (5-min, 10-min intervals)
- Performance dashboards and reporting

**Out of Scope (Phase 1):**
- Live trading execution (paper trading only)
- Options Greeks-based hedging
- Cross-index arbitrage
- Intraday regime switching

---

## 2. Problem Statement

### 2.1 The Core Challenge

Weekly index options traders face a fundamental timing problem:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     THE TIMING PARADOX                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  SCENARIO: Market gaps up 150 points at open                           │
│                                                                         │
│  Straddle Premium: ₹380 → ₹520 (36% expansion)                         │
│                                                                         │
│  TRADER A (Too Early):                                                  │
│  • Sells straddle at ₹450 (9:18 AM)                                    │
│  • Market continues moving, straddle hits ₹520                         │
│  • Stop-loss triggered at ₹517 (115% of ₹450)                          │
│  • LOSS: ₹67 per lot                                                   │
│                                                                         │
│  TRADER B (Too Late):                                                   │
│  • Waits for "confirmation" of peak                                    │
│  • Enters at ₹460 (9:45 AM) after straddle reverses from ₹520          │
│  • Straddle decays to ₹420 by EOD                                      │
│  • PROFIT: ₹40 per lot (but missed ₹60 of potential)                   │
│                                                                         │
│  TRADER C (Optimal):                                                    │
│  • Detects momentum exhaustion at ₹510 (9:32 AM)                       │
│  • Enters short straddle at ₹505                                       │
│  • Straddle decays to ₹420 by EOD                                      │
│  • PROFIT: ₹85 per lot                                                 │
│                                                                         │
│  QUESTION: How do we systematically become Trader C?                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Specific Problems to Solve

#### Problem 1: Peak Detection in Real-Time

**Challenge:** Peaks are only identifiable in hindsight. By the time a peak is "confirmed," significant premium decay has already occurred.

**Current State:** Traders rely on intuition, fixed time entries, or lagging indicators.

**Desired State:** Probabilistic peak estimation using rate-of-change analysis and historical pattern matching.

#### Problem 2: One-Size-Fits-All Strategy

**Challenge:** A single entry rule cannot adapt to varying market conditions:
- High VIX days require different timing than low VIX days
- Expiry day dynamics differ from mid-week
- Gap opens behave differently than grinding opens

**Current State:** Fixed entry times (9:17, 9:24, 9:30) regardless of conditions.

**Desired State:** Multiple trading personalities that self-select based on market regime.

#### Problem 3: No Systematic Learning

**Challenge:** Manual trading generates data but no systematic feedback loop.

**Current State:** Trader reviews P&L, makes mental adjustments, prone to recency bias.

**Desired State:** Automated retrospection engine that identifies statistically significant patterns and evolves parameters.

#### Problem 4: Entry Timing Optimization

**Challenge:** Is 9:17 AM actually optimal? Or would 9:22 AM yield better results on average?

**Current State:** Entry times chosen based on "gut feel" and limited backtesting.

**Desired State:** Parallel paper trading at staggered intervals to statistically determine optimal entry windows.

### 2.3 Existing Strategies to Optimize

| Strategy | Type | Entry Logic | Risk Parameters | Frequency |
|----------|------|-------------|-----------------|-----------|
| **Strategy 1** | Non-Directional | Sell OTM1 PE + CE at 9:17 AM | SL: 115% each leg, TSL: 15pt→10pt, Max Loss: ₹2000/lot | 80% of trades |
| **Strategy 2** | Directional | Sell ATM CE + PE at 9:24 AM | SL: 21% each leg, 1 re-entry allowed, Max Loss: ₹3500/lot | Selective |
| **Strategy 3** | Momentum Buy | Wait for 20% move in OTM option (~₹50 Nifty), buy with 25% SL | TSL or 1:1 target, Max Loss: ₹1000/lot | 9:30 AM trigger |

---

## 3. Core Hypothesis

### 3.1 Primary Hypothesis

> **When ATM straddle premium expands rapidly due to sudden market movement, there exists a predictable "momentum exhaustion" window where selling the straddle offers superior risk-reward compared to fixed-time entries.**

### 3.2 Supporting Hypotheses

| ID | Hypothesis | Testable Prediction |
|----|------------|---------------------|
| H1 | Straddle rate-of-change (ROC) decelerates before price reversal | ROC[t] < ROC[t-5] precedes peak by 2-8 minutes in >60% of cases |
| H2 | Optimal entry time varies by day-of-week | Thursday entries outperform Monday entries by >10% |
| H3 | Conservative personalities outperform in low-VIX regimes | Win rate differential > 15% when India VIX < 14 |
| H4 | Time-staggered entries reduce variance | 10-min delayed entries have lower drawdown than immediate entries |
| H5 | Profit-gated trading improves risk-adjusted returns | Skipping trades after losing streaks improves Sharpe by >0.3 |

### 3.3 Falsification Criteria

The system should be abandoned or redesigned if:
- 3 consecutive months show no personality outperforming random entry
- Peak detection signals have <45% accuracy after 50 samples
- Retrospection-evolved parameters show >40% month-over-month variance (overfitting signal)

---

## 4. System Architecture

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SYSTEM ARCHITECTURE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      DATA INGESTION LAYER                           │   │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐           │   │
│  │  │ Market Feed   │  │ Quantiply    │  │ India VIX     │           │   │
│  │  │ (WebSocket)   │  │ Paper API    │  │ Feed          │           │   │
│  │  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘           │   │
│  │          │                  │                  │                    │   │
│  └──────────┼──────────────────┼──────────────────┼────────────────────┘   │
│             │                  │                  │                        │
│             ▼                  ▼                  ▼                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    EVENT PROCESSING LAYER                           │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │                   Apache Kafka / Redis Streams               │   │   │
│  │  │  Topics: market.ticks | straddle.values | signals.generated │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────┬──────────────────────────────────────┘   │
│                                 │                                          │
│             ┌───────────────────┼───────────────────┐                      │
│             ▼                   ▼                   ▼                      │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐               │
│  │ STRADDLE        │ │ SIGNAL          │ │ TIMING          │               │
│  │ MONITOR         │ │ GENERATOR       │ │ ANALYZER        │               │
│  │                 │ │                 │ │                 │               │
│  │ • ATM tracking  │ │ • ROC analysis  │ │ • 5/10-min lag  │               │
│  │ • Premium calc  │ │ • Peak detect   │ │ • Entry scoring │               │
│  │ • ROC compute   │ │ • Probability   │ │ • Time buckets  │               │
│  └────────┬────────┘ └────────┬────────┘ └────────┬────────┘               │
│           │                   │                   │                        │
│           └───────────────────┼───────────────────┘                        │
│                               ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    PERSONALITY ENGINE                               │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │   │
│  │  │CONSERVATIVE │  │ BALANCED    │  │ AGGRESSIVE  │  │ CUSTOM    │  │   │
│  │  │             │  │             │  │             │  │           │  │   │
│  │  │ prob > 0.75 │  │ prob > 0.60 │  │ prob > 0.50 │  │ User-     │  │   │
│  │  │ max 2/day   │  │ max 4/day   │  │ max 8/day   │  │ defined   │  │   │
│  │  │ profit-gate │  │             │  │             │  │           │  │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘  │   │
│  │         │                │                │               │        │   │
│  └─────────┼────────────────┼────────────────┼───────────────┼────────┘   │
│            │                │                │               │            │
│            ▼                ▼                ▼               ▼            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    EXECUTION LAYER                                  │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │              Quantiply Paper Trading API                     │   │   │
│  │  │  • Order placement    • Position tracking   • P&L compute   │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────┬──────────────────────────────────────┘   │
│                                 │                                          │
│                                 ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    PERSISTENCE LAYER                                │   │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐           │   │
│  │  │ TimescaleDB   │  │ PostgreSQL    │  │ Redis         │           │   │
│  │  │ (Time-series) │  │ (Relational)  │  │ (Cache/Pub)   │           │   │
│  │  └───────────────┘  └───────────────┘  └───────────────┘           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                 │                                          │
│                                 ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    RETROSPECTION ENGINE                             │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │  • EOD batch analysis    • Parameter evolution              │   │   │
│  │  │  • Statistical testing   • Performance attribution          │   │   │
│  │  │  • Rule mutation         • Regime detection                 │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                 │                                          │
│                                 ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    PRESENTATION LAYER                               │   │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐           │   │
│  │  │ React         │  │ Real-time     │  │ Telegram      │           │   │
│  │  │ Dashboard     │  │ Charts        │  │ Alerts        │           │   │
│  │  └───────────────┘  └───────────────┘  └───────────────┘           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           DATA FLOW                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PHASE 1: MARKET HOURS (9:15 AM - 3:30 PM)                                  │
│  ═══════════════════════════════════════════                                │
│                                                                              │
│  [NSE Feed] ──► [Tick Processor] ──► [Straddle Calculator] ──► [Redis]     │
│       │              │                      │                     │         │
│       │              ▼                      ▼                     │         │
│       │         [TimescaleDB]         [ROC Engine]                │         │
│       │              │                      │                     │         │
│       │              │                      ▼                     │         │
│       │              │              [Signal Generator]            │         │
│       │              │                      │                     │         │
│       │              │                      ▼                     │         │
│       │              │              [Personality Router]          │         │
│       │              │                 │    │    │                │         │
│       │              │                 ▼    ▼    ▼                │         │
│       │              │              [C]  [B]  [A]  (Bots)         │         │
│       │              │                 │    │    │                │         │
│       │              │                 └────┼────┘                │         │
│       │              │                      ▼                     │         │
│       │              │              [Quantiply Paper API]         │         │
│       │              │                      │                     │         │
│       │              │                      ▼                     │         │
│       │              └──────────────► [Trade Log DB]              │         │
│       │                                                           │         │
│                                                                              │
│  PHASE 2: POST-MARKET (3:30 PM - 4:30 PM)                                   │
│  ═════════════════════════════════════════                                  │
│                                                                              │
│  [Trade Log DB] ──► [Retrospection Engine]                                  │
│                            │                                                 │
│                            ├──► [Win/Loss Analyzer]                         │
│                            │          │                                      │
│                            │          ▼                                      │
│                            │    [Statistical Tests]                          │
│                            │          │                                      │
│                            │          ▼                                      │
│                            ├──► [Parameter Evolver]                          │
│                            │          │                                      │
│                            │          ▼                                      │
│                            │    [Personality Config DB]                      │
│                            │                                                 │
│                            └──► [Report Generator]                           │
│                                       │                                      │
│                                       ▼                                      │
│                                 [Dashboard + Telegram]                       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Technical Components

### 5.1 Component Inventory

| Component | Responsibility | Input | Output | Criticality |
|-----------|---------------|-------|--------|-------------|
| **Tick Processor** | Normalize raw market data | NSE WebSocket ticks | Standardized tick objects | Critical |
| **Straddle Calculator** | Compute ATM straddle value | ATM CE/PE prices | Straddle premium, Greeks | Critical |
| **ROC Engine** | Calculate rate-of-change metrics | Straddle time-series | ROC values, acceleration | Critical |
| **Signal Generator** | Detect entry opportunities | ROC, time, VIX | Signal events with probability | Critical |
| **Personality Router** | Route signals to appropriate bots | Signal + bot configs | Filtered trade decisions | High |
| **Trade Executor** | Execute paper trades via Quantiply | Trade decisions | Order confirmations | High |
| **Position Manager** | Track open positions, P&L | Executed trades | Position state | High |
| **Retrospection Engine** | Analyze and evolve parameters | Trade history | Updated parameters | Medium |
| **Dashboard Server** | Serve real-time UI | All system state | React UI | Low |

### 5.2 Component Details

#### 5.2.1 Straddle Calculator

```typescript
interface StraddleSnapshot {
  timestamp: Date;
  underlying: 'NIFTY' | 'BANKNIFTY' | 'SENSEX';
  spotPrice: number;
  atmStrike: number;
  atmCallPrice: number;
  atmPutPrice: number;
  straddleValue: number;
  impliedVolatility: number;
  
  // Derived metrics
  straddleChangeFromOpen: number;      // Percentage
  straddleChangeFromPrevClose: number; // Percentage
  rateOfChange1m: number;              // Premium change per minute (1-min window)
  rateOfChange5m: number;              // Premium change per minute (5-min window)
  rocAcceleration: number;             // d(ROC)/dt - is momentum increasing or decreasing?
}
```

**ATM Strike Calculation Logic:**

```typescript
function calculateATMStrike(spotPrice: number, underlying: string): number {
  const strikeInterval = underlying === 'BANKNIFTY' ? 100 : 50;
  const roundedStrike = Math.round(spotPrice / strikeInterval) * strikeInterval;
  return roundedStrike;
}
```

#### 5.2.2 Rate of Change (ROC) Engine

The ROC engine is the core of peak detection. It computes:

1. **First Derivative (ROC):** How fast is the straddle value changing?
2. **Second Derivative (Acceleration):** Is the rate of change speeding up or slowing down?

```typescript
interface ROCMetrics {
  roc1m: number;      // (P[t] - P[t-1]) / 1 minute
  roc5m: number;      // (P[t] - P[t-5]) / 5 minutes
  roc10m: number;     // (P[t] - P[t-10]) / 10 minutes
  acceleration: number; // roc1m[t] - roc1m[t-1]
  
  // Momentum exhaustion indicators
  rocDivergence: boolean;  // Price making new high but ROC declining
  volumeConfirmation: boolean; // High volume on expansion, low on contraction
}

function detectMomentumExhaustion(metrics: ROCMetrics[]): boolean {
  const current = metrics[metrics.length - 1];
  const previous = metrics[metrics.length - 2];
  
  // Momentum exhaustion = ROC was positive and decelerating
  const wasExpanding = previous.roc1m > 0;
  const isDecelerating = current.acceleration < 0;
  const significantDeceleration = Math.abs(current.acceleration) > 0.5; // Tunable
  
  return wasExpanding && isDecelerating && significantDeceleration;
}
```

#### 5.2.3 Signal Generator

Signals are generated when market conditions meet predefined criteria:

```typescript
interface TradingSignal {
  id: string;
  timestamp: Date;
  signalType: 'STRADDLE_SELL' | 'STRADDLE_BUY' | 'DIRECTIONAL_CE' | 'DIRECTIONAL_PE';
  underlying: string;
  
  // Entry details
  suggestedStrike: number;
  suggestedPrice: number;
  
  // Probability assessment
  winProbability: number;  // 0.0 to 1.0
  expectedValue: number;   // Expected P&L
  confidenceInterval: [number, number]; // 95% CI on probability
  
  // Context
  triggerReason: string;
  marketRegime: 'LOW_VOL' | 'HIGH_VOL' | 'TRENDING' | 'RANGEBOUND';
  timeOfDay: string;
  dayOfWeek: number;
  daysToExpiry: number;
  
  // For retrospection
  straddleValueAtSignal: number;
  rocAtSignal: number;
  vixAtSignal: number;
}
```

**Signal Generation Rules (Initial Version):**

```typescript
const SIGNAL_RULES = {
  // Rule 1: Momentum Exhaustion after Expansion
  momentumExhaustion: {
    conditions: [
      'straddleChangeFromOpen > 10%',
      'rocAcceleration < -0.5',
      'time > 9:20 AND time < 11:00',
    ],
    baselineProbability: 0.55,
    adjustments: {
      'vix < 14': +0.05,
      'dayOfWeek === 4': +0.05, // Thursday expiry edge
      'daysToExpiry === 0': +0.10, // Expiry day theta
    }
  },
  
  // Rule 2: Time-Based Entry (Fallback)
  scheduledEntry: {
    conditions: [
      'time === 9:17 AND strategy === NON_DIRECTIONAL',
      'time === 9:24 AND strategy === DIRECTIONAL',
    ],
    baselineProbability: 0.50, // No edge, just default
  },
  
  // Rule 3: Pullback Entry
  pullbackEntry: {
    conditions: [
      'straddlePeakDetected === true',
      'currentStraddle < peakStraddle * 0.98', // 2% pullback
      'timeSincePeak < 10 minutes',
    ],
    baselineProbability: 0.60,
  }
};
```

---

## 6. Data Models & Schema

### 6.1 Database Schema (PostgreSQL + TimescaleDB)

```sql
-- ============================================
-- CORE MARKET DATA (TimescaleDB Hypertable)
-- ============================================

CREATE TABLE market_ticks (
    time            TIMESTAMPTZ NOT NULL,
    underlying      VARCHAR(20) NOT NULL,
    symbol          VARCHAR(50) NOT NULL,
    ltp             DECIMAL(10, 2) NOT NULL,
    bid             DECIMAL(10, 2),
    ask             DECIMAL(10, 2),
    volume          BIGINT,
    oi              BIGINT,
    PRIMARY KEY (time, symbol)
);

SELECT create_hypertable('market_ticks', 'time');

-- Index for fast ATM lookups
CREATE INDEX idx_market_ticks_underlying ON market_ticks (underlying, time DESC);


-- ============================================
-- STRADDLE SNAPSHOTS (TimescaleDB Hypertable)
-- ============================================

CREATE TABLE straddle_snapshots (
    time                        TIMESTAMPTZ NOT NULL,
    underlying                  VARCHAR(20) NOT NULL,
    spot_price                  DECIMAL(10, 2) NOT NULL,
    atm_strike                  INTEGER NOT NULL,
    atm_call_price              DECIMAL(10, 2) NOT NULL,
    atm_put_price               DECIMAL(10, 2) NOT NULL,
    straddle_value              DECIMAL(10, 2) NOT NULL,
    straddle_change_from_open   DECIMAL(5, 2),
    roc_1m                      DECIMAL(8, 4),
    roc_5m                      DECIMAL(8, 4),
    roc_acceleration            DECIMAL(8, 4),
    india_vix                   DECIMAL(5, 2),
    PRIMARY KEY (time, underlying)
);

SELECT create_hypertable('straddle_snapshots', 'time');


-- ============================================
-- TRADING SIGNALS
-- ============================================

CREATE TABLE trading_signals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    underlying          VARCHAR(20) NOT NULL,
    signal_type         VARCHAR(30) NOT NULL,
    suggested_strike    INTEGER NOT NULL,
    suggested_price     DECIMAL(10, 2) NOT NULL,
    win_probability     DECIMAL(4, 3) NOT NULL,
    expected_value      DECIMAL(10, 2),
    trigger_reason      TEXT,
    market_regime       VARCHAR(20),
    straddle_at_signal  DECIMAL(10, 2),
    roc_at_signal       DECIMAL(8, 4),
    vix_at_signal       DECIMAL(5, 2),
    days_to_expiry      INTEGER,
    
    -- Outcome tracking (filled post-trade)
    was_traded          BOOLEAN DEFAULT FALSE,
    actual_outcome      VARCHAR(20), -- 'WIN', 'LOSS', 'BREAKEVEN'
    actual_pnl          DECIMAL(10, 2)
);

CREATE INDEX idx_signals_time ON trading_signals (created_at DESC);


-- ============================================
-- PERSONALITY CONFIGURATIONS
-- ============================================

CREATE TABLE personality_configs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    personality_name        VARCHAR(50) NOT NULL UNIQUE,
    is_active               BOOLEAN DEFAULT TRUE,
    
    -- Entry parameters
    min_probability         DECIMAL(4, 3) NOT NULL,
    max_daily_trades        INTEGER NOT NULL,
    entry_delay_seconds     INTEGER DEFAULT 0,
    
    -- Risk parameters
    require_profit_gate     BOOLEAN DEFAULT FALSE,
    profit_gate_threshold   DECIMAL(10, 2),
    profit_gate_lookback    INTEGER, -- days
    
    -- Evolution tracking
    version                 INTEGER DEFAULT 1,
    parent_version          INTEGER,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    last_modified           TIMESTAMPTZ DEFAULT NOW(),
    
    -- Performance cache
    win_rate_30d            DECIMAL(4, 3),
    total_pnl_30d           DECIMAL(12, 2),
    sharpe_30d              DECIMAL(5, 3)
);

-- Seed initial personalities
INSERT INTO personality_configs (personality_name, min_probability, max_daily_trades, entry_delay_seconds, require_profit_gate, profit_gate_threshold, profit_gate_lookback) VALUES
('conservative', 0.75, 2, 300, true, 5000, 5),
('balanced', 0.60, 4, 120, false, null, null),
('aggressive', 0.50, 8, 30, false, null, null);


-- ============================================
-- PAPER TRADES
-- ============================================

CREATE TABLE paper_trades (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id           UUID REFERENCES trading_signals(id),
    personality_id      UUID REFERENCES personality_configs(id),
    
    -- Trade details
    trade_time          TIMESTAMPTZ NOT NULL,
    underlying          VARCHAR(20) NOT NULL,
    strategy_type       VARCHAR(30) NOT NULL,
    direction           VARCHAR(10) NOT NULL, -- 'SELL', 'BUY'
    
    -- Legs
    leg1_symbol         VARCHAR(50),
    leg1_strike         INTEGER,
    leg1_type           VARCHAR(5), -- 'CE', 'PE'
    leg1_qty            INTEGER,
    leg1_entry_price    DECIMAL(10, 2),
    leg1_exit_price     DECIMAL(10, 2),
    
    leg2_symbol         VARCHAR(50),
    leg2_strike         INTEGER,
    leg2_type           VARCHAR(5),
    leg2_qty            INTEGER,
    leg2_entry_price    DECIMAL(10, 2),
    leg2_exit_price     DECIMAL(10, 2),
    
    -- Timing analysis
    entry_delay_bucket  VARCHAR(10), -- '0min', '5min', '10min', '15min'
    
    -- Outcome
    status              VARCHAR(20) DEFAULT 'OPEN', -- 'OPEN', 'SL_HIT', 'TARGET_HIT', 'TSL_HIT', 'MANUAL_EXIT', 'EOD_EXIT'
    exit_time           TIMESTAMPTZ,
    gross_pnl           DECIMAL(10, 2),
    charges             DECIMAL(10, 2) DEFAULT 0,
    net_pnl             DECIMAL(10, 2),
    
    -- Context at entry
    straddle_at_entry   DECIMAL(10, 2),
    vix_at_entry        DECIMAL(5, 2),
    spot_at_entry       DECIMAL(10, 2)
);

CREATE INDEX idx_paper_trades_time ON paper_trades (trade_time DESC);
CREATE INDEX idx_paper_trades_personality ON paper_trades (personality_id, trade_time DESC);


-- ============================================
-- RETROSPECTION RESULTS
-- ============================================

CREATE TABLE retrospection_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_date            DATE NOT NULL,
    run_type            VARCHAR(20) NOT NULL, -- 'EOD', 'WEEKLY', 'MONTHLY'
    
    -- Inputs
    trades_analyzed     INTEGER,
    date_range_start    DATE,
    date_range_end      DATE,
    
    -- Outputs
    findings            JSONB, -- Structured findings
    parameter_changes   JSONB, -- What was modified
    statistical_tests   JSONB, -- Test results with p-values
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================
-- TIMING ANALYSIS
-- ============================================

CREATE TABLE timing_analysis (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_date       DATE NOT NULL,
    underlying          VARCHAR(20) NOT NULL,
    strategy_type       VARCHAR(30) NOT NULL,
    
    -- Bucketed results
    bucket_0min_winrate     DECIMAL(4, 3),
    bucket_0min_avg_pnl     DECIMAL(10, 2),
    bucket_0min_trades      INTEGER,
    
    bucket_5min_winrate     DECIMAL(4, 3),
    bucket_5min_avg_pnl     DECIMAL(10, 2),
    bucket_5min_trades      INTEGER,
    
    bucket_10min_winrate    DECIMAL(4, 3),
    bucket_10min_avg_pnl    DECIMAL(10, 2),
    bucket_10min_trades     INTEGER,
    
    bucket_15min_winrate    DECIMAL(4, 3),
    bucket_15min_avg_pnl    DECIMAL(10, 2),
    bucket_15min_trades     INTEGER,
    
    -- Statistical significance
    best_bucket             VARCHAR(10),
    significance_pvalue     DECIMAL(6, 4),
    
    created_at              TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.2 Redis Data Structures

```typescript
// Real-time straddle cache
// Key: straddle:{underlying}:current
// Type: Hash
{
  "spotPrice": "22450.50",
  "atmStrike": "22450",
  "straddleValue": "385.50",
  "roc1m": "2.35",
  "roc5m": "1.82",
  "lastUpdated": "2024-01-15T09:25:30.000Z"
}

// Active signals queue
// Key: signals:pending
// Type: Sorted Set (score = timestamp)
"signal:uuid:abc123" -> 1705305930000

// Personality state
// Key: personality:{name}:state
// Type: Hash
{
  "tradesToday": "2",
  "lastTradeTime": "2024-01-15T09:24:00.000Z",
  "runningPnL5d": "7500",
  "profitGatePassed": "true"
}

// Live positions
// Key: positions:{personality}:active
// Type: List
["position:uuid:xyz789", "position:uuid:def456"]
```

---

## 7. Technology Stack

### 7.1 Stack Overview

| Layer | Technology | Justification |
|-------|------------|---------------|
| **Language** | TypeScript (Node.js 20+) | Type safety for complex trading logic, excellent async handling for real-time data |
| **Runtime** | Bun | Faster startup, better performance than Node.js, native TypeScript |
| **Web Framework** | Fastify | Lowest latency HTTP framework, schema validation, better than Express for trading |
| **WebSocket** | ws / uWebSockets.js | Native WebSocket for market data feeds, uWS for high-throughput |
| **Message Queue** | Redis Streams | Simpler than Kafka for this scale, built-in pub/sub, persistence |
| **Primary DB** | PostgreSQL 16 | ACID compliance, JSON support, mature ecosystem |
| **Time-Series DB** | TimescaleDB | Native time-series on PostgreSQL, automatic partitioning, continuous aggregates |
| **Cache** | Redis 7 | Sub-millisecond reads, pub/sub for real-time updates |
| **Task Queue** | BullMQ | Redis-backed, robust job processing for retrospection |
| **Frontend** | React 18 + Vite | Your expertise, fast HMR, excellent for dashboards |
| **Charts** | Lightweight Charts (TradingView) | Professional trading charts, OHLC support |
| **State Management** | Zustand | Minimal, performant, no boilerplate |
| **Styling** | Tailwind CSS | Rapid UI development, consistent design system |
| **Testing** | Vitest + Playwright | Fast unit tests, E2E for critical flows |
| **Deployment** | Docker + Railway/Fly.io | Simple deployment, auto-scaling, cost-effective |

### 7.2 Detailed Justifications

#### 7.2.1 Why TypeScript + Bun?

**Problem:** Trading systems require both performance and correctness. JavaScript alone is too error-prone for financial calculations.

**Solution:**
- **TypeScript** provides compile-time type checking for:
  - Order quantity calculations
  - Price precision (decimals)
  - Signal probability bounds (0-1)
  - State machine transitions

- **Bun** over Node.js because:
  - 4x faster startup (critical for market open)
  - Native TypeScript (no transpilation step)
  - Built-in test runner
  - SQLite support (useful for local development)

```typescript
// Type safety example - impossible to pass wrong order type
type OrderSide = 'BUY' | 'SELL';
type OptionType = 'CE' | 'PE';

interface OrderRequest {
  symbol: string;
  strike: number;
  optionType: OptionType;
  side: OrderSide;
  quantity: number;
  price: number;
}

// This would fail at compile time:
// const badOrder: OrderRequest = { side: 'LONG', ... }; // Error: 'LONG' not assignable
```

#### 7.2.2 Why Fastify over Express?

**Problem:** Every millisecond matters in trading. Express has significant overhead.

**Benchmarks (requests/sec):**
| Framework | Throughput | Latency p99 |
|-----------|------------|-------------|
| Express | 15,000 | 12ms |
| Fastify | 78,000 | 2ms |

**Additional benefits:**
- Schema-based validation (Ajv) for API requests
- Automatic OpenAPI documentation
- First-class TypeScript support
- Plugin architecture for clean separation

```typescript
// Fastify schema validation - validates BEFORE handler executes
const signalSchema = {
  body: {
    type: 'object',
    required: ['underlying', 'signalType', 'probability'],
    properties: {
      underlying: { type: 'string', enum: ['NIFTY', 'BANKNIFTY', 'SENSEX'] },
      signalType: { type: 'string' },
      probability: { type: 'number', minimum: 0, maximum: 1 }
    }
  }
};

app.post('/signals', { schema: signalSchema }, async (req, reply) => {
  // req.body is already validated and typed
});
```

#### 7.2.3 Why TimescaleDB?

**Problem:** Need to store millions of tick records, query time-ranges efficiently, and compute aggregates.

**Why not plain PostgreSQL?**
- Automatic time-based partitioning (no manual `PARTITION BY RANGE`)
- Continuous aggregates (materialized views that auto-update)
- 10-100x faster time-range queries
- Compression (90%+ storage reduction for tick data)

**Why not InfluxDB/QuestDB?**
- Stay in PostgreSQL ecosystem (joins with regular tables)
- Better tooling and community
- Your existing PostgreSQL knowledge transfers

```sql
-- Continuous aggregate for 1-minute straddle OHLC
CREATE MATERIALIZED VIEW straddle_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    underlying,
    FIRST(straddle_value, time) AS open,
    MAX(straddle_value) AS high,
    MIN(straddle_value) AS low,
    LAST(straddle_value, time) AS close,
    AVG(roc_1m) AS avg_roc
FROM straddle_snapshots
GROUP BY bucket, underlying;

-- Auto-refresh every minute during market hours
SELECT add_continuous_aggregate_policy('straddle_1m',
    start_offset => INTERVAL '10 minutes',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
```

#### 7.2.4 Why Redis Streams over Kafka?

**Problem:** Need message passing between components (tick processor → signal generator → personality router).

**Kafka is overkill because:**
- You don't need multi-datacenter replication
- Message volume is ~100-500/second (Kafka designed for millions)
- Operational complexity of ZooKeeper/KRaft
- Cost of managed Kafka (~$200/month minimum)

**Redis Streams provides:**
- Persistent, ordered message log (like Kafka)
- Consumer groups with acknowledgment
- Sub-millisecond latency
- You're already using Redis for cache

```typescript
// Publisher
await redis.xadd('signals:generated', '*', {
  signalId: signal.id,
  underlying: signal.underlying,
  probability: signal.winProbability.toString()
});

// Consumer (personality bot)
const messages = await redis.xreadgroup(
  'GROUP', 'personality-bots', 'conservative-bot',
  'COUNT', 10,
  'STREAMS', 'signals:generated', '>'
);
```

#### 7.2.5 Why Zustand over Redux?

**Problem:** State management for real-time trading dashboard.

**Redux overhead for this use case:**
- Action creators, reducers, selectors, thunks
- ~200 lines of boilerplate for a simple store
- Middleware complexity for async

**Zustand benefits:**
- 5-10 lines to create a store
- No providers, no boilerplate
- Built-in support for subscriptions (perfect for real-time)
- Easy devtools integration

```typescript
// Zustand store - entire trading state
import { create } from 'zustand';

interface TradingState {
  straddle: StraddleSnapshot | null;
  activeSignals: Signal[];
  positions: Position[];
  personalities: PersonalityState[];
  
  // Actions
  updateStraddle: (snapshot: StraddleSnapshot) => void;
  addSignal: (signal: Signal) => void;
  updatePosition: (position: Position) => void;
}

const useTradingStore = create<TradingState>((set) => ({
  straddle: null,
  activeSignals: [],
  positions: [],
  personalities: [],
  
  updateStraddle: (snapshot) => set({ straddle: snapshot }),
  
  addSignal: (signal) => set((state) => ({
    activeSignals: [...state.activeSignals, signal]
  })),
  
  updatePosition: (position) => set((state) => ({
    positions: state.positions.map(p => 
      p.id === position.id ? position : p
    )
  }))
}));
```

---

## 8. Algorithm Design

### 8.1 Peak Detection Algorithm

The peak detection problem is approached as a **momentum exhaustion detection** problem, not a prediction problem.

#### Mathematical Foundation

Let `S(t)` be the straddle value at time `t`.

**First Derivative (Rate of Change):**
```
ROC(t, Δt) = [S(t) - S(t - Δt)] / Δt
```

**Second Derivative (Acceleration):**
```
ACC(t) = ROC(t, 1) - ROC(t-1, 1)
```

**Momentum Exhaustion Signal:**
```
Signal = TRUE when:
  1. S(t) > S(open) * 1.10           // Straddle expanded by 10%+
  2. ROC(t, 1) > 0                   // Still going up
  3. ACC(t) < -threshold            // But decelerating
  4. ROC(t, 5) < ROC(t-5, 5)         // 5-min ROC declining
```

#### Implementation

```typescript
interface PeakDetectionConfig {
  minExpansionPercent: number;      // Minimum straddle expansion to consider
  accelerationThreshold: number;    // How negative must ACC be?
  rocDeclineWindow: number;         // Minutes to compare ROC
  confirmationCandles: number;      // How many candles must confirm?
}

const DEFAULT_CONFIG: PeakDetectionConfig = {
  minExpansionPercent: 10,
  accelerationThreshold: -0.5,
  rocDeclineWindow: 5,
  confirmationCandles: 2
};

class PeakDetector {
  private config: PeakDetectionConfig;
  private straddleHistory: StraddleSnapshot[] = [];
  private openingStraddle: number | null = null;
  
  constructor(config: PeakDetectionConfig = DEFAULT_CONFIG) {
    this.config = config;
  }
  
  onMarketOpen(initialStraddle: number): void {
    this.openingStraddle = initialStraddle;
    this.straddleHistory = [];
  }
  
  processSnapshot(snapshot: StraddleSnapshot): PeakSignal | null {
    this.straddleHistory.push(snapshot);
    
    if (this.straddleHistory.length < this.config.rocDeclineWindow + 1) {
      return null; // Not enough data
    }
    
    const expansionPercent = this.calculateExpansion(snapshot);
    if (expansionPercent < this.config.minExpansionPercent) {
      return null; // Hasn't expanded enough
    }
    
    const acceleration = this.calculateAcceleration();
    const rocDeclining = this.isRocDeclining();
    
    if (acceleration < this.config.accelerationThreshold && rocDeclining) {
      // Momentum exhaustion detected
      const probability = this.estimatePeakProbability(snapshot, acceleration);
      
      return {
        timestamp: snapshot.timestamp,
        straddleValue: snapshot.straddleValue,
        probability,
        acceleration,
        signalStrength: this.calculateSignalStrength(acceleration, expansionPercent)
      };
    }
    
    return null;
  }
  
  private calculateExpansion(current: StraddleSnapshot): number {
    if (!this.openingStraddle) return 0;
    return ((current.straddleValue - this.openingStraddle) / this.openingStraddle) * 100;
  }
  
  private calculateAcceleration(): number {
    const n = this.straddleHistory.length;
    const current = this.straddleHistory[n - 1];
    const prev = this.straddleHistory[n - 2];
    
    return current.roc1m - prev.roc1m;
  }
  
  private isRocDeclining(): boolean {
    const n = this.straddleHistory.length;
    const window = this.config.rocDeclineWindow;
    
    const currentRoc5m = this.straddleHistory[n - 1].roc5m;
    const pastRoc5m = this.straddleHistory[n - 1 - window].roc5m;
    
    return currentRoc5m < pastRoc5m;
  }
  
  private estimatePeakProbability(
    snapshot: StraddleSnapshot, 
    acceleration: number
  ): number {
    // Base probability from historical pattern matching
    let probability = 0.55;
    
    // Adjust based on acceleration magnitude
    probability += Math.min(Math.abs(acceleration) * 0.05, 0.15);
    
    // Adjust based on time of day (peaks more common in first hour)
    const hour = snapshot.timestamp.getHours();
    const minute = snapshot.timestamp.getMinutes();
    const minutesSinceOpen = (hour - 9) * 60 + (minute - 15);
    
    if (minutesSinceOpen < 60) {
      probability += 0.05;
    } else if (minutesSinceOpen > 180) {
      probability -= 0.05; // Afternoon peaks less reliable
    }
    
    // Adjust based on VIX
    if (snapshot.indiaVix && snapshot.indiaVix < 14) {
      probability += 0.05; // Low VIX = more predictable
    }
    
    return Math.max(0.3, Math.min(0.85, probability));
  }
  
  private calculateSignalStrength(acceleration: number, expansion: number): number {
    // 0-100 score combining factors
    const accScore = Math.min(Math.abs(acceleration) * 20, 50);
    const expScore = Math.min(expansion * 2, 50);
    return accScore + expScore;
  }
}
```

### 8.2 Probability Estimation Model

The initial probability model is **rule-based with Bayesian updates**. We avoid ML initially because:
1. Insufficient training data (need 100+ samples per regime)
2. Overfitting risk is high
3. Interpretability is crucial for trading

#### Bayesian Update Framework

```typescript
interface PriorProbability {
  regime: MarketRegime;
  baseProbability: number;
  sampleSize: number;
  lastUpdated: Date;
}

interface ObservedOutcome {
  regime: MarketRegime;
  signalStrength: number;
  wasCorrect: boolean;
}

class BayesianProbabilityModel {
  private priors: Map<MarketRegime, PriorProbability> = new Map();
  
  // Initialize with domain knowledge
  constructor() {
    this.priors.set('LOW_VOL', { 
      regime: 'LOW_VOL', 
      baseProbability: 0.60, 
      sampleSize: 50, 
      lastUpdated: new Date() 
    });
    this.priors.set('HIGH_VOL', { 
      regime: 'HIGH_VOL', 
      baseProbability: 0.45, 
      sampleSize: 50, 
      lastUpdated: new Date() 
    });
    this.priors.set('TRENDING', { 
      regime: 'TRENDING', 
      baseProbability: 0.40, 
      sampleSize: 50, 
      lastUpdated: new Date() 
    });
    this.priors.set('RANGEBOUND', { 
      regime: 'RANGEBOUND', 
      baseProbability: 0.65, 
      sampleSize: 50, 
      lastUpdated: new Date() 
    });
  }
  
  estimateProbability(regime: MarketRegime, signalStrength: number): number {
    const prior = this.priors.get(regime);
    if (!prior) return 0.5;
    
    // Adjust based on signal strength (0-100)
    const strengthAdjustment = (signalStrength - 50) * 0.002; // ±10% max
    
    return Math.max(0.3, Math.min(0.85, prior.baseProbability + strengthAdjustment));
  }
  
  updateWithOutcome(outcome: ObservedOutcome): void {
    const prior = this.priors.get(outcome.regime);
    if (!prior) return;
    
    // Bayesian update with Beta distribution
    // Treating wins as successes, losses as failures
    const alpha = prior.baseProbability * prior.sampleSize;
    const beta = (1 - prior.baseProbability) * prior.sampleSize;
    
    const newAlpha = alpha + (outcome.wasCorrect ? 1 : 0);
    const newBeta = beta + (outcome.wasCorrect ? 0 : 1);
    const newSampleSize = prior.sampleSize + 1;
    
    const newProbability = newAlpha / (newAlpha + newBeta);
    
    this.priors.set(outcome.regime, {
      regime: outcome.regime,
      baseProbability: newProbability,
      sampleSize: newSampleSize,
      lastUpdated: new Date()
    });
  }
}
```

### 8.3 Time-Staggered Entry Analysis

For each signal, we simulate entries at multiple time offsets:

```typescript
interface StaggeredEntryConfig {
  offsets: number[];         // Minutes after signal
  strategies: StrategyType[];
  underlying: string[];
}

const DEFAULT_STAGGER_CONFIG: StaggeredEntryConfig = {
  offsets: [0, 5, 10, 15],
  strategies: ['NON_DIRECTIONAL', 'DIRECTIONAL'],
  underlying: ['NIFTY', 'BANKNIFTY']
};

class TimingAnalyzer {
  private db: Database;
  
  async analyzeSignalWithStaggeredEntries(signal: TradingSignal): Promise<void> {
    for (const offset of DEFAULT_STAGGER_CONFIG.offsets) {
      const entryTime = addMinutes(signal.timestamp, offset);
      const entryPrice = await this.getPriceAtTime(signal.underlying, signal.suggestedStrike, entryTime);
      
      if (!entryPrice) continue; // Market not open or no data
      
      // Create paper trade for each offset
      await this.createPaperTrade({
        signalId: signal.id,
        entryTime,
        entryPrice,
        entryDelayBucket: `${offset}min`,
        // Use a special "timing-analysis" personality
        personalityId: TIMING_ANALYSIS_PERSONALITY_ID
      });
    }
  }
  
  async generateTimingReport(
    dateRangeStart: Date, 
    dateRangeEnd: Date
  ): Promise<TimingReport> {
    const results = await this.db.query(`
      SELECT 
        entry_delay_bucket,
        underlying,
        strategy_type,
        COUNT(*) as trades,
        AVG(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) as win_rate,
        AVG(net_pnl) as avg_pnl,
        STDDEV(net_pnl) as pnl_stddev
      FROM paper_trades
      WHERE trade_time BETWEEN $1 AND $2
        AND personality_id = $3
      GROUP BY entry_delay_bucket, underlying, strategy_type
      ORDER BY underlying, strategy_type, entry_delay_bucket
    `, [dateRangeStart, dateRangeEnd, TIMING_ANALYSIS_PERSONALITY_ID]);
    
    // Statistical significance testing
    const significanceResults = this.performANOVA(results);
    
    return {
      byBucket: results,
      bestBucket: this.findBestBucket(results),
      isSignificant: significanceResults.pValue < 0.05,
      pValue: significanceResults.pValue,
      recommendations: this.generateRecommendations(results, significanceResults)
    };
  }
  
  private performANOVA(results: BucketResults[]): ANOVAResult {
    // One-way ANOVA to test if timing differences are significant
    // H0: All timing buckets have same mean P&L
    // H1: At least one bucket differs
    
    // Implementation uses F-test
    // Returns { fStatistic, pValue, degreesOfFreedom }
  }
}
```

---

## 9. Personality Bot Framework

### 9.1 Personality Definition

Each personality is a **parameter set** that determines trading behavior:

```typescript
interface PersonalityConfig {
  // Identity
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  
  // Entry parameters
  minProbability: number;           // 0.0 - 1.0
  maxDailyTrades: number;           // Hard limit
  entryDelaySeconds: number;        // Wait after signal
  allowedStrategies: StrategyType[];
  allowedUnderlyings: string[];
  
  // Risk parameters
  maxLossPerTrade: number;          // Stop if single trade exceeds
  maxDailyLoss: number;             // Stop trading for day if exceeded
  positionSizeMultiplier: number;   // 0.5 = half size, 2.0 = double
  
  // Profit gate
  requireProfitGate: boolean;
  profitGateThreshold: number;      // Min P&L in lookback period
  profitGateLookbackDays: number;
  
  // Time filters
  allowedTradingWindows: TimeWindow[];
  blockedDates: Date[];             // Skip specific dates (e.g., budget day)
  
  // Regime filters
  allowedRegimes: MarketRegime[];
  maxVix: number;
  minVix: number;
  
  // Re-entry rules
  allowReentry: boolean;
  reentryDelayMinutes: number;
  maxReentriesPerSignal: number;
  
  // Evolution metadata
  version: number;
  parentVersion: number | null;
  evolutionReason: string | null;
  performanceMetrics: PerformanceMetrics;
}

interface TimeWindow {
  startTime: string;  // "09:20"
  endTime: string;    // "14:30"
}

interface PerformanceMetrics {
  winRate30d: number;
  totalPnL30d: number;
  sharpe30d: number;
  maxDrawdown30d: number;
  tradesCount30d: number;
  lastUpdated: Date;
}
```

### 9.2 Default Personalities

```typescript
const PERSONALITIES: PersonalityConfig[] = [
  {
    id: 'conservative',
    name: 'Conservative',
    description: 'High probability trades only, profit-gated, limited frequency',
    isActive: true,
    
    minProbability: 0.75,
    maxDailyTrades: 2,
    entryDelaySeconds: 300,      // 5 min delay for confirmation
    allowedStrategies: ['NON_DIRECTIONAL'],
    allowedUnderlyings: ['NIFTY'],
    
    maxLossPerTrade: 2500,
    maxDailyLoss: 4000,
    positionSizeMultiplier: 1.0,
    
    requireProfitGate: true,
    profitGateThreshold: 5000,
    profitGateLookbackDays: 5,
    
    allowedTradingWindows: [
      { startTime: '09:25', endTime: '11:30' },
      { startTime: '14:00', endTime: '15:00' }
    ],
    blockedDates: [],
    
    allowedRegimes: ['LOW_VOL', 'RANGEBOUND'],
    maxVix: 18,
    minVix: 10,
    
    allowReentry: false,
    reentryDelayMinutes: 0,
    maxReentriesPerSignal: 0,
    
    version: 1,
    parentVersion: null,
    evolutionReason: null,
    performanceMetrics: { /* initialized */ }
  },
  
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Moderate probability threshold, reasonable frequency',
    isActive: true,
    
    minProbability: 0.60,
    maxDailyTrades: 4,
    entryDelaySeconds: 120,
    allowedStrategies: ['NON_DIRECTIONAL', 'DIRECTIONAL'],
    allowedUnderlyings: ['NIFTY', 'BANKNIFTY'],
    
    maxLossPerTrade: 3500,
    maxDailyLoss: 8000,
    positionSizeMultiplier: 1.0,
    
    requireProfitGate: false,
    profitGateThreshold: 0,
    profitGateLookbackDays: 0,
    
    allowedTradingWindows: [
      { startTime: '09:20', endTime: '15:15' }
    ],
    blockedDates: [],
    
    allowedRegimes: ['LOW_VOL', 'HIGH_VOL', 'RANGEBOUND'],
    maxVix: 25,
    minVix: 8,
    
    allowReentry: true,
    reentryDelayMinutes: 15,
    maxReentriesPerSignal: 1,
    
    version: 1,
    parentVersion: null,
    evolutionReason: null,
    performanceMetrics: { /* initialized */ }
  },
  
  {
    id: 'aggressive',
    name: 'Aggressive',
    description: 'Lower probability threshold, high frequency, all regimes',
    isActive: true,
    
    minProbability: 0.50,
    maxDailyTrades: 8,
    entryDelaySeconds: 30,
    allowedStrategies: ['NON_DIRECTIONAL', 'DIRECTIONAL', 'MOMENTUM_BUY'],
    allowedUnderlyings: ['NIFTY', 'BANKNIFTY', 'SENSEX'],
    
    maxLossPerTrade: 4000,
    maxDailyLoss: 15000,
    positionSizeMultiplier: 1.5,
    
    requireProfitGate: false,
    profitGateThreshold: 0,
    profitGateLookbackDays: 0,
    
    allowedTradingWindows: [
      { startTime: '09:16', endTime: '15:25' }
    ],
    blockedDates: [],
    
    allowedRegimes: ['LOW_VOL', 'HIGH_VOL', 'TRENDING', 'RANGEBOUND'],
    maxVix: 35,
    minVix: 0,
    
    allowReentry: true,
    reentryDelayMinutes: 5,
    maxReentriesPerSignal: 2,
    
    version: 1,
    parentVersion: null,
    evolutionReason: null,
    performanceMetrics: { /* initialized */ }
  }
];
```

### 9.3 Personality Router

```typescript
class PersonalityRouter {
  private personalities: PersonalityConfig[];
  private personalityStates: Map<string, PersonalityState>;
  
  constructor(personalities: PersonalityConfig[]) {
    this.personalities = personalities.filter(p => p.isActive);
    this.personalityStates = new Map();
    this.initializeStates();
  }
  
  async routeSignal(signal: TradingSignal): Promise<TradeDecision[]> {
    const decisions: TradeDecision[] = [];
    
    for (const personality of this.personalities) {
      const state = this.personalityStates.get(personality.id)!;
      const decision = await this.evaluateForPersonality(signal, personality, state);
      
      if (decision.shouldTrade) {
        decisions.push(decision);
      }
    }
    
    return decisions;
  }
  
  private async evaluateForPersonality(
    signal: TradingSignal,
    personality: PersonalityConfig,
    state: PersonalityState
  ): Promise<TradeDecision> {
    const checks: CheckResult[] = [];
    
    // Check 1: Probability threshold
    checks.push({
      name: 'probability_threshold',
      passed: signal.winProbability >= personality.minProbability,
      reason: `Signal prob ${signal.winProbability} vs required ${personality.minProbability}`
    });
    
    // Check 2: Daily trade limit
    checks.push({
      name: 'daily_trade_limit',
      passed: state.tradesToday < personality.maxDailyTrades,
      reason: `Trades today: ${state.tradesToday} / ${personality.maxDailyTrades}`
    });
    
    // Check 3: Daily loss limit
    checks.push({
      name: 'daily_loss_limit',
      passed: state.dailyPnL > -personality.maxDailyLoss,
      reason: `Daily P&L: ${state.dailyPnL}, limit: -${personality.maxDailyLoss}`
    });
    
    // Check 4: Strategy allowed
    checks.push({
      name: 'strategy_allowed',
      passed: personality.allowedStrategies.includes(signal.strategyType),
      reason: `Strategy ${signal.strategyType} allowed: ${personality.allowedStrategies.join(', ')}`
    });
    
    // Check 5: Underlying allowed
    checks.push({
      name: 'underlying_allowed',
      passed: personality.allowedUnderlyings.includes(signal.underlying),
      reason: `Underlying ${signal.underlying} allowed: ${personality.allowedUnderlyings.join(', ')}`
    });
    
    // Check 6: Time window
    const currentTime = format(new Date(), 'HH:mm');
    const inTimeWindow = personality.allowedTradingWindows.some(
      w => currentTime >= w.startTime && currentTime <= w.endTime
    );
    checks.push({
      name: 'time_window',
      passed: inTimeWindow,
      reason: `Current time ${currentTime}, windows: ${JSON.stringify(personality.allowedTradingWindows)}`
    });
    
    // Check 7: Regime filter
    checks.push({
      name: 'regime_filter',
      passed: personality.allowedRegimes.includes(signal.marketRegime),
      reason: `Regime ${signal.marketRegime} allowed: ${personality.allowedRegimes.join(', ')}`
    });
    
    // Check 8: VIX range
    const vix = signal.vixAtSignal || 15;
    checks.push({
      name: 'vix_range',
      passed: vix >= personality.minVix && vix <= personality.maxVix,
      reason: `VIX ${vix}, range: ${personality.minVix}-${personality.maxVix}`
    });
    
    // Check 9: Profit gate (if enabled)
    if (personality.requireProfitGate) {
      const lookbackPnL = await this.getLookbackPnL(
        personality.id, 
        personality.profitGateLookbackDays
      );
      checks.push({
        name: 'profit_gate',
        passed: lookbackPnL >= personality.profitGateThreshold,
        reason: `Lookback P&L: ${lookbackPnL}, threshold: ${personality.profitGateThreshold}`
      });
    }
    
    const allPassed = checks.every(c => c.passed);
    
    return {
      personalityId: personality.id,
      signalId: signal.id,
      shouldTrade: allPassed,
      checks,
      entryDelaySeconds: personality.entryDelaySeconds,
      positionSizeMultiplier: personality.positionSizeMultiplier
    };
  }
}
```

---

## 10. Retrospection Engine

### 10.1 Retrospection Goals

The retrospection engine runs EOD and performs:

1. **Performance Attribution:** Which personality performed best today? Why?
2. **Statistical Testing:** Are observed patterns statistically significant?
3. **Parameter Evolution:** Should any personality parameters change?
4. **Anomaly Detection:** Were there unusual market conditions?

### 10.2 EOD Analysis Flow

```typescript
class RetrospectionEngine {
  private db: Database;
  private personalityService: PersonalityService;
  
  async runEODAnalysis(tradingDate: Date): Promise<RetrospectionReport> {
    console.log(`[Retrospection] Starting EOD analysis for ${tradingDate}`);
    
    // Step 1: Gather all trades for the day
    const trades = await this.db.getTrades(tradingDate);
    const signals = await this.db.getSignals(tradingDate);
    
    // Step 2: Performance by personality
    const personalityPerformance = this.analyzeByPersonality(trades);
    
    // Step 3: Timing analysis
    const timingAnalysis = this.analyzeTimingBuckets(trades);
    
    // Step 4: Signal quality assessment
    const signalQuality = this.assessSignalQuality(signals, trades);
    
    // Step 5: Market regime classification
    const regime = await this.classifyMarketRegime(tradingDate);
    
    // Step 6: Statistical tests
    const statisticalTests = this.runStatisticalTests(trades, regime);
    
    // Step 7: Parameter evolution candidates
    const evolutionCandidates = this.identifyEvolutionCandidates(
      personalityPerformance,
      statisticalTests
    );
    
    // Step 8: Generate report
    const report: RetrospectionReport = {
      date: tradingDate,
      summary: this.generateSummary(personalityPerformance, trades),
      personalityPerformance,
      timingAnalysis,
      signalQuality,
      marketRegime: regime,
      statisticalTests,
      evolutionCandidates,
      recommendations: this.generateRecommendations(evolutionCandidates)
    };
    
    // Step 9: Store report
    await this.db.saveRetrospectionReport(report);
    
    // Step 10: Apply approved evolutions (manual review required)
    // NOT auto-applied - flagged for human review
    
    return report;
  }
  
  private analyzeByPersonality(trades: PaperTrade[]): PersonalityPerformance[] {
    const grouped = groupBy(trades, 'personalityId');
    
    return Object.entries(grouped).map(([personalityId, personalityTrades]) => {
      const wins = personalityTrades.filter(t => t.netPnL > 0);
      const losses = personalityTrades.filter(t => t.netPnL <= 0);
      
      const totalPnL = sum(personalityTrades.map(t => t.netPnL));
      const avgPnL = mean(personalityTrades.map(t => t.netPnL));
      const stdDev = std(personalityTrades.map(t => t.netPnL));
      
      return {
        personalityId,
        tradesCount: personalityTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: wins.length / personalityTrades.length,
        totalPnL,
        avgPnL,
        stdDev,
        sharpe: avgPnL / stdDev * Math.sqrt(252), // Annualized
        maxWin: Math.max(...personalityTrades.map(t => t.netPnL)),
        maxLoss: Math.min(...personalityTrades.map(t => t.netPnL)),
        avgHoldingTime: mean(personalityTrades.map(t => 
          differenceInMinutes(t.exitTime, t.tradeTime)
        ))
      };
    });
  }
  
  private runStatisticalTests(
    trades: PaperTrade[], 
    regime: MarketRegime
  ): StatisticalTestResult[] {
    const results: StatisticalTestResult[] = [];
    
    // Test 1: Are personality differences significant? (ANOVA)
    const personalityGroups = groupBy(trades, 'personalityId');
    const anovaResult = this.performOneWayANOVA(
      Object.values(personalityGroups).map(g => g.map(t => t.netPnL))
    );
    results.push({
      testName: 'Personality Difference (ANOVA)',
      hypothesis: 'H0: All personalities have equal mean P&L',
      statistic: anovaResult.fStatistic,
      pValue: anovaResult.pValue,
      significant: anovaResult.pValue < 0.05,
      interpretation: anovaResult.pValue < 0.05
        ? 'Significant difference between personalities'
        : 'No significant difference - could be noise'
    });
    
    // Test 2: Is timing bucket difference significant?
    const timingGroups = groupBy(trades, 'entryDelayBucket');
    const timingAnovaResult = this.performOneWayANOVA(
      Object.values(timingGroups).map(g => g.map(t => t.netPnL))
    );
    results.push({
      testName: 'Timing Bucket Difference (ANOVA)',
      hypothesis: 'H0: All timing buckets have equal mean P&L',
      statistic: timingAnovaResult.fStatistic,
      pValue: timingAnovaResult.pValue,
      significant: timingAnovaResult.pValue < 0.05,
      interpretation: timingAnovaResult.pValue < 0.05
        ? `Timing matters! Best bucket: ${this.findBestTimingBucket(timingGroups)}`
        : 'Timing differences not significant'
    });
    
    // Test 3: Is win rate significantly above 50%? (Binomial test)
    const wins = trades.filter(t => t.netPnL > 0).length;
    const binomialPValue = this.binomialTest(wins, trades.length, 0.5);
    results.push({
      testName: 'Win Rate vs 50% (Binomial)',
      hypothesis: 'H0: True win rate = 50%',
      statistic: wins / trades.length,
      pValue: binomialPValue,
      significant: binomialPValue < 0.05,
      interpretation: binomialPValue < 0.05
        ? `Win rate ${(wins / trades.length * 100).toFixed(1)}% is significantly above 50%`
        : 'Cannot conclude win rate is above 50%'
    });
    
    return results;
  }
  
  private identifyEvolutionCandidates(
    performance: PersonalityPerformance[],
    tests: StatisticalTestResult[]
  ): EvolutionCandidate[] {
    const candidates: EvolutionCandidate[] = [];
    
    for (const perf of performance) {
      // Candidate 1: Win rate too low - tighten probability threshold
      if (perf.winRate < 0.40 && perf.tradesCount >= 10) {
        candidates.push({
          personalityId: perf.personalityId,
          parameter: 'minProbability',
          currentValue: 0, // Will be fetched
          suggestedValue: 0, // Will be calculated
          reason: `Win rate ${(perf.winRate * 100).toFixed(1)}% below 40%`,
          confidence: 'HIGH',
          requiresReview: true
        });
      }
      
      // Candidate 2: Too many trades losing - reduce max trades
      if (perf.totalPnL < -5000 && perf.tradesCount > 3) {
        candidates.push({
          personalityId: perf.personalityId,
          parameter: 'maxDailyTrades',
          currentValue: 0,
          suggestedValue: 0,
          reason: `Lost ₹${Math.abs(perf.totalPnL)} with ${perf.tradesCount} trades`,
          confidence: 'MEDIUM',
          requiresReview: true
        });
      }
      
      // Candidate 3: Sharpe too low - add profit gate
      if (perf.sharpe < 0.5 && perf.tradesCount >= 15) {
        candidates.push({
          personalityId: perf.personalityId,
          parameter: 'requireProfitGate',
          currentValue: false,
          suggestedValue: true,
          reason: `Sharpe ratio ${perf.sharpe.toFixed(2)} too low`,
          confidence: 'MEDIUM',
          requiresReview: true
        });
      }
    }
    
    return candidates;
  }
}
```

### 10.3 Evolution Rules

```typescript
interface EvolutionRule {
  name: string;
  trigger: (metrics: RollingMetrics) => boolean;
  action: (config: PersonalityConfig) => PersonalityConfig;
  cooldownDays: number;  // Don't re-apply within this period
  requiresReview: boolean;
}

const EVOLUTION_RULES: EvolutionRule[] = [
  {
    name: 'TightenProbabilityOnLosing',
    trigger: (m) => m.winRate30d < 0.40 && m.tradesCount30d >= 20,
    action: (config) => ({
      ...config,
      minProbability: Math.min(config.minProbability + 0.05, 0.85),
      version: config.version + 1,
      parentVersion: config.version,
      evolutionReason: 'Auto: Win rate below 40%'
    }),
    cooldownDays: 7,
    requiresReview: true
  },
  
  {
    name: 'ReduceTradesOnDrawdown',
    trigger: (m) => m.maxDrawdown30d > 15000,
    action: (config) => ({
      ...config,
      maxDailyTrades: Math.max(config.maxDailyTrades - 1, 1),
      version: config.version + 1,
      parentVersion: config.version,
      evolutionReason: 'Auto: Drawdown exceeded ₹15,000'
    }),
    cooldownDays: 14,
    requiresReview: true
  },
  
  {
    name: 'IncreaseDelayOnWhipsaw',
    trigger: (m) => m.avgHoldingTime < 10 && m.winRate30d < 0.45,
    action: (config) => ({
      ...config,
      entryDelaySeconds: config.entryDelaySeconds + 60,
      version: config.version + 1,
      parentVersion: config.version,
      evolutionReason: 'Auto: Quick exits + low win rate (whipsaw detection)'
    }),
    cooldownDays: 7,
    requiresReview: true
  },
  
  {
    name: 'EnableProfitGateOnVariance',
    trigger: (m) => m.pnlStdDev > 3000 && !m.hasProfitGate,
    action: (config) => ({
      ...config,
      requireProfitGate: true,
      profitGateThreshold: 3000,
      profitGateLookbackDays: 5,
      version: config.version + 1,
      parentVersion: config.version,
      evolutionReason: 'Auto: High P&L variance'
    }),
    cooldownDays: 30,
    requiresReview: true
  }
];
```

---

## 11. API & Integration Layer

### 11.1 Internal API Endpoints

```typescript
// ==========================================
// FASTIFY ROUTE DEFINITIONS
// ==========================================

// Health check
app.get('/health', async () => ({ status: 'ok', timestamp: new Date() }));

// ---- STRADDLE ----
app.get('/api/straddle/current/:underlying', async (req) => {
  const { underlying } = req.params;
  return straddleService.getCurrent(underlying);
});

app.get('/api/straddle/history/:underlying', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        resolution: { type: 'string', enum: ['1m', '5m', '15m', '1h'] }
      }
    }
  }
}, async (req) => {
  const { underlying } = req.params;
  const { from, to, resolution } = req.query;
  return straddleService.getHistory(underlying, from, to, resolution);
});

// ---- SIGNALS ----
app.get('/api/signals', async (req) => {
  const { date, status } = req.query;
  return signalService.getSignals({ date, status });
});

app.get('/api/signals/:id', async (req) => {
  return signalService.getSignal(req.params.id);
});

// ---- PERSONALITIES ----
app.get('/api/personalities', async () => {
  return personalityService.getAll();
});

app.get('/api/personalities/:id', async (req) => {
  return personalityService.getById(req.params.id);
});

app.patch('/api/personalities/:id', {
  schema: {
    body: {
      type: 'object',
      properties: {
        minProbability: { type: 'number', minimum: 0, maximum: 1 },
        maxDailyTrades: { type: 'integer', minimum: 1 },
        // ... other fields
      }
    }
  }
}, async (req) => {
  return personalityService.update(req.params.id, req.body);
});

app.get('/api/personalities/:id/performance', async (req) => {
  const { days = 30 } = req.query;
  return personalityService.getPerformance(req.params.id, days);
});

// ---- TRADES ----
app.get('/api/trades', async (req) => {
  const { date, personality, status } = req.query;
  return tradeService.getTrades({ date, personality, status });
});

app.get('/api/trades/:id', async (req) => {
  return tradeService.getById(req.params.id);
});

// ---- RETROSPECTION ----
app.get('/api/retrospection/reports', async (req) => {
  const { from, to } = req.query;
  return retrospectionService.getReports(from, to);
});

app.get('/api/retrospection/reports/:date', async (req) => {
  return retrospectionService.getReport(req.params.date);
});

app.post('/api/retrospection/run', async (req) => {
  const { date } = req.body;
  return retrospectionService.triggerManualRun(date);
});

// ---- TIMING ANALYSIS ----
app.get('/api/timing/analysis', async (req) => {
  const { from, to, underlying, strategy } = req.query;
  return timingService.getAnalysis({ from, to, underlying, strategy });
});

// ---- WEBSOCKET ----
app.register(async (fastify) => {
  fastify.get('/ws/live', { websocket: true }, (connection) => {
    // Subscribe to real-time updates
    const unsubscribe = pubsub.subscribe('live-updates', (data) => {
      connection.socket.send(JSON.stringify(data));
    });
    
    connection.socket.on('close', () => {
      unsubscribe();
    });
  });
});
```

### 11.2 Quantiply Integration

```typescript
interface QuantiplyConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  paperTrading: boolean;
}

class QuantiplyClient {
  private config: QuantiplyConfig;
  private httpClient: AxiosInstance;
  
  constructor(config: QuantiplyConfig) {
    this.config = config;
    this.httpClient = axios.create({
      baseURL: config.baseUrl,
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json'
      }
    });
  }
  
  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    const endpoint = this.config.paperTrading 
      ? '/paper/orders' 
      : '/orders';
    
    const response = await this.httpClient.post(endpoint, {
      tradingsymbol: order.symbol,
      exchange: 'NFO',
      transaction_type: order.side,
      quantity: order.quantity,
      price: order.price,
      order_type: order.orderType,
      product: 'NRML',
      validity: 'DAY'
    });
    
    return {
      orderId: response.data.order_id,
      status: response.data.status,
      filledQty: response.data.filled_quantity,
      avgPrice: response.data.average_price
    };
  }
  
  async getPositions(): Promise<Position[]> {
    const endpoint = this.config.paperTrading 
      ? '/paper/positions' 
      : '/positions';
    
    const response = await this.httpClient.get(endpoint);
    
    return response.data.positions.map((p: any) => ({
      symbol: p.tradingsymbol,
      qty: p.quantity,
      avgPrice: p.average_price,
      ltp: p.ltp,
      pnl: p.pnl,
      side: p.quantity > 0 ? 'LONG' : 'SHORT'
    }));
  }
  
  async modifyOrder(orderId: string, modifications: OrderModification): Promise<void> {
    const endpoint = this.config.paperTrading 
      ? `/paper/orders/${orderId}` 
      : `/orders/${orderId}`;
    
    await this.httpClient.put(endpoint, modifications);
  }
  
  async cancelOrder(orderId: string): Promise<void> {
    const endpoint = this.config.paperTrading 
      ? `/paper/orders/${orderId}` 
      : `/orders/${orderId}`;
    
    await this.httpClient.delete(endpoint);
  }
  
  async getOptionChain(underlying: string, expiry: Date): Promise<OptionChain> {
    const response = await this.httpClient.get('/instruments/option-chain', {
      params: {
        underlying,
        expiry: format(expiry, 'yyyy-MM-dd')
      }
    });
    
    return response.data;
  }
}
```

### 11.3 Market Data Feed

```typescript
interface MarketDataConfig {
  provider: 'QUANTIPLY' | 'FYERS' | 'ZERODHA';
  symbols: string[];
  onTick: (tick: Tick) => void;
  onError: (error: Error) => void;
}

class MarketDataFeed {
  private ws: WebSocket | null = null;
  private config: MarketDataConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  
  constructor(config: MarketDataConfig) {
    this.config = config;
  }
  
  async connect(): Promise<void> {
    const wsUrl = this.getWebSocketUrl();
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.on('open', () => {
      console.log('[MarketData] Connected');
      this.reconnectAttempts = 0;
      this.subscribe(this.config.symbols);
    });
    
    this.ws.on('message', (data: Buffer) => {
      const tick = this.parseTick(data);
      if (tick) {
        this.config.onTick(tick);
      }
    });
    
    this.ws.on('error', (error) => {
      console.error('[MarketData] Error:', error);
      this.config.onError(error);
    });
    
    this.ws.on('close', () => {
      console.log('[MarketData] Disconnected');
      this.attemptReconnect();
    });
  }
  
  private subscribe(symbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.ws.send(JSON.stringify({
      action: 'subscribe',
      symbols
    }));
  }
  
  private parseTick(data: Buffer): Tick | null {
    try {
      const parsed = JSON.parse(data.toString());
      return {
        symbol: parsed.symbol,
        ltp: parsed.ltp,
        bid: parsed.bid,
        ask: parsed.ask,
        volume: parsed.volume,
        oi: parsed.oi,
        timestamp: new Date(parsed.timestamp)
      };
    } catch (e) {
      console.error('[MarketData] Parse error:', e);
      return null;
    }
  }
  
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[MarketData] Max reconnect attempts reached');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.pow(2, this.reconnectAttempts) * 1000; // Exponential backoff
    
    console.log(`[MarketData] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => this.connect(), delay);
  }
  
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

---

## 12. Risk Management

### 12.1 Risk Limits

```typescript
interface RiskLimits {
  // Per-trade limits
  maxLossPerTrade: number;           // ₹4,000
  maxPositionSize: number;           // 2 lots
  
  // Daily limits
  maxDailyLoss: number;              // ₹15,000
  maxDailyTrades: number;            // 15
  maxOpenPositions: number;          // 4
  
  // Weekly limits
  maxWeeklyLoss: number;             // ₹40,000
  
  // Circuit breakers
  consecutiveLossLimit: number;      // 3 - stop after 3 consecutive losses
  volatilityPause: {
    vixThreshold: number;            // 25 - pause if VIX > 25
    resumeThreshold: number;         // 20 - resume if VIX < 20
  };
  gapPause: {
    gapPercentThreshold: number;     // 2% - pause if gap > 2%
    pauseDurationMinutes: number;    // 15
  };
}

const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxLossPerTrade: 4000,
  maxPositionSize: 2,
  
  maxDailyLoss: 15000,
  maxDailyTrades: 15,
  maxOpenPositions: 4,
  
  maxWeeklyLoss: 40000,
  
  consecutiveLossLimit: 3,
  volatilityPause: {
    vixThreshold: 25,
    resumeThreshold: 20
  },
  gapPause: {
    gapPercentThreshold: 2,
    pauseDurationMinutes: 15
  }
};
```

### 12.2 Risk Monitor

```typescript
class RiskMonitor {
  private limits: RiskLimits;
  private state: RiskState;
  
  constructor(limits: RiskLimits = DEFAULT_RISK_LIMITS) {
    this.limits = limits;
    this.state = this.initializeState();
  }
  
  canTrade(proposedTrade: TradeProposal): RiskCheckResult {
    const checks: RiskCheck[] = [];
    
    // Check 1: Per-trade loss limit
    checks.push({
      name: 'max_loss_per_trade',
      passed: proposedTrade.maxPotentialLoss <= this.limits.maxLossPerTrade,
      currentValue: proposedTrade.maxPotentialLoss,
      limit: this.limits.maxLossPerTrade
    });
    
    // Check 2: Position size
    checks.push({
      name: 'max_position_size',
      passed: proposedTrade.lots <= this.limits.maxPositionSize,
      currentValue: proposedTrade.lots,
      limit: this.limits.maxPositionSize
    });
    
    // Check 3: Daily loss
    checks.push({
      name: 'max_daily_loss',
      passed: this.state.dailyPnL > -this.limits.maxDailyLoss,
      currentValue: this.state.dailyPnL,
      limit: -this.limits.maxDailyLoss
    });
    
    // Check 4: Daily trade count
    checks.push({
      name: 'max_daily_trades',
      passed: this.state.dailyTradeCount < this.limits.maxDailyTrades,
      currentValue: this.state.dailyTradeCount,
      limit: this.limits.maxDailyTrades
    });
    
    // Check 5: Open positions
    checks.push({
      name: 'max_open_positions',
      passed: this.state.openPositionCount < this.limits.maxOpenPositions,
      currentValue: this.state.openPositionCount,
      limit: this.limits.maxOpenPositions
    });
    
    // Check 6: Weekly loss
    checks.push({
      name: 'max_weekly_loss',
      passed: this.state.weeklyPnL > -this.limits.maxWeeklyLoss,
      currentValue: this.state.weeklyPnL,
      limit: -this.limits.maxWeeklyLoss
    });
    
    // Check 7: Consecutive losses
    checks.push({
      name: 'consecutive_losses',
      passed: this.state.consecutiveLosses < this.limits.consecutiveLossLimit,
      currentValue: this.state.consecutiveLosses,
      limit: this.limits.consecutiveLossLimit
    });
    
    // Check 8: VIX circuit breaker
    checks.push({
      name: 'vix_circuit_breaker',
      passed: !this.state.isVolatilityPaused,
      currentValue: this.state.currentVix,
      limit: this.limits.volatilityPause.vixThreshold
    });
    
    // Check 9: Gap circuit breaker
    checks.push({
      name: 'gap_circuit_breaker',
      passed: !this.state.isGapPaused,
      currentValue: this.state.gapPercent,
      limit: this.limits.gapPause.gapPercentThreshold
    });
    
    const allPassed = checks.every(c => c.passed);
    const failedChecks = checks.filter(c => !c.passed);
    
    return {
      canTrade: allPassed,
      checks,
      failedChecks,
      message: allPassed 
        ? 'All risk checks passed' 
        : `Blocked by: ${failedChecks.map(c => c.name).join(', ')}`
    };
  }
  
  updateState(event: RiskEvent): void {
    switch (event.type) {
      case 'TRADE_CLOSED':
        this.state.dailyPnL += event.pnl;
        this.state.weeklyPnL += event.pnl;
        this.state.dailyTradeCount++;
        
        if (event.pnl < 0) {
          this.state.consecutiveLosses++;
        } else {
          this.state.consecutiveLosses = 0;
        }
        break;
        
      case 'POSITION_OPENED':
        this.state.openPositionCount++;
        break;
        
      case 'POSITION_CLOSED':
        this.state.openPositionCount--;
        break;
        
      case 'VIX_UPDATE':
        this.state.currentVix = event.vix;
        this.state.isVolatilityPaused = event.vix > this.limits.volatilityPause.vixThreshold;
        break;
        
      case 'GAP_DETECTED':
        this.state.gapPercent = event.gapPercent;
        if (Math.abs(event.gapPercent) > this.limits.gapPause.gapPercentThreshold) {
          this.state.isGapPaused = true;
          this.state.gapPauseUntil = addMinutes(new Date(), this.limits.gapPause.pauseDurationMinutes);
        }
        break;
        
      case 'DAY_END':
        this.state.dailyPnL = 0;
        this.state.dailyTradeCount = 0;
        this.state.consecutiveLosses = 0;
        this.state.isGapPaused = false;
        break;
        
      case 'WEEK_END':
        this.state.weeklyPnL = 0;
        break;
    }
  }
}
```

---

## 13. Testing Strategy

### 13.1 Test Categories

| Category | Tool | Coverage Target | Description |
|----------|------|-----------------|-------------|
| **Unit Tests** | Vitest | 80%+ | Pure functions, calculations, transformers |
| **Integration Tests** | Vitest + TestContainers | 60%+ | Database queries, API endpoints |
| **E2E Tests** | Playwright | Critical paths | Full user flows |
| **Backtests** | Custom framework | All strategies | Historical performance validation |
| **Paper Trade Tests** | Manual + Automated | Daily | Live market validation |

### 13.2 Unit Test Examples

```typescript
// straddle-calculator.test.ts
import { describe, it, expect } from 'vitest';
import { StraddleCalculator } from '../src/services/straddle-calculator';

describe('StraddleCalculator', () => {
  describe('calculateATMStrike', () => {
    it('should round to nearest 50 for NIFTY', () => {
      expect(StraddleCalculator.calculateATMStrike(22437, 'NIFTY')).toBe(22450);
      expect(StraddleCalculator.calculateATMStrike(22462, 'NIFTY')).toBe(22450);
      expect(StraddleCalculator.calculateATMStrike(22475, 'NIFTY')).toBe(22500);
    });
    
    it('should round to nearest 100 for BANKNIFTY', () => {
      expect(StraddleCalculator.calculateATMStrike(47850, 'BANKNIFTY')).toBe(47900);
      expect(StraddleCalculator.calculateATMStrike(47949, 'BANKNIFTY')).toBe(47900);
      expect(StraddleCalculator.calculateATMStrike(47950, 'BANKNIFTY')).toBe(48000);
    });
  });
  
  describe('calculateROC', () => {
    it('should calculate rate of change correctly', () => {
      const history = [
        { straddleValue: 100, timestamp: new Date('2024-01-15T09:20:00') },
        { straddleValue: 105, timestamp: new Date('2024-01-15T09:21:00') },
        { straddleValue: 108, timestamp: new Date('2024-01-15T09:22:00') },
      ];
      
      const roc = StraddleCalculator.calculateROC(history, 1);
      expect(roc).toBe(3); // 108 - 105 = 3 per minute
    });
    
    it('should return 0 for insufficient data', () => {
      const history = [{ straddleValue: 100, timestamp: new Date() }];
      expect(StraddleCalculator.calculateROC(history, 1)).toBe(0);
    });
  });
});

// peak-detector.test.ts
describe('PeakDetector', () => {
  describe('detectMomentumExhaustion', () => {
    it('should detect exhaustion when ROC decelerates', () => {
      const detector = new PeakDetector();
      detector.onMarketOpen(350);
      
      // Simulate expansion then deceleration
      const snapshots = [
        { straddleValue: 360, roc1m: 5, roc5m: 4 },
        { straddleValue: 370, roc1m: 8, roc5m: 6 },
        { straddleValue: 380, roc1m: 6, roc5m: 7 },  // ROC declining
        { straddleValue: 385, roc1m: 3, roc5m: 6 },  // Strong deceleration
      ];
      
      let signal = null;
      for (const snapshot of snapshots) {
        signal = detector.processSnapshot(snapshot as any);
      }
      
      expect(signal).not.toBeNull();
      expect(signal!.probability).toBeGreaterThan(0.5);
    });
    
    it('should NOT signal when expansion is insufficient', () => {
      const detector = new PeakDetector({ minExpansionPercent: 10 });
      detector.onMarketOpen(350);
      
      // Only 5% expansion
      const snapshot = { straddleValue: 367, roc1m: 1, roc5m: 0.5 };
      const signal = detector.processSnapshot(snapshot as any);
      
      expect(signal).toBeNull();
    });
  });
});
```

### 13.3 Backtest Framework

```typescript
interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  underlying: string[];
  strategies: StrategyType[];
  personalities: PersonalityConfig[];
  slippage: number;           // Assumed slippage in points
  charges: ChargeStructure;   // STT, brokerage, etc.
}

interface BacktestResult {
  config: BacktestConfig;
  metrics: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    grossPnL: number;
    netPnL: number;
    maxDrawdown: number;
    sharpeRatio: number;
    calmarRatio: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    expectancy: number;
  };
  byPersonality: Map<string, PersonalityMetrics>;
  byMonth: Map<string, MonthlyMetrics>;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
}

class Backtester {
  private config: BacktestConfig;
  private historicalData: Map<string, StraddleSnapshot[]>;
  
  async run(): Promise<BacktestResult> {
    const trades: BacktestTrade[] = [];
    let equity = 100000; // Starting capital
    const equityCurve: EquityPoint[] = [{ date: this.config.startDate, equity }];
    
    // Iterate through each trading day
    for (const date of this.getTradingDays()) {
      const dayData = await this.loadDayData(date);
      const signals = this.generateSignals(dayData);
      
      for (const signal of signals) {
        for (const personality of this.config.personalities) {
          const decision = this.evaluateSignalForPersonality(signal, personality);
          
          if (decision.shouldTrade) {
            const trade = this.simulateTrade(signal, personality, dayData);
            trades.push(trade);
            equity += trade.netPnL;
          }
        }
      }
      
      equityCurve.push({ date, equity });
    }
    
    return this.calculateMetrics(trades, equityCurve);
  }
  
  private simulateTrade(
    signal: TradingSignal,
    personality: PersonalityConfig,
    dayData: DayData
  ): BacktestTrade {
    // Find entry price at signal time + delay
    const entryTime = addSeconds(signal.timestamp, personality.entryDelaySeconds);
    const entrySnapshot = this.findNearestSnapshot(dayData, entryTime);
    
    // Apply slippage
    const entryPrice = entrySnapshot.straddleValue + this.config.slippage;
    
    // Simulate position through the day
    let exitPrice = entryPrice;
    let exitReason: ExitReason = 'EOD';
    let exitTime = dayData.marketClose;
    
    // Check for stop-loss hits
    for (const snapshot of dayData.snapshots) {
      if (snapshot.timestamp <= entryTime) continue;
      
      const slPercent = (snapshot.straddleValue - entryPrice) / entryPrice;
      
      if (signal.signalType === 'STRADDLE_SELL' && slPercent > 0.15) {
        // 15% adverse move for short straddle
        exitPrice = snapshot.straddleValue - this.config.slippage;
        exitReason = 'SL_HIT';
        exitTime = snapshot.timestamp;
        break;
      }
    }
    
    // If no SL hit, exit at EOD
    if (exitReason === 'EOD') {
      const eodSnapshot = dayData.snapshots[dayData.snapshots.length - 1];
      exitPrice = eodSnapshot.straddleValue - this.config.slippage;
    }
    
    // Calculate P&L
    const grossPnL = signal.signalType === 'STRADDLE_SELL'
      ? (entryPrice - exitPrice) * 50 // Lot size
      : (exitPrice - entryPrice) * 50;
    
    const charges = this.calculateCharges(entryPrice, exitPrice);
    const netPnL = grossPnL - charges;
    
    return {
      signalId: signal.id,
      personalityId: personality.id,
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      exitReason,
      grossPnL,
      charges,
      netPnL
    };
  }
}
```

---

## 14. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| Set up TypeScript + Bun project | P0 | 2h | None |
| PostgreSQL + TimescaleDB setup | P0 | 4h | None |
| Redis setup | P0 | 2h | None |
| Market data feed integration | P0 | 8h | Quantiply API access |
| Straddle calculator service | P0 | 4h | Market data feed |
| ROC engine | P0 | 4h | Straddle calculator |
| Historical data backfill | P1 | 8h | DB setup |

**Deliverable:** Real-time straddle tracking with historical storage

### Phase 2: Signal Engine (Weeks 3-4)

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| Peak detector algorithm | P0 | 16h | ROC engine |
| Signal generator | P0 | 8h | Peak detector |
| Probability estimator | P0 | 8h | Signal generator |
| Market regime classifier | P1 | 8h | Historical data |
| Signal storage + API | P0 | 4h | DB setup |

**Deliverable:** Signals generated and stored, visible via API

### Phase 3: Personality System (Weeks 5-6)

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| Personality config schema | P0 | 4h | None |
| Personality router | P0 | 8h | Signal generator |
| Default personalities setup | P0 | 4h | Config schema |
| Paper trade executor | P0 | 12h | Quantiply integration |
| Position manager | P0 | 8h | Paper trade executor |
| Risk monitor | P0 | 8h | Position manager |

**Deliverable:** Multiple personalities paper trading in parallel

### Phase 4: Retrospection (Weeks 7-8)

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| EOD analysis engine | P0 | 16h | Trade history |
| Statistical testing suite | P0 | 8h | Analysis engine |
| Parameter evolution rules | P1 | 8h | Statistical tests |
| Timing analysis | P1 | 8h | Staggered entry data |
| Report generator | P1 | 4h | Analysis engine |

**Deliverable:** Daily retrospection reports with evolution candidates

### Phase 5: Dashboard (Weeks 9-10)

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| React project setup | P0 | 2h | None |
| Real-time straddle chart | P0 | 8h | WebSocket + Charts |
| Personality dashboard | P0 | 8h | Personality API |
| Trade log view | P1 | 4h | Trade API |
| Retrospection viewer | P1 | 4h | Retrospection API |
| Alerts integration (Telegram) | P2 | 4h | Signal generator |

**Deliverable:** Operational dashboard for monitoring

### Phase 6: Validation (Weeks 11-12)

| Task | Priority | Effort | Dependencies |
|------|----------|--------|--------------|
| Backtest framework | P0 | 16h | Historical data |
| 3-month backtest | P0 | 8h | Backtest framework |
| Walk-forward testing | P1 | 8h | Backtest results |
| Paper trading burn-in | P0 | Ongoing | Full system |
| Documentation | P1 | 8h | All phases |

**Deliverable:** Validated system ready for extended paper trading

---

## 15. Success Metrics

### 15.1 System Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Uptime** | 99.5% during market hours | Monitoring |
| **Tick latency** | < 100ms | Prometheus |
| **Signal generation latency** | < 500ms | Prometheus |
| **API response time (p99)** | < 200ms | Prometheus |

### 15.2 Trading Metrics (6-Month Target)

| Metric | Conservative | Balanced | Aggressive |
|--------|--------------|----------|------------|
| **Win Rate** | > 55% | > 50% | > 45% |
| **Sharpe Ratio** | > 1.5 | > 1.2 | > 1.0 |
| **Max Drawdown** | < ₹30K | < ₹50K | < ₹80K |
| **Monthly Return** | > 5% | > 8% | > 12% |

### 15.3 Retrospection Metrics

| Metric | Target | Description |
|--------|--------|-------------|
| **Parameter Stability** | < 30% monthly change | Avoid overfitting |
| **Prediction Accuracy** | > 55% | Peak detection signal accuracy |
| **False Positive Rate** | < 30% | Signals that shouldn't have been generated |

---

## 16. Appendix

### 16.1 Glossary

| Term | Definition |
|------|------------|
| **ATM** | At-The-Money - strike closest to current spot price |
| **OTM1** | First Out-of-The-Money strike |
| **Straddle** | Long/short position in both CE and PE of same strike |
| **ROC** | Rate of Change - speed of premium movement |
| **TSL** | Trailing Stop Loss |
| **VIX** | India Volatility Index |
| **Personality** | Parameter configuration defining trading behavior |
| **Retrospection** | Post-market analysis and learning process |

### 16.2 References

1. TimescaleDB Documentation: https://docs.timescale.com/
2. Fastify Documentation: https://www.fastify.io/docs/latest/
3. Quantiply API Documentation: [Internal]
4. Options Greeks and Pricing: Hull, J. (2017). Options, Futures, and Other Derivatives

### 16.3 Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2024-01-15 | Trading Systems | Initial draft |

---

*End of Document*
