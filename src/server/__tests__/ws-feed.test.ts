/**
 * Integration tests for the /ws/ticks WebSocket feed and /api/meta endpoint.
 *
 * Tests:
 *  1. GET /api/meta returns simulate / broker fields and authDegraded: false
 *  2. GET /api/meta reflects authDegraded: true after setAuthDegraded(true)
 *  3. A tick published to market.ticks Redis stream is delivered to a connected
 *     /ws/ticks client
 *  4. Per-socket cleanup runs on socket close: the duplicate() client is quit,
 *     no leak — teardown invoked exactly once
 *  5. MAX_WS_CONNECTIONS cap: when limit is reached the next connection receives
 *     a JSON error frame with code TOO_MANY_CONNECTIONS
 *
 * Design:
 *  - Tests 1-4 use fake Redis mocks (no Docker required) — Fastify inject() for
 *    HTTP routes and a real listener on port 0 for WebSocket routes (WebSocket
 *    upgrade is not supported by server.inject()).
 *  - Test 5 uses vi.resetModules() + a dynamic import so MAX_WS_CONNECTIONS is
 *    re-evaluated with process.env.MAX_WS_CONNECTIONS = '1' in the new module
 *    scope — the only reliable way to test the IIFE cap without touching
 *    production code.
 *  - All mocks follow the pattern established in server.test.ts (same vi.mock
 *    stubs for pg, eod-retrospection-job, retrospection routes).
 *  - WebSocket client: uses the 'ws' package (already in the project's
 *    node_modules). Vitest runs under Node.js which has no global WebSocket, so
 *    we use ws.WebSocket directly. This matches the smoke.test.ts fallback pattern.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — 'ws' has no @types/ws in this project; the pattern mirrors
// the smoke.test.ts dynamic-import fallback (see src/test/integration/smoke.test.ts).
import WebSocket from 'ws';

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any imports that pull in the mocked
// modules so that vi.mock() hoisting applies them to every subsequent import.
// ---------------------------------------------------------------------------

vi.mock('pg', () => {
  const MockPool = vi.fn(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  }));
  return { Pool: MockPool };
});

vi.mock('../../jobs/eod-retrospection-job.js', () => ({
  createEodRetrospectionQueue: vi.fn(() => ({ add: vi.fn(), close: vi.fn() })),
  createEodRetrospectionWorker: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../../api/routes/retrospection.js', () => ({
  retrospectionRoutes: async () => {
    /* noop plugin stub */
  },
}));

import { setAuthDegraded } from '../../state/broker-status';
// Import buildServer and the broker-status module after mocks are declared.
import { buildServer } from '../index';

// ---------------------------------------------------------------------------
// Fake Redis factory
//
// Mirrors the shape used in api-routes.integration.test.ts — only the methods
// the WS handler actually calls are stubbed.
// ---------------------------------------------------------------------------

/**
 * A minimal fake Redis that supports duplicate() and records xread calls.
 * The duplicate() returns a child stub with xread: () => null so the WS poll
 * loops exit immediately without blocking, and quit() is a no-op.
 *
 * Exposes `.duplicateStub` so tests can inspect calls on it.
 */
interface FakeRedisWithStubs {
  redis: Redis;
  duplicateStub: {
    xread: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
  };
}

function makeFakeRedis(): FakeRedisWithStubs {
  const duplicateStub = {
    xread: vi.fn().mockResolvedValue(null),
    quit: vi.fn().mockResolvedValue('OK'),
  };

  const redis = {
    xread: vi.fn().mockResolvedValue(null),
    duplicate: vi.fn().mockReturnValue(duplicateStub),
  } as unknown as Redis;

  return { redis, duplicateStub };
}

/**
 * Build a Fastify server, start it on a random port (0), and return the server
 * and its listening URL. Using a real listener is required for WebSocket tests
 * because WebSocket upgrades are not supported by Fastify's server.inject().
 */
