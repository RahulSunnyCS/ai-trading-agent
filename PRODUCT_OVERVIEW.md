# AI Trading Agent — Product Overview

## What Is This?

The **AI Trading Agent** is a paper-trading research platform designed to find the optimal entry timing for weekly index options strategies on Indian markets (NSE/BSE). It runs multiple parallel "trading personalities" simultaneously, tracks their performance, and evolves their parameters automatically — the goal is to discover, through systematic experimentation, the entry timing and risk configuration that consistently performs best.

---

## The Problem Being Solved

Weekly options traders face a fundamental dilemma every morning:

| Trader | Behavior | Outcome |
|--------|----------|---------|
| **Too Early** | Enters before straddle peaks | Caught in expansion, stopped out |
| **Too Late** | Waits for full confirmation | Misses the optimal entry |
| **Optimal** | Detects momentum exhaustion | Enters at the sweet spot |

Most traders fall into the first two categories. This system aims to **systematically become the third type** by:

- Detecting when a straddle has peaked using momentum exhaustion signals
- Running multiple personalities with different entry timings in parallel
- Statistically identifying which timing windows actually produce better outcomes
- Continuously refining parameters based on what actually worked

---

## Who Is This For?

- **Options traders** who run weekly index strategies on Nifty, BankNifty, or Sensex
- **Quant-oriented traders** who want data-driven evidence before going live with a strategy
- **Researchers** testing whether momentum exhaustion signals are a real edge

This is a **research and paper-trading tool** — it does not execute real trades.

---

## Supported Markets & Strategies

### Underlying Instruments
- **Nifty 50** (NSE)
- **BankNifty** (NSE)
- **Sensex** (BSE)

### Trading Strategies

| # | Strategy | Entry | Structure | Max Loss |
|---|----------|-------|-----------|----------|
| **Strategy 1** | Non-Directional | 9:17 AM | Sell OTM1 PE + CE | ₹2,000/lot |
| **Strategy 2** | Directional (ATM Short) | 9:24 AM | Sell ATM CE + PE | ₹3,500/lot |
| **Strategy 3** | Momentum Buy | 9:30 AM trigger | Buy OTM after 20% move | ₹1,000/lot |

Strategy 1 accounts for ~80% of trades. All strategies have defined stop-loss and trailing stop-loss rules.

---

## The Three Trading Personalities

The system runs three personalities in parallel, each with a distinct risk appetite:

### The Sniper (Conservative)
> "Only the highest-confidence setups"

- Requires **75%+ probability** before entering
- Maximum **2 trades per day**
- Only trades in calm markets (VIX 10–18)
- Will not trade unless recent P&L is profitable
- Expected: 60–70% win rate, 3–6% monthly return (lower frequency, higher quality)

### The Professional (Balanced)
> "Good setups, consistent sizing"

- Requires **60%+ probability** before entering
- Maximum **4 trades per day**
- Operates across a wider VIX range (8–25)
- No profit gate — trades every qualifying day
- Expected: 50–58% win rate, 5–10% monthly return

### The Opportunist (Aggressive)
> "More swings, higher variance"

- Requires only **50%+ probability** before entering
- Maximum **8 trades per day**
- Operates in nearly all market conditions (VIX up to 35)
- 1.5× position sizing
- Expected: 42–50% win rate, 8–18% monthly return (high variance)

All three personalities receive the same signals simultaneously — the difference is whether they act on it.

---

## How Entry Signals Are Generated

The core signal is **Momentum Exhaustion Detection**:

1. From market open, the system tracks the straddle value (ATM CE + PE combined premium)
2. It measures the **rate of change** and **acceleration** of straddle expansion
3. When expansion has been at least **10%** and the rate of change starts decelerating, a signal is fired
4. The signal includes a **confidence probability** adjusted for:
   - Current VIX level
   - Time of day
   - Day of week

**Fallback signals** are also supported:
- **Scheduled entry**: Fixed time triggers (9:17 AM, 9:24 AM) when no momentum signal fires
- **Pullback entry**: Entry after a 2% pullback from a detected peak

---

## How Decisions Are Made

Every signal passes through a **5-stage filter** before a personality acts:

