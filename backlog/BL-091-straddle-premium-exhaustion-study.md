# BL-091 — Straddle premium exhaustion: historical incremental-signal study

| | |
|---|---|
| **Priority** | P2 — evidence for the proposed Live premium-momentum view; useful before adding more signal parameters |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-034 historical option/index/VIX coverage and quality; existing event study as a comparator, linked below |
| **TODO.md row** | — (filled in when started) |

## Context

The owner proposed a rolling ATM straddle chart with first and second time derivatives to
investigate momentum exhaustion. The follow-up asks which additional parameters improve
detection: preceding expansion size, persistence of slowing, a negative-velocity crossing,
retracement from the running high, expiry-specific IV, underlying movement and nearby-strike
agreement. This item plans a historical analysis; it does not start one.

The target is **straddle-premium expansion exhaustion**, not index directional exhaustion.
Negative acceleration alone means expansion may be slowing, not that a peak is established.
Rolling ATM strike changes can create artificial jumps; derivative estimates also amplify
stale or noisy prices.

Related work:

- [Event-triggered intraday entries](BL-083-event-triggered-intraday-entries.md): T3 already
  combined a fixed morning-ATM straddle turn with spot-range stabilisation. The consolidated
  report records weak evidence. Reproduce its exact definition as a comparator where feasible;
  do not describe this follow-up as an entirely untested idea.
- [Hourly checkpoints](BL-081-drb-hourly-checkpoints-and-no-trade.md): many intraday state
  variables failed to show robust value. Additional filters need incremental evidence.
- `apps/server/src/ingestion/straddle-calc.ts` and
  `apps/server/src/signals/peak-detection-engine.ts` contain existing ROC/acceleration ideas.
  They are frozen reference implementations, not authority for a new derivative definition
  or permission to reactivate the personality engine.
- `packages/trading-data/src/trading_data/derived.py` provides five-minute chain snapshots,
  rolling ATM series and IV/Greeks. Contract-level observations are needed for fixed-strike
  paths; coverage, timestamp conventions and quality flags must be audited.

The external UI proposal is `~/Downloads/Options Research/Options Rotation Widget Proposal.md`.
It defines a standalone Straddle-Premium Expansion Exhaustion widget in Live only; historical
verification remains this study, with recorded-event inspection through Day replay. The UI
proposal owns widget design; this backlog file is the source of truth for the research protocol.

## Goal

Determine whether derivatives and each proposed confirmation parameter add useful information
about subsequent fixed-strike premium contraction and adverse expansion beyond simple
expansion/reversal controls. Produce reproducible event records, a full comparison table,
failure cases and a recommendation: descriptive display only, forward-shadow candidate,
unsupported, or insufficient data.

## Out of scope

- Implementing the dashboard or a live collector; sending alerts or placing orders.
- Changing A/B/C/REF, their baskets, weights, stops or journal.
- Extending or unfreezing the server personality/peak-detection execution system.
- Claiming a premium contraction event is profitable after strategy stops and execution costs.
- Broad parameter optimisation, automatic confidence scores, or a combined filter chosen by
  trying every possible combination.

## Plan

### Phase 0 — Pre-register

**Draft protocol, not run-ready.** Resolve the finite settings below and commit this block plus
the experiment configuration before any outcome exploration, comparison or sweep. No run has
occurred. This task adds a planned item only; start-time questions belong to the normal
"Start BL-091" workflow. Previous research overrides are not inherited by this item.

- **Hypothesis:** Persistence and realised retracement following meaningful premium expansion
  improve subsequent contraction versus acceleration alone; expiry-IV, spot and breadth
  information may add incremental value, but each must be tested separately.
- **Universe:** NIFTY and SENSEX nearest-listed-expiry CE/PE pairs using the instruments and
  expiry calendar available on each historical day. Use all eligible sessions within a frozen
  data manifest, not today's contracts or only days on which rotation selected a strategy.
  Analyse indices separately; report actual DTE coverage and missing/excluded sessions.
- **Series:** Display rolling ATM as context, but estimate derivatives only on a continuous
  strike/expiry segment. Reset after a switch. At detection, freeze that pair for the entire
  outcome horizon. Use the same conventions for controls. Fixed morning-ATM T3 remains a
  separately labelled legacy comparator, not a silently changed version of this signal.
