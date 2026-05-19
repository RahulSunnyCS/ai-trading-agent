import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from './client.ts';

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.log(`  DB connection attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

async function runMigrations(): Promise<void> {
  console.log('Running migrations...');

  await connectWithRetry();

  const client = await pool.connect();
  try {
    // Ensure schema_migrations table exists (idempotent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows: applied } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const appliedVersions = new Set(applied.map((r) => r.version));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let appliedCount = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (appliedVersions.has(version)) {
        console.log(`  skip   ${file}`);
        continue;
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`  apply  ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${String(err)}`);
      }
    }

    console.log(
      `Migrations complete — ${appliedCount} applied, ${appliedVersions.size} already applied.`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
