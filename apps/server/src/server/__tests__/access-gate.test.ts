/**
 * Unit tests for src/server/middleware/access-gate.ts
 *
 * All tests use mocked dependencies:
 *  - `isPaymentEnabled` from src/payment/razorpay is vi.mock'd per test
 *  - pg.Pool is replaced with a hand-crafted mock that returns shaped rows
 *  - Fastify's request/reply objects are shallow stubs — no real HTTP
 *
 * The pg mock returns a `query` function whose behaviour is controlled by
 * `mockQuery.mockResolvedValueOnce(...)` in each test. Multiple calls to
 * query() within checkAccess() are sequenced by `mockResolvedValueOnce`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any import of the module under test.
// ---------------------------------------------------------------------------

// Mock isPaymentEnabled so each test can control whether payment is active.
vi.mock('../../payment/razorpay', () => ({
  isPaymentEnabled: vi.fn(),
}));

// Import the mock so we can configure it per test.
import { isPaymentEnabled } from '../../payment/razorpay';

// Import the module under test after mocks are in place.
import { checkAccess, requireAccess, requireCredits } from '../middleware/access-gate';

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal pg.Pool mock. `query` is a vi.fn() whose resolved value can
 * be overridden per call with mockResolvedValueOnce().
 */
function makeMockPool(defaultRows: unknown[] = []): Pool {
  const mockQuery = vi.fn().mockResolvedValue({ rows: defaultRows });
  return { query: mockQuery } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Mock Fastify request / reply factories
// ---------------------------------------------------------------------------

interface MockReply {
  _statusCode: number;
  _body: unknown;
  status: (code: number) => MockReply;
  send: (body: unknown) => Promise<void>;
}

function makeMockReply(db: Pool): { request: FastifyRequestStub; reply: MockReply } {
  const reply: MockReply = {
    _statusCode: 200,
    _body: undefined,
    status(code: number) {
      this._statusCode = code;
      return this;
    },
    async send(body: unknown) {
      this._body = body;
    },
  };

  // Minimal FastifyRequest stub — only server.db is accessed by the hooks.
  const request = {
    server: { db },
  } as FastifyRequestStub;

  return { request, reply };
}

// Minimal stub type — only the fields the hooks actually read.
interface FastifyRequestStub {
  server: { db: Pool };
}

// ---------------------------------------------------------------------------
// Helper: cast isPaymentEnabled to a vi.Mock so we can call mockReturnValue.
// ---------------------------------------------------------------------------
function mockPaymentEnabled(enabled: boolean): void {
  (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(enabled);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- checkAccess ---

describe('checkAccess', () => {
  it('returns granted=true reason=payment_disabled when payment is not enabled', async () => {
    mockPaymentEnabled(false);
    const db = makeMockPool();

    const result = await checkAccess(db);

    expect(result.granted).toBe(true);
    expect(result.reason).toBe('payment_disabled');
    // DB should never be touched in free mode.
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns granted=true reason=active_monthly_pass when a valid pass exists', async () => {
    mockPaymentEnabled(true);
    const expiresAt = new Date(Date.now() + 86_400_000); // tomorrow

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    // First call: monthly_pass grant query → one row returned.
    mockQuery.mockResolvedValueOnce({ rows: [{ expires_at: expiresAt }] });

    const result = await checkAccess(db);

    expect(result.granted).toBe(true);
    expect(result.reason).toBe('active_monthly_pass');
    expect(result.expiresAt).toEqual(expiresAt);
    // Credit balance query should NOT be called — we short-circuit on the grant.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns granted=true reason=active_monthly_pass without expiresAt when expires_at is null', async () => {
    // Some grants may have a null expires_at (unlimited / manually granted).
    mockPaymentEnabled(true);

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    mockQuery.mockResolvedValueOnce({ rows: [{ expires_at: null }] });

    const result = await checkAccess(db);

    expect(result.granted).toBe(true);
    expect(result.reason).toBe('active_monthly_pass');
    // exactOptionalPropertyTypes: expiresAt must be absent, not undefined.
    expect('expiresAt' in result).toBe(false);
  });

  it('returns granted=true reason=has_credits when no pass but positive balance', async () => {
    mockPaymentEnabled(true);

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    // First call: monthly_pass → no rows.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Second call: credit balance → balance of 5.
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '5' }] });

    const result = await checkAccess(db);

    expect(result.granted).toBe(true);
    expect(result.reason).toBe('has_credits');
    expect(result.creditBalance).toBe(5);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('returns granted=false reason=no_grant when no pass and zero balance', async () => {
    mockPaymentEnabled(true);

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    // First call: monthly_pass → no rows.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Second call: credit balance → 0.
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });

    const result = await checkAccess(db);

    expect(result.granted).toBe(false);
    expect(result.reason).toBe('no_grant');
  });

  it('returns granted=false reason=no_grant on DB error (never throws)', async () => {
    mockPaymentEnabled(true);

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    // Must not throw.
    const result = await checkAccess(db);

    expect(result.granted).toBe(false);
    expect(result.reason).toBe('no_grant');
  });
});

