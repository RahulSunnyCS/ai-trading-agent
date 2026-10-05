/**
 * LiveView — the NIFTY index and the ATM straddle as they arrive over /ws/ticks.
 *
 *  - Market session badge first, so after hours the page says the market is closed and when
 *    it opens, rather than "Connected" and "Waiting for first tick…" forever.
 *  - Each value says how old it is ("Updated 4s ago") and its feed badge reads Live only when
 *    real ticks are fresh: Simulation in simulation mode, Stale once the last tick is older
 *    than lib/overview.ts's FEED_STALE_AFTER_MS while ticks are expected.
 *  - One banner for simulation / broker-token trouble, with the Fyers Login button inline
 *    (lib/live.ts `tokenBanner`); /api/meta comes from the shared `useMeta` hook.
 *  - The recent ticks and straddle values are kept by useLiveTicks across tab switches.
 *
 * Not shown: day change against the previous close — the tick frame carries only symbol, ltp
 * and timestamp, and /api/meta no previous close or day open.
 */

import { useEffect, useMemo, useState } from 'react';

import { useFyersAuthStatus } from '../hooks/useFyersAuthStatus';
import { useLiveTicks } from '../hooks/useLiveTicks';
import { useMeta } from '../hooks/useMeta';
import { formatInt, formatIstTime, formatNumber, formatRelative } from '../lib/format';
import { type FeedView, liveFeedView, tokenBanner } from '../lib/live';
import { type MarketState, describeMarketSession, marketSession } from '../lib/market';
import { type FeedHealth, feedHealth } from '../lib/overview';
import { LiveFeedBanner } from './live/LiveFeedBanner';
import { LiveLineChart } from './live/LiveLineChart';
import { StraddlePanel } from './live/StraddlePanel';
import { Badge, type Tone } from './ui/Badge';
import { Card } from './ui/Card';
import { StatusDot } from './ui/StatusDot';

/** The same tones as the top bar's market item (shell/SystemStatus.tsx). */
const MARKET_TONE: Record<MarketState, Tone> = {
  open: 'positive',
  pre_open: 'warning',
  closed: 'neutral',
};

/** The clock, re-read every `intervalMs`; null until mounted (no server/client time mismatch). */
function useNow(intervalMs: number): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function FeedBadge({ view }: { view: FeedView }) {
  return (
    <Badge tone={view.tone}>
      <StatusDot tone={view.tone} pulse={view.pulse} />
      {view.label}
    </Badge>
  );
}

function indexCaption(health: FeedHealth | null): string {
  switch (health) {
    case 'idle':
      return 'Market closed · no ticks until it opens';
    case 'connecting':
      return 'Connecting to the tick feed…';
    case 'disconnected':
      return 'Tick feed unreachable · retrying';
    case null:
      return '…';
    default:
      return 'Waiting for the first tick…';
  }
}

export function LiveView() {
  const { status, latestLtp, latestTimestamp, ticks, latestStraddle, straddles } = useLiveTicks();
  const { meta } = useMeta();
  const auth = useFyersAuthStatus();
  const now = useNow(1000);

  // A standalone Momentum preview also answers /api/meta, with a different payload: ignore it.
  const simulate = meta !== null && typeof meta.simulate === 'boolean' ? meta.simulate : null;
  const broker = typeof meta?.broker === 'string' ? meta.broker : '';
  const banner = tokenBanner({
    simulate,
    broker,
    authDegraded: meta?.authDegraded === true,
    fyersConfigured: auth.status?.configured === true,
    tokenState: auth.tokenState,
    msLeft: auth.msLeft,
  });

  const session = now ? marketSession(now) : null;
  const healthOf = (lastTickAt: number | null): FeedHealth | null =>
    now === null || session === null
      ? null
      : feedHealth({
          connection: status,
          lastTickAt,
          now: now.getTime(),
          marketOpen: session.state === 'open',
          simulate: simulate === true,
        });
  const indexHealth = healthOf(latestTimestamp);
  const straddleHealth = healthOf(latestStraddle?.timestamp ?? null);
  const indexView = indexHealth ? liveFeedView(indexHealth, simulate === true) : null;
  const straddleView = straddleHealth ? liveFeedView(straddleHealth, simulate === true) : null;

  // Memoised: the clock re-renders this every second, and the chart re-sets its data on change.
  const tickPoints = useMemo(() => ticks.map((t) => ({ time: t.time, value: t.ltp })), [ticks]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {now && session ? (
          <Badge tone={MARKET_TONE[session.state]}>
            <StatusDot
              tone={MARKET_TONE[session.state]}
              pulse={session.state === 'open'}
              label={session.label}
            />
            {describeMarketSession(now)} IST
          </Badge>
        ) : (
          <Badge tone="neutral">Market session…</Badge>
        )}
      </div>

      {banner ? <LiveFeedBanner banner={banner} /> : null}

      <Card>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-faint">
              NIFTY 50 index
            </p>
            {latestLtp !== null && latestTimestamp !== null ? (
              <>
                <p className="metric mt-1 text-4xl font-semibold tracking-tight text-foreground">
                  {formatNumber(latestLtp, 2)}
                </p>
                <p className="mt-1 text-xs text-faint">
                  Updated {now ? formatRelative(latestTimestamp, now) : '…'} ·{' '}
                  {formatIstTime(latestTimestamp, { seconds: true })} IST
                </p>
              </>
            ) : (
              <>
                <p className="metric mt-1 text-4xl font-semibold tracking-tight text-faint">––</p>
                <p className="mt-1 text-xs text-faint">{indexCaption(indexHealth)}</p>
              </>
            )}
          </div>
          {indexView ? <FeedBadge view={indexView} /> : null}
        </div>

        {ticks.length > 1 ? (
          <LiveLineChart
            points={tickPoints}
            height={180}
            series={0}
            ariaLabel={`NIFTY 50 index over the last ${formatInt(ticks.length)} ticks this session`}
            className="rounded-lg border border-border bg-surface-2/40 p-1"
          />
        ) : null}
      </Card>

      <StraddlePanel
        straddle={latestStraddle}
        history={straddles}
        health={straddleHealth}
        view={straddleView}
        now={now}
      />
    </div>
  );
}
