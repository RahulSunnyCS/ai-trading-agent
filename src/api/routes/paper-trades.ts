import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { Clock } from "../../utils/clock.js";

/**
 * Options injected when this plugin is registered.
 * clock is required for clock.today() — IST date string for the default date filter.
 */
export interface PaperTradesRoutesOptions {
  db: Pool;
  clock: Clock;
}

// ---------------------------------------------------------------------------
// JSON Schema: one paper trade row in the paginated response
// ---------------------------------------------------------------------------
// NUMERIC columns come back as strings from the pg driver (see schema.ts rationale).
// Nullable columns use the array form ["string", "null"] — standard JSON Schema.
const PAPER_TRADE_ITEM_SCHEMA = {
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

// ---------------------------------------------------------------------------
// JSON Schema: query parameters for GET /paper-trades
// ---------------------------------------------------------------------------
// Fastify validates these via AJV before the handler runs, so the handler
// can safely cast request.query without additional runtime guards.
//
// date is YYYY-MM-DD — AJV enforces the format via the pattern property.
// status defaults to 'all' when omitted.
const QUERY_STRING_SCHEMA = {
  type: "object",
  properties: {
    date: {
      type: "string",
      // Strict date pattern prevents SQL injection through the date parameter.
      // Even though it is used in a parameterised query ($1), validating the
      // format at the HTTP layer gives a clear 400 with a useful error message
      // rather than a pg parse error with a confusing stack trace.
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    },
    status: {
      type: "string",
      enum: ["open", "closed", "all"],
    },
    page: {
      type: "integer",
      minimum: 1,
      default: 1,
    },
  },
  // No required fields — all have defaults (date → clock.today(), status → 'all', page → 1).
  additionalProperties: false,
} as const;

/**
 * Fastify plugin for the paginated paper-trades REST endpoint.
 *
 * Read-only (GET only) — write operations are performed by the trading engine
 * directly against the database.
 *
 * Pagination cap: max 100 rows per page. This prevents full-hypertable-scan
 * style queries even on large date ranges. Callers paginate by incrementing ?page.
 */
export const paperTradesRoutes: FastifyPluginAsync<PaperTradesRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: PaperTradesRoutesOptions,
): Promise<void> => {
  // -------------------------------------------------------------------------
  // GET /paper-trades
  // -------------------------------------------------------------------------
  // Accepts optional ?date (YYYY-MM-DD, defaults to today IST) and
  // ?status ('open'|'closed'|'all', defaults to 'all').
  //
  // All date comparisons use AT TIME ZONE 'Asia/Kolkata' so the date boundary
  // is midnight IST, matching clock.today() and the trading day definition.
  //
  // Parameterised queries everywhere — $1, $2 etc — even for the status enum
  // which is already validated by AJV, because parameterised queries are the
  // safe default (General Rule 4 equivalent for DB access).
  fastify.get(
    "/paper-trades",
    {
      schema: {
        querystring: QUERY_STRING_SCHEMA,
        response: {
          200: {
            type: "array",
            items: PAPER_TRADE_ITEM_SCHEMA,
          },
        },
      },
    },
    async (request, _reply) => {
      // AJV has already validated and defaulted the query params.
      const query = request.query as {
        date?: string;
        status?: string;
        page?: number;
      };

      const date = query.date ?? opts.clock.today();
      // 'all' → no status filter; 'open'/'closed' → equality filter.
      const status = query.status ?? "all";
      // page is 1-based; convert to 0-based offset for SQL.
      const page = (query.page ?? 1) as number;
      const pageSize = 100; // max rows per page — prevents hypertable full scans
      const offset = (page - 1) * pageSize;

      // Build the WHERE clause programmatically.
      // The date filter is always present (required by the hypertable scan rule).
      // Status filter is appended only when status !== 'all'.
      //
      // We accumulate parameterised values in an array rather than conditionally
      // building a string with interpolated user values — even though AJV validates
      // the status enum, keeping all WHERE values parameterised is the safe default.
      const params: (string | number)[] = [date];
      let statusClause = "";
      if (status !== "all") {
        params.push(status);
        statusClause = `AND status = $${params.length}`;
      }

      // Add pagination params after status so parameter numbering is consistent.
      params.push(pageSize, offset);
      const limitClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;

      const sql = `
        SELECT *
        FROM paper_trades
        WHERE DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $1
          ${statusClause}
        ORDER BY entry_time ASC
        ${limitClause}
      `;

      const result = await opts.db.query<Record<string, unknown>>(sql, params);
      return result.rows;
    },
  );
};
