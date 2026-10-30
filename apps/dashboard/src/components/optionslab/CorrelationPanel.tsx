/**
 * Options Lab → Correlation: do the strategies lose on the same days?
 *
 * A basket of strategies that move as one has the drawdown of one strategy. This tab shows how
 * alike any set of strategies are (a heatmap of daily-P&L correlation), how often they lose on
 * the same days, what a basket of them draws down against its parts, and whether that drifts.
 * The figures come from `GET /legwise/correlation*` (`analytics/correlation.py`, the code behind
 * `obt rotation corr`). Strategies are found by what has results, so a new one appears here the
 * day it has saved days.
 *
 * Everything shown is in-sample over the chosen dates: it describes the window, it does not
 * predict the next one.
 */

import { RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useCorrelationFilters } from '../../hooks/useCorrelationFilters';
import { useFavourites } from '../../hooks/useFavourites';
import { useCorrelation, useCorrelationAvailable } from '../../hooks/useLegwise';
import { useQueryState } from '../../hooks/useQueryState';
import {
  ANY,
  DEFAULT_NAMES,
  LIST_PREFIX,
  MEASURE_LABEL,
  MEASURE_NOTE,
  averagePairwise,
  basisNote,
  buildSelectors,
  displayResponse,
  diversificationNote,
  extremePairs,
  familyLabel,
  isListSelector,
  isShownSelector,
  matrixOf,
  pairReadout,
  pairsAtOrAbove,
  reconstructedNotes,
  reorder,
  selectorLabel,
  slotLabel,
} from '../../lib/correlationView';
import { favouriteSelectors } from '../../lib/favourites';
import { formatDay, formatInt, formatMultiple, formatNumber } from '../../lib/format';
import type {
  CorrelationAvailable,
  CorrelationMeasure,
  CorrelationResponse,
  FavouriteListKey,
} from '../../types/legwise';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Input, Select } from '../ui/Input';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { CorrelationBasket } from './correlation/CorrelationBasket';
import { type Cell, CorrelationHeatmap } from './correlation/CorrelationHeatmap';
import { BasketBuilder, DriftChart, PairCard, StrategyTable } from './correlation/CorrelationParts';
import { StrategyMultiSelect } from './correlation/StrategyMultiSelect';
import { SlippageSwitch } from './rotation/SlippageSwitch';

const MEASURE_OPTIONS: SegmentedOption<CorrelationMeasure>[] = (
  ['pearson', 'spearman', 'loss'] as const
).map((value) => ({ value, label: MEASURE_LABEL[value] }));

const KIND_OPTIONS: SegmentedOption<string>[] = [
  { value: ANY, label: 'Both' },
  { value: 'variant', label: 'Rotation variants' },
  { value: 'legwise', label: 'Live strategies' },
];

const FAMILY_ORDER = ['wide', 'dir', 'buy'];

function familyOptions(groups: Record<string, number>): { value: string; label: string }[] {
  const tokens = Object.keys(groups).sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a);
    const ib = FAMILY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  return tokens.map((t) => ({ value: t, label: `${familyLabel(t)} (${groups[t]})` }));
}

function indexOptions(groups: Record<string, number>): SegmentedOption<string>[] {
  const label: Record<string, string> = { N: 'NIFTY', S: 'SENSEX' };
  return [
    { value: ANY, label: 'Both' },
    ...Object.keys(groups)
      .sort()
      .map((value) => ({ value, label: label[value] ?? value })),
  ];
}

