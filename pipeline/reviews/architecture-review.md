ARCHITECTURE REVIEW REPORT — M5 (S/R Signals, Multi-Index, Optimizer)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Reviewer lens: BACKEND + INFRA (both tags set)
Scope: git diff c1b5b48c56ddc564b09b70b6a1543313461e15f8..HEAD, substantive files only.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


FINDING: Straddle-calc uses Thursday formula for all underlyings — BANKNIFTY and SENSEX symbols built wrong every session
Severity: High
File or area: src/ingestion/straddle-calc.ts:26,301 / src/ingestion/brokers/instrument-registry.ts:264
What it is:
  straddle-calc.ts imports and calls getCurrentExpiry (the synchronous Thursday-formula
  function) at every 15-second snapshot for ALL underlyings. getCurrentExpiry always
  returns the nearest Thursday, regardless of the underlying parameter (the parameter
  is named _underlying and not used). BANKNIFTY weekly options expire on Wednesday;
  SENSEX weekly options expire on Friday. The wrong expiry date is embedded in every
  option symbol string built for these two indices: every CE and PE symbol constructed
  by the straddle calculator for BANKNIFTY and SENSEX carries a Thursday expiry date
  while the broker instrument master and exchange list them with Wednesday/Friday expiry
  dates respectively. The S/R detection engine and any downstream code that builds
  symbols for these underlyings from straddle.values stream messages will also receive
  incorrect symbol data.

  This is not a holiday-shifted-week edge case — it fires on every normal trading session
  the moment BANKNIFTY or SENSEX is in the active INDICES list. The index.ts startup
  assert (assertUnderlyingReadiness) uses getCurrentExpiryFromCalendar (correct) for its
  symbol validation, so the startup check passes cleanly while the runtime symbol-building
  uses the wrong path. The two sources of truth diverge immediately after startup.

Why it matters:
  A straddle position built on a Thursday expiry symbol for BANKNIFTY when the correct
  expiry is Wednesday will fail to subscribe to valid option data from the broker (wrong
  symbol = no ticks = zero straddle values). The simulator will produce output, masking
  the problem in SIMULATE mode; the bug surfaces only in LIVE mode. All S/R levels built
  from zero-or-wrong straddle values for these underlyings will be meaningless.
  retrospection data will be polluted with structurally wrong symbol positions.

Recommendation:
  straddle-calc.ts must use calendar-driven expiry for each underlying. The cleanest
  resolution is to make createStraddleCalculator accept an optional pre-resolved
  expiry date (injected from index.ts which already calls getCurrentExpiryFromCalendar
  at startup), and refresh it only when a new expiry week starts (comparing clock.today()
  to the cached date). The hot 15-second path can then read an in-memory cached Date
  rather than calling an async DB function per snapshot. This eliminates the dual-source
  problem without adding DB round-trips to the hot path.

  Alternatively, if the synchronous constraint on the hot path cannot be relaxed, cache
  the DB-resolved expiry in a module-level variable that index.ts updates before starting
  the straddle calculators and again when a new week begins (detected via a once-daily
  timer).

  Do not leave getCurrentExpiry in straddle-calc.ts for BANKNIFTY or SENSEX. It is
  structurally incorrect for any underlying whose expiry weekday is not Thursday.


FINDING: EOD job calls runEvolutionEngine for all active personalities including sr_anchored — throws and logs an error for every Levelhead run
Severity: High
File or area: src/jobs/eod-retrospection-job.ts:148-150,244 / src/retrospection/evolution-engine.ts:457-473
What it is:
  The EOD job fetches ALL active personalities at step 3 using:
    SELECT id FROM personality_configs WHERE is_active = TRUE
  It then calls runEvolutionEngine for each one unconditionally. Inside
  runEvolutionEngine, the SELECT FOR UPDATE is scoped to entry_type='momentum_exhaustion'.
  When a Levelhead personality (entry_type='sr_anchored') is passed, the locked set
  does not contain it, and the engine throws:
    "personality X not found in momentum_exhaustion group"

  This error is caught by the per-personality try/catch at line 289 and logged as
  console.error. So the retrospection row is written correctly (step 5e ran before
  step 5f), but the error log will fire for EVERY Levelhead personality on EVERY EOD
  batch run — generating persistent false-alarm noise in the production log stream.

  The optimizer (runOptimizer) handles this correctly by returning
  { action: 'none', reason: 'entry_type_excluded:sr_anchored' } without throwing.
  The evolution engine does not have the same pre-flight exit.

