# AI Trading Agent — Product Overview

## What Is This?

The **AI Trading Agent** is a paper-trading research platform for weekly index options strategies on Indian markets (NSE/BSE). It runs multiple parallel "trading personalities" simultaneously across two dimensions — **how to enter** and **how to manage** positions — tracks their performance, and evolves parameters automatically.

The core philosophy is to move away from **time-based, fixed rules** toward **signal-based, adaptive strategies** where every decision (entry timing, position sizing, adjustment, exit) is driven by market data and validated through systematic experimentation.

The goal is to discover, through controlled parallel testing, which combination of entry signals and position management styles consistently performs best — and under which market conditions.

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
- Testing multiple position management styles simultaneously (roll vs cut vs hold)
- Statistically identifying which combination of entry + management produces better outcomes
- Continuously refining parameters based on what actually worked — tagged by market regime

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

## Trading Personalities

The system runs **10 personalities in parallel** across two groups:

**Reference personalities (7)** are controlled experiments. Each one isolates a single variable — entry signal quality, entry frequency, or position management style — so that comparisons are clean. Clockwork is the permanent benchmark that nothing ever changes. The other six have their strategy identity locked (entry type + management style never changes) but their tuning parameters evolve slowly based on evidence.

**Learning personalities (3)** simulate human traders with different adaptation speeds. All three start from identical Clockwork parameters (fixed time entry, hold management) and evolve from there — Conservative Learner very slowly, Medium Learner moderately, Aggressive Learner quickly. After months of trading, their parameter divergence is itself the research output.

| # | Name | Group | Tests |
|---|------|-------|-------|
| 1 | **Clockwork** | Reference | Permanent benchmark — fixed time entry, frozen forever |
| 2 | **Precision** | Reference | High-confidence signal entry vs time-based |
| 3 | **Scanner** | Reference | Entry frequency vs selectivity |
| 4 | **Adjuster** | Reference | Rolling management vs holding |
| 5 | **Reducer** | Reference | Cut+re-enter management vs holding and rolling |
| 6 | **Blitz** | Reference | Max frequency + active management vs selective + passive |
| 7 | **Levelhead** | Reference | S/R-anchored entry vs momentum exhaustion *(Phase 2)* |
| 8 | **Conservative Learner** | Learning | Slow adaptation — 30 samples before any change |
| 9 | **Medium Learner** | Learning | Moderate adaptation — 15 samples before changes |
| 10 | **Aggressive Learner** | Learning | Fast adaptation — acts on as few as 5 samples |

For full personality detail, starting parameters, what can evolve, comparison baselines, and a concrete 5-day evolution example, see **[PERSONALITIES.md](./PERSONALITIES.md)**.

---

## How Entry Signals Are Generated

The system supports multiple signal types. They are layered in phases — each new signal type added only after the previous one is proven.

### Signal Type 1: Momentum Exhaustion (Core)

1. From market open, the system tracks the straddle value (ATM CE + PE combined premium)
2. It measures the **rate of change** and **acceleration** of straddle expansion
3. When expansion has been at least **10%** and the rate of change starts decelerating, a signal is fired
4. The signal includes a **confidence probability** adjusted for:
   - Current VIX level
   - Time of day
   - Day of week

**Fallback signals** within this type:
- **Scheduled entry**: Fixed time triggers (9:17 AM, 9:24 AM) when no momentum signal fires
- **Pullback entry**: Entry after a 2% pullback from a detected peak

### Signal Type 2: Support/Resistance Level Entry (Phase 2)

