# BL-091 — Straddle premium exhaustion: historical incremental-signal study

| | |
|---|---|
| **Priority** | P2 — evidence for the proposed Live premium-momentum view; useful before adding more signal parameters |
| **Status** | In progress (Phase 1 done: census + R0 on P2 + P3; next steps wait for the owner; P1 unread) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-034 historical option/index/VIX coverage and quality; BL-083 (T3 as comparator, the straddle builder in `research/bl083/triggers.py`, and the nightly trigger scoring of PR #167 for any forward shadow) |
| **TODO.md row** | 3.25.1 |

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
  combined a fixed morning-ATM straddle turn with spot-range stabilisation and showed no edge in any
  template; BL-083 attributes the failure to the trigger, not the templates. Reproduce its exact definition as a comparator where feasible;
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

The owner's widget proposal (a copy is at `~/Downloads/Options Research/Options Rotation Widget
Proposal.md`; it is not in the repository) defines a standalone Straddle-Premium Expansion
Exhaustion widget in Live only; historical verification remains this study, with recorded-event
inspection through Day replay. This backlog file is the source of truth for the research
protocol. The two widget specifications the amendments below derive from, in short:

- **Straddle-Premium Expansion Exhaustion (Live only):** three aligned panels, premium / velocity
  (points per minute) / acceleration, on a rolling-ATM series with strike-switch markers and a
  fixed-strike option; causal smoothing only; descriptive states Expansion / Slowing / Reversal
  observed / Expansion resumed from the sign of velocity and acceleration; confirmation inputs
  (preceding expansion size, persistence of slowing, velocity crossing below zero, retracement
  from the running high, expiry-specific IV direction, underlying activity, nearby-strike
  agreement, data quality); Early indication / Reversal observed event definitions recorded at
  detection time with 15 / 30 / 60-minute fixed-strike outcomes; no confidence percentage.
- **Premium Decay & Expectations (Live / Historical → Session / Period):** fixed-strike CE + PE
  path from a chosen starting time to a chosen endpoint; comparable-session matching on index,
  observation time, time to expiry and volatility context with the sample size shown; premium
  percentile against comparable history, normalised by the underlying level; remaining-outcome
  distribution (mean and median contraction, ≥ 20 / 30 / 40-point frequencies, finished above
  start) and maximum adverse expansion; Period heatmaps by date, DTE and opening VIX band ×
  time interval; an unchanged-market (theta-only) scenario kept separate from the historical
  estimate; every issued estimate saved with its inputs and version for later review.

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
the experiment configuration before any outcome comparison or sweep on P1 or forward. No run has
occurred. The gate has two stages since 2026-10-10 (section E): the exploration on P2 + P3 is
registered by section E (what an episode is, what is recorded, which parameters are read) and may
read those periods' outcomes to learn the thresholds; the single P1 run and the T5 shadow are gated
by this block, frozen with the learned thresholds before P1 is read. This task adds a planned item only; start-time questions belong to the normal
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
- **Historical periods (E.3):** learn on P2 (2025-01-10 → 2025-08-29) and the NIFTY-only P3
  (2022-04-05 → 2024-10-08); test once on P1 (2025-12-03 → 2026-10-08), subject to coverage.
  These periods have been used by prior research (BL-081, BL-083 and the rotation lists); none
  is a pristine unseen hold-out, and P1 is untouched only by this item's exploration. Freeze exact
  eligible dates and source versions in the manifest before analysis. Report half-year and index
  results.
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
  `packages/option-backtesting/research/bl091/`, sharing generic helpers through
  `research/common/` if needed. Preserve immutable source data. Then the registered exploration
  on P2 + P3 (E.3): build the episode table (E.2, E.4), replay the re-entry habit R0 to label held
  and stopped minutes (E.6, E.7), and write the one detection rule and trade mapping into this item
  before P1 is read.
- **Deliverables:** Versioned finite configuration, coverage/missingness table, timestamp and
  strike-continuity audit, events with observable inputs and contract identity, and synthetic
  checks for constant/rising/turning series, ATM-switch jumps, gaps and causal derivatives.
- **Done when:** No event changes when later bars are appended; event times follow input
  availability; switches and stale data cannot manufacture exhaustion; the pre-registration
  and finite configuration are committed before outcome evaluation.

### Phase 2 — Historical incremental-value analysis

- **Tasks:** Evaluate the frozen arms and matched controls; report 30-minute contraction and
  adverse expansion, secondary 15/60-minute paths, contraction-threshold frequencies, event
  counts and early/late detection trade-offs. Run the re-entry ladder R0–R5 (E.6) on P1 with
  stops and costs against random re-entry minutes. Include block uncertainty and multiplicity
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

Resolve when the owner starts the item, before freezing Phase 0. Questions 1 and 3 were answered on
2026-10-10 (section E below); question 2 is settled in part (one-minute bars, B.10 and E.1) and is
confirmed at the freeze; question 4 is open.

1. ~~Accept the proposed 30-minute primary horizon, sample floor and pass rule, or specify a
   different practical contraction/adverse-expansion trade-off?~~ **Answered (E.2, E.6):** the
   episode and outcome definitions are in points (rise ≥ 25, decay ≥ 15), and the practical trade-off
   is measured as the rupee result of the owner's re-entry habit with its stop, not as a premium
   horizon alone. The 30-minute premium horizon stays as the secondary, descriptive measure.
2. Use one-minute observations with causal smoothing, or completed five-minute observations
   as the primary cadence? Freeze one; do not choose after evaluation results. Amendment B.10
   proposes one-minute fixed-strike paths from the lake's contract bars; E.1 uses one-minute
   bars for the rolling series. Confirm at the freeze.
3. ~~Which exact expansion, persistence and retracement definitions should the finite study use?~~
   **Answered (E.3):** they are learned from the episodes in the older data, written down once, and
   then run on the untouched latest year. The owner does not know them in advance and does not
   want them guessed.
4. Confirm historical manifest/cut-offs and eligible DTE coverage without requiring unsupported
   SENSEX history; freeze how low-premium/IV-quality cases are handled.

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

### E. Owner's answers (2026-10-10): learn the rule from the episodes, then test it

The owner answered open questions 1 and 3 in conversation on 2026-10-10. Recorded here verbatim in
substance; these are the settings the start-time freeze will use unless the owner changes them.

1. **The series is the rolling (dynamic) ATM straddle.** Whatever strike is ATM at that minute, that
   straddle: NIFTY at 24,000 with the 24,000 straddle at 159; NIFTY moves to 24,100 and the 24,100
   straddle is now the series, at 180 or so. Detection reads this rolling series, built minute by
   minute from the lake's one-minute contract bars (B.10). Every strike switch is marked. Episodes
   (the ≥ 25-point rise and ≥ 15-point decay of E.2) are measured on the rolling ATM straddle itself,
   so a switch counts as movement, as in the owner's example (corrected 2026-10-11; a spliced series
   was registered first and dropped, see the Log). Each leg is priced from its last real trade at most
   5 minutes old; a minute with no priced pair holds the last value and is flagged. For derivatives
   (velocity, acceleration, persistence) the Phase 0 rule stands: **reset** at the switch and warm up
   for the window length (A.7); no derivative is read inside the warm-up. The outcome of a trade is
   measured on the
   pair actually sold at the entry minute, which is then held fixed (the Phase 0 "freeze that pair"
   rule). NIFTY first; SENSEX where the same bars exist.
2. **Episodes and outcomes are in points, not percent.** An episode starts when the rolling ATM
   straddle rises at least **25 points** from a running low (example: 150 decaying to 135, then up
   to 160 or beyond; the owner's typical spike is up to about 100 points). Every such rise in the
   learning data is an episode, whether or not it later fell. An episode **decayed** when the series
   fell at least **15 points** from its running high without making a new high inside the horizon;
   otherwise it **paused and resumed**. No percent rule anywhere. The premium level at the start of
   each episode is recorded as a column only, so it can later be seen whether a 25-point rise behaves
   the same at 120 as at 300.
3. **Learn on the older data, test once on the latest year, then forward.** The exploration that
   finds the rule runs on P2 (2025-01-10 → 2025-08-29) and the NIFTY-only P3 (2022-04-05 →
   2024-10-08). Its output is **one** detection rule and one trade mapping, written into this item
   with every alternative that was looked at (a smoothing window, a persistence count, a retracement
   size each get a Log line, so the number of looks is known). Only then does the rule run, once, on
   P1 (2025-12-03 → 2026-10-08), which this exploration does not read. P1 is not pristine: the
   rotation lists, BL-081 and BL-083 were built with it in view, so a P1 pass is evidence, and the
   T5 shadow (C.12) is the only unseen test. A rule that holds on P1 is registered as T5. The exploration is itself registered before
   it runs: this section fixes what an episode is, what is recorded per episode and which parameters
   are read; it does not fix thresholds, which are the exploration's output. "The last two years
   decide" is kept by not reading P1 until the rule is frozen.
4. **What is recorded for every episode.** Start minute and the running low; the high and its
   minute; rise in points; decayed or paused-and-resumed, and the minute decay began; time of day of
   the high; what NIFTY did from the high over the horizon (kept going, stalled, reversed, with the
   size in points); premium level at the start; days to expiry; opening VIX band; data-quality flags.
   At every candidate minute (see 6 and 7) the parameters: velocity and acceleration of the rolling
   series with causal smoothing, how many minutes the slowing has lasted, give-back from the running
   high in points, expiry-IV direction, NIFTY's own speed over the last minutes, agreement of the two
   neighbouring straddles (A.8), premium percentile against comparable sessions (A.2), time of day.
   All from bars stamped at or before that minute.
5. **Three owner observations become registered questions, not assumptions.**
   - *A peak is often not the peak.* The series falls, then rises again. The exploration's first
     job is to find what, at the moment of slowing, separated the episodes that decayed from the
     ones that resumed. If nothing separates them, that is the finding.
   - *Decay usually comes late, around 14:30 to 15:00.* If most true decays start after 14:30, the
     finding is time of day, not exhaustion, and the honest rule is "sell at 14:30". The base-rate
     table by time of day (A.1) is the control; any exhaustion rule must beat it on the same minutes.
   - *Decay sometimes comes with a move the other way.* NIFTY reverses and the straddle falls. For
     those peaks a directional trade may work; for a stall only the sell works. Each episode's NIFTY
     path (item 4) says which, and the trade mapping may differ by kind of peak: Widesl, Dir (the
     BL-083 templates, C.13) or both.
6. **The re-entry ladder: the owner's habit as the baseline trade test (Phase 2).** The owner's
   experience: on a drastic rise the running wide sell's rupee stop is hit; the owner re-enters the
   OTM wide sell at the new ATM with a small stop, which is hit again, typically three or four times,
   until an attempt holds and the decay that follows can cover the earlier losses. The stop is
   **₹2,000 on a four-lot position, ₹500 per lot** (the owner quoted ₹500 to ₹650 per lot; the
   ₹2,000 total is what the arms use). On today's NIFTY lot of 65 that is about 8 points of combined
   premium, which the premium moves in a minute or two during a 25 to 100 point rise: the early
   attempts are stopped by normal wobble, not because the call about the top was wrong. The engine
   runs with its default `lot_sizing: current` (today's lot on every historical day), so ₹500 is the
   same number of points in P3 (when the lot was 25 or 50) as in P1; a historical-lot run is not an
   arm. The aim is to remove the losing attempts without losing the one that holds. Arms:

   | Arm | Rule after a stop-out |
   |---|---|
   | R0 | The habit: re-enter the OTM wide sell at the new ATM at once, same stop, up to five attempts. Baseline. |
   | R1 | Re-enter only when the detection rule from item 3 fires. Same stop. |
   | R2 | Re-enter only after the rolling series has given back ≥ 15 points from its running high. |
   | R3 | No re-entry before 13:30 (the late-decay observation). |
   | R4 | Re-enter at will, but the stop must be at least a frozen multiple of the premium's recent one-minute swings; if that stop is larger than the owner would carry, do not enter. |
   | R5 | No re-entry within 20 minutes of a stop-out. |

   One rule per arm, no sweep. All arms run on the same episodes through the legwise engine (its
   stops and costs; a ladder of attempts is a sequence of its single entries, built under
   `research/bl091/`), with a comparator of 1,000 runs of random re-entry minutes inside the episode,
   drawn from the same time-of-day distribution as the arm's own entries, so R3 and R5 cannot win by
   entering later in a late-decay market. Per episode and per attempt number: stopped or held,
   rupees, attempts before the winner, worst day. Episodes where **no** attempt held are in the
   tally, since memory keeps the days the fifth attempt paid for the first four and drops the rest.
   Learned on P2 + P3, confirmed once on P1. **Keep rule (freeze before P1):** on P1, the arm's net
   rupees per episode after costs is above R0's and above the comparator's P90, its session-block
   resampled 95 % lower bound of the improvement over R0 is above zero, its worst day is not worse
   than R0's, and it has at least 40 episodes with at least one attempt; fewer episodes is
   inconclusive, not a pass. Reported alongside: attempts removed and winners removed, so the owner
   sees what was given up.
7. **The attempts label the minutes; the parameters are judged against the labels.** Each attempt's
   entry minute in R0 is labelled *held* (true peak) or *stopped* (false peak), measured in rupees with
   the owner's stop. The parameters in item 4 are read at every such minute. One table per parameter:
   its distribution at held versus stopped minutes. A parameter that looks the same in both groups
   does not help, whatever it is called; one that separates them is a candidate. Combinations are the
   ladder C2 → C3 → C5 → C6–C9: add one parameter at a time. Two stages, two rules: **during the
   P2 + P3 exploration** a parameter stays on the ladder if it removes stopped attempts without
   removing held ones (a screening rule, counted in the Log); **on P1** the surviving ladder is judged
   by the Phase 0 pass rule (matched controls, Holm, lower confidence bound) and, as a trade, by the
   R-arm keep rule in item 6. The P1 verdict stands. No search over every combination. The result is reported as
   a win rate per rule with the number of attempts behind it, never as a confidence percentage, because
   parameters that agree often carry the same information and are not independent votes.
8. **Confirmed by the owner (2026-10-10, at start).** The re-entered wide sell is **four Widesl
   strategies = 4 OTM1 CE + 4 OTM1 PE** (OTM2 on SENSEX), each the live `N_wide_1202` /
   `S_wide_1202` shape unchanged (115 % leg stops trailed 15/10, exit 15:28, 1 lot per leg) with an
   MTM stop of **₹650 per strategy** ("I keep widesl as it is, with assume 650 as MTM SL"). One
   strategy is simulated per attempt and its rupees are per strategy; ₹650 is 10 NIFTY points or 32.5
   SENSEX points of combined premium at today's lots. The horizon for decayed versus paused is
   **15:28**; observation starts **09:20**. Scope of the first run: the episode census and the R0
   replay on P2 + P3 only; no parameter tables, no R1–R5, nothing on P1.

## Result — Phase 1 (2026-10-11): episode census and R0 replay on P2 + P3

Counts only. No rule, threshold or arm is chosen from these numbers, and P1 was not read. Scripts:
`packages/option-backtesting/research/bl091/` (`selfcheck.py` 12 of 12 pass, then `census.py`,
`replay_r0.py`, `summarise.py`; full tables in its `out/census.md` and `out/r0_summary.md`, not
tracked). Rupees are per Widesl strategy (the owner runs four), at the engine's cost 0 unless marked.

**Coverage and episode counts** (rolling ATM straddle, ≥ 25-point rise, observation from 09:20):

| period | index | days loaded | episodes | per day | days with 0 / 1 / 2 / 3+ | median switches a day | straddle 09:20→15:28 (median, points) |
|---|---|---|---|---|---|---|---|
| P2 | NIFTY | 157 | 163 | 1.0 | 82 / 40 / 13 / 22 | 33 | −44 |
| P2 | SENSEX | 157 | 1,075 | 6.8 | 2 / 7 / 19 / 129 | 55 | −141 |
| P3 | NIFTY | 618 | 212 | 0.3 | 476 / 102 / 28 / 12 | 28 | −31 |

Skipped: 8 index-days (3 weekend special sessions, 5 excluded by data_quality). SENSEX's straddle is
about three times NIFTY's in points, so the same 25 points is a smaller move there; the owner's 25
was stated for NIFTY. Half of P2 NIFTY's episodes (84 of 163) and 39 % of P3's are on expiry day.

**NIFTY days with a rise of at least X points** (largest episode of the day; of which expiry days):

| rise | P2 (157 days, 33 expiry) | P3 (618 days, 131 expiry) |
|---|---|---|
| ≥ 25 | 75 days (48 %), 25 expiry | 142 days (23 %), 54 expiry |
| ≥ 40 | 48 (31 %), 18 expiry | 48 (8 %), 16 expiry |
| ≥ 60 | 19 (12 %), 7 expiry | 19 (3 %), 4 expiry |
| ≥ 100 | 6 (4 %), 2 expiry | 5 (1 %), 1 expiry |

**Outcome at 15:28** (decayed = gave back ≥ 15 points and did not make a new high):

| period | index | decayed | resumed, open at close | never gave back 15 | of which triggered at 15:00 or later |
|---|---|---|---|---|---|
| P2 | NIFTY | 146 | 1 | 16 | 16 of the 17 not decayed |
| P2 | SENSEX | 1,024 | 22 | 29 | 44 of the 51 |
| P3 | NIFTY | 190 | 7 | 15 | 20 of the 22 |

Before 15:00 almost every episode gave back 15 points by the close, so "does it decay" is not the
question; when it decays, and what it costs to wait, is.

**Size of the rise** (low to high, points): median 37 (P2 NIFTY), 42 (SENSEX), 34 (P3); 90th
percentile 74, 108, 63. Rises of 100+ points: 6, 121 and 7 episodes.

**Timing of decayed episodes.** The high and the 15-point give-back are spread across the day; the
share at or after 14:30 is 14 % / 15 % (P2 NIFTY, high / give-back), 16 % / 18 % (SENSEX), 29 % / 31 %
(P3 NIFTY). The owner's "decay comes around 14:30–15:00" holds for P3 more than for P2.

**Index after the high (decayed episodes):** stalled within one strike step 70 / 390 / 93, reversed
47 / 347 / 51, continued 29 / 287 / 46 (P2 NIFTY / SENSEX / P3 NIFTY).

**R0, the owner's habit** (re-enter the live Widesl after each ₹650 MTM stop, up to five attempts;
1,318 episodes triggered before 15:12):

| period | index | episodes | attempts 1 / 2 / 3 / 4 / 5 | with a held attempt | mean ₹ per episode | median | at ₹20/order mean |
|---|---|---|---|---|---|---|---|
| P2 | NIFTY | 145 | 59 / 24 / 14 / 17 / 31 | 117 (81 %) | +174 | +237 | −32 |
| P2 | SENSEX | 1,002 | 493 / 219 / 93 / 85 / 112 | 893 (89 %) | +532 | +387 | +365 |
| P3 | NIFTY | 171 | 72 / 40 / 20 / 14 / 25 | 152 (89 %) | +867 | +679 | +683 |

Held rate by attempt number (attempts 1 → 5): P2 NIFTY 41 / 28 / 21 / 35 / 13 %; SENSEX 47 / 42 / 32 /
41 / 29 %; P3 NIFTY 42 / 39 / 34 / 33 / 36 %. A fifth attempt was needed in 21 % of P2 NIFTY episodes.

Episodes with a held attempt: losses before the winner averaged −₹929 / −₹837 / −₹1,023 (median 0, 0,
−₹674), the held attempt made +₹2,251 / +₹1,978 / +₹2,658 on average, and the episode ended positive
in 81 of 117 / 644 of 893 / 110 of 152. Held attempts ran a median 156 / 153 / 123 minutes. Of the
overall stops, 8 / 98 / 29 hit on the entry bar itself.

The table above adds ladders that overlap in time on days with several episodes (68 / 843 / 49
episodes start before an earlier ladder that day has ended), which the owner would not run. Counting
only episodes whose ladder starts after every earlier one has ended:

| period | index | episodes | with a held attempt | mean ₹ per episode | median | at ₹20/order mean |
|---|---|---|---|---|---|---|
| P2 | NIFTY | 77 | 62 | +425 | +478 | +212 |
| P2 | SENSEX | 159 | 136 | +395 | +503 | +203 |
| P3 | NIFTY | 122 | 111 | +496 | +514 | +318 |

Worst day (sum of a day's episodes): −₹9,211 / −₹10,185 / −₹5,093 per strategy without overlapping
ladders; −₹24,882 / −₹99,748 / −₹6,234 raw.

**What this does not show.** There is no comparator in this phase: R0's rupees include the plain
theta of a strangle held to 15:28, and nothing here says an episode-triggered entry beats the same
Widesl entered at another minute. That is the time-matched random re-entry comparator of the R arms
(E.6), not run. SENSEX's counts are dominated by the 25-point threshold being small for its straddle.
Expiry-day episodes whose trigger or high is at 15:00 or later (14 / 57 / 42) price against the
settlement average, not the live index (Log, 2026-10-11). R0 fills through the engine, which prices a
strike from its last close including the vendor's zero-volume carried bars, while the episode series
refuses a leg whose last real trade is more than 5 minutes old; 44 SENSEX attempts entered one leg
only. This is the engine convention behind every stored result and is left as is.

## Next stages — consolidated draft (2026-10-11), not registered

Everything the owner decided or proposed after Phase 1, in one place. Nothing here has run. It
becomes the registration once the owner confirms the open points at the end; P1 stays unread
until one rule is frozen.

### What a tradable spike is

- **Series:** the rolling ATM straddle (E.1, as corrected after the smoke run).
- **Threshold:** NIFTY 25 points, SENSEX 90 points above the spike's low.
- **Hold:** the straddle must stay at least the threshold above the low for 5 consecutive minutes.
  The spike is known when the 5th minute completes; any entry is the next minute. Brief jumps that
  do not hold are not traded (about half of all spikes).
- **VIX regime at the 09:15 open:** reported both ways, as the owner decided (2026-10-11): two
  regimes (below 13, 13 and above) and three (below 11, 11–13, 13 and above). Below 11 had 5 NIFTY
  spikes in the learning periods, so its cells will be inconclusive.
- **Size category,** from the level above the low when the hold completes (known at entry), with
  cut points per index and regime from P2 + P3:

  | Index, regime | Held spikes | Below 60th | 60th–85th | 85th and above |
  |---|---|---|---|---|
  | NIFTY, VIX 13+ | 168 | under 35 (101) | 35–45 (41) | 45+ (26) |
  | NIFTY, VIX below 13 | 32 | under 32 (19) | 32–36 (8) | 36+ (5) |
  | SENSEX, VIX 13+ | 85 | under 126 (51) | 126–171 (21) | 171+ (13) |
  | SENSEX, VIX below 13 | 4 | too few | | |

  The owner's "5 minutes after the peak" size is kept for description only, because the peak is not
  known at entry; the category at entry matched the after-peak category for 54 % (NIFTY) and 57 %
  (SENSEX) of spikes.

### Stage 1 — the trading test, no hindsight

- **Widesl** (live shape), first entry the minute after the hold, at three MTM stops per strategy:
  ₹650, ₹1,300 and ₹1,950 (1×, 2× and 3×, owner 2026-10-11), and after each stop one of: R0 re-enter at once (the owner's habit, up to five attempts); R2 wait for
  a give-back of 15 points (SENSEX 54); R3 no entry before 13:30; R4 a stop sized to the premium's
  recent one-minute swings; R5 a 20-minute cooldown; R6 stop after three losing attempts. R1 (wait
  for the signal) is the rule Stage 2 produces.
- **Directional** (live `*_dir_*` shape: ATM straddle sold, one re-entry at cost per leg, exit
  15:28), leg stop 21 % (live), 25 % and 30 %, overall stop scaled with it for this study (₹3,000,
  ₹3,600, ₹4,300; the owner would not use the wider ones live). Two entry categories:
  - **D1, every held spike:** entered once, the minute after the hold.
  - **D2, at a support or resistance level only:** during a held spike, enter when the index reacts
    at a level: in an uptrend it reaches a resistance and is rejected, in a downtrend it reaches a
    support and bounces; and, as a separate variant, when it breaks through the level. Levels (all
    computed from data before the day or before the minute): classic pivots (P, R1, R2, S1, S2);
    previous 1-, 2- and 3-day high and low; daily 20, 50, 100 and 200-day moving averages; the
    first 30 minutes' high and low; round numbers (NIFTY 500s, SENSEX 1,000s); the call and put
    strikes with the most open interest; and the expected move from the 09:20 straddle (open ±
    straddle). Proposed definitions: a touch is within 0.1 % of the level; a rejection is a 1-minute
    close back on the near side within 3 minutes of the touch; a break is a 5-minute close beyond
    the level. Every level's touch count is reported, because with many levels the index is near
    one most of the time.
- **Comparator:** the same strategy entered at random minutes matched on time of day.
- **Read-out:** per index × VIX regime × size category, expiry days separately; cells with fewer
  than 20 spikes reported as inconclusive; rupees at cost 0 and at ₹20 per order; R0's ladders that
  overlap on the same day are counted once.

### Stage 2 — reverse engineering the true top

- **Candidates:** every new higher high of the straddle during a held spike.
- **Label, with hindsight:** a true top if the straddle makes no higher high before giving back 15
  points (SENSEX 54) and a Widesl sold the next minute with the ₹650 stop is not stopped. The owner
  expects 60–70 % of candidates to be false.
- **Parameters at each candidate,** from data up to that minute only:
  1. Straddle: velocity, acceleration, minutes the rise has been slowing, give-back from the high,
     rise so far, minutes since the spike began, number of higher highs so far.
  2. Opposite breakdown on NIFTY, Bank Nifty and VIX: if the index rose during the spike, a break
     of its last 10-minute low; if it fell, of its last 10-minute high; on 1- and 5-minute bars.
  3. Direction of the expiry's ATM implied volatility over the last minutes.
  4. Neighbour straddles one strike either side turning with it.
  5. Far out-of-the-money options, strike fixed at the spike's start: 8 strikes out, and the nearest
     round strike (multiple of 500 NIFTY, 1,000 SENSEX). Call and put separately: change since the
     spike began (points and percent), velocity, acceleration.
  6. Open-interest change of the ATM and far options (exchange snapshot about every 3 minutes),
     including at the reversal: does OI keep rising as the straddle turns (writers adding)?
  7. Option volume at the reversal: ATM call and put volume and the whole nearest-expiry chain's
     volume in the minutes around the candidate, against the spike's own average. Index bars carry
     no volume and futures start only in September 2026, so option volume is the measure.
  8. Other indices: Bank Nifty, Fin Nifty and Midcap Nifty index moves (all periods); their rolling
     straddles (2025 only, monthly expiry).
  9. Context: time of day, days to expiry, VIX regime, size category, and whether the index is at
     one of the D2 levels.
- **Method:** one table per parameter, true tops against false; a parameter that looks the same in
  both is dropped; parameters are added one at a time, never all combinations. Discover on 2022–24,
  check on 2025; parameters that exist only in 2025 are discovered on January–April and checked on
  May–August, and their evidence is labelled weaker. One rule is frozen, becomes R1 in Stage 1, runs
  once on P1, then as trigger T5 in the nightly scoring.

### Data coverage

| Input | 2022–24 | 2025 |
|---|---|---|
| NIFTY options, 1 minute, with OI | yes | yes |
| SENSEX options | no near expiry | yes |
| Bank Nifty, Fin Nifty, Midcap Nifty options | no near expiry | monthly expiry only |
| Their index bars, 1 minute | yes (Midcap from July 2022) | yes |
| India VIX, 1 minute | yes | yes |
| Far OTM strikes (NIFTY ±400/500, SENSEX ±800/1,000) | traded every minute on samples | yes |
| Option volume, 1 minute | yes | yes (zero-volume carried bars excluded) |
| Index volume / futures | no / no | no / no (futures from 2026-09-23) |
| Daily closes for moving averages | from 2015 (built from 1-minute bars) | yes |

### Decided and open (2026-10-11)

Decided: VIX regimes reported both two and three ways; Widesl stops ₹650 / ₹1,300 / ₹1,950;
Directional overall stop scaled with the leg stop for the study; Directional categories D1 and D2;
option volume and OI change at the reversal added to Stage 2.

Open:
1. Breakdown: the last 10 minutes' low or high on 1- and 5-minute bars, or another definition?
2. True top: both conditions (no higher high, and the Widesl sold next is not stopped), or one?
3. D2 level list and the touch / rejection / break definitions above, or a shorter list?
4. Order: Stage 1 first, then Stage 2, as the owner said.

## Stage 1 — registered 2026-10-11 (P2 + P3 only)

Frozen before any Stage 1 outcome is read. The owner said "continue" to the draft's defaults:
the breakdown definition, the true-top label, the D2 level list and definitions, and Stage 1
before Stage 2. P1 stays unread. On the learning periods this stage screens; the keep decision
comes later, once, on P1.

- **Events.** Held spikes from `research/bl091/sustained.py`: NIFTY ≥ 25, SENSEX ≥ 90 points above
  the low, held 5 consecutive minutes. First entry = the minute after the hold completes; events
  whose entry would be 15:13 or later are dropped. **Primary:** the first held spike of each
  index-day (54 NIFTY 2025, 66 NIFTY 2022–24, 53 SENSEX 2025). **Secondary:** every held spike as
  its own event, clustered by day.
- **Categories** (frozen; level above the low when the hold completes, points):

  | Index, VIX at open | 60th pct | 85th pct |
  |---|---|---|
  | NIFTY, two regimes: below 13 / 13+ | 31.8 / 35.2 | 36.0 / 44.6 |
  | NIFTY, three regimes: below 11 / 11–13 / 13+ | 30.7 / 31.8 / 35.2 | 34.0 / 37.5 / 44.6 |
  | SENSEX, 13+ (lower regimes 1–4 spikes, pooled into one inconclusive cell) | 126.3 | 170.6 |

- **Arms (18 in Stage 1a).** Widesl, the live `{N|S}_wide_1202` shape, MTM stop ₹650, ₹1,300 or
  ₹1,950, each with five re-entry rules after an overall stop at minute m (at most 5 attempts, no
  entry at or after 15:13, the ladder ends when an attempt is not overall-stopped):
  R0 enter at m+1; R2 enter the minute after the rolling straddle has given back ≥ 15 points
  (SENSEX 54) from its running high since the first entry; R3 enter at the later of m+1 and 13:30;
  R5 enter at m+20; R6 as R0 with at most 3 attempts. R1 is Stage 2's output. R4 (a stop sized to
  recent swings) is dropped: the owner's three fixed stops test the same question. Directional D1,
  the live `{N|S}_dir_1202` shape, entered once at the first entry minute, leg stop / overall stop
  21 % / ₹3,000, 25 % / ₹3,600, 30 % / ₹4,300.
- **Stage 1b (registered now, runs after its level code is built and checked):** Directional D2 at
  the same three stops, entered the minute after the first qualifying reaction at a level during
  the held spike (from the hold to 15:12). Trend = sign of the index move from the spike's low
  minute to the hold minute. Rejection: the index comes within 0.1 % of a level on the trend side
  (resistance when rising, support when falling) and a 1-minute close is back on the near side within
  3 minutes. Break (separate variant): a completed 5-minute bar closes beyond the level in the trend
  direction. Levels, all known before that minute: classic pivots P, R1, R2, S1, S2 from the
  previous day; previous 1-, 2- and 3-day high and low; daily 20, 50, 100, 200-day simple moving
  averages of closes; the 09:15–09:45 high and low (from 09:45); round numbers (NIFTY multiples of
  500, SENSEX 1,000); the call and put strikes with the most open interest at the latest snapshot;
  the open ± the 09:20 ATM straddle. Each level's touch count is reported.
- **Comparator.** For each event, the same arm on the 10 nearest days of the same index and period
  with no held spike (5 before, 5 after), entered at the same first-entry minute with the same rule
  (R2's running high counted from that minute). Event minus placebo mean per event; t over events
  (primary) or over day means (secondary).
- **Engine and money.** Legwise engine, `lot_sizing: current`, sizing date 2026-10-12, early
  reference wrapper for 2022–24; rupees per strategy at cost 0 and at ₹20 per order.
- **Read-out.** Per arm: events, mean rupees on event days, mean on placebo days, the difference and
  its t, share of events with a held attempt, mean attempts, worst event; by index × period, by VIX
  regime (two and three) × category, and expiry days separately. Cells under 20 events are marked
  inconclusive. The last two years decide (NIFTY 2025, SENSEX 2025); 2022–24 is information.
- **Screening bar (learning periods).** An arm goes forward to P1 if its event-minus-placebo
  difference is positive with t ≥ 2 in NIFTY 2025, same sign in NIFTY 2022–24, and its mean at ₹20
  per order is positive. Nothing else is tuned; every arm is reported.
- **Will not run:** other stops, rules, thresholds, hold lengths, levels or tolerances; P1.

## Stage 2 — registered 2026-10-11 (P2 + P3 only)

Frozen before any Stage 2 outcome is read; the owner asked for the work to continue overnight with
small decisions taken and logged.

- **Candidates.** Every held spike (all of them, clustered by day). A candidate is a minute t from
  the hold minute to the spike's end at which the rolling straddle makes a new high (above every
  earlier minute of the spike), with t ≤ 15:12 so a sale at t+1 is possible.
- **Label (hindsight, for labelling only).** True top if (a) after t the straddle falls to its value
  at t minus 15 points (SENSEX 54) before it exceeds its value at t, by 15:28; and (b) the live
  Widesl with a ₹650 MTM stop sold at t+1 is not overall-stopped. Reported: share of candidates that
  are true tops, and labels (a) and (b) separately.
- **Parameters at t (data stamped ≤ t only):**
  1. Straddle: 3-minute velocity, 3-minute acceleration (this 3 minutes' change minus the previous
     3 minutes'), consecutive minutes of falling 1-minute change, rise so far, deepest pullback so
     far within the spike, minutes since the spike's low, number of new highs so far.
  2. Opposite breakdown in the last 3 minutes (trend = sign of the index move from the spike's low
     to t): own index 1-minute close beyond its previous 10 minutes' low (rising) or high (falling);
     the same on the last completed 5-minute bar against the previous two; Bank Nifty against the
     same trend; VIX 1-minute close below its previous 10 minutes' low.
  3. ATM implied volatility approximated as straddle ÷ (0.8 × forward × √time to expiry), forward =
     strike + call − put; its 5-minute change.
  4. Neighbour straddles one strike either side of the current ATM: how many have a non-negative
     3-minute change (0, 1, 2).
  5. Far options, strikes fixed at the spike's low minute: 8 strikes out (NIFTY 400, SENSEX 800)
     and the nearest round strike at least that far (NIFTY multiple of 500, SENSEX 1,000), call and
     put: percent change since the spike's low, 3-minute percent velocity.
  6. Open interest: ATM call + put OI percent change over the last 6 minutes; far 8-strike call +
     put OI percent change over the last 6 minutes.
  7. Option volume: nearest-expiry chain volume in the last 3 minutes ÷ (3 × its average per minute
     since the spike's low); the same for the ATM pair.
  8. Other indices: Bank Nifty, Fin Nifty, Midcap Nifty 3-minute percent move in the trend
     direction. Their rolling straddles are not built in this run (2025-only data, new loader
     needed); recorded as not done.
  9. Context: minute of day, days to expiry, VIX at the open, size category, and whether the index
     is within 0.1 % of a Stage 1b level.
- **Method.** For each parameter: median among true and false tops and the AUC (the chance a random
  true top has a higher value than a random false one; 0.5 = no information), with a day-shuffled
  permutation check (200 shuffles, seed 91). NIFTY: discover on 2022–24, check on 2025. SENSEX:
  discover January–April 2025, check May–August 2025 (weaker, labelled so). A parameter
  **separates** if its AUC is ≥ 0.60 or ≤ 0.40 in discovery with permutation p < 0.05, and on the
  same side of 0.5 by at least 0.05 in the check.
- **From parameters to a rule.** If at least one NIFTY parameter separates: take the one with the
  largest discovery AUC distance from 0.5; its threshold is the discovery value that maximises (true
  tops kept share − false tops kept share); a second parameter is added only if it separates on the
  candidates the first keeps. That rule is R1: Widesl entries and re-entries only at candidates
  where it fires, run with the Stage 1a machinery at the three stops and judged against R0 and the
  comparator. If none separates, Stage 2 reports that and stops.
- **Will not run:** other thresholds, windows, label definitions or parameter forms; P1.

## Log

- 2026-10-10 — Owner requested adding premium-momentum parameters to the widget proposal and
  a backlog analysis to verify them historically. Created P2 / Planned; index updated. No
  experiment, sweep, live collector, alert or strategy change run. Phase 0 remains a draft
  until start-time questions are resolved and its finite configuration is committed.
- 2026-10-10 — Owner placed Straddle-Premium Expansion Exhaustion in Live only as a standalone
  widget. Updated the UI reference; historical study scope, P2 / Planned status and evaluation
  protocol remain unchanged. No study or product implementation started.
- 2026-10-10 — Renumbered BL-084 → BL-091 (number taken on `main`); amendments A–D appended from the two
  Live widget sections of the proposal. Still Planned; nothing run.
- 2026-10-10 — Owner answered open questions 1 and 3 (section E): rolling ATM series, episodes of
  ≥ 25 points and decay of ≥ 15 points in points only, learn on P2 + P3 and test once on P1, the
  re-entry habit (₹500–650 per lot, four lots) as the baseline trade test with arms R0–R5, and the
  attempts as the labels the parameters are judged against. Still Planned; nothing run.
- 2026-10-10 — PR #169 review: Phase 0 gate split into exploration (section E) and P1/forward
  stages; periods bullet replaced by the E.3 split; P1 described as not pristine; switch handling
  fixed (spliced series for episodes, reset for derivatives); stop restated as ₹2,000 on four lots
  with `lot_sizing: current`; R-arm keep rule given a floor, a bound and a time-matched comparator;
  C-arm rules assigned to stages.
- 2026-10-11 — Phase 1 started: `research/bl091/` (periods, series, episodes, r0, census, replay_r0,
  summarise, selfcheck) and `research/common/early_ref.py` committed before any run. Resolutions of
  the episode wording, recorded as resolutions and not thresholds: (1) a decay is final at 15:28, or
  earlier when a fresh ≥ 25-point rise starts from the pause's low without exceeding the old high (a
  new high first means the episode resumed); (2) a third outcome `no_pause` for episodes that never
  gave back 15 points; (3) both the minute of the high and the minute the 15-point give-back was
  reached are recorded; (4) an episode starts at the last minute at its low; (5) a trigger at or
  after 15:12 is counted but gets no attempt (entry would be 15:13 or later); (6) the spot path
  after the high is `stalled` within one strike step, else `continued` or `reversed` against the
  direction of the rise; (7) the horizon is the completed 15:28 bar, while the engine's 15:28 exit
  fills at the 15:27 bar's close. Rupees reported at the engine's cost 0 and at an assumed ₹20 per
  order. P1 and 2025-08-30 → 2025-12-02 are refused by `periods.assert_learning_day`; self-check 10
  tests it.
- 2026-10-11 — Smoke run (3 days per period, 9 index-days; census only, no outcome table read) found
  two construction problems, fixed before the full run. (1) **The spliced series drifts down at
  every strike switch.** The pair just left is the nearer one, so the dropped gap has one sign; over
  30–90 switches a day it adds up (SENSEX 2025-01-10: rolling straddle −143 points to 14:11, spliced
  −261; NIFTY 2025-01-13 −69 against −110). Episodes therefore use the rolling ATM straddle itself
  (`series.level`), which is also the owner's definition ("the 24,000 straddle at 159 … the 24,100
  straddle at 180"); the spliced total stays in `days.csv` as a diagnostic. E.1 and self-checks 3, 4,
  5 and 7 updated. (2) **Expiry-day settlement window.** From 15:00 on an expiry day the options price
  the settlement average, not the live index, so the index-ATM pair is not at the money (SENSEX
  2025-01-14 15:21: index 76,580, the 76,600 put trading at 97–100, i.e. settlement near 76,500); the
  rolling straddle then jumps at a switch on real trades. The ATM rule is unchanged (engine, AlgoTest
  and the 5-minute derived series all use the index); such episodes are flagged `settlement_window`
  and counted separately. Also added, as A.7 asked: each leg is priced from its last real trade at
  most 5 minutes old (the vendor files repeat old closes as zero-volume bars); it did not change the
  smoke-run episodes. All self-checks pass again (12 with the new 5b).
- 2026-10-11 — Phase 1 census and R0 replay run on P2 + P3 (932 index-days, 1,450 episodes, 1,318
  replayed, 0 errors). Counts only, in the Result section; no rule chosen; P1 unread.
- 2026-10-11 — PR #174 review: the replay's resume key now includes the trigger minute; the overlap
  check uses the latest exit of every earlier ladder; episodes are scanned from the first priced
  minute; the settlement flag covers a high at or after 15:00; a non-overlapping per-episode table
  added. Census unchanged (1,450 episodes), R0 unchanged; overlap counts and the settlement count
  moved slightly (numbers above updated). R0's stale-price fills recorded as a limitation.
- 2026-10-11 — Owner's report (https://claude.ai/artifact/F7D8uTkuio8hwFoHgAPnth, numbers from
  `research/bl091/report_data.py`). Descriptive cuts looked at on P2 + P3, recorded here as looks
  per E.3: R0 per spike by number of attempts (1–5), by expiry day or not, by time of the spike
  (before 11:00 / 11:00–13:00 / after 13:00), held rate by attempt number, average stopped and held
  attempt, and the monthly share of NIFTY days with a 25–40 or 40+ point spike. Observations, not
  rules: five-attempt ladders lost about ₹4,500 per Widesl; most of R0's profit is on expiry days;
  an average ₹650 stop cost ₹930–1,050. Proposed to the owner for Phase 2, not registered: an arm
  that stops after three losing attempts, and a SENSEX threshold of its own.
- 2026-10-11 — Owner's refinement (exploration on P2 + P3, `research/bl091/sustained.py`; the script
  was run before it was committed, recorded here): a spike counts only if the rolling straddle stays
  at least the threshold above its low for 5 consecutive minutes; thresholds per index, NIFTY 25 and
  SENSEX 90 points (episode split level scaled to 15 and 54); size for a top-10 % cut = the straddle 5
  minutes after the peak minus the low. Looks taken: held vs not held counts, size percentiles (P50 /
  P75 / P90) by period and index, band counts (NIFTY 25–30 / 30–40 / 40–45 / 45+, SENSEX 90–190 /
  190+) by both the post-peak and the peak measure. Counts: NIFTY 2025 92 of 163 spikes held 5
  minutes (58 days), 2022–24 108 of 212 (80 days), SENSEX 2025 89 of 132 (55 days). P90 of the
  post-peak size: NIFTY 73 (2025), 63 (2022–24), 68 both; SENSEX 269. Band edges for Phase 2 are the
  owner's to confirm; nothing registered yet.
- 2026-10-11 — Owner chose three categories by percentile of held spikes: below the 60th, 60th–85th,
  85th and above, and noted that the peak is not known at entry. Look taken: P60 / P85 of the level
  when the 5-minute hold completes (known live) and of the post-peak size, pooled per index. Live
  measure: NIFTY P60 35, P85 44 points; SENSEX 127 and 170. Post-peak: NIFTY 37 / 59, SENSEX 131 /
  209. The live category equals the after-peak category for 54 % of NIFTY and 57 % of SENSEX spikes,
  so the size at entry says little about the size the spike will reach. Not registered yet.
- 2026-10-11 — Owner: the percentile cuts should differ by VIX regime at the open (below 11, 11–13,
  13 and above). Look taken: held spikes, share of days with one, and P60 / P85 cuts per VIX band.
  NIFTY share of days with a held spike: 2025 13 % (VIX 11–13) vs 47 % (13+); 2022–24 10 % (<11),
  9 % (11–13), 15 % (13+). Held spikes per band, both periods: 5 (<11), 27 (11–13), 168 (13+); SENSEX
  1 / 3 / 85. Cuts on the level at hold completion: NIFTY 11–13 P60 32 / P85 38, 13+ 35 / 45; SENSEX
  13+ 126 / 171. Below VIX 11 there are too few spikes for a percentile. Not registered yet.
- 2026-10-11 — Owner's plan for the next stages, not yet registered (the owner will restate it):
  Stage 1, the trading test with no hindsight (enter after a spike holds 5 minutes, re-entry rules
  R0–R6, time-matched random comparator, by VIX regime and percentile category); Stage 2, reverse
  engineering: every new higher high during a held spike is a candidate top, labelled with hindsight
  as true or false, and the parameters at each candidate are compared between the two groups.
  Parameters the owner added: an opposite-direction breakdown on NIFTY, Bank Nifty and VIX (1- and
  5-minute charts; Bank Nifty 1-minute bars exist from 2015), and the far out-of-the-money options
  (about 8 strikes out, and the nearest round strike, a multiple of 500 for NIFTY and 1,000 for
  SENSEX): their price change, velocity and acceleration during the spike, since heavy selling may
  collapse them or fear may lift them. Data check on 7 sample days: NIFTY ±400 / ±500 and SENSEX
  ±800 / ±1,000 strikes traded every minute in 2022–25; NIFTY's are ₹1–25 the day before expiry, so
  changes are measured in percent as well as points.
- 2026-10-11 — Owner added: the rolling ATM straddles of other indices (Bank Nifty, Fin Nifty,
  Midcap Nifty) at the same minutes, since the market moves together and the less liquid ones may
  show the collapse first. Data check: their option files before October 2024 hold only long-dated
  contracts (nearest expiry 2–19 months out on samples), so no usable near-expiry straddle in
  2022–24; in 2025 only monthly expiries exist (weeklies ended November 2024), nearest 0–30 days
  out. Their 1-minute index bars cover all periods (Bank Nifty from 2015, Fin Nifty 2017, Midcap
  Nifty July 2022). Not registered yet.
- 2026-10-11 — Owner asked whether open-interest change can be tested. It can: every option bar
  carries OI in 2022–25 (vendor) and in the Fyers collection, and on the ATM contracts checked it
  changes on 123–124 of 375 minutes, i.e. the exchange's snapshot about every 3 minutes. Proposed
  parameter for Stage 2: OI change of the ATM and far out-of-the-money calls and puts during the
  spike (writers adding positions as premium is sold), at 3-minute resolution. Not registered yet.
  Disclosure: this data check also counted OI presence in two P1 files (2026-09-25, 2026-10-08);
  only row and OI counts were read, no prices or outcomes.
- 2026-10-11 — Owner added the Directional template to Stage 1: if the move continues after the
  spike, the threatened leg stops and the other keeps decaying. Proposed arms: the live `*_dir_*`
  shape (ATM straddle sold, 1 lot per leg, one re-entry at cost per leg, ₹3,000 overall stop, exit
  15:28) entered once, the minute after the 5-minute hold completes, with the leg stop at 21 % (live),
  25 % and 30 %, all three reported. Open point: whether the ₹3,000 overall stop stays when the leg
  stops widen. Context: BL-083 found Dir gained after trend triggers in 2024–26 but not in 2022–24.
  Not registered yet.
- 2026-10-11 — Consolidated the post-Phase-1 discussion into "Next stages — consolidated draft";
  cut points for VIX below 13 computed (NIFTY 32 / 36 on 32 spikes). Five open points listed for
  the owner. Not registered.
- 2026-10-11 — Owner decisions folded into the draft: Widesl at three stops (₹650 / ₹1,300 /
  ₹1,950); VIX reported with two and three regimes; Directional overall stop scaled for the study;
  Directional second category D2 (enter on a rejection at, or a break of, a support / resistance
  level); option volume and OI change at the spike's reversal added to Stage 2. Data check: index
  bars have no volume in any period, futures start 2026-09-23, option volume exists 2022–25.
- 2026-10-11 — Stage 1 registered (section "Stage 1 — registered"): owner said "continue" to the
  draft's defaults. Cut points frozen from spike sizes only (no outcomes read). R4 dropped in favour
  of the three fixed stops. Stage 1a (Widesl × 3 stops × 5 rules, Directional D1 × 3) runs first;
  Stage 1b (D2 levels) after its level code is checked.
- 2026-10-11 — Stage 1a run (49,824 runs, 0 errors; checks passed, Directional at 11:32 reproduces
  the stored results). No arm passes the screening bar: in 2025 every arm did worse after a held
  spike than at the same minute on the 10 nearest non-spike days (NIFTY −₹166 to −₹1,259 per spike,
  several t ≤ −2; SENSEX the same direction); 2022–24 small and mixed. Among spike-day choices,
  R3 (no re-entry before 13:30) was best or near best in all three groups (₹650: +₹846 NIFTY 2025,
  +₹628 2022–24, +₹735 SENSEX) with the smallest worst spike; R6 (cap at 3 attempts) was worst in
  NIFTY 2025 (+₹39). Wider Widesl stops cut attempts but deepened the worst spikes. Directional D1
  lost in 2025 at 21 %. Full tables: `research/bl091/out/stage1.md`; the owner's report follows.
- 2026-10-11 — Stage 2 registered (section "Stage 2 — registered") with small decisions logged
  there: candidates start at the hold; give-back replaced by the deepest pullback so far; IV by the
  straddle approximation; other indices' straddles not built in this run.
- 2026-10-11 — Stage 1b run (11,769 runs; checks passed: pivots and previous highs / lows on a
  hand-made table, no same-day or post-P2 daily bars). On the first spike of each day a rejection
  entry fired for 49 of 54 NIFTY 2025 spikes, a median 2 minutes after the hold (median 9 levels on
  the trend side, 3–4 touches per spike), so D2-rejection is close to D1. No D2 arm passes: NIFTY
  2025 −₹716 to −₹840 against the comparator (t −1.5 to −1.9), SENSEX negative, NIFTY 2022–24
  slightly positive (t ≤ 0.9). Looks taken and recorded: results by the level family that fired
  (D2 at 21 %): previous-day high / low did best (rejection +₹1,213 on 16, break +₹3,283 on 11),
  the opening range worst (−₹698 on 20, −₹997 on 17); samples too small to act on.
