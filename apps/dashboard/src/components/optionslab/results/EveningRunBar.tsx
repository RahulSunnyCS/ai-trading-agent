/**
 * The evening run (`obt daily`: collect the day's 1-minute Fyers data, run every saved
 * strategy on it, send the summary to Telegram) as one status bar: token, last run, days
 * collected and the Run button. Its options and log sit behind a disclosure that opens by
 * itself while a run is in progress.
 */

import { ChevronDown, Play } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { LEGWISE_API, useDailyJob, useLegwiseData } from '../../../hooks/useLegwise';
import { apiPost } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { formatDay, formatInt, formatIstDateTimeShort, formatRelative } from '../../../lib/format';
import { formatCountdown, msUntil, tokenState } from '../../../lib/market';
import type { DailyJob, DataStatus } from '../../../types/legwise';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';

/** Re-reads the clock so the countdown and "3 h ago" move without a refetch. */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function TokenBadge({ token, now }: { token: DataStatus['token']; now: Date }) {
  if (!token.ok) {
    return (
      <Badge status="disconnected" dot>
        Fyers login needed
      </Badge>
    );
  }
  const left = msUntil(token.expires_at, now);
  const state = tokenState(token.expires_at, now);
  const title = [
    token.source ? `Source: ${token.source}` : null,
    token.expires_at ? `Expires ${formatIstDateTimeShort(token.expires_at)} IST` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (state === 'expired') {
    return (
      <span title={title}>
        <Badge status="disconnected" dot>
          Fyers token expired
        </Badge>
      </span>
    );
  }
  return (
    <span title={title}>
      <Badge status={state === 'expiring' ? 'attention' : 'connected'} dot>
        Fyers token OK
        {left !== null && left > 0 ? ` · expires in ${formatCountdown(left)}` : ''}
      </Badge>
    </span>
  );
}

function LastRun({ job, now }: { job: DailyJob; now: Date }) {
  if (job.state === 'running') {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge status="running" dot>
          Running
        </Badge>
        <span>
          {job.day ? formatDay(job.day) : 'last closed session'}
          {job.started ? ` · started ${formatRelative(job.started, now)}` : ''}
        </span>
      </span>
    );
  }
  if (job.state === 'idle' || !job.finished) {
    return <span>No run since the service started</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Badge status={job.state === 'failed' ? 'failed' : 'completed'}>
        {job.state === 'failed' ? 'Failed' : 'Done'}
      </Badge>
      <span title={`${formatIstDateTimeShort(job.finished)} IST`}>
        Last run {formatRelative(job.finished, now)}
        {job.day ? ` · for ${formatDay(job.day)}` : ''}
      </span>
    </span>
  );
}

export function EveningRunBar({
  underlying,
  onFinished,
}: {
  /** Whose collected days to count; null until the strategies are known. */
  underlying: string | null;
  onFinished: () => void;
}) {
  const data = useLegwiseData();
  const job = useDailyJob();
  const now = useNow();
  const panelId = useId();
  const [day, setDay] = useState('');
  const [fetch, setFetch] = useState(true);
  const [telegram, setTelegram] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState(false);
  const lastState = useRef<DailyJob['state'] | null>(null);

  const state = job.data?.state ?? 'idle';
  const refetchData = data.refetch;
  useEffect(() => {
    // Open the log when a run starts (or is already going when the page loads). It stays
    // open when the run ends, so the outcome can be read, and the user closes it.
    if (state === 'running' && lastState.current !== 'running') setOpen(true);
    if (lastState.current === 'running' && state !== 'running') {
      onFinished();
      refetchData();
    }
    lastState.current = state;
  }, [state, onFinished, refetchData]);

  async function start() {
    setError(null);
    setStarting(true);
    const body: { date?: string; fetch: boolean; telegram: boolean } = { fetch, telegram };
    if (day) body.date = day;
    const result = await apiPost<DailyJob>(`${LEGWISE_API}/daily`, body);
    setStarting(false);
    if (!result.ok) {
      setError(result.error);
      setOpen(true);
    }
    job.refetch();
  }

  const token = data.data?.token;
  const shown = underlying ?? Object.keys(data.data?.days ?? {})[0] ?? null;
  const collected = shown ? (data.data?.days[shown] ?? []) : [];
  const running = state === 'running';
  const log = job.data?.log ?? [];

  return (
    <section
      aria-label="Evening run"
      className="rounded-xl border border-border bg-surface shadow-card"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-xs text-muted">
        <span className="text-sm font-semibold text-foreground">Evening run</span>
        {token ? (
          <TokenBadge token={token} now={now} />
        ) : data.error ? (
          <Badge status="attention">Data status unavailable</Badge>
        ) : (
          <Skeleton className="h-5 w-40" />
        )}
        {job.data ? (
          <LastRun job={job.data} now={now} />
        ) : job.error ? (
          <span>Run status unavailable</span>
        ) : (
          <Skeleton className="h-5 w-44" />
        )}
        {data.data ? (
          <span>
            {formatInt(collected.length)} {shown ?? ''} {collected.length === 1 ? 'day' : 'days'}{' '}
            collected
            {collected.length > 0
              ? ` · ${formatDay(collected[0])} → ${formatDay(collected[collected.length - 1])}`
              : ''}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            Options & log
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={running || starting}
            onClick={() => void start()}
            title="Collect the day's data, run every saved strategy on it and send the summary"
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            {running ? 'Running…' : 'Run'}
          </Button>
        </span>
      </div>

      {token && !token.ok && token.message ? (
        <p className="whitespace-pre-line border-t border-border px-4 py-2 text-xs text-negative">
          {token.message}
        </p>
      ) : null}
      {error && !open ? (
        <p role="alert" className="border-t border-border px-4 py-2 text-xs text-negative">
          {error}
        </p>
      ) : null}

      <div id={panelId} hidden={!open} className="space-y-3 border-t border-border px-4 py-3">
        <p className="text-xs text-muted">
          Collects the day's 1-minute Fyers data, runs every saved strategy on it and sends the
          summary to Telegram.
        </p>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <label htmlFor={`${panelId}-day`} className="flex flex-col gap-1 text-xs text-muted">
            Day (blank = last closed session)
            <Input
              id={`${panelId}-day`}
              type="date"
              className="w-40"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs text-muted">
            <input type="checkbox" checked={fetch} onChange={(e) => setFetch(e.target.checked)} />
            Collect data first
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={telegram}
              onChange={(e) => setTelegram(e.target.checked)}
            />
            Send summary to Telegram
          </label>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        ) : null}
        {log.length > 0 ? (
          <pre className="max-h-56 overflow-auto rounded-lg bg-surface-2/60 p-3 text-xs text-muted">
            {log.join('\n')}
          </pre>
        ) : (
          <p className="text-xs text-faint">No log yet. It appears here while a run is going.</p>
        )}
      </div>
    </section>
  );
}