Why it matters:
  Persistent "personality X not found" errors in the EOD log make it difficult to spot
  genuine failures. When the on-call operator sees this error, they cannot distinguish
  "Levelhead is sr_anchored (expected)" from "Levelhead row was accidentally deleted"
  without reading source code. Over time, this produces alert fatigue on an error pattern
  that is purely a structural defect in the caller, not a data issue. If Levelhead is
  ever moved out of the comparison group by mistake, the error signature will be
  indistinguishable from the noise.

Recommendation:
  Add an entry_type pre-filter in the EOD job before calling runEvolutionEngine:
    if (personality.entry_type === 'momentum_exhaustion') {
      await runEvolutionEngine(pool, personality.id, ...);
    }
  Or, symmetrically, add the same early-return that the optimizer already has to
  runEvolutionEngine itself (before entering any transaction):
    if (entry_type !== 'momentum_exhaustion') return { action: 'none', reason: 'entry_type_excluded' }
  The optimizer approach is cleaner because it makes the function defensive against any
  caller, not just the EOD job.


FINDING: signal_type='PULLBACK' overloaded as SR_REVERSAL transport — converse guard correct but comment at line 262 is stale and creates maintenance risk
Severity: Medium
File or area: src/signals/personality-filter.ts:260-312 / src/signals/sr-detection-engine.ts:157-172 / src/db/migrations/012_sr_signals.sql
What it is:
  S/R signals are written with signal_type='PULLBACK' and sr_subtype='SR_REVERSAL'.
  The overloading is documented and deliberate (the CHECK constraint only allows
  MOMENTUM_EXHAUSTION, SCHEDULED, PULLBACK). The converse guard at Stage 1 is
  structurally correct: an SR_REVERSAL signal is rejected for every non-sr_anchored
  personality, and a non-SR PULLBACK (from scheduled-signal-emitter.ts) is accepted
  by momentum_exhaustion and any_signal personalities. The two gates fully partition
  the signal space with no gap or double-rejection.

  However, the comment at line 262 still reads:
    "any_signal personalities (Scanner, Blitz) accept all three types"
  After the converse guard was added, any_signal personalities NO LONGER accept all
  three raw signal_type values uniformly — they accept MOMENTUM_EXHAUSTION, SCHEDULED,
  and PULLBACK only when sr_subtype != 'SR_REVERSAL'. The "three types" claim is now
  wrong for the SR_REVERSAL subcase. This is a comment accuracy issue, not a logic bug,
  but stale comments on security-relevant routing logic create maintenance hazards.

  The deeper architectural question (as asked): is using PULLBACK as the transport
  for SR_REVERSAL the right long-term call? The answer depends on whether the
  retrospection system will need to query signals by type independently of subtype.
  The current schema supports this via sr_subtype, but every JOIN on straddle_signals
  that groups by signal_type will conflate PULLBACK pullbacks and PULLBACK SR_REVERSALS
  unless the query also filters on sr_subtype IS NULL / IS NOT NULL. This is a latent
  query-correctness trap for anyone writing retrospection or reporting queries.

Why it matters:
  The comment is wrong today. A developer adding a new personality type that "should
  behave like any_signal" will read line 262 and assume their personality will accept
  SR_REVERSAL signals — it will not. The retrospection reporting risk is separate: any
  GROUP BY signal_type aggregate that does not also condition on sr_subtype will mix
  two semantically different signal populations in the PULLBACK bucket.

Recommendation:
  Short term: Fix the comment at line 262 to accurately describe the effective routing
  after the converse guard. Something like:
    "any_signal personalities accept MOMENTUM_EXHAUSTION, SCHEDULED, and non-SR
    PULLBACK; SR_REVERSAL PULLBACK is blocked by the converse guard below."

  Long term (can be deferred to Phase 2): Add 'SR_REVERSAL' as a first-class value to
  the signal_type CHECK constraint. TEXT + CHECK is fully transactional (as migration
  012 correctly notes for sr_subtype). Adding 'SR_REVERSAL' to the straddle_signals
  signal_type CHECK in a new migration eliminates the subtype-disambiguation requirement
  in retrospection queries and makes signal routing logic in the filter trivially readable.
  The converse guard becomes a simple signal_type check rather than a dual-field check.


