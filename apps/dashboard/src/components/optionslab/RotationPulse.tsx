'use client';

/**
 * Options Lab → Rotation → Family pulse: "is morning short-premium working right now?".
 *
 * Twelve cells, the ones the family-band criterion pools: {Widesl, Dir, Buy} x start band, across
 * both indices and every strike. Per cell: the mean gross per lot-day over the last 5 / 21 / 63
 * sessions with P1 and P2 for reference (each beside its sessions and variants), a rolling-21
 * sparkline with the P1 mean dashed, the rank the ranking gives the cell for the next 09:16 pick,
 * the chips of where the latest picks fall, and how often the focus list picks there.
 *
 * Figures come from `GET /legwise/rotation/pulse` (`rotation/pulse.py`), read-only: gross rupees
 * per ONE lot of one strategy, a mean of the pooled variant-days, never summed. A window with no
 * stored result shows a dash and why. Nothing here changes a list, a weight or the journal.
 */

import { useMemo, useState } from 'react';

import { navigateToLink } from '../../hooks/useQueryState';
import { useRotationPulse } from '../../hooks/useRotationPulse';
import { cn } from '../../lib/cn';
import { EMPTY, formatDay, formatInr, formatInt } from '../../lib/format';
import {
  type Figure,
  WINDOW_KEYS,
  asOfLine,
  bandText,
  chipGroups,
  criterionNote,
  figure,
  flagNote,
  flagView,
  isShort,
  matrixHref,
  nearestIndex,
  picksHeader,
  rankView,
  shareView,
  sourceLine,
  sparkGeometry,
  unavailableView,
} from '../../lib/rotationPulseView';
import type {
  PulseAvailable,
  PulseCell,
  PulseIndex,
  PulseListKey,
} from '../../types/rotationPulse';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { InfoTooltip } from '../ui/InfoTooltip';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

const INDEX_OPTIONS: SegmentedOption<PulseIndex>[] = [
  { value: 'both', label: 'Both' },
  { value: 'NIFTY', label: 'NIFTY' },
  { value: 'SENSEX', label: 'SENSEX' },
];

const TONE_CLASS = {
  positive: 'text-positive',
  negative: 'text-negative',
  neutral: 'text-foreground',
} as const;

const SPARK_W = 88;
const SPARK_H = 28;

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function FigureCell({ f, short }: { f: Figure; short?: boolean }) {
  return (
    <Td dense align="right" numeric title={f.title}>
      <span className={cn('whitespace-nowrap', TONE_CLASS[f.tone])}>
        {f.text}
        {f.counts ? (
          <span className="ml-1.5 text-xs text-faint">
            {f.counts}
            {short ? '*' : ''}
          </span>
        ) : null}
      </span>
    </Td>
  );
}

