/**
 * CLI: straddle reconstruction over a date range.
 *
 * Usage:
 *   bun run scripts/reconstruct.ts --underlying NIFTY --from 2026-05-27T03:45:00Z --to 2026-05-27T10:00:00Z [--cadenceMs 15000] [--dryRun]
 *
 * Reads market_ticks (index) + option_ticks (CE/PE legs) for the underlying
 * and writes straddle_snapshots at the given cadence. Per the reconstructor's
 * contract: every input is at-or-before the step timestamp (no lookahead);
 * a missing CE or PE leg is recorded as a gap and the run continues.
 *
 * --dryRun computes snapshots in-memory without writing to straddle_snapshots.
 */

import pg from 'pg';

import type { Underlying } from '../src/ingestion/brokers/instrument-registry';
import { reconstructStraddle } from '../src/ingestion/historical/reconstruct-straddle';

function arg(name: string, fallback?: string): string {
  const flag = `--${name}`;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === flag) return process.argv[i + 1] ?? '';
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required arg: ${flag}`);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const underlying = arg('underlying').toUpperCase() as Underlying;
  if (!['NIFTY', 'SENSEX', 'BANKNIFTY'].includes(underlying)) {
    throw new Error(`Unknown --underlying: ${underlying}`);
  }
  const from = new Date(arg('from'));
  const to = new Date(arg('to'));
  const cadenceMs = Number.parseInt(arg('cadenceMs', '15000'), 10);
  const persist = !hasFlag('dryRun');

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Invalid --from / --to (use ISO 8601, e.g. 2026-05-27T03:45:00Z)');
  }

  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const t0 = Date.now();
    const r = await reconstructStraddle(db, {
      underlying,
      from,
      to,
      cadenceMs,
      persist,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log('\n=== reconstruct summary ===');
    console.log(`elapsed:           ${elapsed}s`);
    console.log(`cadence:           ${cadenceMs / 1000}s`);
    console.log(`steps attempted:   ${r.stepsAttempted}`);
    console.log(
      `snapshots written: ${r.snapshotsWritten}${persist ? '' : ' (dry-run, not persisted)'}`,
    );
    console.log(`gaps recorded:     ${r.gaps.length}`);
    if (r.gaps.length > 0) {
      console.log('\nFirst 5 gaps:');
      for (const g of r.gaps.slice(0, 5)) {
        console.log(
          `  ${g.stepTime.toISOString()}  missing=${g.missingSymbol}  ${g.reason.slice(0, 60)}`,
        );
      }
    }
  } finally {
    await db.end();
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error('Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