- **Look-ahead check:** Use completed bars with their actual availability timestamps, trailing
  smoothing and as-of highs/baselines only. A five-minute bucket's close is not available at
  its starting timestamp. Freeze moneyness/nearby strikes at each observation. No centred
  smoother, future-labelled regime, whole-day high, eventual peak backdating or future IV.
  Measure tradable follow-through from the next available bar after detection; separately
  label any descriptive detection-close statistics.
- **Survivorship/quality check:** Enumerate expired instruments from historical manifests,
  retain failure counts, freeze quality rules before reading outcomes and compare filters
  on a common eligible sample. Do not select days by profitable or complete-looking paths.
  Unavailable future bars are missing outcomes, not zero returns. Quote-spread analysis is
  omitted where only traded-price bars exist; never fabricate historical quotes.
- **Historical periods:** Proposed development 2024-10-09 through 2025-08-29; chronological
  evaluation 2025-09-01 through 2026-10-09, subject to coverage. NIFTY 2022-01-03 through
  2024-10-08 is a separate older-regime check where eligible data exists. These periods have
  been used by prior research; none is a pristine unseen hold-out. Freeze exact eligible dates
  and source versions in the manifest before analysis. Report half-year and index results.
- **True hold-out:** If a historical lead merits a forward shadow, register its exact rule
  before its first future event and evaluate after 60 trading sessions. The actual start is
  the first eligible session after that registration, not automatically 12 October. No live
  shadow is started by this item creation.
- **Primary outcome (proposed):** Fixed-strike premium contraction over 30 minutes from the
  next available bar, normalised by starting premium, alongside maximum adverse expansion
  over the same path. Report points as a secondary unit. The 15/60-minute horizons are
  descriptive secondary outcomes and cannot rescue a failed primary result.
- **Pass / kill rule (proposed; freeze before runs):** For a forward-shadow lead, the primary
  mean contraction improvement versus the simpler parent rule's matched controls must have
  a multiplicity-adjusted 95% lower confidence bound above zero, beat the time/DTE-matched
  placebo's P90, and not worsen the P90 adverse-expansion fraction. Require at least 100
  distinct evaluation sessions with eligible events for the claimed scope and positive
  improvement in each eligible evaluation half-year. Insufficient samples mean inconclusive;
  failure means no demonstrated incremental value. An index-specific result stays
  index-specific. These are study-design proposals, not owner-approved trading thresholds.
- **Data-snooping control:** Register the bounded comparison ladder below. Every attempted
  configuration appears in the report; do not pick a filter combination on the evaluation
  set. Use a pre-specified Holm adjustment across primary comparisons and session-block
  resampling (same-day indices/strikes stay together). Freeze matching bins, resampling
  seed/count and the simultaneous-inference implementation before outcome inspection.
- **Will not run:** Exhaustive filter combinations, a large smoothing/threshold sweep,
  alternate-primary-horizon rescue tests, retrospective peak labels as live events,
  after-the-fact expiry/day exclusions or a portfolio override test. A gated-off test requires
  the owner's explicit `override: <reason>` in the Log and a new dated experiment block.

#### Finite comparisons to register

| Arm | Definition / question |
|---|---|
| C0 | Time-of-day/DTE-matched eligible observations: what happens without an exhaustion rule? |
| C1 | Meaningful prior expansion alone: does simply waiting after expansion explain the outcome? |
| C2 | C1 plus positive velocity and negative acceleration: the basic early indication. |
| C3 | C2 plus persistent slowing: does persistence improve on a momentary acceleration signal? |
| C4 | C1 plus negative velocity and retracement, without acceleration: the simpler reversal control. |
| C5 | A C3 episode subsequently meeting C4: does observing prior deceleration add value beyond C4? |
| C6–C8 | Add expiry-IV direction, underlying-activity change, and nearby-strike agreement individually to C5; compare each against C5 on its common data sample. |
| Legacy | Exact earlier T3 straddle-turn/range-stabilisation rule, for context where its inputs exist. |

