ARCHITECTURE RE-REVIEW REPORT — Phase 6 Fix Cycle (Milestone 5)
Lens: backend + infra
Diff: git diff 7394fbe..HEAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRIOR FINDING RESOLUTION
━━━━━━━━━━━━━━━━━━━━━━━━

HIGH H1 — BankNifty/Sensex expiry (was: wrong Thursday symbol for all underlyings)
RESOLVED. The fix is architecturally sound. src/ingestion/straddle-calc.ts now
accepts a `currentExpiry: Date` and `resolveExpiry: () => Promise<Date>` via
config injection. src/index.ts resolves the calendar expiry at startup per
underlying (getCurrentExpiryFromCalendar), stores results in expiryByUnderlying
Map, and injects them as a closure. The closure captures `pool` and `underlying`
from the outer scope — correct per-underlying scoping with no shared state risk.
Rollover detection in resolveCurrentExpiry() is accurate (IST-day comparison via
UTC arithmetic; 15:30 IST cutoff as EXPIRY_CUTOFF_HOUR/MIN named constants).
The expiryRefreshInFlight guard prevents concurrent DB calls on the rollover
boundary. The async refresh is fire-and-forget with .finally() that resets the
flag on both success and failure — no flag-stuck risk. Returning the old expiry
during the 15s refresh window is correct and safe (market is closed by 15:30 IST).
The dependency direction is clean: straddle-calc.ts never imports 'pg' directly.
Dual getCurrentExpiry/getCurrentExpiryFromCalendar coexistence is acceptable — the
Thursday formula is explicitly a NIFTY-only fallback with a comment acknowledging
the limitation. VERIFIED.

HIGH H4 — Evolution engine throwing for sr_anchored personalities every EOD
RESOLVED. eod-retrospection-job.ts now fetches entry_type alongside id in the
personality SELECT (step 3) and guards with `if (personality.entry_type ===
'momentum_exhaustion')` before calling runEvolutionEngine (step 5f). The
pre-filter is at the correct layer — the EOD job already owns the entry_type
context and this avoids an unnecessary DB round-trip inside evolution-engine.
The optimizer has a self-contained guard (reads personality from DB, checks
entry_type before proceeding); evolution-engine has a cross-reference comment
pointing at the EOD job guard. The architectural asymmetry between the two
modules is noted as a new finding below (N1). RESOLVED operationally.

MEDIUM M2 — Shutdown order + non-idempotent signal INSERT
RESOLVED. Shutdown order: straddleCalcs are stopped before peakEngine/srEngine
in index.ts (line 805 before lines 808-809), with a clear comment explaining the
producer-before-consumer sequencing. Idempotent INSERTs: both peak-detection-engine
and sr-detection-engine now use the snapshot `time` field (not clock.now()) as the
INSERT timestamp, enabling stable natural keys. Migration 014 adds two partial
UNIQUE indexes:
  - MOMENTUM_EXHAUSTION: (signal_type, time, underlying, atm_strike)
  - PULLBACK: (signal_type, time, underlying, atm_strike, sr_level_price)
Both include `time` to satisfy TimescaleDB's partition-column-in-unique-index
requirement. The sr_level_price column (nullable) is always written as a non-null
value by the SR engine (String(level.price)), so the PULLBACK index provides real
deduplication for re-delivered messages. PostgreSQL's NULL-distinct semantics
(NULL != NULL in unique indexes) mean pre-migration PULLBACK rows without
sr_level_price do not interfere — documented correctly in the migration comment.
ON CONFLICT DO NOTHING with a RETURNING check is correctly handled in both
engines: a 0-row result logs at debug level and returns without re-publishing to
Redis (the original publish already occurred). The schema.ts interface was updated
to include `sr_level_price: string | null` — this is NOT the inconsistency flagged
in the prior review's parenthetical. RESOLVED.

MEDIUM M1 — Optimizer hardcoded to NIFTY
RESOLVED as a guard. optimizer.ts reads `personality.params.underlying` with a
default of BACKTEST_UNDERLYING. Since no current personality seeds include a
`params.underlying` key, all personalities default to BACKTEST_UNDERLYING. The
guard returns 'multi-underlying_not_supported' when the configured underlying
differs from BACKTEST_UNDERLYING. The guard is correct for the current state and
marked as temporary pending the backtest runner supporting per-personality
underlyings. The check reads from personality.params (loaded from DB), not from
a hardcoded constant, making it future-correct when BankNifty/Sensex personalities
are seeded. RESOLVED.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEW FINDINGS FROM THIS CYCLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDING: evolution-engine entry_type contract is implicit (caller must guard)
Severity: Medium
File or area: src/retrospection/evolution-engine.ts (approx. line 402–425),
             src/jobs/eod-retrospection-job.ts (step 5f guard)
