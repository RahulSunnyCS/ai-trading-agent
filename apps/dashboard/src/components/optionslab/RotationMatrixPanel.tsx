'use client';

/**
 * Options Lab › Matrix: where the rotation's strategy variants make or lose money, by start
 * time, date and market condition, with the journal's recorded picks laid over it (read-only).
 *
 * Every figure is read from `GET /legwise/rotation/matrix` (`rotation/matrix.py`): gross P&L per
 * one-lot strategy-day from the nightly results files, pooled as means, rates and worst values,
 * never summed. Alternative settings are not a portfolio. A cell under the minimum number of
 * sessions is muted, not hidden; a missing value is dashed, never zero.
 *
 * The grid is the first thing on the page: a slim run bar (view, metric, a summary of the active
 * settings, Settings) sits above it and every other setting is in a drawer. With no period in the
 * URL it shows today's performance, the latest scored session as one day
 * (`lib/rotationMatrixDefault.ts`).
 */

import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useRotationMatrix } from '../../hooks/useRotationMatrix';
import { useRotationMatrixFilters } from '../../hooks/useRotationMatrixFilters';
import { useTodayIst } from '../../hooks/useTodayIst';
import { formatDay, formatInt } from '../../lib/format';
import {
  FALLBACK_NOTE,
  type MatrixPreset,
  changedCount,
  effectiveFilters,
  latestDayNote,
  parseSessions,
  presetPatch,
  probeParams,
  settingsSummary,
  usesTodayDefault,
} from '../../lib/rotationMatrixDefault';
import {
  ANY,
  METRIC_NOTE,
  type MatrixFilters,
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
import { familyName } from './RotationMatrixControls';
import { type DrawerRequest, RotationMatrixDrawer } from './RotationMatrixDrawer';
import { Legend, OverlayStatus } from './RotationMatrixParts';
import { RotationMatrixRunBar, RotationMatrixSettingsDrawer } from './RotationMatrixRunBar';
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
  const {
    filters: urlFilters,
    explicit,
    set: setUrl,
    reset,
    clearPeriod,
  } = useRotationMatrixFilters();
  const today = useTodayIst();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // No period in the URL: today's session. Its day is the latest scored one, found by a small
  // probe that is also what the "Last N sessions" presets count back from.
  const wantsDefault = usesTodayDefault(urlFilters, explicit);
  const probe = useRotationMatrix(
    useMemo(() => probeParams(today), [today]),
    { enabled: wantsDefault || settingsOpen },
  );
  const sessions = useMemo(() => parseSessions(probe.data), [probe.data]);
  const probePending = wantsDefault && probe.data === null && probe.error === null;
  const latestDay = wantsDefault ? sessions.last : null;
  const filters: MatrixFilters = useMemo(
    () => effectiveFilters(urlFilters, explicit, latestDay),
    [urlFilters, explicit, latestDay],
  );
  const params = useMemo(() => matrixParams(filters), [filters]);
  const result = useRotationMatrix(params, { enabled: !probePending });
  const [drawer, setDrawer] = useState<DrawerRequest | null>(null);
  const [shown, setShown] = useState<Shown>('both');

  /**
   * Edit the settings. While the period is the default (today), touching the period, a date or
   * the compare switch first writes the period out, so the choice is kept and the default stops
   * overriding it: "Custom" starts from the day on screen, "One period" from P1.
   */
  const set = useCallback(
    (patch: Partial<MatrixFilters>) => {
      const touchesTime =
        patch.period !== undefined ||
        patch.from !== undefined ||
        patch.to !== undefined ||
        patch.compare !== undefined;
      if (!wantsDefault || !touchesTime || patch.compare === true) {
        setUrl(patch);
        return;
      }
      const next: Partial<MatrixFilters> = { ...patch };
      next.period ??= patch.compare === false ? 'P1' : 'custom';
      if (next.period === 'custom') {
        next.from ??= filters.from;
        next.to ??= filters.to;
      }
      setUrl(next);
    },
    [wantsDefault, setUrl, filters.from, filters.to],
  );

  const onPreset = useCallback(
    (preset: MatrixPreset) => {
      const patch = presetPatch(preset, sessions);
      if (patch === null) clearPeriod();
      else setUrl(patch);
    },
    [sessions, setUrl, clearPeriod],
  );

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

  const summary = probePending
    ? 'Finding the latest scored session…'
    : settingsSummary(filters, {
        today,
        ...(filters.family !== ANY ? { familyLabel: familyName(filters.family) } : {}),
        ...(meta?.families.find((x) => x.key === filters.strategy)
          ? { strategyLabel: meta.families.find((x) => x.key === filters.strategy)?.label ?? '' }
          : {}),
      });
  const note = !wantsDefault
    ? null
    : latestDay
      ? latestDayNote(latestDay, today)
      : probePending
        ? null
        : FALLBACK_NOTE;

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
    <div className="space-y-4">
      <RotationMatrixRunBar
        filters={filters}
        set={set}
        summary={summary}
        changed={changedCount(filters, explicit)}
        note={note}
        onOpenSettings={() => setSettingsOpen(true)}
      />

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
                description={`${result.error}. The grid below does not match the settings above.`}
              />
              <Button size="sm" onClick={result.refetch}>
                Retry
              </Button>
            </div>
          ) : null}

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
              <div className="mb-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground">{r.metric_label}</h2>
                  <p className="text-xs text-muted">
                    {okMatrices(r)
                      .map((g) => `${formatInt(g.sessions)} sessions · ${periodTitle(r, g)}`)
                      .join(' | ')}
                    {` · minimum ${formatInt(r.min_n)} (fewer is muted, not hidden)`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Legend
                    scale={showDiff ? (r.difference?.scale ?? null) : r.scale}
                    unit={r.unit}
                    difference={showDiff}
                    shared={r.matrices.length === 2 && !showDiff}
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
                </div>
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
                      {r.matrices.length > 1 ? (
                        <h3 className="mb-2 text-sm font-semibold text-foreground">
                          {periodTitle(r, g)}
                          <span className="ml-2 text-xs font-normal text-muted">
                            {formatInt(g.sessions)} sessions
                          </span>
                        </h3>
                      ) : null}
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
              <div className="mt-3 space-y-1">
                <Footnotes r={r} />
              </div>
            </Card>
          ) : null}

          <Card className={stale ? 'opacity-60' : ''}>
            <CardHeader title="Reading this grid" description={`Pooling: ${r.aggregation}.`} />
            <p className="text-xs text-muted">
              {METRIC_NOTE[r.metric]} Gross, per one lot, before costs. Alternative settings are not
              a portfolio: no row or column is summed.
              {filters.list !== ANY
                ? ` The marks are list ${filters.list}'s recorded picks, never reconstructed.`
                : ''}
            </p>
            <ul className="mt-2 space-y-0.5 text-xs text-faint">
              {[
                ...scaleNotes(showDiff ? (r.difference?.scale ?? null) : r.scale, r.unit),
                ...(r.window_rule ? [r.window_rule] : []),
                `Stored results ${r.meta.store.first ? formatDay(r.meta.store.first) : '—'} to ${r.meta.store.last ? formatDay(r.meta.store.last) : '—'}.`,
                ...weekendNotes(r),
              ].map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
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

          <ul className="space-y-1 text-xs text-faint">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}

      <RotationMatrixSettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        filters={filters}
        set={set}
        meta={meta}
        summary={summary}
        onPreset={onPreset}
        onReset={reset}
      />
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