When the index approaches a well-defined, objective S/R level (e.g., previous week's high/low, monthly pivot), a signal is generated:
- **Short straddle at S/R**: Expecting range-bound behaviour around the level; time decay works in favour
- **Directional buy at S/R**: Expecting a sharp bounce or break; asymmetric payoff

S/R levels are defined objectively (not subjectively) — pivot points, previous week high/low, volume POC — and carry a "strength score" based on how many times the level has been tested.

> **Why not build this first?** S/R detection requires significant infrastructure and the quality of the level definition determines everything. It is sequenced after the core signal type is validated.

---

## Strategy Ideas — Honest Evaluation

As the system evolves beyond time-based entries, several ideas have been considered. This is an honest assessment of each:

| Idea | Good? | Practical Now? | Honest Take |
|------|-------|---------------|-------------|
| **ATM straddle peak** | Yes | Yes | The core. Prove this first before adding anything else. |
| **50/100 pt move → add new straddle** | Conceptually interesting | No | Too undefined as a standalone signal. Without a portfolio-level delta/gamma framework, adding straddles at fixed point intervals creates compounding directional risk. Viable only as part of the position management (Adjuster) framework — not as an independent entry signal. |
| **S/R → directional straddle or buy** | Yes, real edge | Phase 2 | Most valuable addition. Options at well-defined S/R levels have genuine edge — short straddle for range-bound expectation, directional buy for bounce/break. Requires a proper S/R detection engine with objective level definitions and strength scoring. |

### Notes on the "50/100 pt" Idea Specifically

This idea is valid **only when reframed correctly**. As an independent entry trigger ("every time index moves 100 points, open a new straddle") it is dangerous because:
- The trigger point is arbitrary without backtesting
- In a trending day, it results in multiple straddles all losing simultaneously
- There is no natural exit or position-size discipline

The **correct framing** is as the Adjuster management style: a position that already exists gets one leg rolled when the index moves ~70 points. This keeps gross exposure flat, reduces net delta, and has defined rules. Same intuition, much safer implementation.

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

## Position Management: The Second Dimension

Entry timing is only half the problem. Once a short straddle is open, **how you manage it as the market moves** determines a large part of the outcome. This is the second dimension the system tests in parallel.

### The Problem: Delta Accumulation

A short straddle is delta-neutral at entry. As the index moves, delta accumulates:

```
Short straddle @ 23000, index moves to 23070:
  → Short 23000 CE is now losing (deeper ITM)
  → Short 23000 PE is winning (further OTM)
  → Net position: short delta (directional risk building)
```

Three philosophies exist for handling this. The system runs all three simultaneously and lets data decide which wins.

---

### The Three Management Styles

#### The Adjuster
> "Stay in the trade, neutralize delta by rolling"

When the index moves ~70 points against the position, the Adjuster rolls one leg to the new ATM strike:

```
3× short straddle @ 23000, index hits 23070
→ Buy back one 23000 CE
→ Sell one 23100 CE (new ATM-ish)
→ Now: 2× at 23000 + 1× rolled to 23100
→ Net delta reduced, gross exposure unchanged
```

- Stays invested at all times — theta keeps collecting on all legs
- Best in: ranging markets where delta eventually reverses
- Worst in: strong trending days where you keep rolling into a move

#### The Reducer
> "Cut size on adverse move, re-enter at better prices"

When the index moves ~70 points against the position, the Reducer closes one of the short straddles entirely — reducing exposure — then waits for VIX to spike or price acceleration to peak before re-entering a new straddle at the new ATM.

```
3× short straddle @ 23000, index hits 23070
→ Close one 23000 straddle (take the loss, reduce exposure)
→ Wait for VIX spike or momentum exhaustion signal
→ Re-enter 1× short straddle @ 23070–23100 at elevated IV
```

- Reduces loss exposure on adverse move
- Re-enters at higher IV — potentially better premium
- Best in: trending days (cuts a losing leg before it gets worse, re-enters at better price)
- Worst in: ranging days (exited too early, re-entered at higher cost, lost theta)

#### The Holder
> "Trust theta, hold conviction through the move"

The Holder makes no adjustment. The position is held until the original stop-loss, trailing stop-loss, or end of day — no rolling, no cutting.

```
3× short straddle @ 23000, index hits 23070
→ No action. Monitor. Let theta work.
→ If market reverts, all three positions recover.
→ If market continues, all three positions keep losing.
```

- Zero transaction costs — no bid-ask drag from adjustments
- Best in: ranging markets with strong mean reversion
- **Warning:** This is the highest-variance and highest-risk style in trending markets. "Holder" does not mean safe — it means maximum exposure. A strongly trending day without adjustment can result in the largest losses of all three styles.

---

### How the Styles Perform by Regime

The winner is **not universal** — it is regime-dependent. This is why regime tagging in the retrospection engine is critical:

| Market Regime | Adjuster | Reducer | Holder |
|---------------|----------|---------|--------|
| Ranging (most common) | Wins — delta neutral, full theta | Loses — exited too early | Wins — theta recovers |
| Trending strong | Bleeds — keeps rolling into move | Wins — cut and re-entered | Blows up — full exposure |
| Volatile + reverting | Wins — adjustments help | Neutral | Neutral |
| Event day spike | Bleeds — multiple losing legs | Wins — reduced size early | Largest loss |

The retrospection engine labels every trading day with its regime. Comparisons are only meaningful within the same regime bucket.

---

### Hard Risk Rules (All Styles)

Regardless of management style, the following are non-negotiable:

- **Maximum open legs**: 4 legs total across all straddles (hard cap, no exceptions)
- **Portfolio-level stop**: If total portfolio P&L drops below ₹X, close all positions immediately — no more rolls or re-entries that day
- **Event day gate**: No new positions or rolls on RBI policy days, budget days, or F&O expiry morning until after the event
- **Margin buffer**: At least 30% free margin required before any roll or new position is added

---

## How the System Learns & Evolves

At the end of each trading day, a retrospection batch runs and analyzes every personality. The output is not just "who won today" — it's **why**, under **which regime**, and **what should change**.

Every result is tagged with the day's market regime before any comparison is made:

| Regime Tag | Definition |
|-----------|-----------|
| `RANGING` | Index within ±0.5% of open, VIX stable |
| `TRENDING_STRONG` | Index moves 1%+ directionally |
| `VOLATILE_REVERTING` | Large intraday swings but mean-reverting |
| `EVENT_DAY` | RBI, budget, F&O expiry morning, macro news |

---

### What Retrospection Computes Per Personality

For every personality, the batch produces five outputs:

1. **Daily metrics** — trades taken, win rate, P&L, max drawdown, Sharpe
2. **Beat-Clockwork delta** — how much this personality made vs Clockwork on the same day (the only comparison that matters)
3. **Entry quality** — for signal-based personalities: were stated probabilities calibrated? Did 70%+ signals actually win 70%+ of the time?
4. **Management effectiveness** — for Adjuster/Reducer/Blitz: did the roll or cut improve outcomes compared to what a hold would have produced in the same situation?
5. **Parameter suggestions** — regime-tagged recommendations for what to change

---

### What Can and Cannot Change — Per Personality

Each personality has a **fixed identity** (entry type + management style) that never changes, and **tunable parameters** around that identity that the retrospection engine can suggest evolving.

| Personality | Fixed Forever | Can Evolve |
|-------------|--------------|-----------|
| **Clockwork** | Everything — entry time, management, all params | **Nothing. Ever.** |
| **Precision** | Entry type (momentum exhaustion), management (Hold) | Probability threshold, max trades/day, VIX range |
| **Scanner** | Entry type (any signal), management (Hold) | Probability threshold, max trades/day |
| **Adjuster** | Entry type (momentum exhaustion), management (Roll) | Probability threshold, roll trigger distance, max open legs |
| **Reducer** | Entry type (momentum exhaustion), management (Cut+Re-enter) | Probability threshold, cut trigger distance, re-entry signal threshold |
| **Blitz** | Entry type (any signal), management (Roll) | Entry threshold, roll trigger distance, max legs |
| **Levelhead** | Entry type (S/R-anchored), management (Reducer) | S/R proximity window, strength score threshold |

The management style is the personality's identity. If Precision starts rolling, it has become Adjuster — that defeats the experiment.

---

### The Clockwork Rule

Clockwork is the **permanent control group**. It answers one question every day:

> *"Is the market beatable today, and by how much?"*

```
All personalities beat Clockwork   → signal-based approaches adding value
No personality beats Clockwork     → the edge may not exist in this regime
Some beat Clockwork in some regime → regime-specific edge confirmed
```

Clockwork's retrospection output is read-only — no suggestions, no changes, no evolution. It is the anchor against which all other personalities are measured at every point in time.

---

### Sample Retrospection Output (Illustrative)

**Ranging day. All personalities ran on the same Nifty signals.**

```
CLOCKWORK     Trades: 1 | P&L: +₹1,840 | Regime: RANGING
              → No changes. Baseline logged.

PRECISION     Trades: 2 | P&L: +₹2,950 | Beat Clockwork: +₹1,110
              Signal calibration: 72%, 78% signals → both won ✓
              → No parameter change suggested.

ADJUSTER      Trades: 2 | P&L: +₹2,200 | Beat Clockwork: +₹360
              Roll triggered at 23070 → market reversed 45 min later
              Roll cost ₹750 in spread. Would have recovered without rolling.
              → Suggestion: on RANGING days, increase roll trigger from 70pt to 90pt
                (queued — needs 10 more RANGING day samples before applying)

REDUCER       Trades: 2 | P&L: +₹1,400 | Lost to Clockwork: -₹440
              Cut triggered → market reversed → re-entry missed recovery window
              → Suggestion: consider RANGING regime gate for Reducer
                (queued — needs 15 more samples to confirm pattern)

SCANNER       Trades: 4 | P&L: +₹3,100 | Beat Clockwork: +₹1,260
              High frequency helped on ranging day (multiple small wins)
              → No change suggested.

BLITZ         Trades: 4 | P&L: +₹1,950 | Beat Clockwork: +₹110
              Rolls added cost on a ranging day vs Scanner (same entries, no rolls)
              → Suggestion: on RANGING days, Blitz underperforms Scanner.
                Track: does Blitz outperform Scanner on TRENDING days? (hypothesis)
```

---

### Comparison Integrity Rule

Precision, Adjuster, and Reducer share the same entry style (high-confidence momentum exhaustion). For their management comparison to be valid, their entry thresholds must stay close. If they drift apart, the comparison becomes "who has a better threshold" rather than "who has a better management style."

**Enforcement:** If the probability threshold gap between any of these three exceeds 8 percentage points, the retrospection engine flags it and pauses further evolution on the outlier until alignment is restored.

---

### Evolution Phases

| Phase | Method | When |
|-------|--------|------|
| **Phase 1** | Rule-based adjustments | From the start |
| **Phase 2** | Bayesian optimization | After 3+ months stable data per personality |
| **Phase 3** | Genetic algorithms | After regime-personality mapping is established |
| **Phase 4** | Reinforcement learning | Only if earlier phases show clear learnable patterns |

All parameter changes are logged with: date, old value, new value, triggering metrics, regime context, and whether human approval was required. Evolution is fully auditable.

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

### 5. Rolling Into a Trend (Adjuster-specific)
The Adjuster style's biggest risk: on a strongly trending day, rolling one leg at every 70-point move means you accumulate losses across multiple rolling points without ever reversing. Each roll adds transaction cost and the aggregate loss can be the largest of all three styles.

### 6. Gamma Compounding With Multiple Legs
Holding 3 short straddles at different strikes is not 3× the risk — it behaves worse on large moves because all legs are simultaneously deep ITM. The hard cap of 4 total legs exists specifically to prevent this from compounding.

### 7. Complexity Budget vs Statistical Significance
The system now tests across two dimensions: entry signal type × management style. Each combination needs 30+ trades for meaningful data. With 2–3 signals per day, some combinations will take months to produce statistically significant results. Running all combinations simultaneously from day one is tempting but produces noise, not signal.

---

## Implementation Roadmap

The system is built in focused phases — each phase answers one research question before the next is layered on. This prevents the "too many variables" problem where you can't tell what's working.

### Phase 1 — Entry Signal vs Baseline + Management Styles
**Research questions:**
- Does any signal-based entry beat fixed-time entry? (Clockwork vs Precision)
- Does entry selectivity beat frequency? (Precision vs Scanner)
- Does active management add value over holding? (Adjuster and Reducer vs Precision)
- Does max-activity beat selective-passive? (Blitz vs Precision)

**Personalities running:** Clockwork, Precision, Scanner, Adjuster, Reducer, Blitz

- Signal type: Momentum exhaustion only
- Index: Nifty (single index to start)
- Portfolio-level Greeks tracking required before Adjuster/Reducer/Blitz go live
- Daily retrospection with regime tagging on every result
- Rule-based evolution (Clockwork excluded permanently)

*Exit criteria: 50+ samples per personality, statistically significant regime-tagged results.*

### Phase 2 — S/R Signal Type
**Research question: Does S/R-anchored entry add independent edge beyond momentum exhaustion?**

**New personality:** Levelhead

- Build S/R detection engine (objective levels: previous week high/low, monthly pivot, volume POC)
- Run Levelhead in parallel alongside Phase 1 personalities
- Multi-index expansion: BankNifty, Sensex
- Bayesian parameter optimization for evolving personalities

*Exit criteria: 30+ Levelhead samples per regime, compared against Precision as control.*

### Phase 3 — Full System Optimization
- Add Strategies 2 & 3 (directional ATM short, momentum buy) to relevant personalities
- Genetic algorithms for discovering new personality combinations
- Microstructure-aware simulation (dynamic slippage model, not static)
- Cross-personality portfolio-level risk constraints

### Phase 4 — Advanced (If Warranted by Data)
- Reinforcement learning for management decisions
- Options Greeks hedging (delta/gamma)
- Live trading readiness assessment

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
