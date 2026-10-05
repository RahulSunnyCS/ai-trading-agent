/**
 * BackfillView — Data › Coverage › Backfill. Two stacked sections:
 *  1. Trigger Backfill card — queue a new historical data fetch job
 *  2. Backfill Status table — the latest range per symbol from GET /api/backfill
 *
 * Status (normalised by the API to three buckets): completed → neutral ·
 * in_progress → info, with a progress bar · failed → negative. The table polls every few
 * seconds while a job is in progress (see useBackfillStatus).
 */

import { LogIn, Play } from 'lucide-react';
import { useState } from 'react';

import { useBackfillStatus } from '../hooks/useBackfillStatus';
import { useFyersAuthStatus } from '../hooks/useFyersAuthStatus';
import { apiPost } from '../lib/api';
import {
  BACKFILL_RESOLUTIONS,
  BACKFILL_SYMBOLS,
  backfillProgress,
  defaultBackfillRange,
  resolutionLabel,
  symbolLabel,
  validateBackfillRange,
} from '../lib/backfill';
import {
  formatDay,
  formatInt,
  formatIstDate,
  formatIstDateTimeShort,
  formatPct,
  formatRelative,
  istToday,
} from '../lib/format';
import { startFyersLogin } from '../lib/fyers-login';
import type { BackfillRangeRow, BackfillStatus } from '../types/trading';
import { Badge, type Status } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { InfoTooltip } from './ui/InfoTooltip';
import { Input, Select } from './ui/Input';
import { RefreshButton } from './ui/RefreshButton';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';
import { toast } from './ui/Toast';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The API normalises every backfill row to one of three statuses.
const BACKFILL_STATUS: Record<BackfillStatus, Status> = {
  completed: 'completed',
  in_progress: 'running',
  failed: 'failed',
};

const STATUS_LABEL: Record<BackfillStatus, string> = {
  completed: 'Completed',
  in_progress: 'In progress',
  failed: 'Failed',
};

const LABEL_CLS = 'mb-1 block text-xs font-medium text-muted';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** How far an in-progress job got: a bar from its checkpoint, or an indeterminate one. */
function ProgressBar({ row }: { row: BackfillRangeRow }) {
  const fraction = backfillProgress(row);
  const label =
    fraction === null
      ? 'Running, no checkpoint yet'
      : `${formatPct(fraction, 0)} · to ${formatIstDateTimeShort(row.checkpoint_ts)}`;
  return (
    <div className="mt-1.5 w-32" title={label}>
      {/* The native element carries the semantics (no value = indeterminate); the bar below
          is its visual. */}
      <progress
        className="sr-only"
        aria-label={`${symbolLabel(row.symbol)} backfill progress`}
        aria-valuetext={label}
        max={1}
        {...(fraction === null ? {} : { value: fraction })}
      />
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        {fraction === null ? (
          <div className="h-full w-full animate-pulse rounded-full bg-info/30" />
        ) : (
          <div
            className="h-full rounded-full bg-info"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        )}
      </div>
      {fraction !== null ? (
        <p className="metric mt-0.5 text-xs text-faint">{formatPct(fraction, 0)}</p>
      ) : null}
    </div>
  );
}

