# Epic: Database Migration Chain Fix

| Field      | Value                                                             |
|------------|-------------------------------------------------------------------|
| Status     | Completed                                                         |
| Date       | 2026-05-24                                                        |
| Branch     | main                                                              |
| Tasks      | T-01, T-02, T-03, T-04, T-05, T-06, T-07 + H1 fix               |
| Risk level | MEDIUM (DDL only; no auth/payment/PII surface touched)            |

---

## 1. What was done

Two distinct problems were diagnosed, planned, and fixed:

**Problem A — Dev server boot failure (immediate, blocking)**

Migration `010_retrospection_evolution.sql` contained an `UPDATE` that read
`min_probability` and `max_daily_loss_pct` as top-level columns from
`personality_configs`. Those columns do not exist on the live table, which was
built in the M2 params-bag shape (a `params JSONB` field, not individual typed
columns). PostgreSQL raised error 42703 (`column "min_probability" does not
exist`), the migration runner rolled back `010`, and `bun run dev` exited 1
before the server started.

Fix: deleted the dead `UPDATE` block (lines ~37-43 of `010`) and trimmed its
stale comment. The `ADD COLUMN IF NOT EXISTS` statements in the same file, plus
the `retrospection_results` additions and the Clockwork `display_name`/`group_type`
backfill, were kept intact.

**Problem B — Fresh-install breakage (silent, caught by analysis)**

A clean database applying all 15 migrations from scratch failed at three points
in sequence:

1. `003_personality_signals_schema.sql` tried to call `create_hypertable` on
   `straddle_signals`, but the table had already been created by `001` as a
   regular table with a single-column `PRIMARY KEY (id)`. TimescaleDB requires
   the partition column (`time`) in the primary key and returned TS103.
2. `005_personality_seed.sql` tried to `INSERT` into `personality_configs` using
   `display_name`, `group_type`, and `params` columns that do not exist on the
   M1-shape table created by `001`.
3. `004_paper_trades_m2.sql` tried to add a foreign key `REFERENCES
   straddle_signals(id)` — invalid once `straddle_signals` is a composite-PK
   hypertable, because PostgreSQL cannot satisfy an FK to a non-unique column.

Root cause: `001_core_schema.sql` contained M1-era (legacy) definitions of both
`personality_configs` and `straddle_signals`. The M2 redesign added canonical
versions in `003`, relying on `IF NOT EXISTS` to silently skip on existing DBs
where `001` had already run. On a fresh DB `001` ran first and owned both tables
permanently, leaving the M2 definitions and the M2 seed with no valid target.

**Fixes applied (Tasks T-01 through T-05):**

- `001_core_schema.sql` (T-01): replaced the M1 `personality_configs` block with
  the params-shape definition (verbatim from 003, including all CHECK/UNIQUE
  constraints); replaced the regular `straddle_signals` block with the
  params-shape hypertable definition including composite `PRIMARY KEY (id, time)`
  followed by `create_hypertable(..., if_not_exists => true)`; dropped the
  `REFERENCES straddle_signals(id)` foreign key from `paper_trades.signal_id`;
  removed `idx_straddle_signals_status_time` (referenced a `status` column that
  never existed in M2).
- `002_seed_clockwork.sql` (T-02): replaced the M1-column `INSERT` with a
  params-shape insert (`name='clockwork'`, `display_name='Clockwork'`,
  `group_type='reference'`, `params='{"max_daily_trades":1,"max_daily_loss":5000}'`)
  using `ON CONFLICT (name) DO NOTHING` so it deduplicates against the full
  personality seed in `005`.
- `003_personality_signals_schema.sql` (T-03): changed `straddle_signals`
  primary key from `(id)` to composite `(id, time)` so the file is internally
  self-consistent (the `CREATE TABLE IF NOT EXISTS` and `create_hypertable` are
  now no-ops on fresh installs but no longer contradictory).
- `004_paper_trades_m2.sql` (T-04): dropped the `REFERENCES straddle_signals(id)`
  foreign key from the `ADD COLUMN signal_id` statement. Column is kept; FK
  removed to match the live dev schema and TimescaleDB constraints.
- `010_retrospection_evolution.sql` (T-05): deleted dead M1-to-params backfill
  `UPDATE`; trimmed stale comment. All other content kept.

**H1 fix (pre-existing bug surfaced by specialist review, fixed in scope):**

