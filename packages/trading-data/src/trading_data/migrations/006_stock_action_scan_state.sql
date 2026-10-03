-- The first audit covers existing history. Only subsequent ex-dates should ask
-- the dashboard user for a manual decision after a stock-data refresh.
CREATE TABLE stock_action_scan_state (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    manual_review_after  DATE NOT NULL,
    last_scanned_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
