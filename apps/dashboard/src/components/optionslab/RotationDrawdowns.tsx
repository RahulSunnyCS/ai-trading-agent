/**
 * Rotation page → "Drawdown episodes": each time the focus list fell, how deep, for how long, how
 * fast it came back, what the fixed base did over the same days, and what the list was holding.
 *
 * Gross, per lot-day (a list holds 6 lots, or 8 with the Buy add-on). The series is the stored
 * results of the days the journal recorded and, for days before it began, the picks the rule
 * would have made; the two are counted apart. Read through `GET /legwise/rotation/drawdowns`
 * (`rotation/drawdowns.py` does every figure). A description of what was held, never a cause.
 */

import { useMemo, useState } from 'react';

import { useQueryState } from '../../hooks/useQueryState';
import { useRotationDrawdowns } from '../../hooks/useRotationDrawdowns';
import { formatDay, formatInr, formatInt } from '../../lib/format';
import {
  DEFAULT_DEPTH,
  DEPTH_OPTIONS,
  WINDOW_OPTIONS,
  areaPath,
  asDepth,
  asWindow,
  baseText,
  durationText,
  episodeSpans,
  geometry,
  linePath,
  readingLine,
} from '../../lib/rotationDrawdownsView';
import type { RotationListKey } from '../../types/rotation';
import type { DrawdownEpisode, RotationDrawdownsResponse } from '../../types/rotationDrawdowns';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { Select } from '../ui/Input';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';

function Chart({
  d,
  selected,
}: {
  d: RotationDrawdownsResponse;
  selected: number | null;
}) {
  const g = useMemo(() => geometry(d.series), [d.series]);
  const spans = useMemo(() => episodeSpans(d.series, d.episodes), [d.series, d.episodes]);
  const own = d.series.map((p) => p.underwater);
  const base = d.series.map((p) => p.base_underwater);
  const hasBase = base.some((v) => v !== null);
  const last = d.series.length - 1;
  return (
    <div>
      <svg
        viewBox={`0 0 ${g.width} ${g.height}`}
        className="w-full"
        role="img"
        aria-label={`Underwater chart for list ${d.list}: ${d.episodes.length} falls of at least ${d.min_depth} rupees per lot, worst ${Math.round(d.max_dd)} rupees per lot.`}
      >
        {g.ticks.map((t) => (
          <g key={t}>
            <line
              x1={g.left}
              x2={g.width - g.right}
              y1={g.y(t)}
              y2={g.y(t)}
              className={t === 0 ? 'stroke-border-strong' : 'stroke-border'}
            />
            <text x={g.left - 6} y={g.y(t) + 3} textAnchor="end" className="fill-faint text-[10px]">
              {t === 0 ? '0' : formatInr(t, { compact: true })}
            </text>
          </g>
        ))}
        {spans.map((s) => (
          <g key={s.n}>
            <rect
              x={g.x(s.from)}
              y={g.top}
              width={Math.max(g.x(s.to) - g.x(s.from), 2)}
              height={g.height - g.top - g.bottom}
              className={selected === s.n ? 'fill-primary/15' : 'fill-primary/5'}
            />
            {selected === s.n || g.x(s.to) - g.x(s.from) >= 14 ? (
              <text
                x={g.x(s.from) + 3}
                y={g.top + 10}
                className={`font-mono text-[10px] ${selected === s.n ? 'fill-foreground' : 'fill-muted'}`}
                pointerEvents="none"
              >
                {s.n}
              </text>
            ) : null}
          </g>
        ))}
        <path d={areaPath(own, g)} className="fill-primary/20" />
        {hasBase ? (
          <path
            d={linePath(base, g)}
            className="fill-none stroke-muted"
            strokeDasharray="4 3"
            strokeWidth={1.3}
          />
        ) : null}
        <path d={linePath(own, g)} className="fill-none stroke-primary" strokeWidth={1.8} />
        {d.series.map((p, i) => (
          <rect
            key={p.day}
            x={g.x(i) - 2}
            y={g.top}
            width={4}
            height={g.height - g.top - g.bottom}
            fill="transparent"
          >
            <title>
              {`${formatDay(p.day)} · ${p.source}: ${formatInr(p.underwater)} below peak${
                p.base_underwater === null ? '' : ` · base ${formatInr(p.base_underwater)}`
              }`}
            </title>
          </rect>
        ))}
        {last >= 0 ? (
          <>
            <text x={g.left} y={g.height - 6} className="fill-faint text-[10px]">
              {formatDay(d.series[0]?.day)}
            </text>
            <text
              x={g.width - g.right}
              y={g.height - 6}
              textAnchor="end"
              className="fill-faint text-[10px]"
            >
              {formatDay(d.series[last]?.day)}
            </text>
          </>
        ) : null}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-0.5 w-4 bg-primary" /> list {d.list}
        </span>
        {hasBase ? (
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0 w-4 border-t border-dashed border-muted" /> fixed base
          </span>
        ) : (
          <span>The fixed base has no results for these days.</span>
        )}
        <span>shaded and numbered: a fall of at least {formatInr(d.min_depth)} per lot</span>
      </div>
    </div>
  );
}

