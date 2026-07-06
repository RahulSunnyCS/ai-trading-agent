/**
 * FyersAuthCard — shows the current Fyers OAuth token state and provides a
 * login button that opens the Fyers authorization URL in a new tab.
 *
 * States rendered:
 *  - Not configured  → neutral badge, env-var hint, no login button
 *  - Connected       → positive badge, token expiry time, secondary Re-login button
 *  - Disconnected    → negative badge, primary Login button
 *
 * After the user completes login in the new tab and switches back, the
 * useFyersAuthStatus focus-listener automatically re-polls the status — no
 * extra logic needed here.
 */

import { AlertCircle, CheckCircle2, ExternalLink, LogIn } from 'lucide-react';

import { useFyersAuthStatus } from '../hooks/useFyersAuthStatus.js';
import { apiGet } from '../lib/api.js';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { StatusDot } from './ui/StatusDot';

// ---------------------------------------------------------------------------
// Date formatter — IST, matching BackfillView / RegimeView pattern
// ---------------------------------------------------------------------------

const expiryFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatExpiry(iso: string): string {
  return expiryFmt.format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Login action — fetches the OAuth URL and opens it in a new tab
// ---------------------------------------------------------------------------

async function openFyersLogin(): Promise<void> {
  const result = await apiGet<{ url: string; state: string }>('/api/auth/fyers/login');
  if (!result.ok) {
    // Surface error to the console; the UI re-polls on focus so the user can
    // retry by clicking the button again after the issue resolves.
    console.error(`[FyersAuthCard] Failed to get login URL: ${result.error}`);
    return;
  }
  // noopener,noreferrer: prevents the new tab from accessing window.opener,
  // closing the tab reference leak from OAuth redirect pages.
  window.open(result.data.url, '_blank', 'noopener,noreferrer');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FyersAuthCard() {
  const { status, loading } = useFyersAuthStatus();

  const isConnected = status?.connected && !status.needsReauth;
  const isConfigured = status?.configured;

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
                  onClick={() => void openFyersLogin()}
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
                FYERS_ACCESS_TOKEN
              </code>{' '}
              in your environment to enable Fyers integration.
            </p>
          </>
        )}

        {!loading && status !== null && isConfigured && isConnected && (
          <>
            <Badge tone="positive" dot>
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
                  {formatExpiry(status.expiresAt)} IST
                </span>
              </span>
            )}
          </>
        )}

        {!loading && status !== null && isConfigured && !isConnected && (
          <>
            <Badge tone="negative" dot>
              <AlertCircle className="h-3 w-3" />
              {status.needsReauth ? 'Token expired' : 'Disconnected'}
            </Badge>
            <p className="text-sm text-muted">
              {status.degraded
                ? 'Auth failure detected — token may have expired. Click Login to re-authenticate.'
                : 'Click "Login with Fyers" to authorise this app and store a fresh token.'}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
