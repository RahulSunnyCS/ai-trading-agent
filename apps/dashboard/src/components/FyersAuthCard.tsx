/**
 * FyersAuthCard — shows the current Fyers OAuth token state and provides a
 * login button that opens the Fyers authorization URL in a new tab.
 *
 * States rendered:
 *  - Not configured  → neutral badge, env-var hint, no login button
 *  - Connected       → `connected` status badge, token expiry time, secondary Re-login button
 *  - Disconnected    → negative badge, primary Login button
 *
 * After the user completes login in the new tab and switches back, the
 * useFyersAuthStatus focus-listener automatically re-polls the status — no
 * extra logic needed here.
 */

import { AlertCircle, CheckCircle2, ExternalLink, LogIn } from 'lucide-react';

import { useFyersAuthStatus } from '../hooks/useFyersAuthStatus';
import { formatIstDateTimeShort } from '../lib/format';
import { startFyersLogin } from '../lib/fyers-login';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { StatusDot } from './ui/StatusDot';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FyersAuthCard() {
  const { status, loading, error } = useFyersAuthStatus();

  const isConnected = Boolean(status?.connected && !status.needsReauth);
  const isConfigured = Boolean(status?.configured);

  return (
    <Card>
      <CardHeader
        title="Fyers Connection"
        description="OAuth token required for backfill and live market data"
        icon={
          <StatusDot
            tone={
              isConnected ? 'positive' : status !== null && !isConfigured ? 'neutral' : 'negative'
            }
            pulse={isConnected}
          />
        }
        actions={
          // Show nothing while loading to avoid flicker
          loading ? undefined : (
            <>
              {isConfigured && (
                <Button
                  size="sm"
                  variant={isConnected ? 'secondary' : 'primary'}
                  onClick={startFyersLogin}
                >
                  <LogIn className="h-3.5 w-3.5" />
                  {isConnected ? 'Re-login' : 'Login with Fyers'}
                  <ExternalLink className="h-3 w-3 opacity-60" />
                </Button>
              )}
            </>
          )
        }
      />

      {/* Status row */}
      <div className="flex flex-wrap items-center gap-3">
        {loading && <span className="text-sm text-muted">Checking connection…</span>}

        {!loading && error && (
          <p className="text-sm text-negative">Could not check Fyers status: {error}</p>
        )}

        {!loading && status === null && <Badge tone="neutral">Unknown</Badge>}

        {!loading && status !== null && !isConfigured && (
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

        {!loading && status !== null && isConfigured && isConnected && (
          <>
            <Badge status="connected" dot>
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </Badge>
            {status.appId && (
              <span className="text-sm text-muted">
                App: <span className="font-mono text-xs text-foreground">{status.appId}</span>
              </span>
            )}
            {status.expiresAt && (
              <span className="text-sm text-muted">
                Expires{' '}
                <span className="tabular-nums text-foreground">
                  {formatIstDateTimeShort(status.expiresAt)} IST
                </span>
              </span>
            )}
          </>
        )}

        {!loading && status !== null && isConfigured && !isConnected && (
          <>
            <Badge tone="negative" dot>
              <AlertCircle className="h-3 w-3" />
              No API token
            </Badge>
            <p className="text-sm text-muted">
              {status.degraded
                ? 'The token is missing, expired, or belongs to a different app. Re-login with Fyers.'
                : 'Click "Login with Fyers" to authorise this app and store a fresh token.'}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
