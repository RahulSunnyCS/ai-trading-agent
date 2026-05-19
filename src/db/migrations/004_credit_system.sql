-- Migration 004: Credit system
-- Creates credit_transactions table and credit_balance view.
--
-- credit_transactions: an append-only ledger of credit movements. Positive
-- credits_delta values represent purchased credits; negative values represent
-- credits consumed by feature calls (e.g. a backtest run). The design is
-- intentionally append-only — no UPDATE or DELETE — so the audit trail is
-- always intact and the current balance is always derivable from the full
-- history.
--
-- The foreign key to access_grants(razorpay_order_id) ties every credit
-- purchase back to a verified payment. Consumed credits reference the same
-- order that originally funded them, providing a complete credit lifecycle.
--
-- credit_balance view: a simple SUM over all credits_delta. For a single-
-- instance product the table will stay small, so a full-table aggregate is
-- acceptable. If the table grows large, this can be replaced with a
-- materialized view or a running-total trigger without changing the interface.

-- ---------------------------------------------------------------------------
-- credit_transactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credit_transactions (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  razorpay_order_id   TEXT          NOT NULL REFERENCES access_grants(razorpay_order_id),
  credits_delta       INTEGER       NOT NULL,  -- positive = purchased, negative = consumed
  feature             TEXT,                    -- which feature consumed the credit (NULL for purchases)
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Index on razorpay_order_id to efficiently look up all credit movements for a
-- given order (e.g. "how many credits remain from order X?")
CREATE INDEX IF NOT EXISTS idx_credit_transactions_order ON credit_transactions(razorpay_order_id);

-- ---------------------------------------------------------------------------
-- credit_balance view
-- ---------------------------------------------------------------------------

-- CREATE OR REPLACE VIEW is inherently idempotent — safe to re-run.
-- COALESCE ensures the view returns 0 (not NULL) when the table is empty.
CREATE OR REPLACE VIEW credit_balance AS
SELECT COALESCE(SUM(credits_delta), 0) AS balance
FROM credit_transactions;
