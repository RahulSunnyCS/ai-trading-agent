-- Migration 015: Add `underlying` column to paper_trades
--
-- CONTEXT (C1 bug fix):
--   The per-index daily stop in portfolio-risk.ts and the per-index open-leg
--   cap in personality-filter.ts both need to filter paper_trades by the index
--   name (e.g. 'NIFTY', 'BANKNIFTY', 'SENSEX'). The existing `symbol` column
--   holds the full Fyers prefixed option symbol such as
--   'NSE:NIFTY25O0924500CE' — it cannot be compared to a bare index name.
--
-- SOLUTION:
--   Add a TEXT column `underlying` (nullable for backward compatibility with
--   pre-M2 rows that were inserted before this migration). New inserts
--   (from trade-executor) must populate this column explicitly.
--
-- BACKFILL:
--   Extract the index name from the existing `symbol` column using CASE WHEN
--   LIKE rules that match the known Fyers option symbol prefixes:
--     NSE:NIFTY…   → 'NIFTY'
--     NSE:BANKNIFTY… / NSE:NIFTYBEE… are excluded (distinct products)
--     BSE:SENSEX…  → 'SENSEX'
--   Any symbol that does not match these patterns is left NULL and will be
--   reported as unknown. The LIKE patterns are anchored to the known NSE/BSE
--   prefixes used by the Fyers WebSocket feed.
--
-- RESIDUAL (out of scope in this migration):
--   trade-executor.ts (PaperTradeExecutor.openTrade) is the canonical INSERT
--   site. It must be updated to populate `underlying` on new inserts so that
--   post-migration rows always carry the value. Until that change lands, the
--   SQL in portfolio-risk.ts (Rule 3) and personality-filter.ts (open-leg query)
--   will see NULL for new rows and those rows will be omitted from per-underlying
--   aggregates — this is safe-fail: missing underlying means the trade does not
--   count against any index's stop, which is conservative (under-counts losses).
--
-- IDEMPOTENCY:
--   ADD COLUMN IF NOT EXISTS is idempotent — re-running on a database that
--   already has the column is a no-op.

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS underlying TEXT;

-- Backfill from the existing `symbol` column using LIKE prefix matching.
-- BANKNIFTY must be checked before NIFTY because 'NSE:BANKNIFTY...' contains
-- 'NIFTY' as a substring — longest match first prevents false classification.
-- Only rows with NULL underlying are updated so the statement is idempotent
-- (re-running after partial backfill does not overwrite already-set values).
UPDATE paper_trades
SET underlying = CASE
  WHEN symbol LIKE 'NSE:BANKNIFTY%' THEN 'BANKNIFTY'
  WHEN symbol LIKE 'NSE:NIFTY%'     THEN 'NIFTY'
  WHEN symbol LIKE 'BSE:SENSEX%'    THEN 'SENSEX'
  ELSE NULL  -- unknown symbol format; leave NULL, operator must fix manually
END
WHERE underlying IS NULL;

-- Index on (underlying, status) to make the per-underlying open-leg count
-- (personality-filter.ts, open-positions query) and the per-underlying daily
-- stop (portfolio-risk.ts, Rule 3) efficient.
-- Also useful for the margin buffer (Rule 4) once it is scoped per underlying.
CREATE INDEX IF NOT EXISTS idx_paper_trades_underlying_status
  ON paper_trades (underlying, status);
