/**
 * FyersAuthCard — shows the current Fyers OAuth token state and provides a
 * login button that opens the Fyers authorization URL in a new tab.
 *
 * States rendered:
 *  - Not configured → neutral badge, env-var hint, no login button
 *  - Connected      → `connected` badge, countdown + expiry time, secondary Re-login button
 *  - Expiring soon  → `attention` badge (two hours or less left), countdown, primary Login
 *  - Expired        → `failed` badge, when it expired, primary Login
 *  - No API token   → `disconnected` badge, primary Login
 *
 * After the user completes login in the new tab and switches back, the
 * useFyersAuthStatus focus-listener re-polls the status. That refetch (and the
 * 60 s poll) keeps the previous status on screen, so the badge and the Login
 * button stay put; only the very first load shows "Checking connection…".
 */

import { AlertCircle, AlertTriangle, CheckCircle2, ExternalLink, LogIn } from 'lucide-react';

import { useFyersAuthStatus } from '../hooks/useFyersAuthStatus';
import { formatIstDateTimeShort } from '../lib/format';
import { startFyersLogin } from '../lib/fyers-login';
import { formatCountdown } from '../lib/market';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { StatusDot } from './ui/StatusDot';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FyersAuthCard() {
  const { status, loading, error, tokenState, msLeft } = useFyersAuthStatus();

  const isConfigured = Boolean(status?.configured);
  const isConnected = tokenState === 'valid' || tokenState === 'expiring';
  const expiring = tokenState === 'expiring';
  // A primary button whenever logging in is the thing to do next.
  const loginIsPrimary = tokenState !== 'valid';

  const appId = status?.appId ? (
    <span className="text-sm text-muted">
      App: <span className="font-mono text-xs text-foreground">{status.appId}</span>
    </span>
  ) : null;

  return (
    <Card>
      <CardHeader
        title="Fyers Connection"
        description="OAuth token required for backfill and live market data"
        icon={
          <StatusDot
            tone={
              status === null || !isConfigured
                ? 'neutral'
                : tokenState === 'valid'
                  ? 'primary'
                  : expiring
                    ? 'warning'
                    : 'negative'
            }
            pulse={tokenState === 'valid'}
          />
        }
        actions={
          // Hidden only until the first status arrives; background refetches leave it alone.
          isConfigured ? (
            <Button
              size="sm"
              variant={loginIsPrimary ? 'primary' : 'secondary'}
              onClick={startFyersLogin}
            >
              <LogIn className="h-3.5 w-3.5" />
              {isConnected ? 'Re-login' : 'Login with Fyers'}
              <ExternalLink className="h-3 w-3 opacity-60" />
            </Button>
          ) : undefined
        }
      />

      {/* Status row */}
      <div className="flex flex-wrap items-center gap-3">
        {loading && <span className="text-sm text-muted">Checking connection…</span>}

        {!loading && status === null && <Badge tone="neutral">Unknown</Badge>}

        {status !== null && !isConfigured && (
          <>
            <Badge tone="neutral">Not configured</Badge>
            <p className="text-sm text-muted">
              Set{' '}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-xs font-mono text-faint">
                FYERS_APP_ID
              </code>{' '}
              and{' '}
              <code className="rounded bg-surface-2 px-1 py-0.5 text-xs font-mono text-faint">
                FYERS_APP_SECRET
              </code>{' '}
              on the server to enable Fyers login. The secret is never stored in this browser.
            </p>
          </>
        )}

        {status !== null && isConfigured && isConnected && (
          <>
            {expiring ? (
              <Badge status="attention" dot>
                <AlertTriangle className="h-3 w-3" />
                Expiring soon
              </Badge>
            ) : (
              <Badge status="connected" dot>
                <CheckCircle2 className="h-3 w-3" />
                Connected
              </Badge>
            )}
            {appId}
            {status.expiresAt && msLeft !== null && (
              <span className="text-sm text-muted">
                Expires in{' '}
                <span
                  className={
                    expiring ? 'tabular-nums text-warning' : 'tabular-nums text-foreground'
                  }
                >
                  {formatCountdown(msLeft)}
                </span>{' '}
                <span className="tabular-nums">
                  ({formatIstDateTimeShort(status.expiresAt)} IST)
                </span>
              </span>
            )}
            {expiring && (
              <p className="basis-full text-sm text-muted">
                Log in again before the market opens so the live feed and backfill keep working.
              </p>
            )}
          </>
        )}

        {status !== null && isConfigured && tokenState === 'expired' && (
          <>
            <Badge status="failed" dot>
              <AlertCircle className="h-3 w-3" />
              Expired
            </Badge>
            {appId}
            {status.expiresAt && !status.revoked && (
              <span className="text-sm text-muted">
                Expired{' '}
                <span className="tabular-nums text-foreground">
                  {formatIstDateTimeShort(status.expiresAt)} IST
                </span>
              </span>
            )}
            <p className="basis-full text-sm text-muted">
              {status.revoked
                ? 'Fyers no longer accepts this token. Click "Login with Fyers" to store a fresh one.'
                : 'Fyers tokens last until 06:00 IST the next morning. Click "Login with Fyers" to store a fresh one.'}
            </p>
          </>
        )}

        {status !== null && isConfigured && tokenState === 'missing' && (
          <>
            <Badge status="disconnected" dot>
              <AlertCircle className="h-3 w-3" />
              No API token
            </Badge>
            <p className="text-sm text-muted">
              {status.expiresAt
                ? 'The stored token belongs to a different app. Re-login with Fyers.'
                : 'Click "Login with Fyers" to authorise this app and store a fresh token.'}
            </p>
          </>
        )}

        {!loading && error && (
          <p className="basis-full text-sm text-negative">
            Could not check Fyers status: {error}
            {status !== null ? ' (showing the last known state)' : ''}
          </p>
        )}
      </div>
    </Card>
  );
}
