/**
 * OverviewView — the morning board: six cards, each answering one thing the owner otherwise
 * opens a page for, each linking to that page.
 *
 *   Rotation today · Momentum this week · Trade book · Jobs · Logins · Data
 *
 * Every figure comes from an endpoint its page already reads; the rules that turn the responses
 * into lines live in lib/overviewView.ts. Each card has its own loading state (a skeleton), an
 * error state (one sentence; with older figures still on screen it says so) and an empty state.
 * A figure that does not exist is a dash with its reason, never a zero.
 */

import {
  ArrowRight,
  BookOpenCheck,
  CalendarClock,
  Database,
  KeyRound,
  Layers,
  LineChart,
} from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

import { useAppRoute } from '../hooks/useAppRoute';
import { useFyersAuthStatus } from '../hooks/useFyersAuthStatus';
import { useMomentumAlerts } from '../hooks/useMomentumAlerts';
import { useNow } from '../hooks/useNow';
import { usePolledResource } from '../hooks/usePolledResource';
import { ROTATION_PAGE_LOTS, useRotationOverview, useRotationSummary } from '../hooks/useRotation';
import { useRunLog, useSchedulerJobs } from '../hooks/useSchedulerJobs';
import { useTodayIst } from '../hooks/useTodayIst';
import { useTradeBookDays, useTradeBookSummary } from '../hooks/useTradeBook';
import { ANGEL_STATUS_URL, type AngelStatus } from '../lib/angelOne';
import { cn } from '../lib/cn';
import {
  EMPTY,
  formatDayShort,
  formatInr,
  formatInt,
  formatPct,
  formatRelative,
} from '../lib/format';
import {
  type LineTone,
  type StatusLine,
  angelLine,
  brokerLoginLine,
  dataLines,
  entryLine,
  failureReason,
  fyersLine,
  jobsOverview,
  kiteLine,
  latestPaperDay,
  liveForDay,
  momentumHeadline,
  readoutProgress,
  rulesLine,
  tradeBookOverview,
} from '../lib/overviewView';
import { buildPath } from '../lib/routes';
import type { SchedulerJob } from '../lib/scheduler';
import { fiscalYearOf, fyLabel, fyRange } from '../lib/tradeBookView';
import type { MomentumLiveRules, MomentumWeekView } from '../types/momentum';
import type { RotationLiveResponse } from '../types/rotationLive';
import type { KiteStatus } from './KiteCard';
import type { Tab } from './shell/nav';
import { Card, CardHeader, Skeleton, StatusDot } from './ui';
import type { Tone } from './ui';

const KITE_STATUS_URL = '/api/momentum/kite/status';
/** The Today page's Live vs paper read (hooks/useRotationLive.ts), here re-read on a timer. */
const ROTATION_LIVE_URL = '/api/backtest/legwise/rotation/live';
const MINUTE = 60_000;
const LIVE_POLL_MS = 5 * MINUTE;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

interface CardLink {
  label: string;
  tab: Tab;
  /** Sub-route segments, e.g. ['week']. */
  rest?: string[];
}

/** A real link that a plain left click follows in place (no reload), like the sidebar's. */
function TabLink({ link }: { link: CardLink }) {
  const { navigate } = useAppRoute();
  const rest = link.rest ?? [];
  function onClick(event: MouseEvent): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(link.tab, ...rest);
  }
  return (
    <a
      href={buildPath(link.tab, ...rest)}
      onClick={onClick}
      aria-label={`Open ${link.label}`}
      className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {link.label}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

function OverviewCard({
  title,
  icon,
  link,
  children,
}: {
  title: string;
  icon: ReactNode;
  link: CardLink;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader title={title} icon={icon} className="mb-3" actions={<TabLink link={link} />} />
      <div className="flex flex-col gap-1.5 text-sm">{children}</div>
    </Card>
  );
}

/** Stands in for the card's lines until the first answer arrives. */
function CardSkeleton() {
  return (
    <output aria-busy="true" aria-label="Loading" className="block space-y-2">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-4 w-40" />
    </output>
  );
}

/** One plain sentence for a card with nothing to show: a service that is down, or no data yet. */
function PlainState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

/** Said under figures that are older than the last failed refresh. */
function StaleNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-warning">
      Could not refresh ({error}). Showing the last figures loaded.
    </p>
  );
}

const DOT_TONE: Record<LineTone, Tone> = {
  ok: 'positive',
  warn: 'warning',
  bad: 'negative',
  info: 'info',
  neutral: 'neutral',
};