FINDING: Margin Rule 4 open-leg count is cross-underlying but uses only the new trade's underlying lot size — produces structurally inconsistent margin estimates in multi-index mode
Severity: Medium
File or area: src/trading/portfolio-risk.ts:263-267
What it is:
  Rule 4 queries all open legs with no underlying filter:
    SELECT COUNT(*) AS cnt FROM paper_trades WHERE status = 'open'
  It then computes estimated_margin = openCount * newTrade.straddleValue * 1 * lotSize * rate
  where lotSize is the lot size for the NEW trade's underlying (not the existing open positions).

  Concretely: if one NIFTY leg (lotSize=50) and one BANKNIFTY leg (lotSize=15) are open,
  and a SENSEX entry is proposed:
    openCount = 2
    lotSize = LOT_SIZES['SENSEX'] = 10
    estimated_margin = 2 * sensexStraddleValue * 1 * 10 * 0.2
  This uses the SENSEX lot size for NIFTY's capital usage, producing an underestimate.
  Conversely, a new NIFTY entry against two open SENSEX legs overestimates.

  The formula was correct in Phase 1 (single underlying) where all open legs were NIFTY
  with lotSize=50. In multi-index mode the mismatch is structural but bounded: this is
  a margin safety check, not an accounting record (as the comment acknowledges), and the
  conservatism in using the current straddle value for all open positions offsets some of
  the lot-size error.

Why it matters:
  With three indices each running 10 personalities, the cross-underlying open count can
  reach 30+ simultaneously. If SENSEX (lotSize=10) is cheap to margin and NIFTY (lotSize=50)
  is expensive, the formula can underestimate margin usage and fail to block a NIFTY trade
  that would breach actual capital reserves. The deferred global circuit-breaker (T-50)
  is the correct long-term fix; this finding flags that the interim state has a structural
  blind spot specifically in the margin calculation that was not updated with the multi-index
  expansion.

Recommendation:
  In the same migration or as a follow-on task, scope the margin query to the specific
  underlying or compute a per-underlying open count multiplied by its own lot size:
    SELECT u.underlying, COUNT(*) AS cnt
    FROM paper_trades pt
    JOIN (SELECT DISTINCT underlying FROM paper_trades WHERE status = 'open') u ON pt.underlying = u.underlying
    WHERE pt.status = 'open'
    GROUP BY u.underlying
  Then sum margin contributions across underlyings using the correct lot size per
  underlying. Alternatively, for the interim, note this limitation explicitly in the
  code comment alongside the T-50 TODO so the risk is visible to future maintainers.


FINDING: EOD optimizer hardcodes BACKTEST_UNDERLYING='NSE:NIFTY50-INDEX' for all personalities regardless of which index the personality trades
Severity: Medium
File or area: src/retrospection/optimizer.ts:192,735
What it is:
  The optimizer backtest always uses BACKTEST_UNDERLYING = 'NSE:NIFTY50-INDEX' when
  building the BacktestConfig passed to createBacktestRunner. The code comment at line
  86-87 acknowledges this: "underlying defaults to 'NSE:NIFTY50-INDEX'. The EOD job
  passes no override today."

  In Phase 1 with only NIFTY personalities, this is correct by accident. In M5 with
  BANKNIFTY and SENSEX personalities potentially evolving, the optimizer will score
  a BANKNIFTY personality against NIFTY historical straddle data. The training Sharpe
  produced will be from the wrong market entirely, and the resulting min_probability
  proposal will be statistically invalid for the BANKNIFTY personality.

  The current min-sample gate (MINIMUM_SAMPLE_STABLE=200 rows) and the is_frozen check
  are correctly in place, but neither guards against the wrong underlying being used as
  the scoring data source.

Why it matters:
  A min_probability tuned to NIFTY's volatility characteristics applied to a BANKNIFTY
  personality (which has higher notional volatility and different signal dynamics) will
  be systematically miscalibrated. In autonomous mode (EVOLUTION_REQUIRE_APPROVAL=false),
  this could silently degrade BANKNIFTY's parameters over time. In approval mode (the
  safer default), proposals will be wrong and mislead the operator.