What it is: runEvolutionEngine does not guard against non-momentum_exhaustion
  personalities internally. The optimizer does guard internally (reads
  personality from DB, checks entry_type, returns early). evolution-engine
  does not read the personality — it receives pre-computed metrics — so it
  cannot check entry_type without an extra DB query. The H4 fix therefore
  puts the guard in the EOD job. The comment in evolution-engine.ts documents
  this as an architectural decision but leaves a "caller must pre-filter"
  contract undocumented in the function signature itself.
Why it matters: Any future caller of runEvolutionEngine that does not know to
  pre-filter by entry_type will encounter the "not found in momentum_exhaustion
  group" error on every run for non-momentum personalities. The contract
  violation produces a DB transaction error (thrown), not a clean early return.
  As personalities expand (Levelhead Phase 2, fixed_time Clockwork), this risk
  grows. The optimizer's self-contained guard is the better pattern.
Recommendation: Add an `entryType?: string` parameter to runEvolutionEngine's
  metrics argument (or as a standalone parameter) and return { action: 'none',
  reason: 'entry_type_excluded' } early when it is not 'momentum_exhaustion'.
  This mirrors the optimizer's pattern and makes the guard self-contained
  without a DB round-trip (the value is passed in by the caller who already
  has it). Remove the inline comment block that defers responsibility to the
  caller — it should be a JSDoc contract, not an inline workaround note.

FINDING: IST_OFFSET_MS re-defined in multiple modules instead of imported
Severity: Low
File or area: src/ingestion/straddle-calc.ts (line 33),
             src/signals/personality-filter.ts (lines 202, 609, 622),
             also pre-existing in: sr-levels.ts, peak-detection-engine.ts,
             regime-tagging.ts, probability-scorer.ts, instrument-registry.ts,
             backtest-runner.ts, scheduled-entry.ts
What it is: `IST_OFFSET_MS = 5.5 * 60 * 60 * 1000` is defined as a named
  constant in src/utils/clock.ts and exported. This fix cycle adds two more
  local definitions — one module-level in straddle-calc.ts (new in this diff)
  and two function-level in fetchDailyState and toISTDate in personality-filter.ts
  (new in this diff). Both files already import from clock.ts (straddle-calc.ts
  imports Clock and RealClock; personality-filter.ts imports nothing from clock.ts
  and could add the import).
Why it matters: A single definition drift (e.g. IST temporarily becomes UTC+5:45
  in a hypothetical edge case, or there is a test-environment override) would
  require finding and patching every local copy. More practically: a new developer
  will see `5.5 * 60 * 60 * 1000` and not know it is already a named export in
  clock.ts, and will add another copy.
Recommendation: In straddle-calc.ts, change `import { RealClock } from
  '../utils/clock'` to `import { RealClock, IST_OFFSET_MS } from '../utils/clock'`
  and remove the local const. In personality-filter.ts, add `import {
  IST_OFFSET_MS } from '../utils/clock.js'` and remove the three local
  definitions. This is a zero-risk refactor — the value is identical in all
  copies. The pre-existing copies in other modules are pre-existing debt and
  outside this diff's scope, but should be cleaned up in a follow-on pass.

FINDING: Two-step INSERT+UPDATE leaves paper_trades.underlying nullable with a
  known residual gap at the canonical INSERT site
Severity: Low
File or area: src/trading/paper-trade-executor.ts (openTrade INSERT),
             src/signals/personality-router.ts (post-open UPDATE),
             src/db/migrations/015_paper_trades_underlying.sql
What it is: Migration 015 adds `underlying TEXT` (nullable) to paper_trades.
  The canonical INSERT in PaperTradeExecutor.openTrade does NOT populate
  `underlying` — it is set afterward via UPDATE in the personality router. This
  is a documented out-of-scope residual (the migration and portfolio-risk.ts
  both carry a "NOTE FOR REVIEWERS" comment). If the UPDATE fails (DB timeout,
  connection drop), the row has underlying=NULL permanently. The per-index daily
  stop (Rule 3 in portfolio-risk.ts) and the per-index leg cap (personality-
  filter.ts open-positions query) then exclude that trade from their count, which
  is safe-fail (under-counting losses is conservative for a blocking risk check).
  The migration also acknowledges this pattern. The prior review raised C1 (the
  open-leg query used symbol=underlying_name, which could never match); that is
  fixed to underlying=$2.