`src/jobs/eod-retrospection-job.ts` line 147 selected a `primary_symbol` column
that has never existed in any migration. This caused the entire EOD retrospection
batch to crash on every run with `column "primary_symbol" does not exist`.
Fixed by dropping `primary_symbol` from the `SELECT` and removing the
corresponding field from the row type.

**T-06 — Migration regression test:**

Extended the existing `src/test/integration/migrations.integration.test.ts`
(the only file that calls `runMigrations()` directly) with assertions that lock
in the fresh-install guarantees: exactly 10 personality rows, exactly 4
hypertables, composite PK on `straddle_signals`, no FK on
`paper_trades.signal_id`, idempotent second run.

**T-07 — Dead type annotations:**

Added `@deprecated` JSDoc comments to `PersonalityConfig`, `StraddleSignal`,
`ManagementStyle`, and `SignalStatus` in `src/db/schema.ts` — the M1-era
interfaces that are not present on fresh installs and are unused by live code.
Types were not deleted; the annotation signals to future developers which
interface to use (`PersonalityConfigM2`).

---

## 2. How this helps the project

Before this fix, the project could not be set up from scratch. Any developer
cloning the repository, any CI environment starting fresh, or any deployment to
a new server would fail before the application started. This was discovered
because the EOD migration (010) was new and unapplied, making it the first M1
artifact to execute against the already-params-shaped live database.

The fix means:
- `bun run dev` starts reliably on both existing and fresh databases.
- A new contributor or a new server can clone the repo, run `docker compose up -d`
  and `bun run migrate`, and have a working database in one step.
- The migration chain is now canonical: what a fresh install produces is
  schema-identical to the live development database (verified by schema diff
  post-fix).
- The EOD retrospection job (the learning engine) no longer crashes immediately
  on its first scheduled run.
- A regression test guards against this class of failure recurring.

---

## 3. Limitations and tradeoffs (and why we chose this)

**Editing migration history rather than adding a forward migration**

The standard rule for migration files is never edit a file that has already been
applied to a live database. We broke this rule for files `001`–`004` deliberately.

Why a forward-only migration could not work here: the fresh chain aborted at
`003` (TS103 before `create_hypertable` ran). Any hypothetical `012_reconcile`
file would never be reached because the chain cannot complete past file 3. The
only way to make a fresh install succeed was to fix the definitions that are read
first — `001` and `003`. A forward migration is viable only once the chain runs
to completion.

Why it is safe on existing databases: the migration runner identifies applied
files by filename only (no content checksum). Files `001`–`004` are already
recorded in `schema_migrations` on every existing DB. The runner skips them. The
edits therefore have zero effect on any database that has already run those
files. Every changed statement uses `IF NOT EXISTS` or `ON CONFLICT DO NOTHING`,
so even a forced re-run would be a safe no-op.

The accepted residual risk: an existing database that predates the M2 params
shape will have different physical columns in `personality_configs` and
`straddle_signals` from a fresh install, and the runner cannot detect or report
this divergence (no content-hash check). The development database was confirmed
schema-identical to a fresh install by direct diff after the fix; any other
long-lived database of unknown history is not automatically reconciled.

**Keeping duplicate definitions in 001 and 003 rather than removing**

After the fix, both `001` and `003` define `personality_configs` and
`straddle_signals`. The `003` definitions are now no-ops on fresh installs (the
tables already exist from `001`). They were left in place — with comments
noting they are historical no-ops — rather than deleted because removing them
would alter the content of an already-applied migration file on existing
databases, which the runner would then flag as "applied but content changed" in
any future system that adds checksums. The maintenance cost is documented: if a
column is added to either table, both `001` and `003` must be updated together.

**Composite PK means `straddle_signals.id` is not standalone-unique**

TimescaleDB requires the partition column (`time`) in the primary key. The
resulting composite `PRIMARY KEY (id, time)` enforces uniqueness only on the
pair, not on `id` alone. The Brier-score calibration query in `brier-score.ts`
joins `paper_trades` to `straddle_signals` on `id` alone. In practice UUID
v4 collision is astronomically improbable (no code path reuses signal IDs), so
this is a structural assumption rather than an exploitable defect. No standalone
`UNIQUE(id)` index was added in this epic; see Section 7.

**Foreign key on `paper_trades.signal_id` permanently removed**

