'use client';

/**
 * Options Lab › Matrix: where the rotation's strategy variants make or lose money, by start
 * time, date and market condition, with the journal's recorded picks laid over it (read-only).
 *
 * Every figure is read from `GET /legwise/rotation/matrix` (`rotation/matrix.py`): gross P&L per
 * one-lot strategy-day from the nightly results files, pooled as means, rates and worst values,
 * never summed. Alternative settings are not a portfolio. A cell under the minimum number of
 * sessions is muted, not hidden; a missing value is dashed, never zero.
 */

import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useRotationMatrix } from '../../hooks/useRotationMatrix';
import { useRotationMatrixFilters } from '../../hooks/useRotationMatrixFilters';
import { formatInt } from '../../lib/format';
import {
  ANY,
  cellParams,
  insightLines,
  matrixParams,
  okMatrices,
  scaleNotes,
} from '../../lib/rotationMatrixView';
import type { MatrixGrid, MatrixResponse } from '../../types/rotationMatrix';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { RotationMatrixControls } from './RotationMatrixControls';
import { type DrawerRequest, RotationMatrixDrawer } from './RotationMatrixDrawer';
import { Legend, OverlayStatus } from './RotationMatrixParts';
import { RotationMatrixTable } from './RotationMatrixTable';

type Shown = 'both' | 'difference';

function periodTitle(r: MatrixResponse, g: MatrixGrid): string {
  return r.periods.find((p) => p.id === g.period)?.label ?? g.period;
}

function Footnotes({ r }: { r: MatrixResponse }) {
  return (
    <>
      <OverlayStatus overlay={r.overlay} />
      {r.view === 'date_slot' && r.overlay.available ? (
        <p className="text-xs text-muted">
          Letters in a cell are the lists that recorded a pick there. A late entry is not forward
          and is left out of the selection statistics.
        </p>
      ) : null}
      {r.selection_denominator ? (
        <p className="text-xs text-muted">{r.selection_denominator}</p>
      ) : null}
    </>
  );
}

