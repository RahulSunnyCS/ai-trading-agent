import { Sparkles } from 'lucide-react';

import { EMPTY, formatDay, formatPct, formatPp } from '../../lib/format';
import type { MomentumResult } from '../../types/momentum';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fmtDate(value: unknown): string {
  return typeof value === 'string' ? formatDay(value) : EMPTY;
}

/**
 * A 5-second, plain-English takeaway computed entirely client-side from data
 * the backend already returns (kpis + yearly) — no new API surface. Mirrors
 * the kind of summary the legacy UI's KPI cards implied but never stated as
 * a single sentence.
 */
export function MomentumInsights({ result }: { result: MomentumResult }) {
  const k = result.kpis;
  const benchmarkName = result.benchmark_name;
  const yearsBeating = num(k.years_beating_benchmark);
  const years = num(k.years);
  const excessCagr = num(k.excess_cagr);
  const maxDrawdown = num(k.max_drawdown);
  const drawdownTrough = k.max_drawdown_trough;
  const winRate = num(k.win_rate);

  const yearlyRows = result.yearly as Array<{
    year: unknown;
    vs_benchmark: unknown;
    strategy: unknown;
  }>;
  let bestYear: { year: unknown; vs: number } | null = null;
  let worstYear: { year: unknown; vs: number } | null = null;
  for (const row of yearlyRows) {
    const vs = num(row.vs_benchmark);
    if (vs === null) continue;
    if (!bestYear || vs > bestYear.vs) bestYear = { year: row.year, vs };
    if (!worstYear || vs < worstYear.vs) worstYear = { year: row.year, vs };
  }

  const sentences: string[] = [];
  if (excessCagr !== null) {
    sentences.push(
      excessCagr >= 0
        ? `Beat ${benchmarkName} by ${formatPp(excessCagr, 1, { sign: false })} a year`
        : `Trailed ${benchmarkName} by ${formatPp(Math.abs(excessCagr), 1, { sign: false })} a year`,
    );
  }
  if (yearsBeating !== null && years !== null) {
    sentences.push(`ahead of it in ${yearsBeating} of ${years} calendar years`);
  }
  if (bestYear && worstYear && bestYear.year !== worstYear.year) {
    sentences.push(
      `best relative year ${bestYear.year} (${formatPct(bestYear.vs, 0, { sign: true })} vs benchmark), worst ${worstYear.year} (${formatPct(worstYear.vs, 0, { sign: true })})`,
    );
  }
  if (maxDrawdown !== null) {
    sentences.push(`deepest fall ${formatPct(maxDrawdown)}, bottoming ${fmtDate(drawdownTrough)}`);
  }
  if (winRate !== null) {
    sentences.push(`${formatPct(winRate, 0)} of closed trades were profitable`);
  }

  if (sentences.length === 0) return null;

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-gradient-to-r from-primary/10 to-transparent px-3 py-2.5">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <p className="text-sm leading-relaxed text-foreground">
        {sentences.map((sentence, index) => (
          <span key={sentence}>
            {index === 0 ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : sentence}
            {index < sentences.length - 1 ? ' · ' : '.'}
          </span>
        ))}
      </p>
    </div>
  );
}
