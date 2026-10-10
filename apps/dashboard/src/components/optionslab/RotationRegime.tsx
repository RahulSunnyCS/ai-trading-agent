/**
 * Rotation page → "Forward days vs research periods": what kind of market did the forward window
 * test? The opening-VIX, days-to-expiry and weekday mix of the forward days beside P1, P2 and P3,
 * with the VIX open and each index's day range, and how near the forward mix is to each period.
 *
 * Describes; tests nothing. The mixes come from `GET /legwise/rotation/regime`
 * (`rotation/regime.py`); P3 is not in the rotation store and is shown as unavailable. Nothing on
 * this card changes a list, a weight or the journal.
 */

import { useRotationRegime } from '../../hooks/useRotationRegime';
import { formatDay, formatInt, formatNumber } from '../../lib/format';
import {
  PERIOD_SHORT,
  closerText,
  quantileText,
  readingLine,
  segmentTitle,
  shade,
  shares,
} from '../../lib/rotationRegimeView';
import type {
  RegimePeriod,
  RegimeRowKey,
  RotationRegimeResponse,
} from '../../types/rotationRegime';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';

const COLUMNS = ['P1', 'P2', 'P3', 'forward'] as const;

function ColumnHead({ p }: { p: RegimePeriod }) {
  return (
    <div className="min-w-0 text-xs">
      <div className="font-medium text-foreground">{PERIOD_SHORT[p.id]}</div>
      <div className="truncate text-faint" title={p.label}>
        {p.status === 'ok'
          ? `${formatInt(p.n)} sessions`
          : p.status === 'unavailable'
            ? 'not in the store'
            : 'no sessions yet'}
      </div>
      {p.status === 'ok' && p.from && p.to ? (
        <div className="truncate font-mono text-[10px] text-faint">
          {formatDay(p.from)} – {formatDay(p.to)}
        </div>
      ) : null}
    </div>
  );
}

function MixBar({ p, row }: { p: RegimePeriod; row: RegimeRowKey }) {
  const mix = p.mix?.[row];
  if (p.status !== 'ok' || !mix) {
    return (
      <div
        className="h-5 rounded border border-dashed border-border-strong"
        title={p.reason ?? ''}
        aria-label={p.status === 'unavailable' ? 'not available' : 'no sessions yet'}
      />
    );
  }
  const frac = shares(mix);
  return (
    <div
      className="flex h-5 overflow-hidden rounded border border-border"
      role="img"
      aria-label={mix.categories
        .map((c, i) => `${c} ${formatNumber((frac[i] ?? 0) * 100, 0)}%`)
        .join(', ')}
    >
      {mix.categories.map((c, i) => {
        const f = frac[i] ?? 0;
        if (f === 0) return null;
        return (
          <i
            key={c}
            title={segmentTitle(c, mix.counts[i] ?? 0, f)}
            className="flex items-center justify-center overflow-hidden bg-primary font-mono text-[10px] not-italic text-foreground"
            style={{ width: `${f * 100}%`, opacity: shade(i, mix.categories.length) }}
          >
            {f >= 0.09 ? formatNumber(f * 100, 0) : ''}
          </i>
        );
      })}
    </div>
  );
}

function Grid({ d }: { d: RotationRegimeResponse }) {
  const byId = new Map(d.periods.map((p) => [p.id, p]));
  const periods = COLUMNS.map((id) => byId.get(id)).filter((p): p is RegimePeriod => !!p);
  const cols = 'grid grid-cols-[9.5rem_repeat(4,minmax(8rem,1fr))] items-center gap-x-3 gap-y-2';
  const text = (label: string, pick: (p: RegimePeriod) => string) => (
    <>
      <span className="text-xs text-muted">{label}</span>
      {periods.map((p) => (
        <span key={p.id} className="font-mono text-[11px] text-foreground">
          {p.status === 'ok' ? pick(p) : '—'}
        </span>
      ))}
    </>
  );
  return (
    <div className="overflow-x-auto">
      <div className={`${cols} min-w-[48rem]`}>
        <span />
        {periods.map((p) => (
          <ColumnHead key={p.id} p={p} />
        ))}
        {d.rows.map((r) => (
          <div key={r.key} className="contents">
            <span className="text-xs text-muted">{r.label}</span>
            {periods.map((p) => (
              <MixBar key={p.id} p={p} row={r.key} />
            ))}
          </div>
        ))}
        {text('VIX open · P10 · P50 · P90', (p) => quantileText(p.vix_open, 1))}
        {text('NIFTY day range', (p) => quantileText(p.range?.NIFTY ?? null, 2, '%'))}
        {text('SENSEX day range', (p) => quantileText(p.range?.SENSEX ?? null, 2, '%'))}
      </div>
      <p className="mt-3 text-[11px] text-faint">
        Share of sessions, in percent; the number shows on a segment of 9% or more and the tooltip
        gives every count. Categories run light to dark in the order of the row’s own scale. Day
        range: {d.range_definition}.
      </p>
    </div>
  );
}

