-- Migration 004: Link paper_trades to personalities and signals (Milestone 2)
--
-- All three new columns are nullable. Pre-M2 rows (Milestone 1 trades) will have
-- NULL for personality_id, parent_trade_id, and signal_id — this is correct and
-- expected. NULL here means "trade created before the personality engine existed",
-- not "data is missing".
--
-- ADD COLUMN IF NOT EXISTS is idempotent: re-running this migration on a database
-- that already has these columns is a no-op rather than an error.

-- personality_id — which personality opened this trade.
-- NULL for all Milestone 1 trades (pre-personality-engine).
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS personality_id  UUID REFERENCES personality_configs(id);

-- parent_trade_id — self-referential link used by the Roll (Adjuster) management
-- style: when a leg is closed and re-entered at a new strike the new trade row
-- references the original trade via this column.
-- NULL for all standard (non-rolled) trades.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS parent_trade_id UUID REFERENCES paper_trades(id);

-- signal_id — the straddle_signals row that triggered this trade.
-- NULL for Milestone 1 trades and for Clockwork fixed-time entries (which do not
-- originate from a detected signal).
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS signal_id       UUID REFERENCES straddle_signals(id);

-- Index on personality_id: the API and retrospection engine query trades grouped
-- by personality frequently (e.g. WHERE personality_id = $1 AND status = 'open').
CREATE INDEX IF NOT EXISTS idx_paper_trades_personality ON paper_trades (personality_id);

-- Index on parent_trade_id: used to reconstruct roll chains for the Adjuster's
-- trade history view (WHERE parent_trade_id = $1 ORDER BY entry_time).
CREATE INDEX IF NOT EXISTS idx_paper_trades_parent      ON paper_trades (parent_trade_id);
