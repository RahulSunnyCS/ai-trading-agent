/**
 * BackfillView — two stacked sections:
 *  1. Trigger Backfill card — queue a new historical data fetch job
 *  2. Backfill Status table — history from GET /api/backfill
 *
 * Status (normalised by the API to three buckets): completed → positive ·
 * in_progress → info · failed → negative.
 */

import { Play } from 'lucide-react';
import { useState } from 'react';

import { useBackfillStatus } from '../hooks/useBackfillStatus';
import { apiPost } from '../lib/api';
import { formatInt, formatIstDate } from '../lib/format';
import type { BackfillRangeRow, BackfillStatus } from '../types/trading';
import { Badge, type Status } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Input, Select } from './ui/Input';
import { RefreshButton } from './ui/RefreshButton';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The API normalises every backfill row to one of three statuses.
const BACKFILL_STATUS: Record<BackfillStatus, Status> = {
  completed: 'completed',
  in_progress: 'running',
  failed: 'failed',
};

function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'in_progress':
      return 'In Progress';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

/**
 * Computes the default from/to date range for the trigger form.
 * Called once during useState initialisation — not inside render.
 * Avoids useMemo to keep it a plain synchronous helper.
 */
function defaultDateRange(): { from: string; to: string } {
  const today = new Date();
  const to = new Date(today);
  to.setDate(to.getDate() - 1);
  const from = new Date(today);
  from.setDate(from.getDate() - 7);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const LABEL_CLS = 'mb-1 block text-xs font-medium text-muted';

// Phase-1 scope: backfill is limited to NIFTY and Sensex. These values must
// match BACKFILL_SUPPORTED_SYMBOLS on the server (src/ingestion/brokers/types.ts)
// — the POST /api/backfill route rejects anything else with a 400.
const BACKFILL_SYMBOLS = [
  { value: 'NSE:NIFTY50-INDEX', label: 'NIFTY' },
  { value: 'BSE:SENSEX-INDEX', label: 'Sensex' },
] as const;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DateRangeCell({ from, to }: { from: string; to: string }) {
  return (
    <span className="tabular-nums text-foreground">
      {formatIstDate(from)} → {formatIstDate(to)}
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
              <Badge status={BACKFILL_STATUS[row.status]} dot>
                {statusLabel(row.status)}
              </Badge>
            </Td>
            <Td numeric align="right" className="text-foreground">
              {formatInt(row.rows_written)}
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

// ---------------------------------------------------------------------------
// Trigger Backfill card
// ---------------------------------------------------------------------------

interface TriggerCardProps {
  /** Called after a successful job queue so the status table can refresh. */
  onQueued: () => void;
}

function TriggerBackfillCard({ onQueued }: TriggerCardProps) {
  const defaults = defaultDateRange();

  const [symbol, setSymbol] = useState<string>(BACKFILL_SYMBOLS[0].value);
  const [resolution, setResolution] = useState('1');
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    { ok: true; jobId: string } | { ok: false; error: string } | null
  >(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setSubmitting(true);

    const res = await apiPost<{ jobId: string }>('/api/backfill', {
      symbol,
      resolution,
      from,
      to,
    });

    setSubmitting(false);

    if (!res.ok) {
      setResult({ ok: false, error: res.error });
      return;
    }

    setResult({ ok: true, jobId: res.data.jobId });
    // Notify the status table to refresh so the new job appears immediately.
    onQueued();
  }

  return (
    <Card>
      <div className="mb-4">
        <h2 className="text-base font-semibold tracking-tight text-foreground">Trigger Backfill</h2>
        <p className="mt-0.5 text-sm text-muted">Queue a new historical data fetch job</p>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {/* 4-column grid on desktop, stacked on mobile */}
        <div className="grid gap-3 sm:grid-cols-4">
          {/* Symbol */}
          <div>
            <label htmlFor="bf-symbol" className={LABEL_CLS}>
              Symbol
            </label>
            <Select
              id="bf-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              required
            >
              {BACKFILL_SYMBOLS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Resolution */}
          <div>
            <label htmlFor="bf-resolution" className={LABEL_CLS}>
              Resolution
            </label>
            <Select
              id="bf-resolution"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            >
              <option value="1">1-min</option>
              <option value="5">5-min</option>
              <option value="15">15-min</option>
              <option value="D">Daily</option>
              <option value="W">Weekly</option>
            </Select>
          </div>

          {/* From date */}
          <div>
            <label htmlFor="bf-from" className={LABEL_CLS}>
              From
            </label>
            <Input
              id="bf-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </div>

          {/* To date */}
          <div>
            <label htmlFor="bf-to" className={LABEL_CLS}>
              To
            </label>
            <Input
              id="bf-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </div>
        </div>

        {/* Submit row */}
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <Button
            type="submit"
            variant="primary"
            disabled={submitting}
            className="w-full sm:w-auto"
          >
            <Play className="h-3.5 w-3.5" />
            {submitting ? 'Queueing…' : 'Queue Backfill'}
          </Button>

          {/* Inline feedback — cleared on next submission */}
          {result?.ok && (
            <span className="text-sm font-medium text-positive">
              Job queued — ID: {result.jobId}
            </span>
          )}
          {result !== null && !result.ok && (
            <span className="text-sm font-medium text-negative">{result.error}</span>
          )}
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function BackfillView() {
  const { ranges, loading, error, refresh } = useBackfillStatus();
  const hasData = ranges.length > 0;

  return (
    <div className="space-y-4">
      {/* Section 1: Trigger a new backfill job */}
      <TriggerBackfillCard onQueued={refresh} />

      {/* Section 2: Backfill job history table */}
      <Card flush>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              Backfill Status
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Latest backfill per symbol — each rerun replaces the previous one
            </p>
          </div>
          <RefreshButton onClick={refresh} loading={loading} />
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
    </div>
  );
}