Why it matters: The residual is bounded and safe-fail in direction, and is
  acknowledged in three places. However, it means new paper trades opened between
  a process restart and a successful UPDATE will briefly show NULL underlying in
  any concurrent read of paper_trades. In a single-process application this window
  is sub-millisecond. The real risk is the UPDATE failure path: if trade-executor
  is updated in Phase 2 to populate underlying on INSERT, the UPDATE becomes
  redundant but harmless — but if trade-executor is extended by another path
  (e.g. a manual API trigger) without populating underlying, the gap silently
  reappears.
Recommendation: Track the trade-executor update as a concrete ticket. When
  PaperTradeExecutor.openTrade is extended to accept EntryIntent fields
  (personality_id, signal_id, underlying), populate all three at INSERT time and
  remove the two separate UPDATE statements from the router. This collapses the
  two-step pattern to one atomic write and eliminates the residual. Until then,
  the current approach is acceptable.

FINDING: BACKTEST_UNDERLYING symbol format does not match straddle_snapshots.symbol
Severity: Low (pre-existing, not introduced by this cycle — documented for completeness)
File or area: src/retrospection/optimizer.ts (BACKTEST_UNDERLYING = 'NSE:NIFTY50-INDEX'),
             src/backtesting/backtest-runner.ts (WHERE symbol = $1),
             src/ingestion/historical/reconstruct-straddle.ts (symbol: underlying = 'NIFTY')
What it is: BACKTEST_UNDERLYING is set to the Fyers index ticker 'NSE:NIFTY50-INDEX'.
  The backtest-runner queries `WHERE symbol = $1` on straddle_snapshots. But
  reconstruct-straddle.ts writes `symbol: underlying` where underlying is type
  Underlying ('NIFTY', 'BANKNIFTY', 'SENSEX') — the bare name, not the Fyers
  ticker. So the backtest query always returns 0 rows. In practice this is masked
  by the M3 kernel-only guard: all shortlist candidates are <= 0.70 (the fixed
  backtest runner probability), so the backtest fast path is skipped anyway. The
  system works, but through two bugs offsetting each other rather than by design.
  This bug was not introduced by this fix cycle.
Why it matters: Once calibrated per-signal probabilities are introduced (Phase 2),
  the M3 kernel-only guard will stop firing. The backtest will then run and return
  0 trades for NIFTY, causing every optimizer run to return 'no_eligible_finalist'.
  The optimizer will silently stop making suggestions.
Recommendation: Align BACKTEST_UNDERLYING with the value stored in
  straddle_snapshots.symbol. Either change BACKTEST_UNDERLYING to 'NIFTY' (the
  bare name), or change reconstruct-straddle to store the Fyers ticker as symbol.
  The simpler fix is to change the constant — verify the existing straddle_snapshots
  data matches 'NIFTY' with a `SELECT DISTINCT symbol FROM straddle_snapshots LIMIT 5`
  before applying.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVENTIONS ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Named exports: all modified files use named exports. No default exports added.
Injectable clock: no Date.now() calls introduced in production paths. The
  snapshot time is correctly taken from the stream message (`time` field), not
  from clock.now(). The personality-filter IST boundary computation uses the
  injected `todayIST` string (from the caller's clock) rather than calling
  Date.now() inline.
Append-only migrations: only migrations 014 and 015 are new files. No
  existing migration file was modified in this diff.
Raw SQL: all new DB queries use parameterised placeholders — no string
  interpolation in SQL.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Prior findings resolved: H1 (RESOLVED), H4 (RESOLVED), M2 (RESOLVED), M1 (RESOLVED)

High  : 0
Medium: 1  (N1 — evolution-engine caller contract; operational risk as personalities expand)
Low   : 3  (IST_OFFSET_MS duplication; INSERT+UPDATE residual; BACKTEST_UNDERLYING mismatch)

VERDICT: CONDITIONAL PASS

The four prior HIGH and MEDIUM findings are resolved. The architecture of the
expiry injection (H1), idempotent signals (M2), and EOD entry_type guard (H4) is
correct and well-documented. The new Medium finding (N1) is a maintenance hazard
as the personality roster expands — it should be addressed before Phase 2 activates
non-momentum personalities. The three Low findings are safe-fail or pre-existing
and do not block this milestone.
