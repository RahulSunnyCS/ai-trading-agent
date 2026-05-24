# Pipeline Progress — M3 (Fyers Historical Data, Replay & Backtesting)

- **Lane:** feature-full
- **Risk level:** HIGH (financial-logic + public-facing-api risk flags)
- **Sprint count:** 3
- **Effort:** Planning/Red Team at max; default per CLAUDE.md table otherwise.
- **recommendation_rounds_used:** 1 (R1 pull T-33 forward + R2 golden-oracle CI check accepted at Gate 1; re-planning)

## Phase Status

| Phase | Status |
|---|---|
| Phase 0 — Triage | ✅ Done (risk_manifest.json written) |
| Phase 1 — Planning + Red Team (×3 + 1 re-plan delta) | ✅ Done |
| Human Gate 1 | ✅ Approved (D1/D2/D3 + R1 + R2) |
| Phase 2 — Decomposition (M3a: T-54,T-55,T-56,T-57,T-33) | ✅ Done — contracts in pipeline/tasks/ |
| Phase 3 — Implementation | ✅ Done (M3a: T-54,55,56,57,33 — 440 unit tests pass) |
| Phase 4 — Specialist Review (security + perf + arch) | ✅ Done — CONDITIONAL PASS (0 Crit / 1 High / 13 Med / 10 Low) |
| Human Gate 2 | ✅ Approved — fix C1–C4 then proceed (H1/M1 tracked) |
| Gate-2 fix cycle (C1–C4) | ✅ Done — verified (tsc clean, 440 unit pass); C1 INSERT+migration 009, C2 ticksConsumed barrier, C3 --against-live guard, C4 barrier drain |
| Phase 5 — Test generation (unit/integration/docs) | ✅ Done — barrier unit test + 3 integration tests; README M3a docs present |
| Phase 6 — Test execution loop | ✅ Done — unit 451 pass / 3 skip; new integration tests skip cleanly w/o Docker (CI-ONLY). Pre-existing smoke.test.ts fails only on absent Redis (environmental, untouched). |
| Phase 7 — Final review + Gate 3 | ⏳ Next |

## Tracked follow-ups (post-Gate-2, accepted)
- H1 (Perf High): N+1 per-step leg queries in reconstructor — fix before 15s reconstruction over >2-3 week ranges.
- M1 (Sec+Perf Med): unbounded in-memory load in historical-feed.load() — page/cap before multi-month windows.
- Tech debt: HistoricalFeed extends BrokerFeed; straddle-calc pushToBuffer; fetchMarketTicks symbol filter; idx_straddle_snapshots(symbol,time); backfill_ranges CHECK; ON CONFLICT target pinning; token log fingerprint; regime_confidence string type; on('gap') doc/code drift; gaps_json on resume.
- NOTE: migration 009 unique index will fail if a pre-fix dev DB already holds duplicate straddle_snapshots rows — dedup before applying.

## Notes
- M2 (personality router T-27) and M4 (regime tagging T-33) are not yet built; both are forward dependencies for T-51 / T-58. Surfaced as Gate-1 decisions.
