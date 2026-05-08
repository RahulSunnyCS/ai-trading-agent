import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool, closePool } from './client';

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

const MIGRATIONS: Array<{ version: number; file: string; description: string }> = [
  { version: 1, file: '001_initial_schema.sql', description: 'Initial schema' },
];

async function getAppliedVersions(): Promise<Set<number>> {
  const pool = getPool();
  try {
    const result = await pool.query<{ version: number }>(
      `SELECT version FROM schema_migrations ORDER BY version`
    );
    return new Set(result.rows.map((r) => r.version));
  } catch {
    // Table doesn't exist yet — first run
    return new Set();
  }
}

async function runMigrations(): Promise<void> {
  const pool = getPool();
  console.log('[migrate] Connecting to database...');

  // Wait for DB to be ready
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt === 10) throw err;
      console.log(`[migrate] DB not ready, retrying (${attempt}/10)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const applied = await getAppliedVersions();
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    console.log('[migrate] All migrations already applied.');
    return;
  }

  for (const migration of pending) {
    console.log(`[migrate] Applying v${migration.version}: ${migration.description}`);
    const sql = readFileSync(join(MIGRATIONS_DIR, migration.file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`[migrate] ✓ v${migration.version} applied`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] ✗ v${migration.version} failed:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`[migrate] Done. ${pending.length} migration(s) applied.`);
}

// Run if invoked directly
if (import.meta.main) {
  await runMigrations();
  await closePool();
}

export { runMigrations };