export function RotationMatrixPanel() {
  const { filters, set } = useRotationMatrixFilters();
  const params = useMemo(() => matrixParams(filters), [filters]);
  const result = useRotationMatrix(params);
  const [drawer, setDrawer] = useState<DrawerRequest | null>(null);
  const [shown, setShown] = useState<Shown>('both');

  const data = result.data;
  const r = data?.available ? data : null;
  const meta = data ? data.meta : undefined;
  const overlayList = filters.list === ANY ? null : filters.list;

  // the previous grid stays on screen when a later request fails: say so, never show it as current
  const stale = result.error !== null && data !== null;
  const hasDifference = r?.difference != null;
  useEffect(() => {
    if (!hasDifference) setShown('both');
  }, [hasDifference]);
  const showDiff = shown === 'difference' && r?.difference?.status === 'ok';

  /** Open the drawer for one cell: one section per period it is made of. */
  const open = (
    row: string,
    col: string,
    periodIds: MatrixGrid['period'][],
    rowLabel: string,
    colLabel: string,
    heading: string,
  ) =>
    setDrawer({
      title: `${rowLabel} · ${colLabel}`,
      subtitle: `${heading} · gross per one-lot strategy-day`,
      sections: periodIds.map((id) => ({
        ...(periodIds.length > 1 && r ? { heading: periodLabelOf(r, id) } : {}),
        params: cellParams(filters, row, col, id),
      })),
    });

  return (
    <div className="space-y-5">
      <RotationMatrixControls filters={filters} set={set} meta={meta} />

      {result.error && data === null ? (
        <div className="space-y-3">
          <StateMessage
            variant="error"
            title="Could not load the matrix"
            description={result.error}
          />
          <Button size="sm" onClick={result.refetch}>
            Retry
          </Button>
        </div>
      ) : data === null ? (
        <SkeletonRows rows={8} />
      ) : !r ? (
        <StateMessage
          variant="empty"
          title="No strategy has stored results yet"
          description={`${(data as { reason: string }).reason}. Results appear after the nightly rotation update (obt rotation update).`}
        />
      ) : (
        <>
          {stale ? (
            <div className="space-y-2">
              <StateMessage
                variant="error"
                title="The latest request failed; this is the previous result"
                description={`${result.error}. The grid below does not match the controls above.`}
              />
              <Button size="sm" onClick={result.refetch}>
                Retry
              </Button>
            </div>
          ) : null}
          <Card className={stale ? 'opacity-60' : ''}>
            <CardHeader
              title={r.metric_label}
              description={`Pooling: ${r.aggregation}.`}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={result.refetch}
                  disabled={result.loading}
                  aria-label="Refresh the matrix"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${result.loading ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  Refresh
                </Button>
              }
            />
            <p className="text-xs text-muted">
              {okMatrices(r)
                .map((g) => `${formatInt(g.sessions)} sessions · ${periodTitle(r, g)}`)
                .join(' | ')}
              {` · minimum ${formatInt(r.min_n)} sessions (fewer is muted, not hidden) · stored results ${r.meta.store.first ?? '—'} to ${r.meta.store.last ?? '—'}`}
            </p>
            {weekendNotes(r).map((n) => (
              <p key={n} className="text-xs text-faint">
                {n}
              </p>
            ))}
            {(() => {
              const lines = insightLines(r);
              return lines.length > 0 ? (
                <ul className="mt-4 space-y-1 text-sm text-foreground">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null;
            })()}
          </Card>

          {r.matrices.map((g) =>
            g.status !== 'ok' ? (
              <StateMessage
                key={g.period}
                variant="empty"
                title={`${periodTitle(r, g)} is not available`}
                description={g.reason ?? undefined}
              />
            ) : null,
          )}

          {okMatrices(r).length > 0 ? (
            <Card className={stale ? 'opacity-60' : ''}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <Legend
                  scale={showDiff ? (r.difference?.scale ?? null) : r.scale}
                  unit={r.unit}
                  difference={showDiff}
                  shared={r.matrices.length === 2 && !showDiff}
                  notes={[
                    ...scaleNotes(showDiff ? (r.difference?.scale ?? null) : r.scale, r.unit),
                    ...(r.window_rule ? [r.window_rule] : []),
                  ]}
                />
                {r.difference ? (
                  <SegmentedControl
                    value={shown}
                    options={[
                      { value: 'both', label: 'Both periods' },
                      {
                        value: 'difference',
                        label: 'Difference',
                        disabled: r.difference.status !== 'ok',
                      },
                    ]}
                    onChange={setShown}
                    ariaLabel="Show both periods or their difference"
                    size="sm"
                  />
                ) : null}
              </div>
              {r.difference && r.difference.status !== 'ok' ? (
                <p className="mb-3 text-xs text-warning">
                  Difference unavailable: {r.difference.reason ?? 'a period has no data'}.
                </p>
              ) : null}
              <div
                className={
                  r.matrices.length === 2 && !showDiff && r.cols.length <= 14
                    ? 'grid gap-6 2xl:grid-cols-2'
                    : 'space-y-6'
                }
              >
                {showDiff && r.difference?.status === 'ok' ? (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-foreground">
                      {r.difference.minuend} minus {r.difference.subtrahend}
                      <span className="ml-2 text-xs font-normal text-muted">
                        {r.difference.note}
                      </span>
                    </h3>
                    <RotationMatrixTable
                      rows={r.rows}
                      cols={r.cols}
                      cells={r.difference.cells ?? []}
                      scale={r.difference.scale ?? null}
                      unit={r.unit}
                      difference
                      periods={[r.difference.minuend ?? '', r.difference.subtrahend ?? '']}
                      overlayList={null}
                      caption={`${r.metric_label}, ${r.difference.minuend} minus ${r.difference.subtrahend}`}
                      onOpen={(row, col) => {
                        const a = r.difference?.minuend;
                        const b = r.difference?.subtrahend;
                        if (a && b)
                          open(
                            row,
                            col,
                            [a, b],
                            labelOf(r.rows, row),
                            labelOf(r.cols, col),
                            `${a} minus ${b}`,
                          );
                      }}
                    />
                  </div>
                ) : (
                  okMatrices(r).map((g) => (
                    <div key={g.period}>
                      <h3 className="mb-2 text-sm font-semibold text-foreground">
                        {periodTitle(r, g)}
                        <span className="ml-2 text-xs font-normal text-muted">
                          {formatInt(g.sessions)} sessions
                        </span>
                      </h3>
                      <RotationMatrixTable
                        rows={r.rows}
                        cols={r.cols}
                        cells={g.cells ?? []}
                        rowSummary={g.row_summary}
                        colSummary={g.col_summary}
                        scale={r.scale}
                        unit={r.unit}
                        overlayList={overlayList}
                        datePicks={r.date_picks}
                        caption={`${r.metric_label}, ${periodTitle(r, g)}`}
                        onOpen={(row, col) =>
                          open(
                            row,
                            col,
                            [g.period],
                            labelOf(r.rows, row),
                            labelOf(r.cols, col),
                            periodTitle(r, g),
                          )
                        }
                      />
                    </div>
                  ))
                )}
              </div>
              <Footnotes r={r} />
            </Card>
          ) : null}

          <ul className="space-y-1 text-xs text-faint">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}

      <RotationMatrixDrawer request={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}

function labelOf(items: { key: string; label: string }[], key: string): string {
  return items.find((i) => i.key === key)?.label ?? key;
}

function periodLabelOf(r: MatrixResponse, id: string): string {
  return r.periods.find((p) => p.id === id)?.label ?? id;
}

/** "1 weekend session left out of P1 (2026-02-01), as in the ranking history." */
function weekendNotes(r: MatrixResponse): string[] {
  return okMatrices(r).flatMap((g) => {
    const p = r.periods.find((x) => x.id === g.period);
    const days = p?.weekend_excluded ?? [];
    if (days.length === 0) return [];
    return [
      `${formatInt(days.length)} weekend session${days.length === 1 ? '' : 's'} left out of ${g.period} (${days.join(', ')}), as in the ranking history.`,
    ];
  });
}
