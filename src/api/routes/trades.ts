import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";

/**
 * Options passed in when this plugin is registered.
 * db is the pg Pool — injected rather than imported from the module-level
 * singleton so the plugin remains testable without real Postgres.
 */
export interface TradesRoutesOptions {
  db: Pool;
}

// ---------------------------------------------------------------------------
// Inline JSON schemas (Fastify's native AJV format — no Zod dependency)
// ---------------------------------------------------------------------------

// One paper trade entry returned from the API.
// NUMERIC columns are serialised as strings (matches pg type-parser behaviour).
// nullable fields use `type: ["string", "null"]` — standard JSON Schema syntax.
const PAPER_TRADE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    entry_time: { type: "string" },
    exit_time: { type: ["string", "null"] },
    entry_ce_strike: { type: ["string", "null"] },
    entry_pe_strike: { type: ["string", "null"] },
    entry_ce_price: { type: ["string", "null"] },
    entry_pe_price: { type: ["string", "null"] },
    exit_ce_price: { type: ["string", "null"] },
    exit_pe_price: { type: ["string", "null"] },
    lots: { type: "number" },
    lot_size: { type: "number" },
    straddle_at_entry: { type: "string" },
    lowest_straddle_value_seen: { type: "string" },
    vix_at_entry: { type: ["string", "null"] },
    spot_at_entry: { type: ["string", "null"] },
    exit_reason: { type: ["string", "null"] },
    gross_pnl: { type: ["string", "null"] },
    net_pnl: { type: ["string", "null"] },
    max_drawdown: { type: ["string", "null"] },
    status: { type: "string", enum: ["open", "closed"] },
    notes: { type: ["string", "null"] },
  },
  required: [
    "id",
    "entry_time",
    "lots",
    "lot_size",
    "straddle_at_entry",
    "lowest_straddle_value_seen",
    "status",
  ],
} as const;

/**
 * Fastify plugin that mounts the paper trades REST endpoints.
 *
 * Routes are deliberately read-only (GET only). Write operations
 * are performed by the trading engine directly against the database;
 * the API surface is for dashboard consumption and retrospection queries.
 *
 * SQL queries return snake_case column names (PostgreSQL default) which
 * matches the schema property names above. No renaming needed — the pg
 * driver returns column names exactly as they appear in the query.
 *
 * Both queries include a time-range safeguard implied by ORDER / LIMIT;
 * for open trades we do not add a time filter because there is no
 * sensible cutoff for live positions. History is capped to 100 rows to
 * prevent full hypertable scans (the ORDER BY exit_time DESC + LIMIT
 * lets TimescaleDB use its chunk-exclusion optimiser efficiently).
 */
export const tradesRoutes: FastifyPluginAsync<TradesRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: TradesRoutesOptions,
): Promise<void> => {
  // GET /api/trades — all currently open paper trades
  fastify.get(
    "/api/trades",
    {
      schema: {
        response: {
          200: {
            type: "array",
            items: PAPER_TRADE_SCHEMA,
          },
        },
      },
    },
    async (_request, _reply) => {
      const result = await opts.db.query<Record<string, unknown>>(
        `SELECT * FROM paper_trades
         WHERE status = 'open'
           AND entry_time > NOW() - INTERVAL '7 days'
         ORDER BY entry_time DESC
         LIMIT 100`,
      );
      return result.rows;
    },
  );

  // GET /api/trades/history — last 100 closed trades, newest first.
  // ORDER BY exit_time DESC pairs well with TimescaleDB chunk exclusion:
  // the query planner scans the most-recent chunks first and stops at LIMIT 100
  // without touching older partitions.
  fastify.get(
    "/api/trades/history",
    {
      schema: {
        response: {
          200: {
            type: "array",
            items: PAPER_TRADE_SCHEMA,
          },
        },
      },
    },
    async (_request, _reply) => {
      const result = await opts.db.query<Record<string, unknown>>(
        `SELECT * FROM paper_trades
         WHERE status = 'closed'
         ORDER BY exit_time DESC
         LIMIT 100`,
      );
      return result.rows;
    },
  );
};
