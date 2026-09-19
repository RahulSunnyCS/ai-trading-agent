# Product & Strategy

What this system is, who it is for, and which markets it covers live in
`.claude/project/overview.md`, which is auto-loaded into every session. This
file holds what that summary deliberately leaves out: the reasoning — why these
strategies, how the decisions are made, what would count as success, and where
it can go wrong.

Delivery status and the task catalogue are in `docs/roadmap.md`.

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



---

# Personalities — Full Reference

## Important: What "Frozen" Actually Means

A common confusion: "frozen" does not mean "parameters never change." Here is the precise definition per personality type:

| What's frozen | Reference personalities | Learning personalities |
|--------------|------------------------|----------------------|
| **Entry type** | Yes — always | No — can shift with strong evidence |
| **Management style** | Yes — always | No — can shift with strong evidence |
| **Tuning parameters** | Evolve slowly (high evidence bar) | Evolve at their learning speed |
| **Everything** | Clockwork only | Never |

Clockwork is the only personality where literally nothing ever changes. It is the permanent, unchanging baseline.

---


## The 2D Design Matrix (Reference Personalities)

Reference personalities are designed so that each comparison isolates exactly one variable:

```
                    HOLD          ROLL           CUT + RE-ENTER
                 ┌────────────┬──────────────┬────────────────────┐
Time-based       │ Clockwork  │      —        │         —          │
High-conf signal │ Precision  │   Adjuster    │      Reducer       │
Low-conf signal  │  Scanner   │    Blitz      │         —          │
S/R-anchored     │     —      │      —        │     Levelhead *    │
                 └────────────┴──────────────┴────────────────────┘
                                                      * Phase 2 only
```

Blank cells are intentional. Every filled cell is a hypothesis. Every adjacent pair shares one variable and differs on exactly one other.

---


## Reference Personalities (1–7)

### 1. Clockwork
> *"Does any signal-based approach outperform a fixed clock?"*

**The permanent benchmark.** Enters at a fixed time every day. Holds to stop-loss or EOD. No signal filtering, no management adjustments, no parameter evolution — ever. If every other personality can't beat Clockwork consistently, signal-based approaches have no edge.

| Parameter | Value | Evolvable? |
|-----------|-------|-----------|
| Entry | Fixed 9:17 AM, every qualifying day | **No** |
| Management | Hold to SL / TSL / EOD | **No** |
| min_probability | — (not applicable) | **No** |
| max_daily_trades | 1 | **No** |
| max_daily_loss | ₹5,000 | **No** |
| entry_delay_secs | 0 | **No** |
| ALL parameters | Starting values | **Nothing changes. Ever.** |

**Compared against:** Nothing — it is the benchmark all others compare against.

---

### 2. Precision
> *"Does high-quality signal entry beat time-based entry, with no other changes?"*

Enters only on high-confidence momentum exhaustion signals. Holds through the position exactly like Clockwork — no adjustments. The only variable changed from Clockwork is the entry trigger.

| Parameter | Starting Value | Evolvable? |
|-----------|---------------|-----------|
| Entry type | Momentum exhaustion | No |
| Management style | Hold | No |
| min_probability | 0.70 | Yes — slowly |
| max_daily_trades | 2 | Yes — slowly |
| max_daily_loss | ₹8,000 | Yes — slowly |
| entry_delay_secs | 120 | Yes — slowly |
| vix_max | 25 | Yes — slowly |

**Compared against:** Clockwork (same management, different entry trigger)

---

### 3. Scanner
> *"Does taking more signals beat being selective — if management is the same?"*

Enters on any qualifying signal including low-confidence momentum exhaustion and scheduled fallback entries. Same hold management as Precision — the only variable is entry threshold.

| Parameter | Starting Value | Evolvable? |
|-----------|---------------|-----------|
| Entry type | Any signal (momentum + fallback) | No |
| Management style | Hold | No |
| min_probability | 0.50 | Yes — slowly |
| max_daily_trades | 5 | Yes — slowly |
| max_daily_loss | ₹10,000 | Yes — slowly |
| entry_delay_secs | 60 | Yes — slowly |
| vix_max | 30 | Yes — slowly |

**Compared against:** Precision (same management, different entry threshold)

---

### 4. Adjuster
> *"Does active delta neutralization (rolling) add value over just holding a good entry?"*

