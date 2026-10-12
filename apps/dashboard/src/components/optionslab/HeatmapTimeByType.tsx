'use client';

/**
 * Options Lab › Heatmap › "Entry time by strategy type": for each strategy type (the 12 index x
 * family groups of the rotation universe) and each entry time, the mean gross P&L of one lot over
 * the selected days. Read-only over the stored results of the 298 rotation variants, through
 * `GET /legwise/rotation/matrix` (view `family_slot`, metric `avg`); the Matrix tab is the same
 * data with every control. Nothing is computed here: the table, tint, thin flag and tooltip are
 * the Matrix's own (`RotationMatrixTable`, `lib/rotationMatrixView.ts`); this card only picks
 * the days and names the rows.
 *
 * The default is the latest scored session. A session is one day, so its cells are not "thin"
 * for being a sample of one (`min_n=1`); a range under the API's default minimum keeps the flag.
 */

import { RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { useRotationMatrix } from '../../hooks/useRotationMatrix';
import { useTimeByTypeSelection } from '../../hooks/useTimeByTypeSelection';
import { formatInt } from '../../lib/format';
import {
  PRESET_OPTIONS,
  type TimeByTypePreset,
  answersSelection,
  latestNote,
  parseSessions,
  probeParams,
  resolveSelection,
  selectionFilters,
  selectionParams,
  selectionTitle,
  thinNote,
  todayIst,
  typeLabel,
  typeRows,
} from '../../lib/heatmapTimeByTypeView';
import { cellParams, okMatrices, scaleNotes } from '../../lib/rotationMatrixView';
import type { MatrixResponse } from '../../types/rotationMatrix';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Input } from '../ui/Input';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { type DrawerRequest, RotationMatrixDrawer } from './RotationMatrixDrawer';
import { Legend, colHeader } from './RotationMatrixParts';
import { RotationMatrixTable } from './RotationMatrixTable';

function weekendNote(r: MatrixResponse): string | null {
  const days = r.periods.flatMap((p) => p.weekend_excluded ?? []);
  if (days.length === 0) return null;
  return `${formatInt(days.length)} weekend session${days.length === 1 ? '' : 's'} left out (${days.join(', ')}), as in the ranking history.`;
}

