-- Large daily stock-price discontinuities, reviewed against the cached NSE
-- whole-market corporate-action feed. Keep this separate from raw bars: a
-- split changes the interpretation of a bar, not the exchange's reported bar.
CREATE TABLE stock_action_candidates (
    symbol              TEXT NOT NULL,
    ex_date             DATE NOT NULL,
    previous_close      DOUBLE NOT NULL,
    close               DOUBLE NOT NULL,
    previous_volume     BIGINT NOT NULL,
    volume              BIGINT NOT NULL,
    previous_turnover   DOUBLE NOT NULL,
    turnover            DOUBLE NOT NULL,
    implied_factor      DOUBLE,
    suggested_factor    DOUBLE,
    confirmed_factor    DOUBLE,
    cumulative_factor   DOUBLE,
    status              TEXT NOT NULL CHECK (status IN ('confirmed', 'crash', 'review')),
    event_kind          TEXT,
    source              TEXT,
    subject             TEXT,
    PRIMARY KEY (symbol, ex_date)
);

-- Human decisions survive a rescan or a fresh bhavcopy migration. A confirmed
-- factor changes the adjusted research series; a crash explicitly keeps raw P&L.
CREATE TABLE stock_action_reviews (
    symbol       TEXT NOT NULL,
    ex_date      DATE NOT NULL,
    decision     TEXT NOT NULL CHECK (decision IN ('split', 'bonus', 'crash')),
    factor       DOUBLE,
    source_url   TEXT,
    note         TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, ex_date)
);
