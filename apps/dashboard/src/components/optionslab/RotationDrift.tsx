/**
 * Rotation page → "Selection drift": is the focus list quietly turning into one family, one index
 * or one start time? The share of its core picks by family, index, strike method and start band
 * over P1, the last 63 and the last 21 sessions, and where the last 21 sit against the list's own
 * rolling-21-session range in P1.
 *
 * Picks, not P&L. A flag asks for a look and changes nothing. Read through
 * `GET /legwise/rotation/drift` (`rotation/drift.py` does every figure).
 */

import { useRotationDrift } from '../../hooks/useRotationDrift';
import { formatNumber } from '../../lib/format';
import {
  ROWS,
  ROW_LABEL,
  bandText,
  flagText,
  flagged,
  measureBand,
  measureValue,
  readingLine,
  spanText,
  tint,
} from '../../lib/rotationDriftView';
import type { RotationListKey } from '../../types/rotation';
import type { DriftDimension, RotationDriftResponse } from '../../types/rotationDrift';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';

function ShareBar({ d, row }: { d: DriftDimension; row: 'history' | 'last63' | 'last21' }) {
  const shares = d.shares[row];
  const counts = d.counts[row];
  const total = counts.reduce((s, c) => s + c, 0);
  const marked = flagged(d);
  if (total === 0) {
    return <div className="h-5 rounded border border-dashed border-border-strong" />;
  }
  return (
    <div
      className="flex h-5 overflow-hidden rounded border border-border"
      role="img"
      aria-label={d.categories
        .map((c, i) => `${c.label} ${formatNumber((shares[i] ?? 0) * 100, 0)}%`)
        .join(', ')}
    >
      {d.categories.map((c, i) => {
        const share = shares[i] ?? 0;
        if (share === 0) return null;
        const flag = row === 'last21' ? marked.get(c.key) : undefined;
        return (
          <i
            key={c.key}
            title={`${c.label}: ${counts[i] ?? 0} picks (${formatNumber(share * 100, 0)}%)${
              flag ? ` · ${flagText(flag)}` : ''
            }`}
            className={`flex items-center justify-center overflow-hidden whitespace-nowrap px-1 font-mono text-[10px] not-italic text-foreground ${
              flag ? 'ring-2 ring-inset ring-warning' : ''
            }`}
            style={{
              width: `${share * 100}%`,
              backgroundColor: `hsl(var(--primary) / ${tint(i, d.categories.length)})`,
            }}
          >
            {share >= 0.14 ? `${c.label} ${formatNumber(share * 100, 0)}%` : ''}
          </i>
        );
      })}
    </div>
  );
}

function Dimension({ d, data }: { d: DriftDimension; data: RotationDriftResponse }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-foreground">{d.label}</span>
        {d.flags.map((f) => (
          <Badge key={f.category} tone="warning">
            {flagText(f)}
          </Badge>
        ))}
      </div>
      {ROWS.map((row) => (
        <div key={row} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
          <span className="text-[11px] text-muted" title={spanText(data, row)}>
            {ROW_LABEL[row]}
          </span>
          <ShareBar d={d} row={row} />
        </div>
      ))}
    </div>
  );
}

function Concentration({ d }: { d: RotationDriftResponse }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-faint">
          <th className="py-1.5 pr-3 font-medium">Measure</th>
          <th className="py-1.5 pr-3 text-right font-medium">Last {d.short}</th>
          <th className="py-1.5 text-right font-medium">Its usual range</th>
        </tr>
      </thead>
      <tbody>
        {d.concentration.map((m) => (
          <tr
            key={m.key}
            className={`h-8 border-t border-border ${m.flag ? 'bg-warning/10' : ''}`}
            title={m.note}
          >
            <td className="py-1 pr-3 text-foreground">{m.label}</td>
            <td className="whitespace-nowrap py-1 pr-3 text-right font-mono text-foreground">
              {measureValue(m)}
            </td>
            <td className="whitespace-nowrap py-1 text-right font-mono text-muted">
              {measureBand(m)}
              {m.flag ? <span className="ml-1.5 text-warning">{m.flag}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RotationDrift({ list }: { list: RotationListKey }) {
  const res = useRotationDrift(list);
  const d = res.data;
  const current = d !== null && d.list === list;
  return (
    <Card>
      <CardHeader
        title="Selection drift"
        description={`List ${list}: what its core picks have been, by family, index, strike method and start band, against its own range in P1. Counts picks, not P&L.`}
        actions={
          <span className="flex items-center gap-2">
            {current && d.flags > 0 ? (
              <Badge tone="warning">{`${d.flags} outside its range`}</Badge>
            ) : null}
            <RefreshButton onClick={res.refetch} loading={res.loading} />
          </span>
        }
      />
      {res.error ? (
        <StateMessage variant="error" title="Could not read the picks" description={res.error} />
      ) : d === null || !current ? (
        <SkeletonRows rows={5} />
      ) : d.windows.last21.n_days === 0 ? (
        <StateMessage
          variant="empty"
          title="No picks to count yet"
          description="The card fills once the history has been re-scored or the first entry is recorded."
        />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              {d.dimensions.map((dim) => (
                <Dimension key={dim.key} d={dim} data={d} />
              ))}
              <p className="text-[11px] text-faint">
                {d.history_label}, re-scored. An outlined segment is outside the list's own rolling-
                {d.short}-session range ({d.band_percentiles[0]}th to {d.band_percentiles[1]}th
                percentile over {d.rolling_windows} windows).
              </p>
            </div>
            <div className="self-start">
              <Concentration d={d} />
            </div>
          </div>
          <p className="text-sm text-muted">{readingLine(d)}</p>
        </div>
      )}
    </Card>
  );
}
