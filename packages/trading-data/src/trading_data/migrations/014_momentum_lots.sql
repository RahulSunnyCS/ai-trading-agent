-- BL-142 Phase 2-3: the lot ledger. The owner follows a favourite group (one sleeve per Friday)
-- with one real lot per sleeve; Kite shows one combined holding per stock, so which shares belong
-- to which lot is kept here.
--
-- momentum_lot_events is append-only: a lot's shares of a symbol are the sum of its deltas.
-- `symbol` is the broker's base symbol (CUPID, MON100), `sleeve_id` the group member's saved-run
-- id (never the dashboard's renumbered label). `kind`: 'seed' (the first holdings, from a snapshot),
-- 'attributed' (a change in Kite's holdings the ledger booked to the lot whose orders were last
-- made), 'assigned' (the owner assigned a change the ledger could not explain), 'manual'.
CREATE TABLE IF NOT EXISTS momentum_lot_events (
    owner      TEXT NOT NULL,
    group_id   TEXT NOT NULL,
    sleeve_id  TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    delta      DOUBLE NOT NULL,
    booked_at  TEXT NOT NULL,            -- ISO 8601 with offset: the snapshot that revealed it
    kind       TEXT NOT NULL CHECK (kind IN ('seed', 'attributed', 'assigned', 'manual')),
    note       TEXT
);

-- The lot whose orders were made most recently, and what each lot was told to trade (JSON,
-- {sleeve_id: {symbol: signed shares}}, sells negative): the next change in Kite's holdings is
-- booked against those quantities first (the owner trades on Monday what Friday's orders said),
-- and only what is left goes to the pending lot.
CREATE TABLE IF NOT EXISTS momentum_lot_state (
    owner              TEXT NOT NULL,
    group_id           TEXT NOT NULL,
    pending_sleeve_id  TEXT,
    planned            TEXT,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (owner, group_id)
);

-- A new lot (a sleeve that holds nothing yet) is funded with this much, or with all the free
-- cash when that is more (owner, 2026-10-21: Rs 50,000 a week up to Rs 2 lakh).
ALTER TABLE momentum_owner_settings ADD COLUMN IF NOT EXISTS lot_size_rs DOUBLE DEFAULT 50000;
