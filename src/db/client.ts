import pg, { type QueryResultRow } from "pg";

// Configure pg to return NUMERIC (OID 1700) columns as strings instead of JS
// floats. This is critical for financial data: a value like 21847.50 would
// silently become 21847.5 if pg coerces it to a JS number, and accumulated
// floating-point rounding errors in P&L calculations are unacceptable in a
// trading context. Callers use libraries like `decimal.js` or raw string
// arithmetic when they need precision math.
pg.types.setTypeParser(1700, (val) => val);

// Create the pool from DATABASE_URL. Pool settings are intentionally left at
// pg defaults (max 10 connections). If the env var is missing, pg will throw
// at first query — this is acceptable since there is no meaningful fallback.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Executes a parameterised SQL query and returns all rows typed as T[].
 *
 * Using a generic here means callers can write:
 *   const rows = await query<StraddleSnapshot>('SELECT * FROM ... WHERE time > $1', [since]);
 * without casting. The type is a caller promise — pg itself is untyped at the
 * wire level, so do not pass T for rows that do not actually match the shape.
 *
 * T is constrained to QueryResultRow (pg's own bound) so that pool.query<T>
 * compiles without error. In practice every DB row type is a plain object so
 * this constraint is always satisfied by callers.
 */
export async function query<T extends QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

/**
 * Like `query<T>` but returns only the first row, or null if the result set
 * is empty. Use this for lookups by primary key or unique constraint where you
 * know at most one row can match.
 */
export async function queryOne<T extends QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await pool.query<T>(sql, params);
  // result.rows[0] can be undefined when the set is empty; we normalise to null
  // to give callers a consistent sentinel rather than forcing them to check for
  // both undefined and null.
  return result.rows[0] ?? null;
}

/**
 * Wraps a callback in a BEGIN / COMMIT / ROLLBACK transaction.
 *
 * A dedicated PoolClient is checked out for the duration so all statements
 * share the same backend connection (required by PostgreSQL for transactions).
 * ROLLBACK is always attempted in the catch block; if it also fails we log the
 * secondary error but still rethrow the original — losing the original error
 * would make debugging impossible.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // Log the secondary failure but do not mask the original error
      console.error("ROLLBACK failed after transaction error:", rollbackErr);
    }
    throw err;
  } finally {
    // Always release the client back to the pool — even on success — to avoid
    // pool exhaustion under load.
    client.release();
  }
}
