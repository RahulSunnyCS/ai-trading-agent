# M5 Gate 2 — Updated Synthesis Review Report (post fix-cycle re-review)

**Verdict: CONDITIONAL PASS** — all original Criticals & Highs resolved; remaining items are 1 Medium + Low follow-ups, none blocking this milestone.

Re-review of fix diff `7394fbe..HEAD` by all three specialists:
- Security: **PASS** (0 Critical / 0 High / 0 Medium / 0 Low; 1 accepted risk)
- Performance: **PASS** (0 / 0 / 0; 3 new Low)
- Architecture: **CONDITIONAL PASS** (0 High / 1 Medium / 3 Low)

## ORIGINAL BLOCKERS — ALL RESOLVED (verified)
- 🔴→✅ **C1** per-index risk controls: real `underlying` column (migration 015, backfilled, BANKNIFTY-before-NIFTY), populated by the router's post-open UPDATE, queries corrected; real-column tests added. Security verified it is safe-fail (under-counts, never fail-open), not still broken.
- 🔴→✅ **C2** EOD backtest: now runs once (shared) with the N+1 collapsed to one range query (hypertable time-predicate intact).
- 🟠→✅ **H1** multi-index symbols: calendar expiry injected per StraddleCalculator with debounced rollover; BankNifty/Sensex now build correct-dated symbols.
- 🟠→✅ **H2** NULL personality_id: verified — daily stop is a pre-entry check; closed rows are always patched at open. Accepted as documented risk.
- 🟠→✅ **H3** date filter now sargable (uses the index).
- 🟠→✅ **H4** Levelhead no longer throws at EOD (pre-filtered by entry_type).
- 🟡→✅ **M1, M2, M3, M4, M5** all resolved and verified.

## REMAINING OPEN ITEMS (non-blocking — follow-ups)

🟡 **Medium (architecture N1):** `runEvolutionEngine` has no internal entry_type guard — the protection lives only in the EOD job caller. A future un-guarded caller would hit the throw. Recommend adding a self-contained `entry_type_excluded` early-return (mirroring the optimizer) **before Phase 2 activates non-momentum personalities.** Zero extra DB cost.

🟢 **Low follow-ups:**
- (perf) `kernel_only` guard is gated on `precomputedTrades === undefined`, so it never fires in the EOD path (which always supplies them); `scoreFinalists` runs in-memory regardless. C2's win (1 backtest not 3) still holds; remove the extra condition. In-memory only, no DB.
- (perf) `loadPersonalities` called twice per EOD (down from four); thread a preloaded list.
- (perf) add composite index `(personality_id, status, entry_time)` when closed-trade volume grows.
- (arch) `IST_OFFSET_MS` re-defined locally in `straddle-calc.ts` and `personality-filter.ts` — import the existing constant from `clock.ts`.
- (arch) `paper_trades.underlying` two-step residual: when the executor INSERT is next touched, populate `underlying` atomically and drop the router UPDATE.
- (arch, latent) **`BACKTEST_UNDERLYING='NSE:NIFTY50-INDEX'` does not match `straddle_snapshots.symbol='NIFTY'`** → the shared backtest returns 0 rows. Currently harmless (probabilities uncalibrated; optimizer safe-fails to no suggestion), but when Phase 2 calibration lands the optimizer will silently stop suggesting. Fix the constant to `'NIFTY'` after confirming the stored value.
- (sec hardening) eventually write `personality_id`/`underlying` inside the INSERT transaction to make the H2 invariant robust against future inline-close changes.
- (from first review) L1 seed expiry-date verification vs NSE/BSE calendar; L2 bound stored NUMERICs; L3 stale comment + signal_type/sr_subtype conflation; L4 magic-number SR thresholds.

## CONFLICTS BETWEEN REVIEWERS
None. The two reviewers' independent observations on the optimizer actually compose into one coherent latent issue: `kernel_only` doesn't fire in EOD (perf) **and** the shared backtest queries a non-matching symbol (arch) → today the EOD optimizer scores against 0 backtest rows and safe-fails to no suggestion. Harmless now (pre-calibration), but both should be fixed before Phase 2 calibration so the optimizer actually functions.

## VERDICT EXPLANATION
**CONDITIONAL PASS.** The fix cycle resolved all 2 Criticals and all 4 Highs, verified against the real schema and write paths, with no new Critical/High and a net test increase (1144 unit tests green, typecheck clean). The single Medium and the Low follow-ups are safe-fail or future-facing (Phase 2), none block shipping M5. Recommend proceeding past Gate 2 with the Medium (N1) and the two optimizer-latent Lows tracked as must-do-before-Phase-2.
