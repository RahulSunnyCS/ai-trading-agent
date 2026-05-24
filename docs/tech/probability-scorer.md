# The Probability Scorer in Full

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series. This
> expands §5 of [Pipeline Internals](./pipeline-internals.md). Source:
> `src/signals/probability-scorer.ts`.

`scoreProbability()` turns a raw exhaustion signal into a bounded probability
and a confidence tier. It is a **pure function** — no I/O, all inputs
pre-fetched — so scoring one signal for all 10 personalities costs zero extra
Redis/DB calls and is exhaustively unit-testable.

## The pipeline of a score

```
signalType ─┬─ SCHEDULED ──────────────► fixed 0.60, MEDIUM, all-zero breakdown (short-circuit)
            │
            └─ MOMENTUM_EXHAUSTION / PULLBACK
                   │
            base probability
                   │  + Σ(9 independent adjustments)
                   ▼
            clamp to [0.0, 1.0]  ──►  confidenceTier
```

### Base probability (before adjustments)
| signalType | base | notes |
|---|---|---|
| `SCHEDULED` | **0.60** | short-circuits entirely — no adjustments, tier hardcoded MEDIUM. Time-triggered entries aren't signal-quality-driven. |
| `MOMENTUM_EXHAUSTION` | `rawExhaustionScore × 0.4 + 0.35` | linear map: score 0 → **0.35**, score 1 → **0.75** |
| `PULLBACK` | **0.60** fixed | then runs the same 9 adjustments as momentum |

## The 9 adjustment factors

Each factor is independent (no cross-interactions — deliberate, for
interpretability) and returns a small additive delta. Note **only India VIX
actually calls `clamp(±0.10)`**; the other eight are step functions whose
magnitudes are bounded by construction.

| # | Key | Input used | Logic | Range |
|---|---|---|---|---|
| 1 | `india_vix` | `indiaVix` (level) | ≤15 → +0.02; 15–25 → linear `-(vix-15)×0.005`; >25 → -0.05; then `clamp(±0.10)` | +0.02 … -0.05 |
| 2 | `us_vix` | `macro.us_vix.value` (level) | <15 → +0.02; ≤20 → 0; ≤30 → -0.04; >30 → -0.08 | +0.02 … -0.08 |
| 3 | `sp500` | `macro.sp500.change_pct` | <-1.5% → -0.06; <-0.5% → -0.03; ≤1.5% → 0; >1.5% → +0.03 | +0.03 … -0.06 |
| 4 | `dax` | `macro.dax.change_pct` | <-1.5% → -0.04; <-0.5% → -0.02; ≤1.5% → 0; >1.5% → +0.02 | +0.02 … -0.04 |
| 5 | `crude_oil` | `abs(change_pct)` | >3% → -0.05; ≥1.5% → -0.02; else 0 | 0 … -0.05 |
| 6 | `gold` | `change_pct` | >2% → -0.05; >1% → -0.03; else 0 | 0 … -0.05 |
| 7 | `oi_change` | `oiChangePct` | >5% → +0.04; ≥2% → +0.02; -2…2% → 0; ≥-5% → -0.02; <-5% → -0.04 | +0.04 … -0.04 |
| 8 | `time_of_day` | IST hh:mm | 09:20–09:45 → +0.05; 14:00–15:00 → -0.04; else 0 | +0.05 … -0.04 |
| 9 | `day_of_week` | IST weekday | Monday → -0.03; Friday → -0.03; else 0 | 0 … -0.03 |

### The reasoning behind each factor
- **india_vix / us_vix** — higher fear ⇒ premium decay (the basis of these
  trades) is less predictable ⇒ penalty. Mild boost when calm.
- **sp500 / dax** — global risk appetite spilling into Nifty. Falls penalise
  (gap-open / sentiment risk); strong rallies give a small boost. DAX is
  weaker-weighted than S&P (lower direct correlation, afternoon relevance).
- **crude_oil** — uses **absolute** move: India is a major oil importer, so a
  big move *in either direction* is macro disruption ⇒ penalty only.
