/**
 * AngelOneCard — the Angel One SmartAPI connection on Broker logins, beside the Fyers card.
 *
 * Angel One has no OAuth redirect: the backend logs in over REST with the credentials in the
 * repo .env, so there is nothing to log in to here. The card shows which settings are present
 * (names only), the last connection check (the 08:00 job's or a Test connection's), the last
 * collection that came from Angel One, and a Test connection button that makes ONE login now.
 * The server allows one test at a time and one a minute; the button is disabled while a test
 * runs and through that cool-down.
 */

import { AlertCircle, CheckCircle2, PlugZap } from 'lucide-react';

import { useAngelOneConnection } from '../hooks/useAngelOneConnection';
import { useNow } from '../hooks/useNow';
import {
  type AngelCheck,
  type AngelStatus,
  REASON_LABEL,
  SOURCE_LABEL,
  STATE_BADGE,
  STATE_DOT,
  angelCardState,
  cooldownEndsAt,
  newestCheck,
  testButton,
} from '../lib/angelOne';
import { formatDay, formatDuration, formatIstDateTimeShort } from '../lib/format';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { StatusDot } from './ui/StatusDot';

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-faint">
      {children}
    </code>
  );
}

/** The button is a small leaf with its own 1 s clock, so the countdown re-renders only it. */
function TestButton({
  status,
  receivedAt,
  testing,
  onTest,
}: {
  status: AngelStatus;
  receivedAt: number;
  testing: boolean;
  onTest: () => void;
}) {
  const now = useNow(1000);
  const button = testButton({
    configured: status.configured,
    testing,
    running: status.running,
    endsAtMs: cooldownEndsAt(status, receivedAt),
    nowMs: now ? now.getTime() : receivedAt,
  });
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={onTest}
      disabled={button.disabled}
      loading={testing}
      title={
        button.secondsLeft > 0
          ? 'Angel One limits logins: one test a minute.'
          : 'Makes one Angel One login now. Nothing is fetched or traded.'
      }
    >
      {testing ? null : <PlugZap className="h-3.5 w-3.5" />}
      {button.label}
    </Button>
  );
}

function CheckLine({ check }: { check: AngelCheck }) {
  return (
    <div className="basis-full space-y-1 text-sm">
      <p className="text-muted">
        Last check{' '}
        <span className="tabular-nums text-foreground">
          {formatIstDateTimeShort(check.checked_at, { seconds: true })} IST
        </span>{' '}
        · {SOURCE_LABEL[check.source]}
        {check.attempted && <> · {formatDuration(check.duration_ms)}</>}
        {check.ok ? (
          <span className="text-positive"> · {REASON_LABEL.ok}</span>
        ) : (
          <span className="text-negative"> · {REASON_LABEL[check.reason]}</span>
        )}
      </p>
      {!check.ok && <p className="text-negative">{check.message}</p>}
    </div>
  );
}

export function AngelOneCard() {
  const { status, loading, error, receivedAt, testing, testResult, testError, test } =
    useAngelOneConnection();

  const check = newestCheck(testResult, status?.last_check ?? null);
  const state = angelCardState(status, check);
  const badge = STATE_BADGE[state];
  const missing = status?.credentials.filter((c) => c.required && !c.set) ?? [];

  return (
    <Card>
      <CardHeader
        title="Angel One Connection"
        description="SmartAPI login used by the evening collection when Fyers is not logged in"
        icon={<StatusDot tone={STATE_DOT[state]} pulse={state === 'working'} />}
        actions={
          status?.configured ? (
            <TestButton
              status={status}
              receivedAt={receivedAt}
              testing={testing}
              onTest={() => void test()}
            />
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        {loading && <span className="text-sm text-muted">Checking connection…</span>}

        {!loading && (
          <Badge tone={badge.tone} dot>
            {state === 'working' && <CheckCircle2 className="h-3 w-3" />}
            {state === 'failed' && <AlertCircle className="h-3 w-3" />}
            {badge.label}
          </Badge>
        )}

        {status?.client && (
          <span className="text-sm text-muted">
            Client: <span className="font-mono text-xs text-foreground">{status.client}</span>
          </span>
        )}

        {status !== null && !status.configured && (
          <p className="text-sm text-muted">
            Set the{' '}
            {missing.length === 1 ? 'missing setting' : `${missing.length} missing settings`} below
            in the server's <Code>.env</Code> to enable the Angel One login. Values are never shown
            here.
          </p>
        )}

        {status?.configured && !check && (
          <p className="text-sm text-muted">
            No connection check recorded yet. The 08:00 check runs on trading days, or use Test
            connection.
          </p>
        )}

        {check && <CheckLine check={check} />}

        {testError && <p className="basis-full text-sm text-negative">{testError}</p>}

        {status?.last_collection && (
          <p className="basis-full text-sm text-muted">
            Last collection from Angel One:{' '}
            <span className="tabular-nums text-foreground">
              {formatDay(status.last_collection.trading_day)}
            </span>{' '}
            ({status.last_collection.status})
          </p>
        )}

        {status !== null && (
          <ul className="flex basis-full flex-wrap gap-2" aria-label="Angel One settings">
            {status.credentials.map((c) => (
              <li key={c.name} className="flex items-center gap-1.5 text-xs">
                <Code>{c.name}</Code>
                {c.set ? (
                  <Badge tone="positive">set</Badge>
                ) : (
                  <Badge tone={c.required ? 'negative' : 'neutral'}>
                    {c.required ? 'missing' : 'optional'}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}

        {status?.warning && <p className="basis-full text-sm text-warning">{status.warning}</p>}

        {!loading && error && (
          <p className="basis-full text-sm text-negative">
            Could not check Angel One status: {error}
            {status !== null ? ' (showing the last known state)' : ''}
          </p>
        )}
      </div>
    </Card>
  );
}
