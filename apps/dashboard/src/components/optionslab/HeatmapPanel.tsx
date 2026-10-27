/**
 * Options Lab → Heatmap: what an ATM short straddle made at each entry time and stop loss.
 *
 * The AlgoTest Heatmap grid, computed from the lake's 1-minute option bars: sell the at-the-money
 * call and put at the entry time, each leg with its own stop at a percentage above its entry
 * price, exit at the exit time. Three views (Time vs SL for a day, Date vs Time at one stop,
 * Date vs SL at one entry time), every index and every stock the lake has, and a
 * weeks-to-expiry filter. The figures come from `GET /legwise/heatmap` (`heatmap/view.py`), read
 * from grids `obt heatmap build` stores; this component only lays them out.
 *
 * Everything is a historical replay with no costs or slippage: a description, not a forecast.
 */

import { Download, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';

import { type HeatmapParams, useHeatmap, useHeatmapAvailable } from '../../hooks/useHeatmap';
import { navigateToLink, useQueryState } from '../../hooks/useQueryState';
import { formatDay, formatInt } from '../../lib/format';
import {
  ALL_STOCKS,
  NO_SL,
  NO_SL_HINT,
  VIEW_LABEL,
  WEEK_LABEL,
  cellClass,
  formatCell,
  matrixFamilyStartHref,
  maxAbsOf,
  metricLabel,
  settingsChips,
  slLabel,
  slLevels,
  slOptionLabel,
  toCsv,
  unitNote,
} from '../../lib/heatmapView';
import type {
  HeatmapAvailable,
  HeatmapCell,
  HeatmapMetric,
  HeatmapResponse,
  HeatmapUnderlying,
  HeatmapViewKey,
} from '../../types/heatmap';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Drawer } from '../ui/Drawer';
import { InfoTooltip } from '../ui/InfoTooltip';
import { Input, Select } from '../ui/Input';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';

const VIEW_OPTIONS: { value: HeatmapViewKey; label: string }[] = (
  ['time_sl', 'date_time', 'date_sl'] as const
).map((value) => ({ value, label: VIEW_LABEL[value] }));

const METRIC_OPTIONS: SegmentedOption<HeatmapMetric>[] = [
  { value: 'value', label: 'P&L' },
  { value: 'pct', label: '% of premium' },
];

type Split = 'net' | 'split';
const SPLIT_OPTIONS: SegmentedOption<Split>[] = [
  { value: 'net', label: 'Straddle' },
  { value: 'split', label: 'Split PE / CE' },
];

const WEEKS = [0, 1, 2, 3, 4] as const;

