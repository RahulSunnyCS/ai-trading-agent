# Personalities — Full Reference

## Overview

The system runs **10 personalities in parallel**. They fall into two distinct groups with different purposes:

| Group | Count | Purpose | Parameters |
|-------|-------|---------|-----------|
| **Reference** | 7 | Controlled experiments — isolate one variable at a time | Light tuning allowed (except Clockwork: entirely frozen) |
| **Learning** | 3 | Human learning simulation — test how fast to adapt | Full parameter evolution at different speeds |

**Reference personalities** answer: *"Which strategy configuration works, and in which regime?"*

**Learning personalities** answer: *"How fast should a strategy adapt when evidence comes in?"*

These are complementary questions. Neither group alone answers both.

---

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

*For the system architecture and database schema behind these personalities, see [TECHNICAL_REFERENCE.md](./TECHNICAL_REFERENCE.md).*
*For product overview and strategy context, see [PRODUCT_OVERVIEW.md](./PRODUCT_OVERVIEW.md).*
