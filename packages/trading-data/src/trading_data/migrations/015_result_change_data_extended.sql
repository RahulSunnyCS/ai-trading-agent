-- A new label for momentum_result_changes: `data_extended`, a moved result that only added later
-- weeks (every week the two runs share is identical). DuckDB cannot alter a CHECK constraint, so
-- the table is rebuilt with every row kept; the columns and their order are 011's.
CREATE TABLE momentum_result_changes_015 (
    change_id       TEXT PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    dataset         TEXT NOT NULL,
    version_id      TEXT NOT NULL,
    anchor_run_id   TEXT NOT NULL,
    prev_run_id     TEXT NOT NULL,
    run_id          TEXT NOT NULL,
    label           TEXT NOT NULL CHECK (label IN
                        ('data_extended', 'data_revised', 'intended', 'check', 'not_reproducible',
                         'unknown')),
    prev_versions   JSON,
    versions        JSON,
    changed         JSON,
    first_difference DATE,
    kpis_before     JSON NOT NULL,
    kpis_after      JSON NOT NULL,
    detail          JSON,
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     TEXT
);
INSERT INTO momentum_result_changes_015
SELECT change_id, created_at, dataset, version_id, anchor_run_id, prev_run_id, run_id, label,
    prev_versions, versions, changed, first_difference, kpis_before, kpis_after, detail, reviewed_at,
    reviewed_by
FROM momentum_result_changes;
DROP TABLE momentum_result_changes;
ALTER TABLE momentum_result_changes_015 RENAME TO momentum_result_changes;