```
Stage 1 — Hard Filters:      Is this strategy/underlying/time allowed?
Stage 2 — State Checks:      Have we hit daily trade/loss limits?
Stage 3 — Context Checks:    Is VIX in an acceptable range?
Stage 4 — Signal Quality:    Does probability meet the threshold?
Stage 5 — Profit Gate:       Has recent performance earned the right to trade? (Sniper only)
```

A trade only executes if it passes all applicable stages.

---

## How the System Learns & Evolves

At the end of each trading day, the system runs a **retrospection batch** that analyzes:

- Win rates, P&L, and drawdowns per personality
- Best entry offsets (0, 5, 10, 15 min after signal)
- Win rate by hour, day of week, and VIX range
- Parameter suggestions for next day

### Evolution Phases

| Phase | Method | When |
|-------|--------|------|
| **Phase 1** | Rule-based adjustments | MVP (now) |
| **Phase 2** | Bayesian optimization | After stable baseline |
| **Phase 3** | Genetic algorithms | After 3+ months data |
| **Phase 4** | Reinforcement learning | Future |

**Example rule-based evolution:**
- Win rate < 40% → increase probability threshold by 5%
- Max drawdown > ₹20K → reduce daily trade limit by 1
- High result variance → enable profit gate

All parameter changes are logged with version history so evolution is fully traceable.

---

## Success Criteria

### When Is the System "Working"?

| Metric | Target |
|--------|--------|
| Win rate improvement vs random entry | > 15% |
| Sharpe ratio | > 1.5 |
| Parameter drift | < 20% month-over-month |
| Peak detection accuracy | > 55% after 50 samples |

### When Should We Stop?

The system has built-in **falsification criteria** — pre-defined conditions that indicate the approach isn't working:

- 3 consecutive months: no personality beats random entry
- Peak detection accuracy < 45% after 50 samples
- Parameter variance > 40% month-over-month

---

## Known Risks & Limitations

### 1. This Is Paper Trading
All trades are simulated. Slippage, liquidity constraints, and execution quality in live markets will differ — especially during high-volatility opens.

### 2. Overfitting Risk
The system has many tunable parameters. Continuous adaptation can cause it to fit historical patterns that don't repeat. Mitigation: regime-aware static playbooks and strict hypothesis testing before parameter changes.

### 3. Correlated Personalities
All three personalities trade the same underlying, so their drawdowns may be correlated — the "diversification" between personalities is behavioral, not asset-level.

### 4. Probability Calibration
The confidence scores (e.g., "75% probability") are estimates based on rules and historical patterns — not rigorously calibrated probability distributions. Treat them as relative rankings, not absolute likelihoods.

---

## Implementation Roadmap

### Phase 1 — MVP
- One signal type (momentum exhaustion)
- Two personalities (Conservative + Balanced)
- One index (Nifty)
- Daily retrospection + weekly review
- Rule-based evolution

### Phase 2 — Expansion
- Add Aggressive personality
- Add Strategies 2 & 3
- Bayesian parameter optimization
- Multi-index support (BankNifty, Sensex)

### Phase 3 — Optimization
- Genetic algorithms for personality discovery
- Microstructure-aware simulation (realistic slippage)
- Regime-switching logic

### Phase 4 — Advanced
- Reinforcement learning (if warranted by data)
- Cross-personality portfolio-level risk constraints
- Options Greeks hedging framework

---

## Dashboard & Reporting

The system includes a real-time React dashboard showing:

- Live straddle value and momentum indicators
- Active signals and their confidence levels
- Per-personality trade activity and running P&L
- EOD retrospection reports with timing analysis charts

---

## Data Sources

| Source | Data | Usage |
|--------|------|-------|
| NSE/BSE WebSocket | Real-time ticks | Straddle calculation, signal generation |
| Quantiply API | Paper trade execution | Simulated P&L tracking |
| India VIX | Volatility index | Signal confidence adjustment, regime detection |
| FII/DII flow | Institutional activity | External signal context |
| Global indices | SGX Nifty, Dow, GIFT Nifty | Pre-market context |

---

*This document covers the product and strategy perspective. For architecture, database schema, and implementation details, see [TECHNICAL_REFERENCE.md](./TECHNICAL_REFERENCE.md).*
