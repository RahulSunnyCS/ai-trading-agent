/**
 * One description of a Momentum config, shared by every place that summarises a run in words:
 * the "What this run tests" strip, the collapsed settings summary, the result's assumption
 * chips and the Rebalance preview. Kept in one helper so those summaries cannot disagree.
 *
 * Broad Momentum ignores the generic `top_n` / `exit_rank` (the form still carries them); its
 * selection comes from the `broad_*` keys, which differ by category mode.
 */

export interface MomentumConfigDescription {
  /** "2017-01-06 → 2026-09-25" */
  period: string;
  /** Lower-case cadence for a sentence: "weekly", "every 2 weeks", "monthly". */
  cadence: string;
  /** Standalone chip: "Weekly rebalance", "Every 2 weeks (phase 1)", "Monthly rebalance". */
  cadenceChip: string;
  /** "top 5, exit after rank 10" */
  selection: string;
  /** Compact form for a one-line summary: "top 5 / exit >10". */
  selectionShort: string;
  /** Benchmark name, or an em dash when none is set. */
  benchmark: string;
}

const EMPTY = '—';

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function count(value: unknown): string {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n)
    ? String(n)
    : EMPTY;
}

export function describeConfig(
  config: Record<string, unknown>,
  dataset: string,
): MomentumConfigDescription {
  const every = Number(config.rebalance_every ?? 1);
  const monthly = config.rebalance === 'monthly';
  const everyN = !monthly && Number.isFinite(every) && every > 1;
  const cadence = monthly ? 'monthly' : everyN ? `every ${every} weeks` : 'weekly';
  const cadenceChip = monthly
    ? 'Monthly rebalance'
    : everyN
      ? `Every ${every} weeks (phase ${Number(config.rebalance_offset ?? 0) + 1})`
      : 'Weekly rebalance';

  let selection: string;
  let selectionShort: string;
  if (dataset === 'broad' && config.broad_category_mode !== 'off') {
    const held = count(config.broad_category_top_n);
    const picks = count(config.broad_picks_per_category);
    const exit = count(config.broad_category_exit_rank);
    selection = `top ${held} categories × ${picks} stocks each, sell a category after rank ${exit}`;
    selectionShort = `top ${held} categories × ${picks} / exit >${exit}`;
  } else if (dataset === 'broad') {
    const held = count(config.broad_off_top_n);
    const exit = count(config.broad_off_exit_rank);
    selection = `top ${held} stocks, exit after rank ${exit}`;
    selectionShort = `top ${held} stocks / exit >${exit}`;
  } else {
    const held = count(config.top_n);
    const exit = count(config.exit_rank);
    selection = `top ${held}, exit after rank ${exit}`;
    selectionShort = `top ${held} / exit >${exit}`;
  }

  return {
    period: `${text(config.start, 'Start')} → ${text(config.end, 'latest')}`,
    cadence,
    cadenceChip,
    selection,
    selectionShort,
    benchmark: text(config.benchmark, EMPTY),
  };
}
