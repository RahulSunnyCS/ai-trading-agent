# Value-Enhancement Strategy — AI Trading Agent

> **Status:** Advisory / strategy document. No code changes are implied by this file
> itself — it is a decision aid. Every recommendation is grounded in the current
> codebase and PRDs, and Part 7 sequences the work so you can pick what to build.
>
> **Source material reviewed:** `PRODUCT_OVERVIEW.md`, `PERSONALITIES.md`, `ROADMAP.md`,
> `TECHNICAL_REFERENCE.md`; strategy code (`src/signals/probability-scorer.ts`,
> `peak-detection-engine.ts`, `personality-filter.ts`, the three management styles);
> the retrospection + evolution engine (`src/retrospection/*`, `src/trading/regime-tagging.ts`,
> `src/backtesting/backtest-runner.ts`, `backtest-report.ts`); and the full React
> dashboard (`src/frontend/*`).
>
> **Last updated:** 2026-05-29

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Part 0 — The "more parameters" hypothesis is backwards for trading](#part-0)
3. [Part 1 — Do you need RAG?](#part-1)
4. [Part 2 — The best way to analyze history](#part-2)
5. [Part 3 — Per-personality daily parameter adjustment](#part-3)
6. [Part 4 — The four value workstreams](#part-4)
7. [Part 5 — Per-tab dashboard value analysis](#part-5)
8. [Part 6 — What NOT to do](#part-6)
9. [Part 7 — Suggested sequencing](#part-7)
10. [Appendix A — Parameter & evolvability reference](#appendix-a)
11. [Appendix B — How to verify each claim](#appendix-b)

---

## Executive Summary

The system is in much better shape than a first read suggests: M1–M4 + M7 are complete,
the retrospection engine, regime tagging, Brier scoring, the backtest runner, and
per-regime metrics are all **implemented**. The opportunity is therefore **not "build more
engine"** — it is **trust, surface, and condition** what already exists.

Five headline conclusions:

1. **More parameters will not make this smarter — it will make it overfit.** Trading is a
   low-data, low-signal, non-stationary domain; the opposite of the regime where LLM
   scaling laws hold. The right "scaling" is more *data* and better *calibration*, not more
   free parameters. (Part 0)
2. **You do not need RAG** in the decision loop, and adding it would damage the
   reproducibility guarantee the research design rests on. A read-only LLM "explain this"
   analyst is the only safe use, and only later. (Part 1)
3. **Three gaps block trustworthy analysis:** probabilities are uncalibrated; evolution
   only tunes `min_probability`; and the best analytics are computed but never shown.
   (Part 2)
4. **"Daily adjustment" should mean regime-conditional *selection* from pre-validated
   parameter sets — not daily re-tuning.** (Part 3)
5. **The fastest commercial wins are surfacing already-computed data** on the dashboard.
   (Parts 4–5)

---

<a name="part-0"></a>
## Part 0 — The "more parameters → more efficiency" hypothesis is backwards for trading

> *This is the most important section. The intuition is natural — but the analogy from
> LLMs does not carry, and the project's own PRD already encodes why.*

### Why scaling laws work for LLMs

An LLM improves with more parameters because it is paired with:

- **(a) effectively unlimited training data**,
- **(b) a stationary target** (English grammar in 2020 ≈ English grammar in 2024), and
- **(c) a very high signal-to-noise ratio** (the next token is genuinely predictable).

More parameters let the model absorb more of a real, stable, data-rich signal.

### Why that breaks for index-options trading — three structural reasons

1. **Data is scarce, not unlimited.** ~2–3 signals/day × ~250 trading days ≈
   **500–750 samples/year per personality**. Condition on regime (4 buckets) and you have
   **~100–200 samples per regime per year**. `PRODUCT_OVERVIEW.md` (§Complexity Budget)
   states each entry×management combination "needs 30+ trades for meaningful data" and that
   running everything at once "produces noise, not signal."
2. **The target is non-stationary.** Edges decay; the market adapts. There is no fixed
   function to converge onto, so added capacity mostly fits *yesterday's noise*.
3. **Signal-to-noise is brutally low.** Index options are near-efficient; most daily P&L
   variance is irreducible noise.

### The consequence: the bias–variance tradeoff

In a low-data, low-signal, non-stationary domain, **every extra free parameter raises
variance faster than it lowers bias.** The result is the classic trap: brilliant in
backtest, loses money live. The project already lists this as **Known Risk #2
(Overfitting)** and defines **falsification / stop criteria** in `PRODUCT_OVERVIEW.md`:

- *"Parameter variance > 40% month-over-month"* → stop.
- *"No personality beats random entry for 3 consecutive months"* → stop.
- *"Peak detection accuracy < 45% after 50 samples"* → stop.

Adding free parameters drives the system straight at those tripwires.

### What *does* transfer from ML/LLM work — the real way to add intelligence

| LLM lesson | Trading translation (the right move) |
|---|---|
| More **data** beats more parameters | Scale **underlyings + history**: backfill more years, add BankNifty/Sensex (M5). Same parameters, far more samples → genuinely tighter estimates. |
| **Regularization** prevents overfit | Keep free parameters *few*; make each earn changes via significance tests + cooldowns (partly built already). |
| **Ensembling** beats one big model | The **10 personalities are already an ensemble** — the correct architecture. Add value by improving the ensemble's *combination/selection*, not by inflating each member. |
| **Calibration** makes outputs trustworthy | Calibrate `adjusted_probability` (not calibrated today — Part 2). Higher-leverage than any new parameter. |
| **Hierarchical / shrinkage** models share strength | Bayesian hierarchical estimation (regime as a level) lets a 12-sample regime *borrow* from the pool — the statistically correct way to "learn more" without overfitting (M5/T-46). |
| Better **features** beat more weights | Add *context/conditioning* (regime, term structure, OI), not free scalars. Condition existing parameters on regime instead of inventing new ones. |

> **Bottom line:** the path to a smarter system is **more data, better calibration,
> regime-conditional parameter *selection*, hierarchical shrinkage, and a better ensemble
> combiner** — not more free parameters. *"Fewer, well-validated, context-aware
> parameters"* is the trading analogue of the LLM scaling win.

---

<a name="part-1"></a>
## Part 1 — Do you need RAG?

**Short answer: No for the decision loop; optionally a thin, read-only LLM "analyst" for
the human operator, built later.**

### For the core quant loop (analyzing history, tuning parameters) — No, and it would hurt

- Your history is **structured, numeric, time-series** in TimescaleDB (`paper_trades`,
  `retrospection_results`, `daily_regime_tags`, `straddle_signals`). The right tools are
  **SQL + statistics + classical ML** (kNN, clustering, hierarchical models) — *not* text
  embeddings. Vector search over numeric feature vectors is just kNN with extra latency and
  infrastructure.
- RAG introduces **non-determinism, latency, and hallucination** into a domain whose crown
  jewel is **deterministic golden replay** (`ROADMAP.md` M0.5: *"a finding you cannot
  reproduce is not a finding"*). An LLM in the parameter-decision path would **destroy** the
  reproducibility guarantee the whole research design rests on.

### Don't confuse "retrieval of similar days" with RAG

*"Find the 20 most similar past VOLATILE_REVERTING days and show their outcomes"* is
genuinely valuable — but it is a **kNN query over a numeric feature vector** (regime
features, VIX, ROC, time-of-day), done in SQL / `numpy`. It needs **no vector DB and no
LLM**. Build *that* and call it **"analog days,"** not RAG.

### Where an LLM layer *can* help — strictly secondary, strictly out of the decision path

1. **Natural-language research analyst over the retrospection corpus.** The operator asks
   *"Why did Adjuster underperform on event days last quarter?"* and an LLM summarizes
   `retrospection_results` + `personality_audit_log` into prose. A **reporting/explanation
   aid**, never a decision-maker — read-only, cites the rows, never writes parameters.
2. **Unstructured-context features** — embedding RBI policy text / news as a *macro
   feature* for the probability scorer. This is feature engineering, lower priority than
   calibrating existing features, and must be validated before touching a live score.

> **Verdict:** Skip RAG for now. If you want an LLM, add a sandboxed read-only "Explain this
> result" analyst on the dashboard *after* the core analytics (Part 2) exist.

---

<a name="part-2"></a>
## Part 2 — The best way to analyze history (and the gaps blocking it)

**The data infrastructure is substantially built**: regime tagging
(`regime-tagging.ts`, causal 14:30 IST cutoff), Brier score (`brier-score.ts`),
Beat-Clockwork delta, management effectiveness, the backtest runner with
train/test/**holdout** splits, and per-regime metrics in `backtest-report.ts`. The analysis
problem is **three specific gaps**, not a missing engine.

### Gap A — Probabilities are not calibrated *(highest-leverage fix in the project)*

`probability-scorer.ts` is explicit: *"Probability scores are NOT empirically calibrated
yet — relative rankings, not absolute probabilities."* Every personality gates on
`min_probability` (e.g. 0.70). If "0.70" doesn't actually mean "wins ~70% of the time," the
entire entry filter **and** the evolution loop are tuning against a meaningless number.

**Fix:** reliability diagrams (predicted vs actual win-rate buckets) + **isotonic or Platt
scaling** (the deferred **T-52**). Calibration turns the Brier score you already compute
into an actionable trust signal.

### Gap B — Evolution only tunes `min_probability`, on a crude rule

`evolution-engine.ts` implements *one* rule: `winRate < 0.40 → +0.05`,
`winRate > 0.70 → −0.03`, 7-day cooldown, 8pp integrity cap. But `PERSONALITIES.md`
*documents* a far richer design: per-learning-speed **p-value thresholds**
(0.05 / 0.15 / 0.30), **evolving roll/cut triggers**, **auto-revert** of harmful changes,
and **identity changes** for Learners. **The documented design is the analysis you want;
the implementation is a fraction of it.**

### Gap C — The analytics are computed but not surfaced

`backtest-report.ts` already produces per-regime Sharpe / drawdown / win-rate per
personality, but the Regimes tab shows only raw enum tags (T-58 UI deferred). The operator
literally cannot see the system's best output.

### The right analytical toolkit (priority order)

1. **Per-regime statistics with significance.** Never compare across regimes (already a
   project rule). Attach a **two-sample t-test / Mann–Whitney U (p < 0.05)** to every
   Beat-Clockwork claim — T-58 plans this for backtests; make it the default lens
   everywhere.
2. **Calibration / reliability diagrams** (Gap A / T-52).
3. **Walk-forward / out-of-sample discipline.** Enforce that *no* tuning ever touches the
   **holdout** split; report holdout performance separately as the only trusted number.
4. **Bayesian hierarchical estimation** (regime nested under personality). Small-sample
   regimes shrink toward the pool — adaptive *and* overfit-resistant. The correct home for
   M5/T-46.
5. **Analog-day retrieval (classical kNN)** — "similar historical days," no RAG.
6. **Falsification dashboard** — actually compute & display the PRD stop-criteria (beats
   random over 3 months, peak-detection accuracy after 50 samples, parameter variance MoM).
   Currently prose, not metrics.

---

<a name="part-3"></a>
## Part 3 — Per-personality daily parameter adjustment (reframed correctly)

Your question — *"what parameters should adjust daily for each personality"* — needs a
split, because **daily re-tuning of learned parameters is the fastest route to
overfitting** (Part 0). Three distinct kinds of "parameter"; only one should move daily.

### (A) Context inputs — read fresh daily, never "learned" *(already correct ✅)*

Regime tag, India VIX, event-day flag, blocked dates, time-of-day. These are *inputs the
strategy conditions on*, not values to tune. The 5-stage filter + portfolio-risk rules
already consume these daily. **Keep as-is.**

### (B) Learned strategy parameters — must evolve SLOWLY, never daily *(keep cooldowns ✅)*

`min_probability`, `roll_trigger_points`, `cut_trigger_points`, `vix_max`,
`max_daily_trades`, `reentry_min_probability`. The cooldowns (3 / 7 / 14 days) and
min-sample gates (5 / 15 / 30) exist precisely to stop daily churn. **Do not make these
daily.**

### (C) The real opportunity — regime-conditional parameter *sets* ("playbooks"), selected daily

Instead of one global `roll_trigger_points = 70`, hold a *validated* value **per regime**
and **select** today's value from today's regime tag. The PRD gives the exact example:
*"on RANGING days, increase roll trigger from 70pt to 90pt."* This is daily *selection from
pre-validated sets*, not daily *tuning* — adaptive without inflating free-parameter count
uncontrollably (each regime value still earns its place via the min-sample + significance
gate).

### Which parameters to make regime-conditional, per personality

(Evolvable params per `PERSONALITIES.md`; the engine currently moves only `min_probability`.)

| Personality | Make regime-conditional (priority) | Rationale |
|---|---|---|
| **Clockwork** | **Nothing — ever.** | Frozen benchmark; `FROZEN_VIOLATION` guard. Do not touch. |
| **Precision** | `min_probability`, `vix_max` | Tighten selectivity in TRENDING / EVENT, relax in RANGING. |
| **Scanner** | `min_probability`, `max_daily_trades` | High-frequency helps in RANGING, hurts in TRENDING (Day-2 example). |
| **Adjuster** | **`roll_trigger_points`** (highest value), `min_probability` | Rolling bleeds in TRENDING — widen/disable there, tighten in RANGING. The PRD's headline example. |
| **Reducer** | **`cut_trigger_points`**, `reentry_min_probability` | Cutting wins in TRENDING, loses in RANGING — gate the cut by regime. |
| **Blitz** | `roll_trigger_points`, `min_probability` | Worst-case in TRENDING (Day-2: −₹5,200) — needs the strongest regime gate. |
| **Levelhead** *(Phase 2)* | `sr_proximity_points`, `sr_strength_threshold` | Only after the S/R engine exists (M5). |
| **Learners (3)** | Implement the *documented* learning behavior first | They currently cannot evolve roll/cut/identity at all (Gap B). The headline "smarter learning" work. |

### Guardrails to keep (non-negotiable)

- The **8-percentage-point comparison-integrity cap** on Precision/Adjuster/Reducer
  `min_probability`.
- The **Clockwork frozen guard** (`FROZEN_VIOLATION`).
- The **min-sample + cooldown** gates.
- The **holdout firewall**.

> Regime-conditional sets multiply the number of values being estimated, so the
> significance bar matters **more**, not less. Require a minimum sample **per regime**
> before a regime-specific value may diverge from the global one (shrinkage — Part 2.4).

---

<a name="part-4"></a>
## Part 4 — The four value workstreams (your chosen priorities)

### W1 — Research trustworthiness *(do first; underpins everything)*

1. **Probability calibration (T-52):** reliability diagrams + isotonic/Platt over
   `straddle_signals` ↔ `paper_trades`. Without this, every threshold is fiction.
2. **Significance on every comparison:** t-test / Mann–Whitney on Beat-Clockwork deltas,
   per regime (extend T-58 beyond backtests).
3. **Holdout firewall + walk-forward reporting:** holdout performance is the headline
   number; forbid tuning from seeing it.
4. **Falsification dashboard:** compute & display the PRD stop-criteria as live metrics.

### W2 — Smarter learning / evolution *(the real answer to the "more parameters" idea)*

1. **Close the design-vs-implementation gap (Gap B):** implement the documented
   `PERSONALITIES.md` behavior — per-learning-speed p-value thresholds, **evolving
   roll/cut/vix params** (not just `min_probability`), **auto-revert** of harmful changes,
   **identity changes** for Learners.
2. **Regime-conditional parameter sets (Part 3C):** the highest-value structural change.
3. **Bayesian hierarchical shrinkage (M5/T-46):** adaptive + overfit-resistant; replaces
   the crude win-rate rule with a principled posterior.

### W3 — New signals / strategies *(expands the edge surface — after W1)*

1. **S/R detection engine + Levelhead (M5 / T-43, T-44):** the PRD calls this the *"most
   valuable addition"* with *"genuine edge"* — objective levels (prev-week H/L, monthly
   pivot, volume POC) + strength score.
2. **Multi-index (BankNifty, Sensex — T-45):** the cleanest "more data" lever (Part 0) —
   ~3× samples with the same parameters.
3. **Pullback signal** already exists in the scorer; wire and measure it before adding
   more types. **Resist** the "50/100-pt new straddle" idea as an *entry* (the PRD
   correctly rejects it; it is only safe as Adjuster *management*).

### W4 — Product / commercial polish *(it's a paid SaaS — surface what exists)*

Recurring theme: **the backend already computes far more than the UI shows.** Fastest
commercial wins are *surfacing* existing data, not new computation.

1. **Per-personality P&L + Beat-Clockwork on the Personalities tab** (via
   `/personalities/{id}/performance`).
2. **Evolution approval UI** — the engine writes `proposed_adjustments`; there is no screen
   to review/accept them (T-34/T-41 gap). Core to the product promise.
3. **Shareable experiment-card reports** (export the backtest report; PDF/CSV) — the
   research *output* is the product.
4. **Subscription / credit-balance + invoice** surfacing on Pricing (`/payment/balance`
   exists; UI doesn't show it).

---

<a name="part-5"></a>
## Part 5 — Per-tab dashboard value analysis (all 8 tabs)

**Shell:** grouped sidebar (Trading / Research / Account); single Zustand store (theme
only); charts via Lightweight Charts. Most "missing" items below have **backend data that
already exists** — flagged in the last column.

| Tab | What it shows now | Highest-value additions | Backend exists? |
|---|---|---|---|
| **Live** | NIFTY LTP, sparkline, straddle (WS + REST), feed/auth banner | **Regime background overlay**; show **India VIX** beside straddle; ROC/acceleration bands as a mean-reversion cue; active-signal + confidence-tier ticker | VIX feed + signals exist; regime tag exists |
| **Trades** | Flat log by entry time | **Personality attribution column**; **management style** + **exit time / duration**; date/status/personality **filters**; **pagination/virtualization**; **CSV export** | All fields in `paper_trades`; deferred in `pending.ts` |
| **Personalities** | Config snapshot only | **Live running P&L per personality**; **Beat-Clockwork delta** column; **parameter-evolution history** drilldown; **side-by-side A/B compare**; **approve/reject proposed adjustments** | `/performance` + `personality_audit_log` + `proposed_adjustments` all exist — pure surfacing |
| **P&L** | Cumulative realized (EOD), top-line metrics | **Per-personality breakdown** (stacked area); **unrealized P&L** for opens; **max-drawdown** + **win/loss streaks**; **Sharpe**; date-range / FY presets | Sharpe + drawdown already in `retrospection_results` (migration 010) |
| **Regimes** | Raw enum tags table | **Per-regime stats** (mean return, vol, trade count, Sharpe) — *this is T-58, already computed in `backtest-report.ts`*; **regime-distribution chart**; **click regime → filtered trades**; regime bands over price | **Yes — computed, just not rendered. Highest UI ROI.** |
| **Backfill** | Coverage table | **In-UI "Start backfill"** form; **progress bar + ETA** for running jobs; **one-click gap-fill**; symbol/resolution filters | Backfill runner exists (CLI); needs endpoint + UI |
| **Replay** | CLI docs + coverage list | **Safe server-driven backtest endpoint** + **render results** (equity curve, trade list, regime overlay); one-click dry-run per row; **A/B two runs** | Backtest runner (T-51) exists in-memory; needs safe endpoint |
| **Pricing** | Plan cards + Razorpay checkout | **Current subscription / credit balance** banner; **invoice / purchase history**; GST display (Phase 2) | `/payment/balance` exists; not surfaced |

**Cross-cutting:** trading data lives in per-component hooks, not Zustand — fine while tabs
are gated, but a per-personality live-P&L feed (used by Personalities + P&L) should be
lifted to a shared store. Add **alerting** (threshold / regime-change notifications) as a
cross-tab capability once the analytics exist.

---

<a name="part-6"></a>
## Part 6 — What NOT to do (explicit anti-recommendations)

- ❌ **Don't add free tunable parameters to chase efficiency** (Part 0 — raises variance,
  invites the falsification tripwires).
- ❌ **Don't tune learned parameters daily** (overfitting; respect the cooldowns).
- ❌ **Don't put RAG/LLM in the parameter-decision path** (kills reproducibility).
- ❌ **Don't compare personalities across different regimes** (existing project rule).
- ❌ **Don't touch Clockwork** or relax the 8pp integrity cap / holdout firewall.

---

<a name="part-7"></a>
## Part 7 — Suggested sequencing (highest value / lowest risk first)

1. **Surface what already exists (W4 + Part 5).** Render T-58 per-regime stats on the
   Regimes tab; per-personality P&L + Beat-Clockwork on Personalities; the evolution
   approval UI. *Low risk, immediate visible value, no new modeling.*
2. **Probability calibration (W1.1 / T-52).** Makes every threshold and Brier score
   trustworthy — unblocks all downstream tuning.
3. **Significance + holdout discipline + falsification dashboard (W1.2–4).** Now the
   numbers are believable.
4. **Regime-conditional parameter sets (W2.2 / Part 3C),** starting with Adjuster's
   `roll_trigger_points` — the PRD's flagship example, gated by per-regime significance.
5. **Close the evolution design gap (W2.1):** evolve roll/cut params, auto-revert,
   learning-speed behavior.
6. **More data, not more parameters (W3.2):** BankNifty / Sensex, longer backfill.
7. **Bayesian hierarchical evolution (W2.3 / M5-T-46)** and **S/R engine + Levelhead
   (W3.1 / M5).**
8. *(Optional, last)* **read-only LLM "explain this result" analyst** — only after 1–3 exist.

---

<a name="appendix-a"></a>
## Appendix A — Parameter & evolvability reference

Quick reference for the 10 personalities (from `005_personality_seed.sql` /
`PERSONALITIES.md`). "Evolvable" = the design allows slow evolution; **today the engine
only moves `min_probability`** (Gap B).

| # | Personality | Group | Entry type | Mgmt style | Active | Frozen | Evolvable params (per design) |
|---|---|---|---|---|---|---|---|
| 1 | **Clockwork** | reference | fixed_time | hold | ✓ | ✓ | **None — ever** |
| 2 | **Precision** | reference | momentum_exhaustion | hold | ✓ | | `min_probability`, `max_daily_trades`, `max_daily_loss`, `entry_delay_secs`, `vix_max` |
| 3 | **Scanner** | reference | any_signal | hold | | | `min_probability`, `max_daily_trades`, `max_daily_loss`, `entry_delay_secs`, `vix_max` |
| 4 | **Adjuster** | reference | momentum_exhaustion | roll | ✓ | | `min_probability`, `max_daily_trades`, `roll_trigger_points`, `max_open_legs`, `max_daily_loss` |
| 5 | **Reducer** | reference | momentum_exhaustion | cut_reenter | | | `min_probability`, `cut_trigger_points`, `reentry_min_probability`, `max_daily_trades`, `max_daily_loss` |
| 6 | **Blitz** | reference | any_signal | roll | | | `min_probability`, `max_daily_trades`, `roll_trigger_points`, `max_open_legs`, `max_daily_loss` |
| 7 | **Levelhead** *(Phase 2)* | reference | sr_anchored | cut_reenter | | | `sr_proximity_points`, `sr_strength_threshold`, `cut_trigger_points`, `max_daily_trades` |
| 8 | **Conservative Learner** | learning | fixed_time→* | hold→* | | | Anything (incl. entry/mgmt identity) — min 30 samples, ±3%, 14d cooldown, p<0.05 |
| 9 | **Medium Learner** | learning | fixed_time→* | hold→* | | | Anything — min 15 samples, ±6%, 7d cooldown, p<0.15 |
| 10 | **Aggressive Learner** | learning | fixed_time→* | hold→* | | | Anything — min 5 samples, ±10%, 3d cooldown, p<0.30 |

**Probability scorer (`probability-scorer.ts`):** base by signal type
(MOMENTUM_EXHAUSTION = `score·0.4 + 0.35`; SCHEDULED/PULLBACK = fixed 0.60) plus **9
independent macro adjustments** (india_vix, us_vix, sp500, dax, crude_oil, gold, oi_change,
time_of_day, day_of_week), summed and clamped to [0,1]. **Not empirically calibrated** —
this is Gap A.

---

<a name="appendix-b"></a>
## Appendix B — How to verify each claim (advisory document, so check, don't trust)

- **Calibration gap (A):** plot a reliability diagram from existing `straddle_signals` ↔
  `paper_trades` joins — if the 0.70 bucket doesn't win ~70%, Gap A is confirmed.
- **Evolution gap (B):** read `src/retrospection/evolution-engine.ts` (single
  `min_probability` win-rate rule) against `PERSONALITIES.md` §"Change Behavior" (full
  p-value / identity-change / auto-revert design) — the divergence is the work.
- **"Computed but not shown" gap (C):** compare `RegimeMetrics[]` in
  `src/backtesting/backtest-report.ts` (computes per-regime Sharpe/drawdown) against
  `src/frontend/components/RegimeView.tsx` (renders only tags) — confirms the T-58
  surfacing opportunity.
- **Overfitting tripwires:** see `PRODUCT_OVERVIEW.md` §"When Should We Stop?" — the
  falsification criteria are stated as prose; no code computes them yet.

---

*Companion documents: product/strategy → `PRODUCT_OVERVIEW.md`; personality design →
`PERSONALITIES.md`; architecture/schema → `TECHNICAL_REFERENCE.md`; delivery status →
`ROADMAP.md`.*
