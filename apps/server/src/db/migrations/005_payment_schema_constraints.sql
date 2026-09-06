-- Migration: 005_payment_schema_constraints
-- Tightens the payment schema based on Phase 4 review findings:
--
--   1. `days_granted` made nullable — semantically meaningless for credits_pack rows.
--      A table-level CHECK enforces that monthly_pass rows supply it, credits_pack do not.
--   2. Cross-column CHECK on `access_grants`: monthly_pass → expires_at NOT NULL;
--      credits_pack → expires_at IS NULL.
--   3. Composite index on (grant_type, status, created_at DESC) for the order-lookup
--      query inside consumeCredit, which runs while holding an advisory lock.
--   4. `set_updated_at()` trigger function + trigger on `access_grants` so updated_at
--      is maintained automatically (not manually per UPDATE statement).
--   5. CHECK on `credit_transactions` that consumption rows (credits_delta < 0) must
--      supply `feature`, providing schema-level audit guarantees.
--
-- All ALTER TABLE ... ADD CONSTRAINT statements use IF NOT EXISTS where PostgreSQL 15+
-- supports it. For older-compatible syntax we use DO $$ ... $$ guards.

-- ---------------------------------------------------------------------------
-- 1. Make days_granted nullable
-- ---------------------------------------------------------------------------

ALTER TABLE access_grants ALTER COLUMN days_granted DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Cross-column CHECK constraints on access_grants
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chk_access_grants_days_granted_type'
      AND table_name = 'access_grants'
  ) THEN
    ALTER TABLE access_grants ADD CONSTRAINT chk_access_grants_days_granted_type
      CHECK (
        (grant_type = 'monthly_pass' AND days_granted IS NOT NULL AND days_granted > 0)
        OR
        (grant_type = 'credits_pack' AND days_granted IS NULL)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chk_access_grants_expires_at_type'
      AND table_name = 'access_grants'
  ) THEN
    ALTER TABLE access_grants ADD CONSTRAINT chk_access_grants_expires_at_type
      CHECK (
        (grant_type = 'monthly_pass' AND expires_at IS NOT NULL)
        OR
        (grant_type = 'credits_pack' AND expires_at IS NULL)
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Composite index for consumeCredit's order lookup
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_access_grants_credits_lookup
  ON access_grants (grant_type, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. updated_at auto-maintenance trigger on access_grants
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'trg_access_grants_updated_at'
      AND event_object_table = 'access_grants'
  ) THEN
    CREATE TRIGGER trg_access_grants_updated_at
      BEFORE UPDATE ON access_grants
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Audit CHECK on credit_transactions: consumption rows must name feature
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chk_credit_transactions_feature_required'
      AND table_name = 'credit_transactions'
  ) THEN
    ALTER TABLE credit_transactions ADD CONSTRAINT chk_credit_transactions_feature_required
      CHECK (credits_delta > 0 OR feature IS NOT NULL);
  END IF;
END $$;
