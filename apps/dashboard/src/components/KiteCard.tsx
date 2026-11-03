/**
 * KiteCard — the Zerodha Kite connection on Broker logins (BL-142). Kite holds the owner's
 * Momentum money; this repo only reads it (holdings and free cash for Your orders), never trades.
 *
 * Kite's token dies at 06:00 IST each day, so the owner logs in on a Friday before the 14:15
 * orders and on a Monday before the open (Telegram reminders at Fri 13:30 and Mon 08:45 say so
 * when it is missing). Log in opens Kite's own page; Kite sends the browser back to the hosted
 * dashboard's /api/momentum/kite/callback, which the dashboard forwards through the tunnel to the
 * Momentum API on the laptop. That keeps today's token and, when Kite is the holdings source,
 * reads the holdings at once. So the login works from a phone too.
 */

import { AlertCircle, CheckCircle2, ExternalLink, LogIn } from 'lucide-react';

import { usePolledResource } from '../hooks/usePolledResource';
import { apiPost } from '../lib/api';
import { formatInr, formatInt, formatIstDateTimeShort } from '../lib/format';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { StatusDot } from './ui/StatusDot';
import { toast } from './ui/Toast';

/** `GET /api/momentum/kite/status`. */
export interface KiteStatus {
  configured: boolean;
  connected: boolean;
  expiresAt: string | null;
  userId: string | null;
  holdingsSource: 'paper' | 'fyers' | 'kite';
  lastSnapshot: {
    syncedAt: string;
    cash: number | null;
    symbols: number;
    excluded: string[];
  } | null;
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-faint">
      {children}
    </code>
  );
}

/**
 * Open the tab inside the click (so no popup blocker stops it), then send it to Kite's login
 * page once the API has registered the login.
 */
async function startKiteLogin(): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  const response = await apiPost<{ url: string }>('/api/momentum/kite/login', {});
  if (!response.ok) {
    tab?.close();
    toast(`Could not start the Kite login: ${response.error}`, 'error');
    return;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = response.data.url;
  } else {
    window.location.assign(response.data.url);
  }
}

export function KiteCard() {
  const {
    data: status,
    loading,
    error,
  } = usePolledResource<KiteStatus>('/api/momentum/kite/status', { intervalMs: 60_000 });
  const snapshot = status?.lastSnapshot ?? null;

  return (
    <Card>
      <CardHeader
        title="Kite Connection"
        description="Read-only: your Momentum holdings and free cash for Your orders. Never places an order."
        icon={
          <StatusDot
            tone={!status?.configured ? 'neutral' : status.connected ? 'primary' : 'negative'}
            pulse={Boolean(status?.connected)}
          />
        }
        actions={
          status?.configured ? (
            <Button
              size="sm"
              variant={status.connected ? 'secondary' : 'primary'}
              onClick={() => void startKiteLogin()}
            >
              <LogIn className="h-3.5 w-3.5" />
              {status.connected ? 'Re-login' : 'Login with Kite'}
              <ExternalLink className="h-3 w-3 opacity-60" />
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        {loading && !status && <span className="text-sm text-muted">Checking connection…</span>}

        {status && !status.configured && (
          <>
            <Badge tone="neutral">Not configured</Badge>
            <p className="text-sm text-muted">
              Set <Code>KITE_API_KEY</Code> and <Code>KITE_API_SECRET</Code> in the repo{' '}
              <Code>.env</Code>. The Kite app&apos;s redirect URL is the hosted dashboard&apos;s{' '}
              <Code>/api/momentum/kite/callback</Code>.
            </p>
          </>
        )}

        {status?.configured && status.connected && (
          <>
            <Badge status="connected" dot>
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </Badge>
            {status.userId ? (
              <span className="text-sm text-muted">
                Account <span className="font-mono text-xs text-foreground">{status.userId}</span>
              </span>
            ) : null}
            {status.expiresAt ? (
              <span className="text-sm text-muted">
                until{' '}
                <span className="tabular-nums text-foreground">
                  {formatIstDateTimeShort(status.expiresAt)} IST
                </span>
              </span>
            ) : null}
          </>
        )}

        {status?.configured && !status.connected && (
          <>
            <Badge status="disconnected" dot>
              <AlertCircle className="h-3 w-3" />
              Not logged in today
            </Badge>
            <p className="text-sm text-muted">
              Kite logins last until 06:00 IST. Log in before Friday&apos;s 14:15 orders and
              Monday&apos;s open.
            </p>
          </>
        )}

        {status && status.holdingsSource !== 'kite' && (
          <p className="basis-full text-xs text-faint">
            Your orders read the {status.holdingsSource === 'paper' ? 'paper portfolio' : 'Fyers'}{' '}
            holdings now. Switch the source to Kite in Your orders › settings to use this account.
          </p>
        )}

        {snapshot && (
          <p className="basis-full text-sm text-muted">
            Last read {formatIstDateTimeShort(snapshot.syncedAt)} IST: {formatInt(snapshot.symbols)}{' '}
            holdings
            {snapshot.cash != null ? `, free cash ${formatInr(snapshot.cash)}` : ''}
            {snapshot.excluded.length
              ? `. Left out as options margin: ${snapshot.excluded.join(', ')}`
              : ''}
            .
          </p>
        )}

        {error && (
          <p className="basis-full text-sm text-negative">
            Could not check Kite status: {error}
            {status ? ' (showing the last known state)' : ''}
          </p>
        )}
      </div>
    </Card>
  );
}