A FK from `paper_trades.signal_id` to `straddle_signals(id)` is structurally
impossible while `straddle_signals` has a composite primary key — PostgreSQL
cannot back a FK to a column that is not itself uniquely constrained. The FK is
therefore gone permanently unless `straddle_signals.id` gains a separate UNIQUE
index. The consequence is that orphaned `signal_id` values in `paper_trades`
are silently excluded from Brier-score calibration (INNER JOIN produces no
row), which is the correct behavior for SCHEDULED/Clockwork entries that
legitimately have no associated signal.

**Duplicate filename prefixes deferred**

Files `002_*`, `003_*`, `004_*`, and `005_*` each appear twice. The runner's
lexicographic sort produces the correct apply order by accident. Renumbering
the secondary file in each pair would change its sort position and simultaneously
change the filename key stored in `schema_migrations`, causing the runner to
treat the renamed file as unapplied on every existing database — a silent
re-run risk. A safe renumber requires a coordinated `schema_migrations` update
in the same transaction. This is not blocked on any current feature and is
deferred; the risk is low because the existing order satisfies all dependency
constraints.

**Migration runner identifies applied files by filename only (no checksum)**

This property is what makes the in-place edits safe on existing databases. The
flip side is that two databases both reporting "all 15 files applied" may have
different physical schemas if one was migrated before the edits were made. The
only mitigation in place is the verified schema equivalence between the live dev
database and a fresh install at the time of this fix. A forward reconciliation
migration (`012_reconcile`) would close this window permanently; it is deferred
(see Section 7).

---

## 4. Tests the AI ran to verify this works

**Typecheck — `bun run --bun tsc --noEmit`**
Result: PASS (clean). Covers the H1 fix (`eod-retrospection-job.ts` row type),
the T-07 `@deprecated` annotations in `schema.ts`, and all changed migration
files (SQL, not compiled, but TS callers of the affected types).

**Unit suite — `bun run test:unit`**
File: all 45 unit test files under `src/test/unit/`
Result: PASS — 815 passed, 3 skipped, 0 failures.
What it proves: no behavior regression in any algorithm, filter stage, or helper
that touches personality parameters accessed via the `params` JSONB bag.

**Migration regression test — T-06**
File: `src/test/integration/migrations.integration.test.ts`
Result: PASS — 13 assertions passed.
What each assertion proves:
- Full 15-file fresh chain applies without error (exit 0).
- `personality_configs` contains exactly 10 rows.
- Exactly 4 TimescaleDB hypertables exist: `market_ticks`, `option_ticks`,
  `straddle_signals`, `straddle_snapshots`.
- `straddle_signals` primary key is composite `(id, time)` — confirmed by
  querying `pg_constraint`.
- `paper_trades.signal_id` column exists with no foreign-key constraint —
  confirmed by querying `information_schema.referential_constraints`.
- Second call to `runMigrations()` on the same database is a clean no-op
  (idempotency).
- `schema_migrations` records exactly 15 filenames.
- Suite skips cleanly when `DATABASE_URL` is unset (the `hasDatabase` guard
  is preserved).

**Migration chain on existing dev database**
Ran `bun run migrate` against the live dev database (files `001`–`009` and
`004_paper_trades_m2` already recorded in `schema_migrations`). Files `010` and
`011` applied cleanly in sequence. Post-apply schema diff against a fresh-install
database showed column-for-column equivalence for `personality_configs`,
`straddle_signals`, `paper_trades`, and `retrospection_results`.

**Dev server boot**
`bun run dev` (simulation mode) started without error and the API was reachable
on port 3000 after `010` applied on the dev database.

**Pre-existing integration failures — not caused by this work**
Running the full integration suite (not just the migration test) surfaced
approximately 21 failures across `personality-filter`, `reconstruct-idempotency`,
`performance-api`, `personalities-api`, and `smoke` tests. Investigation
confirmed all are pre-existing:
- Several tests insert `paper_trades` rows without a `symbol` value, which
  violates the `NOT NULL` constraint dating to the original `001` migration
  (commit `9572a1c`). These tests failed against the dev database before this
  epic began.
- Reconstruction tests fail due to unrelated `straddle_snapshots` setup issues.
- A `pg_type_typname_nsp_index` duplicate surfaces when tests run without a
  prior `bun run migrate` step (parallel `runMigrations()` race in the harness);
  CI avoids this by running migrate first.

None of these failures are attributable to or worsened by this migration fix.
Push CI is currently entirely red at a pre-existing Biome lint failure unrelated
to this epic.