/** The rolling-21 line over up to 126 sessions with the P1 mean dashed; hover reads one point. */
function Sparkline({ cell }: { cell: PulseCell }) {
  const spark = cell.spark;
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(
    () => (spark ? sparkGeometry(spark.values, spark.p1_mean, SPARK_W, SPARK_H) : null),
    [spark],
  );
  if (!spark || !geo || geo.path === '') {
    return <span className="text-xs text-faint">{EMPTY}</span>;
  }
  const last = spark.values.length - 1;
  const at = hover ?? last;
  const value = spark.values[at];
  const day = spark.days[at];
  const x = geo.xs[at];
  const y = geo.ys[at];
  const label = `${cell.label}: rolling 21-session mean gross, ${formatInr(value ?? null)} on ${formatDay(day)}; P1 mean ${formatInr(spark.p1_mean)}`;
  return (
    <div className="relative" style={{ width: SPARK_W, height: SPARK_H }}>
      <svg
        role="img"
        aria-label={label}
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        className="block text-muted"
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(nearestIndex(e.clientX - box.left, box.width, spark.values.length));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <title>{label}</title>
        {geo.meanY !== null ? (
          <line
            x1={0}
            x2={SPARK_W}
            y1={geo.meanY}
            y2={geo.meanY}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 3"
            className="text-faint"
          />
        ) : null}
        <path
          d={geo.path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {x !== undefined && y !== null && y !== undefined ? (
          <circle cx={x} cy={y} r={2.5} className="fill-current text-primary" />
        ) : null}
      </svg>
      {hover !== null ? (
        <span className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded bg-surface px-1 font-mono text-xs tabular-nums text-foreground shadow-card">
          {formatDay(day).slice(0, 6)} {formatInr(value ?? null)}
        </span>
      ) : null}
    </div>
  );
}

function HeadWithTip({ children, tip }: { children: string; tip: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <InfoTooltip text={tip} label={`About ${children}`} />
    </span>
  );
}

function Row({ cell, r, focus }: { cell: PulseCell; r: PulseAvailable; focus: PulseListKey }) {
  const href = matrixHref(cell);
  if (cell.st !== 'ok' || !cell.windows) {
    return (
      <TRow>
        <Td dense className="whitespace-nowrap">
          <span className="font-medium">{cell.kind_label}</span>{' '}
          <span className="text-muted">{bandText(cell.band_label)}</span>
        </Td>
        <Td dense colSpan={10} className="text-xs text-muted">
          {cell.reason ?? 'This strategy does not exist here.'}
        </Td>
      </TRow>
    );
  }
  const rank = rankView(cell, r);
  const flag = flagView(cell.flag);
  const note = flagNote(cell.flag);
  const chips = chipGroups(cell.chips, focus);
  const share = shareView(cell, r);
  const picks = picksHeader(r);
  return (
    <TRow
      {...(href ? { onClick: () => navigateToLink(href) } : {})}
      className={flag ? 'bg-surface-2/30' : ''}
    >
      <Td dense className="whitespace-nowrap">
        <span className="font-medium">{cell.kind_label}</span>{' '}
        <span className="text-muted">{bandText(cell.band_label)}</span>
      </Td>
      {WINDOW_KEYS.map((k) => {
        const stat = cell.windows?.[k];
        return (
          <FigureCell
            key={k}
            f={figure(stat, `Last ${k} sessions`)}
            short={isShort(stat, Number(k))}
          />
        );
      })}
      <FigureCell f={figure(cell.p1, 'P1')} />
      <FigureCell f={figure(cell.p2, 'P2')} />
      <Td dense>
        <Sparkline cell={cell} />
      </Td>
      <Td dense>
        {flag ? (
          <span className="whitespace-nowrap" title={flag.title}>
            <Badge tone={flag.tone}>{flag.short}</Badge>
          </span>
        ) : note ? (
          <span className="text-xs text-faint" title={note}>
            no range yet
          </span>
        ) : (
          <span className="text-xs text-faint">{EMPTY}</span>
        )}
      </Td>
      <Td dense align="right" numeric title={rank.title}>
        <span className="whitespace-nowrap">{rank.text}</span>
      </Td>
      <Td dense>
        {chips.length === 0 ? (
          <span className="text-xs text-faint">{EMPTY}</span>
        ) : (
          <span className="inline-flex flex-nowrap gap-1 whitespace-nowrap">
            {chips.map((c) => (
              <span key={c.list} title={c.title}>
                <Badge
                  tone={picks.source === 'reconstructed' ? 'neutral' : c.focus ? 'primary' : 'info'}
                >
                  {c.count > 1 ? `${c.list}×${c.count}` : c.list}
                </Badge>
              </span>
            ))}
          </span>
        )}
      </Td>
      <Td dense align="right" numeric title={share.title}>
        <span className="whitespace-nowrap">{share.text}</span>
      </Td>
    </TRow>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function RotationPulse({ focus }: { focus: PulseListKey }) {
  const [index, setIndex] = useState<PulseIndex>('both');
  const result = useRotationPulse(focus, index);
  const data = result.data;
  const picks = data?.available ? picksHeader(data) : null;
  const stale = result.error !== null && data !== null;

  return (
    <Card>
      <CardHeader
        title="Family pulse"
        description="Is morning short-premium working right now? Recent gross per lot-day in the 12 cells the ranking pools: strategy kind by start band, both indices, every strike."
        className="mb-3"
      />
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          Index
          <SegmentedControl
            value={index}
            options={INDEX_OPTIONS}
            onChange={setIndex}
            ariaLabel="Index filter for the cell means"
            size="sm"
          />
        </div>
        <RefreshButton onClick={result.refetch} loading={result.loading} label="Reload" />
      </div>

      {result.error && data === null ? (
        <div className="space-y-3">
          <StateMessage
            variant="error"
            title="Could not load the Family pulse"
            description={result.error}
          />
          <Button size="sm" onClick={result.refetch}>
            Retry
          </Button>
        </div>
      ) : data === null ? (
        <SkeletonRows rows={6} />
      ) : !data.available ? (
        <StateMessage variant="empty" {...unavailableView(data.reason)} />
      ) : (
        <div className={cn('space-y-3', stale && 'opacity-60')}>
          {stale ? (
            <div className="space-y-2">
              <StateMessage
                variant="error"
                title="The latest request failed; this is the previous result"
                description={result.error ?? ''}
              />
              <Button size="sm" onClick={result.refetch}>
                Retry
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone="info">Gross</Badge>
            <span>{asOfLine(data)}</span>
            {data.journal.chain.intact ? null : (
              <Badge tone="negative">Journal chain broken: entries not trusted</Badge>
            )}
            {data.journal.late.length > 0 ? (
              <Badge tone="warning">
                {formatInt(data.journal.late.length)} late{' '}
                {data.journal.late.length === 1 ? 'entry' : 'entries'} excluded
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-faint">
            {sourceLine(data)} {criterionNote(data)}
            {index === 'both'
              ? ''
              : ' The index filter narrows the means only; it is not what the ranking uses.'}
          </p>

          <Table stickyFirstCol>
            <THead>
              <Th dense>Cell</Th>
              <Th dense align="right">
                <HeadWithTip tip="Mean gross per lot-day of the cell's variants over the last 5 sessions, then the sessions and variants it stands on. Variants on one date are not independent, so the sessions count is the sample.">
                  Last 5
                </HeadWithTip>
              </Th>
              <Th dense align="right">
                Last 21
              </Th>
              <Th dense align="right">
                Last 63
              </Th>
              <Th dense align="right">
                <HeadWithTip
                  tip={`${data.periods.P1.label}: the reference the cell is read against (to ${formatDay(data.periods.P1.to)}).`}
                >
                  P1
                </HeadWithTip>
              </Th>
              <Th dense align="right">
                <HeadWithTip tip={`${data.periods.P2.label}: the second reference period.`}>
                  P2
                </HeadWithTip>
              </Th>
              <Th dense>
                <HeadWithTip tip="The rolling 21-session mean gross over up to the last 126 sessions. The dashed line is the P1 mean. Hover for a day.">
                  Rolling 21
                </HeadWithTip>
              </Th>
              <Th dense>
                <HeadWithTip tip="Whether the last 21 sessions' mean sits outside the range of this cell's own rolling 21-session means in P1 (P10 to P90). A description of drift; nothing changes.">
                  Drift
                </HeadWithTip>
              </Th>
              <Th dense align="right">
                <HeadWithTip tip="The rank the ranking gives this cell on the family-band criterion for the next 09:16 pick: the same value Why this pick shows as Family-band recent, ranked among the 12 cells. It carries 5% of the composite in A, B and C.">
                  Ranking sees
                </HeadWithTip>
              </Th>
              <Th dense>Picks</Th>
              <Th dense align="right">
                <HeadWithTip
                  tip={`List ${focus}'s share of its core picks that landed in the cell over its last 21 sessions (frequency beside profit). A Buy cell shows the days the Buy add-on sat there, because the Buy is not a core pick.`}
                >
                  {`Share of ${focus}`}
                </HeadWithTip>
              </Th>
            </THead>
            <tbody>
              {data.cells.map((c) => (
                <Row key={c.key} cell={c} r={data} focus={focus} />
              ))}
            </tbody>
          </Table>

          <p className="text-xs text-muted">
            {picks?.label ? (
              <>
                <Badge tone={picks.source === 'recorded' ? 'positive' : 'neutral'}>
                  {picks.label}
                </Badge>{' '}
                picks are shown in the Picks column.{' '}
              </>
            ) : null}
            {picks?.note ?? ''}
          </p>
          {!data.rank.available ? (
            <p className="text-xs text-muted">Ranking sees: {data.rank.reason}</p>
          ) : data.rank.history_to !== null && data.rank.history_to !== data.as_of ? (
            <p className="text-xs text-warning">
              The ranking's history ends {formatDay(data.rank.history_to)}, before the latest stored
              session: some variants have no result for {formatDay(data.as_of)} yet.
            </p>
          ) : null}
          <p className="text-xs text-faint">
            Each figure is a mean over the cell's strategy-days, one lot each, before charges: not a
            list's P&amp;L (a list trades two lots a strategy) and never summed across cells. Counts
            read sessions·variants; * marks a window shorter than its name. Click a row to open it
            in the Strategy Matrix's pulse view. {data.flag_rule}
          </p>
        </div>
      )}
    </Card>
  );
}