async function buildListeningServer(
  redisOverride?: Redis,
): Promise<{ server: FastifyInstance; baseUrl: string; wsUrl: string }> {
  const { redis } = redisOverride ? { redis: redisOverride } : makeFakeRedis();
  const server = await buildServer({ logger: false }, undefined, redis);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws/ticks`;
  return { server, baseUrl, wsUrl };
}

/**
 * Open a WebSocket connection (using ws package) and wait for the first
 * message, then close. Returns the first message payload as a string.
 */
function receiveFirstMessage(wsUrl: string, timeoutMs = 3000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket: no message received within ${timeoutMs}ms`));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl);

    ws.on('message', (data: unknown) => {
      clearTimeout(timer);
      const msg = Buffer.isBuffer(data) ? data.toString() : String(data);
      resolve(msg);
      ws.close();
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Open a WebSocket connection, collect all messages until the socket closes,
 * then return them. Useful for the cap-rejection test where the server closes
 * the socket immediately after the error frame.
 */
function receiveAllMessages(wsUrl: string, timeoutMs = 3000): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const messages: string[] = [];

    let settled = false;
    const done = (msgs: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(msgs);
    };

    const timer = setTimeout(() => done(messages), timeoutMs);

    const ws = new WebSocket(wsUrl);

    ws.on('message', (data: unknown) => {
      messages.push(Buffer.isBuffer(data) ? data.toString() : String(data));
    });

    ws.on('close', () => done(messages));

    ws.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// /api/meta tests — use server.inject() (no real listener needed)
// ---------------------------------------------------------------------------

describe('GET /api/meta', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    const { redis } = makeFakeRedis();
    server = await buildServer({ logger: false }, undefined, redis);
  });

  afterEach(async () => {
    await server.close();
    vi.clearAllMocks();
    // Always reset authDegraded to false so this state does not leak across tests.
    setAuthDegraded(false);
  });

  it('returns simulate and broker fields from process.env with authDegraded false by default', async () => {
    const savedSimulate = process.env.SIMULATE;
    const savedBroker = process.env.BROKER;
    process.env.SIMULATE = 'true';
    process.env.BROKER = 'fyers';

    try {
      const response = await server.inject({ method: 'GET', url: '/api/meta' });
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        simulate: boolean;
        broker: string;
        authDegraded: boolean;
      }>();
      expect(body.simulate).toBe(true);
      expect(body.broker).toBe('fyers');
      expect(body.authDegraded).toBe(false);
    } finally {
      if (savedSimulate === undefined) delete process.env.SIMULATE;
      else process.env.SIMULATE = savedSimulate;
      if (savedBroker === undefined) delete process.env.BROKER;
      else process.env.BROKER = savedBroker;
    }
  });

  it('returns authDegraded: true after setAuthDegraded(true) and false after reset', async () => {
    // Set the degraded flag before the request.
    setAuthDegraded(true);

    const degraded = await server.inject({ method: 'GET', url: '/api/meta' });
    expect(degraded.statusCode).toBe(200);
    const degradedBody = degraded.json<{ authDegraded: boolean }>();
    expect(degradedBody.authDegraded).toBe(true);

    // Reset the flag and verify it goes back to false.
    setAuthDegraded(false);

    const recovered = await server.inject({ method: 'GET', url: '/api/meta' });
    const recoveredBody = recovered.json<{ authDegraded: boolean }>();
    expect(recoveredBody.authDegraded).toBe(false);
  });

  it('returns broker as empty string when BROKER env var is not set', async () => {
    const savedBroker = process.env.BROKER;
    delete process.env.BROKER;

    try {
      const response = await server.inject({ method: 'GET', url: '/api/meta' });
      const body = response.json<{ broker: string }>();
      expect(body.broker).toBe('');
    } finally {
      if (savedBroker !== undefined) process.env.BROKER = savedBroker;
    }
  });
});

// ---------------------------------------------------------------------------
// /ws/ticks — 'connected' acknowledgement
// ---------------------------------------------------------------------------