function downloadCsv(r: HeatmapResponse, split: boolean) {
  const blob = new Blob([toCsv(r, split)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `heatmap-${r.underlying}-${r.view}-${r.exit_time.replace(':', '')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function rowLabel(view: HeatmapViewKey, row: string): string {
  return view === 'time_sl' ? row : formatDay(row);
}

function columnLabel(view: HeatmapViewKey, col: string | number): string {
  if (view === 'date_time') return String(col);
  return slLabel(col);
}

/** The No SL column exists only where the columns are stop losses. */
function isNoSl(view: HeatmapViewKey, col: string | number | undefined): boolean {
  return view !== 'date_time' && Number(col) === NO_SL;
}

function Cell({
  cell,
  maxAbs,
  unit,
  split,
  bold,
  noSl,
}: {
  cell: HeatmapCell | null;
  maxAbs: number;
  unit: HeatmapResponse['unit'];
  split: boolean;
  bold?: boolean;
  /** The No SL column: set apart by a heavier left edge. */
  noSl?: boolean;
}) {
  const tone = cellClass(cell?.net, maxAbs);
  return (
    <td
      className={`${tone} whitespace-nowrap border border-surface px-2 py-1.5 text-center font-mono text-xs tabular-nums ${bold ? 'font-semibold' : ''} ${noSl ? 'border-l-2 border-l-border-strong' : ''}`}
      title={
        cell
          ? `${noSl ? `${NO_SL_HINT}. ` : ''}Call ${formatCell(cell.ce, unit)} · Put ${formatCell(cell.pe, unit)} · ${formatInt(cell.n)} straddle${cell.n === 1 ? '' : 's'}`
          : noSl
            ? `${NO_SL_HINT}. Nothing stored for it (not built yet, or no straddle)`
            : 'No straddle'
      }
    >
      {cell ? (
        split ? (
          <span className="flex flex-col leading-tight">
            <span>{formatCell(cell.pe, unit)}</span>
            <span className="text-muted">{formatCell(cell.ce, unit)}</span>
          </span>
        ) : (
          formatCell(cell.net, unit)
        )
      ) : (
        '—'
      )}
    </td>
  );
}

function HeatmapTable({ r, split }: { r: HeatmapResponse; split: boolean }) {
  const maxAbs = useMemo(
    () => maxAbsOf([...r.cells, r.row_totals, r.column_totals]),
    [r.cells, r.row_totals, r.column_totals],
  );
  const first =
    r.view === 'time_sl'
      ? 'TIME ↓  SL % →'
      : r.view === 'date_time'
        ? 'DATE ↓  TIME →'
        : 'DATE ↓  SL % →';
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-surface-2 px-2 py-2 text-left text-xs font-semibold text-muted">
              {first}
            </th>
            {r.columns.map((c) => (
              <th
                key={c}
                title={isNoSl(r.view, c) ? NO_SL_HINT : undefined}
                className={`px-2 py-2 text-center font-mono text-xs font-semibold text-muted ${isNoSl(r.view, c) ? 'border-l-2 border-l-border-strong' : ''}`}
              >
                {columnLabel(r.view, c)}
              </th>
            ))}
            <th className="bg-surface-2 px-2 py-2 text-center text-xs font-semibold text-foreground">
              TOTAL
            </th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row, i) => (
            <tr key={row}>
              <th className="sticky left-0 z-10 whitespace-nowrap bg-surface-2 px-2 py-1.5 text-left font-mono text-xs font-medium text-foreground">
                {rowLabel(r.view, row)}
              </th>
              {(r.cells[i] ?? []).map((cell, j) => (
                <Cell
                  key={`${row}-${r.columns[j]}`}
                  cell={cell}
                  maxAbs={maxAbs}
                  unit={r.unit}
                  split={split}
                  noSl={isNoSl(r.view, r.columns[j])}
                />
              ))}
              <Cell
                cell={r.row_totals[i] ?? null}
                maxAbs={maxAbs}
                unit={r.unit}
                split={split}
                bold
              />
            </tr>
          ))}
          <tr>
            <th className="sticky left-0 z-10 bg-surface-2 px-2 py-1.5 text-left text-xs font-semibold text-foreground">
              TOTAL
            </th>
            {r.column_totals.map((cell, j) => (
              <Cell
                key={`total-${r.columns[j]}`}
                cell={cell}
                maxAbs={maxAbs}
                unit={r.unit}
                split={split}
                bold
                noSl={isNoSl(r.view, r.columns[j])}
              />
            ))}
            <Cell cell={r.total} maxAbs={maxAbs} unit={r.unit} split={split} bold />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function bestOf(r: HeatmapResponse): { label: string; value: number } | null {
  let best: { label: string; value: number } | null = null;
  r.cells.forEach((line, i) =>
    line.forEach((cell, j) => {
      if (cell && (best === null || cell.net > best.value)) {
        best = {
          label: `${rowLabel(r.view, r.rows[i] ?? '')} · ${columnLabel(r.view, r.columns[j] ?? '')}`,
          value: cell.net,
        };
      }
    }),
  );
  return best;
}

function Summary({ r }: { r: HeatmapResponse }) {
  const best = bestOf(r);
  const days = `${formatInt(r.days.length)} day${r.days.length === 1 ? '' : 's'}`;
  // Exit and metric repeat the controls above, so they are one muted line of basis, not two cards.
  const basis = [
    `Exit ${r.exit_time}`,
    metricLabel(r.metric),
    'no costs or slippage',
    r.kind === 'stock' ? 'stock options: monthly expiry only' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 rounded-lg border border-border bg-surface-2/60 px-4 py-2">
      <div className="flex min-w-0 items-baseline gap-2" title={`${days}, ${unitNote(r)}`}>
        <span className="text-xs font-medium uppercase tracking-wider text-faint">Total</span>
        <span className="metric text-base font-semibold tracking-tight text-foreground">
          {r.total ? formatCell(r.total.net, r.unit) : '—'}
        </span>
        <span className="text-xs text-muted">{days}</span>
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="flex items-center gap-1 self-center text-xs font-medium uppercase tracking-wider text-faint">
          Best cell
          <InfoTooltip
            text="The largest single cell on screen. One cell is a few days at one setting, so it is a place to look, not a rule."
            label="About Best cell"
          />
        </span>
        <span className="metric text-base font-semibold tracking-tight text-foreground">
          {best ? formatCell(best.value, r.unit) : '—'}
        </span>
        {best ? <span className="truncate text-xs text-muted">{best.label}</span> : null}
      </div>
      <p
        className="min-w-0 text-xs text-muted"
        title={`${unitNote(r)}. Legs not stopped exit at ${r.exit_time}; no costs or slippage.`}
      >
        {basis}
      </p>
    </div>
  );
}

function Controls({
  available,
  current,
  setters,
}: {
  available: HeatmapAvailable;
  current: ReturnType<typeof useHeatmapSettings>;
  setters: ReturnType<typeof useHeatmapSettings>['set'];
}) {
  const { view, underlying, date, from, to, sl, time, exit, metric, weeks, info } = current;
  const indices = available.underlyings.filter((u) => u.kind === 'index');
  const stocks = available.underlyings.filter(
    (u) => u.kind === 'stock' && u.underlying !== ALL_STOCKS,
  );
  const hasPool = available.underlyings.some((u) => u.underlying === ALL_STOCKS);
  const indexOptions: SegmentedOption<string>[] = indices.map((u) => ({
    value: u.underlying,
    label: u.underlying,
  }));
  return (
    <Card>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-xs text-muted">
          Table configuration
          <Select
            value={view}
            onChange={(e) => setters.view(e.target.value as HeatmapViewKey)}
            aria-label="Table configuration"
          >
            {VIEW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {view === 'time_sl' ? (
          <>
            <div className="flex flex-col gap-1 text-xs text-muted">
              Date
              <Input
                type="date"
                value={date}
                min={info?.first_day}
                max={info?.last_day}
                onChange={(e) => setters.date(e.target.value)}
                aria-label="Date"
              />
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted">
              To (optional, sums the days)
              <Input
                type="date"
                value={to}
                min={date}
                max={info?.last_day}
                onChange={(e) => setters.to(e.target.value)}
                aria-label="To date"
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1 text-xs text-muted">
              Start date
              <Input
                type="date"
                value={from}
                min={info?.first_day}
                max={info?.last_day}
                onChange={(e) => setters.from(e.target.value)}
                aria-label="Start date"
              />
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted">
              End date
              <Input
                type="date"
                value={to}
                min={from}
                max={info?.last_day}
                onChange={(e) => setters.to(e.target.value)}
                aria-label="End date"
              />
            </div>
          </>
        )}
        {view === 'date_time' ? (
          <div className="flex flex-col gap-1 text-xs text-muted">
            Stop loss
            <Select
              value={String(sl)}
              onChange={(e) => setters.sl(Number(e.target.value))}
              aria-label="Stop loss"
            >
              {slLevels(available).map((s) => (
                <option key={s} value={s}>
                  {slOptionLabel(s)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {view === 'date_sl' ? (
          <div className="flex flex-col gap-1 text-xs text-muted">
            Entry time
            <Select
              value={time}
              onChange={(e) => setters.time(e.target.value)}
              aria-label="Entry time"
            >
              {available.times.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
          Index
          <SegmentedControl
            value={indices.some((u) => u.underlying === underlying) ? underlying : ''}
            options={indexOptions}
            onChange={setters.underlying}
            ariaLabel="Index"
            size="sm"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          Stock (monthly expiry)
          <Select
            value={
              underlying === ALL_STOCKS || stocks.some((u) => u.underlying === underlying)
                ? underlying
                : ''
            }
            onChange={(e) => e.target.value && setters.underlying(e.target.value)}
            aria-label="Stock"
          >
            <option value="">Pick a stock…</option>
            {hasPool ? <option value={ALL_STOCKS}>All F&O stocks (% of premium)</option> : null}
            {stocks.map((u) => (
              <option key={u.underlying} value={u.underlying}>
                {u.underlying}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          Exit
          <Select
            value={exit}
            onChange={(e) => setters.exit(e.target.value)}
            aria-label="Exit time"
          >
            {available.exit_times.map((t) => (
              <option key={t} value={t}>
                {t}
                {t === '15:15' ? ' (AlgoTest’s own)' : ''}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <SegmentedControl
          value={metric}
          options={METRIC_OPTIONS.map((o) => ({
            ...o,
            disabled: underlying === ALL_STOCKS && o.value === 'value',
          }))}
          onChange={setters.metric}
          ariaLabel="Metric"
          size="sm"
        />
        <SegmentedControl
          value={current.split}
          options={SPLIT_OPTIONS}
          onChange={setters.split}
          ariaLabel="Straddle or split"
          size="sm"
        />
        {info?.expiry === 'weekly' ? (
          <p className="text-xs text-faint">Weekly expiry: every day is in its expiry week.</p>
        ) : (
          <fieldset className="flex flex-wrap items-center gap-1.5">
            <legend className="sr-only">Weeks to expiry</legend>
            <span className="text-xs text-muted">Weeks to expiry</span>
            {WEEKS.map((w) => {
              const on = weeks.includes(w);
              return (
                <button
                  key={w}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setters.weeks(on ? weeks.filter((x) => x !== w) : [...weeks, w].sort())
                  }
                  className={`rounded-full px-2.5 py-0.5 text-xs ring-1 ring-inset ${
                    on
                      ? 'bg-primary/15 text-foreground ring-primary/40'
                      : 'bg-surface-2 text-muted ring-border hover:ring-border-strong'
                  }`}
                >
                  {WEEK_LABEL[w]}
                </button>
              );
            })}
            {weeks.length > 0 ? (
              <button
                type="button"
                onClick={() => setters.weeks([])}
                className="text-xs text-muted underline"
              >
                all weeks
              </button>
            ) : null}
          </fieldset>
        )}
      </div>
    </Card>
  );
}

/** The settings, kept in the URL query so a link or a refresh lands on the same table. */
function useHeatmapSettings(available: HeatmapAvailable) {
  const [viewQ, setViewQ] = useQueryState('view');
  const [underlyingQ, setUnderlyingQ] = useQueryState('u');
  const [dateQ, setDateQ] = useQueryState('date');
  const [fromQ, setFromQ] = useQueryState('from');
  const [toQ, setToQ] = useQueryState('to');
  const [slQ, setSlQ] = useQueryState('sl');
  const [timeQ, setTimeQ] = useQueryState('time');
  const [exitQ, setExitQ] = useQueryState('exit');
  const [metricQ, setMetricQ] = useQueryState('metric');
  const [weeksQ, setWeeksQ] = useQueryState('weeks');
  const [splitQ, setSplitQ] = useQueryState('split');

  const view: HeatmapViewKey = (VIEW_OPTIONS.find((o) => o.value === viewQ)?.value ??
    'time_sl') as HeatmapViewKey;
  const names = available.underlyings.map((u) => u.underlying);
  const underlying =
    underlyingQ && names.includes(underlyingQ)
      ? underlyingQ
      : names.includes('NIFTY')
        ? 'NIFTY'
        : (names[0] ?? 'NIFTY');
  const info: HeatmapUnderlying | undefined = available.underlyings.find(
    (u) => u.underlying === underlying,
  );
  const last = info?.last_day ?? '';
  const date = dateQ && /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : last;
  const to = toQ && /^\d{4}-\d{2}-\d{2}$/.test(toQ) ? toQ : view === 'time_sl' ? '' : last;
  const from = fromQ && /^\d{4}-\d{2}-\d{2}$/.test(fromQ) ? fromQ : last ? addDays(last, -14) : '';
  const levels = slLevels(available);
  const sl = slQ !== null && levels.includes(Number(slQ)) ? Number(slQ) : (levels[0] ?? 10);
  const time = timeQ && available.times.includes(timeQ) ? timeQ : (available.times[0] ?? '09:16');
  const exit =
    exitQ && available.exit_times.includes(exitQ) ? exitQ : (available.exit_times[0] ?? '15:30');
  // points per share cannot be added across stocks, so the pooled view is always % of premium
  const metric: HeatmapMetric = metricQ === 'pct' || underlying === ALL_STOCKS ? 'pct' : 'value';
  // a weekly index is always in its expiry week, so the filter only means something for monthly
  const weeks = (info?.expiry === 'weekly' ? '' : (weeksQ ?? ''))
    .split(',')
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 9);
  const split: Split = splitQ === 'split' ? 'split' : 'net';

  return {
    view,
    underlying,
    info,
    date,
    from,
    to,
    sl,
    time,
    exit,
    metric,
    weeks,
    split,
    set: {
      view: (v: HeatmapViewKey) => setViewQ(v === 'time_sl' ? null : v),
      // a new underlying has its own span of days: drop the dates chosen for the old one
      underlying: (u: string) => {
        setUnderlyingQ(u === 'NIFTY' ? null : u);
        setDateQ(null);
        setFromQ(null);
        setToQ(null);
      },
      date: (v: string) => setDateQ(v || null),
      from: (v: string) => setFromQ(v || null),
      to: (v: string) => setToQ(v || null),
      sl: (v: number) => setSlQ(String(v)),
      time: (v: string) => setTimeQ(v),
      exit: (v: string) => setExitQ(v),
      metric: (v: HeatmapMetric) => setMetricQ(v === 'value' ? null : v),
      weeks: (v: number[]) => setWeeksQ(v.length ? v.join(',') : null),
      split: (v: Split) => setSplitQ(v === 'net' ? null : v),
    },
  };
}

function Result({ params, split }: { params: HeatmapParams; split: boolean }) {
  const result = useHeatmap(params);
  if (result.error && result.data === null) {
    return <StateMessage variant="error" title="Cannot draw this yet" description={result.error} />;
  }
  if (result.data === null) return <SkeletonRows rows={8} />;
  const r = result.data;
  return (
    <div className="space-y-5">
      <Summary r={r} />
      {result.error ? (
        <StateMessage variant="error" title="Showing the last result" description={result.error} />
      ) : null}
      <Card>
        <CardHeader
          title={`${r.underlying} short straddle · ${VIEW_LABEL[r.view]}`}
          description={`${unitNote(r)}. ${r.view === 'date_time' && r.filters.sl === NO_SL ? `No stop loss: both legs are held to ${r.exit_time}.` : `Each leg has its own stop at the SL % above its entry price; legs not stopped exit at ${r.exit_time}. ${slLabel(NO_SL)} holds both legs to the exit with no stop.`}`}
          actions={
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => downloadCsv(r, split)}
                disabled={r.rows.length === 0}
                aria-label="Download CSV"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                CSV
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={result.refetch}
                disabled={result.loading}
                aria-label="Refresh heatmap"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${result.loading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                Refresh
              </Button>
            </div>
          }
        />
        {r.rows.length === 0 ? (
          <StateMessage
            variant="empty"
            title="No straddles for these settings"
            description="Pick another date range or clear the weeks-to-expiry filter."
          />
        ) : (
          <HeatmapTable r={r} split={split} />
        )}
        <p className="mt-3 text-xs text-faint">
          Replay of the collected 1-minute bars with no costs or slippage, at the ATM strike of the
          entry minute. Cells are one lot (index) or one share (stock); a range sums the days in it.
        </p>
      </Card>
    </div>
  );
}

function HeatmapBody({ available }: { available: HeatmapAvailable }) {
  const s = useHeatmapSettings(available);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const params: HeatmapParams | null = (() => {
    if (!s.info) return null;
    const base = {
      underlying: s.underlying,
      view: s.view,
      exit: s.exit,
      metric: s.metric,
      weeks: s.weeks,
    };
    if (s.view === 'time_sl')
      return { ...base, date: s.date, to: s.to || undefined, from: s.to ? s.date : undefined };
    if (s.view === 'date_time') return { ...base, from: s.from, to: s.to, sl: s.sl };
    return { ...base, from: s.from, to: s.to, time: s.time };
  })();
  // A single-date request carries `date`; a summed range sends from/to.
  const fixed: HeatmapParams | null =
    params && s.view === 'time_sl' && s.to
      ? { ...params, date: undefined, from: s.date, to: s.to }
      : params;
  const chips = settingsChips({
    ...s,
    kind: s.info?.kind === 'stock' ? 'stock' : 'index',
    split: s.split === 'split',
  });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2">
        {chips.map((chip) => (
          <span
            key={chip}
            className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-foreground"
          >
            {chip}
          </span>
        ))}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => setSettingsOpen(true)}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Change
        </Button>
      </div>
      <Drawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title="Heatmap settings"
        subtitle="Table, dates, index or stock, exit and unit. The table updates as you change them."
      >
        <Controls available={available} current={s} setters={s.set} />
      </Drawer>
      {fixed ? (
        <Result params={fixed} split={s.split === 'split'} />
      ) : (
        <StateMessage variant="empty" title="Pick an index or a stock" />
      )}
      <MatrixLink href={matrixFamilyStartHref(s)} />
    </div>
  );
}

/** The question this page used to answer in a second card now lives on the Matrix. */
function MatrixLink({ href }: { href: string }) {
  return (
    <p className="text-xs text-muted">
      Strategy types by entry time are in the{' '}
      <a
        href={href}
        className="text-primary underline-offset-2 hover:underline"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigateToLink(href);
        }}
      >
        Matrix (Family × start, the same days)
      </a>
      .
    </p>
  );
}

function StraddleSection() {
  const available = useHeatmapAvailable();
  if (available.error && available.data === null) {
    return (
      <StateMessage
        variant="error"
        title="Could not list the heatmap data"
        description={available.error}
      />
    );
  }
  if (available.data === null) return <SkeletonRows rows={6} />;
  if (available.data.underlyings.length === 0) {
    return (
      <StateMessage
        variant="empty"
        title="No heatmap has been built yet"
        description="Run obt heatmap build (indices) and obt heatmap build --stocks, or wait for the evening run."
      />
    );
  }
  return <HeatmapBody available={available.data} />;
}

export function HeatmapPanel() {
  return <StraddleSection />;
}
