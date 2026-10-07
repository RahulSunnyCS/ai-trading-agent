/**
 * The ATM straddle as pushed over /ws/ticks every ~15 s: value, how old it is, a sparkline of
 * the values received this session, the legs, and the momentum figures the signal engine uses.
 */

import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';

import type { StraddlePoint, StraddleSnapshot } from '../../hooks/useLiveTicks';
import { formatInt, formatIstTime, formatNumber, formatPct, formatPp } from '../../lib/format';
import { type FeedView, STRADDLE_INTERVAL_MS } from '../../lib/live';
import type { FeedHealth } from '../../lib/overview';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { InfoTooltip } from '../ui/InfoTooltip';
import { StatusDot } from '../ui/StatusDot';
import { UpdatedAgo } from './LiveClock';
import { LiveLineChart } from './LiveLineChart';

const HINTS = {
  atm: 'The strike nearest the index, rounded to the strike step; the straddle is this strike’s call plus put.',
  ce: 'Last traded price of the ATM call option (CE).',
  pe: 'Last traded price of the ATM put option (PE).',
  roc: 'Rate of change: the percent change in straddle value since the previous 15-second snapshot.',
  accel:
    'Acceleration: this snapshot’s rate of change minus the previous one’s, in percentage points; negative while an expansion is running out of steam.',
} as const;

function Leg({
  label,
  hint,
  value,
  valueClass = 'text-foreground',
}: {
  label: string;
  hint: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 px-3 py-2">
      <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-faint">
        {label}
        <InfoTooltip text={hint} label={`About ${label}`} />
      </div>
      <div className={`metric mt-0.5 text-sm font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

function Momentum({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <InfoTooltip text={hint} label={`About ${label}`} />
      <span className="metric text-foreground">{children}</span>
    </span>
  );
}

function emptyText(health: FeedHealth | null): { title: string; detail: string } {
  const every = `every ${formatInt(STRADDLE_INTERVAL_MS / 1000)} s`;
  switch (health) {
    case 'idle':
      return {
        title: 'Market closed',
        detail: `Straddle snapshots arrive ${every} while the market is open.`,
      };
    case 'connecting':
    case 'disconnected':
      return { title: 'Tick feed not connected', detail: 'The straddle shows once it reconnects.' };
    default:
      return {
        title: 'Waiting for the first straddle snapshot…',
        detail: `Snapshots arrive ${every} once the calculator runs.`,
      };
  }
}

export function StraddlePanel({
  straddle,
  history,
  health,
  view,
}: {
  straddle: StraddleSnapshot | null;
  history: readonly StraddlePoint[];
  /** Health of the straddle feed (null until the clock has started). */
  health: FeedHealth | null;
  view: FeedView | null;
}) {
  const empty = emptyText(health);
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">ATM straddle</h2>
        {view && straddle !== null ? (
          <Badge tone={view.tone}>
            <StatusDot tone={view.tone} pulse={view.pulse} />
            {view.label}
          </Badge>
        ) : null}
      </div>

      {straddle === null ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/50 px-3 py-2.5">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
          <div>
            <p className="text-sm text-muted">{empty.title}</p>
            <p className="mt-0.5 text-xs text-faint">{empty.detail}</p>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="metric text-3xl font-semibold tracking-tight text-foreground">
              {formatNumber(straddle.straddleValue, 2)}
            </p>
            <p className="text-xs text-faint">
              Updated <UpdatedAgo at={straddle.timestamp} /> ·{' '}
              {formatIstTime(straddle.timestamp, { seconds: true })} IST
            </p>
          </div>

          {history.length > 1 ? (
            <LiveLineChart
              points={history}
              height={64}
              series={1}
              axes={false}
              ariaLabel={`Straddle value over the last ${formatInt(history.length)} snapshots this session`}
              className="mt-3"
            />
          ) : null}

          <div className="mt-3 grid grid-cols-3 gap-2">
            <Leg label="ATM" hint={HINTS.atm} value={formatInt(straddle.atmStrike)} />
            <Leg
              label="CE"
              hint={HINTS.ce}
              value={formatNumber(straddle.cePrice, 2)}
              valueClass="text-info"
            />
            <Leg
              label="PE"
              hint={HINTS.pe}
              value={formatNumber(straddle.pePrice, 2)}
              valueClass="text-accent"
            />
          </div>

          {straddle.roc !== undefined ? (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <Momentum label="ROC" hint={HINTS.roc}>
                {formatPct(straddle.roc, 2, { sign: true, unit: 'percent' })} per snapshot
              </Momentum>
              {straddle.acceleration !== undefined ? (
                <Momentum label="Accel" hint={HINTS.accel}>
                  {formatPp(straddle.acceleration, 2, { unit: 'percent' })}
                </Momentum>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