**E2E tests**
Not applicable. This epic touches only the database migration chain and one
server-side job; there is no UI surface, no HTTP route change, and no new API
endpoint. No Playwright tests were added or run. Automation Gate status: CI-ONLY.

---

## 5. Manual test cases (for human verification)

**MTC-1 — Fresh database migrates end-to-end without error**
- Preconditions: Docker Compose running (`docker compose up -d`). No existing
  `ai_trading_agent` database (or run `docker compose down -v` first to start
  clean).
- Steps:
  1. `docker compose up -d` and wait for both services to show `(healthy)`.
  2. `bun run migrate`
  3. Connect to the database:
     `docker exec -it <postgres_container> psql -U postgres -d ai_trading_agent`
  4. Run: `SELECT COUNT(*) FROM personality_configs;`
  5. Run: `SELECT COUNT(*) FROM timescaledb_information.hypertables;`
  6. Run: `SELECT constraint_name, constraint_type FROM information_schema.table_constraints WHERE table_name='straddle_signals' AND constraint_type='PRIMARY KEY';`
  7. Run: `SELECT COUNT(*) FROM schema_migrations;`
- Expected result: Step 2 exits 0 with no error output. Step 4 returns `10`.
  Step 5 returns `4`. Step 6 returns one row with a composite PK name (not a
  single-column PK). Step 7 returns `15`.

**MTC-2 — Dev server boots on an existing database**
- Preconditions: Existing dev database with files 001–009 already applied
  (standard development environment). Migration 010 is NOT recorded in
  `schema_migrations`.
- Steps:
  1. `SIMULATE=true bun run dev`
  2. Watch startup output for any `ERROR` or `migration failed` lines.
  3. Wait for `Fastify server listening` (or equivalent) in stdout.
  4. `curl -s http://localhost:3000/api/personalities | head -c 200`
- Expected result: Server starts without error. `010` and `011` apply cleanly in
  the startup log. The API returns a JSON array of personalities (or `{}`/`[]`
  if no active signals — that is correct).

**MTC-3 — Migration idempotency**
- Preconditions: Any fully-migrated database (fresh or dev). Server not running.
- Steps:
  1. `bun run migrate` (first run — should be a no-op since all 15 files are
     already recorded).
  2. Note the output (should say "no new migrations" or similar with 0 applied).
  3. `bun run migrate` again (second run).
- Expected result: Both runs exit 0. No SQL errors. No duplicate rows in any
  table. `SELECT COUNT(*) FROM personality_configs` still returns `10`.

**MTC-4 — EOD job no longer crashes on startup**
- Preconditions: Fully-migrated database. `bun run dev` running (any mode).
- Steps:
  1. In a second terminal: `grep -n "primary_symbol" src/jobs/eod-retrospection-job.ts`
  2. Optionally trigger a manual retrospection via the API:
     `curl -s -X POST http://localhost:3000/api/retrospection/trigger`
  3. Check server logs for any `column "primary_symbol" does not exist` error.