// --- requireAccess ---

describe('requireAccess', () => {
  it('allows through when payment is disabled (does not call reply.status)', async () => {
    mockPaymentEnabled(false);

    const db = makeMockPool();
    const { request, reply } = makeMockReply(db);

    await requireAccess(
      request as unknown as Parameters<typeof requireAccess>[0],
      reply as unknown as Parameters<typeof requireAccess>[1],
    );

    // reply.status() should never be called — route proceeds normally.
    expect(reply._statusCode).toBe(200);
    expect(reply._body).toBeUndefined();
  });

  it('allows through when an active monthly pass exists', async () => {
    mockPaymentEnabled(true);

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    mockQuery.mockResolvedValueOnce({ rows: [{ expires_at: new Date(Date.now() + 86_400_000) }] });

    const { request, reply } = makeMockReply(db);

    await requireAccess(
      request as unknown as Parameters<typeof requireAccess>[0],
      reply as unknown as Parameters<typeof requireAccess>[1],
    );

    expect(reply._statusCode).toBe(200);
    expect(reply._body).toBeUndefined();
  });

  it('returns 403 when payment is enabled and no grant or credits exist', async () => {
    mockPaymentEnabled(true);

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    // No monthly_pass.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Zero credits.
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });

    const { request, reply } = makeMockReply(db);

    await requireAccess(
      request as unknown as Parameters<typeof requireAccess>[0],
      reply as unknown as Parameters<typeof requireAccess>[1],
    );

    expect(reply._statusCode).toBe(403);
    const body = reply._body as Record<string, unknown>;
    expect(body.error).toBe('access_denied');
    expect(body.reason).toBe('no_grant');
  });
});

// --- requireCredits ---

describe('requireCredits', () => {
  it('behaves identically to requireAccess at MVP — allows through when payment disabled', async () => {
    mockPaymentEnabled(false);

    const db = makeMockPool();
    const { request, reply } = makeMockReply(db);

    await requireCredits(
      request as unknown as Parameters<typeof requireCredits>[0],
      reply as unknown as Parameters<typeof requireCredits>[1],
    );

    expect(reply._statusCode).toBe(200);
    expect(reply._body).toBeUndefined();
  });

  it('allows through when monthly pass is active (pass includes unlimited credits)', async () => {
    mockPaymentEnabled(true);

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    mockQuery.mockResolvedValueOnce({ rows: [{ expires_at: new Date(Date.now() + 86_400_000) }] });

    const { request, reply } = makeMockReply(db);

    await requireCredits(
      request as unknown as Parameters<typeof requireCredits>[0],
      reply as unknown as Parameters<typeof requireCredits>[1],
    );

    expect(reply._statusCode).toBe(200);
  });

  it('returns 403 when payment enabled, no grant, no credits', async () => {
    mockPaymentEnabled(true);

    const db = makeMockPool();
    const mockQuery = (db as unknown as { query: ReturnType<typeof vi.fn> }).query;
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });

    const { request, reply } = makeMockReply(db);

    await requireCredits(
      request as unknown as Parameters<typeof requireCredits>[0],
      reply as unknown as Parameters<typeof requireCredits>[1],
    );

    expect(reply._statusCode).toBe(403);
    const body = reply._body as Record<string, unknown>;
    expect(body.error).toBe('access_denied');
  });
});
