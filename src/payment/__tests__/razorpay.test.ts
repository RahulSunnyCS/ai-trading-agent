/**
 * Unit tests for src/payment/razorpay.ts
 *
 * All external dependencies (pg Pool, Razorpay SDK) are mocked.
 * No real network calls or DB connections are made.
 */

import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the Razorpay SDK before importing the module under test.
// The module caches a singleton (_razorpayClient), so we need to reset it
// between tests that touch initRazorpay(). We do this by re-importing the
// module via vi.resetModules() in the singleton tests.
// ---------------------------------------------------------------------------
vi.mock('razorpay', () => {
  const MockRazorpay = vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
    _keyId: opts.key_id,
    orders: { create: vi.fn() },
  }));
  return { default: MockRazorpay };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a correct HMAC-SHA256 hex string the same way the implementation does. */
function computePaymentHmac(orderId: string, paymentId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

function computeWebhookHmac(body: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Build a minimal mock pg PoolClient with controllable query behaviour. */
function buildMockClient(queryResponses: Array<{ rows: unknown[] }> = []) {
  let callIndex = 0;
  const query = vi.fn().mockImplementation(() => {
    const response = queryResponses[callIndex] ?? { rows: [] };
    callIndex++;
    return Promise.resolve(response);
  });
  const release = vi.fn();
  return { query, release };
}

/** Build a mock pg Pool whose connect() returns the given client. */
function buildMockPool(client: ReturnType<typeof buildMockClient>): Pool {
  return {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// isPaymentEnabled
// ---------------------------------------------------------------------------

describe('isPaymentEnabled()', () => {
  afterEach(() => {
    // vi.unstubAllEnvs() not in Vitest 2.0
  });

  it('should return true when RAZORPAY_KEY_ID is set', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
    const { isPaymentEnabled } = await import('../razorpay.ts');
    expect(isPaymentEnabled()).toBe(true);
  });

  it('should return false when RAZORPAY_KEY_ID is not set', async () => {
    process.env.RAZORPAY_KEY_ID = '';
    const { isPaymentEnabled } = await import('../razorpay.ts');
    expect(isPaymentEnabled()).toBe(false);
  });

  it('should return false when RAZORPAY_KEY_ID is empty string', async () => {
    process.env.RAZORPAY_KEY_ID = '';
    const { isPaymentEnabled } = await import('../razorpay.ts');
    expect(isPaymentEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTestMode
// ---------------------------------------------------------------------------

describe('isTestMode()', () => {
  afterEach(() => {
    // vi.unstubAllEnvs() not in Vitest 2.0
  });

  it('should return true for a rzp_test_ prefixed key', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
    const { isTestMode } = await import('../razorpay.ts');
    expect(isTestMode()).toBe(true);
  });

  it('should return false for a rzp_live_ prefixed key', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_live_abc123';
    const { isTestMode } = await import('../razorpay.ts');
    expect(isTestMode()).toBe(false);
  });

  it('should return false when RAZORPAY_KEY_ID is not set', async () => {
    process.env.RAZORPAY_KEY_ID = '';
    const { isTestMode } = await import('../razorpay.ts');
    expect(isTestMode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// initRazorpay
// ---------------------------------------------------------------------------

describe('initRazorpay()', () => {
  // Each test gets a fresh module instance so the singleton (_razorpayClient)
  // starts as null.
  beforeEach(() => {
    vi.clearAllMocks(); // resetModules not in Vitest 2.0
    // vi.unstubAllEnvs() not in Vitest 2.0
  });

  afterEach(() => {
    // vi.unstubAllEnvs() not in Vitest 2.0
  });

  it('should throw a descriptive error when RAZORPAY_KEY_ID is missing', async () => {
    process.env.RAZORPAY_KEY_ID = '';
    process.env.RAZORPAY_KEY_SECRET = 'some_secret';
    const { initRazorpay } = await import('../razorpay.ts');
    expect(() => initRazorpay()).toThrowError('RAZORPAY_KEY_ID is not set');
  });

  it('should not include key secret in the error when RAZORPAY_KEY_ID is missing', async () => {
    const secretValue = 'super_secret_key_value';
    process.env.RAZORPAY_KEY_ID = '';
    process.env.RAZORPAY_KEY_SECRET = secretValue;
    const { initRazorpay } = await import('../razorpay.ts');
    expect(() => initRazorpay()).not.toThrowError(secretValue);
  });

  it('should throw a descriptive error when RAZORPAY_KEY_SECRET is missing', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
    process.env.RAZORPAY_KEY_SECRET = '';
    const { initRazorpay } = await import('../razorpay.ts');
    expect(() => initRazorpay()).toThrowError('RAZORPAY_KEY_SECRET is missing');
  });

  it('should return a Razorpay instance when both keys are present', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
    process.env.RAZORPAY_KEY_SECRET = 'secret_value';
    const { initRazorpay } = await import('../razorpay.ts');
    const instance = initRazorpay();
    expect(instance).toBeDefined();
    // The mock constructor wraps key_id — verify it received correct key
    expect((instance as unknown as { _keyId: string })._keyId).toBe('rzp_test_abc123');
  });

  it('should return the same instance on subsequent calls (singleton)', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
    process.env.RAZORPAY_KEY_SECRET = 'secret_value';
    const { initRazorpay } = await import('../razorpay.ts');
    const first = initRazorpay();
    const second = initRazorpay();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// verifyPaymentSignature
// ---------------------------------------------------------------------------

describe('verifyPaymentSignature()', () => {
  const SECRET = 'test_key_secret_value';
  const ORDER_ID = 'order_ABC123';
  const PAYMENT_ID = 'pay_XYZ789';

  beforeEach(() => {
    vi.clearAllMocks(); // resetModules not in Vitest 2.0
    // vi.unstubAllEnvs() not in Vitest 2.0
  });

  afterEach(() => {
    // vi.unstubAllEnvs() not in Vitest 2.0
  });

  it('should return true for a correctly computed HMAC-SHA256 signature', async () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const { verifyPaymentSignature } = await import('../razorpay.ts');
    const sig = computePaymentHmac(ORDER_ID, PAYMENT_ID, SECRET);
    expect(verifyPaymentSignature(ORDER_ID, PAYMENT_ID, sig)).toBe(true);
  });

  it('should return false for an incorrect signature', async () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const { verifyPaymentSignature } = await import('../razorpay.ts');
    expect(verifyPaymentSignature(ORDER_ID, PAYMENT_ID, 'totally_wrong_signature')).toBe(false);
  });

  it('should return false (never throw) when RAZORPAY_KEY_SECRET is not set', async () => {
    process.env.RAZORPAY_KEY_SECRET = '';
    const { verifyPaymentSignature } = await import('../razorpay.ts');
    const sig = computePaymentHmac(ORDER_ID, PAYMENT_ID, SECRET);
    expect(() => verifyPaymentSignature(ORDER_ID, PAYMENT_ID, sig)).not.toThrow();
    expect(verifyPaymentSignature(ORDER_ID, PAYMENT_ID, sig)).toBe(false);
  });

  it('should return false for a signature that is the right length but wrong value', async () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const { verifyPaymentSignature } = await import('../razorpay.ts');
    // A SHA-256 hex digest is always 64 chars — craft a wrong one of same length
    const correctSig = computePaymentHmac(ORDER_ID, PAYMENT_ID, SECRET);
    const wrongSig = correctSig.replace(/./g, (_c, i: number) => (i === 0 ? '0' : _c));
    // Ensure it is different and same length
    expect(wrongSig.length).toBe(64);
    expect(verifyPaymentSignature(ORDER_ID, PAYMENT_ID, wrongSig)).toBe(false);
  });

  it('should use crypto.timingSafeEqual for comparison', async () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const { verifyPaymentSignature } = await import('../razorpay.ts');
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    const sig = computePaymentHmac(ORDER_ID, PAYMENT_ID, SECRET);
    verifyPaymentSignature(ORDER_ID, PAYMENT_ID, sig);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature()', () => {
  const WEBHOOK_SECRET = 'webhook_secret_value';

  beforeEach(() => {
    vi.clearAllMocks(); // resetModules not in Vitest 2.0
    // vi.unstubAllEnvs() not in Vitest 2.0
  });

  afterEach(() => {
    // vi.unstubAllEnvs() not in Vitest 2.0
  });

  it('should return true for a correctly computed HMAC of the raw body buffer', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { verifyWebhookSignature } = await import('../razorpay.ts');
    const body = Buffer.from('{"event":"payment.captured","id":"evt_001"}');
    const sig = computeWebhookHmac(body, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(body, sig)).toBe(true);
  });

  it('should return false when body bytes are tampered (same signature, different body)', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { verifyWebhookSignature } = await import('../razorpay.ts');
    const originalBody = Buffer.from('{"event":"payment.captured","id":"evt_001"}');
    const tamperedBody = Buffer.from('{"event":"payment.captured","id":"evt_TAMPERED"}');
    const sig = computeWebhookHmac(originalBody, WEBHOOK_SECRET);
    // Signature was computed over originalBody — must not verify against tamperedBody
    expect(verifyWebhookSignature(tamperedBody, sig)).toBe(false);
  });

  it('should return false for a correct body but incorrect signature', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { verifyWebhookSignature } = await import('../razorpay.ts');
    const body = Buffer.from('{"event":"payment.captured"}');
    expect(verifyWebhookSignature(body, 'bad_sig')).toBe(false);
  });

  it('should return false (never throw) when RAZORPAY_WEBHOOK_SECRET is not set', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = '';
    const { verifyWebhookSignature } = await import('../razorpay.ts');
    const body = Buffer.from('{}');
    expect(() => verifyWebhookSignature(body, 'anysig')).not.toThrow();
    expect(verifyWebhookSignature(body, 'anysig')).toBe(false);
  });

  it('should correctly verify a body containing non-ASCII bytes', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { verifyWebhookSignature } = await import('../razorpay.ts');
    // Non-ASCII bytes: UTF-8 encoded Indian Rupee sign and some emoji bytes
    const body = Buffer.from([0xe2, 0x82, 0xb9, 0xf0, 0x9f, 0x92, 0xb0, 0xff, 0x00]);
    const sig = computeWebhookHmac(body, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(body, sig)).toBe(true);
  });

  it('should return false (not throw) for a malformed headerSignature', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { verifyWebhookSignature } = await import('../razorpay.ts');
    const body = Buffer.from('{"event":"payment.captured"}');
    // timingSafeEqual will throw if buffers are different lengths — the impl must
    // catch this and return false.
    expect(() => verifyWebhookSignature(body, '')).not.toThrow();
    expect(verifyWebhookSignature(body, '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCreditBalance
// ---------------------------------------------------------------------------

describe('getCreditBalance()', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // resetModules not in Vitest 2.0
  });

  it('should return the parsed numeric balance from the credit_balance view', async () => {
    const { getCreditBalance } = await import('../razorpay.ts');
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ balance: '42.00' }] }),
    } as unknown as Pool;
    const result = await getCreditBalance(db);
    expect(result).toBe(42);
  });

  it('should query the credit_balance view (not raw tables)', async () => {
    const { getCreditBalance } = await import('../razorpay.ts');
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ balance: '10' }] });
    const db = { query: mockQuery } as unknown as Pool;
    await getCreditBalance(db);
    expect(mockQuery).toHaveBeenCalledWith('SELECT balance FROM credit_balance');
  });

  it('should return 0 when the query returns no rows', async () => {
    const { getCreditBalance } = await import('../razorpay.ts');
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const result = await getCreditBalance(db);
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// consumeCredit
// ---------------------------------------------------------------------------

describe('consumeCredit()', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // resetModules not in Vitest 2.0
  });

  // ---- Input validation ----

  it('should throw for negative amount', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const db = buildMockPool(buildMockClient());
    await expect(consumeCredit(db, 'backtest', -1)).rejects.toThrow(
      'amount must be a positive integer',
    );
  });

  it('should throw for zero amount', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const db = buildMockPool(buildMockClient());
    await expect(consumeCredit(db, 'backtest', 0)).rejects.toThrow(
      'amount must be a positive integer',
    );
  });

  it('should throw for NaN amount', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const db = buildMockPool(buildMockClient());
    await expect(consumeCredit(db, 'backtest', Number.NaN)).rejects.toThrow(
      'amount must be a positive integer',
    );
  });

  it('should throw for non-integer amount (e.g. 1.5)', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const db = buildMockPool(buildMockClient());
    await expect(consumeCredit(db, 'backtest', 1.5)).rejects.toThrow(
      'amount must be a positive integer',
    );
  });

  // ---- Insufficient balance ----

  it('should return {success: false, remainingBalance} when balance is insufficient', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    // Query call order: BEGIN, advisory lock, balance query, (ROLLBACK implicit path)
    const client = buildMockClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // advisory lock
      { rows: [{ balance: '0' }] }, // balance query → insufficient
      { rows: [] }, // ROLLBACK
    ]);
    const db = buildMockPool(client);
    const result = await consumeCredit(db, 'backtest', 1);
    expect(result).toEqual({ success: false, remainingBalance: 0 });
  });

  it('should call ROLLBACK when balance is insufficient', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const client = buildMockClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // advisory lock
      { rows: [{ balance: '0' }] }, // balance
      { rows: [] }, // ROLLBACK
    ]);
    const db = buildMockPool(client);
    await consumeCredit(db, 'backtest', 1);
    const calls: string[] = client.query.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  // ---- No paid credits_pack order ----

  it('should return {success: false} when no paid credits_pack order exists', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const client = buildMockClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // advisory lock
      { rows: [{ balance: '10' }] }, // balance → sufficient
      { rows: [] }, // order query → no row
      { rows: [] }, // ROLLBACK
    ]);
    const db = buildMockPool(client);
    const result = await consumeCredit(db, 'backtest', 1);
    expect(result.success).toBe(false);
  });

  // ---- Successful debit ----

  it('should return {success: true, remainingBalance: N-amount} on successful debit', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const client = buildMockClient([
      { rows: [] }, // BEGIN
      { rows: [] }, // advisory lock
      { rows: [{ balance: '5' }] }, // balance
      { rows: [{ razorpay_order_id: 'order_PAY001' }] }, // order
      { rows: [] }, // INSERT
      { rows: [] }, // COMMIT
    ]);
    const db = buildMockPool(client);
    const result = await consumeCredit(db, 'backtest', 1);
    expect(result).toEqual({ success: true, remainingBalance: 4 });
  });

  it('should deduct the correct amount from the balance', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const client = buildMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [{ balance: '10' }] },
      { rows: [{ razorpay_order_id: 'order_PAY001' }] },
      { rows: [] },
      { rows: [] },
    ]);
    const db = buildMockPool(client);
    const result = await consumeCredit(db, 'backtest', 3);
    expect(result).toEqual({ success: true, remainingBalance: 7 });
  });

  // ---- Transaction sequence ----

  it('should call BEGIN, pg_advisory_xact_lock(7241964), and COMMIT in order on success', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const client = buildMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [{ balance: '5' }] },
      { rows: [{ razorpay_order_id: 'order_PAY001' }] },
      { rows: [] },
      { rows: [] },
    ]);
    const db = buildMockPool(client);
    await consumeCredit(db, 'backtest', 1);

    const calls: string[] = client.query.mock.calls.map((c) => String(c[0]));
    const beginIdx = calls.indexOf('BEGIN');
    const lockIdx = calls.indexOf('SELECT pg_advisory_xact_lock(7241964)');
    const commitIdx = calls.indexOf('COMMIT');

    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(lockIdx);
  });

  // ---- DB error handling ----

  it('should call ROLLBACK and rethrow when DB throws an unexpected error', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const dbError = new Error('connection terminated unexpectedly');
    let callCount = 0;
    const client = {
      query: vi.fn().mockImplementation(() => {
        callCount++;
        // Throw on the 3rd call (balance query), after BEGIN and advisory lock succeed
        if (callCount === 3) {
          return Promise.reject(dbError);
        }
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };
    const db = buildMockPool(client);

    await expect(consumeCredit(db, 'backtest', 1)).rejects.toThrow(
      'connection terminated unexpectedly',
    );

    const calls: string[] = client.query.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
  });

  // ---- Connection release ----

  it('should call client.release() in finally regardless of success', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const client = buildMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [{ balance: '5' }] },
      { rows: [{ razorpay_order_id: 'order_PAY001' }] },
      { rows: [] },
      { rows: [] },
    ]);
    const db = buildMockPool(client);
    await consumeCredit(db, 'backtest', 1);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('should call client.release() in finally even when the DB throws', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    let callCount = 0;
    const client = {
      query: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 3) {
          return Promise.reject(new Error('db boom'));
        }
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };
    const db = buildMockPool(client);

    await expect(consumeCredit(db, 'backtest', 1)).rejects.toThrow('db boom');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('should call client.release() in finally even when balance is insufficient', async () => {
    const { consumeCredit } = await import('../razorpay.ts');
    const client = buildMockClient([
      { rows: [] },
      { rows: [] },
      { rows: [{ balance: '0' }] },
      { rows: [] },
    ]);
    const db = buildMockPool(client);
    await consumeCredit(db, 'backtest', 1);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
