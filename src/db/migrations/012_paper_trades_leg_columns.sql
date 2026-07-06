-- 012_paper_trades_leg_columns.sql
--
-- Adds the four CE/PE-leg columns that paper-trade-executor, adjuster, and the
-- /api/{paper-trades,trades} routes have always written/read but were never
-- migrated. Without this the personality router's openTrade() throws:
--   column "entry_ce_strike" of relation "paper_trades" does not exist
-- and no paper trade can be created — caught only when the full live/replay
-- chain was wired end-to-end in commit 5f1056a.
--
-- All four are nullable: existing rows (none in dev right now) keep NULL.
-- For an ATM straddle the CE and PE strikes are equal — see the inline
-- comment in paper-trade-executor.ts. Storing them separately keeps the
-- door open for future strangle / butterfly leg geometries without another
-- schema change.

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS entry_ce_strike NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS entry_pe_strike NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS entry_ce_price  NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS entry_pe_price  NUMERIC(12, 2);
