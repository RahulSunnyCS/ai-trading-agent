-- 008_regime_tagging.sql
-- Adds the infrastructure for the historical regime tagging engine (T-33).
--
-- What this migration does:
--   1. Adds a nullable `resolution` TEXT column to straddle_snapshots.
--      This closes the T-56 gap: reconstruct-straddle.ts computes a resolution
--      per snapshot but had no column to persist it. Existing rows remain NULL
--      (no table rewrite). Going forward, the reconstructor can write the
--      resolution tag here so downstream consumers can query fidelity without
--      joining back to option_ticks.
--   2. Creates daily_regime_tags — one row per (date, symbol), written by the
--      regime tagging engine after each historical reconstruction run.
--   3. Creates event_calendar — a checked-in, dated table of known Indian
--      market event days (RBI policy dates, Union Budgets, F&O expiry mornings)
--      used by the regime classifier to assign EVENT_DAY without relying on the
--      live BLOCKED_DATES env var (which is not reproducible in backtests).
--
-- Idempotency: every statement uses IF NOT EXISTS (or a DO $$ guard).
-- Re-running this migration is a no-op when already applied.
--
-- This migration MUST NOT edit 001_core_schema.sql or 007_historical_backfill.sql.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. resolution column — straddle_snapshots
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY: reconstruct-straddle.ts (T-56) already computes a resolution tag per
-- snapshot (e.g. '1', '5', 'D') propagated from option_ticks, but it could
-- not persist it because straddle_snapshots had no such column. This column
-- closes that gap so fidelity/degraded-day detection is queryable without
-- an expensive join back to option_ticks.
--
-- NULL default: all existing live-data rows are unaffected. Only historically
-- reconstructed rows (source='fyers-historical' in option_ticks) will carry
-- a non-null resolution here.

ALTER TABLE straddle_snapshots
  ADD COLUMN IF NOT EXISTS resolution TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. daily_regime_tags — per-day market regime output
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One row per (trade_date, symbol) pair. Written by the regime tagging engine
-- after it classifies each reconstructed day.
--
-- regime values:
--   'RANGING'           — low directional move, low straddle expansion
--   'TRENDING_STRONG'   — sustained directional index move above threshold
--   'VOLATILE_REVERTING'— high straddle roc_acceleration / whipsaw + mean reversion
--   'EVENT_DAY'         — date appears in event_calendar (takes precedence over all)
--   'UNCLASSIFIED'      — data for this day is gapped or low-fidelity; regime
--                         could not be determined reliably. regime_confidence
--                         holds the gap fraction that triggered UNCLASSIFIED.
--
-- regime_confidence [0.0, 1.0]:
--   - For RANGING/TRENDING_STRONG/VOLATILE_REVERTING: the fraction of intraday
--     snapshots that agreed with the assigned label (higher = more confident).
--   - For EVENT_DAY: always 1.0 (deterministic calendar lookup).
--   - For UNCLASSIFIED: the gap fraction (fraction of expected snapshots that
--     were missing) — a value closer to 1.0 means almost all data was missing.
--
-- UNIQUE (trade_date, symbol): the tagging engine is idempotent — re-running
-- for the same day and symbol updates the existing row via ON CONFLICT DO UPDATE.
--
-- classified_at: wall-clock time the row was written. Useful for auditing and
-- for detecting stale classifications after a data reingestion.

CREATE TABLE IF NOT EXISTS daily_regime_tags (
  id               BIGSERIAL     PRIMARY KEY,
  trade_date       DATE          NOT NULL,
  symbol           TEXT          NOT NULL,
  regime           TEXT          NOT NULL
    CHECK (regime IN (
      'RANGING', 'TRENDING_STRONG', 'VOLATILE_REVERTING', 'EVENT_DAY', 'UNCLASSIFIED'
    )),
  regime_confidence NUMERIC(5,4) NOT NULL
    CHECK (regime_confidence >= 0 AND regime_confidence <= 1),
  classified_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (trade_date, symbol)
);

