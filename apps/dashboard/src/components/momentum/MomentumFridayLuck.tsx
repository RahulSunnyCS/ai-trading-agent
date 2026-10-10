'use client';

import { useRunSection } from '../../hooks/useRunSection';
import { cn } from '../../lib/cn';
import { formatPct, formatPp } from '../../lib/format';
import { type FridayLuck, fridayLuck } from '../../lib/momentumFridays';
import type { MomentumFridaySpread } from '../../types/momentum';
import { Button } from '../ui/Button';
import { Shimmer } from '../ui/Skeleton';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

function gapTone(gap: number): string {
  if (Math.abs(gap) < 0.0005) return 'text-muted';
  return gap > 0 ? 'text-positive' : 'text-negative';
}

/** Each Friday's own result next to the account that holds all of them. */
export function MomentumFridayLuckBody({ spread }: { spread: MomentumFridaySpread }) {
  const luck: FridayLuck | null = fridayLuck(spread);
  if (!luck) return <p className="text-sm text-muted">No Friday figures for this run.</p>;
  const top = Math.max(...luck.rows.map((row) => row.cagr), 0.0001);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Trading on one Friday alone would have earned{' '}
        <span className="tabular-nums text-foreground">{formatPct(luck.worst.cagr)}</span> to{' '}
        <span className="tabular-nums text-foreground">{formatPct(luck.best.cagr)}</span> a year;
        the{' '}
        <span className="tabular-nums text-foreground">
          {formatPp(luck.spread, 1, { sign: false })}
        </span>{' '}
        gap is the calendar, not the rule. Holding all {spread.every} Fridays earned{' '}
        <span className="tabular-nums text-foreground">{formatPct(spread.blend.cagr)}</span>, with
        no Friday to pick.
      </p>
      <Table>
        <THead>
          <Th>Friday</Th>
          <Th align="right">CAGR</Th>
          <Th className="w-40">{null}</Th>
          <Th align="right">vs all Fridays</Th>
          <Th align="right">Max drawdown</Th>
          <Th align="right">Ulcer</Th>
        </THead>
        <tbody>
          {luck.rows.map((row) => {
            const whole = row.offset === null;
            return (
              <TRow key={row.label} className={cn(whole && 'bg-surface-2/40 font-medium')}>
                <Td className={cn('whitespace-nowrap', whole && 'text-foreground')}>{row.label}</Td>
                <Td align="right" className="tabular-nums">
                  {formatPct(row.cagr)}
                </Td>
                <Td>
                  <div className="h-1.5 w-full rounded-full bg-primary/10">
                    <div
                      className={cn('h-1.5 rounded-full', whole ? 'bg-primary' : 'bg-primary/50')}
                      style={{ width: `${Math.max(2, (row.cagr / top) * 100)}%` }}
                    />
                  </div>
                </Td>
                <Td align="right" className={cn('tabular-nums', gapTone(row.gap))}>
                  {whole ? '—' : formatPp(row.gap)}
                </Td>
                <Td align="right" className="tabular-nums">
                  {formatPct(row.maxDrawdown)}
                </Td>
                <Td align="right" className="tabular-nums">
                  {formatPct(row.ulcer)}
                </Td>
              </TRow>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

export function MomentumFridayLuckLoader({ runId }: { runId: string }) {
  const section = useRunSection(runId, 'friday_spread');
  if (section.error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span>Could not load this. {section.error}</span>
        <Button size="sm" onClick={section.retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (section.loading || section.data === undefined) {
    return (
      <output aria-busy="true" aria-label="Loading" className="block">
        <Shimmer className="h-32 w-full" />
      </output>
    );
  }
  if (section.data === null) {
    return <p className="text-sm text-muted">This run has no Friday figures.</p>;
  }
  return <MomentumFridayLuckBody spread={section.data} />;
}
