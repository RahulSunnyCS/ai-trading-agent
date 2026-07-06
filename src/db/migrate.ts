import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

// ---------------------------------------------------------------------------
// Connection with retry
// ---------------------------------------------------------------------------

/**
 * Attempt to connect to PostgreSQL with exponential back-off.
 *
 * Retry is necessary in Docker Compose environments where the app container
 * can start before PostgreSQL finishes its own initialisation. Three retries
 * with 2s / 4s / 8s waits match the typical pg startup window without
 * blocking the terminal for too long.
 */
async function connectWithRetry(connectionString: string): Promise<pg.PoolClient> {
  const retryDelaysMs = [2000, 4000, 8000] as const;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      // Use a one-off Pool just for the migration run so we can close it
      // cleanly after migrations complete without touching the shared pool
      // in client.ts (which may not have been imported yet).
      const pool = new pg.Pool({ connectionString, max: 1 });
      const client = await pool.connect();
      // Attach the pool to the client so we can end it after migration
      (client as pg.PoolClient & { _pool: pg.Pool })._pool = pool;
      return client;
    } catch (err) {
      lastError = err;
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        // All retries exhausted
        break;
      }
      console.error(
        `Migration: connection attempt ${attempt + 1} failed. Retrying in ${delay / 1000}s…`,
        err,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.error('Migration: could not connect to PostgreSQL after 3 retries.');
  throw lastError;
}

// ---------------------------------------------------------------------------
// Main migration runner
// ---------------------------------------------------------------------------

/**
 * Runs all pending SQL migration files from src/db/migrations/ in ascending
 * lexicographic order (001_..., 002_..., etc.) against the database pointed
 * to by DATABASE_URL.
 *
 * Design decisions:
 * - Idempotent: schema_migrations tracks applied filenames; re-running is safe.
 * - Each migration runs inside its own BEGIN/COMMIT so a failure in migration N
 *   does not roll back migrations 1..N-1 (already committed and recorded).
 *   This matches the industry-standard "one transaction per migration file"
 *   approach rather than "one giant transaction" which cannot handle DDL in
 *   some databases.
 * - TimescaleDB presence is validated before any migration runs, because every
 *   hypertable creation will fail without it and the error message from
 *   PostgreSQL is confusing. A clear process.exit(1) with a helpful message is
 *   less surprising than a mid-migration DDL error.
 */
export async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  const client = (await connectWithRetry(connectionString)) as pg.PoolClient & {
    _pool: pg.Pool;
  };

  try {
    // ------------------------------------------------------------------
    // 1. TimescaleDB extension check
    // ------------------------------------------------------------------
    // This must run before CREATE TABLE because the migration files will
    // attempt to create hypertables, which require the extension.
    const tsdbResult = await client.query<{ installed_version: string }>(
      `SELECT extversion AS installed_version FROM pg_extension WHERE extname = 'timescaledb'`,
    );

    if (tsdbResult.rows.length === 0) {
      console.error(
        'ERROR: TimescaleDB extension not found. ' +
          'Use image timescale/timescaledb:latest-pg16, not postgres:16-alpine.',
      );
      process.exit(1);
    }

    const tsdbVersion = tsdbResult.rows[0]?.installed_version ?? '(unknown)';
    console.log(`Migration: TimescaleDB ${tsdbVersion} detected.`);

    // ------------------------------------------------------------------
    // 2. Create tracking table if absent
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          SERIAL      PRIMARY KEY,
        filename    TEXT        UNIQUE NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ------------------------------------------------------------------
    // 3. Load already-applied filenames into a Set for O(1) lookup
    // ------------------------------------------------------------------
    const appliedResult = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    const applied = new Set(appliedResult.rows.map((r) => r.filename));

    // ------------------------------------------------------------------
    // 4. Discover migration files
    // ------------------------------------------------------------------
    // Resolve relative to the repository root (process.cwd()) so this works
    // whether invoked via `bun run migrate` from root or directly.
    const migrationsDir = join(process.cwd(), 'src', 'db', 'migrations');
    let files: string[];
    try {
      files = await readdir(migrationsDir);
    } catch {
      console.log('Migration: migrations directory not found or empty — nothing to apply.');
      return;
    }

    // Filter to .sql files only (ignore .gitkeep and other artefacts) and sort
    // ascending. Lexicographic order matches numeric order when filenames use
    // zero-padded numbers (001_, 002_, …).
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

    if (sqlFiles.length === 0) {
      console.log('Migration: no SQL files found in migrations/ — nothing to apply.');
      return;
    }

    // ------------------------------------------------------------------
    // 5. Apply pending migrations
    // ------------------------------------------------------------------
    for (const filename of sqlFiles) {
      if (applied.has(filename)) {
        console.log(`Migration: skipping ${filename} (already applied)`);
        continue;
      }

      console.log(`Migration: applying ${filename}…`);
      const filePath = join(migrationsDir, filename);
      const sql = await readFile(filePath, 'utf8');

      // Each migration runs in its own transaction so that a failure in
      // migration N+1 does not roll back the DDL from migration N (TimescaleDB
      // hypertable creation is not transactional in all versions anyway).
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        console.log(`Migration: ${filename} applied successfully.`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          // Ignore ROLLBACK failures — the connection may be in an error state
        });
        console.error(`Migration: failed on ${filename}:`, err);
        throw err;
      }
    }

    console.log('Migration: all migrations applied successfully.');
  } finally {
    // Release the client and close the one-off pool regardless of success or
    // failure, so the process can exit cleanly without hanging on open sockets.
    client.release();
    await client._pool.end();
  }
}

// ---------------------------------------------------------------------------
// Direct invocation via `bun run src/db/migrate.ts`
// ---------------------------------------------------------------------------
// import.meta.main is Bun-specific; it is true only when this file is the
// entry point (not when it is imported as a module). This lets the function
// be imported in tests without triggering a migration run.
if (import.meta.main) {
  runMigrations().catch((err) => {
    console.error('Migration runner failed:', err);
    process.exit(1);
  });
}