function Filters({
  available,
  state,
  favourites,
}: {
  available: CorrelationAvailable;
  state: ReturnType<typeof useCorrelationFilters>;
  favourites: ReturnType<typeof useFavourites>;
}) {
  const { filters, setFilters, range, setRange } = state;
  const starred = useMemo(
    () => new Set(favourites.set ? favouriteSelectors(favourites.set) : []),
    [favourites.set],
  );
  // Only the shown rotation lists are offered (VISIBLE_LIST_KEYS); the API enumerates all four.
  const lists = (available.lists ?? [])
    .filter((l) => isShownSelector(l.selector))
    .map((l) => ({ selector: l.selector, name: l.name }));
  const g = available.groups;
  const variantsOnly = filters.kind !== 'legwise';
  return (
    <Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1 text-xs text-muted">
          Start time
          <Select
            value={filters.slot}
            onChange={(e) => setFilters({ slot: e.target.value })}
            disabled={!variantsOnly}
            aria-label="Start time"
          >
            <option value={ANY}>Any start time</option>
            {Object.entries(g.slot).map(([slot, n]) => (
              <option key={slot} value={slot}>
                {slotLabel(slot)} ({n})
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          Family
          <Select
            value={filters.family}
            onChange={(e) => setFilters({ family: e.target.value })}
            disabled={!variantsOnly}
            aria-label="Family"
          >
            <option value={ANY}>Any family</option>
            {familyOptions(g.family).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          Index
          <SegmentedControl
            value={filters.index}
            options={indexOptions(g.index).map((o) => ({ ...o, disabled: !variantsOnly }))}
            onChange={(index) => setFilters({ index })}
            ariaLabel="Index"
            size="sm"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          Kind
          <SegmentedControl
            value={filters.kind}
            options={KIND_OPTIONS}
            onChange={(kind) => setFilters({ kind })}
            ariaLabel="Kind of strategy"
            size="sm"
          />
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1 text-xs text-muted">
          From
          <Input
            type="date"
            value={range.from ?? ''}
            onChange={(e) => setRange({ from: e.target.value })}
            aria-label="From date"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          To
          <Input
            type="date"
            value={range.to ?? ''}
            onChange={(e) => setRange({ to: e.target.value })}
            aria-label="To date"
          />
        </div>
        <div className="sm:col-span-2">
          <StrategyMultiSelect
            options={available.strategies}
            lists={lists}
            chosen={filters.names}
            onChange={(names) => setFilters({ names })}
            starred={starred}
            onToggleStar={
              favourites.set
                ? (selector) =>
                    isListSelector(selector)
                      ? favourites.toggleList(
                          selector.slice(LIST_PREFIX.length) as FavouriteListKey,
                        )
                      : favourites.toggleStrategy(selector)
                : undefined
            }
          />
          {starred.size > 0 ? (
            <button
              type="button"
              onClick={() => setFilters({ names: [...state.defaultNames] })}
              className="mt-1 w-fit text-xs text-primary hover:underline"
            >
              Reset to favourites
            </button>
          ) : null}
        </div>
      </div>
      {filters.names.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {filters.names.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setFilters({ names: filters.names.filter((x) => x !== n) })}
              className="rounded-full bg-surface-2 px-2.5 py-0.5 font-mono text-xs text-foreground ring-1 ring-inset ring-border hover:ring-border-strong"
              title="Remove from the comparison"
            >
              {selectorLabel(n)} ×
            </button>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function Summary({
  r,
  matrix,
}: { r: CorrelationResponse; matrix: CorrelationResponse['pearson'] }) {
  const avg = averagePairwise(matrix);
  const { alike } = extremePairs(matrix, r.names);
  const high = pairsAtOrAbove(matrix, 0.6);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Strategies"
        value={formatInt(r.names.length)}
        note={`${formatInt(r.n_days)} days in common, ${formatDay(r.days[0])} to ${formatDay(r.days[r.days.length - 1])}`}
      />
      <StatCard
        label="Average pair"
        value={formatNumber(avg, 2)}
        note={`${formatInt(high.n)} of ${formatInt(high.of)} pairs are 0.60 or more`}
        hint="The mean correlation over every pair. Near 0 means the strategies mostly do their own thing."
      />
      <StatCard
        label="Most alike pair"
        value={alike ? formatNumber(alike.value, 2) : '—'}
        note={alike ? `${alike.a} ~ ${alike.b}` : undefined}
        hint="The two strategies whose daily P&L move together most."
      />
      <StatCard
        label="Basket vs its parts"
        value={r.basket.dd_ratio === null ? '—' : formatMultiple(r.basket.dd_ratio, 2)}
        note={diversificationNote(r.basket.dd_ratio)}
        hint="All of them together, one lot each: the basket's biggest drawdown divided by the sum of each strategy's own. Below 1.00 is diversification."
      />
    </div>
  );
}

function Result({
  r,
  measure,
  setMeasure,
  selectors,
  range,
}: {
  r: CorrelationResponse;
  measure: CorrelationMeasure;
  setMeasure: (m: CorrelationMeasure) => void;
  selectors: string;
  range: { from?: string | undefined; to?: string | undefined };
}) {
  const [hover, setHover] = useState<Cell | null>(null);
  const [pinned, setPinned] = useState<Cell | null>(null);
  // A rotation list is shown by its name (`list:A` -> Steady); `raw` keeps the selector names
  // that a follow-up request (the basket pick) must send.
  const raw = r;
  r = useMemo(() => displayResponse(raw), [raw]);
  const notes = useMemo(() => reconstructedNotes(raw), [raw]);
  const basis = useMemo(() => basisNote(raw), [raw]);
  const matrix = useMemo(() => matrixOf(r, measure), [r, measure]);
  const view = useMemo(() => reorder(matrix, r.names, r.order), [matrix, r.names, r.order]);
  const rowAverage = useMemo(
    () =>
      r.pearson.map((row, i) => {
        const others = row.filter((v, j): v is number => j !== i && typeof v === 'number');
        return others.length ? others.reduce((s, v) => s + v, 0) / others.length : null;
      }),
    [r.pearson],
  );
  const shown = hover ?? pinned;
  const pair = shown ? pairReadout(r, view.index[shown[0]] ?? 0, view.index[shown[1]] ?? 0) : null;

  return (
    <div className="space-y-5">
      <Summary r={r} matrix={r.pearson} />
      {notes.length > 0 || basis ? (
        <ul className="space-y-0.5 text-xs text-muted" aria-label="About the lists">
          {basis ? <li>{basis}</li> : null}
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {r.stale.length > 0 ? (
        <StateMessage
          variant="error"
          title="Some results are from an older version of the strategy"
          description={`${r.stale.join(', ')} changed since these days were saved.`}
        />
      ) : null}

      <Card>
        <CardHeader
          title="How alike are they?"
          description={MEASURE_NOTE[measure]}
          actions={
            <SegmentedControl
              value={measure}
              options={MEASURE_OPTIONS}
              onChange={setMeasure}
              ariaLabel="Measure"
              size="sm"
            />
          }
        />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <CorrelationHeatmap
            names={view.names}
            matrix={view.m}
            hover={hover}
            pinned={pinned}
            onHover={setHover}
            onPin={setPinned}
            ariaLabel={`Correlation of ${r.names.length} strategies, ${MEASURE_LABEL[measure]}. Use the arrow keys to read a pair.`}
          />
          <PairCard pair={pair} pinned={hover === null && pinned !== null} />
        </div>
        <p className="mt-3 text-xs text-faint">
          In-sample: these are the days in the window, not a forecast. Rows are ordered so that
          strategies that move together sit next to each other.
        </p>
      </Card>

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader
            title="Each strategy"
            description="One lot each. “Alike to others” is the mean daily-P&L correlation with the rest."
          />
          <StrategyTable r={r} order={view.index} average={rowAverage} />
        </Card>
        <Card>
          <CardHeader
            title="A basket that is not alike"
            description="Pick the best-ranked strategies that do not move with one already kept."
          />
          <BasketBuilder selectors={selectors} names={raw.names} measure={measure} range={range} />
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Does it hold over time?"
          description={`The average pair's correlation in each block of ${r.window} trading days, with the most and least alike pair as the band. A pair that is unrelated on average can still move as one in a quarter.`}
        />
        <DriftChart rows={r.rolling} window={r.window} />
      </Card>
    </div>
  );
}

function StrategyPicker({
  state,
  favourites,
}: {
  state: ReturnType<typeof useCorrelationFilters>;
  favourites: ReturnType<typeof useFavourites>;
}) {
  const available = useCorrelationAvailable();
  // When the page is on its own defaults (no ?names=), drop starred items that no longer exist
  // (a strategy deleted since it was starred) so one stale star cannot break the comparison.
  const filters = useMemo(() => {
    // A comparison needs two: a set the page chose (the favourites, or an old link narrowed below)
    // that is left with one name is topped up with the built-in three, never shown as one.
    const atLeastTwo = (names: string[]) =>
      names.length >= 2 ? names : [...names, ...DEFAULT_NAMES.filter((n) => !names.includes(n))];
    // A rotation list the dashboard does not show is never compared, even from an old link.
    if (!state.filters.names.every(isShownSelector)) {
      return { ...state.filters, names: atLeastTwo(state.filters.names.filter(isShownSelector)) };
    }
    if (!state.usingDefaults || available.data === null) return state.filters;
    const known = new Set([
      ...available.data.strategies.map((s) => s.name),
      ...(available.data.lists ?? []).map((l) => l.selector),
    ]);
    return {
      ...state.filters,
      names: atLeastTwo(state.filters.names.filter((n) => known.has(n))),
    };
  }, [state.usingDefaults, state.filters, available.data]);
  const selectors = buildSelectors(filters);
  const result = useCorrelation(
    selectors,
    state.range,
    63,
    !state.waiting && available.data !== null,
  );

  if (available.error && available.data === null) {
    return (
      <StateMessage
        variant="error"
        title="Could not list the strategies"
        description={available.error}
      />
    );
  }
  if (available.data === null || state.waiting) return <SkeletonRows rows={6} />;
  if (available.data.strategies.length === 0) {
    return (
      <StateMessage
        variant="empty"
        title="No strategy has saved results yet"
        description="Results appear after the nightly rotation update (obt rotation update) and the evening run (obt daily)."
      />
    );
  }

  return (
    <div className="space-y-5">
      <Filters available={available.data} state={{ ...state, filters }} favourites={favourites} />
      <div className="flex items-center justify-between gap-3 text-xs text-muted">
        <span>
          Comparing{' '}
          <span className="font-mono">
            {selectors
              .split(',')
              .map((part) => selectorLabel(part))
              .join(', ')}
          </span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={result.refetch}
          disabled={result.loading}
          aria-label="Refresh correlation"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${result.loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </div>
      {result.error ? (
        <StateMessage variant="error" title="Cannot compare these yet" description={result.error} />
      ) : result.data === null ? (
        <SkeletonRows rows={8} />
      ) : (
        <Result
          r={result.data}
          measure={state.measure}
          setMeasure={state.setMeasure}
          selectors={selectors}
          range={state.range}
        />
      )}
    </div>
  );
}

type Mode = 'picker' | 'basket';
const MODE_OPTIONS: SegmentedOption<Mode>[] = [
  { value: 'picker', label: 'Pick strategies' },
  { value: 'basket', label: 'A day’s basket' },
];

/**
 * The Correlation tab: the strategy picker, and the "A day's basket" preset that fills it with
 * one list's picks for one day (or the fixed base). The mode lives in the URL (`?mode=basket`)
 * with the picker's own filters, so a link lands on the same view.
 */
export function CorrelationPanel() {
  const [modeQ, setModeQ] = useQueryState('mode');
  const favourites = useFavourites();
  // What the bare page opens on: the starred lists and strategies. null while they load; if they
  // cannot be loaded at all, the built-in three (undefined) rather than waiting for ever.
  const favouriteNames = favourites.set
    ? favouriteSelectors(favourites.set)
    : favourites.error !== null
      ? undefined
      : null;
  const state = useCorrelationFilters(favouriteNames);
  const mode: Mode = modeQ === 'basket' ? 'basket' : 'picker';
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl
          value={mode}
          options={MODE_OPTIONS}
          onChange={(m) => setModeQ(m === 'basket' ? 'basket' : null)}
          ariaLabel="What to compare"
          size="sm"
        />
        <SlippageSwitch extra="It reaches the rotation variants and lists only: a saved leg-wise strategy's figures are always without it." />
      </div>
      {mode === 'basket' ? (
        <CorrelationBasket
          onOpenCustom={(names, range) => {
            state.setFilters({ slot: ANY, family: ANY, index: ANY, kind: ANY, names });
            state.setRange({ from: range.from ?? null, to: range.to ?? null });
            setModeQ(null);
          }}
        />
      ) : (
        <StrategyPicker state={state} favourites={favourites} />
      )}
    </div>
  );
}