Define features and time windows once, then reuse them across arms. Freeze expansion baseline,
normalisation, smoothing window/order, deadbands, persistence count, retracement size,
neighbour set and every threshold before the registered evaluation. Prefer one specification
per arm; any development-only alternatives must be enumerated and budgeted in advance.

For delayed confirmation arms, measure outcomes from their own executable detection times,
not from the earlier candidate. Report confirmation delay and the contraction already missed.
Use a declared episode/cooldown rule to avoid counting the same movement repeatedly; proposed
non-overlap is 60 minutes per index. Report eligible observations, events and distinct days.
Match comparator samples on observable starting conditions, including time, DTE and expansion
size. Do not match on subsequent outcomes; show unmatched coverage and retain the unfiltered
parent outcome as context. Add a paired candidate-episode analysis for early versus delayed
confirmation rather than comparing only unrelated event averages.

### Phase 1 — Coverage, feature definitions and event construction

- **Tasks:** Audit historical input coverage without ranking outcomes; freeze the manifest and
  complete Phase 0. Implement research-only event extraction under
  `packages/option-backtesting/research/bl084/`, sharing generic helpers through
  `research/common/` if needed. Preserve immutable source data.
- **Deliverables:** Versioned finite configuration, coverage/missingness table, timestamp and
  strike-continuity audit, events with observable inputs and contract identity, and synthetic
  checks for constant/rising/turning series, ATM-switch jumps, gaps and causal derivatives.
- **Done when:** No event changes when later bars are appended; event times follow input
  availability; switches and stale data cannot manufacture exhaustion; the pre-registration
  and finite configuration are committed before outcome evaluation.

### Phase 2 — Historical incremental-value analysis

- **Tasks:** Evaluate the frozen arms and matched controls; report 30-minute contraction and
  adverse expansion, secondary 15/60-minute paths, contraction-threshold frequencies, event
  counts and early/late detection trade-offs. Include block uncertainty and multiplicity
  handling, chronological-period results and the older-regime context check.
- **Deliverables:** Full results table for all arms, event-path examples including failures,
  data exclusions, lead/fail/inconclusive verdicts and a comparison with earlier T3 evidence.
- **Done when:** Every reported improvement identifies its simpler comparator, sample,
  uncertainty, delay and adverse-path effect; no historical period is mislabelled unseen.

### Phase 3 — Recommendation for the widget and any future shadow

- **Tasks:** Classify parameters as descriptive context, promising for a forward shadow,
  unsupported or data-limited. Specify which labels can honestly appear on the widget.
  If a lead qualifies, write a separate dated forward protocol and operational prerequisites;
  do not start it implicitly.
- **Deliverables:** One recommendation with exact rule/version, known limitations and the
  proposed forward evaluation. Portfolio/strategy tests, if later requested, receive their
  own pre-registration with executable fills, stops and costs.
- **Done when:** The owner can distinguish a useful visual from a supported signal and see
  precisely what further evidence would be needed before using it in rotation.

## Risks

- Recentring ATM, asynchronous legs and bar-close timing can create false turning points.
- Derivatives, retracement, IV and breadth partly reuse the same information; several agreeing
  indicators are not independent votes or a calibrated probability.
- Short-dated premium/IV can be unstable; time-to-expiry, low prices and data flags must remain
  visible, with no retrospective removal of difficult sessions.
- Overlapping events and correlated strikes exaggerate sample size unless clustered by session.
- A filter may look better only because it fires later or on easier sessions; matched controls,
  event coverage and delay are essential.
- Existing historical periods have already informed the research programme. Only a newly
  registered forward test can supply fresh evidence after this study.

## Open questions

Resolve when the owner starts the item, before freezing Phase 0:

1. Accept the proposed 30-minute primary horizon, sample floor and pass rule, or specify a
   different practical contraction/adverse-expansion trade-off?
2. Use one-minute observations with causal smoothing, or completed five-minute observations
   as the primary cadence? Freeze one; do not choose after evaluation results.
3. Which exact expansion, persistence and retracement definitions should the finite study use?
4. Confirm historical manifest/cut-offs and eligible DTE coverage without requiring unsupported
   SENSEX history; freeze how low-premium/IV-quality cases are handled.