- Expected result: Step 1 returns no matches (the column reference was removed).
  Step 3 shows no `primary_symbol` error. The retrospection job either runs
  successfully or returns a known non-crash error (e.g. no trades to process for
  today's date).

**MTC-5 — Clockwork personality is seeded correctly and frozen**
- Preconditions: Fully-migrated database (fresh or dev).
- Steps:
  1. Connect to the database.
  2. `SELECT name, display_name, is_frozen, group_type, params FROM personality_configs WHERE name = 'clockwork';`
  3. `SELECT COUNT(*) FROM personality_configs WHERE is_frozen = TRUE;`
- Expected result: Step 2 returns one row with `name='clockwork'`,
  `display_name='Clockwork'`, `is_frozen=true`, `group_type='reference'`,
  and `params` containing at least `max_daily_trades` and `max_daily_loss`.
  Step 3 returns `1` (only Clockwork is frozen).

**MTC-6 — Schema diff between fresh and existing dev database**
- Preconditions: Two running databases — one fresh (MTC-1 result) and one
  existing dev database, both fully migrated.
- Steps: On each database, run:
  ```sql
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name IN ('personality_configs','straddle_signals','paper_trades','retrospection_results')
  ORDER BY table_name, ordinal_position;
  ```
  Compare the output side-by-side.
- Expected result: Column lists are identical between the two databases for all
  four tables. Any difference indicates a pre-existing divergence from before
  this fix (investigate against the schema_migrations filename records to
  identify which file produced the divergence).

---

## 6. Security and risk notes

**Resolved findings**

No Critical, High, or Medium findings were introduced by this diff.

The one High finding resolved in this epic (H1 — `primary_symbol` column in the
EOD job) was a pre-existing bug exposed by the specialist review, not introduced
by the migration changes. It was fixed in scope because it would have caused
silent total failure of the learning engine.

Security review verdict: PASS (0 Critical / 0 High / 0 Medium / 2 Low).
The two Low findings are structural, not exploitable:
- `straddle_signals.id` not standalone-unique: id-only Brier-score join relies
  on `gen_random_uuid()` making collisions negligibly improbable. Accepted.
  Optional hardening: `CREATE UNIQUE INDEX IF NOT EXISTS idx_straddle_signals_id`
  (deferred — see Section 7).
- `paper_trades.signal_id` bare UUID, no FK: unavoidable by TimescaleDB
  composite-PK design. Accepted by design and documented in migration comments.

**Clockwork immutability**

The `002_seed_clockwork.sql` fix uses `ON CONFLICT (name) DO NOTHING` — it
never overwrites an existing Clockwork row. The `010` UPDATE that backfills
`display_name`/`group_type` is guarded by `display_name IS NULL` and does not
touch `is_frozen`, `params`, `entry_type`, or `management_style`. The evolution
engine's `FROZEN_VIOLATION` guard in `evolution-engine.ts` is not touched by
this epic. Clockwork parameter drift from migration edits is not possible.

**No destructive SQL**

Every statement in the changed migration files is `CREATE ... IF NOT EXISTS`,
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`,
or a `NULL`-guarded `UPDATE`. There are no `DROP TABLE`, `DROP COLUMN`,
`DELETE`, or `TRUNCATE` statements anywhere in this diff. An existing database
that somehow re-ran these files (which the runner prevents by filename check)
would produce no data loss.

**No secrets introduced**

No credentials, API keys, or connection strings appear in any changed file. The
diff is pure DDL/seed and TypeScript type comments.

**Feature flag / rollback**

There is no feature flag for a migration fix. Rollback path: `docker compose down -v`
restores a clean slate on development. On a production database, the safe
rollback is to restore from a pre-migration backup; no destructive SQL was
executed so no data is lost from the migration itself. The EOD job H1 fix
(`eod-retrospection-job.ts`) can be reverted by reverting that one file — the
job was already non-functional before the fix, so reverting simply restores the
pre-fix crash behavior.

---

## 7. Follow-ups and deferred work

**Optional — `UNIQUE(id)` index on `straddle_signals`**
Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_straddle_signals_id ON straddle_signals (id)` in a new forward migration. Converts the Brier-score join's `id`-uniqueness assumption from "guaranteed by `gen_random_uuid()` in practice" to "enforced by the schema." Low urgency; no current code path can create a collision. (Security finding Sec-L1.)

**Optional — `012_reconcile` forward migration for legacy-DB safety**
A forward migration with `ADD COLUMN IF NOT EXISTS` for all M2 columns on
`personality_configs` and `straddle_signals`. On fresh installs and the current
dev database this is a no-op. On a long-lived database that predates the M2
reshape (if one exists), it would materialise the correct columns without a
destructive reset. Deferred because the dev database is already confirmed
schema-identical to a fresh install; the risk applies only to unknown legacy
databases. (Architecture finding Arch-L5.)

**Medium — Non-sargable `DATE()` queries on hot paths (Perf M1)**
Three files wrap `entry_time` in `DATE(entry_time AT TIME ZONE 'Asia/Kolkata')`
to filter today's trades: `personality-filter.ts:146`, `paper-trade-executor.ts:254`,
`position-monitor.ts:560`. This defeats index pruning on queries that run every
15 seconds during a trading session. Fix: replace with explicit UTC midnight
range bounds as already done in `brier-score.ts:97-110`. Accrues cost gradually
as `paper_trades` grows. Not in scope for this epic. (Performance finding M1.)

**Low — Fold `signal_id` index into migration 004 (Perf M2)**
`idx_paper_trades_signal_id` is currently created only in `011_retrospection_indexes.sql`.
Any database migrated without applying `011` (e.g., a staging dump taken between
004 and 011) runs the Brier-score JOIN as a sequential scan. Consider promoting
the `CREATE INDEX IF NOT EXISTS` into `004_paper_trades_m2.sql` so it is always
present. Low urgency; `011` covers all fresh installs. (Performance finding M2.)

**Low — Duplicate filename prefixes in `src/db/migrations/`**
Pairs `002_*`, `003_*`, `004_*`, `005_*` each appear twice. The current
lexicographic apply order is dependency-safe by coincidence. A future third file
at any of these prefixes could create a silent dependency violation on fresh
installs. Renumbering requires a coordinated `schema_migrations` re-key
migration. Deferred; document the runner's filename-only identity model in
`migrate.ts` header comments or a `MIGRATIONS.md` to warn future authors.
(Architecture finding Arch-L4.)

**Low — Dead Clockwork `UPDATE` in 010**
`010_retrospection_evolution.sql` retains an `UPDATE ... WHERE name = 'Clockwork'`
(capital C). The `002` seed uses lowercase `clockwork`; the WHERE clause matches
zero rows on every install. The `display_name IS NULL` guard is also permanently
false after the `002` fix. The statement is a safe no-op but the comment above
it is misleading. Add a clarifying comment or remove the block. (Architecture
finding Arch-L1.)

**Low — `PersonalityConfigSnake` unused import in `position-monitor.ts`**
Line 63 imports and aliases the deprecated `PersonalityConfig` M1 type as
`PersonalityConfigSnake`. The alias is never used in the file body. Removing
the import line eliminates a misleading signal without any behavior change.
(Architecture finding Arch-L2.)

**Pre-existing — CI Biome lint failure**
Push CI (`ci.yml`) stops at the Biome lint step, so unit and integration tests
do not run on push. This is unrelated to the migration fix and predates this
epic. Needs a separate fix before CI is reliable again.

**Pre-existing — ~21 broken integration tests**
Tests in `personality-filter`, `reconstruct-idempotency`, `performance-api`,
`personalities-api`, and `smoke` suites fail due to: (a) `paper_trades` inserts
missing a required `symbol` column (constraint dates to commit `9572a1c`);
(b) straddle-snapshots reconstruction setup errors. None are caused by or
related to this migration fix. Need a dedicated cleanup pass.

---

## 8. References

**Task contracts**
- `pipeline/tasks/T-01.json` — Fix `001_core_schema.sql`
- `pipeline/tasks/T-02.json` — Fix `002_seed_clockwork.sql`
- `pipeline/tasks/T-03.json` — Fix `003_personality_signals_schema.sql`
- `pipeline/tasks/T-04.json` — Fix `004_paper_trades_m2.sql`
- `pipeline/tasks/T-05.json` — Fix `010_retrospection_evolution.sql`
- `pipeline/tasks/T-06.json` — Extend migration integration test
- `pipeline/tasks/T-07.json` — Add `@deprecated` to dead M1 types in `schema.ts`

**Review reports**
- `pipeline/reviews/security.md` — PASS (0C/0H/0M/2L)
- `pipeline/reviews/performance.md` — CONDITIONAL PASS (0C/1H/2M/2L)
- `pipeline/reviews/architecture-report.md` — PASS (0C/0H/0M/5L)
- `pipeline/reviews/synthesis.md` — CONDITIONAL PASS overall (driven by H1 pre-existing bug)
- `pipeline/reviews/automation-gate.md` — CI-ONLY for E2E; all other checks PASS
- `pipeline/diagnosis.md` — Phase 0.7 root-cause investigation
- `pipeline/plan-fresh-install.md` — Phase 1 plan + sprint 2 revisions

**Key changed files**
- `src/db/migrations/001_core_schema.sql` — canonical params-shape tables, composite hypertable PK, FK and stale index removed
- `src/db/migrations/002_seed_clockwork.sql` — params-shape Clockwork seed with conflict guard
- `src/db/migrations/003_personality_signals_schema.sql` — `straddle_signals` PK made composite (self-consistent)
- `src/db/migrations/004_paper_trades_m2.sql` — legacy `straddle_signals` FK dropped
- `src/db/migrations/010_retrospection_evolution.sql` — dead M1-to-params backfill removed
- `src/db/schema.ts` — `@deprecated` annotations on unused M1 types
- `src/jobs/eod-retrospection-job.ts` — `primary_symbol` column reference removed (H1 fix)
- `src/test/integration/migrations.integration.test.ts` — extended with 13 fresh-install assertions
- `.claude/project/technical.md` — updated project context for migration patterns
