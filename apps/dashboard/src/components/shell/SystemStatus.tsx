import { type ReactNode, useEffect, useState } from 'react';

import { type FyersAuthState, useFyersAuthStatus } from '../../hooks/useFyersAuthStatus';
import { useMeta } from '../../hooks/useMeta';
import { usePaymentBalance } from '../../hooks/usePaymentBalance';
import { cn } from '../../lib/cn';
import { formatInt } from '../../lib/format';
import { startFyersLogin } from '../../lib/fyers-login';
import {
  type MarketState,
  describeMarketSession,
  formatCountdown,
  marketSession,
} from '../../lib/market';
import type { Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { StatusDot } from '../ui/StatusDot';

/** How often the market session is re-evaluated against the clock. */
const MARKET_TICK_MS = 30_000;

const MARKET_TONE: Record<MarketState, Tone> = {
  open: 'positive',
  pre_open: 'warning',
  closed: 'neutral',
};

const MARKET_TEXT: Record<MarketState, string> = {
  open: 'Open',
  pre_open: 'Pre-open',
  closed: 'Closed',
};

/** One entry of the cluster: a dot that is always there, and text from `md` up. */
function StatusItem({
  tone,
  pulse = false,
  label,
  title,
  children,
}: {
  tone: Tone;
  pulse?: boolean;
  /** What the dot means, for screen readers (and for everyone below `md`, with `title`). */
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={title}>
      <StatusDot tone={tone} pulse={pulse} label={label} />
      <span className="hidden md:inline" aria-hidden="true">
        {children}
      </span>
    </span>
  );
}

interface TokenView {
  tone: Tone;
  text: string;
  /** Full sentence for the tooltip and the accessible name. */
  title: string;
  /** False when a click could not lead anywhere (login not configured, status unknown). */
  canLogin: boolean;
}

function tokenView(auth: FyersAuthState, simulate: boolean, authDegraded: boolean): TokenView {
  const { status, tokenState, msLeft } = auth;
  if (status === null) {
    return auth.loading
      ? { tone: 'neutral', text: 'Token', title: 'Checking the Fyers token', canLogin: false }
      : {
          tone: 'neutral',
          text: 'Token unknown',
          title: 'Could not check the Fyers token',
          canLogin: false,
        };
  }
  if (!status.configured) {
    return {
      tone: 'neutral',
      text: 'No token',
      title: 'Fyers login is not configured on the server',
      canLogin: false,
    };
  }

  const countdown = msLeft !== null ? formatCountdown(msLeft) : null;
  switch (tokenState) {
    case 'valid':
      // The live feed can reject a token whose expiry still looks fine.
      return authDegraded && !simulate
        ? {
            tone: 'warning',
            text: 'Re-login required',
            title: 'The live feed rejected the Fyers token. Click to log in again',
            canLogin: true,
          }
        : {
            tone: 'primary',
            text: 'Connected',
            title: countdown
              ? `Fyers token connected, expires in ${countdown}. Click to log in again`
              : 'Fyers token connected. Click to log in again',
            canLogin: true,
          };
    case 'expiring':
      return {
        tone: 'warning',
        text: countdown ? `Expiring ${countdown}` : 'Expiring',
        title: countdown
          ? `Fyers token expires in ${countdown}. Click to log in again`
          : 'Fyers token expires soon. Click to log in again',
        canLogin: true,
      };
    case 'expired':
      return {
        tone: simulate ? 'neutral' : 'negative',
        text: 'Expired',
        title: 'Fyers token has expired. Click to log in',
        canLogin: true,
      };
    case 'missing':
      // Simulation needs no token, so its absence is not an alarm there.
      return {
        tone: simulate ? 'neutral' : 'negative',
        text: 'No token',
        title: simulate
          ? 'No Fyers token (not needed in simulation). Click to log in'
          : 'No Fyers token. Click to log in',
        canLogin: true,
      };
  }
}

/**
 * Always-on status cluster for the top bar: API reachability, market session, feed mode,
 * Fyers token (a button that starts the login) and credits. Every entry renders from the
 * first paint — nothing waits on /api/meta, and a failed poll shows as "API unreachable"
 * instead of an empty space. Below `md` only the dots show; each carries its meaning as an
 * accessible label and a tooltip.
 */
export function SystemStatus() {
  const { meta, loading: metaLoading, error: metaError } = useMeta();
  const auth = useFyersAuthStatus();
  const credits = usePaymentBalance();

  // Null until mounted: the session depends on the clock, which the server render and the
  // browser would not agree on at a session boundary.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), MARKET_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const apiDown = metaError !== null;
  const apiPending = !apiDown && meta === null && metaLoading;
  const session = now ? marketSession(now) : null;
  const simulate = meta?.simulate === true;
  const token = tokenView(auth, simulate, meta?.authDegraded === true);

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted md:gap-3">
      <StatusItem
        tone={apiDown ? 'negative' : apiPending ? 'neutral' : 'positive'}
        label={apiDown ? 'API unreachable' : apiPending ? 'Checking the API' : 'API reachable'}
        title={
          apiDown
            ? `API unreachable: ${metaError}`
            : apiPending
              ? 'Checking the API'
              : 'API reachable'
        }
      >
        {apiDown ? <span className="text-negative">API unreachable</span> : 'API'}
      </StatusItem>

      <StatusItem
        tone={session ? MARKET_TONE[session.state] : 'neutral'}
        pulse={session?.state === 'open'}
        label={session ? session.label : 'Market session'}
        title={now ? `${describeMarketSession(now)} IST` : 'Market session'}
      >
        {session ? MARKET_TEXT[session.state] : 'Market'}
      </StatusItem>

      {meta ? (
        <StatusItem
          tone={meta.simulate ? 'info' : meta.authDegraded ? 'warning' : 'positive'}
          label={
            meta.simulate
              ? 'Simulated feed'
              : meta.authDegraded
                ? 'Live feed degraded'
                : 'Live feed connected'
          }
          title={
            meta.simulate
              ? 'Simulated market data'
              : `Live market data${meta.broker ? ` from ${meta.broker}` : ''}${
                  meta.authDegraded ? ' (needs re-login)' : ''
                }`
          }
        >
          {meta.simulate ? 'Simulation' : 'Live'}
          {meta.broker ? (
            <span className="hidden text-faint xl:inline"> · {meta.broker}</span>
          ) : null}
        </StatusItem>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        onClick={startFyersLogin}
        disabled={!token.canLogin}
        aria-label={token.title}
        title={token.title}
        className={cn(
          '-mx-1 h-6 gap-1.5 whitespace-nowrap px-1 md:px-1.5',
          token.tone === 'negative' && 'text-negative hover:text-negative',
          token.tone === 'warning' && 'text-warning hover:text-warning',
        )}
      >
        <StatusDot tone={token.tone} />
        <span className="hidden tabular-nums md:inline">{token.text}</span>
      </Button>

      {credits.balance !== null ? (
        <span
          className="hidden whitespace-nowrap tabular-nums md:inline"
          title="Feature-token credits left"
        >
          {formatInt(credits.balance)} {credits.balance === 1 ? 'credit' : 'credits'}
        </span>
      ) : null}
    </div>
  );
}
