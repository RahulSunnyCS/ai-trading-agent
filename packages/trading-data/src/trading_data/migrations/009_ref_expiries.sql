-- 009: every expiry date an index's options actually had (BL-034 Phase 2). Replaces the
-- weekday rule in ref_expiry_rules for history: NSE/BSE moved expiry weekdays more than once
-- (NIFTY Thursday -> Tuesday on 2025-09-01, SENSEX Friday -> Tuesday -> Thursday), and a
-- holiday moves a single expiry. Rows come from the lake (`tdata reference derive-expiries`,
-- source = 'observed') plus the few expiries the lake has no contracts for (source = 'added',
-- each with its reason in DECISIONS.md). Exported to expiries_observed.csv like every ref table.
CREATE TABLE ref_expiries (
    underlying  TEXT NOT NULL,
    expiry      DATE NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('observed', 'added')),
    PRIMARY KEY (underlying, expiry)
);
