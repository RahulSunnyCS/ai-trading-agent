-- 010: the risk-free rate for implied volatility (BL-034 Phase 3 needs it per day). The RBI
-- policy repo rate, effective from each Monetary Policy Committee decision date — a stand-in
-- for the 91-day T-bill, which trades close to it; at weekly expiries the rate moves an option
-- price by paise. Effective-dated like every ref table; exported as rates.csv.
CREATE TABLE ref_rates (
    name            TEXT NOT NULL,      -- RBI_REPO
    rate_pct        DOUBLE NOT NULL,    -- percent per year, e.g. 6.5
    effective_date  DATE NOT NULL,
    PRIMARY KEY (name, effective_date)
);
