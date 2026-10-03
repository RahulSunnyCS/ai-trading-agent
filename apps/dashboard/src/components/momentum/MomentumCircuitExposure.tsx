'use client';

import type {
  MomentumCircuitEpisode,
  MomentumCircuitEscaped,
  MomentumCircuitExposure,
  MomentumCircuitTrapped,
} from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { ResultSection } from './ResultSection';

function signed(value: number, digits = 1): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function tone(value: number): string {
  return value < 0 ? 'tabular-nums text-negative' : 'tabular-nums text-positive';
}

function Empty({ children }: { children: string }) {
  return <p className="text-xs text-muted">{children}</p>;
}

function ExitBadge({ row }: { row: MomentumCircuitTrapped }) {
  if (row.exit === 'still_held') return <Badge tone="negative">still held at the end</Badge>;
  if (row.exit === 'sold_during') {
    return <Badge tone="negative">sold on a locked day (not possible live)</Badge>;
  }
  return <Badge tone="warning">sold {row.exit_date}, after the lock</Badge>;
}

function TrappedTable({ rows }: { rows: MomentumCircuitTrapped[] }) {
  if (rows.length === 0)
    return <Empty>The strategy was never holding a stock when it locked.</Empty>;
  return (
    <Table>
      <THead>
        <Th>Stock</Th>
        <Th>Lock</Th>
        <Th align="right">Sessions</Th>
        <Th align="right">Fall in lock</Th>
        <Th align="right">Fall until it sold</Th>
        <Th align="right">Position</Th>
        <Th align="right">Effect on portfolio</Th>
        <Th>What the strategy did</Th>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TRow key={`${row.symbol}-${row.start}`}>
            <Td className="font-medium text-foreground">{row.symbol}</Td>
            <Td className="whitespace-nowrap text-muted">
              {row.start} → {row.end}
            </Td>
            <Td align="right" className="tabular-nums">
              {row.days}
              <span className="ml-1 text-xs text-faint">({row.band_pct}% band)</span>
            </Td>
            <Td align="right" className={tone(row.move_pct)}>
              {signed(row.move_pct)}
            </Td>
            <Td align="right" className={tone(row.realised_move_pct)}>
              {signed(row.realised_move_pct)}
            </Td>
            <Td align="right" className="tabular-nums">
              {row.portfolio_share_pct.toFixed(1)}%
            </Td>
            <Td align="right" className={tone(row.portfolio_impact_pct)}>
              {signed(row.portfolio_impact_pct, 2)}
            </Td>
            <Td>
              <ExitBadge row={row} />
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

function EscapedTable({ rows }: { rows: MomentumCircuitEscaped[] }) {
  if (rows.length === 0) {
    return <Empty>No lower circuit hit a stock the strategy had just sold.</Empty>;
  }
  return (
    <Table>
      <THead>
        <Th>Stock</Th>
        <Th>Lock</Th>
        <Th align="right">Sessions</Th>
        <Th align="right">Fall in lock</Th>
        <Th>Strategy sold</Th>
        <Th align="right">Position it sold</Th>
        <Th align="right">Loss avoided</Th>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TRow key={`${row.symbol}-${row.start}`}>
            <Td className="font-medium text-foreground">{row.symbol}</Td>
            <Td className="whitespace-nowrap text-muted">
              {row.start} → {row.end}
            </Td>
            <Td align="right" className="tabular-nums">
              {row.days}
              <span className="ml-1 text-xs text-faint">({row.band_pct}% band)</span>
            </Td>
            <Td align="right" className={tone(row.move_pct)}>
              {signed(row.move_pct)}
            </Td>
            <Td className="whitespace-nowrap text-muted">
              {row.exit_date} ({row.days_before} days before)
            </Td>
            <Td align="right" className="tabular-nums">
              {row.portfolio_share_pct.toFixed(1)}%
            </Td>
            <Td align="right" className={tone(row.avoided_impact_pct)}>
              {signed(row.avoided_impact_pct, 2)}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

function UpperTable({ rows }: { rows: MomentumCircuitEpisode[] }) {
  if (rows.length === 0) return <Empty>No upper-circuit run hit a stock this backtest held.</Empty>;
  return (
    <Table>
      <THead>
        <Th>Stock</Th>
        <Th>Lock</Th>
        <Th align="right">Sessions</Th>
        <Th align="right">Rise</Th>
        <Th align="right">Position</Th>
        <Th align="right">Effect on portfolio</Th>
        <Th>Notes</Th>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TRow key={`${row.symbol}-${row.start}`}>
            <Td className="font-medium text-foreground">{row.symbol}</Td>
            <Td className="whitespace-nowrap text-muted">
              {row.start} → {row.end}
            </Td>
            <Td align="right" className="tabular-nums">
              {row.days}
              <span className="ml-1 text-xs text-faint">({row.band_pct}% band)</span>
            </Td>
            <Td align="right" className={tone(row.move_pct)}>
              {signed(row.move_pct)}
            </Td>
            <Td align="right" className="tabular-nums">
              {row.portfolio_share_pct.toFixed(1)}%
            </Td>
            <Td align="right" className={tone(row.portfolio_impact_pct)}>
              {signed(row.portfolio_impact_pct, 2)}
            </Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {row.blocked_entry ? <Badge tone="warning">bought on a locked day</Badge> : null}
                {row.times_held > 1 ? <Badge>held {row.times_held} times</Badge> : null}
              </div>
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The worst lower/upper-circuit runs among the stocks this backtest held, and whether the strategy
 * was already out of a stock before it locked down. Display only: it never changes what the
 * backtest bought, so it also shows what an unfiltered run walked into.
 */
export function MomentumCircuitExposureCard({
  exposure,
}: {
  exposure: MomentumCircuitExposure | null | undefined;
}) {
  if (!exposure) return null;
  const near = exposure.lc_trapped_count + exposure.lc_escaped_count;
  const escapePct = near > 0 ? Math.round((exposure.lc_escaped_count / near) * 100) : null;
  return (
    <Card>
      <CardHeader
        title="Worst circuit situations in this backtest"
        description="Stocks the backtest held that closed at a price-band edge for several sessions in a row. Measured after the fact; it does not change the results above."
      />
      <div className="space-y-6">
        <div className="space-y-1.5 text-xs leading-relaxed text-muted">
          <p>
            {exposure.touched.toLocaleString('en-IN')} of{' '}
            {exposure.positions.toLocaleString('en-IN')} holdings met at least one band-edge close.
          </p>
          <p>
            {near > 0 ? (
              <>
                Of {near.toLocaleString('en-IN')} lower-circuit locks (2+ sessions) on stocks it
                held or had sold in the prior 8 weeks, the strategy was{' '}
                <span className="font-medium text-foreground">
                  already out before {exposure.lc_escaped_count.toLocaleString('en-IN')} (
                  {escapePct}
                  %)
                </span>{' '}
                and{' '}
                <span className="font-medium text-foreground">
                  still holding in {exposure.lc_trapped_count.toLocaleString('en-IN')}
                </span>
                {exposure.lc_trapped_sold_during > 0
                  ? `, ${exposure.lc_trapped_sold_during.toLocaleString('en-IN')} of which it sold in the middle of the lock, a fill a live run could not have got`
                  : ''}
                .
              </>
            ) : (
              'No lower-circuit lock hit a stock it held.'
            )}
          </p>
        </div>
        <ResultSection
          padded={false}
          title="Lower circuit: still holding when it locked"
          description="Longest locks first. Effect = your position size × the fall until the strategy sold."
        >
          <TrappedTable rows={exposure.lc} />
        </ResultSection>
        <ResultSection
          padded={false}
          title="Lower circuit: already out before it locked"
          description="The strategy sold these up to 8 weeks before the lock began. Biggest losses avoided first."
        >
          <EscapedTable rows={exposure.lc_escaped} />
        </ResultSection>
        <ResultSection
          padded={false}
          title="Upper circuit (a stock you could not buy)"
          description="Longest runs first. A rise like this is real only if you were already in before the lock."
        >
          <UpperTable rows={exposure.uc} />
        </ResultSection>
        <p className="text-[11px] text-faint">
          Circuits are inferred from closes at a 2%, 5%, 10% or 20% move from the previous close, in
          the same direction on consecutive sessions; the daily bars carry no band data.
        </p>
      </div>
    </Card>
  );
}
