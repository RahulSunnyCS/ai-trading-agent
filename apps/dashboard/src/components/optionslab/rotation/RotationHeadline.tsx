/**
 * The headline strip: the five numbers that decide whether the focus list is good, each against
 * the benchmark the reader picked, with the gap as a badge (Analytics page pattern, rules 3-4).
 */

import { EMPTY, formatInr, formatInt, formatPct, formatPp } from '../../../lib/format';
import type { HeadlineFigure } from '../../../lib/rotationView';
import { InfoTooltip } from '../../ui/InfoTooltip';

const GAP_TONE = {
  positive: 'bg-positive/10 text-positive',
  negative: 'bg-negative/10 text-negative',
  default: 'bg-surface-2 text-muted',
} as const;

function show(value: number | null, unit: HeadlineFigure['unit']): string {
  if (value === null) return EMPTY;
  if (unit === 'inr') return formatInr(value, { compact: true });
  if (unit === 'pct') return formatPct(value, 0, { unit: 'percent' });
  return formatInt(value);
}

function gapText(f: HeadlineFigure): string | null {
  if (f.gap === null) return null;
  if (f.unit === 'inr') return formatInr(f.gap, { sign: true, compact: true });
  if (f.unit === 'pct') return formatPp(f.gap, 0, { unit: 'percent' });
  return null;
}

export function RotationHeadline({
  figures,
  benchmarkLabel,
}: { figures: HeadlineFigure[]; benchmarkLabel: string }) {
  if (figures.length === 0) return null;
  return (
    <section aria-label="Headline" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {figures.map((f) => {
        const gap = gapText(f);
        return (
          <div key={f.id} className="rounded-lg border border-border bg-surface px-4 py-3">
            <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-faint">
              {f.label}
              <InfoTooltip text={f.hint} label={`About ${f.label}`} />
            </div>
            <div
              className={`metric mt-1 text-xl font-semibold ${
                f.unit === 'inr' && f.value < 0 ? 'text-negative' : 'text-foreground'
              }`}
            >
              {show(f.value, f.unit)}
              {f.id === 'sessions' && f.benchmark !== null ? (
                <span className="text-sm font-normal text-faint"> / {f.benchmark}</span>
              ) : null}
            </div>
            {f.caption ? <p className="mt-0.5 text-[11px] text-faint">{f.caption}</p> : null}
            {f.id !== 'sessions' ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span>
                  {benchmarkLabel} <span className="font-mono">{show(f.benchmark, f.unit)}</span>
                </span>
                {gap ? (
                  <span className={`rounded px-1.5 py-0.5 font-mono ${GAP_TONE[f.tone]}`}>
                    {gap}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