- **gold** — only **rising** gold penalises (flight-to-safety / risk-off). Gold
  flat or falling is *not* treated as a positive signal.
- **oi_change** — OI buildup from the 9:15 open confirms genuine participation
  (boost); unwinding means participants are exiting (penalty).
- **time_of_day** — post-open premium has more room to decay (boost); the
  14:00–15:00 close window is erratic with squaring/short-covering (penalty).
- **day_of_week** — Monday (unabsorbed weekend gaps) and Friday (weekly-expiry
  rollover distortions) both -0.03.

## Final clamp & confidence tier

```ts
adjustedProbability = clamp(base + Σ adjustments, 0.0, 1.0);

if (adjustedProbability >= 0.70) tier = 'HIGH';
else if (adjustedProbability >= 0.50) tier = 'MEDIUM';
else tier = 'LOW';
```

So the tier boundaries are simple thresholds: **HIGH ≥ 0.70**, **0.50 ≤ MEDIUM
< 0.70**, **LOW < 0.50**. (`SCHEDULED` is fixed at 0.60 ⇒ always MEDIUM.) These
align with the personalities' default `min_probability` (e.g. 0.70 for
Precision) — a HIGH-tier signal is roughly the threshold a conservative
personality wants.

## `adjustmentBreakdown` — always 9 keys

The returned `adjustmentBreakdown` always has all 9 keys (0 when a factor didn't
apply), built from `zeroBreakdown()`. Consumers can sum or render it without
null-checking. It's persisted to `straddle_signals.adjustment_breakdown` as JSON
for later calibration analysis.

## Insights worth noting

1. **The macro overlay is deliberately asymmetric — penalty-heavy.** Summing the
   per-factor extremes, the maximum *positive* total is about **+0.18** while the
   maximum *negative* total is about **-0.44**. Risk-off conditions can gut a
   signal far more than calm conditions can lift it — a conservative bias that
   suits a premium-selling strategy that loses badly in turbulent markets.
2. **Mixed input semantics per factor.** `india_vix`/`us_vix` read a *level*;
   `sp500`/`dax`/`gold` read a *signed change*; `crude_oil` reads an *absolute*
   change. Direction handling is intentional per factor, not uniform.
3. **Only one factor is `clamp`-capped.** The rest are bounded by their if-ladder
   shape. The comments describe all nine as "capped," but the explicit
   `clamp(±0.10)` guard exists only on India VIX — the others can't exceed their
   discrete steps anyway.
4. **`null` is uniformly neutral.** Any missing input (VIX feed down, no OI,
   absent macro field) contributes **0**, never a penalty. Missing data must
   never silently bias strategy selection — the same philosophy as the filter's
   VIX-null pass.
5. **A latent edge case: base can exceed 0.75.** `rawExhaustionScore` is
   documented here as 0–1, but the peak-detection engine produces it
   **unclamped** (it can exceed 1). A score >1 would push the base above 0.75
   before adjustments. The final `clamp(…, 0, 1)` keeps the output valid, but the
   input contract and producer disagree — worth tightening if scores are ever
   calibrated.
6. **Not calibrated yet.** Per the code and `technical.md`, these are **relative
   rankings, not true probabilities**. Brier scores
   (`straddle_signals.signal_brier_score` / retrospection) track calibration
   over time; the weights here are hand-chosen, not fitted.

## Two clocks for time extraction
`getISTComponents` uses `toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })`
for hour/minute (IANA zone handles the "24:00" wraparound), but a raw
`+5:30` offset + `getUTCDay()` for the weekday (avoids fragile locale day-name
parsing; IST has no DST so the fixed offset is always correct).

## Related code
- `src/signals/probability-scorer.ts` — this function.
- `src/signals/peak-detection-engine.ts` — produces `rawExhaustionScore` and
  calls the scorer.
- `src/ingestion/global-macro-feed.ts` — `MacroContext` source.
- `src/signals/personality-filter.ts` — Stage 4 compares `adjustedProbability`
  to `min_probability`.
