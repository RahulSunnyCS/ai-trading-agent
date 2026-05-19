/**
 * Razorpay service module — Orders API, signature verification, credit consumption.
 *
 * Design decisions:
 *
 * 1. LAZY INIT — no Razorpay client is created at module load. `initRazorpay()` is
 *    the only entry point that touches the SDK. This means importing this module when
 *    `RAZORPAY_KEY_ID` is absent (e.g. local dev with `PAYMENT_ENABLED=false`) does
 *    not throw. The host route/handler calls `initRazorpay()` only after confirming
 *    payment mode is active.
 *
 * 2. BUFFER FOR WEBHOOK HMAC — `verifyWebhookSignature` accepts `Buffer` not `string`.
 *    Razorpay computes the webhook signature over the raw HTTP body bytes. If the
 *    caller parses the body with JSON.parse and then re-serialises with JSON.stringify,
 *    key ordering, whitespace, and Unicode escapes may differ from the original bytes,
 *    silently breaking the HMAC. By requiring `Buffer`, we force callers to pass the
 *    raw bytes from the framework's pre-parse hook, making the contract impossible to
 *    violate accidentally.
 *
 * 3. TRANSACTION FOR consumeCredit — a plain SELECT + INSERT is vulnerable to a
 *    time-of-check/time-of-use (TOCTOU) race: two concurrent requests can both read
 *    the same positive balance, both decide to consume, and both commit, leaving the
 *    balance negative. Wrapping in a transaction with `FOR UPDATE` on the balance
 *    query serialises concurrent consumers so only one can proceed when balance == 1.
 *
 * 4. NO SECRETS IN ERRORS — RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are
 *    never echoed in error messages or logs. Errors use descriptive messages only.
 *
 * 5. NAMED EXPORTS ONLY — project convention; no default export.
 */

import crypto from 'node:crypto';

import type { Pool } from 'pg';
import Razorpay from 'razorpay';

// ---------------------------------------------------------------------------
// Payment-enabled guard
// ---------------------------------------------------------------------------

/**
 * Derived at call time (not module load) from the presence of RAZORPAY_KEY_ID.
 * Absent key → payment subsystem is disabled and the app runs in free / dev mode.
 */
export function isPaymentEnabled(): boolean {
  // Dot notation required — Biome's `useLiteralKeys` rejects bracket notation
  // for string-literal keys.
  return Boolean(process.env.RAZORPAY_KEY_ID);
}

// ---------------------------------------------------------------------------
// Lazy Razorpay client (singleton — created once, reused across requests)
// ---------------------------------------------------------------------------

let _razorpayClient: Razorpay | null = null;

/**
 * Initialise (once) and return the Razorpay SDK singleton.
 *
 * Called lazily — cold import of this file never fails in dev mode where
 * RAZORPAY_KEY_ID is absent. The instance is cached after first construction
 * so SDK internals (connection keep-alives, etc.) are not recreated per request.
 */
export function initRazorpay(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId) {
    // Do not include the secret or its value in the error.
    throw new Error(
      'Payment mode is not enabled: RAZORPAY_KEY_ID is not set. ' +
        'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable Razorpay.',
    );
  }

  if (!keySecret) {
    throw new Error('Razorpay secret not configured: RAZORPAY_KEY_SECRET is missing.');
  }

  if (_razorpayClient === null) {
    _razorpayClient = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  return _razorpayClient;
}

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

