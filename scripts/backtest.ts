/**
 * Backtest CLI — bun run backtest
 *
 * Usage:
 *   bun run scripts/backtest.ts --from 2024-01-01 --to 2024-12-31 --underlying NIFTY \
 *     [--holdout-days 20] [--train-fraction 0.7] [--json]
 *
 * Options:
 *   --from <YYYY-MM-DD>       Start date inclusive (required)
 *   --to   <YYYY-MM-DD>       End date inclusive (required)
 *   --underlying <name>       NIFTY | BANKNIFTY | SENSEX (required)
 *   --holdout-days <n>        Last N calendar days reserved as holdout (default: 20)
 *   --train-fraction <0..1>   Fraction of non-holdout days used for training (default: 0.7)
 *   --json                    Print ExperimentCard JSON instead of formatted report
 *
 * Environment:
 *   DATABASE_URL  PostgreSQL connection string (required)
 *
 * Exit codes:
 *   0  — backtest completed successfully
 *   1  — fatal error (misconfiguration, DB unreachable, invalid args, etc.)
 *
 * Security notes:
 *   - DATABASE_URL is read from environment only — never from CLI args.
 *   - All SQL queries in the backtest runner are parameterised.
 *   - No results are written to the database.
 */

import pg from 'pg';
import { createBacktestRunner } from '../src/backtesting/backtest-runner.js';
import { formatReport, generateReport } from '../src/backtesting/backtest-report.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  fromDate: string;
  toDate: string;
  underlying: string;
  holdoutDays: number;
  trainFraction: number;
  json: boolean;
} {
  const args = argv.slice(2); // drop 'bun' and script path
  let fromDate = '';
  let toDate = '';
  let underlying = '';
  let holdoutDays = 20;
  let trainFraction = 0.7;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from') {
      fromDate = args[++i] ?? '';
    } else if (arg === '--to') {
      toDate = args[++i] ?? '';
    } else if (arg === '--underlying') {
      underlying = args[++i] ?? '';
    } else if (arg === '--holdout-days') {
      holdoutDays = Number(args[++i]);
    } else if (arg === '--train-fraction') {
      trainFraction = Number(args[++i]);
    } else if (arg === '--json') {
      json = true;
    }
  }

  return { fromDate, toDate, underlying, holdoutDays, trainFraction, json };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateDate(d: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`${name} must be in YYYY-MM-DD format, got: "${d}"`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { fromDate, toDate, underlying, holdoutDays, trainFraction, json } = parseArgs(
    process.argv,
  );

  // Validate required args
  if (!fromDate || !toDate || !underlying) {
    console.error('Usage: bun run scripts/backtest.ts --from YYYY-MM-DD --to YYYY-MM-DD --underlying NIFTY [--holdout-days 20] [--train-fraction 0.7] [--json]');
    process.exit(1);
  }

  validateDate(fromDate, '--from');
  validateDate(toDate, '--to');

  if (!['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(underlying)) {
    console.error(`--underlying must be one of NIFTY, BANKNIFTY, SENSEX (got: ${underlying})`);
    process.exit(1);
  }

  if (!Number.isFinite(holdoutDays) || holdoutDays < 0) {
    console.error('--holdout-days must be a non-negative integer');
    process.exit(1);
  }

  if (!Number.isFinite(trainFraction) || trainFraction <= 0 || trainFraction >= 1) {
    console.error('--train-fraction must be a number in (0, 1)');
    process.exit(1);
  }

  // Read DATABASE_URL from environment only — never from CLI args
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    const runner = createBacktestRunner(pool);
    const result = await runner.run({
      underlying,
      fromDate,
      toDate,
      holdoutDays,
      trainFraction,
    });

    const card = generateReport(result);

    if (json) {
      console.log(JSON.stringify(card, null, 2));
    } else {
      console.log(formatReport(card));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Backtest failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