Same high-confidence entry as Precision. When the index moves ~70 points adversely, rolls one leg to the new ATM strike — reducing net delta without adding gross exposure.

| Parameter | Starting Value | Evolvable? |
|-----------|---------------|-----------|
| Entry type | Momentum exhaustion | No |
| Management style | Roll | No |
| min_probability | 0.70 | Yes — slowly |
| max_daily_trades | 2 | Yes — slowly |
| roll_trigger_points | 70 | Yes — slowly |
| max_open_legs | 4 | Yes — slowly |
| max_daily_loss | ₹12,000 | Yes — slowly |

**Compared against:** Precision (same entry, different management)

---

### 5. Reducer
> *"Does cutting size on an adverse move and re-entering at better IV beat holding through?"*

Same high-confidence entry as Precision. When the index moves ~70 points adversely, closes one position entirely, then waits for the next exhaustion signal to re-enter at the new ATM.

| Parameter | Starting Value | Evolvable? |
|-----------|---------------|-----------|
| Entry type | Momentum exhaustion | No |
| Management style | Cut + Re-enter | No |
| min_probability | 0.70 | Yes — slowly |
| max_daily_trades | 2 initial + 2 re-entries | Yes — slowly |
| cut_trigger_points | 70 | Yes — slowly |
| reentry_min_probability | 0.65 | Yes — slowly |
| max_daily_loss | ₹10,000 | Yes — slowly |

**Compared against:** Precision and Adjuster (same entry, different management)

---

### 6. Blitz
> *"Does maximum frequency + active management beat selective + passive?"*

Low entry threshold (like Scanner) combined with rolling management (like Adjuster). The "do everything, do it often" hypothesis — the opposite end of the spectrum from Precision.

| Parameter | Starting Value | Evolvable? |
|-----------|---------------|-----------|
| Entry type | Any signal (momentum + fallback) | No |
| Management style | Roll | No |
| min_probability | 0.50 | Yes — slowly |
| max_daily_trades | 5 | Yes — slowly |
| roll_trigger_points | 70 | Yes — slowly |
| max_open_legs | 4 | Yes — slowly |
| max_daily_loss | ₹15,000 | Yes — slowly |

**Compared against:** Precision (selective + passive) and Scanner (same entry, different management)

---

### 7. Levelhead *(Phase 2 — not active until S/R engine is built)*
> *"Does entering at objective support/resistance levels add independent edge?"*

Enters only when the index is at a well-defined, objectively identified S/R level (previous week high/low, monthly pivot, volume POC). Uses Reducer-style management.

| Parameter | Starting Value | Evolvable? |
|-----------|---------------|-----------|
| Entry type | S/R-anchored | No |
| Management style | Cut + Re-enter | No |
| sr_proximity_points | 20 | Yes — slowly |
| sr_strength_threshold | 0.65 | Yes — slowly |
| max_daily_trades | 2 | Yes — slowly |
| cut_trigger_points | 70 | Yes — slowly |

**Compared against:** Precision (same management style, different entry signal type)

**Prerequisite:** S/R detection engine with strength scoring must be built and validated before this personality runs.

---


## Learning Personalities (8–10)

These three personalities simulate human traders with different learning speeds. They are not controlled experiments — they are open-ended adaptive systems.

**All three start from identical Clockwork parameters:**
```
Entry:          Fixed 9:17 AM (time-based, like Clockwork)
Management:     Hold to SL / TSL / EOD
min_probability: N/A
max_daily_trades: 1
max_daily_loss:  ₹5,000
```

They evolve from this baseline. After weeks and months, they will look increasingly different from each other and from Clockwork. Their divergence is the research output.

### What Learning Personalities Can Change

Unlike reference personalities, learning personalities can change **anything** including entry type and management style — given strong enough evidence. This is what makes them a true human learning simulation.

| Category | Can change? | Notes |
|----------|------------|-------|
| min_probability | Yes | First parameter likely to evolve |
| max_daily_trades | Yes | — |
| entry_delay_secs | Yes | — |
| max_daily_loss | Yes | — |
| roll_trigger / cut_trigger | Yes | After they adopt a management style |
| **entry_type** | Yes | With strong evidence (e.g., repeated loss on fixed-time entry → try signal-based) |
| **management_style** | Yes | With strong evidence (e.g., repeated large losses → try rolling or cutting) |