## Log

- 2026-10-10 — Owner requested adding premium-momentum parameters to the widget proposal and
  a backlog analysis to verify them historically. Created P2 / Planned; index updated. No
  experiment, sweep, live collector, alert or strategy change run. Phase 0 remains a draft
  until start-time questions are resolved and its finite configuration is committed.
- 2026-10-10 — Owner placed Straddle-Premium Expansion Exhaustion in Live only as a standalone
  widget. Updated the UI reference; historical study scope, P2 / Planned status and evaluation
  protocol remain unchanged. No study or product implementation started.

## Amendments proposed from the two Live widget sections (2026-10-10)

Read against "Premium Decay & Expectations" and "Straddle-Premium Expansion Exhaustion" in
`~/Downloads/Options Research/Options Rotation Widget Proposal.md`. Each item below is a proposed
change to Phase 0–3; none is frozen until the owner starts the item. Nothing here has been run.

### A. What the widgets specify that the study does not test

1. **Base rates by interval, DTE and opening VIX band (from Premium Decay → Historical → Period).**
   The study's C0 matches controls on time of day and DTE at event times only. Add a Phase 1
   deliverable: the unconditional fixed-strike contraction table, interval × DTE × opening VIX band
   per index (median change in points and %, contraction frequency, expansion frequency, max adverse
   expansion, distinct-session count). Use it (a) as the published denominator every arm is read
   against, so "exhaustion at 13:30 on expiry day" is judged against normal 13:30 expiry-day decay,
   and (b) to add **opening VIX band** to C0's matching variables. The proposal's later-stage note
   "rather than treating normal late-session decay as a special exhaustion event" becomes a
   registered control, not a caveat.
2. **Premium relative level as one more arm (from the premium-comparison view).** The widget shows
   the current premium's percentile against comparable sessions (same index, observation time,
   time to expiry, volatility context), premium normalised by the underlying level. Register
   **C9 = C5 plus "premium above the comparable-session median"** on C5's common sample, like C6–C8.
   Freeze the comparable set (index, 30-minute observation bucket, DTE, VIX band; underlying-level
   normalisation) before outcomes are read. One arm, not a sweep.