/** Today on the exchange's calendar, re-read every few minutes so a tab left open overnight moves on. */
function useTodayIst(): string {
  const [today, setToday] = useState(() => todayIst());
  useEffect(() => {
    const id = setInterval(() => setToday(todayIst()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  return today;
}

export function HeatmapTimeByType() {
  const today = useTodayIst();
  const probe = useRotationMatrix(useMemo(() => probeParams(today), [today]));
  const sessions = useMemo(() => parseSessions(probe.data), [probe.data]);
  const { input, pickPreset, pickDay, pickRange } = useTimeByTypeSelection();
  const sel = useMemo(() => resolveSelection(input, sessions), [input, sessions]);
  const params = useMemo(() => (sel ? selectionParams(sel) : {}), [sel]);
  const result = useRotationMatrix(params, { enabled: sel !== null });
  const [drawer, setDrawer] = useState<DrawerRequest | null>(null);

  // Only an answer to the current selection is drawn: while the next one loads, the previous
  // grid must not sit under the new title.
  const r =
    result.data?.available && sel && answersSelection(result.data, sel) ? result.data : null;
  const grid = r ? okMatrices(r)[0] : undefined;
  const periodMeta = r?.periods[0];
  const rows = useMemo(() => (r ? typeRows(r.rows) : []), [r]);

  const isPresetMode = sel && sel.mode !== 'day' && sel.mode !== 'range';
  const shownFrom = sel ? (sel.period === 'custom' ? sel.from : (periodMeta?.from ?? '')) : '';
  const shownTo = sel ? (sel.period === 'custom' ? sel.to : (periodMeta?.to ?? '')) : '';

  function open(rowKey: string, colKey: string) {
    if (!sel || !r || !grid) return;
    const row = rows.find((x) => x.key === rowKey);
    const col = r.cols.find((x) => x.key === colKey);
    setDrawer({
      title: `${row ? typeLabel(row) : rowKey} · ${col ? colHeader(col.key, col.label) : colKey}`,
      subtitle: `${selectionTitle(sel, periodMeta?.label)} · gross per one-lot strategy-day`,
      sections: [{ params: cellParams(selectionFilters(sel), rowKey, colKey, grid.period) }],
    });
  }

  let body: ReactNode;
  if (probe.error && probe.data === null) {
    body = (
      <StateMessage
        variant="error"
        title="Cannot read the stored results"
        description={probe.error}
      />
    );
  } else if (probe.data === null) {
    body = <SkeletonRows rows={6} />;
  } else if (sel === null && probe.data.available) {
    body = (
      <StateMessage
        variant="empty"
        title="No scored sessions yet"
        description="The nightly run has not stored a weekday result."
      />
    );
  } else if (probe.data && !probe.data.available) {
    body = (
      <StateMessage variant="empty" title="No results stored yet" description={probe.data.reason} />
    );
  } else if (result.error && r === null && result.data?.available !== false) {
    body = <StateMessage variant="error" title="Cannot draw this yet" description={result.error} />;
  } else if (result.data && !result.data.available) {
    body = (
      <StateMessage
        variant="empty"
        title="No results stored yet"
        description={result.data.reason}
      />
    );
  } else if (r && sel && grid) {
    const empty = (grid.sessions ?? 0) === 0;
    const notes = [
      latestNote(sel, today),
      thinNote(sel, grid.sessions),
      weekendNote(r),
      result.error ? `Showing the last result: ${result.error}` : null,
    ].filter((n): n is string => n !== null);
    body = (
      <div className="space-y-3">
        <p className="text-sm text-foreground">
          <span className="font-medium">{selectionTitle(sel, periodMeta?.label)}</span>
          <span className="ml-2 text-xs text-muted">
            {formatInt(grid.sessions ?? 0)} session{grid.sessions === 1 ? '' : 's'}, both indices
          </span>
        </p>
        {empty ? (
          <StateMessage
            variant="empty"
            title="No stored result for these days"
            description="Pick a session the nightly run has scored (weekdays since 2024-10-09), or another range."
          />
        ) : (
          <>
            <RotationMatrixTable
              rows={rows}
              cols={r.cols}
              cells={grid.cells ?? []}
              scale={r.scale}
              unit={r.unit}
              overlayList={null}
              caption={`Mean gross P&L per one lot by strategy type and entry time, ${selectionTitle(sel, periodMeta?.label)}`}
              onOpen={open}
            />
            <Legend scale={r.scale} unit={r.unit} notes={scaleNotes(r.scale, r.unit)} />
          </>
        )}
        {notes.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-muted">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  } else {
    body = <SkeletonRows rows={6} />;
  }

  return (
    <Card>
      <CardHeader
        title="Entry time by strategy type"
        description="A cell is the mean gross P&L of one lot over the selected days, before charges: each strategy type (rows) started at that entry time (columns). Green made money, red lost."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              probe.refetch();
              result.refetch();
            }}
            disabled={result.loading || probe.loading}
            aria-label="Refresh entry time by strategy type"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${result.loading || probe.loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Refresh
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="max-w-full overflow-x-auto">
          <SegmentedControl<TimeByTypePreset | ''>
            value={isPresetMode && sel ? (sel.mode as TimeByTypePreset) : ''}
            options={PRESET_OPTIONS}
            onChange={(v) => v && pickPreset(v)}
            ariaLabel="Days shown"
            size="sm"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          Day
          <Input
            type="date"
            value={sel?.single ? sel.from : ''}
            min={sessions.first ?? undefined}
            max={sessions.last ?? undefined}
            onChange={(e) => pickDay(e.target.value)}
            aria-label="Day"
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          From
          <Input
            type="date"
            value={shownFrom}
            min={sessions.first ?? undefined}
            max={shownTo || (sessions.last ?? undefined)}
            onChange={(e) =>
              pickRange({ from: e.target.value, to: shownTo || sessions.last || '' })
            }
            aria-label="From date"
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          To
          <Input
            type="date"
            value={shownTo}
            min={shownFrom || (sessions.first ?? undefined)}
            max={sessions.last ?? undefined}
            onChange={(e) =>
              pickRange({ from: shownFrom || sessions.first || '', to: e.target.value })
            }
            aria-label="To date"
            className="w-40"
          />
        </div>
      </div>

      {body}
      <RotationMatrixDrawer request={drawer} onClose={() => setDrawer(null)} />
    </Card>
  );
}