function EpisodeTable({
  d,
  selected,
  onSelect,
}: {
  d: RotationDrawdownsResponse;
  selected: number | null;
  onSelect: (n: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-faint">
            <th className="py-1.5 pr-2 font-medium">#</th>
            <th className="py-1.5 pr-3 font-medium">Peak</th>
            <th className="py-1.5 pr-3 font-medium">Trough</th>
            <th className="py-1.5 pr-3 font-medium">Back</th>
            <th className="py-1.5 pr-3 text-right font-medium">Depth / lot</th>
            <th className="py-1.5 pr-3 text-right font-medium">Basket</th>
            <th className="py-1.5 pr-3 font-medium">Length</th>
            <th className="py-1.5 pr-3 text-right font-medium">Base, same days</th>
            <th className="py-1.5 text-right font-medium">Stops</th>
          </tr>
        </thead>
        <tbody>
          {d.episodes.map((e) => (
            <tr
              key={e.n}
              className={`h-8 border-t border-border ${selected === e.n ? 'bg-primary/10' : ''}`}
            >
              <td className="py-1 pr-2">
                <button
                  type="button"
                  onClick={() => onSelect(e.n)}
                  aria-pressed={selected === e.n}
                  aria-label={`Show what drove episode ${e.n}`}
                  className="font-mono text-foreground underline-offset-2 hover:underline"
                >
                  {e.n}
                </button>
              </td>
              <td className="whitespace-nowrap py-1 pr-3 font-mono">
                {e.peak_day ? formatDay(e.peak_day) : 'start'}
              </td>
              <td className="whitespace-nowrap py-1 pr-3 font-mono">{formatDay(e.trough_day)}</td>
              <td className="whitespace-nowrap py-1 pr-3 font-mono">
                {e.open ? <Badge tone="warning">open</Badge> : formatDay(e.end_day)}
              </td>
              <td className="whitespace-nowrap py-1 pr-3 text-right font-mono text-negative">
                {formatInr(e.depth)}
              </td>
              <td className="whitespace-nowrap py-1 pr-3 text-right font-mono text-muted">
                {e.depth_basket === null ? '—' : formatInr(e.depth_basket)}
              </td>
              <td className="whitespace-nowrap py-1 pr-3 text-muted">{durationText(e)}</td>
              <td className="whitespace-nowrap py-1 pr-3 text-right font-mono">{baseText(e)}</td>
              <td className="whitespace-nowrap py-1 text-right font-mono">{formatInt(e.stops)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Drivers({ e }: { e: DrawdownEpisode }) {
  const top = Math.max(...e.drivers.map((r) => Math.abs(r.total)), 1);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Episode {e.n}: {e.peak_day ? formatDay(e.peak_day) : 'the start'} to{' '}
        {formatDay(e.trough_day)}, {formatInr(e.depth)} per lot, split by what the list held (family
        and start band).
      </p>
      <ul className="space-y-1.5">
        {e.drivers.slice(0, 8).map((r) => (
          <li
            key={`${r.kind}|${r.band}`}
            className="grid grid-cols-[10rem_minmax(0,1fr)_5.5rem] items-center gap-2 text-xs"
          >
            <span className="truncate text-foreground" title={r.label}>
              {r.label}
            </span>
            <div className="relative h-2.5 rounded bg-surface-2">
              <i className="absolute inset-y-0 left-1/2 w-px bg-border-strong" />
              <i
                className={`absolute inset-y-0 rounded ${
                  r.total < 0 ? 'right-1/2 bg-negative/70' : 'left-1/2 bg-positive/70'
                }`}
                style={{ width: `${(Math.abs(r.total) / top) * 50}%` }}
              />
            </div>
            <span
              className={`text-right font-mono ${r.total < 0 ? 'text-negative' : 'text-positive'}`}
              title={`${r.pick_days} pick-days`}
            >
              {formatInr(r.total, { sign: true })}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-faint">
        A description of what was held, not a cause: the same picks also made money elsewhere. The
        bars add up to the episode's depth.
      </p>
    </div>
  );
}

export function RotationDrawdowns({ list }: { list: RotationListKey }) {
  const [winQ, setWinQ] = useQueryState('ddwin');
  const [depthQ, setDepthQ] = useQueryState('dddepth');
  const window = asWindow(winQ);
  const minDepth = asDepth(depthQ);
  const res = useRotationDrawdowns({ list, window, minDepth });
  const d = res.data;
  const current =
    d !== null && d.list === list && d.window.id === window && d.min_depth === minDepth;
  const [picked, setPicked] = useState<number | null>(null);
  const deepest = d?.episodes.reduce<DrawdownEpisode | null>(
    (m, e) => (m === null || e.depth < m.depth ? e : m),
    null,
  );
  const shown = d?.episodes.find((e) => e.n === picked) ?? deepest ?? null;

  return (
    <Card>
      <CardHeader
        title="Drawdown episodes"
        description={`List ${list}, gross per lot-day: how deep each fall went, how long it took to come back, and what the fixed base did over the same days.`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={window}
              options={WINDOW_OPTIONS}
              onChange={(v) => setWinQ(v === 'P1' ? null : v)}
              ariaLabel="Window"
              size="sm"
            />
            <Select
              value={String(minDepth)}
              onChange={(e) =>
                setDepthQ(Number(e.target.value) === DEFAULT_DEPTH ? null : e.target.value)
              }
              aria-label="Smallest fall to list, rupees per lot"
              className="w-28"
            >
              {DEPTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  ≥ {o.label}
                </option>
              ))}
            </Select>
            <RefreshButton onClick={res.refetch} loading={res.loading} />
          </span>
        }
      />
      {res.error ? (
        <StateMessage
          variant="error"
          title="Could not read the drawdowns"
          description={res.error}
        />
      ) : d === null || !current ? (
        <SkeletonRows rows={5} />
      ) : d.n_days === 0 ? (
        <StateMessage
          variant="empty"
          title={
            window === 'forward' ? 'No scored forward sessions yet' : 'No sessions in this window'
          }
          description={
            window === 'forward'
              ? 'The card fills with the first on-time entry that has been scored by the 19:45 update.'
              : 'The history has no scored sessions for this list in the window.'
          }
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone="neutral">{`${formatInt(d.n_days)} sessions`}</Badge>
            {d.recorded_days > 0 ? (
              <Badge tone="primary">{`${d.recorded_days} recorded`}</Badge>
            ) : null}
            {d.reconstructed_days > 0 ? (
              <Badge tone="neutral">{`${d.reconstructed_days} reconstructed`}</Badge>
            ) : null}
            {d.left_out.late + d.left_out.waiting + d.left_out.no_entry > 0 ? (
              <span>
                left out: {d.left_out.late} late, {d.left_out.waiting} not yet scored,{' '}
                {d.left_out.no_entry} without an entry
              </span>
            ) : null}
          </div>
          <Chart d={d} selected={shown?.n ?? null} />
          {d.episodes.length > 0 && shown ? (
            <div className="space-y-5">
              <EpisodeTable d={d} selected={shown.n} onSelect={setPicked} />
              <div className="max-w-3xl">
                <Drivers e={shown} />
              </div>
            </div>
          ) : (
            <StateMessage
              variant="empty"
              title={`No fall reached ${formatInr(d.min_depth)} per lot`}
              description={`The deepest fall in this window was ${formatInr(d.max_dd)} per lot. Lower the threshold to list the smaller ones.`}
            />
          )}
          <p className="text-sm text-muted">{readingLine(d)}</p>
        </div>
      )}
    </Card>
  );
}
