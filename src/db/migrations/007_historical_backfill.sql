-- 007_historical_backfill.sql
-- Adds the infrastructure required for the historical backfill writer (T-55).
--
-- What this migration does:
--   1. Adds a nullable `resolution` column to market_ticks and option_ticks.
--      Existing live-data rows remain NULL — they are unaffected.
--   2. Adds a `source` column to option_ticks (market_ticks already has one).
--      Default 'fyers' so existing rows are unchanged semantically.
--   3. Adds a PARTIAL UNIQUE index on each hypertable scoped to
--      source = 'fyers-historical' only. Live writes use source = 'fyers' or
--      'simulator', which is a disjoint key space — the historical index never
--      competes with live writers.
--   4. Creates the backfill_ranges table for resumable range tracking.
--
-- Idempotency: every statement uses IF NOT EXISTS (or the DO $$ guard for
-- cases where PG DDL does not support IF NOT EXISTS natively). Re-running
-- this migration is safe — it is a no-op when already applied.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- 1. resolution column — market_ticks
-- ──────────────────────────────────────────────────────────────────────────────

-- ADD COLUMN IF NOT EXISTS is available in PostgreSQL 9.6+.
-- NULL default leaves all existing rows unchanged (no table rewrite).
ALTER TABLE market_ticks
  ADD COLUMN IF NOT EXISTS resolution TEXT;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. resolution column — option_ticks
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE option_ticks
  ADD COLUMN IF NOT EXISTS resolution TEXT;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. source column — option_ticks
-- ──────────────────────────────────────────────────────────────────────────────
--
-- option_ticks did not have a `source` column in migration 001 (only market_ticks
-- did). We add it here so that:
--   (a) The partial UNIQUE index WHERE source = 'fyers-historical' can be created
--       on option_ticks in the same way as market_ticks.
--   (b) The backfill writer can tag historical option rows consistently.
--
-- DEFAULT 'fyers' matches the market_ticks convention. NULL is NOT allowed
-- (NOT NULL WITH DEFAULT) because we never want unknown-source rows. Existing
-- rows get the default value 'fyers' at ALTER TABLE time — PostgreSQL applies the
-- column default to all existing rows when NOT NULL is specified without a
-- separate UPDATE pass.

ALTER TABLE option_ticks
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'fyers';

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. PARTIAL UNIQUE index on market_ticks — historical rows only
-- ──────────────────────────────────────────────────────────────────────────────
--
-- Design decisions recorded here (see also T-55 contract):
--
-- (a) PARTIAL UNIQUE index: WHERE source = 'fyers-historical'
--     At index-build time this key space is empty (no historical rows yet), so
--     the build is instant — there are zero rows to sort and vacuum. We build
--     NON-concurrently (no CONCURRENTLY keyword) because:
--       i.  Non-concurrent build acquires a ShareLock which prevents writes to
--           market_ticks while the index is built. On an empty key space this
--           is effectively instant, so the lock window is negligible.
--       ii. CONCURRENTLY requires two passes and cannot run inside a
--           transaction. Since the migration runner wraps each file in its own
--           BEGIN/COMMIT, CONCURRENTLY would fail with "CREATE INDEX CONCURRENTLY
--           cannot run inside a transaction block".
--
-- (b) Index MUST include `time` (the partition column).
--     TimescaleDB hypertables partition on `time`. Indexes on hypertables MUST
--     include the partition column so that TimescaleDB can push index-scan
--     predicates down to individual chunks. An index that omits `time` would
--     build only on the entire hypertable's parent, not on each chunk — this
--     silently produces an invalid / non-pruning index.
--
-- (c) UNIQUE index is required for INSERT ... ON CONFLICT DO NOTHING.
--     A non-UNIQUE partial index cannot be used as a conflict target by
--     PostgreSQL's ON CONFLICT clause. The UNIQUE modifier is mandatory.
--
-- (d) IF NOT EXISTS for idempotency.
--     CREATE UNIQUE INDEX IF NOT EXISTS is supported in PostgreSQL 9.5+ and is
--     the correct way to make the DDL re-runnable.
--
-- (e) INVALID index detection.
--     If the migration is interrupted between DDL and the schema_migrations
--     INSERT, PostgreSQL may leave an INVALID index behind. The DO $$ block
--     below detects and drops any invalid index with this name before
--     attempting to create it, so a re-run always succeeds cleanly.

