/**
 * CLI: option-leg historical backfill.
 *
 * Usage:
 *   bun run scripts/backfill-legs.ts --underlying NIFTY --from 2026-03-30 --to 2026-05-29 [--resolution 1] [--bufferAbove 1] [--bufferBelow 1]
 *
 * Reads intraday index OHLC from market_ticks (Phase-2 backfill must have run)
 * and downloads every ATM CE/PE option leg needed for straddle reconstruction
 * and replay over the window.
 *
 * Why a CLI and not a route: legs are not in the user-facing API allowlist
 * (which is NIFTY/Sensex index-only by product decision) and a multi-minute
 * orchestrated job is a poor fit for an HTTP request.
 */

import pg from 'pg';

import type { FyersResolution } from '../src/ingestion/brokers/fyers-historical';
import type { Underlying } from '../src/ingestion/brokers/instrument-registry';
import { backfillOptionLegs } from '../src/ingestion/historical/backfill-option-legs';

interface CliArgs {
  underlying: Underlying;
  from: Date;
  to: Date;
  resolution: FyersResolution;
  bufferAbove: number;
  bufferBelow: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      args[key] = val;
      i += 1;
    }
  }

  const required = (k: string): string => {
    const v = args[k];
    if (!v) throw new Error(`Required: --${k}`);
    return v;
  };

  const underlying = required('underlying').toUpperCase() as Underlying;
  if (underlying !== 'NIFTY' && underlying !== 'SENSEX' && underlying !== 'BANKNIFTY') {
    throw new Error(`Unknown --underlying: ${underlying}`);
  }
  const from = new Date(`${required('from')}T00:00:00.000Z`);
  const to = new Date(`${required('to')}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Invalid --from / --to (use YYYY-MM-DD)');
  }
  const resolution = (args.resolution ?? '1') as FyersResolution;
  const bufferAbove = Number.parseInt(args.bufferAbove ?? '1', 10);
  const bufferBelow = Number.parseInt(args.bufferBelow ?? '1', 10);

  return { underlying, from, to, resolution, bufferAbove, bufferBelow };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const startMs = Date.now();
    const summary = await backfillOptionLegs(db, {
      underlying: args.underlying,
      from: args.from,
      to: args.to,
      resolution: args.resolution,
      bufferStrikesAbove: args.bufferAbove,
      bufferStrikesBelow: args.bufferBelow,
    });
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log('\n=== summary ===');
    console.log(`elapsed:      ${elapsed}s`);
    console.log(`legs:         ${summary.legsCompleted}/${summary.legsAttempted} completed`);
    console.log(`partial:      ${summary.legsPartial.length}`);
    console.log(`failed:       ${summary.legsFailed.length}`);
    console.log(`expiries:     ${summary.expiriesProcessed}`);
    console.log(`rows written: ${summary.totalRowsWritten}`);
    if (summary.legsFailed.length > 0) {
      console.log('\n=== first failed legs ===');
      for (const f of summary.legsFailed.slice(0, 5)) {
        console.log(`  ${f.symbol}  ${f.error.slice(0, 120)}`);
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
