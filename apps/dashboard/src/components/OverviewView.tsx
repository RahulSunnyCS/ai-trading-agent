/**
 * OverviewView — the landing view: one card per question the operator asks every day, each
 * answered without a click and each linking into the tab that owns the detail.
 *
 *   Market · Feed · Fyers token · Paper trading · Weekly momentum signal ·
 *   Options Lab evening job · Credits
 *
 * Every card has three states besides its data: a skeleton until the first answer, one plain
 * sentence when its service cannot be reached, and its own "nothing yet" wording. The rules
 * that turn raw state into words (feed staleness, the signal summary, the evening job line)
 * live in lib/overview.ts.
 */

import {
  ArrowRight,
  Clock,
  CreditCard,
  KeyRound,
  Layers,
  LineChart,
  Radio,
  Repeat,
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useEffect, useState } from 'react';

import { useAppRoute } from '../hooks/useAppRoute';
import { useFyersAuthStatus } from '../hooks/useFyersAuthStatus';
import { useDailyJob, useLegwiseData } from '../hooks/useLegwise';
import { useLiveTicks } from '../hooks/useLiveTicks';
import { useMeta } from '../hooks/useMeta';
import { useMomentumWeeklyJob } from '../hooks/useMomentumWeeklyJob';
import { useNow } from '../hooks/useNow';
import { TRADES_WINDOW_CAPTION, usePaperTrades } from '../hooks/usePaperTrades';
import { usePaymentBalance } from '../hooks/usePaymentBalance';
import { usePolledResource } from '../hooks/usePolledResource';
import { cn } from '../lib/cn';
import { formatDay, formatInr, formatInt, formatIstTime, formatRelative } from '../lib/format';
import { startFyersLogin } from '../lib/fyers-login';
import { describeMarketSession, formatCountdown, marketSession } from '../lib/market';
import {
  type FeedHealth,
  eveningJobLine,
  feedHealth,
  weeklyScheduleLine,
  weeklySignalRows,
  weeklySignalSummary,
} from '../lib/overview';
import { computePnlSummary } from '../lib/pnl';
import { buildPath } from '../lib/routes';
import type { MomentumSavedRun, MomentumWeeklyStatus } from '../types/momentum';
import type { Tab } from './shell/nav';
import { Badge, Button, Card, CardHeader, Skeleton, StatusDot } from './ui';
import type { Tone } from './ui';

/** How often the slower cards re-read their status. */
const WEEKLY_STATUS_POLL_MS = 60_000;
const EVENING_JOB_POLL_MS = 15_000;
/** How long the Feed card shows a skeleton for the first connection attempt. */
const FEED_CONNECT_GRACE_MS = 5_000;

const TRADING_UNREACHABLE = "Can't reach the trading server right now.";
const MOMENTUM_UNREACHABLE = "Can't reach the Momentum service right now.";
const OPTIONS_UNREACHABLE = "Can't reach the Options Lab service right now.";

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
  links,
  children,
}: {
  title: string;
  icon: ReactNode;
  links: CardLink[];
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={title}
        icon={icon}
        className="mb-3"
        actions={links.map((link) => <TabLink key={link.label} link={link} />)}
      />
      {children}
    </Card>
  );
}

type ValueTone = 'default' | 'positive' | 'negative' | 'warning' | 'muted';

const VALUE_TONE: Record<ValueTone, string> = {
  default: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-negative',
  warning: 'text-warning',
  muted: 'text-muted',
};

/** The card's one headline value. `numeric` sets figures in the mono face. */
function Headline({
  children,
  tone = 'default',
  numeric = false,
}: {
  children: ReactNode;
  tone?: ValueTone;
  numeric?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xl font-semibold tracking-tight',
        numeric ? 'metric' : '',
        VALUE_TONE[tone],
      )}
    >
      {children}
    </div>
  );
}

