/**
 * Integration tests for the Fastify API routes.
 *
 * Uses server.inject() — no real HTTP listener, no real DB, no real Redis.
 * All DB queries are mocked with vi.fn(). Redis is stubbed to prevent the
 * WebSocket broadcast loop from making real connections.
 *
 * The goal is to verify route-level behaviour: HTTP status codes, response
 * shapes, AJV query-string validation, and correct DB query invocation.
 */

import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../api/server.js";
import { FixedClock } from "../../utils/clock.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Returns a minimal pg Pool mock whose query() resolves with the given rows.
 * A new mock is created per describe-block so per-test overrides with
 * mockResolvedValueOnce() do not bleed across suites.
 */
function mockDb(rows: Record<string, unknown>[] = []): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    end: vi.fn(),
  } as unknown as Pool;
}

/**
 * Returns a minimal Redis mock. The WebSocket handler calls redis.duplicate()
 * on each connection; the duplicate's xread is made to return null so the
 * broadcast loop immediately loops back without sending. The outer redis object
 * is never called by the REST routes — only the WebSocket handler uses it.
 */
function mockRedis(): Redis {
  return {
    xread: vi.fn().mockResolvedValue(null),
    duplicate: vi.fn().mockReturnValue({
      xread: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    }),
    disconnect: vi.fn(),
  } as unknown as Redis;
}

// Fixed clock frozen at 09:30 IST on 2026-01-15 — used by all tests that need a
// deterministic "today" value (dashboard/summary, paper-trades default date).
const TEST_CLOCK = new FixedClock("2026-01-15T09:30:00+05:30");

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer({ db: mockDb(), redis: mockRedis(), clock: TEST_CLOCK });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns HTTP 200 with status ok", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; time: number }>();
    expect(body.status).toBe("ok");
  });

  it("response contains a time field that is a number", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });
    const body = response.json<{ status: string; time: number }>();
    expect(typeof body.time).toBe("number");
    // The FixedClock value must be the epoch-ms of 2026-01-15T09:30:00+05:30.
    expect(body.time).toBe(TEST_CLOCK.now());
  });
});

// ---------------------------------------------------------------------------
// GET /api/trades
// ---------------------------------------------------------------------------

