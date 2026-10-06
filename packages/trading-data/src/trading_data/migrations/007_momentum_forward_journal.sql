-- BL-024: the forward-signal journal. Every weekly signal, recorded when it is produced and
-- never changed afterwards, so it can later be compared with what actually happened.
--
-- Append-only by convention AND by evidence: DuckDB has no triggers, so nothing here can
-- refuse an UPDATE or DELETE. Instead each row stores the hash of the row before it
-- (prev_hash) and of itself (row_hash) over its exact stored text; an edited or removed row
-- breaks the chain (`mbt journal verify`). The only writer is
-- momentum_backtesting.forward_journal.record, which only inserts.
--
-- Text, not JSON/TIMESTAMPTZ, for every hashed field: the hash is recomputed from the stored
-- bytes, so they must come back exactly as written. Cast `holdings_before`/`signal` to JSON
-- to query them.
CREATE TABLE momentum_forward_journal (
    entry_id          BIGINT PRIMARY KEY,
    recorded_at       TEXT NOT NULL,              -- ISO 8601 UTC, e.g. 2026-10-09T09:10:02.123456Z
    week              DATE NOT NULL,              -- the signal week (its Friday)
    run_kind          TEXT NOT NULL CHECK (run_kind IN ('preview', 'final')),
    source            TEXT NOT NULL CHECK (source IN ('favourite', 'benchmark')),
    config_id         TEXT NOT NULL,              -- saved favourite's run_id, or the benchmark name
    config_name       TEXT NOT NULL,
    dataset           TEXT NOT NULL,
    settings_hash     TEXT NOT NULL,
    settings          TEXT NOT NULL,              -- canonical JSON
    code_commit       TEXT NOT NULL,              -- git HEAD, '+dirty' when the tree had changes
    data_fingerprint  TEXT NOT NULL,
    holdings_before   TEXT NOT NULL,              -- canonical JSON {asset: weight}: the model
                                                  -- portfolio at the signal close, BEFORE the
                                                  -- signal's own BUY/SELL actions (the engine
                                                  -- never trades its newest week); the actions
                                                  -- are in `signal`. Next week's row holds the
                                                  -- result of carrying them out.
    signal            TEXT NOT NULL,              -- canonical JSON, the signal as produced
    supersedes        BIGINT,                     -- entry_id this row corrects (same week/run/config)
    prev_hash         TEXT NOT NULL,              -- row_hash of entry_id - 1; 64 zeros for the first
    row_hash          TEXT NOT NULL UNIQUE
);
