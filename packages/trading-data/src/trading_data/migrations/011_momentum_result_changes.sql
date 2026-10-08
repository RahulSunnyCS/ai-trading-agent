-- BL-052: every time a saved Momentum strategy's result moves, why it moved.
--
-- One row per moved result, written in the same transaction as the run that moved it (by
-- momentum_backtesting.runs_store.save_run, and by `mbt saved merge` for runs saved before the
-- fingerprints existed). Append-only: nothing updates a row except `reviewed_at`/`reviewed_by`,
-- set once when the owner marks a Check or Not reproducible change reviewed, and nothing deletes
-- one. It is the record later analytics reads.
--
-- A run-record table: listed in momentum_backtesting.db_read.RUN_RECORD_TABLES, so writing a row
-- never changes the data version a backtest is keyed on (otherwise the first row would make an
-- identical rerun look like "data revised").
CREATE TABLE momentum_result_changes (
    change_id       TEXT PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    dataset         TEXT NOT NULL,
    version_id      TEXT NOT NULL,                -- the strategy (strategy_versions.version_id)
    anchor_run_id   TEXT NOT NULL,                -- the run holding the strategy's name and status
    prev_run_id     TEXT NOT NULL,
    run_id          TEXT NOT NULL,
    label           TEXT NOT NULL CHECK (label IN
                        ('data_revised', 'intended', 'check', 'not_reproducible', 'unknown')),
    prev_versions   JSON,                         -- {data, tables, lake, files, code}; NULL = not recorded
    versions        JSON,
    changed         JSON,                         -- what differs in the data: table names, lake, files
    first_difference DATE,                        -- first week the two curves disagree
    kpis_before     JSON NOT NULL,
    kpis_after      JSON NOT NULL,
    detail          JSON,                         -- e.g. {"reason": "<golden changelog reason>"}
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     TEXT
);