describe("GET /api/trades", () => {
  let server: FastifyInstance;
  let db: Pool;

  beforeAll(async () => {
    db = mockDb();
    server = buildServer({ db, redis: mockRedis(), clock: TEST_CLOCK });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns HTTP 200 with empty array when no open trades exist", async () => {
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await server.inject({ method: "GET", url: "/api/trades" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("returns HTTP 200 with trade objects when trades exist", async () => {
    const tradeRows = [
      {
        id: "trade-001",
        entry_time: "2026-01-15T04:00:00.000Z",
        exit_time: null,
        entry_ce_strike: null,
        entry_pe_strike: null,
        entry_ce_price: null,
        entry_pe_price: null,
        exit_ce_price: null,
        exit_pe_price: null,
        lots: 1,
        lot_size: 50,
        straddle_at_entry: "200.00",
        lowest_straddle_value_seen: "195.00",
        vix_at_entry: null,
        spot_at_entry: null,
        exit_reason: null,
        gross_pnl: null,
        net_pnl: null,
        max_drawdown: null,
        status: "open",
        notes: null,
      },
      {
        id: "trade-002",
        entry_time: "2026-01-15T05:00:00.000Z",
        exit_time: null,
        entry_ce_strike: null,
        entry_pe_strike: null,
        entry_ce_price: null,
        entry_pe_price: null,
        exit_ce_price: null,
        exit_pe_price: null,
        lots: 2,
        lot_size: 50,
        straddle_at_entry: "210.00",
        lowest_straddle_value_seen: "205.00",
        vix_at_entry: null,
        spot_at_entry: null,
        exit_reason: null,
        gross_pnl: null,
        net_pnl: null,
        max_drawdown: null,
        status: "open",
        notes: null,
      },
    ];

    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: tradeRows,
      rowCount: tradeRows.length,
    });

    const response = await server.inject({ method: "GET", url: "/api/trades" });
    expect(response.statusCode).toBe(200);

    const body = response.json<typeof tradeRows>();
    expect(body).toHaveLength(2);
    expect(body[0]?.id).toBe("trade-001");
    expect(body[0]?.lots).toBe(1);
    expect(body[0]?.lot_size).toBe(50);
    expect(body[0]?.straddle_at_entry).toBe("200.00");
    expect(body[0]?.lowest_straddle_value_seen).toBe("195.00");
    expect(body[0]?.status).toBe("open");
    expect(body[1]?.id).toBe("trade-002");
  });
});

// ---------------------------------------------------------------------------
// GET /api/trades/history
// ---------------------------------------------------------------------------

describe("GET /api/trades/history", () => {
  let server: FastifyInstance;
  let db: Pool;

  beforeAll(async () => {
    db = mockDb();
    server = buildServer({ db, redis: mockRedis(), clock: TEST_CLOCK });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns HTTP 200 with empty array when no closed trades exist", async () => {
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await server.inject({ method: "GET", url: "/api/trades/history" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("returns HTTP 200 with up to 100 closed trades", async () => {
    const closedRows = [
      {
        id: "trade-100",
        entry_time: "2026-01-15T04:00:00.000Z",
        exit_time: "2026-01-15T07:00:00.000Z",
        entry_ce_strike: null,
        entry_pe_strike: null,
        entry_ce_price: null,
        entry_pe_price: null,
        exit_ce_price: null,
        exit_pe_price: null,
        lots: 1,
        lot_size: 50,
        straddle_at_entry: "200.00",
        lowest_straddle_value_seen: "185.00",
        vix_at_entry: "14.50",
        spot_at_entry: "22000.00",
        exit_reason: "EOD",
        gross_pnl: "750.00",
        net_pnl: "700.00",
        max_drawdown: "-50.00",
        status: "closed",
        notes: null,
      },
      {
        id: "trade-101",
        entry_time: "2026-01-15T05:30:00.000Z",
        exit_time: "2026-01-15T08:00:00.000Z",
        entry_ce_strike: null,
        entry_pe_strike: null,
        entry_ce_price: null,
        entry_pe_price: null,
        exit_ce_price: null,
        exit_pe_price: null,
        lots: 2,
        lot_size: 50,
        straddle_at_entry: "220.00",
        lowest_straddle_value_seen: "200.00",
        vix_at_entry: "15.00",
        spot_at_entry: "22100.00",
        exit_reason: "STOP_LOSS",
        gross_pnl: "1000.00",
        net_pnl: "950.00",
        max_drawdown: "-100.00",
        status: "closed",
        notes: null,
      },
      {
        id: "trade-102",
        entry_time: "2026-01-14T04:00:00.000Z",
        exit_time: "2026-01-14T07:00:00.000Z",
        entry_ce_strike: null,
        entry_pe_strike: null,
        entry_ce_price: null,
        entry_pe_price: null,
        exit_ce_price: null,
        exit_pe_price: null,
        lots: 1,
        lot_size: 50,
        straddle_at_entry: "190.00",
        lowest_straddle_value_seen: "175.00",
        vix_at_entry: null,
        spot_at_entry: null,
        exit_reason: "EOD",
        gross_pnl: "375.00",
        net_pnl: "350.00",
        max_drawdown: null,
        status: "closed",
        notes: null,
      },
    ];

    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: closedRows,
      rowCount: closedRows.length,
    });

    const response = await server.inject({ method: "GET", url: "/api/trades/history" });
    expect(response.statusCode).toBe(200);

    const body = response.json<typeof closedRows>();
    expect(body).toHaveLength(3);
    // All returned rows must have status 'closed' (from mock data)
    for (const row of body) {
      expect(row.status).toBe("closed");
    }
    expect(body[0]?.id).toBe("trade-100");
    expect(body[0]?.exit_reason).toBe("EOD");
    expect(body[0]?.gross_pnl).toBe("750.00");
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/live
// ---------------------------------------------------------------------------

describe("GET /dashboard/live", () => {
  let server: FastifyInstance;
  let db: Pool;

  beforeAll(async () => {
    db = mockDb();
    server = buildServer({ db, redis: mockRedis(), clock: TEST_CLOCK });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns HTTP 404 when no recent snapshot exists", async () => {
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await server.inject({ method: "GET", url: "/dashboard/live" });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ message: string }>();
    expect(body.message).toMatch(/no straddle snapshot/i);
  });

  it("returns HTTP 200 with snapshot data when a recent snapshot exists", async () => {
    const snapshotTime = new Date("2026-01-15T04:00:00.000Z");
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        {
          straddle_value: "200",
          atm_strike: "22000",
          underlying: "NIFTY",
          time: snapshotTime,
        },
      ],
      rowCount: 1,
    });

    const response = await server.inject({ method: "GET", url: "/dashboard/live" });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      straddleValue: string;
      roc: number | null;
      acceleration: number | null;
      atmStrike: string;
      underlying: string;
      timestamp: string;
    }>();

    expect(body.straddleValue).toBe("200");
    expect(body.atmStrike).toBe("22000");
    expect(body.underlying).toBe("NIFTY");
    expect(body.timestamp).toBe(snapshotTime.toISOString());
  });

  it("response shape includes roc and acceleration fields (both null until migration)", async () => {
    const snapshotTime = new Date("2026-01-15T04:00:00.000Z");
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        {
          straddle_value: "200",
          atm_strike: "22000",
          underlying: "NIFTY",
          time: snapshotTime,
        },
      ],
      rowCount: 1,
    });

    const response = await server.inject({ method: "GET", url: "/dashboard/live" });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      straddleValue: string;
      roc: number | null;
      acceleration: number | null;
      atmStrike: string;
      underlying: string;
      timestamp: string;
    }>();

    // roc and acceleration are null until the DB schema adds them
    expect(body.roc).toBeNull();
    expect(body.acceleration).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/summary
// ---------------------------------------------------------------------------

describe("GET /dashboard/summary", () => {
  let server: FastifyInstance;
  let db: Pool;

  beforeAll(async () => {
    db = mockDb();
    server = buildServer({ db, redis: mockRedis(), clock: TEST_CLOCK });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns HTTP 200 with empty array when no trades today", async () => {
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await server.inject({ method: "GET", url: "/dashboard/summary" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("returns HTTP 200 with trade summaries for today", async () => {
    const summaryRows = [
      {
        id: "trade-001",
        status: "open",
        straddle_at_entry: "200.00",
        gross_pnl: null,
        exit_reason: null,
      },
      {
        id: "trade-002",
        status: "closed",
        straddle_at_entry: "210.00",
        gross_pnl: "500.00",
        exit_reason: "EOD",
      },
    ];

    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: summaryRows,
      rowCount: summaryRows.length,
    });

    const response = await server.inject({ method: "GET", url: "/dashboard/summary" });
    expect(response.statusCode).toBe(200);

    const body = response.json<typeof summaryRows>();
    expect(body).toHaveLength(2);
    expect(body[0]?.id).toBe("trade-001");
    expect(body[0]?.status).toBe("open");
    expect(body[0]?.straddle_at_entry).toBe("200.00");
    expect(body[0]?.gross_pnl).toBeNull();
    expect(body[1]?.id).toBe("trade-002");
    expect(body[1]?.gross_pnl).toBe("500.00");
    expect(body[1]?.exit_reason).toBe("EOD");
  });
});

// ---------------------------------------------------------------------------
// GET /paper-trades
// ---------------------------------------------------------------------------

describe("GET /paper-trades", () => {
  let server: FastifyInstance;
  let db: Pool;

  beforeAll(async () => {
    db = mockDb();
    server = buildServer({ db, redis: mockRedis(), clock: TEST_CLOCK });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns HTTP 400 for invalid date format", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/paper-trades?date=not-a-date",
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns HTTP 400 for invalid status value", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/paper-trades?status=invalid",
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns HTTP 200 with empty array for valid params when no trades match", async () => {
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await server.inject({
      method: "GET",
      url: "/paper-trades?date=2026-01-15&status=open",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("returns HTTP 200 with trade list when DB has matching data", async () => {
    const tradeRows = [
      {
        id: "trade-001",
        entry_time: "2026-01-15T04:00:00.000Z",
        exit_time: null,
        entry_ce_strike: null,
        entry_pe_strike: null,
        entry_ce_price: null,
        entry_pe_price: null,
        exit_ce_price: null,
        exit_pe_price: null,
        lots: 1,
        lot_size: 50,
        straddle_at_entry: "200.00",
        lowest_straddle_value_seen: "195.00",
        vix_at_entry: null,
        spot_at_entry: null,
        exit_reason: null,
        gross_pnl: null,
        net_pnl: null,
        max_drawdown: null,
        status: "open",
        notes: null,
      },
    ];

    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: tradeRows,
      rowCount: tradeRows.length,
    });

    const response = await server.inject({
      method: "GET",
      url: "/paper-trades?date=2026-01-15&status=open",
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<typeof tradeRows>();
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe("trade-001");
    expect(body[0]?.status).toBe("open");
  });

  it("uses page=2 to compute the correct SQL OFFSET (100)", async () => {
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await server.inject({
      method: "GET",
      url: "/paper-trades?date=2026-01-15&page=2",
    });
    expect(response.statusCode).toBe(200);

    // Verify the DB was queried with the page-2 offset value (100).
    const queryCall = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      (string | number)[],
    ];
    // params array: [date, pageSize=100, offset=100]
    const params = queryCall[1];
    // offset is the last param, pageSize is second-to-last
    expect(params[params.length - 1]).toBe(100); // offset for page 2
    expect(params[params.length - 2]).toBe(100); // pageSize cap
  });

  it("status=all omits the status filter from the SQL params", async () => {
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await server.inject({
      method: "GET",
      url: "/paper-trades?date=2026-01-15&status=all",
    });
    expect(response.statusCode).toBe(200);

    const queryCall = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      (string | number)[],
    ];
    const params = queryCall[1];
    // When status=all: params = [date, pageSize, offset] → length 3, no status string
    expect(params).toHaveLength(3);
    expect(params[0]).toBe("2026-01-15");
  });

  it("status=closed includes the status value in the SQL params", async () => {
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await server.inject({
      method: "GET",
      url: "/paper-trades?date=2026-01-15&status=closed",
    });
    expect(response.statusCode).toBe(200);

    const queryCall = (db.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      (string | number)[],
    ];
    const params = queryCall[1];
    // When status=closed: params = [date, status, pageSize, offset] → length 4
    expect(params).toHaveLength(4);
    expect(params[1]).toBe("closed");
  });
});