function Support({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-sm text-muted">{children}</p>;
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-faint">{children}</p>;
}

/** Stands in for the headline and supporting line until the first answer arrives. */
function CardSkeleton() {
  return (
    <output aria-busy="true" aria-label="Loading" className="block">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-2 h-4 w-48" />
    </output>
  );
}

/** One plain sentence for "nothing to show": a service that is down, or a feature that is off. */
function PlainState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

const MARKET_TONE: Record<ReturnType<typeof marketSession>['state'], Tone> = {
  open: 'positive',
  pre_open: 'warning',
  closed: 'neutral',
};

function MarketCard() {
  const now = useNow(1000);
  return (
    <OverviewCard
      title="Market"
      icon={<Clock className="h-4 w-4" />}
      links={[{ label: 'Live', tab: 'live' }]}
    >
      {now === null ? (
        <CardSkeleton />
      ) : (
        <>
          <Headline numeric>
            {formatIstTime(now, { seconds: true })}
            <span className="text-sm font-medium text-faint">IST</span>
          </Headline>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted">
            <StatusDot tone={MARKET_TONE[marketSession(now).state]} />
            {describeMarketSession(now)}
          </p>
        </>
      )}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

const FEED_VIEW: Record<FeedHealth, { label: string; tone: Tone; pulse: boolean }> = {
  live: { label: 'Live', tone: 'positive', pulse: true },
  stale: { label: 'Stale', tone: 'warning', pulse: false },
  waiting: { label: 'Connected', tone: 'info', pulse: false },
  idle: { label: 'Idle', tone: 'neutral', pulse: false },
  connecting: { label: 'Connecting…', tone: 'neutral', pulse: false },
  disconnected: { label: 'Not connected', tone: 'negative', pulse: false },
};

function feedSupport(health: FeedHealth, lastTickAt: number | null, now: Date): string {
  const last = lastTickAt === null ? null : formatRelative(lastTickAt, now);
  switch (health) {
    case 'live':
    case 'stale':
      return `Last tick ${last ?? 'not received yet'}`;
    case 'waiting':
      return 'No tick received yet on this connection';
    case 'idle':
      return last
        ? `Market closed · last tick ${last}`
        : 'Market closed · no ticks expected until it opens';
    case 'connecting':
      return last
        ? `Trying to reach the tick feed · last tick ${last}`
        : 'Trying to reach the tick feed';
    case 'disconnected':
      return last
        ? `The tick feed is unreachable · last tick ${last}`
        : 'The tick feed is unreachable';
  }
}

function FeedCard() {
  // useLiveTicks opens its own WebSocket per mounted consumer (there is no shared store), so
  // this is a second /ws/ticks consumer in the codebase next to LiveView. That is acceptable
  // here only because App renders tabs exclusively: Overview and Live are never mounted at the
  // same time, so there is still one socket per browser tab. If a second always-mounted
  // consumer appears (say, a feed dot in the top bar), lift the connection into a store first.
  const { status, latestTimestamp } = useLiveTicks();
  const { meta } = useMeta();
  const now = useNow(1000);

  // The socket starts at "connecting" and returns to it between retries. Only the first
  // attempt is a loading state; after that the card says it is reconnecting.
  // A socket that neither opens nor fails (a proxy that swallows the upgrade) stops counting
  // as loading after FEED_CONNECT_GRACE_MS, so the skeleton never stays for good.
  const [settled, setSettled] = useState(false);
  if (!settled && status !== 'connecting') setSettled(true);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), FEED_CONNECT_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);

  // A standalone Momentum preview also answers /api/meta, with a different payload.
  const simulate = meta?.simulate === true;
  const health =
    now === null
      ? null
      : feedHealth({
          connection: status,
          lastTickAt: latestTimestamp,
          now: now.getTime(),
          marketOpen: marketSession(now).state === 'open',
          simulate,
        });
  const view = health ? FEED_VIEW[health] : null;

  return (
    <OverviewCard
      title="Feed"
      icon={<Radio className="h-4 w-4" />}
      links={[{ label: 'Live', tab: 'live' }]}
    >
      {now === null || health === null || view === null || (!settled && status === 'connecting') ? (
        <CardSkeleton />
      ) : (
        <>
          <Headline tone={health === 'stale' ? 'warning' : 'default'}>
            <StatusDot tone={view.tone} pulse={view.pulse} />
            {view.label}
            {simulate ? <Badge tone="info">Simulation</Badge> : null}
          </Headline>
          <Support>{feedSupport(health, latestTimestamp, now)}</Support>
        </>
      )}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Fyers token
// ---------------------------------------------------------------------------

function TokenCard() {
  const auth = useFyersAuthStatus();
  const links: CardLink[] = [{ label: 'Broker logins', tab: 'brokerLogins' }];
  const icon = <KeyRound className="h-4 w-4" />;

  let body: ReactNode;
  if (auth.loading) {
    body = <CardSkeleton />;
  } else if (auth.status === null) {
    body = <PlainState>{TRADING_UNREACHABLE}</PlainState>;
  } else if (!auth.status.configured) {
    body = (
      <>
        <Headline tone="muted">Not set up</Headline>
        <Support>Fyers login is not configured on this server.</Support>
      </>
    );
  } else {
    const countdown = auth.msLeft !== null && auth.msLeft > 0 ? formatCountdown(auth.msLeft) : null;
    const view = {
      valid: {
        label: 'Valid',
        tone: 'default' as ValueTone,
        dot: 'positive' as Tone,
        support: countdown ? `Expires in ${countdown}` : 'Connected',
      },
      expiring: {
        label: 'Expiring soon',
        tone: 'warning' as ValueTone,
        dot: 'warning' as Tone,
        support: countdown
          ? `Expires in ${countdown}. Log in again to renew it.`
          : 'Log in again to renew it.',
      },
      expired: {
        label: 'Expired',
        tone: 'negative' as ValueTone,
        dot: 'negative' as Tone,
        support: 'Log in again to restore live market data.',
      },
      missing: {
        label: 'No token',
        tone: 'negative' as ValueTone,
        dot: 'negative' as Tone,
        support: 'Log in to Fyers to get live market data.',
      },
    }[auth.tokenState];
    body = (
      <>
        <Headline tone={view.tone}>
          <StatusDot tone={view.dot} />
          {view.label}
        </Headline>
        <Support>{view.support}</Support>
        {auth.tokenState !== 'valid' ? (
          <div className="mt-3">
            <Button size="sm" variant="primary" onClick={startFyersLogin}>
              Login
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <OverviewCard title="Fyers token" icon={icon} links={links}>
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Paper trading
// ---------------------------------------------------------------------------

function PaperTradingCard() {
  // A second usePaperTrades consumer is fine for the same reason as the feed: Trades, P&L and
  // Overview are never mounted together.
  const { trades, loading, error } = usePaperTrades();

  let body: ReactNode;
  if (loading && trades.length === 0) {
    body = <CardSkeleton />;
  } else if (error !== null && trades.length === 0) {
    body = <PlainState>{TRADING_UNREACHABLE}</PlainState>;
  } else {
    const { openCount, todayRealizedPnl } = computePnlSummary(trades);
    const tone: ValueTone =
      todayRealizedPnl > 0 ? 'positive' : todayRealizedPnl < 0 ? 'negative' : 'default';
    body = (
      <>
        <Headline tone={tone} numeric>
          {formatInr(todayRealizedPnl, { sign: true })}
          <span className="font-sans text-sm font-medium text-faint">realised today</span>
        </Headline>
        <Support>
          {formatInt(openCount)} open {openCount === 1 ? 'position' : 'positions'}
        </Support>
        <Caption>
          {error !== null
            ? `${TRADING_UNREACHABLE} Showing the last figures loaded.`
            : TRADES_WINDOW_CAPTION}
        </Caption>
      </>
    );
  }

  return (
    <OverviewCard
      title="Paper trading"
      icon={<Repeat className="h-4 w-4" />}
      links={[
        { label: 'Trades', tab: 'trades' },
        { label: 'P&L', tab: 'pnl' },
      ]}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Weekly momentum signal
// ---------------------------------------------------------------------------

function WeeklySignalCard() {
  const status = usePolledResource<MomentumWeeklyStatus>('/api/momentum/weekly/status', {
    intervalMs: WEEKLY_STATUS_POLL_MS,
    cache: true,
  });
  const favorites = usePolledResource<MomentumSavedRun[]>('/api/momentum/favorite-strategies', {
    cache: true,
  });
  const { job, running } = useMomentumWeeklyJob();

  let body: ReactNode;
  // A reply without the expected shape (an error body, a proxy page) is treated as unreachable
  // rather than crashing the whole Overview.
  if (status.data === null || !Array.isArray(status.data.signals)) {
    body = status.loading ? <CardSkeleton /> : <PlainState>{MOMENTUM_UNREACHABLE}</PlainState>;
  } else {
    // Same reading as Momentum › Weekly signal: the newest saved final signal, and the
    // Telegram-active favourite (or the built-in live strategy when none is active).
    const latestFinal = status.data.signals.find((signal) => signal.run === 'final');
    const strategyName =
      (Array.isArray(favorites.data)
        ? favorites.data.find((run) => run.active)?.name
        : undefined) ?? 'Default live strategy';
    const schedule = weeklyScheduleLine(status.data.schedule);
    body = (
      <>
        {latestFinal ? (
          <>
            <Headline numeric>{formatDay(latestFinal.week)}</Headline>
            <Support>
              {weeklySignalSummary(strategyName, weeklySignalRows(job, latestFinal.week))}
            </Support>
          </>
        ) : (
          <>
            <Headline tone="muted">No signal yet</Headline>
            <Support>{strategyName} has not produced a final signal.</Support>
          </>
        )}
        {running ? (
          <div className="mt-2">
            <Badge status="running" dot>
              Run in progress
            </Badge>
          </div>
        ) : schedule ? (
          <Caption>{schedule}</Caption>
        ) : null}
      </>
    );
  }

  return (
    <OverviewCard
      title="Weekly momentum signal"
      icon={<LineChart className="h-4 w-4" />}
      links={[{ label: 'This week', tab: 'momentum', rest: ['week'] }]}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Options Lab evening job
// ---------------------------------------------------------------------------

function EveningJobCard() {
  const data = useLegwiseData();
  const job = useDailyJob(EVENING_JOB_POLL_MS);

  let body: ReactNode;
  if (data.data === null) {
    body = data.loading ? <CardSkeleton /> : <PlainState>{OPTIONS_UNREACHABLE}</PlainState>;
  } else {
    // The same series the Options Lab evening-run card counts.
    const days = data.data.days.NIFTY ?? [];
    const lastDay = days[days.length - 1];
    const jobLine = job.data ? eveningJobLine(job.data) : null;
    const collected = `${formatInt(days.length)} NIFTY ${days.length === 1 ? 'day' : 'days'} collected`;
    body = (
      <>
        {lastDay ? (
          <Headline numeric>{formatDay(lastDay)}</Headline>
        ) : (
          <Headline tone="muted">No data yet</Headline>
        )}
        <Support>
          {lastDay ? `Last collected day · ${collected}` : 'No day has been collected.'}
        </Support>
        {job.data?.state === 'running' ? (
          <div className="mt-2">
            <Badge status="running" dot>
              Evening run in progress
            </Badge>
          </div>
        ) : jobLine ? (
          <Caption>{`${jobLine.charAt(0).toUpperCase()}${jobLine.slice(1)}`}</Caption>
        ) : null}
      </>
    );
  }

  return (
    <OverviewCard
      title="Options Lab evening job"
      icon={<Layers className="h-4 w-4" />}
      links={[{ label: 'Options Lab', tab: 'optionslab', rest: ['results'] }]}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

function CreditsCard() {
  const credits = usePaymentBalance();

  let body: ReactNode;
  if (credits.loading) {
    body = <CardSkeleton />;
  } else if (credits.error !== null) {
    body = <PlainState>{TRADING_UNREACHABLE}</PlainState>;
  } else if (!credits.enabled) {
    body = <PlainState>Billing is off in this environment</PlainState>;
  } else if (credits.balance === null) {
    body = <PlainState>The credit balance is not available right now.</PlainState>;
  } else {
    body = (
      <>
        <Headline numeric tone={credits.balance > 0 ? 'default' : 'warning'}>
          {formatInt(credits.balance)}
          <span className="font-sans text-sm font-medium text-faint">
            {credits.balance === 1 ? 'credit' : 'credits'}
          </span>
        </Headline>
        <Support>
          {credits.balance > 0
            ? 'One credit is used per backtest run.'
            : 'Backtest runs need credits. Buy a pack to continue.'}
        </Support>
      </>
    );
  }

  return (
    <OverviewCard
      title="Credits"
      icon={<CreditCard className="h-4 w-4" />}
      links={[{ label: 'Billing', tab: 'pricing' }]}
    >
      {body}
    </OverviewCard>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function OverviewView() {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
      <MarketCard />
      <FeedCard />
      <TokenCard />
      <PaperTradingCard />
      <WeeklySignalCard />
      <EveningJobCard />
      <CreditsCard />
    </div>
  );
}
