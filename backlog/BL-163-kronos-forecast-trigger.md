# BL-163 — Kronos hour-ahead forecast as an intraday trigger (zero-shot, pre-registered)

| | |
|---|---|
| **Priority** | P3 — speculative: a generic candlestick model trained on no NSE data, tested against a framework that has already killed every market-state variable it was given (BL-081, BL-083's two thin leads); cheap to run, and the month's work is Momentum (BL-010) |
| **Status** | Planned (pre-registration drafted; nothing run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-25 |
| **Depends on** | BL-120 (the rule tester: events vs placebo vs random time, charges, the ledger and the locked confirmation period), BL-083 (the three templates and the event-study design), the 1-minute NIFTY lake |
| **TODO.md row** | — (filled in when started) |

## Context

Kronos (`github.com/shiyu-coder/Kronos`, MIT, AAAI 2026) is a decoder-only model over OHLCV "K-line" tokens,
pre-trained on bars from 45 exchanges. Given up to 512 bars it returns the next `pred_len` bars (open, high,
low, close, volume), sampled (`T`, `top_p`, `sample_count`). Weights for Kronos-mini (4.1M), -small (24.7M)
and -base (102.3M) are on Hugging Face (`NeoQuasar/Kronos-*`); -large is not released. Inference on a laptop
CPU is fine at this size. It came up in a 24 Oct 2026 list of fast-growing finance repos, which the owner
asked about; the code has not changed since April 2026.

Why it might fit here, and only here: the rotation's open question has always been *entry timing*, not
another weighting of the fixed grid (BL-083's framing). The repo already has the apparatus for exactly this
test and nothing else needs building to use it:

- the three live templates (Widesl, Dir, Buy) simulated from any minute by the legwise engine
  (`rotation/triggers.py`, `ruletest/sim.py`);
- the event study with a time-matched placebo and a random-time control, charges applied on read, every
  test counted in a ledger, and a confirmation period locked until `obt rule reveal` (`ruletest/study.py`,
  BL-120);
- 1-minute NIFTY bars from 2015 and NIFTY option bars from 2022-01 in the lake.

What the rule tester cannot do today is read an *external* feature: a rule's WHEN is `expr.py`'s grammar over
the index's own bars. A Kronos forecast would enter as a cached per-(session, stamp) feature, the way the
ATM-straddle feature does (`ruletest/frame.py`), built strictly from bars stamped ≤ the stamp.

**The look-ahead problem specific to a pre-trained model.** The model's pre-training data is not ours to
inspect. If NSE bars were in it (45 exchanges; the paper does not list them in the README), then any test
day inside the pre-training window is not zero-shot: the model may have *seen* that day. So the only clean
period is after the weights were published. The small/base weights appeared with the paper (arXiv
2025-08-02; fine-tuning scripts 2025-08-17). This item therefore treats sessions from **2025-08-18** as the
clean window (≈ 285 NIFTY sessions to 2026-10-08, then forward) and anything earlier as "possibly in
training", reported apart and never used for a verdict. Phase 1's first task is to record the weights'
Hugging Face commit hash and date, and the paper's stated data cut-off, in this item's Log.

The prior is low and should be said: generic time-series foundation models have not shown a repeatable
intraday edge out of sample on a single index in the public literature; and the repo's own hourly
market-state study (BL-081) and the four hand triggers (BL-083) found nothing that survived the 2022–24
confirmation set. A test costs about a day of work and an hour or two of CPU, so it is worth a single
pre-registered look, not a programme.

## Goal

A recorded answer, from the clean window and forward days only: does Kronos-small's zero-shot forecast of
the next hour carry information the live templates can use at the forecast minute, against the same
template entered at the same minute on days without the signal, after charges? Pass, kill or inconclusive,
logged here; a page added under `research/options/common/` when the verdict is recorded.

## Out of scope

- Fine-tuning on NSE data (a different item with its own train / validation / test split; it would also
  make the look-ahead argument above much harder).
- Any live use, Telegram message, journal entry or dashboard surface before the verdict.
- Kronos as a *ranking* criterion for the 09:16 pick (the pick is recorded before the open, when the model
  has only yesterday's bars; a different test).
- Weekly or daily forecasts for Momentum (a different item; see Open questions).
- Order placement (the repo places none).

## Plan

### Phase 0 — Pre-register
Committed before any run. A rule is never edited after a run: a new, dated rule supersedes it with a logged
reason, and both stay here.

- **Hypothesis:** at a stamp j in 10:30–14:00, Kronos-small's forecast of the next 60 one-minute bars (from
  the 400 bars ending at j, both from the index's own lake bars) gives (a) a *direction*: the forecast close
  at j+60 minus the close at j, and (b) a *range*: the forecast high minus low over the 60 bars. Two rules,
  both fixed now:
  - **R1 direction → Dir.** Fires the first time in the window that |direction| ≥ 0.15% of the close at j;
    the Dir template enters at j+1 on the forecast's side (`on: up` / `on: down`). Hypothesis: event minus
    placebo per lot, after charges, is positive.
  - **R2 contraction → Widesl.** Fires the first time in the window that the forecast range is below 0.6 ×
    the median realised 60-minute range at the same clock hour over the previous 20 sessions; the Widesl
    template enters at j+1. Hypothesis: event minus placebo per lot, after charges, is positive.
  The thresholds (0.15%, 0.6, 60 bars, 400-bar context) are set here without looking at any output and are
  not tuned afterwards.
- **Model and sampling (fixed):** `NeoQuasar/Kronos-small` + `NeoQuasar/Kronos-Tokenizer-base`, at the
  Hugging Face commits recorded in the Log; `max_context 512`, `lookback 400`, `pred_len 60`, `T 1.0`,
  `top_p 0.9`, `sample_count 10`, a fixed seed derived from (session, stamp); direction and range are taken
  from the averaged path the predictor returns. Volume is passed; `amount` is left empty (the README allows
  it). One forecast per stamp, stamps 10:30–14:00 (BL-083's window), one event per rule per session.
- **Templates:** BL-083's three live shapes as the rule tester has them (Widesl, Dir, Buy), 1 lot, entry
  j+1, exit 15:28, `lot_sizing: current`. Buy is run as a third arm of R1 for the event study only
  (`on: up` / `on: down`), with no hypothesis attached.
- **Universe:** NIFTY only (nearest weekly expiry, as the templates). SENSEX is reported as supporting
  evidence only (data from 2024-10, trained on nothing, and half the clean window).
- **Periods:**
  - *Clean window (the verdict):* NIFTY sessions 2025-08-18 → 2026-10-08. Nothing before the weights were
    public counts.
  - *Possibly-in-training (descriptive only):* the tester's learning period before 2025-08-18 and its
    confirmation period (2022-01 → 2024-10-08). Reported in a separate table, labelled, never a verdict.
    The confirmation period stays locked until `obt rule reveal`, as for any rule.
  - *Forward:* sessions after 2026-10-08 are never tested until a forward read-out is registered here.
- **Comparators (the tester's):** the time-matched placebo (same template and side at the same minute on
  the 20 nearest no-event sessions), the random-time control (a 5-minute entry grid, 200 draws, seeded from
  the spec hash), slippage 0.5% and 1% on the events, BL-063 charges on everything.
- **Look-ahead check:** (1) the forecast at j reads bars stamped ≤ j only, held by the tester's causality
  test on the feature (a shifted-bar test: perturbing bars > j must not change the value at j); (2) the model
  weights are fixed before the first run and their hash is in the Log; (3) R2's realised-range median uses
  the previous 20 *completed* sessions; (4) the placebo is matched on calendar position, never outcome;
  (5) the clean window begins after the weights' publication date, as argued above.
- **Pass / kill rule (per rule, on the clean window, after charges):** a **lead** if event minus placebo per
  lot is positive with a day-clustered t ≥ 2.5, the events beat the random-time control's P90, at least 40
  events fired, and the sign holds at 0.5% slippage. **Kill** if the point estimate is at or below zero, or
  t < 1 with at least 40 events. Between: inconclusive, logged, and a forward read-out may be registered
  (a new dated block) before any forward session is read. A lead is a journal candidate for a shadow
  record (as BL-162), never an adoption.
- **Hold-out:** every session after 2026-10-08; nothing after that date is scored in Phase 2.
- **Will not run:** other horizons (30, 120 bars), other thresholds, other contexts, Kronos-mini / -base,
  more samples, SENSEX as a primary, any fine-tuning, a rule that combines R1 and R2, per-weekday or
  per-expiry fits, and anything on forward sessions. Each needs `override: <reason>` in the Log, and a
  second definition is a new dated block, not an edit.

### Phase 1 — The feature (research only, ≈ 1–2 h CPU)
- **Tasks:** `packages/option-backtesting/research/bl163/`: `forecast.py` builds the per-(session, stamp)
  direction and range arrays for NIFTY over the clean window and the learning period from the lake's
  1-minute bars (one `predict_batch` per session, cached under `research/bl163/results/`, git-ignored);
  `causality_check.py` perturbs bars after j and asserts the value at j is unchanged. The model runs in a
  separate `uv` environment under `research/bl163/` (torch is not added to the package's dependencies).
  Record in the Log: the weights' commit hashes and dates, the paper's data cut-off, torch and model
  versions, wall time.
- **Deliverables:** the cached feature files and a one-page `out/feature_summary.md` (coverage: stamps with a
  forecast per session; the forecast's own distribution, no P&L).
- **Done when:** the causality check passes on 20 random (session, stamp) pairs, and a session's forecast
  re-run with the same seed is bit-identical.

### Phase 2 — The two rules through the tester
- **Tasks:** expose the feature to the rule grammar as `{kronos_dir: {}}` / `{kronos_range: {}}` read from
  the Phase 1 files (a small, read-only extension of `ruletest/frame.py`'s feature loading, behind a path
  setting, so a missing file is an error, never zeros); write `R1.yaml` and `R2.yaml` in
  `research/bl163/rules/`; run `obt rule test` on the clean window first, then the possibly-in-training
  period; apply the Phase 0 rule.
- **Deliverables:** the tester's result files, the ledger lines, a table in this item (event minus placebo,
  t, n events, random-time P90, slippage rows), the verdict in the Log, a `research/options/common/`
  page (`external-forecast.md`) with the result and the training-overlap caveat.
- **Done when:** both rules have a logged pass / kill / inconclusive on the clean window and the page is
  committed in the same change.

## Risks

- **Training overlap:** if the paper's data cut-off is later than 2025-08-18, the clean window shrinks; if it
  cannot be established, the clean window is as registered and the uncertainty is stated with the verdict.
- **Sampling noise:** 10 samples per stamp leave the forecast noisy; a fixed seed makes it reproducible but
  not less noisy. The rule reads only two coarse statistics, so this is accepted; it is not a reason to
  raise `sample_count` after the fact.
- **Few events:** R2 may fire rarely; under 40 events the rule is inconclusive by construction, not killed.
- **Dependency weight:** torch and the model are kept out of the package's `pyproject.toml`; the research
  environment is disposable.
- **Garden of forking paths:** two rules, one model, one window, and the tester's ledger counts every run.
  Anything else is a new dated block.

## Open questions

- Does the owner want the hour horizon, or is a next-session forecast (from the 09:16 pick's point of view)
  the more interesting question? That would be a ranking-criterion test with its own item.
- Should a Momentum twin (weekly bars, a ranking tie-breaker) be opened now as a separate `Idea`, or wait
  for this verdict?
- Is a separate torch environment under `research/bl163/` acceptable, or should the model run on another
  machine and only its feature files be copied in?
- SENSEX as supporting evidence: worth the extra hour of CPU, or leave it out entirely?

## Log

- 2026-10-25 — created from the owner's question about the 24 Oct "fast-growing finance repos" list;
  pre-registration drafted; nothing run. Priority P3 by Claude's judgement (low prior, Momentum month).
