-- Indexes to support the entry engine's open-position check and API route queries.
-- The status column is queried frequently (WHERE status = 'open') with no existing
-- index, causing a sequential scan on every straddle snapshot (every 15 seconds).

CREATE INDEX IF NOT EXISTS idx_paper_trades_status
  ON paper_trades (status);

CREATE INDEX IF NOT EXISTS idx_paper_trades_status_entry_time
  ON paper_trades (status, entry_time DESC);