The difference from reference personalities: there are no identity locks. A Learning personality that repeatedly observes Adjuster outperforming on TRENDING days may eventually adopt rolling as its management style. A human trader watching someone else consistently win would do the same.

---

### Change Behavior — Mechanical Definition

What "conservative/medium/aggressive" means in change behavior:

| Dimension | Conservative Learner | Medium Learner | Aggressive Learner |
|-----------|---------------------|---------------|--------------------|
| Min samples before any change | 30 | 15 | 5 |
| Parameters changed per cycle | 1 (worst only) | 2 | 3+ |
| Max change size per parameter | ±3% | ±6% | ±10% |
| Cooldown between change cycles | 14 days | 7 days | 3 days |
| Evidence confidence threshold | p < 0.05 | p < 0.15 | p < 0.30 |
| Identity change (entry/mgmt style) | After 60+ samples + p < 0.01 | After 30 samples + p < 0.05 | After 15 samples + p < 0.10 |
| Reverts a bad change? | Yes — quickly (3 days) | Yes — slowly (10 days) | Rarely (only on severe loss) |

---

### 8. Conservative Learner
> *"What configuration does a very slow, evidence-demanding trader converge to?"*

Changes parameters rarely and only under overwhelming evidence. Needs 30 samples before acting. Changes only the single worst-performing parameter, by the smallest allowable amount. Reverts quickly if the change causes harm.

- Likely to look similar to Clockwork for the first 2–3 months
- May never change entry_type or management_style — requires 60+ samples at p < 0.01
- Expected behavior: stable, low-drift, converges slowly toward a defensible configuration
- Risk: may lag too far behind genuine regime changes

---

### 9. Medium Learner
> *"What configuration does a balanced, moderately adaptive trader converge to?"*

Changes parameters when a pattern becomes reasonably clear. Needs 15 samples, adjusts 2 parameters per cycle, moderate change size. Identity changes require 30 samples with reasonable confidence.

- Will begin diverging from Clockwork after approximately 3–4 weeks
- Balanced between stability and responsiveness
- Expected behavior: finds a middle ground between over-fitting (Aggressive) and under-fitting (Conservative)
- Most likely to resemble what a thoughtful human trader would arrive at independently

---

### 10. Aggressive Learner
> *"What configuration does a fast-reacting, pattern-chasing trader converge to?"*

Changes parameters quickly on limited evidence. Needs only 5 samples. Adjusts 3+ parameters per cycle, with large step sizes. Rarely reverts. Identity changes are possible after just 15 samples.

- Will diverge from Clockwork within the first week
- Likely to find good configurations faster — but also more likely to overfit noise
- Will look dramatically different from its starting Clockwork baseline after 30 days
- Expected risk: strong performance in the first month, potential blowup when it over-adapts to a regime that ends
- **Most interesting to watch** — this is where you'll see the earliest real results, for better or worse

---


## 5-Day Evolution Example

A concrete walkthrough showing how each personality responds to the same market events.

**Starting parameters (all personalities):**
```
Reference (Precision, Adjuster, Reducer): min_probability=0.70, roll/cut trigger=70pt
Reference (Scanner, Blitz):               min_probability=0.50, max_trades=5
Learning (all three):                     Fixed 9:17 AM entry, Hold, max_trades=1
```

---

### Day 1 — RANGING | VIX 14 | Nifty +0.2%

| Personality | Trades | P&L | vs Clockwork | Notes |
|-------------|--------|-----|-------------|-------|
| Clockwork | 1 | +₹1,840 | baseline | — |
| Precision | 2 | +₹2,950 | **+₹1,110** | Two clean signals, both won |
| Scanner | 4 | +₹3,100 | **+₹1,260** | High frequency worked on ranging day |
| Adjuster | 2 | +₹2,200 | **+₹360** | Roll fired once, cost ₹750 in spread |
| Reducer | 2 | +₹1,400 | **-₹440** | Cut early, market reversed, missed recovery |
| Blitz | 4 | +₹1,950 | **+₹110** | Rolls added cost vs Scanner (same entries) |
| Conservative Learner | 1 | +₹1,840 | =₹0 | Identical to Clockwork. No change possible. |
| Medium Learner | 1 | +₹1,840 | =₹0 | Identical to Clockwork. No change possible. |
| Aggressive Learner | 1 | +₹1,840 | =₹0 | Identical to Clockwork. No change possible. |

