import { Sparkles } from 'lucide-react';

import type { MomentumResult } from '../../types/momentum';
import { Card } from '../ui/Card';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function fmtDate(value: unknown): string {
  return typeof value === 'string' ? value : '—';
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
        ? `Beat ${benchmarkName} by ${pct(excessCagr)} a year`
        : `Trailed ${benchmarkName} by ${pct(Math.abs(excessCagr))} a year`,
    );
  }
  if (yearsBeating !== null && years !== null) {
    sentences.push(`ahead of it in ${yearsBeating} of ${years} calendar years`);
  }
  if (bestYear && worstYear && bestYear.year !== worstYear.year) {
    sentences.push(
      `best relative year ${bestYear.year} (${bestYear.vs >= 0 ? '+' : ''}${pct(bestYear.vs, 0)} vs benchmark), worst ${worstYear.year} (${worstYear.vs >= 0 ? '+' : ''}${pct(worstYear.vs, 0)})`,
    );
  }
  if (maxDrawdown !== null) {
    sentences.push(`deepest fall ${pct(maxDrawdown)}, bottoming ${fmtDate(drawdownTrough)}`);
  }
  if (winRate !== null) {
    sentences.push(`${pct(winRate, 0)} of closed trades were profitable`);
  }

  if (sentences.length === 0) return null;

  return (
    <Card className="border-primary/25 bg-gradient-to-br from-primary/10 via-surface to-surface">
      <div className="flex items-start gap-2.5">
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
    </Card>
  );
}