function Line({ line }: { line: StatusLine }) {
  return (
    <div className="flex items-baseline gap-2" title={line.detail}>
      <StatusDot tone={DOT_TONE[line.tone]} className="shrink-0 translate-y-[-1px]" />
      <span className="min-w-0">
        <span className="text-muted">{line.label}</span>{' '}
        <span className="text-foreground">{line.text}</span>
      </span>
    </div>
  );
}

/** A rupee figure in the mono face, coloured by its sign; a missing one is a dash with a reason. */
function Inr({ value, reason }: { value: number | null; reason?: string | null }) {
  if (value === null) {
    return (
      <span className="text-muted">
        {EMPTY}
        {reason ? ` (${reason})` : ''}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'metric font-medium',
        value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : 'text-foreground',
      )}
    >
      {formatInr(value, { sign: true })}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rotation today
// ---------------------------------------------------------------------------

function RotationCard() {
  const overview = useRotationOverview();
  const summary = useRotationSummary({ lots: ROTATION_PAGE_LOTS });
  // The capture lands at 15:40 (and its retry by 16:30): re-read it as the paper day moves on.
  const live = usePolledResource<RotationLiveResponse>(ROTATION_LIVE_URL, {
    intervalMs: LIVE_POLL_MS,
  });

  let body: ReactNode;
  if (!summary.data && !overview.data) {
    body =
      summary.loading || overview.loading ? (
        <CardSkeleton />
      ) : (
        <PlainState>Can't reach the Options Lab service right now.</PlainState>
      );
  } else {
    const entry = entryLine(overview.data);
    const paper = latestPaperDay(summary.data);
    const liveResult = paper && live.data ? liveForDay(live.data, paper.day) : null;
    const liveReason = live.loading ? 'loading' : 'live results unavailable';
    const progress = readoutProgress(summary.data);
    body = (
      <>
        {entry ? <Line line={entry} /> : null}
        {paper ? (
          <>
            <Row label={formatDayShort(paper.day, { weekday: true })}>
              <Inr value={paper.value} />{' '}
              <span className="text-muted">paper, gross, one lot a strategy</span>
            </Row>
            <Row label="Live">
              <Inr
                value={liveResult?.value ?? null}
                reason={liveResult ? liveResult.reason : liveReason}
              />
              {liveResult?.value !== null && liveResult?.value !== undefined ? (
                <span className="text-muted">
                  {' '}
                  vs <Inr value={liveResult.paper} /> on paper, per lot after costs
                  {liveResult.accounts > 1 ? `, ${formatInt(liveResult.accounts)} accounts` : ''}
                  {liveResult.reason ? (
                    <span className="text-warning"> ({liveResult.reason})</span>
                  ) : null}
                </span>
              ) : null}
            </Row>
          </>
        ) : summary.data ? (
          <PlainState>No forward day has been scored yet.</PlainState>
        ) : null}
        {progress ? (
          <Row label={`Day ${formatInt(progress.day)} of ${formatInt(progress.of)}`}>
            <span className="text-muted">
              since {formatDayShort(progress.firstDay, { weekday: true })}
            </span>{' '}
            <Inr value={progress.sinceFirst} reason="no total" />
          </Row>
        ) : null}
        <p className="mt-1 text-xs text-faint">
          Adaptive Classic. Live is the platforms' own result; its paper twin uses the same costs.
        </p>
        <StaleNote error={summary.error ?? overview.error} />
      </>
    );
  }

  return (
    <OverviewCard
      title="Rotation today"
      icon={<Layers className="h-4 w-4" />}
      link={{ label: 'Today', tab: 'optionslab', rest: ['rotation'] }}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Momentum this week
// ---------------------------------------------------------------------------

function MomentumCard({ now }: { now: number }) {
  const week = usePolledResource<MomentumWeekView>('/api/momentum/week', { cache: true });
  const rules = usePolledResource<MomentumLiveRules>('/api/momentum/live-rules', { cache: true });
  const kite = usePolledResource<KiteStatus>(KITE_STATUS_URL, { intervalMs: MINUTE });
  const alerts = useMomentumAlerts();

  let body: ReactNode;
  if (!week.data) {
    body = week.loading ? (
      <CardSkeleton />
    ) : (
      <PlainState>Can't reach the Momentum service right now.</PlainState>
    );
  } else {
    const headline = momentumHeadline(week.data);
    const open = alerts.data?.alerts?.length ?? 0;
    body = (
      <>
        {headline ? (
          <>
            <p className="font-medium text-foreground">{headline.name}</p>
            <p className="text-muted">{headline.nextTrade ?? 'Next trade date not known.'}</p>
          </>
        ) : (
          <PlainState>No headline favourite is set (Saved runs).</PlainState>
        )}
        {rules.data || !rules.loading ? (
          <Line
            line={
              rules.data
                ? rulesLine(rules.data)
                : { label: 'Rules', text: 'status unavailable', tone: 'neutral' }
            }
          />
        ) : null}
        {kite.data || !kite.loading ? <Line line={kiteLine(kite.data, now)} /> : null}
        {open > 0 ? (
          <Line
            line={{
              label: 'Alerts',
              text: `${formatInt(open)} ${open === 1 ? 'needs' : 'need'} you`,
              tone: 'warn',
            }}
          />
        ) : null}
        <StaleNote error={week.error} />
      </>
    );
  }

  return (
    <OverviewCard
      title="Momentum this week"
      icon={<LineChart className="h-4 w-4" />}
      link={{ label: 'This week', tab: 'momentum', rest: ['week'] }}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Trade book
// ---------------------------------------------------------------------------

function TradeBookCard() {
  const today = useTodayIst();
  const fy = fiscalYearOf(today);
  const range = fyRange(fy);
  // The same requests as the F&O page's for this year (all F&O accounts), so they share its cache.
  const summary = useTradeBookSummary(range, null);
  const days = useTradeBookDays(range, null);

  let body: ReactNode;
  if (!summary.data) {
    body = summary.loading ? (
      <CardSkeleton />
    ) : (
      <PlainState>Can't read the contract notes right now.</PlainState>
    );
  } else {
    const view = tradeBookOverview(summary.data, days.data, today);
    const daysPending = !days.data;
    const daysReason = days.loading ? 'loading' : 'days unavailable';
    body = view ? (
      <>
        <p className="text-muted">
          {view.lastNoteDay
            ? `Notes in through ${formatDayShort(view.lastNoteDay, { weekday: true })}`
            : 'No contract note this year yet.'}
        </p>
        <Row
          label={
            view.latest
              ? `Latest day, ${formatDayShort(view.latest.day, { weekday: true })}`
              : 'Latest day'
          }
        >
          <Inr value={view.latest?.net ?? null} reason={daysPending ? daysReason : 'no note yet'} />
        </Row>
        <Row label="Month to date">
          <Inr
            value={view.monthToDate?.net ?? null}
            reason={daysPending ? daysReason : 'no note this month yet'}
          />
          {view.monthToDate ? (
            <span className="text-muted">
              {' '}
              · {formatInt(view.monthToDate.sessions)}{' '}
              {view.monthToDate.sessions === 1 ? 'session' : 'sessions'}
            </span>
          ) : null}
        </Row>
        <Row label={`${fyLabel(fy)} to date`}>
          <Inr value={view.fyNet} reason="no session yet" />
          {view.fyPct !== null ? (
            <span className="text-muted">
              {' '}
              · {formatPct(view.fyPct, 1, { unit: 'percent' })} of capital
            </span>
          ) : null}
        </Row>
        <p className="mt-1 text-xs text-faint">F&O accounts, net after charges and algo fees.</p>
        <StaleNote error={summary.error ?? days.error} />
      </>
    ) : (
      <PlainState>The contract-notes summary has an unexpected shape.</PlainState>
    );
  }

  return (
    <OverviewCard
      title="Trade book"
      icon={<BookOpenCheck className="h-4 w-4" />}
      link={{ label: 'F&O', tab: 'tradebook', rest: ['fno'] }}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** A failed job, with the reason its run gave (or, for a bare "exit 1", its log's error line). */
function FailedJob({ job, now }: { job: SchedulerJob; now: number }) {
  const run = job.lastRun;
  const needsLog = Boolean(run && /^exit -?\d+$/.test(run.error?.trim() ?? 'exit 1'));
  const log = useRunLog(run?.id ?? 0, false, needsLog);
  const reason = failureReason(run, log.data?.text ?? null);
  return (
    <div className="flex items-baseline gap-2">
      <StatusDot tone="negative" className="shrink-0 translate-y-[-1px]" />
      <div className="min-w-0">
        <span className="font-mono text-xs text-foreground">{job.id}</span>{' '}
        <span className="text-muted">
          failed {run ? formatRelative(run.ended_at ?? run.started_at, now) : ''}
        </span>
        <p className="truncate text-xs text-muted" title={reason}>
          {needsLog && log.loading && !log.data ? 'Reading its log…' : reason}
        </p>
      </div>
    </div>
  );
}

function JobsCard({ now }: { now: number }) {
  const jobs = useSchedulerJobs();

  let body: ReactNode;
  if (!jobs.data) {
    body = jobs.loading ? (
      <CardSkeleton />
    ) : (
      <PlainState>
        Can't reach the scheduler right now (the dashboard needs SCHEDULER_DIRECT=1).
      </PlainState>
    );
  } else {
    const view = jobsOverview(jobs.data, now);
    const rest = [
      view.succeeded ? `${formatInt(view.succeeded)} succeeded` : null,
      view.running ? `${formatInt(view.running)} running` : null,
      view.quiet ? `${formatInt(view.quiet)} not run in 24 h` : null,
    ].filter(Boolean);
    body = (
      <>
        <p className="text-xs text-faint">Last 24 hours</p>
        {view.failed.length === 0 ? (
          <Line line={{ label: 'Failures', text: 'none', tone: 'ok' }} />
        ) : (
          view.failed.map((job) => <FailedJob key={job.id} job={job} now={now} />)
        )}
        {view.failedEarlier.length > 0 ? (
          <Line
            line={{
              label: 'Still failing from earlier',
              text: view.failedEarlier.map((job) => job.id).join(', '),
              tone: 'bad',
              detail: 'Their latest run failed more than 24 hours ago and they have not run since.',
            }}
          />
        ) : null}
        {rest.length > 0 ? (
          <p className="text-muted">
            {view.failed.length > 0 ? 'The others: ' : ''}
            {rest.join(' · ')}
          </p>
        ) : null}
        <StaleNote error={jobs.error} />
      </>
    );
  }

  return (
    <OverviewCard
      title="Jobs"
      icon={<CalendarClock className="h-4 w-4" />}
      link={{ label: 'Jobs', tab: 'jobs' }}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Logins
// ---------------------------------------------------------------------------

function LoginsCard({ now }: { now: number }) {
  const fyers = useFyersAuthStatus();
  const angel = usePolledResource<AngelStatus>(ANGEL_STATUS_URL, {
    intervalMs: MINUTE,
    cache: true,
  });
  const kite = usePolledResource<KiteStatus>(KITE_STATUS_URL, { intervalMs: MINUTE });
  const jobs = useSchedulerJobs();

  const loading =
    fyers.loading && angel.loading && kite.loading && jobs.loading && !angel.data && !kite.data;
  const job = jobs.data?.find((j) => j.id === 'broker-login') ?? null;

  return (
    <OverviewCard
      title="Logins"
      icon={<KeyRound className="h-4 w-4" />}
      link={{ label: 'Broker logins', tab: 'brokerLogins' }}
    >
      {loading ? (
        <CardSkeleton />
      ) : (
        <>
          <Line line={fyersLine(fyers.status, fyers.tokenState, fyers.error)} />
          <Line
            line={
              angel.data || !angel.loading
                ? angelLine(angel.data, now)
                : { label: 'Angel One', text: 'checking', tone: 'neutral' }
            }
          />
          <Line
            line={
              kite.data || !kite.loading
                ? kiteLine(kite.data, now)
                : { label: 'Kite', text: 'checking', tone: 'neutral' }
            }
          />
          <Line
            line={
              jobs.data
                ? brokerLoginLine(job, now)
                : {
                    label: 'Morning login',
                    text: jobs.loading ? 'checking' : 'scheduler unavailable',
                    tone: 'neutral',
                  }
            }
          />
        </>
      )}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function DataCard() {
  const overview = useRotationOverview();
  const lines = dataLines(overview.data);

  let body: ReactNode;
  if (!lines) {
    body = overview.loading ? (
      <CardSkeleton />
    ) : (
      <PlainState>Can't reach the Options Lab service right now.</PlainState>
    );
  } else if (lines.length === 0) {
    body = <PlainState>No health check reported.</PlainState>;
  } else {
    body = (
      <>
        {lines.map((line) => (
          <Line key={line.label} line={line} />
        ))}
        <StaleNote error={overview.error} />
      </>
    );
  }

  return (
    <OverviewCard
      title="Data"
      icon={<Database className="h-4 w-4" />}
      link={{ label: 'Today', tab: 'optionslab', rest: ['rotation'] }}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function OverviewView() {
  // One slow clock for the relative times ("17 h ago") and the 24-hour window.
  const clock = useNow(MINUTE);
  const now = clock?.getTime() ?? Date.now();
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
      <RotationCard />
      <MomentumCard now={now} />
      <TradeBookCard />
      <JobsCard now={now} />
      <LoginsCard now={now} />
      <DataCard />
    </div>
  );
}