**Retrospection flags (queued, not actioned):**
- Reducer underperformed on RANGING day → 1 RANGING sample (needs 10)
- Adjuster roll cost vs hold → 1 RANGING sample (needs 10)

---

### Day 2 — TRENDING_STRONG | VIX 19 | Nifty -1.4%

| Personality | Trades | P&L | vs Clockwork | Notes |
|-------------|--------|-----|-------------|-------|
| Clockwork | 1 | -₹2,200 | baseline | No filter — took the loss |
| Precision | 1 | -₹1,800 | **+₹400** | Skipped one low-confidence signal |
| Scanner | 3 | -₹3,900 | **-₹1,700** | Low bar → entered into a trending move |
| Adjuster | 2 | -₹4,100 | **-₹1,900** | Rolled into trend twice, compounded losses |
| Reducer | 1 | -₹800 | **+₹1,400** | Cut early, re-entered at better IV |
| Blitz | 3 | -₹5,200 | **-₹3,000** | Worst day: low threshold + rolling into trend |
| Conservative Learner | 1 | -₹2,200 | =₹0 | Still identical to Clockwork |
| Medium Learner | 1 | -₹2,200 | =₹0 | Still identical to Clockwork |
| Aggressive Learner | 1 | -₹2,200 | =₹0 | 2 days of data. Needs 5 to act. |

**Retrospection flags (queued):**
- Adjuster: rolling badly hurt on TRENDING day → 1 TRENDING sample (needs 10)
- Reducer: outperformed on TRENDING day → 1 TRENDING sample (needs 10)
- Scanner: high frequency hurt on TRENDING day → 1 sample (needs 10)
- Blitz: worst result of all → 1 sample

---

### Day 3 — RANGING | VIX 13 | Nifty -0.1%

Similar to Day 1. Precision, Scanner, Clockwork all profitable. Adjuster marginal. Reducer underperforms again.

**Retrospection flags:**
- Reducer: RANGING underperformance now 2 samples (needs 10 — still queued)
- Adjuster roll cost: 2 RANGING samples (still queued)
- Aggressive Learner: 3 total days. Needs 5 to act. Still watching.

---

### Day 4 — EVENT_DAY | VIX 22 | RBI Policy

Reference personalities with event gates skip. Clockwork and Learning personalities have no event gate yet — they enter and take the hit.

| Personality | Trades | P&L | Notes |
|-------------|--------|-----|-------|
| Clockwork | 1 | -₹3,100 | No event gate — entered |
| Precision | 0 | ₹0 | Event gate triggered |
| Scanner | 0 | ₹0 | Event gate triggered |
| Adjuster | 0 | ₹0 | Event gate triggered |
| Reducer | 0 | ₹0 | Event gate triggered |
| Blitz | 0 | ₹0 | Event gate triggered |
| Conservative Learner | 1 | -₹3,100 | No event gate learned yet |
| Medium Learner | 1 | -₹3,100 | No event gate learned yet |
| Aggressive Learner | 1 | -₹3,100 | 4 days data now. Needs 1 more day to act. |

**Retrospection flags:**
- Aggressive Learner: EVENT_DAY produced -₹3,100 loss. Pattern flagged. Will act next cycle.

---

### Day 5 — RANGING | VIX 14 | Nifty +0.3%

**Aggressive Learner hits 5-sample threshold. Acts on two suggestions simultaneously:**

```
Change 1: Add event day gate (4 days data, EVENT_DAY loss = -₹3,100)
          block_event_days → true

Change 2: Reduce max_daily_loss (Day 4 loss exceeded threshold)
          max_daily_loss: ₹5,000 → ₹3,500
```

Aggressive Learner is now a different strategy from Clockwork. It will not enter on event days. It has tighter loss limits.

Medium Learner: 5 days data, needs 15. No changes yet.

Conservative Learner: 5 days data, needs 30. No changes yet.

Reference personalities: No rule thresholds met (most need 10–30 samples). All parameters unchanged. Suggestions accumulating.

---

### End of Day 5 — Parameter State