Recommendation:
  The personality_configs row should carry an explicit underlying field (or the EOD
  job should pass the personality's configured underlying to runOptimizer). For now,
  add a pre-flight guard in runOptimizer that returns { action: 'none', reason:
  'multi-underlying_not_supported' } for any personality whose params indicates an
  underlying other than NIFTY. This is safer than silently using the wrong backtest
  data. The comment at line 86-87 should be escalated to a TODO with the T-50 tag so
  it is tracked alongside the other multi-index deferred work.


FINDING: index.ts graceful shutdown stops signal engines before straddle calculators — pending messages in-flight can lose ACK
Severity: Medium
File or area: src/index.ts:472-481
What it is:
  The shutdown sequence is:
    1. positionMonitor.stop()
    2. vixFeed.stop()
    3. peakEngine.stop()      ← signal engines stopped first
    4. srEngine.stop()        ← signal engines stopped first
    5. straddleCalcs.map(stop) ← straddle calculators stopped second
    6. feed.disconnect()
    7. pool.end()
    8. redis.quit()

  SRDetectionEngine and PeakDetectionEngine are Redis Streams consumer-group readers.
  When stop() is called (sets _running=false), the consumer loop exits at its next
  iteration (2-second block window). Any straddle snapshot that arrives between the
  engine's loop exit and straddleCalcs.stop() will be published to straddle.values but
  not ACKed by the engine — it stays in the PENDING list for the consumer group. On
  restart, XAUTOCLAIM will re-deliver these to a fresh consumer.

  The deeper issue is that pool.end() fires before any pending DB writes from the signal
  engines complete. If an engine is mid-way through _emitSignal (has written to the DB
  but has not yet ACKed the Redis message) and SIGTERM fires, pool.end() races with the
  in-flight INSERT. Under heavy load this can produce a partial write followed by a
  duplicate on restart.

Why it matters:
  Re-delivery on restart is acceptable for idempotent operations, but the straddle_signals
  INSERT in _emitSignal is not idempotent — there is no ON CONFLICT DO NOTHING. A restart
  after a partial shutdown during an active signal emission can produce a duplicate signal
  row, which will double-count the signal in retrospection.

Recommendation:
  Reverse the shutdown order for signal engines: stop the straddle calculators (and wait
  for them to drain their pending publishes) BEFORE stopping the consumer-group engines.
  This reduces the window for in-flight message loss. Additionally, add ON CONFLICT DO
  NOTHING (or a unique constraint on (underlying, time) for straddle_signals) to make the
  INSERT idempotent. A partial-write-then-restart scenario then produces a harmless
  duplicate write that is silently discarded rather than a duplicate row.


FINDING: Optimizer Phase B with fixed adjustedProbability=0.7 in backtest runner renders the scoring step non-discriminating within the [0.30, 0.70] shortlist range
Severity: Medium
File or area: src/retrospection/optimizer.ts:36-49,608-650
What it is:
  The optimizer's Phase B scores shortlisted candidates by filtering backtest trades to
  adjustedProbability >= candidate_C. The backtest runner currently assigns a fixed
  adjustedProbability=0.7 to every MOMENTUM_EXHAUSTION signal. As a result:
    - Any candidate C <= 0.70 admits ALL train momentum trades (identical Sharpe for each)
    - Any candidate C > 0.70 admits ZERO trades (ineligible)

  The code explicitly documents this limitation at lines 36-49 and handles it correctly:
  the kernel score from Phase A is used as the tie-breaker when all Phase B candidates
  share the same Sharpe. The optimizer still returns a usable result (the kernel peak),
  just not one that the real backtest discriminated.

  The concern is architectural: Phase A (kernel smoother) and Phase B (backtest) are
  positioned as two separate scoring steps, but Phase B currently adds zero discrimination
  within the [0.30, 0.70] range. The two-phase architecture is sound for when the
  backtest runner is upgraded to emit calibrated probabilities — but right now, calling
  createBacktestRunner in the EOD batch adds DB I/O and computation cost for zero
  additional signal over Phase A alone.

Why it matters:
  The backtest runner is called inside the EOD job for every momentum_exhaustion
  personality on every trading day once MINIMUM_SAMPLE_STABLE rows exist. This is
  potentially 9 backtest runs per EOD job (9 momentum_exhaustion personalities) doing
  365 days of straddle reconstruction, each producing zero discrimination. The budget
  is an EOD non-critical path so the cost is not catastrophic, but it is wasted I/O
  that could cause the EOD job to exceed its 5-minute budget under load.

  Additionally, the SHORTLIST_MIN_TRADES gate (5 trades) means any candidate above
  0.70 that happens to be shortlisted will always return ineligible — this is a
  deterministic result that could be computed cheaply without the backtest.

Recommendation:
  Add a guard in runOptimizer: before calling createBacktestRunner, check whether the
  shortlist contains any candidate above 0.70. If all candidates are <= 0.70, the Phase B
  backtest will produce identical Sharpes for all of them and the tie-breaker (kernel
  score) has already been computed in Phase A. In this case, skip the backtest call
  entirely and return the kernel-peak candidate directly with reason='kernel_only'.
  Document this as a temporary guard that is removed when the backtest runner emits
  calibrated per-signal probabilities. This avoids the EOD budget risk while keeping
  the two-phase structure intact for when Phase B becomes genuinely discriminating.


FINDING: SRLevelType includes 'prev_week_high' and 'prev_week_low' as distinct enum members but contributed[] can contain both simultaneously — minor naming inconsistency
Severity: Low
File or area: src/signals/sr-levels.ts:54, 701-707
What it is:
  SRLevelType is defined as 'prev_week_high' | 'prev_week_low' | 'pivot' | 'poc'.
  The contributed[] array in SRLevelResult is documented as "which level families
  contributed". But prev_week_high and prev_week_low are not independent families
  — they are always produced together from the same prev-week candle query. The
  code at lines 701-707 correctly pushes both types independently ("only add to
  contributed once per family"), and the comment says "both H and L = one
  contribution" but then still pushes both type strings.

  The result is that contributed[] always contains either both 'prev_week_high' AND
  'prev_week_low', or neither — never just one. A caller inspecting contributed.includes('prev_week_high')
  can infer 'prev_week_low' is also present without checking, which makes the type
  redundant for the contributed metadata purpose.

Why it matters:
  This is a naming/design inconsistency. If a future engineer adds per-level filtering
  (e.g., "include only resistance levels, not support"), they will find that contributed[]
  does not accurately reflect the distinction. The poc_used result-level flag correctly
  represents "did the poc family contribute" as a boolean — the same boolean pattern
  would be cleaner for prev_week as well.

Recommendation:
  Introduce a 'prev_week' family label for contributed[] (separate from the SRLevelType
  enum used for individual levels). Keep SRLevelType with four values for level-type
  semantics. In contributed[], replace 'prev_week_high' and 'prev_week_low' with a single
  'prev_week' sentinel. This is a non-breaking internal change (contributed[] is not
  persisted, only included in the level_source JSONB blob for display). Alternatively,
  treat this as a Phase 2 cleanup item and leave a TODO comment.


FINDING: migration 013 seed data requires manual NSE/BSE calendar verification before production use — no automated validation exists
Severity: Low
File or area: src/db/migrations/013_index_expiry_calendar.sql (lines 64-95)
What it is:
  The migration seeds 9 weekly expiry dates per underlying starting from 2026-05-24
  through 2026-07-24. The seeds are computed from weekday formulas (Thursday for NIFTY,
  Wednesday for BANKNIFTY, Friday for SENSEX). The migration comment correctly notes:
  "Before using this calendar in production, verify against the live NSE/BSE instrument
  master file or the exchange's official circular page." All rows are seeded with
  is_holiday_shifted=FALSE and the comment states "No known NSE/BSE holidays fall on
  these dates" with a caveat that the 2026 holiday calendar is not yet widely published.

  The refill reminder mechanism (assertCalendarFreshness + CALENDAR_REFILL_DAYS) warns
  when fewer than 14 days of future expiries remain. With 9 weeks seeded and today at
  2026-05-25, the calendar runs through 2026-07-23/24 — approximately 2 months.
  The CALENDAR_REFILL_DAYS default of 14 days means the operator will first see a
  refill reminder approximately 14 days before 2026-07-24, giving adequate lead time.
  The hard-fail on expired calendar (CalendarExpiredError) is correctly in place.

  The data integrity concern is not the mechanism but the seed data accuracy: if any
  of the seeded dates falls on an exchange holiday (which the code cannot detect at
  migration time), the is_holiday_shifted flag will be FALSE while the actual expiry
  was moved. The straddle calculator (using the Thursday formula) would build symbols
  for the Thursday date while the exchange uses the shifted date.

Why it matters:
  An incorrect is_holiday_shifted=FALSE row means the system builds and subscribes to
  options with the wrong expiry date on a holiday-shifted week. This is not a daily
  failure — it is a once-per-holiday event — but when it does occur, the straddle
  value will be zero (no matching option data) and all personality decisions for that
  session will be based on a zero straddle value.

Recommendation:
  Document in the schema or in a runbook that the expiry calendar requires manual
  verification against the NSE/BSE holiday calendar before each month of new seeds are
  added. Consider adding a CI/CD check (a simple script that fetches the NSE holiday
  calendar and cross-checks seeded dates) as part of the migration test suite.
  Additionally, address the dual-source-of-truth problem (see the High finding above)
  so that even when the calendar data is correct, it is actually used by the
  straddle calculator at runtime.


FINDING: sr-levels.ts has three separate DB queries for the same prev-week window — could be batched but is acceptable for session-start use
Severity: Low
File or area: src/signals/sr-levels.ts:686-736
What it is:
  computeSRLevels makes three sequential DB queries for the previous-week window:
    1. fetchOHLCV for prev-week (open, high, low, close, volume)
    2. fetchOHLCV for prev-month (pivot computation)
    3. fetchTicksForPOC for prev-week (raw tick stream for volume profile)

  Queries 1 and 3 both operate on the same [prevWeekFrom, prevWeekTo) window on the
  market_ticks hypertable. They could be combined into a single query that returns both
  the OHLCV aggregate and the raw tick rows, eliminating one round-trip.

  This is only called once per session start per underlying (lazy-loaded in
  _loadLevels on first snapshot), so the performance cost is negligible in practice.
  The separation also makes each query's logic clear and independently testable. This
  is a low-priority maintainability note, not a runtime concern.

Why it matters:
  At session start the three queries run serially. For 3 underlyings this is 9 DB
  round-trips to the TimescaleDB hypertable. At session start latency this is unlikely
  to matter. If S/R level reload is ever made more frequent (e.g., mid-session reload
  after a half-day session), the sequential structure becomes a bottleneck.

Recommendation:
  No action required now. If S/R level reload frequency increases in Phase 2, consider
  combining queries 1 and 3 into a single CTE that returns both the aggregate and the
  raw ticks in one round-trip. For now, add a comment noting the two queries share
  the same time window so a future refactor is obvious.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SPECIFICALLY ASSESSED SEAMS (as requested)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Signal_type='PULLBACK' + sr_subtype='SR_REVERSAL' overloading
   The converse guard (personality-filter.ts:306-311) is structurally sound and
   verified correct. The two gates fully partition the signal space:
     - sr_anchored receives SR_REVERSAL: passed by gate 1 (sr_anchored requires SR_REVERSAL)
     - sr_anchored receives non-SR: rejected by gate 1 (sr_subtype != 'SR_REVERSAL')
     - non-sr_anchored receives SR_REVERSAL: rejected by converse guard
     - non-sr_anchored receives non-SR PULLBACK: passes both gates
   No gap or double-rejection found. The comment at line 262 is stale (see Medium finding).
   The longer-term schema concern (PULLBACK bucket mixing two populations) is noted
   in the Medium finding.

2. getCurrentExpiry duality (Thursday formula vs. calendar DB)
   This is assessed as a High finding. The dual-source-of-truth is NOT acceptable
   even for Phase 1: BANKNIFTY and SENSEX build wrong option symbols on every session
   when INDICES includes those underlyings. The startup assert validates with the correct
   calendar-based expiry but runtime symbol-building uses the Thursday formula. The
   resolution is to pass the pre-resolved expiry date from index.ts into each straddle
   calculator, caching it in memory and refreshing on week rollover.

3. Optimizer.ts hybrid objective with hardcoded adjustedProbability=0.7
   The abstraction is sound for when the backtest runner is upgraded. The Phase B
   backtest call in the current state adds cost with zero additional discrimination
   within [0.30, 0.70]. The Clockwork is_frozen guard is correctly enforced (throws
   FROZEN_VIOLATION in runOptimizer at lines 813-818, and rechecked inside the
   transaction at lines 988-993). The comparison-integrity 8pp rule is correctly
   enforced via applyIntegrityCap (which is the same exported function used by the
   rule engine — no bypass). Sr_anchored personalities are explicitly excluded before
   any work begins (line 822-826). Guards are sound; the Phase B cost is wasted
   today (see Medium finding for the specific recommendation).

4. Portfolio-risk per-(personality,underlying) scoping with deferred global breaker
   The per-index book design (D2 Option A) is correctly implemented for Rule 3
   (daily stop). The deferred global circuit-breaker (T-50) leaves a real risk-
   control gap: a systemic model failure producing losses across all 10 personalities
   on all 3 underlyings simultaneously has no automated stop. PORTFOLIO_DAILY_STOP
   applied per-(personality, underlying) means the global exposure limit is implicitly
   30x the per-book limit (10 personalities x 3 underlyings), which is likely
   unintended. The margin Rule 4 cross-underlying inconsistency (Medium finding) is
   separate. The global circuit-breaker deferral is documented and tracked (T-50/M6);
   this is a known gap, not a hidden one. The per-book stop provides the primary
   per-session protection.

5. index.ts multi-index bootstrap coupling, error handling, and graceful shutdown
   INDICES env parsing is clean and defensively coded. The per-underlying startup
   assert (assertUnderlyingReadiness) correctly disable-on-fail rather than crash-
   on-fail. The all-underlyings-failed guard (process.exit(1)) is correctly placed.
   The parallel start of all components (peakEngine, srEngine, straddleCalcs, VIX
   feed) is correct — all consume from Redis streams which buffer until readers
   arrive. The graceful shutdown ordering concern (signal engines stopped before
   straddle calculators) is noted in the Medium finding. The LIVE-mode symbol
   validation correctly logs a warning that the broker instrument master lookup
   is deferred and uses structural-only validation — this is honest and non-blocking.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ADDITIONAL STRUCTURAL OBSERVATIONS (no separate finding)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Convention compliance:
  - No default exports found in M5 files. Named exports throughout. ✓
  - Injectable Clock used consistently in sr-levels.ts, sr-detection-engine.ts,
    instrument-registry.ts. No Date.now() calls found. ✓
  - All straddle_signals INSERTs are fully parameterised. No string interpolation
    of user or stream data. ✓
  - All market_ticks queries include time-range WHERE clauses. Hypertable
    full-scan protection observed. ✓
  - Migration files are append-only (012_, 013_) and named correctly. ✓
  - checkComparisonIntegrity in personality-filter.ts correctly excludes
    non-momentum_exhaustion and frozen personalities from the spread check. ✓

Module cohesion:
  sr-levels.ts is a well-bounded pure computation module (two DB queries, one
  pure scoring pass). sr-detection-engine.ts cleanly separates stream consumption
  from level loading from signal emission. The export boundary between the two
  modules is appropriate: sr-detection-engine imports computation functions from
  sr-levels but not vice versa. No circular dependency exists.

Evolution-engine refactor:
  Extracting clampMinProbability, applyIntegrityCap, checkCooldown, writeProposal,
  and writeApplied as shared exports is a correct application of DRY. The extracted
  functions are pure (no DB access, except writeProposal/writeApplied which receive
  an injected PoolClient). The optimizer correctly reuses all guards. The original
  runEvolutionEngine behaviour is byte-for-byte unchanged per the module comment —
  this is verifiable from the diff.

Naming clarity:
  SR_SIGNAL_TYPE = 'PULLBACK' as const in sr-detection-engine.ts (line 172) is
  appropriately named from the transport perspective. The separate SR_REVERSAL constant
  for sr_subtype (line 160) correctly distinguishes the two layers. No magic numbers
  found in the new S/R code — all thresholds use named config fields or exported
  constants. The confidence tier thresholds (0.6, 0.35) in deriveConfidenceTier are
  inline literals; they should be named constants (SR_HIGH_STRENGTH_FLOOR,
  SR_MEDIUM_STRENGTH_FLOOR) for testability and discoverability, but this is cosmetic.


SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
High  : 2
Medium: 5
Low   : 3

The two High findings are directly related to the multi-index expansion (T-45):
the Thursday-formula straddle-calc produces wrong option symbols for BANKNIFTY and
SENSEX on every session, and the EOD job calls runEvolutionEngine for all entry types
producing a throw-and-catch error for Levelhead on every run. Both require targeted
fixes before BANKNIFTY or SENSEX are activated in production. The Medium findings are
structural gaps that accumulate risk at scale but are not day-one breakages.
