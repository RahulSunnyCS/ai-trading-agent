/**
 * Unit tests for src/server/routes/payment.ts
 *
 * Uses Fastify's built-in server.inject() — no real HTTP socket is opened.
 *
 * All external dependencies are mocked:
 *  - src/payment/razorpay — createOrder, getCreditBalance, isPaymentEnabled,
 *    isTestMode, verifyPaymentSignature, verifyWebhookSignature
 *  - src/payment/geolocation — getClientCountry, extractClientIp
 *  - pg — Pool replaced with a lightweight stub so no DB connection is needed
 *
 * Tests:
 *  1. GET /api/payment/status returns 200 with `enabled` boolean
 *  2. GET /api/payment/plans returns plans array when payment enabled
 *  3. GET /api/payment/plans returns empty array when payment disabled
 *  4. POST /api/payment/create-order with invalid plan returns 400
 *  5. POST /api/payment/create-order when payment disabled returns 503
 *  6. POST /api/payment/verify with bad signature returns 400
 *  7. GET /api/payment/balance returns { balance: 0 } when payment disabled
 *  8. POST /api/payment/webhook with invalid signature returns 401
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test.
// vi.mock() is hoisted to the top of the file by Vitest's transformer, so
// these declarations take effect before any import runs.
// ---------------------------------------------------------------------------

vi.mock('../../payment/razorpay', () => ({
  isPaymentEnabled: vi.fn(),
  isTestMode: vi.fn(),
  createOrder: vi.fn(),
  verifyPaymentSignature: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  getCreditBalance: vi.fn(),
}));

vi.mock('../../payment/geolocation', () => ({
  extractClientIp: vi.fn(),
  getClientCountry: vi.fn(),
}));

// Mock pg.Pool — paymentRoutes accesses fastify.db which is set by the server
// factory; we replace it manually after building the server below.
vi.mock('pg', () => {
  const MockPool = vi.fn(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  }));
  return { Pool: MockPool };
});

// ---------------------------------------------------------------------------
// Imports of mocked modules (after vi.mock declarations)
// ---------------------------------------------------------------------------

import {
  createOrder,
  getCreditBalance,
  isPaymentEnabled,
  isTestMode,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../../payment/razorpay';

import { extractClientIp, getClientCountry } from '../../payment/geolocation';

// Module under test — imported after mocks are in place.
import { paymentRoutes } from '../routes/payment';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal pg.Pool mock — only the methods the routes call. */
function makeMockPool(queryImpl?: ReturnType<typeof vi.fn>): Pool {
  return {
    query: queryImpl ?? vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

/**
 * Build a minimal Fastify server with only the paymentRoutes plugin registered.
 * The pg Pool is replaced with a mock after construction.
 *
 * We do NOT call buildServer() from server/index.ts here because that function
 * registers WebSocket and CORS plugins that require extra setup in tests.
 * Instead we build the smallest possible Fastify instance that satisfies the
 * plugin's dependencies.
 */
async function buildTestServer(pool?: Pool): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  // Decorate with db so paymentRoutes can access fastify.db.
  // This mirrors what buildServer() does in server/index.ts.
  server.decorate('db', pool ?? makeMockPool());

  await server.register(paymentRoutes);

  return server;
}

// ---------------------------------------------------------------------------
// Per-test lifecycle
// ---------------------------------------------------------------------------

let server: FastifyInstance;

beforeEach(async () => {
  // Reset all mocks before each test so mock state does not bleed between tests.
  vi.clearAllMocks();

  // Default: payment enabled, testMode false, geolocation returns unknown.
  (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (isTestMode as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (extractClientIp as ReturnType<typeof vi.fn>).mockReturnValue('1.2.3.4');
  (getClientCountry as ReturnType<typeof vi.fn>).mockResolvedValue({
    country: 'India',
    isIndia: true,
    confidence: 'high',
  });

  server = await buildTestServer();
});

afterEach(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// 1. GET /api/payment/status — returns 200 with `enabled` boolean
// ---------------------------------------------------------------------------

describe('GET /api/payment/status', () => {
  it('returns 200 with enabled:true when payment is enabled', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isTestMode as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (getClientCountry as ReturnType<typeof vi.fn>).mockResolvedValue({
      country: 'India',
      isIndia: true,
      confidence: 'high',
    });

    const response = await server.inject({ method: 'GET', url: '/api/payment/status' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(typeof body.enabled).toBe('boolean');
    expect(body.testMode).toBe(false);
    expect(body.region).toBe('India');
    expect(body.confidence).toBe('high');
  });

  it('returns 200 with enabled:false when payment is disabled', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await server.inject({ method: 'GET', url: '/api/payment/status' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.enabled).toBe(false);
  });

  it('returns region:null and confidence:unknown when geolocation throws', async () => {
    (getClientCountry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('geo timeout'));

    const response = await server.inject({ method: 'GET', url: '/api/payment/status' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    // Geolocation errors must never cause a 500 — degrade to unknown.
    expect(body.region).toBeNull();
    expect(body.confidence).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/payment/plans — returns plans array when payment enabled
// ---------------------------------------------------------------------------

describe('GET /api/payment/plans (payment enabled)', () => {
  it('returns 200 with a non-empty plans array', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await server.inject({ method: 'GET', url: '/api/payment/plans' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.plans)).toBe(true);
    const plans = body.plans as unknown[];
    // Three plans must be present when payment is enabled.
    expect(plans.length).toBe(3);
  });

  it('includes monthly_pass, credits_50, and credits_200 plan IDs', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await server.inject({ method: 'GET', url: '/api/payment/plans' });
    const body = JSON.parse(response.body) as Record<string, unknown>;
    const plans = body.plans as Array<Record<string, unknown>>;

    const ids = plans.map((p) => p.id);
    expect(ids).toContain('monthly_pass');
    expect(ids).toContain('credits_50');
    expect(ids).toContain('credits_200');
  });

  it('each plan has id, name, pricePaise, and description fields', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await server.inject({ method: 'GET', url: '/api/payment/plans' });
    const body = JSON.parse(response.body) as Record<string, unknown>;
    const plans = body.plans as Array<Record<string, unknown>>;

    for (const plan of plans) {
      expect(typeof plan.id).toBe('string');
      expect(typeof plan.name).toBe('string');
      expect(typeof plan.pricePaise).toBe('number');
      expect(typeof plan.description).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. GET /api/payment/plans — returns empty array when payment disabled
// ---------------------------------------------------------------------------

describe('GET /api/payment/plans (payment disabled)', () => {
  it('returns 200 with an empty plans array', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await server.inject({ method: 'GET', url: '/api/payment/plans' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.plans)).toBe(true);
    expect((body.plans as unknown[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. POST /api/payment/create-order — invalid plan returns 400
// ---------------------------------------------------------------------------

describe('POST /api/payment/create-order', () => {
  it('returns 400 with error:invalid_plan when plan is unknown', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/create-order',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'unknown_plan' }),
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_plan');
  });

  it('returns 400 with error:invalid_plan when plan is missing', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/create-order',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_plan');
  });

  it('creates an order and returns orderId, amount, currency, keyId for a valid plan', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (createOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      orderId: 'order_test_123',
      amount: 99900,
      currency: 'INR',
    });
    // Simulate a test key ID present in env.
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/create-order',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'monthly_pass' }),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.orderId).toBe('order_test_123');
    expect(body.amount).toBe(99900);
    expect(body.currency).toBe('INR');
    // keyId should be the public key, never the secret.
    expect(body.keyId).toBe('rzp_test_abc');
    // Ensure the secret is not present.
    expect('keySecret' in body).toBe(false);

    // Reset env var set in this test — use undefined assignment (Biome noDelete).
    process.env.RAZORPAY_KEY_ID = undefined;
  });
});

// ---------------------------------------------------------------------------
// 5. POST /api/payment/create-order — payment disabled returns 503
// ---------------------------------------------------------------------------

describe('POST /api/payment/create-order (payment disabled)', () => {
  it('returns 503 with error:payment_disabled', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/create-order',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'monthly_pass' }),
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.error).toBe('payment_disabled');
  });
});

// ---------------------------------------------------------------------------
// 6. POST /api/payment/verify — bad signature returns 400
// ---------------------------------------------------------------------------

describe('POST /api/payment/verify', () => {
  it('returns 400 with error:invalid_signature when signature fails', async () => {
    // verifyPaymentSignature returns false → invalid signature.
    (verifyPaymentSignature as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderId: 'order_abc',
        paymentId: 'pay_abc',
        signature: 'bad_sig',
        plan: 'monthly_pass',
      }),
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_signature');
  });

  it('returns 400 when orderId is missing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_abc',
        signature: 'sig_abc',
        plan: 'monthly_pass',
      }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when plan is invalid', async () => {
    // Even with a truthy signature, an invalid plan should fail.
    (verifyPaymentSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderId: 'order_abc',
        paymentId: 'pay_abc',
        signature: 'good_sig',
        plan: 'not_a_valid_plan',
      }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 200 with success:true when signature passes and DB succeeds', async () => {
    (verifyPaymentSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Provide a pool whose query returns a valid upsert result for the grant row.
    const mockQuery = vi
      .fn()
      // First call: access_grants upsert RETURNING — return a grant row.
      .mockResolvedValueOnce({
        rows: [
          { id: 'grant-uuid', grant_type: 'monthly_pass', expires_at: new Date('2026-06-18') },
        ],
      })
      // Subsequent calls (credit insert, etc.) — return empty rows safely.
      .mockResolvedValue({ rows: [] });

    const pool = makeMockPool(mockQuery);
    await server.close();
    server = await buildTestServer(pool);

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderId: 'order_abc',
        paymentId: 'pay_abc',
        signature: 'good_sig',
        plan: 'monthly_pass',
      }),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.grantType).toBe('monthly_pass');
  });
});

// ---------------------------------------------------------------------------
// 7. GET /api/payment/balance — returns { balance: 0 } when payment disabled
// ---------------------------------------------------------------------------

describe('GET /api/payment/balance', () => {
  it('returns 200 with balance:0 when payment is disabled', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await server.inject({ method: 'GET', url: '/api/payment/balance' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.balance).toBe(0);
  });

  it('returns 200 with balance from getCreditBalance when payment is enabled', async () => {
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getCreditBalance as ReturnType<typeof vi.fn>).mockResolvedValue(47);

    const response = await server.inject({ method: 'GET', url: '/api/payment/balance' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.balance).toBe(47);
  });
});

// ---------------------------------------------------------------------------
// 8. POST /api/payment/webhook — invalid signature returns 401
// ---------------------------------------------------------------------------

describe('POST /api/payment/webhook', () => {
  it('returns 401 with error:invalid_webhook_signature when signature fails', async () => {
    // verifyWebhookSignature returns false → reject the webhook.
    (verifyWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_abc', order_id: 'order_abc', amount: 99900 } } },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/webhook',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'bad_signature',
      },
      body: payload,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_webhook_signature');
  });

  it('returns 401 when x-razorpay-signature header is missing', async () => {
    const payload = JSON.stringify({ event: 'payment.captured', payload: {} });

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/webhook',
      headers: { 'content-type': 'application/json' },
      // No x-razorpay-signature header.
      body: payload,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_webhook_signature');
  });

  it('returns 200 { received: true } when signature passes and event is processed', async () => {
    // verifyWebhookSignature returns true → accept the webhook.
    (verifyWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Pool whose query returns empty rows (no duplicate event, idempotency passes).
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const pool = makeMockPool(mockQuery);
    await server.close();
    server = await buildTestServer(pool);
    // Re-apply mocks after server rebuild.
    (verifyWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const payload = JSON.stringify({
      id: 'evt_test_001',
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_abc', order_id: 'order_abc', amount: 99900 } } },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/webhook',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'valid_signature',
      },
      body: payload,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.received).toBe(true);
  });

  it('returns 200 { received: true } for duplicate event (idempotency)', async () => {
    (verifyWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Pool that returns a row on the first query (existing event found).
    const mockQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ razorpay_event_id: 'evt_dup_001' }] });

    const pool = makeMockPool(mockQuery);
    await server.close();
    server = await buildTestServer(pool);
    (verifyWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const payload = JSON.stringify({
      id: 'evt_dup_001',
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_dup', order_id: 'order_dup', amount: 99900 } } },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/payment/webhook',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'valid_signature',
      },
      body: payload,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.received).toBe(true);
    // The access_grants UPDATE must NOT be called again (duplicate event skipped).
    // mockQuery was called once (for the idempotency SELECT) and stopped there.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
