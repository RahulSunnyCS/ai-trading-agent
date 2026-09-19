-- Migration 003: Payment tables
-- Creates access_grants and processed_webhook_events tables for Razorpay integration.
--
-- access_grants: one row per Razorpay order that has been created. Records are
-- created at order-creation time (status='pending') and updated to 'paid'/'active'
-- when the webhook confirms successful payment. The razorpay_order_id is the
-- natural idempotency key — UNIQUE constraint prevents double-processing.
--
-- processed_webhook_events: idempotency log for Razorpay webhook deliveries.
-- Razorpay guarantees at-least-once delivery, so we record every event_id we
-- successfully process; re-delivery of the same event_id is silently ignored.
-- Using TEXT PRIMARY KEY (not UUID) because the event_id comes from Razorpay
-- and is already globally unique on their side.

-- ---------------------------------------------------------------------------
-- access_grants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS access_grants (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  razorpay_order_id   TEXT          NOT NULL UNIQUE,
  razorpay_payment_id TEXT,                              -- NULL until payment confirmed
  grant_type          TEXT          NOT NULL CHECK (grant_type IN ('monthly_pass','credits_pack')),
  days_granted        INTEGER       NOT NULL CHECK (days_granted > 0),
  expires_at          TIMESTAMPTZ,                       -- NULL for credits_pack grants
  status              TEXT          NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','paid','active','expired')),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Index on status for fast lookups of active/pending grants (the common query
-- pattern is "is there an active grant right now?")
CREATE INDEX IF NOT EXISTS idx_access_grants_status ON access_grants(status);

-- Partial index on expires_at — only rows where expires_at IS NOT NULL are
-- relevant for expiry checks; this keeps the index small and avoids scanning
-- credits_pack rows (which have NULL expires_at and never expire this way).
CREATE INDEX IF NOT EXISTS idx_access_grants_expires_at ON access_grants(expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- processed_webhook_events
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  razorpay_event_id   TEXT          PRIMARY KEY,
  processed_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
