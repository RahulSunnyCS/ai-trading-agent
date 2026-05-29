/**
 * BackfillView — backfill job history from GET /api/backfill.
 *
 * Status → tone: complete → positive · running → info · partial/gapped → warning ·
 * error → negative · else neutral.
 */

import { RefreshCw } from 'lucide-react';

import { useBackfillStatus } from '../hooks/useBackfillStatus.js';
import type { BackfillRangeRow } from '../types/trading.js';
import { Badge, type Tone } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';

function statusTone(status: string): Tone {
  switch (status) {
    case 'complete':
      return 'positive';
    case 'running':
      return 'info';
    case 'partial':
    case 'gapped':
      return 'warning';
    case 'error':
      return 'negative';
    default:
      return 'neutral';
  }
}

const dateFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function DateRangeCell({ from, to }: { from: string; to: string }) {
  return (
    <span className="tabular-nums text-foreground">
      {dateFmt.format(new Date(from))} → {dateFmt.format(new Date(to))}
    </span>
  );
}

function BackfillTable({ ranges }: { ranges: BackfillRangeRow[] }) {
  return (
    <Table>
      <THead>
        <Th>Symbol</Th>
        <Th>Date Range</Th>
        <Th>Resolution</Th>
        <Th>Status</Th>
        <Th align="right">Rows Written</Th>
        <Th align="right">Gaps</Th>
      </THead>
      <tbody>
        {ranges.map((row) => (
          <TRow key={row.id}>
            <Td className="font-medium text-foreground">{row.symbol}</Td>
            <Td>
              <DateRangeCell from={row.from_ts} to={row.to_ts} />
            </Td>
            <Td className="text-muted">{row.resolution}</Td>
            <Td>
              <Badge tone={statusTone(row.status)} dot>
                {row.status}
              </Badge>
            </Td>
            <Td numeric align="right" className="text-foreground">
              {row.rows_written.toLocaleString('en-IN')}
            </Td>
            <Td numeric align="right">
              {row.gaps_detected > 0 ? (
                <span className="font-medium text-warning">{row.gaps_detected}</span>
              ) : (
                <span className="text-faint">0</span>
              )}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

export function BackfillView() {
  const { ranges, loading, error, refresh } = useBackfillStatus();
  const hasData = ranges.length > 0;

  return (
    <Card flush>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Backfill Status
          </h2>
          <p className="mt-0.5 text-sm text-muted">Historical tick-data ingestion coverage</p>
        </div>
        <Button size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="px-2 py-1">
        {loading && !hasData && <SkeletonRows rows={4} className="px-1 pt-2" />}
        {error !== null && (
          <StateMessage
            variant="error"
            title="Couldn't load backfill status — retrying…"
            description={error}
            className="m-3"
          />
        )}
        {!loading && error === null && !hasData && (
          <StateMessage
            variant="empty"
            title="No backfill jobs yet"
            description="Backfill ranges appear once the historical data ingestion pipeline has run."
          />
        )}
        {hasData && <BackfillTable ranges={ranges} />}
      </div>
    </Card>
  );
}
