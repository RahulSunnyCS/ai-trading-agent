import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The CSVs are NOT duplicated here. They live inside the Python package
 * because uv ships them as package data in the wheel — moving them would
 * break a standalone install of option-backtesting.
 *
 * So this reads the one copy. A second copy is exactly the drift this package
 * exists to stop: apps/server hard-coded NIFTY's lot size at 50 while these
 * CSVs said 65, and every paper P&L was 30% out for months because nothing
 * compared them.
 */
const REFERENCE_DIR = join(
  import.meta.dirname,
  '../../option-backtesting/src/option_backtesting/data/reference',
);

export type Underlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';

interface DatedRow {
  underlying: string;
  value: number;
  effectiveDate: Date;
}

function parseCsv(file: string, valueColumn: string): DatedRow[] {
  const text = readFileSync(join(REFERENCE_DIR, file), 'utf8').trim();
  const [header, ...rows] = text.split('\n');
  const cols = (header ?? '').split(',').map((c) => c.trim());
  const iU = cols.indexOf('underlying');
  const iV = cols.indexOf(valueColumn);
  const iD = cols.indexOf('effective_date');
  if (iU < 0 || iV < 0 || iD < 0) {
    throw new Error(`${file} is missing one of underlying/${valueColumn}/effective_date`);
  }
  return rows.map((line) => {
    const cells = line.split(',');
    return {
      underlying: (cells[iU] ?? '').trim(),
      value: Number(cells[iV]),
      effectiveDate: new Date(`${(cells[iD] ?? '').trim()}T00:00:00Z`),
    };
  });
}

let lotSizeRows: DatedRow[] | null = null;
let strikeStepRows: DatedRow[] | null = null;

/**
 * Latest row effective on or before `asOf`. Throws rather than falling back to
 * a wrong-era value — the same "never silently guess" rule the Python loader
 * uses, and for the same reason: a missing row is a data gap to fix, not
 * something to paper over with today's number.
 */
function mostRecentAsOf(rows: DatedRow[], underlying: string, asOf: Date, label: string): number {
  const candidates = rows.filter(
    (r) => r.underlying === underlying && r.effectiveDate.getTime() <= asOf.getTime(),
  );
  if (candidates.length === 0) {
    const day = asOf.toISOString().slice(0, 10);
    throw new Error(
      `No ${label} row for ${underlying} effective on or before ${day}. Add one to packages/option-backtesting/src/option_backtesting/data/reference/ rather than guessing.`,
    );
  }
  return candidates.reduce((a, b) => (a.effectiveDate > b.effectiveDate ? a : b)).value;
}

/** Contract lot size in force on `asOf`. NIFTY is 65 as of 2026-01-01, not 50. */
export function lotSize(underlying: Underlying, asOf: Date = new Date()): number {
  lotSizeRows ??= parseCsv('lot_sizes.csv', 'lot_size');
  return mostRecentAsOf(lotSizeRows, underlying, asOf, 'lot_sizes');
}

/** ATM strike interval in force on `asOf`. */
export function strikeStep(underlying: Underlying, asOf: Date = new Date()): number {
  strikeStepRows ??= parseCsv('strike_step.csv', 'step');
  return mostRecentAsOf(strikeStepRows, underlying, asOf, 'strike_step');
}
