/**
 * Access Gate Middleware — Fastify preHandler hooks for payment/access checks.
 *
 * Design decisions:
 *
 * 1. SILENT PASS WHEN PAYMENT DISABLED — when RAZORPAY_KEY_ID is absent,
 *    isPaymentEnabled() returns false and every route is allowed through
 *    unconditionally. This is the project spec's "silent fail in dev/free mode"
 *    rule — never block access in a non-payment environment.
 *
 * 2. NEVER THROWS — checkAccess catches all DB errors and returns
 *    { granted: false, reason: 'no_grant' } rather than propagating. This means
 *    a transient DB outage degrades to a 403 for the caller rather than an
 *    uncaught 500, which would expose internal error detail.
 *
 * 3. RAW SQL ONLY — no ORM, consistent with the rest of the codebase
 *    (src/db/client.ts pattern). Query results are typed against AccessGrant and
 *    narrowed before use.
 *
 * 4. noUncheckedIndexedAccess GUARD — result.rows[0] is always checked against
 *    undefined before property access. The tsconfig has noUncheckedIndexedAccess
 *    enabled, so the type of rows[0] is `T | undefined`.
 *
 * 5. exactOptionalPropertyTypes — AccessStatus uses optional properties
 *    (expiresAt?, creditBalance?). We only set them when we have a real value,
 *    never set them to undefined explicitly (exactOptionalPropertyTypes rejects
 *    `{ expiresAt: undefined }`).
 *
 * 6. NO DEFAULT EXPORT — project convention.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { isPaymentEnabled } from '../../payment/razorpay';

// ---------------------------------------------------------------------------
// AccessStatus type
// ---------------------------------------------------------------------------

export interface AccessStatus {
  granted: boolean;
  reason: 'payment_disabled' | 'active_monthly_pass' | 'has_credits' | 'no_grant';
  // Only present when a monthly_pass grant was found — exactOptionalPropertyTypes
  // means we must never set this to `undefined`, only omit it.
  expiresAt?: Date;
  // Only present when access is granted via a credit balance check.
  creditBalance?: number;
}

// ---------------------------------------------------------------------------
// Row types for raw SQL results
// ---------------------------------------------------------------------------

/** Shape of a row returned by the monthly_pass query. */
interface AccessGrantRow {
  expires_at: Date | null;
}

/** Shape of a row returned by the credit balance query. */
interface CreditBalanceRow {
  balance: string; // pg returns NUMERIC/SUM as string — parse explicitly
}

// ---------------------------------------------------------------------------
// Core access check
// ---------------------------------------------------------------------------

/**
 * Check the current access status against the database.
 *
 * Never throws — returns `{ granted: false, reason: 'no_grant' }` on any error.
 *
 * Order of precedence:
 *  1. Payment disabled → granted (payment_disabled)
 *  2. Active monthly_pass grant → granted (active_monthly_pass)
 *  3. Positive credit balance → granted (has_credits)
 *  4. Otherwise → denied (no_grant)
 */
export async function checkAccess(db: Pool): Promise<AccessStatus> {
  // Fast path: payment subsystem not active → allow everything through.
  if (!isPaymentEnabled()) {
    return { granted: true, reason: 'payment_disabled' };
  }

  try {
    // --- Step 1: check for an active monthly_pass grant ---
    //
    // We use expires_at IS NULL as a sentinel for "never expires" grants, so the
    // WHERE clause allows both NULL (unlimited) and future timestamps.
    const grantResult = await db.query<AccessGrantRow>(
      `SELECT expires_at
       FROM access_grants
       WHERE grant_type = 'monthly_pass'
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC
       LIMIT 1`,
    );

    const grantRow = grantResult.rows[0];
    if (grantRow !== undefined) {
      // Monthly pass found — build status. Only include expiresAt when the
      // column is non-null (exactOptionalPropertyTypes disallows setting to
      // undefined explicitly).
      const status: AccessStatus = { granted: true, reason: 'active_monthly_pass' };
      if (grantRow.expires_at !== null) {
        status.expiresAt = grantRow.expires_at;
      }
      return status;
    }

    // --- Step 2: check credit balance ---
    //
    // COALESCE ensures we get 0 rather than NULL when the table is empty.
    const balanceResult = await db.query<CreditBalanceRow>(
      `SELECT COALESCE(SUM(credits_delta), 0) AS balance
       FROM credit_transactions`,
    );

    const balanceRow = balanceResult.rows[0];
    // pg COALESCE(SUM(...), 0) always produces a row even on an empty table,
    // but we guard for undefined to satisfy noUncheckedIndexedAccess.
    const balance = balanceRow !== undefined ? Number.parseFloat(balanceRow.balance) : 0;

    if (balance > 0) {
      return { granted: true, reason: 'has_credits', creditBalance: balance };
    }

    // --- Step 3: no valid grant ---
    return { granted: false, reason: 'no_grant' };
  } catch {
    // Swallow DB errors — degrade gracefully to denied rather than 500.
    // We intentionally do not log the error here; the caller's framework will
    // emit its own request-level log with the 403 status code.
    return { granted: false, reason: 'no_grant' };
  }
}

// ---------------------------------------------------------------------------
// Fastify preHandler hooks
// ---------------------------------------------------------------------------

/**
 * requireAccess — preHandler hook that gates any protected route behind a
 * payment/access check.
 *
 * Usage:
 *   server.get('/api/protected', { preHandler: requireAccess }, handler);
 *
 * Allow-through conditions (in order):
 *  - Payment is disabled (dev/free mode)
 *  - An active monthly_pass grant exists
 *  - A positive credit balance exists
 *
 * Deny: HTTP 403 { error: 'access_denied', reason: <string> }
 */
export async function requireAccess(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Silent pass when payment subsystem is disabled.
  if (!isPaymentEnabled()) {
    return;
  }

  const status = await checkAccess(request.server.db);

  if (status.granted) {
    return;
  }

  // Cast reason to string for the JSON response — it is a string union, so no
  // information is lost, but the reply type is not constrained to our union.
  await reply.status(403).send({ error: 'access_denied', reason: status.reason });
}

/**
 * requireCredits — preHandler hook for credit-consuming routes.
 *
 * For MVP, this is identical to requireAccess because monthly_pass holders
 * have unlimited feature-token access during their validity window. The
 * distinction becomes meaningful in a future version when credit-only users
 * exist — at that point this hook can add a credit-deduction step.
 *
 * Allow-through conditions (same as requireAccess):
 *  - Payment disabled
 *  - active_monthly_pass (pass includes unlimited credits)
 *  - has_credits (positive balance)
 */
export async function requireCredits(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Delegate entirely to requireAccess — both hooks have identical semantics
  // at MVP. The separation exists so callers declare intent clearly and so
  // requireCredits can diverge (e.g. deduct a credit) without touching
  // requireAccess.
  await requireAccess(request, reply);
}
