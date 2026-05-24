import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import type { Clock } from '../../utils/clock.js';

/**
 * Options injected when this plugin is registered.
 * Both db and clock are injected (not imported from singletons) so the
 * plugin is independently testable with mocks.
 */
export interface DashboardRoutesOptions {
  db: Pool;
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Response schema for GET /dashboard/live
// ---------------------------------------------------------------------------
// roc and acceleration are typed as ["number", "null"] because they are not
// present in the current straddle_snapshots schema (migration 001) — they are
// planned for a future migration. The response always returns them as null
// until the schema gains those columns. This is consistent with the task spec
// note "roc and acceleration may be null in some rows".
//
// straddleValue and atmStrike are NUMERIC in PostgreSQL, which the pg driver
// returns as strings (see schema.ts header for the NUMERIC string-type rationale).
// We declare them as "string" here to match the wire format.
const LIVE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    straddleValue: { type: 'string' },
    roc: { type: ['number', 'null'] },
    acceleration: { type: ['number', 'null'] },
    atmStrike: { type: 'string' },
    underlying: { type: 'string' },
    timestamp: { type: 'string' },
  },
  required: ['straddleValue', 'atmStrike', 'underlying', 'timestamp'],
} as const;

// ---------------------------------------------------------------------------
// Response schema for GET /dashboard/summary
// ---------------------------------------------------------------------------
// Returns lightweight trade summaries for the current IST day.
// gross_pnl is NUMERIC → string; straddle_at_entry similarly.
// exit_reason can be null for open trades included in the summary.
const SUMMARY_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closed'] },
    straddle_at_entry: { type: 'string' },
    gross_pnl: { type: ['string', 'null'] },
    exit_reason: { type: ['string', 'null'] },
  },
  required: ['id', 'status', 'straddle_at_entry'],
} as const;

/**
 * Fastify plugin for dashboard read endpoints.
 *
 * Routes are read-only (GET only). They surface live straddle data and
 * today's trade summary for the React dashboard.
 *
 * GET /dashboard/live  — latest straddle snapshot within the past minute.
 *                        404 when the feed is stale (useful for the dashboard to detect feed-down).
 * GET /dashboard/summary — today's paper_trades (IST date). Polled by the React dashboard every 10s.
 */
export const dashboardRoutes: FastifyPluginAsync<DashboardRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: DashboardRoutesOptions,
): Promise<void> => {
  // -------------------------------------------------------------------------
  // GET /dashboard/live
  // -------------------------------------------------------------------------
  // Returns the most recent straddle snapshot from the last 60 seconds.
  //
  // Why "NOW() - INTERVAL '1 minute'" instead of a larger window?
  // The hypertable technical mandate requires a time-range filter on every
  // query against straddle_snapshots (see technical.md — full-table scans on
  // hypertables are extremely slow). One minute is tight enough to detect
  // a stale feed quickly on the dashboard without scanning too much data.
  // The query is ORDER BY time DESC LIMIT 1 so PostgreSQL only needs the
  // single most-recent chunk — TimescaleDB's chunk exclusion optimiser will
  // skip all older partitions.
  //
  // Returns 404 if no snapshot has arrived in the last minute (e.g. market
  // closed, data feed down) so the dashboard can show a "no recent data"
  // state rather than stale numbers.
  fastify.get(
    '/dashboard/live',
    {
      schema: {
        response: {
          200: LIVE_RESPONSE_SCHEMA,
          404: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
            required: ['message'],
          },
        },
      },
    },
    async (_request, reply) => {
      const result = await opts.db.query<{
        straddle_value: string;
        atm_strike: string;
        underlying: string;
        time: Date;
      }>(
        `SELECT straddle_value, atm_strike, underlying, time
         FROM straddle_snapshots
         WHERE time > NOW() - INTERVAL '1 minute'
         ORDER BY time DESC
         LIMIT 1`,
      );

      if (result.rows.length === 0) {
        // 404 signals "no recent data" — the dashboard can render a "feed
        // inactive" state. This is not a server error; we use reply.code()
        // and return the body rather than throwing, which keeps Fastify's
        // schema serialiser active for the 404 shape.
        return reply.code(404).send({ message: 'No straddle snapshot in the last minute' });
      }

      const row = result.rows[0] as {
        straddle_value: string;
        atm_strike: string;
        underlying: string;
        time: Date;
      };

      return {
        straddleValue: row.straddle_value,
        // roc and acceleration are not yet in the DB schema (migration 001).
        // Return null until a future migration adds these columns.
        roc: null,
        acceleration: null,
        atmStrike: row.atm_strike,
        underlying: row.underlying,
        // Convert the pg Date object to ISO 8601 string for the JSON payload.
        timestamp: row.time.toISOString(),
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /dashboard/summary
  // -------------------------------------------------------------------------
  // Returns all paper trades opened today (IST date) regardless of status.
  //
  // Why AT TIME ZONE 'Asia/Kolkata'?
  // entry_time is stored as TIMESTAMPTZ (UTC in the DB). DATE() applied
  // without a timezone converts to the server's local timezone, which may not
  // be IST. Explicit AT TIME ZONE 'Asia/Kolkata' ensures the date boundary
  // matches the trading day boundary (midnight IST) regardless of where the
  // server runs — this is consistent with clock.today() which also uses IST.
  //
  // $1 is the today string ('YYYY-MM-DD') from clock.today(). Using a
  // parameterised query (not string interpolation) prevents SQL injection
  // even though the value comes from a controlled source — safe defaults rule.
  fastify.get(
    '/dashboard/summary',
    {
      schema: {
        response: {
          200: {
            type: 'array',
            items: SUMMARY_ITEM_SCHEMA,
          },
        },
      },
    },
    async (_request, _reply) => {
      const today = opts.clock.today(); // 'YYYY-MM-DD' in IST

      const result = await opts.db.query<{
        id: string;
        status: 'open' | 'closed';
        straddle_at_entry: string;
        gross_pnl: string | null;
        exit_reason: string | null;
      }>(
        `SELECT id, status, straddle_at_entry, gross_pnl, exit_reason
         FROM paper_trades
         WHERE DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $1
         ORDER BY entry_time ASC`,
        [today],
      );

      return result.rows;
    },
  );
};
