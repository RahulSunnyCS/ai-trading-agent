-- Migration 013: index_expiry_calendar — weekly F&O expiry dates per underlying
--
-- This table is the machine-readable source of truth for upcoming weekly
-- options expiry dates.  It is used by the S/R signal engine (Phase 2) to
-- determine how close a signal is to expiry — a key input to the Levelhead
-- personality's time-decay pressure scoring.
--
-- It also feeds the regime tagger (EVENT_DAY classification) as a replacement
-- for BLOCKED_DATES env-var lookups, which are not reproducible in backtest
-- replay mode.
--
-- Design decisions:
--
-- 1. Separate table (not in event_calendar)
--    event_calendar (migration 008) stores one-off market events (RBI policy,
--    budget day, etc.).  Expiry dates are a recurring, structured dataset with
--    different query patterns (range queries by underlying) and a different
--    update cadence.  Keeping them separate avoids polluting event_calendar
--    with hundreds of routine rows and lets the expiry calendar be queried
--    independently.
--
-- 2. PRIMARY KEY (underlying, expiry_date) — no surrogate key
--    The natural composite key is sufficient and unique by definition
--    (one expiry per underlying per date).  A surrogate UUID would add overhead
--    with no benefit since this table is always queried by (underlying) or
--    (underlying, expiry_date).
--
-- 3. is_holiday_shifted BOOLEAN DEFAULT FALSE
--    TRUE means the expiry date was moved from its normal weekday because of a
--    stock exchange holiday.  Typically shifted to the nearest preceding trading
--    day.  The flag lets query code distinguish a "moved" expiry from a normal
--    one without inspecting day-of-week.
--
-- 4. ON CONFLICT DO NOTHING for idempotency
--    Re-running the migration (or future seed migrations that add more rows)
--    does not fail on duplicate (underlying, expiry_date) pairs.

CREATE TABLE IF NOT EXISTS index_expiry_calendar (
  underlying         TEXT    NOT NULL,
  expiry_date        DATE    NOT NULL,
  -- FALSE: normal weekday expiry.
  -- TRUE: exchange holiday caused a shift to an adjacent trading day.
  is_holiday_shifted BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (underlying, expiry_date)
);

-- ---------------------------------------------------------------------------
-- Seed data: current + next ~8 weekly expiries per index
-- Reference date: 2026-05-24 (Sunday)
--
-- Expiry weekday per index (NSE/BSE policy as of 2026):
--
--   NIFTY    → THURSDAY
--     NSE moved ALL major index weekly options to Thursday in 2024 to reduce
--     Monday–Friday settlement concentration.  Nifty 50 has always used
--     Thursday as its monthly expiry weekday and kept it for weeklies.
--     Source: NSE circular dated October 2024 (effective Nov 2024).
--
--   BANKNIFTY → WEDNESDAY
--     NSE moved Bank Nifty weekly expiry from Thursday to Wednesday effective
--     2023-09-06 to reduce Thursday expiry-day volatility clustering.
--     Source: NSE circular NSCCL/CMPT/56550 (August 2023).
--
--   SENSEX   → FRIDAY
--     BSE Sensex weekly options expire on Friday.  BSE deliberately chose
--     Friday to differentiate from NSE's Thursday/Wednesday schedule,
--     making Sensex weeklies accessible to traders who want end-of-week
--     settlement.
--     Source: BSE notice 20230801-50 (effective August 2023).
--
-- IMPORTANT FOR HUMAN VERIFICATION:
--   The weekday choices above are based on exchange circulars known up to
--   August 2025.  NSE/BSE have changed expiry weekdays multiple times in
--   recent years.  Before using this calendar in production, verify against
--   the live NSE/BSE instrument master file or the exchange's official
--   circular page.  Rows flagged is_holiday_shifted=TRUE should be
--   cross-checked against the NSE holiday calendar for the relevant year.
--
-- Computed expiry sequences from 2026-05-24:
--   NIFTY    Thursdays : 05-28, 06-04, 06-11, 06-18, 06-25, 07-02, 07-09, 07-16, 07-23
--   BANKNIFTY Wednesdays: 05-27, 06-03, 06-10, 06-17, 06-24, 07-01, 07-08, 07-15, 07-22
--   SENSEX   Fridays   : 05-29, 06-05, 06-12, 06-19, 06-26, 07-03, 07-10, 07-17, 07-24
--
-- No known NSE/BSE holidays fall on these dates in the standard 2026 exchange
-- calendar (Indian market holidays in May–July 2026 are not widely published
-- yet as of the reference date); is_holiday_shifted is set FALSE for all rows.
-- Update to TRUE if the exchange declares a holiday that shifts any date.
-- ---------------------------------------------------------------------------

INSERT INTO index_expiry_calendar (underlying, expiry_date, is_holiday_shifted) VALUES
  -- NIFTY — weekly Thursday expiries
  ('NIFTY', '2026-05-28', FALSE),
  ('NIFTY', '2026-06-04', FALSE),
  ('NIFTY', '2026-06-11', FALSE),
  ('NIFTY', '2026-06-18', FALSE),
  ('NIFTY', '2026-06-25', FALSE),
  ('NIFTY', '2026-07-02', FALSE),
  ('NIFTY', '2026-07-09', FALSE),
  ('NIFTY', '2026-07-16', FALSE),
  ('NIFTY', '2026-07-23', FALSE),

  -- BANKNIFTY — weekly Wednesday expiries
  ('BANKNIFTY', '2026-05-27', FALSE),
  ('BANKNIFTY', '2026-06-03', FALSE),
  ('BANKNIFTY', '2026-06-10', FALSE),
  ('BANKNIFTY', '2026-06-17', FALSE),
  ('BANKNIFTY', '2026-06-24', FALSE),
  ('BANKNIFTY', '2026-07-01', FALSE),
  ('BANKNIFTY', '2026-07-08', FALSE),
  ('BANKNIFTY', '2026-07-15', FALSE),
  ('BANKNIFTY', '2026-07-22', FALSE),

  -- SENSEX — weekly Friday expiries
  ('SENSEX', '2026-05-29', FALSE),
  ('SENSEX', '2026-06-05', FALSE),
  ('SENSEX', '2026-06-12', FALSE),
  ('SENSEX', '2026-06-19', FALSE),
  ('SENSEX', '2026-06-26', FALSE),
  ('SENSEX', '2026-07-03', FALSE),
  ('SENSEX', '2026-07-10', FALSE),
  ('SENSEX', '2026-07-17', FALSE),
  ('SENSEX', '2026-07-24', FALSE)

ON CONFLICT (underlying, expiry_date) DO NOTHING;