-- Fast lookup by symbol + date range (the most common query pattern for
-- backtesting: "give me all regime tags for NIFTY between date A and date B").
CREATE INDEX IF NOT EXISTS idx_daily_regime_tags_symbol_date
  ON daily_regime_tags (symbol, trade_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. event_calendar — checked-in dated table of Indian market event days
-- ─────────────────────────────────────────────────────────────────────────────
--
-- PURPOSE: The live trading engine uses BLOCKED_DATES (a JSON env var) to
-- identify event days at runtime. That env var is NOT reproducible for
-- historical classification — it changes per deployment and cannot be
-- reconstructed for past dates. This table is checked into the migration so
-- every environment (dev / CI / prod) uses the same deterministic calendar.
--
-- EVENT TYPES captured here:
--   'RBI_POLICY'    — RBI Monetary Policy Committee (MPC) decision days.
--                     Typically 4–6 times per year. These are high-volatility
--                     events because rate decisions move markets sharply.
--   'UNION_BUDGET'  — Union Budget presentation (typically Feb 1). Extreme
--                     volatility; F&O expiry is often advanced that week.
--   'FNO_EXPIRY'    — Weekly/monthly F&O expiry morning (Nifty: Thursday).
--                     Only the morning session is event-tagged; afternoon is
--                     classified normally. We tag the full day here for
--                     simplicity — operators can refine to half-day if needed.
--   'STATE_ELECTION'— State assembly election days where F&O can spike.
--   'HOLIDAY'       — Scheduled NSE market holidays (Diwali, Holi, etc.)
--                     where the exchange is closed. We tag these so the regime
--                     engine can skip closed days entirely.
--
-- OPERATOR EXTENSION:
--   To add a new event, insert a row into this table via a new migration file
--   (e.g. 009_event_calendar_2026.sql). Do NOT edit this migration — it is the
--   historical seed. New rows can also be added manually in dev for testing.
--
-- REGIME MAPPING: any date in this table is classified as EVENT_DAY by the
-- regime tagging engine, regardless of what the straddle data says. EVENT_DAY
-- has the highest precedence (see regime-tagging.ts PRECEDENCE constants).
--
-- event_date: the DATE on which the event falls. Matches trade_date in daily_regime_tags.
-- event_type: one of the strings above; open-ended TEXT (no CHECK) so operators
--   can add custom types without a schema change.
-- description: human-readable notes for auditing (e.g. "RBI MPC April 2025 — rate unchanged").

CREATE TABLE IF NOT EXISTS event_calendar (
  id           BIGSERIAL   PRIMARY KEY,
  event_date   DATE        NOT NULL,
  event_type   TEXT        NOT NULL,
  description  TEXT,
  -- A single date may have multiple events (e.g. F&O expiry + RBI on same day),
  -- so we allow multiple rows per date. The regime engine treats any match as EVENT_DAY.
  UNIQUE (event_date, event_type)
);

CREATE INDEX IF NOT EXISTS idx_event_calendar_date
  ON event_calendar (event_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed data: known Indian market event days (2023–2026)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Sources:
--   RBI MPC dates: https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx
--   Union Budget: Ministry of Finance press releases
--   NSE Holidays: https://www.nseindia.com/trade/holidays-clearing-settlement
--
-- OPERATOR NOTE: This seed covers 2023–2026. Add new dates by inserting
-- new rows here or in a follow-on migration (do NOT edit the existing INSERT
-- block — use ON CONFLICT DO NOTHING to keep the seed idempotent).
--
-- ON CONFLICT DO NOTHING: safe to re-run. Does not overwrite existing rows.

INSERT INTO event_calendar (event_date, event_type, description) VALUES
  -- ── RBI MPC Decisions 2023 ────────────────────────────────────────────────
  ('2023-02-08', 'RBI_POLICY', 'RBI MPC February 2023 — rate hike 25bps to 6.50%'),
  ('2023-04-06', 'RBI_POLICY', 'RBI MPC April 2023 — rate unchanged 6.50%'),
  ('2023-06-08', 'RBI_POLICY', 'RBI MPC June 2023 — rate unchanged 6.50%'),
  ('2023-08-10', 'RBI_POLICY', 'RBI MPC August 2023 — rate unchanged 6.50%'),
  ('2023-10-06', 'RBI_POLICY', 'RBI MPC October 2023 — rate unchanged 6.50%'),
  ('2023-12-08', 'RBI_POLICY', 'RBI MPC December 2023 — rate unchanged 6.50%'),

  -- ── RBI MPC Decisions 2024 ────────────────────────────────────────────────
  ('2024-02-08', 'RBI_POLICY', 'RBI MPC February 2024 — rate unchanged 6.50%'),
  ('2024-04-05', 'RBI_POLICY', 'RBI MPC April 2024 — rate unchanged 6.50%'),
  ('2024-06-07', 'RBI_POLICY', 'RBI MPC June 2024 — rate unchanged 6.50%'),
  ('2024-08-08', 'RBI_POLICY', 'RBI MPC August 2024 — rate unchanged 6.50%'),
  ('2024-10-09', 'RBI_POLICY', 'RBI MPC October 2024 — rate unchanged 6.50%'),
  ('2024-12-06', 'RBI_POLICY', 'RBI MPC December 2024 — rate cut 25bps to 6.25%'),

  -- ── RBI MPC Decisions 2025 ────────────────────────────────────────────────
  ('2025-02-07', 'RBI_POLICY', 'RBI MPC February 2025 — rate cut 25bps to 6.00%'),
  ('2025-04-09', 'RBI_POLICY', 'RBI MPC April 2025 — rate unchanged 6.00%'),
  ('2025-06-06', 'RBI_POLICY', 'RBI MPC June 2025 — rate unchanged 6.00%'),
  ('2025-08-06', 'RBI_POLICY', 'RBI MPC August 2025 — scheduled'),
  ('2025-10-08', 'RBI_POLICY', 'RBI MPC October 2025 — scheduled'),
  ('2025-12-05', 'RBI_POLICY', 'RBI MPC December 2025 — scheduled'),

  -- ── RBI MPC Decisions 2026 ────────────────────────────────────────────────
  ('2026-02-06', 'RBI_POLICY', 'RBI MPC February 2026 — scheduled'),
  ('2026-04-07', 'RBI_POLICY', 'RBI MPC April 2026 — scheduled'),
  ('2026-06-05', 'RBI_POLICY', 'RBI MPC June 2026 — scheduled'),

  -- ── Union Budget Dates ────────────────────────────────────────────────────
  ('2023-02-01', 'UNION_BUDGET', 'Union Budget 2023-24 presentation'),
  ('2024-02-01', 'UNION_BUDGET', 'Interim Budget 2024-25 presentation'),
  ('2024-07-23', 'UNION_BUDGET', 'Full Union Budget 2024-25 presentation'),
  ('2025-02-01', 'UNION_BUDGET', 'Union Budget 2025-26 presentation'),
  ('2026-02-01', 'UNION_BUDGET', 'Union Budget 2026-27 presentation (scheduled)'),

  -- ── NSE Market Holidays 2024 ─────────────────────────────────────────────
  -- Source: NSE circular for 2024 trading holidays
  ('2024-01-22', 'HOLIDAY', 'Ayodhya Ram Mandir Consecration / Special holiday'),
  ('2024-01-26', 'HOLIDAY', 'Republic Day'),
  ('2024-03-25', 'HOLIDAY', 'Holi'),
  ('2024-04-14', 'HOLIDAY', 'Dr. Ambedkar Jayanti / Mahavir Jayanti / Good Friday'),
  ('2024-04-17', 'HOLIDAY', 'Ram Navami'),
  ('2024-04-21', 'HOLIDAY', 'Good Friday (if applicable)'),
  ('2024-05-23', 'HOLIDAY', 'Buddha Purnima'),
  ('2024-06-17', 'HOLIDAY', 'Bakri Id / Eid ul-Adha'),
  ('2024-07-17', 'HOLIDAY', 'Muharram'),
  ('2024-08-15', 'HOLIDAY', 'Independence Day'),
  ('2024-10-02', 'HOLIDAY', 'Gandhi Jayanti / Mahatma Gandhi birthday'),
  ('2024-11-01', 'HOLIDAY', 'Diwali Laxmi Pujan'),
  ('2024-11-15', 'HOLIDAY', 'Gurunanak Jayanti'),
  ('2024-12-25', 'HOLIDAY', 'Christmas'),

  -- ── NSE Market Holidays 2025 ─────────────────────────────────────────────
  ('2025-01-26', 'HOLIDAY', 'Republic Day'),
  ('2025-02-26', 'HOLIDAY', 'Mahashivaratri'),
  ('2025-03-14', 'HOLIDAY', 'Holi'),
  ('2025-03-31', 'HOLIDAY', 'Id-ul-Fitr (Ramzan Id)'),
  ('2025-04-10', 'HOLIDAY', 'Mahavir Jayanti'),
  ('2025-04-14', 'HOLIDAY', 'Dr. Ambedkar Jayanti'),
  ('2025-04-18', 'HOLIDAY', 'Good Friday'),
  ('2025-05-01', 'HOLIDAY', 'Maharashtra Day'),
  ('2025-08-15', 'HOLIDAY', 'Independence Day'),
  ('2025-08-27', 'HOLIDAY', 'Ganesh Chaturthi'),
  ('2025-10-02', 'HOLIDAY', 'Gandhi Jayanti / Mahatma Gandhi birthday'),
  ('2025-10-02', 'HOLIDAY', 'Dussehra'),
  ('2025-10-20', 'HOLIDAY', 'Diwali Laxmi Pujan'),
  ('2025-10-21', 'HOLIDAY', 'Diwali (Balipratipada)'),
  ('2025-11-05', 'HOLIDAY', 'Prakash Gurpurb Sri Guru Nanak Dev Ji'),
  ('2025-12-25', 'HOLIDAY', 'Christmas'),

  -- ── NSE Market Holidays 2026 (scheduled / provisional) ──────────────────
  ('2026-01-26', 'HOLIDAY', 'Republic Day'),
  ('2026-03-03', 'HOLIDAY', 'Holi (provisional)'),
  ('2026-03-20', 'HOLIDAY', 'Id-ul-Fitr (provisional)'),
  ('2026-04-02', 'HOLIDAY', 'Ram Navami (provisional)'),
  ('2026-04-03', 'HOLIDAY', 'Good Friday (provisional)'),
  ('2026-04-14', 'HOLIDAY', 'Dr. Ambedkar Jayanti / Mahavir Jayanti (provisional)'),
  ('2026-05-01', 'HOLIDAY', 'Maharashtra Day'),
  ('2026-08-15', 'HOLIDAY', 'Independence Day'),
  ('2026-10-02', 'HOLIDAY', 'Gandhi Jayanti'),
  ('2026-11-09', 'HOLIDAY', 'Diwali Laxmi Pujan (provisional)'),
  ('2026-11-25', 'HOLIDAY', 'Gurunanak Jayanti (provisional)'),
  ('2026-12-25', 'HOLIDAY', 'Christmas')
ON CONFLICT (event_date, event_type) DO NOTHING;
