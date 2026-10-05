/**
 * Options Lab → Daily results: the evening-run status bar, a sortable comparison of the
 * saved strategies, their cumulative P&L, and a day grid whose cells open that day's replay
 * in place. A date range and (when the strategies trade more than one) the underlying
 * narrow everything on the page together.
 *
 * Only results produced by the strategy file AS IT IS NOW count toward the
 * totals — a result from an earlier version of the file is shown greyed as
 * "stale" and excluded, the same rule `obt daily` applies in the terminal.
 */

import { useId, useMemo, useState } from 'react';

import { useAnatomy, useLegwiseResults, useLegwiseStrategies } from '../../hooks/useLegwise';
import { formatDay, formatInt } from '../../lib/format';
import type { PnlDay } from '../../lib/legwiseJoin';
import {
  type DayRange,
  comparisonRows,
  daysOf,
  filterByRange,
  hasRange,
  segmentNames,
  strategiesFor,
  underlyingsOf,
} from '../../lib/legwiseResults';
import { lotsOf } from '../../lib/legwiseStats';
import { useRegimeCuts } from '../../store/regimeCuts';
import type {
  AnatomyResponse,
  DayAnatomy,
  ResultsResponse,
  SavedStrategy,
} from '../../types/legwise';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Input, Select } from '../ui/Input';
import { RefreshButton } from '../ui/RefreshButton';
import { Skeleton, SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { Toolbar, ToolbarSpacer } from '../ui/Toolbar';
import { DayTypeCard } from './DayTypeCard';
import { DayTypeLegend } from './anatomy';
import { ComparisonTable } from './results/ComparisonTable';
import { DayGrid, type DaySelection } from './results/DayGrid';
import { EveningRunBar } from './results/EveningRunBar';
import { CumulativeLines } from './shared';

function LoadingState() {
  return (
    <output aria-busy="true" aria-label="Loading results" className="block space-y-5">
      <Card>
        <Skeleton className="mb-4 h-5 w-48" />
        <SkeletonRows rows={4} />
      </Card>
      <Card>
        <Skeleton className="mb-4 h-5 w-40" />
        <Skeleton className="h-64 w-full" />
      </Card>
      <Card>
        <Skeleton className="mb-4 h-5 w-32" />
        <SkeletonRows rows={6} />
      </Card>
    </output>
  );
}

interface ViewProps {
  results: ResultsResponse;
  saved: SavedStrategy[];
  underlying: string | null;
  underlyings: string[];
  onUnderlying: (next: string) => void;
  underlyingById: Map<string, string>;
  refreshing: boolean;
  onRefresh: () => void;
}

/** Fetches the index anatomy for the chosen underlying; mounted only once it is known. */
function ResultsWithAnatomy(props: ViewProps & { underlying: string }) {
  // The cuts set on Market regimes, so day types here match that tab and the replay.
  const cuts = useRegimeCuts();
  const anatomy = useAnatomy(props.underlying, cuts);
  const { onRefresh } = props;
  const refetchAnatomy = anatomy.refetch;
  return (
    <ResultsView
      {...props}
      // A response for the previous underlying must not label this one's days.
      anatomy={anatomy.data?.underlying === props.underlying ? anatomy.data : null}
      anatomyLoading={anatomy.loading}
      onRefresh={() => {
        onRefresh();
        refetchAnatomy();
      }}
    />
  );
}

function ResultsView({
  results,
  saved,
  underlying,
  underlyings,
  onUnderlying,
  underlyingById,
  refreshing,
  onRefresh,
  anatomy,
  anatomyLoading,
}: ViewProps & { anatomy: AnatomyResponse | null; anatomyLoading: boolean }) {
  const regimeCuts = useRegimeCuts();
  const segmentLabels = useMemo(() => segmentNames(regimeCuts), [regimeCuts]);
  const [range, setRange] = useState<DayRange>({});
  const fieldId = useId();
  const [selected, setSelected] = useState<DaySelection | null>(null);

  const lotsById = useMemo(
    () => new Map(saved.map((s) => [s.strategy.id, lotsOf(s.strategy)])),
    [saved],
  );
  const strategies = useMemo(
    () => strategiesFor(results.strategies, underlyingById, underlying),
    [results.strategies, underlyingById, underlying],
  );
  // Every result of the strategies in view, before the date range.
  const scopeRows = useMemo(() => {
    const ids = new Set(strategies.map((s) => s.id));
    return results.results.filter((r) => ids.has(r.strategy_id));
  }, [results.results, strategies]);
  const allDays = useMemo(() => daysOf(scopeRows), [scopeRows]);
  const rows = useMemo(() => filterByRange(scopeRows, range), [scopeRows, range]);
  const days = useMemo(() => daysOf(rows), [rows]);

  const comparison = useMemo(
    () =>
      comparisonRows(
        strategies.map((s) => ({
          id: s.id,
          name: s.name,
          sha: s.sha,
          lots: lotsById.get(s.id) ?? 1,
          days: rows.filter((r) => r.current && r.strategy_id === s.id),
        })),
      ),
    [strategies, rows, lotsById],
  );
  const lines = useMemo(
    () => comparison.map((row) => ({ id: row.id, points: row.stats.cumulative })),
    [comparison],
  );
  const gridStrategies = useMemo(
    () =>
      comparison.map((row) => ({
        id: row.id,
        lots: lotsById.get(row.id) ?? 1,
        colorIndex: row.colorIndex,
      })),
    [comparison, lotsById],
  );
  const pnlById = useMemo(() => {
    const out = new Map<string, PnlDay[]>();
    for (const s of gridStrategies) {
      out.set(
        s.id,
        rows
          .filter((r) => r.current && r.strategy_id === s.id)
          .map((r) => ({ day: r.day, net: r.net / s.lots })),
      );
    }
    return out;
  }, [rows, gridStrategies]);
  const strategyIds = useMemo(() => gridStrategies.map((s) => s.id), [gridStrategies]);

  // The full index history, not the range: the "previous day" lens needs the day before.
  const anatomyDays = useMemo(() => anatomy?.days ?? [], [anatomy]);
  const anatomyByDay = useMemo(
    () => new Map<string, DayAnatomy>(anatomyDays.map((d) => [d.day, d])),
    [anatomyDays],
  );

  const oldest = allDays[allDays.length - 1];
  const newest = allDays[0];
  const filtered = hasRange(range);
  const index = underlying ?? 'Index';

  return (
    <>
      <Card className="px-4 py-3">
        <Toolbar ariaLabel="Results filters" className="gap-x-3">
          {underlyings.length > 1 && underlying !== null ? (
            <label
              htmlFor={`${fieldId}-underlying`}
              className="flex items-center gap-2 text-xs text-muted"
            >
              Underlying
              <Select
                id={`${fieldId}-underlying`}
                className="w-36"
                value={underlying}
                onChange={(e) => {
                  setSelected(null);
                  onUnderlying(e.target.value);
                }}
              >
                {underlyings.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <span className="text-sm font-medium text-foreground">
              {underlying ?? 'All strategies'}
            </span>
          )}
          <label htmlFor={`${fieldId}-from`} className="flex items-center gap-2 text-xs text-muted">
            From
            <Input
              id={`${fieldId}-from`}
              type="date"
              className="w-40"
              value={range.from ?? ''}
              min={oldest}
              max={newest}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </label>
          <label htmlFor={`${fieldId}-to`} className="flex items-center gap-2 text-xs text-muted">
            To
            <Input
              id={`${fieldId}-to`}
              type="date"
              className="w-40"
              value={range.to ?? ''}
              min={oldest}
              max={newest}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            disabled={!filtered}
            onClick={() => setRange({})}
            title="Show every day"
          >
            All
          </Button>
          <span className="text-xs text-muted" aria-live="polite">
            {filtered
              ? `${formatInt(days.length)} of ${formatInt(allDays.length)} days`
              : `${formatInt(allDays.length)} ${allDays.length === 1 ? 'day' : 'days'}`}
            {oldest && newest ? ` · ${formatDay(oldest)} → ${formatDay(newest)}` : ''}
          </span>
          <ToolbarSpacer />
          <RefreshButton onClick={onRefresh} loading={refreshing} />
        </Toolbar>
      </Card>

      <Card>
        <CardHeader
          title="Strategy comparison"
          description="Ranked by Net / lot. Click a column to sort."
        />
        <ComparisonTable rows={comparison} />
      </Card>

      <Card>
        <CardHeader
          title="Cumulative net P&L"
          description="₹ per lot (net of each strategy's costs; a strategy's lot = its smallest leg)"
        />
        <CumulativeLines lines={lines} />
      </Card>

      <Card>
        <CardHeader
          title="Day by day"
          description="₹ per lot. Click a figure to replay that strategy's day under the row."
        />
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-medium uppercase tracking-wider text-faint">
            {index} shape
          </span>
          <DayTypeLegend />
          {anatomyLoading && !anatomy ? <Skeleton className="h-4 w-24" /> : null}
        </div>
        {days.length === 0 ? (
          <StateMessage
            variant="empty"
            title={filtered ? 'No days in this range' : 'No results yet'}
            description={
              filtered
                ? 'Widen the dates or press All.'
                : 'Run the evening job to collect a day and run every saved strategy on it.'
            }
          />
        ) : (
          <DayGrid
            days={days}
            strategies={gridStrategies}
            rows={rows}
            anatomyByDay={anatomyByDay}
            underlying={index}
            selected={selected}
            onSelect={setSelected}
          />
        )}
      </Card>

      <DayTypeCard
        strategies={strategyIds}
        pnl={pnlById}
        anatomy={anatomyDays}
        segmentNames={segmentLabels}
      />
    </>
  );
}

export function ResultsPanel() {
  const results = useLegwiseResults();
  const saved = useLegwiseStrategies();
  const [chosen, setChosen] = useState<string | null>(null);

  const underlyingById = useMemo(
    () => new Map((saved.data ?? []).map((s) => [s.strategy.id, s.strategy.underlying as string])),
    [saved.data],
  );
  const underlyings = useMemo(
    () =>
      underlyingsOf(
        (results.data?.strategies ?? []).map((s) => s.id),
        underlyingById,
      ),
    [results.data, underlyingById],
  );
  const underlying =
    chosen !== null && underlyings.includes(chosen) ? chosen : (underlyings[0] ?? null);

  // Lots and the underlying come from the saved strategies, so wait for both answers
  // (a failed strategies request still lets the results render, per lot = as saved).
  const settled =
    results.data !== null && (saved.data !== null || (!saved.loading && saved.error !== null));
  const refetchResults = results.refetch;
  const refetchSaved = saved.refetch;
  const refresh = () => {
    refetchResults();
    refetchSaved();
  };
  const view: ViewProps | null =
    settled && results.data
      ? {
          results: results.data,
          saved: saved.data ?? [],
          underlying,
          underlyings,
          onUnderlying: setChosen,
          underlyingById,
          refreshing: results.loading || saved.loading,
          onRefresh: refresh,
        }
      : null;

  return (
    <div className="space-y-5">
      <EveningRunBar underlying={underlying} onFinished={refetchResults} />

      {results.error && (
        <StateMessage variant="error" title="Couldn't load results" description={results.error} />
      )}
      {saved.error && !results.error && (
        <StateMessage
          variant="error"
          title="Couldn't load the saved strategies"
          description={`${saved.error} Figures are shown as saved, not per lot, and the underlying is unknown.`}
        />
      )}

      {view === null && !results.error ? <LoadingState /> : null}

      {view !== null && view.results.strategies.length === 0 ? (
        <StateMessage
          variant="empty"
          title="No strategies yet"
          description="Create one in the Strategy builder tab, then run the evening job."
        />
      ) : null}

      {view !== null && view.results.strategies.length > 0 ? (
        view.underlying !== null ? (
          <ResultsWithAnatomy {...view} underlying={view.underlying} />
        ) : (
          <ResultsView {...view} anatomy={null} anatomyLoading={false} />
        )
      ) : null}
    </div>
  );
}