```
Personality             Entry Type    Mgmt Style   min_probability   Event Gate   max_daily_loss
────────────────────────────────────────────────────────────────────────────────────────────────
Clockwork               Fixed 9:17    Hold          —                 No           ₹5,000  (frozen)
Precision               Momentum      Hold          0.70              Yes          ₹8,000  (unchanged)
Scanner                 Any signal    Hold          0.50              Yes          ₹10,000 (unchanged)
Adjuster                Momentum      Roll          0.70              Yes          ₹12,000 (unchanged)
Reducer                 Momentum      Cut/Re        0.70              Yes          ₹10,000 (unchanged)
Blitz                   Any signal    Roll          0.50              Yes          ₹15,000 (unchanged)
────────────────────────────────────────────────────────────────────────────────────────────────
Conservative Learner    Fixed 9:17    Hold          —                 No           ₹5,000  (unchanged)
Medium Learner          Fixed 9:17    Hold          —                 No           ₹5,000  (unchanged)
Aggressive Learner      Fixed 9:17    Hold          —                 YES ← new    ₹3,500  ← new
```

**After just 5 days, Aggressive Learner has already diverged.** After 30 days it may look completely unlike Clockwork. After 90 days it may have found a strong configuration — or it may have overfit to patterns that don't hold.

---


## Full Summary Table — All 10 Personalities

| # | Name | Group | Entry Type | Mgmt Style | Identity Frozen? | Params Evolve? | Compared Against |
|---|------|-------|-----------|-----------|-----------------|----------------|-----------------|
| 1 | **Clockwork** | Reference | Fixed time | Hold | Yes | **Never** | — (benchmark) |
| 2 | **Precision** | Reference | Momentum (70%+) | Hold | Yes | Slowly | Clockwork |
| 3 | **Scanner** | Reference | Any signal (50%+) | Hold | Yes | Slowly | Precision |
| 4 | **Adjuster** | Reference | Momentum (70%+) | Roll | Yes | Slowly | Precision |
| 5 | **Reducer** | Reference | Momentum (70%+) | Cut+Re-enter | Yes | Slowly | Precision + Adjuster |
| 6 | **Blitz** | Reference | Any signal (50%+) | Roll | Yes | Slowly | Precision + Scanner |
| 7 | **Levelhead** | Reference | S/R-anchored | Cut+Re-enter | Yes | Slowly | Precision *(Phase 2)* |
| 8 | **Conservative Learner** | Learning | Starts: Fixed time | Starts: Hold | No | Very slowly | Clockwork + all Reference |
| 9 | **Medium Learner** | Learning | Starts: Fixed time | Starts: Hold | No | Moderately | Clockwork + all Reference |
| 10 | **Aggressive Learner** | Learning | Starts: Fixed time | Starts: Hold | No | Quickly | Clockwork + all Reference |

---


## Research Questions — What the Full System Answers

**From Reference personalities:**
- Does momentum exhaustion signal beat fixed-time entry? *(Precision vs Clockwork)*
- Does entry selectivity beat entry frequency? *(Precision vs Scanner)*
- Does rolling management beat holding? *(Adjuster vs Precision)*
- Does cut-and-re-enter beat holding and rolling? *(Reducer vs Precision, Adjuster)*
- Does high-frequency + active management beat selective + passive? *(Blitz vs Precision)*
- Does S/R-anchored entry add independent edge? *(Levelhead vs Precision — Phase 2)*
- Which regime does each strategy work best in? *(regime-tagged retrospection across all)*

**From Learning personalities:**
- Does adaptation speed matter? *(Conservative vs Medium vs Aggressive Learner)*
- Where does a fast-adapting trader converge after 3 months? *(Aggressive Learner endpoint)*
- Does rapid adaptation eventually overfit and collapse? *(Aggressive Learner long-run)*
- Is slow, evidence-demanding adaptation better than no adaptation? *(Conservative Learner vs Clockwork)*
- What's the optimal adaptation speed for Indian weekly options? *(all three Learners compared)*

**Combined:**
- Does the best Reference personality outperform the best Learning personality?
- Does a system-discovered configuration (via Learning) outperform a human-designed configuration (Reference)?
- At what point, if any, do Learning personalities converge toward Reference personality configurations independently?

---

*Architecture and database schema: [docs/architecture.md](./architecture.md).*
