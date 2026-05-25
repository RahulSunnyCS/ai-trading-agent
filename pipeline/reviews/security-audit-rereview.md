# SECURITY AUDIT RE-REVIEW — Milestone 5 Phase-6 Fix Cycle

Scope: `git diff 7394fbe..HEAD`, source files only. Focused re-review of the fix
cycle that addressed the two blocking findings from the prior audit
(`pipeline/reviews/security-audit.md`). Goal: (1) confirm the prior blockers are
genuinely resolved, (2) catch any NEW security/integrity issue introduced by the
fixes. Already-accepted Low findings are not re-litigated.

Context unchanged: single-instance research/paper-trading tool. No user auth, no
sessions, no payment code in this diff (auth risk-flag N/A per business.md). Focus
remains SQL injection, schema/data-integrity, fail-open risk-control bypasses, and
the integrity invariants (Clockwork is_frozen guard, 8pp comparison cap, holdout
leakage).

Headline: **Both prior blockers are genuinely resolved.** The CRITICAL (queries
referencing a non-existent `underlying` column on `paper_trades`) is fixed by
migration 015 + a populating router UPDATE + corrected queries. The HIGH
(NULL-personality fail-open) is now a documented, sound accepted-risk because the
daily stop is a *pre-entry* check and the NULL window cannot affect it. The new SQL
(migrations 014/015) is parameterised and the unique-index/ON-CONFLICT design is
correct. No new Critical or High issue was introduced.

---

## VERIFICATION OF PRIOR BLOCKER 1 (was CRITICAL) — RESOLVED

FINDING: Per-index daily-stop / leg-cap referenced a non-existent `underlying`
column and matched bare index names against prefixed symbols.

Verification result: **RESOLVED.**

(a) Queries reference only real columns now.
- `src/trading/portfolio-risk.ts:226-234` (Rule 3 daily stop) filters
  `personality_id = $3 AND underlying = $4`. `underlying` now exists on
  `paper_trades` (migration 015 line 38; `schema.ts:276` `underlying: string | null`).
- `src/signals/personality-filter.ts:243-249` (open-leg count) now filters
  `($2::text IS NULL OR underlying = $2)` — the prior `symbol = $2` bare-name vs
  prefixed-symbol mismatch is gone.
- `src/trading/portfolio-risk.ts:309-314` (Rule 4 margin) now scopes
  `WHERE status = 'open' AND underlying = $1`.
- All values are bound parameters — no string interpolation. No injection.

(b) The router actually populates `underlying`, so controls are not fail-open.
- `src/signals/personality-router.ts:698-705` UPDATE sets
  `underlying = $3` from `signal.underlying` in the same round-trip that sets
  `personality_id`/`signal_id`.
- `signal.underlying` is the bare index name. The router skips any signal missing
  `underlying` entirely (`personality-router.ts:757-760`,
  `console.warn('Signal missing underlying — skipping')`), so a populated trade
  always carries a real, non-empty index name. The per-index query parameter
  (`intent.underlying` / `signal.underlying`) is the SAME bare-name form stored —
  the two now match.

(c) Migration-015 backfill LIKE rules are sound and safe.
- `015_paper_trades_underlying.sql:45-52`: BANKNIFTY is matched BEFORE NIFTY
  (`WHEN symbol LIKE 'NSE:BANKNIFTY%' ... WHEN symbol LIKE 'NSE:NIFTY%'`), so the
  `NIFTY`-substring-of-`BANKNIFTY` collision is correctly avoided (longest/most-
  specific prefix first). SENSEX matches `'BSE:SENSEX%'`. Unmatched symbols are
  left NULL (conservative).