describe('/ws/ticks — connected acknowledgement', () => {
  it('sends a { type: "connected" } frame immediately upon connection', async () => {
    const { server, wsUrl } = await buildListeningServer();

    try {
      const firstMsg = await receiveFirstMessage(wsUrl);
      const frame = JSON.parse(firstMsg) as Record<string, unknown>;
      expect(frame.type).toBe('connected');
      expect(typeof frame.timestamp).toBe('number');
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /ws/ticks — tick delivery from Redis stream
//
// To simulate a tick arriving AFTER the socket connects, we control when the
// fake xread returns data. The strategy:
//   1. Build a fake Redis whose xread initially returns null (no messages).
//   2. Connect a WebSocket client and wait for the 'connected' frame.
//   3. Replace xread's implementation to return a tick payload once, then null.
//   4. The WS handler's poll loop will pick it up in its next iteration (≤100ms).
//   5. Assert the 'tick' frame arrives at the client.
// ---------------------------------------------------------------------------

describe('/ws/ticks — tick delivery from Redis stream', () => {
  it('delivers a tick message when a tick is published to market.ticks stream', async () => {
    const { redis: fakeRedis, duplicateStub } = makeFakeRedis();
    const { server, wsUrl } = await buildListeningServer(fakeRedis);

    try {
      const messages: string[] = [];

      const allDone = new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(
          () => reject(new Error('timeout: tick frame not received')),
          4000,
        );

        ws.on('message', (data: unknown) => {
          const msg = Buffer.isBuffer(data) ? data.toString() : String(data);
          messages.push(msg);

          const frame = JSON.parse(msg) as Record<string, unknown>;
          if (frame.type === 'connected') {
            // Socket is open. Now inject a tick into the stream by making the
            // next xread call on the duplicate client return one message.
            const tickPayload = JSON.stringify({
              symbol: 'NSE:NIFTY50-INDEX',
              ltp: 22_500,
              timestamp: Date.now(),
            });

            // Build the ioredis XREAD return shape:
            // [ [ 'market.ticks', [ ['1-1', ['data', <json>]] ] ] ]
            const xreadResult: [string, [string, string[]][]][] = [
              ['market.ticks', [['1-1', ['data', tickPayload]]]],
            ];

            // Override the duplicate's xread: return tick once, then null always.
            duplicateStub.xread.mockResolvedValueOnce(xreadResult).mockResolvedValue(null);
          }

          if (frame.type === 'tick') {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        });

        ws.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      await allDone;

      // There must be at least one 'tick' frame in the collected messages.
      const tickFrames = messages
        .map((m) => JSON.parse(m) as Record<string, unknown>)
        .filter((f) => f.type === 'tick');

      expect(tickFrames.length).toBeGreaterThan(0);
      const tickFrame = tickFrames[0]!;
      expect(tickFrame.symbol).toBe('NSE:NIFTY50-INDEX');
      expect(tickFrame.ltp).toBe(22_500);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// /ws/ticks — per-socket cleanup on close
//
// When the client closes the WebSocket, the server's socket 'close' handler
// must call the cleanup() function which:
//   1. Calls quit() on the per-connection duplicate Redis client.
//   2. Removes the cleanup callback from wsCleanupCallbacks (no leak).
//   3. Decrements wsConnectionCount.
//
// We can observe (1) directly: quit() on the duplicate stub must be called
// after the client closes the socket.
// ---------------------------------------------------------------------------

describe('/ws/ticks — per-socket cleanup on close', () => {
  it('calls quit() on the duplicate Redis client when the socket closes', async () => {
    const { redis: fakeRedis, duplicateStub } = makeFakeRedis();
    const { server, wsUrl } = await buildListeningServer(fakeRedis);

    try {
      // Connect, wait for the 'connected' frame, then close the socket.
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(
          () => reject(new Error('timeout: did not receive connected frame')),
          3000,
        );

        ws.on('message', (data: unknown) => {
          const frame = JSON.parse(
            Buffer.isBuffer(data) ? data.toString() : String(data),
          ) as Record<string, unknown>;

          if (frame.type === 'connected') {
            clearTimeout(timeout);
            // Connection is established — close it now.
            ws.close();
          }
        });

        ws.on('close', () => resolve());
        ws.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Give the server's 'close' handler a brief moment to run (it is async
      // in the event loop but should complete within one tick cycle).
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      // quit() on the duplicate must have been called exactly once.
      expect(duplicateStub.quit).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('duplicate() is called once per connection', async () => {
    const { redis: fakeRedis } = makeFakeRedis();
    const duplicateSpy = vi.spyOn(fakeRedis, 'duplicate');
    const { server, wsUrl } = await buildListeningServer(fakeRedis);

    try {
      await receiveFirstMessage(wsUrl);
      // Give cleanup a moment to run.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      // duplicate() must have been called exactly once for this connection.
      expect(duplicateSpy).toHaveBeenCalledTimes(1);
    } finally {
      duplicateSpy.mockRestore();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// MAX_WS_CONNECTIONS cap
//
// MAX_WS_CONNECTIONS is evaluated as an IIFE at module load time, so it cannot
// be overridden by setting process.env.MAX_WS_CONNECTIONS after the module has
// been imported. The only reliable way to test it is to:
//   1. Set process.env.MAX_WS_CONNECTIONS before the module loads.
//   2. Use vi.resetModules() to discard the cached module.
//   3. Dynamically import buildServer from the reset module cache.
//   4. After the test, restore the env var and reset modules again.
//
// The test sets the cap to 1, opens one connection (which consumes the slot),
// then opens a second connection and asserts it receives a TOO_MANY_CONNECTIONS
// error frame and is closed immediately.
// ---------------------------------------------------------------------------

describe('MAX_WS_CONNECTIONS cap', () => {
  it('rejects a new connection with TOO_MANY_CONNECTIONS when the cap is reached', async () => {
    const savedMax = process.env.MAX_WS_CONNECTIONS;
    process.env.MAX_WS_CONNECTIONS = '1';

    // Reset the module cache so buildServer re-evaluates MAX_WS_CONNECTIONS.
    vi.resetModules();

    let server: FastifyInstance | undefined;
    let firstSocket: WebSocket | undefined;

    try {
      // Dynamically import after reset so the IIFE sees MAX_WS_CONNECTIONS = '1'.
      // We must also re-apply the same vi.mock() stubs because vi.mock() hoisting
      // only applies to static imports; after resetModules() the mocks are gone.
      vi.mock('pg', () => {
        const MockPool = vi.fn(() => ({
          query: vi.fn().mockResolvedValue({ rows: [] }),
          end: vi.fn().mockResolvedValue(undefined),
        }));
        return { Pool: MockPool };
      });

      vi.mock('../../jobs/eod-retrospection-job.js', () => ({
        createEodRetrospectionQueue: vi.fn(() => ({ add: vi.fn(), close: vi.fn() })),
        createEodRetrospectionWorker: vi.fn(() => ({ close: vi.fn() })),
      }));

      vi.mock('../../api/routes/retrospection.js', () => ({
        retrospectionRoutes: async () => {
          /* noop */
        },
      }));

      const { buildServer: freshBuildServer } = await import('../index');

      const { redis: fakeRedis } = makeFakeRedis();
      server = await freshBuildServer({ logger: false }, undefined, fakeRedis);
      await server.listen({ port: 0, host: '127.0.0.1' });

      const addr = server.server.address() as AddressInfo;
      const wsUrl = `ws://127.0.0.1:${addr.port}/ws/ticks`;

      // Connection 1 — fills the single available slot.
      firstSocket = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('first socket: no connected frame within 3s')),
          3000,
        );
        firstSocket!.on('message', (data: unknown) => {
          const f = JSON.parse(Buffer.isBuffer(data) ? data.toString() : String(data)) as Record<
            string,
            unknown
          >;
          if (f.type === 'connected') {
            clearTimeout(timeout);
            resolve();
          }
        });
        firstSocket!.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Connection 2 — must be rejected.
      const secondMessages = await receiveAllMessages(wsUrl, 3000);

      // The second connection must have received at least one message.
      expect(secondMessages.length).toBeGreaterThan(0);

      // The first message must be the TOO_MANY_CONNECTIONS error frame.
      const errorFrame = JSON.parse(secondMessages[0]!) as Record<string, unknown>;
      expect(errorFrame.type).toBe('error');
      expect(errorFrame.code).toBe('TOO_MANY_CONNECTIONS');
      expect(typeof errorFrame.message).toBe('string');
    } finally {
      if (firstSocket) firstSocket.close();
      if (server) await server.close();

      if (savedMax === undefined) delete process.env.MAX_WS_CONNECTIONS;
      else process.env.MAX_WS_CONNECTIONS = savedMax;

      // Reset modules again so subsequent tests in this file get the original
      // buildServer with the original MAX_WS_CONNECTIONS = 50.
      vi.resetModules();
    }
  });
});