export interface CreateOrderParams {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

export interface OrderResult {
  orderId: string;
  amount: number;
  currency: string;
}

/**
 * Create a Razorpay order. Uses the Razorpay SDK (already in package.json).
 *
 * `amountPaise` must already be in the smallest currency unit (paise for INR).
 * The SDK accepts the amount as a number.
 */
export async function createOrder(params: CreateOrderParams): Promise<OrderResult> {
  const client = initRazorpay();

  const order = await client.orders.create({
    amount: params.amountPaise,
    currency: params.currency,
    receipt: params.receipt,
    // notes is IMap<string | number> in the SDK — our Record<string, string> is
    // compatible because string extends string | number.
    ...(params.notes !== undefined ? { notes: params.notes } : {}),
  });

  return {
    orderId: order.id,
    // amount comes back as number | string from the SDK type — normalise to number.
    amount: typeof order.amount === 'string' ? Number.parseInt(order.amount, 10) : order.amount,
    currency: order.currency,
  };
}

// ---------------------------------------------------------------------------
// Signature verification — payment
// ---------------------------------------------------------------------------

/**
 * Verify the payment signature returned by Razorpay after a successful checkout.
 *
 * Razorpay signs the payload as: HMAC-SHA256("${orderId}|${paymentId}", KEY_SECRET)
 *
 * Returns `false` (never throws) on bad input or missing secret so that callers
 * can safely treat the return value as a pass/fail boolean.
 */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    // Secret not configured — treat as verification failure, not a hard error.
    // Never log the secret value itself.
    return false;
  }

  try {
    const payload = `${orderId}|${paymentId}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    // Use timingSafeEqual to prevent timing-based secret recovery attacks.
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    // Any unexpected error (e.g. malformed signature string) → fail safe.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signature verification — webhook
// ---------------------------------------------------------------------------

/**
 * Verify a Razorpay webhook delivery against the `X-Razorpay-Signature` header.
 *
 * CRITICAL: `rawBody` MUST be a `Buffer` containing the unmodified bytes from the
 * HTTP request. Do NOT pass a re-serialised string: JSON.stringify(JSON.parse(body))
 * can alter key order, whitespace, or Unicode escapes, silently invalidating the HMAC.
 *
 * The calling Fastify route must use `addContentTypeParser` with `parseAs: 'buffer'`
 * (or equivalent) so the framework hands us the pre-parse raw bytes.
 *
 * Returns `false` (never throws) on bad input or missing secret.
 */
export function verifyWebhookSignature(rawBody: Buffer, headerSignature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    // Never log the secret value.
    return false;
  }

  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody) // Buffer.update() hashes the raw bytes directly — no encoding step
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerSignature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Credit balance
// ---------------------------------------------------------------------------

/**
 * Return the current total credit balance via the `credit_balance` view.
 * Using the view as the single source of truth means the aggregate logic
 * lives in one place — if the view is updated (e.g. to a materialized view),
 * this function picks up the change automatically.
 */
export async function getCreditBalance(db: Pool): Promise<number> {
  const result = await db.query<{ balance: string }>('SELECT balance FROM credit_balance');

  // pg returns NUMERIC as a string — parse explicitly.
  const row = result.rows[0];
  return row !== undefined ? Number.parseFloat(row.balance) : 0;
}

// ---------------------------------------------------------------------------
// Credit consumption
// ---------------------------------------------------------------------------

/**
 * Atomically consume `amount` credits (default 1) for the given `feature`.
 *
 * Atomicity design:
 * - All reads and writes happen inside a single PostgreSQL transaction.
 * - `pg_advisory_xact_lock(key)` serialises concurrent consumers for the lifetime
 *   of the transaction — the second concurrent request blocks at the lock acquisition
 *   step until the first commits and releases it automatically. This avoids the
 *   TOCTOU race without requiring `FOR UPDATE` on aggregate queries (which PostgreSQL
 *   rejects: "FOR UPDATE is not allowed with aggregate functions").
 * - Advisory lock key 7241964 is an arbitrary stable constant — unique to this
 *   operation within this application. Any non-zero integer works; the constant
 *   just avoids magic-number confusion.
 * - If the balance is insufficient, the transaction is rolled back and the caller
 *   receives `success: false` with the current balance.
 *
 * The INSERT row must reference a valid `razorpay_order_id` (FK to access_grants).
 * We select the most recently paid credits_pack order because that is the grant that
 * funded the credits being consumed — this preserves the audit trail's credit lifecycle.
 */
export async function consumeCredit(
  db: Pool,
  feature: string,
  amount = 1,
): Promise<{ success: boolean; remainingBalance: number }> {
  // Validate amount before touching the DB — catches NaN, negatives, and non-integers.
  // A negative amount would mint credits; NaN bypasses the balance check entirely.
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    throw new Error(`consumeCredit: amount must be a positive integer, got ${amount}`);
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Acquire an application-level advisory lock that is automatically released
    // when this transaction ends. Serialises all concurrent consumeCredit calls
    // so only one reads + inserts at a time, preventing the TOCTOU race.
    await client.query('SELECT pg_advisory_xact_lock(7241964)');

    // Read the current balance within the locked transaction.
    const balanceResult = await client.query<{ balance: string }>(
      'SELECT COALESCE(SUM(credits_delta), 0) AS balance FROM credit_transactions',
    );

    const balanceRow = balanceResult.rows[0];
    const currentBalance = balanceRow !== undefined ? Number.parseFloat(balanceRow.balance) : 0;

    if (currentBalance < amount) {
      await client.query('ROLLBACK');
      return { success: false, remainingBalance: currentBalance };
    }

    // Find the most recently paid credits_pack order to reference in the FK.
    // We use the same order that seeded the credits being consumed so the ledger
    // clearly shows which purchase funded which feature call.
    const orderResult = await client.query<{ razorpay_order_id: string }>(
      `SELECT razorpay_order_id
       FROM access_grants
       WHERE grant_type = 'credits_pack'
         AND status IN ('paid', 'active')
       ORDER BY created_at DESC
       LIMIT 1`,
    );

    const orderRow = orderResult.rows[0];
    if (orderRow === undefined) {
      // No paid credits_pack order exists — cannot consume.
      await client.query('ROLLBACK');
      return { success: false, remainingBalance: currentBalance };
    }

    // Insert the consumption record (negative delta).
    await client.query(
      `INSERT INTO credit_transactions (razorpay_order_id, credits_delta, feature)
       VALUES ($1, $2, $3)`,
      [orderRow.razorpay_order_id, -amount, feature],
    );

    await client.query('COMMIT');

    return { success: true, remainingBalance: currentBalance - amount };
  } catch (err) {
    // Roll back on any unexpected error to prevent partial writes.
    await client.query('ROLLBACK');
    throw err;
  } finally {
    // Always release the pooled connection even if commit/rollback throws.
    client.release();
  }
}