3. **Expansion size normalised by recent premium variability (from the widget's "preceding
   expansion size … relative to recent variability").** The draft normalises by starting premium
   only. Define the expansion deadband as a multiple of the trailing realised variability of the same
   fixed-strike premium (frozen window, e.g. the last 60 completed one-minute changes), so a 5-point
   rise counts on a quiet day and not on a wild one. One definition, frozen in Phase 0.
4. **"Expansion resumed" as an outcome category (from the event drawer).** Alongside endpoint
   contraction and maximum adverse expansion, record for every event whether the fixed-strike
   premium made a new running high inside the horizon, and when. Report it per arm; a confirmation
   parameter that lowers the resumed fraction without raising delay is the honest version of
   "fewer false indications".
5. **Threshold frequencies and "finished above start" (from the remaining-outcome panel).** Phase 2
   already lists contraction-threshold frequencies. Freeze them as **≥ 20 / 30 / 40 points and
   ≥ 10 / 20 / 30 % of starting premium**, plus the fraction finishing above the starting premium,
   per arm and per horizon. Secondary and descriptive; they cannot rescue a failed primary.
6. **Time-decay-only scenario as a descriptive baseline (from "unchanged-market scenario").** For
   each event, the pricing-model contraction with the underlying and expiry IV held constant over
   the horizon (theta from `chain_snapshots_5m`, labelled model-based). Report observed contraction
   minus this scenario so a signal is seen to beat theta, not only matched history. Context only;
   not a pass criterion, because intraday theta at one DTE is itself a model choice.
7. **Staleness and continuity rules, frozen (from the quality strip).** Define stale as an
   unchanged CE or PE close for N consecutive minutes or zero volume where volume exists; define the
   warm-up after an ATM switch as the derivative window length; suppress events inside either.
   Freeze N and the window in Phase 0 and report how many candidate events each rule removed.
8. **Nearby-strike set, frozen (C8).** The widget says "a small, fixed set": register it as the
   two straddles one strike step either side of the fixed ATM pair, same expiry, measured on the
   same clock. Agreement = the same descriptive state at the same minute.

### B. Changes to the periods, cadence and data path

9. **Align the periods with P1 / P2 / P3.** The draft's development (2024-10-09 → 2025-08-29) and
   evaluation (2025-09-01 → 2026-10-09) windows match no other item. Use P1 (2025-12-03 →
   2026-10-08), P2 (2025-01-10 → 2025-08-29) and the NIFTY-only P3 (2022-04-05 → 2024-10-08)
   where contract-level bars exist, so the result sits beside BL-081 and BL-083 and the owner's
   "last two years" reading applies without translation. Report half-years inside P1 + P2 as the
   draft asks. The straddle / IV derived series start 2024-10, so P3 covers only what the 1-minute
   option bars of the 2022 import allow; say so in the coverage table rather than dropping P3.
10. **One-minute observations, causal smoothing, from the lake's contract bars.** Resolves open
    question 2. The derived `straddle_series_5m` is rolling ATM at 5-minute windows and switches
    strikes; it is the context series, not the signal series. Build fixed-strike paths from
    `bars_1m` option contracts, reusing the 09:20-ATM straddle builder in `research/bl083/triggers.py`
    (it already freezes a pair and reads bars stamped ≤ j only). The widget's "completed one- or
    five-minute intervals" then share one definition with the study.
11. **The legacy T3 comparator becomes a hard requirement, run on the same sample.** BL-083's T3
    (09:20-ATM straddle up ≥ 5 % on its 10:00 value, now ≥ 3 % below that high, 30-minute spot range
    ÷ ATR below its trailing-252 median) is the only version of this idea with a recorded result, and
    it was the weakest of the four triggers. Every arm reports its difference to T3 on T3's eligible
    sessions, not only to C0.

### C. The forward test does not need the Live widget

12. **Forward shadow through nightly scoring, not a live feed.** PR #167 scores the four BL-083
    triggers every evening from the day's collected bars (first firing per index, templates from the
    next minute, a 20-day placebo, appended under `TRADING_DATA_ROOT/rotation/triggers/`). A BL-091
    lead that passes Phase 2 is registered as **T5** in that pipeline: its exact rule and version,
    detection from bars stamped ≤ j, outcomes measured from j + 1, recorded on unseen days from the
    first eligible session after registration, judged after 60 sessions. This replaces "write a
    separate dated forward protocol" with a concrete, already-running mechanism, and it decouples the
    study from the intraday collector the Live widget needs. The Live widget, if built later, displays
    what the nightly record also computes; the two cannot disagree.
13. **The eventual strategy test is BL-083's template, not a new design.** If T5 is ever to touch the
    rotation, the test is the one BL-083 ran: fire Widesl / Dir / Buy at j + 1, against the
    time-matched placebo, then the override of the next pending core pick, read under the registered
    bar and under the owner's rule. Say this in Phase 3 so the path from "signal" to "rule" is one
    existing pre-registration, not an open question.
14. **Checkpoint provenance (from "prediction review").** Every nightly T5 record carries the rule
    version, data manifest version, inputs at detection and the horizon; records are append-only.
    A later recomputation with a new version is a new series, never an overwrite. This is the
    "recorded live vs reconstructed" distinction the widget wants, enforced at the data layer.

### D. Housekeeping

15. **Renumbered 2026-10-10.** Drafted as BL-084, which on `main` is the Momentum weekly stop-loss
    (killed 2026-10-08); this item is BL-091. The widget proposal's link and the INDEX row updated
    together.
16. **Sample floor check at Phase 1.** With a 60-minute cooldown per index and roughly 360 P1 + P2
    sessions × 2 indices, the 100-eligible-session floor is plausible for C1–C5 but may fail for
    C6–C9 on their common samples. Report the achievable floor per arm from the coverage audit before
    Phase 2, and declare in advance which arms are inconclusive by construction.
- 2026-10-10 — Renumbered BL-084 → BL-091 (number taken on `main`); amendments A–D appended from the two
  Live widget sections of the proposal. Still Planned; nothing run.
