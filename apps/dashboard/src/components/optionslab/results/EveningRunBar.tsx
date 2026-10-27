/**
 * The evening run (`obt daily`: collect the day's 1-minute Fyers data, run every saved
 * strategy on it, send the summary to Telegram) as one status bar: token, last run, days
 * collected and the Run button. Its options and log sit behind a disclosure that opens by
 * itself while a run is in progress.
 *
 * `compact` (the Today page, since the dashboard review of 2026-10-28) renders it inside the
 * page's run bar: a status chip and Run, with the token, the days collected, the options and the
 * log in the disclosure, which takes its own line of that bar when open.
 *
 * The API only knows the runs it started itself; the scheduled 15:45 run is the scheduler's. So
 * when the API has no finished run, the last run is the scheduler's `options-evening` (when the
 * scheduler API is reachable), else the latest collected day: never "no run" after a run happened.
 */

import { ChevronDown, Play } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { LEGWISE_API, useDailyJob, useLegwiseData } from '../../../hooks/useLegwise';
import { useNow } from '../../../hooks/useNow';
import { usePolledResource } from '../../../hooks/usePolledResource';
import { apiPost } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { formatDay, formatInt, formatIstDateTimeShort, formatRelative } from '../../../lib/format';
import { formatCountdown, msUntil, tokenState } from '../../../lib/market';
import { SCHEDULER_API, type SchedulerJob, type SchedulerRun } from '../../../lib/scheduler';
import type { DailyJob, DataStatus } from '../../../types/legwise';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';

/** The scheduler's id for the evening run. */
export const EVENING_JOB_ID = 'options-evening';

function TokenBadge({ token, now }: { token: DataStatus['token']; now: Date }) {
  if (!token.ok) {
    return (
      <Badge status="attention" dot>
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

function LastRun({
  job,
  scheduled,
  latestDay,
  now,
}: {
  job: DailyJob;
  /** The scheduler's latest `options-evening` run, when the scheduler API answered. */
  scheduled: SchedulerRun | null;
  /** The newest collected session, the last resort. */
  latestDay: string | null;
  now: Date;
}) {
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
  if (job.state !== 'idle' && job.finished) {
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
  if (scheduled) {
    const going = scheduled.ended_at === null;
    const failed = !going && scheduled.exit_code !== 0;
    const at = scheduled.ended_at ?? scheduled.started_at;
    return (
      <span className="inline-flex items-center gap-2">
        <Badge status={going ? 'running' : failed ? 'failed' : 'completed'} dot={going}>
          {going ? 'Running' : failed ? 'Failed' : 'Done'}
        </Badge>
        <span title={`${formatIstDateTimeShort(at)} IST, run by the scheduler`}>
          {going ? 'Scheduled run started' : 'Scheduled run'} {formatRelative(at, now)}
        </span>
      </span>
    );
  }
  return (
    <span>{latestDay ? `Latest session collected ${formatDay(latestDay)}` : 'No run yet'}</span>
  );
}

export function EveningRunBar({
  underlying,
  onFinished,
  compact = false,
}: {
  /** Whose collected days to count; null until the strategies are known. */
  underlying: string | null;
  onFinished: () => void;
  /** Inside the page's run bar: chip and Run, everything else behind the disclosure. */
  compact?: boolean;
}) {
  const data = useLegwiseData();
  const job = useDailyJob();
  // Read once: only for the last-run line when the API did not run the evening itself. A
  // scheduler that is not reachable (no SCHEDULER_DIRECT, a hosted dashboard) just leaves it out.
  const jobs = usePolledResource<SchedulerJob[]>(`${SCHEDULER_API}/jobs`, { cache: true });
  // Moves the countdown and "3 h ago" without a refetch; null only before the first effect.
  const now = useNow(30_000);
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
  const scheduled =
    (Array.isArray(jobs.data) ? jobs.data : []).find((j) => j.id === EVENING_JOB_ID)?.lastRun ??
    null;

  const tokenBadge =
    token && now ? (
      <TokenBadge token={token} now={now} />
    ) : data.error ? (
      <Badge status="attention">Data status unavailable</Badge>
    ) : (
      <Skeleton className="h-5 w-40" />
    );
  const lastRun =
    job.data && now ? (
      <LastRun
        job={job.data}
        scheduled={scheduled}
        latestDay={collected[collected.length - 1] ?? null}
        now={now}
      />
    ) : job.error ? (
      <span>Run status unavailable</span>
    ) : (
      <Skeleton className="h-5 w-44" />
    );
  const daysLine = data.data ? (
    <span>
      {formatInt(collected.length)} {shown ?? ''} {collected.length === 1 ? 'day' : 'days'}{' '}
      collected
      {collected.length > 0
        ? ` · ${formatDay(collected[0])} → ${formatDay(collected[collected.length - 1])}`
        : ''}
    </span>
  ) : null;
  const toggle = (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen((v) => !v)}
    >
      {compact ? 'Evening run' : 'Options & log'}
      <ChevronDown
        className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
        aria-hidden="true"
      />
    </Button>
  );
  const runButton = (
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
  );
  const panel = (
    <div
      id={panelId}
      hidden={!open}
      className={cn(
        'space-y-3 px-4 py-3',
        compact
          ? 'order-last basis-full rounded-xl border border-border bg-surface'
          : 'border-t border-border',
      )}
    >
      {compact ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          {tokenBadge}
          {daysLine}
        </div>
      ) : null}
      {compact && token && !token.ok && token.message ? (
        <p className="whitespace-pre-line text-xs text-muted">
          {token.message} The evening run uses Angel One when Fyers is not logged in.
        </p>
      ) : null}
      <p className="text-xs text-muted">
        Collects the day's 1-minute option data (Fyers, or Angel One when Fyers is not logged in),
        runs every saved strategy on it and sends the summary to Telegram. The scheduler runs it at
        15:45 on trading days; this is for running it by hand.
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
  );

  if (compact) {
    // Fragments flow into the page's run bar (a wrapping flex row); the panel takes a line.
    return (
      <>
        <span
          aria-label="Evening run"
          className="inline-flex items-center gap-2 text-xs text-muted"
        >
          {token && !token.ok ? tokenBadge : null}
          {lastRun}
          {toggle}
          {runButton}
        </span>
        {error && !open ? (
          <p role="alert" className="order-last basis-full text-xs text-negative">
            {error}
          </p>
        ) : null}
        {panel}
      </>
    );
  }

  return (
    <section
      aria-label="Evening run"
      className="rounded-xl border border-border bg-surface shadow-card"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-xs text-muted">
        <span className="text-sm font-semibold text-foreground">Evening run</span>
        {tokenBadge}
        {lastRun}
        {daysLine}
        <span className="ml-auto flex items-center gap-2">
          {toggle}
          {runButton}
        </span>
      </div>

      {token && !token.ok && token.message ? (
        <p className="whitespace-pre-line border-t border-border px-4 py-2 text-xs text-muted">
          {token.message} The evening run uses Angel One when Fyers is not logged in.
        </p>
      ) : null}
      {error && !open ? (
        <p role="alert" className="border-t border-border px-4 py-2 text-xs text-negative">
          {error}
        </p>
      ) : null}
      {panel}
    </section>
  );
}