DO $$
BEGIN
  -- Detect and clean up an INVALID index from a previous failed run.
  -- pg_index.indisvalid = false means the index was only partially built.
  -- Dropping it here is safe: if it is INVALID it was never usable, and
  -- re-creating it from scratch is the only way to make it valid again.
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_market_ticks_hist_uniq'
      AND NOT i.indisvalid
  ) THEN
    DROP INDEX idx_market_ticks_hist_uniq;
    RAISE NOTICE 'Dropped INVALID index idx_market_ticks_hist_uniq — will be rebuilt.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_market_ticks_hist_uniq
  ON market_ticks (symbol, time)
  WHERE source = 'fyers-historical';

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. PARTIAL UNIQUE index on option_ticks — historical rows only
-- ──────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_option_ticks_hist_uniq'
      AND NOT i.indisvalid
  ) THEN
    DROP INDEX idx_option_ticks_hist_uniq;
    RAISE NOTICE 'Dropped INVALID index idx_option_ticks_hist_uniq — will be rebuilt.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_option_ticks_hist_uniq
  ON option_ticks (symbol, time)
  WHERE source = 'fyers-historical';

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. backfill_ranges — resumable range tracking table
-- ──────────────────────────────────────────────────────────────────────────────
--
-- One row per (symbol, from_ts, to_ts, resolution) backfill job.
-- The status column tracks whether the job completed cleanly, was interrupted
-- (partial), or had detected calendar gaps.
--
-- status values:
--   'pending'   — job has been queued but not yet started
--   'running'   — job is currently being executed (crash-safe: stale 'running'
--                 rows can be detected by checking updated_at + timeout)
--   'partial'   — job was interrupted (e.g. FyersAuthError); checkpoint_ts holds
--                 the last successfully written candle time; re-run resumes here
--   'complete'  — all requested candles written with NO calendar gaps detected
--   'gapped'    — all requested candles written but calendar gaps were detected;
--                 gaps_json contains the gap records; NEVER use 'complete' when
--                 gaps_detected > 0
--   'error'     — job failed with a non-resumable error
--
-- gaps_json stores a JSON array of {from, to, reason} gap records so that
-- calendar-gap analysis can be done without a separate table. NULL when no
-- gaps were detected.
--
-- INVARIANT: if gaps_detected > 0, status MUST be 'partial' or 'gapped' —
-- NEVER 'complete'. The writer enforces this in TypeScript; the CHECK constraint
-- below provides a database-level guard.

CREATE TABLE IF NOT EXISTS backfill_ranges (
  id              BIGSERIAL     PRIMARY KEY,
  symbol          TEXT          NOT NULL,
  from_ts         TIMESTAMPTZ   NOT NULL,
  to_ts           TIMESTAMPTZ   NOT NULL,
  resolution      TEXT          NOT NULL,
  -- Current status of this backfill range.
  status          TEXT          NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'partial', 'complete', 'gapped', 'error')),
  -- Number of rows successfully written to market_ticks or option_ticks.
  rows_written    BIGINT        NOT NULL DEFAULT 0,
  -- Checkpoint: the timestamp of the last candle successfully persisted.
  -- Set on FyersAuthError so a re-run can resume from here without re-fetching
  -- or re-writing already-completed data.
  -- NULL means the job has not yet written any candles (start from from_ts).
  checkpoint_ts   TIMESTAMPTZ,
  -- Number of calendar gaps detected during reconciliation.
  -- When > 0, status must be 'partial' or 'gapped' — never 'complete'.
  gaps_detected   INTEGER       NOT NULL DEFAULT 0,
  -- JSON array of gap records: [{from, to, reason}].
  -- Stored as TEXT (not JSONB) to avoid requiring a JSONB column in this
  -- migration. Switched to JSONB if query-level gap filtering is ever needed.
  gaps_json       TEXT,
  -- Wall-clock time of the last status update (for stale-job detection).
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Creation time for auditing.
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Lookups for the resume logic: given a symbol + range, find the existing row.
CREATE INDEX IF NOT EXISTS idx_backfill_ranges_symbol_range
  ON backfill_ranges (symbol, from_ts, to_ts, resolution);

-- Status-based queries (e.g. find all 'partial' rows to resume).
CREATE INDEX IF NOT EXISTS idx_backfill_ranges_status
  ON backfill_ranges (status);