- The UPDATE uses static SQL with literal patterns — no parameter, no injection.
- `WHERE underlying IS NULL` makes the backfill idempotent and non-destructive on
  re-run. `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are
  idempotent. DDL is safe.

(d) Residual NULL-underlying window on rows that contribute to the daily-stop SUM.
- The daily-stop SUM (`portfolio-risk.ts:226`) only sums rows with
  `status = 'closed'`. The executor INSERT (`paper-trade-executor.ts:77-103`)
  always inserts with `status = 'open'` and NULL `underlying`; the router then
  patches `underlying` via UPDATE while the row is still open. The close path
  (`paper-trade-executor.ts:148+`, `position-monitor.ts:462`) flips
  `status` to `closed` but does not touch `underlying`. Therefore a row can only
  be `closed` with NULL `underlying` if (i) it is a legacy pre-015 row — backfilled
  by migration 015 — or (ii) the router UPDATE threw a DB error (logged at
  `personality-router.ts:710`). In both residual cases the row is excluded from
  the per-index SUM, which **under-counts** losses: the stop fires later than ideal,
  never earlier. That is the conservative (safe-fail) direction for a blocking
  pre-entry check. No fail-open: the prior bug made the stop inert for ALL rows;
  now it is enforced for every normally-opened trade.

Conclusion: the column/value mismatch is genuinely fixed and the control is
enforced. Down-grading from CRITICAL to resolved.

---

## VERIFICATION OF PRIOR BLOCKER 2 (was HIGH) — ACCEPTED RISK (no longer a finding)

FINDING (was): NULL `personality_id` fail-open on the daily stop
(`personality_id = $3` never matches NULL rows).

Decision under review: NO code change; argued that closed trades get
`personality_id` set at open via the router UPDATE, and NULL rows are genuine
pre-M2 orphans the stop should skip.

Verification result: **Reasoning holds. Accept as a documented accepted-risk.**

- The daily stop is evaluated *before* a new trade opens
  (`portfolioRiskCheck` runs at entry intent time, returns
  `PORTFOLIO_DAILY_STOP` to block entry). The NULL window described in the prior
  audit (row exists after INSERT but before the router's follow-up UPDATE) exists
  only for rows that are still `open` and un-patched. The stop SUMs only `closed`
  rows, and as established in 1(d) a row becomes `closed` only after the open-time
  UPDATE has already set `personality_id` (or it is a genuine pre-M2/error orphan).
  So the NULL window cannot affect the pre-entry check. The inline comment at
  `portfolio-risk.ts:204-214` states this correctly.
- Residual exposure: genuinely-NULL `personality_id` rows (pre-M2, or a logged
  UPDATE failure) are excluded from every personality's book. That under-counts —
  conservative — and these rows do not belong to any personality book by design.
- Caveat (not blocking): the safety argument depends on `personality_id` being set
  before a row is ever closed. That invariant currently holds because the close
  paths run strictly after the router UPDATE and the executor never closes a trade
  inline at open. If a future change ever closes a trade in the same flow before the
  router UPDATE runs, this accepted-risk would need revisiting. Recommend keeping
  the documented invariant comment and, ideally, eventually writing
  `personality_id`/`underlying` inside the INSERT transaction rather than a
  follow-up UPDATE. This is a hardening note, not a current finding.

Conclusion: I accept the no-code-change decision as a sound, documented
accepted-risk. No longer a finding.

---

## NEW SQL INTRODUCED BY THE CYCLE

### Migration 015 (paper_trades underlying) — SOUND
Covered in 1(c)/1(d) above. DDL idempotent, backfill safe and ordered correctly,
index `(underlying, status)` supports the per-index queries. No injection. No
finding.

### Migration 014 (straddle_signals idempotency) — SOUND
- `sr_level_price NUMERIC` added `IF NOT EXISTS` — idempotent, nullable, does not
  disturb existing MOMENTUM/SCHEDULED rows. (`014:101-102`)
- Two PARTIAL UNIQUE indexes:
  - MOMENTUM_EXHAUSTION key `(signal_type, time, underlying, atm_strike)`
    `WHERE signal_type = 'MOMENTUM_EXHAUSTION'` (`014:119-121`).
  - PULLBACK key `(signal_type, time, underlying, atm_strike, sr_level_price)`
    `WHERE signal_type = 'PULLBACK'` (`014:138-140`).
- Natural-key correctness — could two legitimately-distinct signals collide?
  - Momentum: the engine emits at most ONE momentum signal per snapshot per
    (underlying, atm_strike); each 15s snapshot has a unique `time`. No legitimate
    second momentum signal shares the same key at the same instant, so ON CONFLICT
    DO NOTHING can only drop a genuine re-delivery duplicate. Correct.
  - PULLBACK: multiple S/R levels can fire at one snapshot — `sr_level_price` is in
    the key, so distinct levels do NOT collide. Correct. (Caveat: two distinct S/R
    levels rounded to the exact same NUMERIC price at the same snapshot would be
    treated as one; that is a degenerate, harmless case — they are economically the
    same level. Not a finding.)
- Time-in-key requirement: both unique indexes include `time` (the hypertable
  partition column), satisfying TimescaleDB's rule. Correct.
- Pre-existing-duplicate failure mode: `CREATE UNIQUE INDEX` will error if the data
  already contains duplicates from the pre-fix bug. The migration documents this as
  intended operator-resolves-first behaviour and supplies detection/cleanup queries
  (`014:49-86`). This is a deployment/operability note, not a security issue — and
  the fail direction (refuse to create the index) is safe.

### ON CONFLICT DO NOTHING in the two engines — SOUND
- Both engines handle the 0-row RETURNING path: peak
  (`peak-detection-engine.ts:572-581`) and SR (`sr-detection-engine.ts:670-685`)
  early-return on `dbResult.rows.length === 0`, logging at debug and — critically —
  NOT publishing to `signals.generated`. So a duplicate that was already persisted+
  published on the first delivery is not re-published, and a signal that was NOT
  persisted is never published. No crash, no orphan publish. Correct.
- `signal_type` literals match the partial-index predicates: peak inserts the
  literal `'MOMENTUM_EXHAUSTION'`; SR inserts `SR_SIGNAL_TYPE = 'PULLBACK'`
  (`sr-detection-engine.ts:166`). So ON CONFLICT actually targets the intended
  partial index. Correct.
- INSERT `time` switched from `clock.now()` to the snapshot `time`
  (`peak:553`, `sr:651`). `time` is finiteness-validated before the INSERT in both
  engines (`peak:352-369`, `sr:393-404`). Integrity downside check: the snapshot
  time is the correct event timestamp for a signal (and is required for the
  re-delivery idempotency to work — wall-clock would differ across restarts and
  defeat the key). The straddle_signals.time column is the partition/event time;
  using the snapshot instant is more correct than the prior insert-wall-clock, not
  less. No integrity downside.

---

## SHARED-BACKTEST REUSE (eod-retrospection-job.ts / optimizer.ts) — SOUND

- The EOD job runs ONE backtest per EOD batch (single `tradeDateISO`, single
  `BACKTEST_UNDERLYING = NIFTY`, single `OPTIMIZER_HOLDOUT_DAYS`,
  `trainFraction 0.7`) and passes the resulting `SimulatedTrade[]` to each
  personality's `runOptimizer` via `precomputedTrades`
  (`eod-retrospection-job.ts:203-247, 346-359`).
- No cross-personality data leakage: `SimulatedTrade[]` is shared *market* data
  (NIFTY straddle trades), not personality-specific data — there is no
  personality-keyed field in the backtest output. Every NIFTY momentum personality
  is legitimately scored against the same market history. Non-NIFTY personalities
  are rejected by the optimizer's M1 guard
  (`optimizer.ts:871-882`, `multi-underlying_not_supported`) BEFORE
  `precomputedTrades` is used, so sharing NIFTY trades with them is impossible.
- Holdout/train integrity preserved: `scoreFinalists` still hard-filters to
  `split === 'train' && signalType === 'MOMENTUM_EXHAUSTION'`
  (`optimizer.ts:630`). Holdout/test trades are never scored. The shared trade set
  carries the same per-trade `split` tag, so sharing does not bypass the split.
- Clockwork `is_frozen` guard preserved: pre-read throw
  (`optimizer.ts:841-844`) AND re-check inside the `SELECT ... FOR UPDATE`
  transaction (`optimizer.ts:1101-1106`). Throw-not-skip intact.
- 8pp comparison-integrity cap preserved: the proposal still routes through
  `applyIntegrityCap(clampedCandidate, lockedMinProb, otherProbs, delta)` inside
  the locked momentum-only comparison group (`optimizer.ts:1119-1132`). Both the
  backtest path and the new `kernel_only` fast path converge to the same
  `clampedCandidate` → `clampMinProbability` → guard layer (`optimizer.ts:1042+`),
  so the fast path does NOT bypass clamp, cap, cooldown, frozen re-check, or the
  approval gate.
- evolution-engine H4 pre-filter: the EOD job now calls `runEvolutionEngine` only
  for `entry_type === 'momentum_exhaustion'` personalities
  (`eod-retrospection-job.ts:317-323`). This only suppresses a false-alarm error
  for sr_anchored/fixed_time personalities (which the engine's FOR UPDATE never
  locks anyway); it does not relax any guard for momentum personalities. Sound.

No guard bypass and no leakage introduced.

---

## OTHER DELTAS REVIEWED (no finding)

- `personality-filter.ts` date predicate changed from
  `DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $2::date` to an IST-midnight UTC
  range (`entry_time >= $2 AND entry_time < $3`, `:187-225`). Bound parameters;
  semantics match `portfolio-risk.ts` Rule 3; index-friendly. The IST boundary math
  (`new Date(todayIST) - IST_OFFSET_MS`) is the same in both modules. No injection,
  no integrity change.
- `parseBlockedDatesSet()` (`personality-filter.ts:643-666`): parsed-once-per-signal
  optimisation; still try/catch-guarded, non-string entries filtered, empty Set on
  failure (fail-safe = skip blocked-date check, same as before). No new untrusted
  input reaches SQL. No finding.
- `index.ts` calendar-expiry injection + shutdown reorder (`:420-490, 789-810`):
  correctness/integrity hardening (correct expiry per underlying; calculators
  stopped before engines so no un-ACK'd straddle.values, backstopped by 014's
  idempotent INSERT). `getCurrentExpiryFromCalendar` is parameterised and takes an
  allowlisted `Underlying` enum. No security regression.

Prior Low findings (SR snapshot range-bound hardening; 013 expiry-seed
verification) are unchanged by this cycle and remain open as previously logged —
not re-counted here.

---

SUMMARY (this re-review's deltas only)
Critical: 0
High    : 0
Medium  : 0
Low     : 0  (prior two Lows remain open, unchanged; not re-counted)
Accepted risks: 1 (NULL personality_id / NULL underlying rows excluded from the
  per-index daily stop — conservative under-count; sound because the stop is a
  pre-entry check and closed rows are always patched at open time)

Overall verdict: PASS

Rationale: Both prior blockers are genuinely resolved and verified against the real
schema and the actual write/close paths. The new SQL (migrations 014/015) is
parameterised, idempotent, and uses correct natural keys with the hypertable
time-in-key requirement satisfied. The ON CONFLICT 0-row path is handled in both
engines (no crash, no orphan publish). The shared-backtest reuse introduces no
cross-personality leakage and preserves the Clockwork frozen guard, the 8pp cap,
the holdout/train split, and the approval gate. No new Critical/High/Medium issue
was introduced by the fix cycle.

Recommended (non-blocking) hardening: eventually write `personality_id` and
`underlying` inside the INSERT transaction rather than a follow-up UPDATE, to make
the accepted-risk invariant robust against future inline-close changes.