function BackfillTable({ ranges }: { ranges: BackfillRangeRow[] }) {
  return (
    <Table>
      <THead>
        <Th>Symbol</Th>
        <Th>Date range</Th>
        <Th>Resolution</Th>
        <Th>Status</Th>
        <Th align="right">Rows written</Th>
        <Th align="right">Gaps</Th>
        <Th align="right">Updated</Th>
      </THead>
      <tbody>
        {ranges.map((row) => (
          <TRow key={row.id}>
            <Td className="font-medium text-foreground">
              <span title={row.symbol}>{symbolLabel(row.symbol)}</span>
            </Td>
            <Td>
              <span className="whitespace-nowrap tabular-nums text-foreground">
                {formatIstDate(row.from_ts)} → {formatIstDate(row.to_ts)}
              </span>
            </Td>
            <Td className="text-muted">{resolutionLabel(row.resolution)}</Td>
            <Td>
              <Badge status={BACKFILL_STATUS[row.status]} dot>
                {STATUS_LABEL[row.status]}
              </Badge>
              {row.status === 'in_progress' ? <ProgressBar row={row} /> : null}
            </Td>
            <Td numeric align="right" className="text-foreground">
              {formatInt(row.rows_written)}
            </Td>
            <Td numeric align="right">
              {row.gaps_detected > 0 ? (
                <span className="font-medium text-warning">{formatInt(row.gaps_detected)}</span>
              ) : (
                <span className="text-faint">{formatInt(0)}</span>
              )}
            </Td>
            <Td align="right" className="whitespace-nowrap text-faint">
              <span title={formatIstDateTimeShort(row.updated_at)}>
                {formatRelative(row.updated_at)}
              </span>
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
  /** Called after a successful job queue so the status table can pick the new job up. */
  onQueued: () => void;
}

/** The Queue button's place when there is no usable Fyers token: a backfill needs one. */
function LoginPrompt({ expired }: { expired: boolean }) {
  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
      <Button variant="primary" onClick={startFyersLogin} className="w-full sm:w-auto">
        <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
        Log in to Fyers
      </Button>
      <span className="text-sm text-muted">
        {expired ? 'The Fyers token has expired.' : 'No Fyers token.'} A backfill fetches from
        Fyers, so it needs a valid login first.
      </span>
    </div>
  );
}

function TriggerBackfillCard({ onQueued }: TriggerCardProps) {
  // The IST date, not the UTC one (a day behind before 05:30 IST). Fixed for the card's life.
  const [today] = useState(() => istToday());
  const [defaults] = useState(() => defaultBackfillRange(today));

  const [symbol, setSymbol] = useState<string>(BACKFILL_SYMBOLS[0]);
  const [resolution, setResolution] = useState<string>(BACKFILL_RESOLUTIONS[0]);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    { ok: true; jobId: string } | { ok: false; error: string } | null
  >(null);

  const auth = useFyersAuthStatus();
  const needsLogin =
    !auth.loading && (auth.tokenState === 'missing' || auth.tokenState === 'expired');
  const invalid = validateBackfillRange(from, to, today);

  /** Any edit clears the last outcome, so it never describes a different request. */
  function edit<T>(setter: (value: T) => void): (value: T) => void {
    return (value) => {
      setResult(null);
      setter(value);
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid !== null || needsLogin) return;
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

    setResult({ ok: true, jobId: String(res.data.jobId) });
    toast(
      `Backfill queued: ${symbolLabel(symbol)} · ${resolutionLabel(resolution)}, ${formatDay(from)} → ${formatDay(to)}`,
    );
    // Re-read the status table now and keep polling until the job's row appears.
    onQueued();
  }

  return (
    <Card>
      <div className="mb-4">
        <h2 className="text-base font-semibold tracking-tight text-foreground">Trigger Backfill</h2>
        <p className="mt-0.5 text-sm text-muted">
          Queue a historical candle fetch from Fyers. Dates are IST trading days.
        </p>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        {/* 4-column grid on desktop, stacked on mobile */}
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="bf-symbol" className={LABEL_CLS}>
              Symbol
            </label>
            <Select
              id="bf-symbol"
              value={symbol}
              onChange={(e) => edit(setSymbol)(e.target.value)}
              required
            >
              {BACKFILL_SYMBOLS.map((value) => (
                <option key={value} value={value}>
                  {symbolLabel(value)}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="bf-resolution" className={LABEL_CLS}>
              Resolution
            </label>
            <Select
              id="bf-resolution"
              value={resolution}
              onChange={(e) => edit(setResolution)(e.target.value)}
            >
              {BACKFILL_RESOLUTIONS.map((value) => (
                <option key={value} value={value}>
                  {resolutionLabel(value)}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="bf-from" className={LABEL_CLS}>
              From
            </label>
            <Input
              id="bf-from"
              type="date"
              value={from}
              max={to || today}
              onChange={(e) => edit(setFrom)(e.target.value)}
              aria-invalid={invalid?.includes('From') ? true : undefined}
              aria-describedby={invalid !== null ? 'bf-range-error' : undefined}
              required
            />
          </div>

          <div>
            <label htmlFor="bf-to" className={LABEL_CLS}>
              To
            </label>
            <Input
              id="bf-to"
              type="date"
              value={to}
              min={from || undefined}
              max={today}
              onChange={(e) => edit(setTo)(e.target.value)}
              aria-invalid={invalid?.includes('To') ? true : undefined}
              aria-describedby={invalid !== null ? 'bf-range-error' : undefined}
              required
            />
          </div>
        </div>

        {/* Submit row */}
        {needsLogin ? (
          <LoginPrompt expired={auth.tokenState === 'expired'} />
        ) : (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
              disabled={invalid !== null || auth.loading}
              className="w-full sm:w-auto"
            >
              {submitting ? null : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
              {submitting ? 'Queueing…' : 'Queue Backfill'}
            </Button>

            {invalid !== null ? (
              <span id="bf-range-error" role="alert" className="text-sm font-medium text-negative">
                {invalid}
              </span>
            ) : null}
            {invalid === null && result?.ok ? (
              <span className="flex items-center gap-1.5 text-sm text-muted">
                Queued. It appears in the table below once the worker starts it.
                <InfoTooltip text={`Job id ${result.jobId}`} label="Queued job id" />
              </span>
            ) : null}
            {invalid === null && result !== null && !result.ok ? (
              <span role="alert" className="text-sm font-medium text-negative">
                {result.error}
              </span>
            ) : null}
          </div>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function BackfillView() {
  const { ranges, loading, error, refresh, polling, watchForNewJob } = useBackfillStatus();
  const hasData = ranges.length > 0;

  return (
    <div className="space-y-4">
      {/* Section 1: Trigger a new backfill job */}
      <TriggerBackfillCard onQueued={watchForNewJob} />

      {/* Section 2: Backfill job history table */}
      <Card flush>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              Backfill Status
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Latest backfill per symbol — each rerun replaces the previous one
              {polling ? ' · updating every few seconds while a job runs' : ''}
            </p>
          </div>
          <RefreshButton onClick={refresh} loading={loading && !polling} />
        </div>

        <div className="px-2 py-1">
          {loading && !hasData && <SkeletonRows rows={4} className="px-1 pt-2" />}
          {error !== null && (
            <StateMessage
              variant="error"
              title="Couldn't load backfill status"
              description={error}
              className="m-3"
            />
          )}
          {!loading && error === null && !hasData && (
            <StateMessage
              variant="empty"
              title="No backfill jobs yet"
              description="Queue one above; its progress shows here."
            />
          )}
          {hasData && <BackfillTable ranges={ranges} />}
        </div>
      </Card>
    </div>
  );
}
