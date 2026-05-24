-- Migration 012: Add S/R signal columns to straddle_signals
--
-- Phase 2 introduces Support/Resistance anchored signal detection (the
-- "Levelhead" personality and sr_anchored entry_type).  These four columns
-- extend the existing straddle_signals hypertable to carry the additional
-- metadata produced by the S/R engine.  Existing MOMENTUM_EXHAUSTION and
-- SCHEDULED rows are unaffected (all four columns are nullable).
--
-- Design decisions:
--
-- 1. TEXT CHECK vs Postgres enum
--    We use TEXT with a CHECK constraint rather than ALTER TYPE / ADD VALUE on
--    an enum.  Adding a value to a Postgres enum is a catalog-lock operation
--    that is NOT transactional (DDL takes a brief AccessExclusiveLock and
--    cannot be rolled back inside a transaction).  TEXT + CHECK is fully
--    transactional, can be widened without ALTER TYPE, and avoids the
--    `pg_dump` complications that come with enums across databases.  The
--    tradeoff is that the CHECK is enforced only at write time (not enforced
--    in TypeScript directly), which is acceptable because all writes go
--    through typed service-layer functions.
--
-- 2. sr_subtype allows NULL explicitly
--    The CHECK is written as (sr_subtype IS NULL OR sr_subtype IN (...))
--    rather than just sr_subtype IN (...) so that NULL is always accepted
--    without needing NOT NULL DEFAULT handling on the existing rows.
--
-- 3. ADD COLUMN IF NOT EXISTS
--    Makes the migration fully idempotent — safe to re-run on both fresh and
--    existing databases.  The migration runner already guards by filename, but
--    IF NOT EXISTS is the defensive SQL belt-and-suspenders.
--
-- 4. No index on sr_subtype here
--    Indexes on S/R signal columns belong in a later task when the query
--    patterns for the Levelhead personality are known.  Premature indexes on
--    a hypertable add chunk-level overhead for uncertain read benefit.

ALTER TABLE straddle_signals
  ADD COLUMN IF NOT EXISTS sr_subtype TEXT
    CHECK (sr_subtype IS NULL OR sr_subtype IN ('SR_REVERSAL'));

-- sr_strength [0.0, 1.0]: a continuous confidence score for how strongly the
-- price reacted at the S/R level.  Nullable because momentum signals do not
-- have a meaningful S/R strength value.
ALTER TABLE straddle_signals
  ADD COLUMN IF NOT EXISTS sr_strength NUMERIC;

-- poc_used: TRUE when the Point of Control (POC) of the session's volume
-- profile contributed to the S/R level used for this signal.  Nullable so
-- MOMENTUM_EXHAUSTION and SCHEDULED signals can leave it NULL without
-- implying FALSE (which would be semantically wrong).
ALTER TABLE straddle_signals
  ADD COLUMN IF NOT EXISTS poc_used BOOLEAN;

-- level_source: JSONB blob describing which S/R levels were consulted and
-- their weights, e.g.:
--   {"levels": [{"price": 22500, "type": "swing_high", "weight": 0.8}]}
-- Stored as JSONB (not TEXT) so the API layer can query into it with the ->
-- operator if needed without manual JSON.parse().  Shape is intentionally
-- open-ended because the S/R engine's level taxonomy will evolve in Phase 2.
ALTER TABLE straddle_signals
  ADD COLUMN IF NOT EXISTS level_source JSONB;