function Distances({ d }: { d: RotationRegimeResponse }) {
  const research = d.distances ? Object.keys(d.distances.overall) : [];
  return (
    <div className="space-y-3">
      {d.distances === null ? (
        <StateMessage
          variant="empty"
          title="No forward sessions yet"
          description="The forward column fills with the first on-time entry (Mon 12 Oct, 09:16). Until then the research periods are shown on their own."
        />
      ) : (
        <>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-faint">
                <th className="py-1.5 pr-3 font-medium">Measure</th>
                {research.map((id) => (
                  <th key={id} className="py-1.5 pr-3 text-right font-medium">
                    to {PERIOD_SHORT[id] ?? id}
                  </th>
                ))}
                <th className="py-1.5 text-right font-medium">Nearer</th>
              </tr>
            </thead>
            <tbody>
              {d.distances.rows.map((r) => (
                <tr key={r.key} className="h-8 border-t border-border">
                  <td className="py-1 pr-3 text-foreground">{r.label}</td>
                  {research.map((id) => (
                    <td key={id} className="py-1 pr-3 text-right font-mono text-foreground">
                      {r.to[id] === null || r.to[id] === undefined
                        ? '—'
                        : formatNumber(r.to[id] ?? null, 2)}
                    </td>
                  ))}
                  <td className="py-1 text-right text-muted">{closerText(r.closer)}</td>
                </tr>
              ))}
              <tr className="h-8 border-t border-border-strong font-medium">
                <td className="py-1 pr-3 text-foreground">Average</td>
                {research.map((id) => (
                  <td key={id} className="py-1 pr-3 text-right font-mono text-foreground">
                    {d.distances?.overall[id] === null || d.distances?.overall[id] === undefined
                      ? '—'
                      : formatNumber(d.distances.overall[id] ?? null, 2)}
                  </td>
                ))}
                <td className="py-1 text-right text-foreground">
                  {closerText(d.distances.closer)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="text-[11px] text-faint">
            Distance: half the summed difference of the shares. 0 is the same mix, 1 shares nothing.
          </p>
        </>
      )}
    </div>
  );
}

export function RotationRegime() {
  const res = useRotationRegime();
  const d = res.data;
  return (
    <Card>
      <CardHeader
        title="Forward days vs research periods"
        description="What kind of market did the forward window test: the same mix as the period the weights were chosen on, or the one they were confirmed on?"
        actions={
          <span className="flex items-center gap-2">
            {d?.thin ? (
              <Badge tone="warning">{`${d.forward_days} of ${d.thin_days} sessions`}</Badge>
            ) : null}
            <RefreshButton onClick={res.refetch} loading={res.loading} />
          </span>
        }
      />
      {res.error && d === null ? (
        <StateMessage variant="error" title="Could not read the periods" description={res.error} />
      ) : d === null ? (
        <SkeletonRows rows={5} />
      ) : (
        <div className="space-y-4">
          {res.error ? (
            <StateMessage
              variant="error"
              title="The periods could not be refreshed"
              description={`Showing the last response. ${res.error}`}
            />
          ) : null}
          <Grid d={d} />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <Distances d={d} />
            <div className="space-y-2 text-sm text-muted">
              <p>{readingLine(d)}</p>
              <p className="text-xs text-faint">
                A days-to-expiry fit learnt in one period describes a different weekday in another
                when the expiry calendar changed, so that row can differ across periods without the
                market being different. P3 (2022–24, NIFTY only) is not in the rotation store and is
                not filled in.
              </p>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
