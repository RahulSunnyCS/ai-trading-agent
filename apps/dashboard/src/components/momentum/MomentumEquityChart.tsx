'use client';

import { ChevronDown } from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  getChartTheme,
  getSeriesPalette,
  pickSeries,
  plotlyChrome,
  seriesCssColor,
  withAlpha,
} from '../../lib/chartTheme';
import { cn } from '../../lib/cn';
import { EMPTY, formatDay, formatInr, formatInt, formatPct } from '../../lib/format';
import {
  EQUITY_RANGES,
  type EquityRange,
  ROTATION_THIN_ABOVE_WEEKS,
  type RangeLine,
  type RotationKind,
  type WeekSummary,
  countVisibleWeeks,
  drawdownStats,
  fitNames,
  fittedNamesText,
  headroomRange,
  latestValue,
  rangeStartIndex,
  rebaseFactor,
  rebaseSeries,
  rotationKind,
  rotationMarkersShown,
  rotationOnOrBefore,
  sliceSeries,
  startIndexFor,
  thinRotations,
  tooltipPlacement,
  weekChangeCounts,
  weekReturn,
  weekSummary,
} from '../../lib/momentumResult';
import { type PlotlyBasic, loadPlotly } from '../../lib/plotly';
import { useMomentumViewStore } from '../../store/momentumView';
import { useThemeStore } from '../../store/theme';
import type {
  MomentumComparison,
  MomentumRotation,
  MomentumSavedRun,
  MomentumSeries,
} from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { SegmentedControl } from '../ui/SegmentedControl';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { useResultFlash } from './MomentumRunProgress';

type PlotEvent = 'plotly_hover' | 'plotly_unhover' | 'plotly_click' | 'plotly_relayout';
/** Plotly.react() attaches event-emitter methods to the div at runtime; not in the DOM lib types. */
type PlotlyHTMLElement = HTMLDivElement & {
  on?: (event: PlotEvent, handler: (event: Record<string, unknown>) => void) => void;
  removeAllListeners?: (event: PlotEvent) => void;
};

const PLOT_EVENTS: PlotEvent[] = [
  'plotly_hover',
  'plotly_unhover',
  'plotly_click',
  'plotly_relayout',
];

/** Plot height with only the value panel, and with the drawdown + 52-week-edge rows under it. */
/** The held count at a week; a week the series leaves blank carries the last known count. */
function heldAt(counts: ReadonlyArray<number | null>, index: number): number | null {
  for (let i = Math.min(index, counts.length - 1); i >= 0; i--) {
    const value = counts[i];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

const PLOT_HEIGHT = 460;
const PLOT_HEIGHT_WITH_RISK = 720;
/** The plot's margins; the week box sits just inside the top-left corner of the plot area. */
const PLOT_MARGIN = { l: 66, r: 18, t: 8, b: 36 } as const;
const BOX_INSET = 8;
/** The week box takes at most this share of the plot's width, but never less than the minimum. */
const BOX_SHARE = 0.45;
const BOX_MIN_WIDTH = 200;
/** Average width of a text-xs character (tickers are mostly capitals), and the box's padding. */
const BOX_CHAR_PX = 7;
const BOX_PADDING_PX = 18;
/** Characters the "▲ 12 IN" / "▼ 12 OUT" label takes before the names. */
const BOX_LABEL_CHARS = 10;
/** Rows per list in the advanced tooltip before "+N more". */
const TOOLTIP_MAX_ROWS = 10;
/** Characters for the topped-up / trimmed name lists in the advanced tooltip. */
const TOOLTIP_NAME_CHARS = 48;
const ROTATIONS_KEY = 'rotations';

/** Marker colour per rotation kind (Plotly needs strings, so these come from the chart theme). */
const KIND_COLOR: Record<RotationKind, 'positive' | 'negative' | 'warning' | 'text'> = {
  added: 'positive',
  out: 'negative',
  both: 'warning',
  other: 'text',
};

const lakh = (value: number | null) => (value === null ? null : value / 100_000);

/** The x of the first point of a Plotly hover / click event, as an ISO day. */
function eventDay(event: Record<string, unknown>): string | null {
  const points = event.points as Array<{ x?: unknown }> | undefined;
  const x = points?.[0]?.x;
  return x == null ? null : String(x).slice(0, 10);
}

function signTone(value: number | null | undefined): string {
  if (value == null || value === 0) return 'text-muted';
  return value > 0 ? 'text-positive' : 'text-negative';
}

type Dash = 'solid' | 'dot' | 'dash' | 'dashdot';

interface LegendItem {
  key: string;
  name: string;
  value: number | null;
  dash: Dash;
  /** A token class for the swatch colour, or a CSS colour for a series-palette line. */
  swatchClass?: string;
  swatchColor?: string;
}

const DASH_CLASS: Record<Dash, string> = {
  solid: 'border-solid',
  dot: 'border-dotted',
  dash: 'border-dashed',
  dashdot: 'border-dashed',
};

/** One line of the chart as a legend entry: swatch, name, value at the active week. Toggles it. */
function LegendButton({
  item,
  hidden,
  onToggle,
}: { item: LegendItem; hidden: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={!hidden}
      onClick={onToggle}
      title={hidden ? `Show ${item.name}` : `Hide ${item.name}`}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-1 py-0.5 text-xs transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        hidden && 'opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('w-4 border-t-2', DASH_CLASS[item.dash], item.swatchClass)}
        style={item.swatchColor ? { borderColor: item.swatchColor } : undefined}
      />
      <span className={cn('text-muted', hidden && 'line-through')}>{item.name}</span>
      <span className="font-mono font-medium tabular-nums text-foreground">
        {hidden ? EMPTY : formatInr(item.value, { compact: true })}
      </span>
    </button>
  );
}

type WeekStatus = 'Latest' | 'Pinned' | 'Hovered';

/** "NAME +27%" for an exit; the name alone when its return is unknown. */
function exitLabel(row: { asset: string; return: number | null }): string {
  return row.return == null
    ? row.asset
    : `${row.asset} ${formatPct(row.return, 0, { sign: true })}`;
}

/** The week's return, signed and coloured, then "this week". */
function WeekReturn({ value }: { value: number | null }) {
  return (
    <>
      <span className={cn('font-mono font-medium tabular-nums', signTone(value))}>
        {formatPct(value, 2, { sign: true })}
      </span>
      <span className="text-faint"> this week</span>
    </>
  );
}

/**
 * The week in words, in the plot's top-left corner (TradingView style), one fact per line.
 * It ignores the pointer so hovering through it still reaches the chart, and as an overlay it
 * cannot move the plot when its height changes.
 */
function WeekBox({
  day,
  status,
  summary,
  rotation,
  idle,
  weekReturnValue,
  maxWidth,
}: {
  day: string;
  status: WeekStatus;
  summary: WeekSummary;
  rotation: MomentumRotation | undefined;
  idle: number;
  weekReturnValue: number | null;
  maxWidth: number;
}) {
  const nameChars = Math.max(
    Math.floor((maxWidth - BOX_PADDING_PX) / BOX_CHAR_PX) - BOX_LABEL_CHARS,
    0,
  );
  const ins = fitNames(
    (rotation?.ins ?? []).filter((row) => !row.top_up).map((row) => row.asset),
    nameChars,
  );
  const outs = rotation?.outs ?? [];
  const outFit = fitNames(outs.map(exitLabel), nameChars);
  const shownOuts = outs.slice(0, outFit.shown.length);
  const adjustments = [
    summary.toppedUp > 0 ? `Topped up ${formatInt(summary.toppedUp)}` : null,
    summary.trimmed > 0 ? `Trimmed ${formatInt(summary.trimmed)}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <section
      aria-label="Week readout"
      className="pointer-events-none absolute z-10 space-y-0.5 rounded-lg border border-border bg-surface/80 px-2 py-1.5 text-xs shadow-card backdrop-blur-sm"
      style={{ left: PLOT_MARGIN.l + BOX_INSET, top: PLOT_MARGIN.t + BOX_INSET, maxWidth }}
    >
      <p className="flex items-center gap-1.5 whitespace-nowrap">
        <Badge tone={status === 'Latest' ? 'neutral' : 'primary'}>{status}</Badge>
        <span className="text-faint">·</span>
        <span className="font-semibold text-foreground">Week of {formatDay(day)}</span>
      </p>
      {summary.inCount > 0 ? (
        <p className="truncate">
          <span className="font-medium text-foreground">▲ {formatInt(summary.inCount)} IN</span>{' '}
          <span className="text-muted">{fittedNamesText(ins)}</span>
        </p>
      ) : null}
      {summary.outCount > 0 ? (
        <p className="truncate">
          <span className="font-medium text-foreground">▼ {formatInt(summary.outCount)} OUT</span>{' '}
          {shownOuts.map((row, index) => (
            <span key={row.asset} className="text-muted">
              {index > 0 ? ', ' : ''}
              {row.asset}
              {row.return == null ? null : (
                <span className={cn('tabular-nums', signTone(row.return))}>
                  {' '}
                  {formatPct(row.return, 0, { sign: true })}
                </span>
              )}
            </span>
          ))}
          {outFit.more > 0 ? <span className="text-muted"> +{outFit.more} more</span> : null}
        </p>
      ) : null}
      {adjustments.length > 0 ? (
        <p className="whitespace-nowrap text-muted">{adjustments.join(' · ')}</p>
      ) : null}
      {summary.kind === 'none' ? <p className="text-muted">No change</p> : null}
      <p className="whitespace-nowrap">
        {summary.kind === 'parked' ? (
          <span className="font-medium text-warning">Parked in the liquid fund</span>
        ) : (
          <span className="text-muted">
            Held {summary.held === null ? EMPTY : formatInt(summary.held)}
            {idle > 0.001 ? ` · ${formatPct(idle)} cash` : ''}
          </span>
        )}
        <span className="text-faint"> · </span>
        <WeekReturn value={weekReturnValue} />
      </p>
    </section>
  );
}

function TipHeading({ children }: { children: ReactNode }) {
  return (
    <p className="mb-0.5 mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
      {children}
    </p>
  );
}

function TipMore({ count }: { count: number }) {
  return count > 0 ? (
    <p className="text-faint">+{formatInt(count)} more · click the week to pin the full list</p>
  ) : null;
}

/**
 * The advanced tooltip: the hovered week's full detail, floating by the cursor. The parent
 * positions it (through `innerRef`) after every render and on every mouse move.
 */
function WeekTooltip({
  innerRef,
  day,
  rotation,
  held,
  weekReturnValue,
}: {
  innerRef: RefObject<HTMLDivElement>;
  day: string;
  rotation: MomentumRotation | undefined;
  held: number | null;
  weekReturnValue: number | null;
}) {
  const share = new Map((rotation?.holdings ?? []).map((row) => [row.asset, row.share]));
  const entries = (rotation?.ins ?? []).filter((row) => !row.top_up);
  const topUps = (rotation?.ins ?? []).filter((row) => row.top_up).map((row) => row.asset);
  const outs = rotation?.outs ?? [];
  const trims = (rotation?.trims ?? []).map((row) => row.asset);
  const parked = Boolean(rotation?.parked) || held === 0;
  return (
    <div
      ref={innerRef}
      role="tooltip"
      className="pointer-events-none absolute left-0 top-0 z-30 w-max max-w-[360px] rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-elevated"
    >
      <p className="font-semibold text-foreground">Week of {formatDay(day)}</p>
      {!rotation ? <p className="text-muted">No trades this week.</p> : null}
      {rotation?.parked ? (
        <p className="text-warning">Nothing qualified: the money went to the liquid fund.</p>
      ) : null}
      {entries.length > 0 ? (
        <>
          <TipHeading>In · {formatInt(entries.length)}</TipHeading>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3">
            {entries.slice(0, TOOLTIP_MAX_ROWS).map((row) => (
              <div key={row.asset} className="contents">
                <span className="truncate text-foreground">{row.asset}</span>
                <span className="text-right font-mono tabular-nums text-muted">
                  {row.rank == null ? EMPTY : `#${formatInt(row.rank)}`}
                </span>
                <span className="text-right font-mono tabular-nums text-muted">
                  {formatPct(share.get(row.asset))}
                </span>
              </div>
            ))}
          </div>
          <TipMore count={entries.length - TOOLTIP_MAX_ROWS} />
        </>
      ) : null}
      {outs.length > 0 ? (
        <>
          <TipHeading>Out · {formatInt(outs.length)}</TipHeading>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_minmax(0,8rem)] gap-x-3">
            {outs.slice(0, TOOLTIP_MAX_ROWS).map((row) => (
              <div key={row.asset} className="contents">
                <span className="truncate text-foreground">{row.asset}</span>
                <span className={cn('text-right font-mono tabular-nums', signTone(row.return))}>
                  {formatPct(row.return, 1, { sign: true })}
                </span>
                <span className="text-right font-mono tabular-nums text-muted">
                  {row.weeks_held == null ? EMPTY : `${formatInt(row.weeks_held)} wk`}
                </span>
                <span className="truncate text-muted">{row.reason || EMPTY}</span>
              </div>
            ))}
          </div>
          <TipMore count={outs.length - TOOLTIP_MAX_ROWS} />
        </>
      ) : null}
      {topUps.length > 0 ? (
        <p className="mt-1.5">
          <span className="text-faint">Topped up {formatInt(topUps.length)}: </span>
          <span className="text-muted">
            {fittedNamesText(fitNames(topUps, TOOLTIP_NAME_CHARS))}
          </span>
        </p>
      ) : null}
      {trims.length > 0 ? (
        <p className={topUps.length > 0 ? '' : 'mt-1.5'}>
          <span className="text-faint">Trimmed {formatInt(trims.length)}: </span>
          <span className="text-muted">{fittedNamesText(fitNames(trims, TOOLTIP_NAME_CHARS))}</span>
        </p>
      ) : null}
      <p className="mt-1.5 border-t border-border pt-1.5">
        {parked ? (
          <span className="font-medium text-warning">Parked in the liquid fund</span>
        ) : (
          <span className="text-muted">Held {held === null ? EMPTY : formatInt(held)}</span>
        )}
        <span className="text-faint"> · </span>
        <WeekReturn value={weekReturnValue} />
      </p>
    </div>
  );
}

function ChangeGroup({
  title,
  count,
  children,
}: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-faint">
        {title} · {formatInt(count)}
      </h4>
      {count === 0 ? <p className="text-xs text-muted">None this week.</p> : children}
    </div>
  );
}

/**
 * The full detail of one week's rotation, with no height cap: every entry and exit on its own
 * row. It follows the pinned week (or the latest), never the hovered one, so moving the mouse
 * over the chart cannot change its height and move the plot.
 */
function WeekChanges({
  day,
  rotation,
  holdingsRotation,
  hoverDay,
}: {
  day: string;
  rotation: MomentumRotation | undefined;
  /** The last rotation on or before `day`: what is held after this week. */
  holdingsRotation: MomentumRotation | null;
  hoverDay: string | null;
}) {
  const [holdingsOpen, setHoldingsOpen] = useState(false);
  const share = new Map((rotation?.holdings ?? []).map((row) => [row.asset, row.share]));
  const entries = (rotation?.ins ?? []).filter((row) => !row.top_up);
  const topUps = (rotation?.ins ?? []).filter((row) => row.top_up);
  const outs = rotation?.outs ?? [];
  const trims = rotation?.trims ?? [];
  const holdings = holdingsRotation?.holdings ?? [];
  const holdingsDay = holdingsRotation?.week.slice(0, 10) ?? null;

  return (
    <div className="space-y-4 border-t border-border px-3 py-3">
      {/* Always one line, so hovering another week does not change the height. */}
      <p className="text-xs text-faint">
        {hoverDay !== null && hoverDay !== day
          ? `Showing ${formatDay(day)}. Click a point to pin another week.`
          : `Showing ${formatDay(day)}. Click a point on the chart to pin its week here.`}
      </p>
      {rotation?.parked ? (
        <p className="text-xs text-warning">
          Nothing qualified: the money went to the liquid fund.
        </p>
      ) : null}
      {!rotation ? <p className="text-xs text-muted">No trades this week.</p> : null}
      {rotation ? (
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          <ChangeGroup title="In" count={entries.length}>
            <Table>
              <THead>
                <Th>Name</Th>
                <Th align="right">Rank</Th>
                <Th align="right">Weight</Th>
              </THead>
              <tbody>
                {entries.map((row) => (
                  <TRow key={row.asset}>
                    <Td>{row.asset}</Td>
                    <Td numeric align="right">
                      {row.rank == null ? EMPTY : formatInt(row.rank)}
                    </Td>
                    <Td numeric align="right">
                      {formatPct(share.get(row.asset))}
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </ChangeGroup>
          <ChangeGroup title="Out" count={outs.length}>
            <Table>
              <THead>
                <Th>Name</Th>
                <Th align="right">Return</Th>
                <Th align="right">Held</Th>
                <Th align="right">Rank</Th>
                <Th>Reason</Th>
              </THead>
              <tbody>
                {outs.map((row) => (
                  <TRow key={row.asset}>
                    <Td>{row.asset}</Td>
                    <Td numeric align="right">
                      <span className={signTone(row.return)}>
                        {formatPct(row.return, 1, { sign: true })}
                      </span>
                    </Td>
                    <Td numeric align="right">
                      {row.weeks_held == null ? EMPTY : `${formatInt(row.weeks_held)} wk`}
                    </Td>
                    <Td numeric align="right">
                      {row.rank == null ? EMPTY : formatInt(row.rank)}
                    </Td>
                    <Td>
                      <span className="text-muted">{row.reason || EMPTY}</span>
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </ChangeGroup>
          {topUps.length > 0 ? (
            <ChangeGroup title="Topped up" count={topUps.length}>
              <Table>
                <THead>
                  <Th>Name</Th>
                  <Th align="right">Rank</Th>
                  <Th align="right">Weight</Th>
                </THead>
                <tbody>
                  {topUps.map((row) => (
                    <TRow key={row.asset}>
                      <Td>{row.asset}</Td>
                      <Td numeric align="right">
                        {row.rank == null ? EMPTY : formatInt(row.rank)}
                      </Td>
                      <Td numeric align="right">
                        {formatPct(share.get(row.asset))}
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            </ChangeGroup>
          ) : null}
          {trims.length > 0 ? (
            <ChangeGroup title="Trimmed" count={trims.length}>
              <Table>
                <THead>
                  <Th>Name</Th>
                  <Th align="right">Weight</Th>
                  <Th>Reason</Th>
                </THead>
                <tbody>
                  {trims.map((row) => (
                    <TRow key={row.asset}>
                      <Td>{row.asset}</Td>
                      <Td numeric align="right">
                        {formatPct(share.get(row.asset))}
                      </Td>
                      <Td>
                        <span className="text-muted">{row.reason || EMPTY}</span>
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            </ChangeGroup>
          ) : null}
        </div>
      ) : null}
      {holdings.length > 0 ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            className="-ml-2"
            aria-expanded={holdingsOpen}
            onClick={() => setHoldingsOpen((open) => !open)}
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', holdingsOpen && 'rotate-180')}
              aria-hidden="true"
            />
            Holdings after this week ({formatInt(holdings.length)})
            {holdingsDay !== null && holdingsDay !== day ? (
              <span className="font-normal text-faint">
                · unchanged since {formatDay(holdingsDay)}
              </span>
            ) : null}
          </Button>
          {holdingsOpen ? (
            <ul className="mt-2 grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {holdings.map((row) => (
                <li key={row.asset} className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-foreground">{row.asset}</span>
                  <span className="font-mono tabular-nums text-muted">{formatPct(row.share)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-faint">{label}</span>{' '}
      <span className="font-medium tabular-nums text-foreground">{children}</span>
    </span>
  );
}

export function MomentumEquityChart({
  series,
  benchmarkName,
  rotations,
  overlays = [],
  comparisons = [],
  flashKey = null,
  broad = false,
}: {
  series: MomentumSeries;
  benchmarkName: string;
  rotations: MomentumRotation[];
  overlays?: MomentumSavedRun[];
  comparisons?: MomentumComparison[];
  flashKey?: number | null;
  /** A Broad Momentum result: its rotation markers show only at a year or less. */
  broad?: boolean;
}) {
  const flashing = useResultFlash(flashKey);
  const chartRef = useRef<HTMLDivElement>(null);
  const plotlyRef = useRef<PlotlyBasic | null>(null);
  const [scrollZoom, setScrollZoom] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [range, setRange] = useState<EquityRange>('all');
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ key: string; from: string; to: string } | null>(null);
  /** Legend entries switched off, by key. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  /** The card's inner width, null until measured. */
  const [boxWidth, setBoxWidth] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  /** The last mouse position over the plot (client coordinates); null once it leaves. */
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const theme = useThemeStore((state) => state.theme);
  const weekChangesOpen = useMomentumViewStore((state) => state.weekChangesOpen);
  const setWeekChangesOpen = useMomentumViewStore((state) => state.setWeekChangesOpen);
  const drawdownOpen = useMomentumViewStore((state) => state.drawdownOpen);
  const setDrawdownOpen = useMomentumViewStore((state) => state.setDrawdownOpen);
  const advancedTooltip = useMomentumViewStore((state) => state.advancedTooltip);
  const setAdvancedTooltip = useMomentumViewStore((state) => state.setAdvancedTooltip);

  function toggleTrace(key: string): void {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** The visible window: lines re-based to ₹1 lakh at its first week, sub-panels sliced to it. */
  const view = useMemo(() => {
    const start = rangeStartIndex(series.dates, range);
    const dates = sliceSeries(series.dates, start);
    const firstDay = start > 0 ? (dates[0]?.slice(0, 10) ?? null) : null;
    const strategyFactor = start > 0 ? (rebaseFactor(series.strategy, start) ?? 1) : 1;
    const visible: MomentumSeries = {
      dates,
      strategy: rebaseSeries(series.strategy, start),
      benchmark: rebaseSeries(series.benchmark, start),
      cash: rebaseSeries(series.cash, start),
      drawdown_strategy: sliceSeries(series.drawdown_strategy, start),
      drawdown_benchmark: sliceSeries(series.drawdown_benchmark, start),
      rolling_52w_excess: sliceSeries(series.rolling_52w_excess, start),
      idle_share: sliceSeries(series.idle_share, start),
      holdings_count: sliceSeries(series.holdings_count, start),
    };
    return {
      series: visible,
      rebased: start > 0,
      firstDay,
      strategyFactor,
      comparisons: comparisons.map((line) => ({
        name: line.name,
        values: rebaseSeries(line.series, start),
      })),
      overlays: overlays.map((run) => {
        const runStart = startIndexFor(run.dates, firstDay);
        return {
          name: run.name || `Run ${run.n}`,
          dates: sliceSeries(run.dates, runStart),
          values: firstDay === null ? run.strategy : rebaseSeries(run.strategy, runStart),
        };
      }),
      rotations:
        firstDay === null
          ? rotations
          : rotations.filter((rotation) => rotation.week.slice(0, 10) >= firstDay),
    };
  }, [series, range, comparisons, overlays, rotations]);

  // Plotly keeps the user's zoom while this key is unchanged, and drops it when it changes.
  const revisionKey = `${series.dates[0] ?? ''}:${series.dates.at(-1) ?? ''}:${series.dates.length}:${range}:${logScale}`;
  const activeZoom = zoom !== null && zoom.key === revisionKey ? zoom : null;
  const visibleWeeks = countVisibleWeeks(
    view.series.dates,
    activeZoom?.from ?? null,
    activeZoom?.to ?? null,
  );
  const thinned = visibleWeeks > ROTATION_THIN_ABOVE_WEEKS;
  const markersShown = rotationMarkersShown(broad, visibleWeeks);

  const rotationByWeek = useMemo(() => {
    const map = new Map<string, MomentumRotation>();
    for (const rotation of rotations) map.set(rotation.week.slice(0, 10), rotation);
    return map;
  }, [rotations]);

  const rotationPoints = useMemo(
    () =>
      markersShown
        ? thinRotations(view.rotations, thinned ? Number.POSITIVE_INFINITY : 0).map((rotation) => ({
            date: rotation.week,
            value: lakh(rotation.value * view.strategyFactor),
            kind: rotationKind(rotation),
          }))
        : [],
    [view, thinned, markersShown],
  );

  // The main axis is ours: the visible window of every visible line, with ~22 % headroom on top
  // so the curve rarely reaches the week box in the corner. Null leaves it to Plotly.
  const yRange = useMemo(() => {
    const lines: RangeLine[] = [];
    const add = (key: string, dates: ReadonlyArray<string>, values: Array<number | null>) => {
      if (!hidden.has(key)) lines.push({ dates, values: values.map(lakh) });
    };
    const shownSeries = view.series;
    add('strategy', shownSeries.dates, shownSeries.strategy);
    add('benchmark', shownSeries.dates, shownSeries.benchmark);
    add('cash', shownSeries.dates, shownSeries.cash);
    view.comparisons.forEach((line, index) => {
      add(`comparison:${index}`, shownSeries.dates, line.values);
    });
    view.overlays.forEach((run, index) => {
      add(`overlay:${index}`, run.dates, run.values);
    });
    return headroomRange(lines, activeZoom?.from ?? null, activeZoom?.to ?? null, logScale);
  }, [view, hidden, activeZoom, logScale]);

  /** Puts the advanced tooltip by the cursor, inside the visible part of the card. */
  const placeTooltip = useCallback((): void => {
    const tip = tooltipRef.current;
    const host = boxRef.current;
    const cursor = cursorRef.current;
    if (!tip || !host) return;
    // No mouse position (a tap on a touch screen): no floating tooltip; the corner box remains.
    tip.style.visibility = cursor ? 'visible' : 'hidden';
    if (!cursor) return;
    const rect = host.getBoundingClientRect();
    const bounds = {
      left: Math.max(rect.left, 0),
      top: Math.max(rect.top, 0),
      right: Math.min(rect.right, window.innerWidth),
      bottom: Math.min(rect.bottom, window.innerHeight),
    };
    const place = tooltipPlacement(
      cursor,
      { width: tip.offsetWidth, height: tip.offsetHeight },
      bounds,
    );
    tip.style.left = `${Math.round(place.left - rect.left)}px`;
    tip.style.top = `${Math.round(place.top - rect.top)}px`;
  }, []);

  // Follow the cursor between Plotly's hover events, and drop the hover when it leaves the plot.
  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const move = (event: MouseEvent): void => {
      cursorRef.current = { x: event.clientX, y: event.clientY };
      placeTooltip();
    };
    const leave = (): void => {
      cursorRef.current = null;
      setHoverDate(null);
    };
    element.addEventListener('mousemove', move);
    element.addEventListener('mouseleave', leave);
    return () => {
      element.removeEventListener('mousemove', move);
      element.removeEventListener('mouseleave', leave);
    };
  }, [placeTooltip]);

  // A new hovered week changes the tooltip's size: place it again before the browser paints.
  useLayoutEffect(() => {
    placeTooltip();
  });

  // Purge once, on unmount. The render effect below only ever calls Plotly.react(), so a
  // re-render (theme, thinned markers, an overlay) keeps the user's pan and zoom.
  useEffect(() => {
    const element = chartRef.current;
    return () => {
      if (plotlyRef.current && element) plotlyRef.current.purge(element);
    };
  }, []);

  // The plot's own `responsive` only listens for window resizes. The card also changes width
  // when the settings column is hidden or shown, so watch the box itself: redraw the plot to
  // the new width and re-measure how many names the week box has room for.
  useEffect(() => {
    const node = boxRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const width = Math.round(node.clientWidth);
      setBoxWidth(width);
      const element = chartRef.current;
      if (width > 0 && element?.classList.contains('js-plotly-plot')) {
        try {
          plotlyRef.current?.Plots.resize(element);
        } catch {
          // The plot was purged or hidden between the observation and this frame.
        }
      }
    };
    const observer = new ResizeObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    });
    observer.observe(node);
    measure();
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    let mounted = true;

    async function render(): Promise<void> {
      const plotly = await loadPlotly();
      if (!mounted || !element) return;
      plotlyRef.current = plotly;
      const colors = getChartTheme(theme);
      const palette = getSeriesPalette(theme);
      const shown = view.series;
      const visible = (key: string): boolean | 'legendonly' =>
        hidden.has(key) ? 'legendonly' : true;
      const traces: Array<Record<string, unknown>> = [
        {
          x: shown.dates,
          y: shown.strategy.map(lakh),
          name: 'Strategy',
          type: 'scatter',
          mode: 'lines',
          visible: visible('strategy'),
          line: { color: colors.primary, width: 2.6 },
          fill: 'tozeroy',
          fillcolor: withAlpha(colors.primary, 0.08),
          hoverinfo: 'none',
        },
        {
          x: shown.dates,
          y: shown.benchmark.map(lakh),
          name: benchmarkName,
          type: 'scatter',
          mode: 'lines',
          visible: visible('benchmark'),
          // Foreground at a thinner width: clearly a reference line, not a disabled one.
          line: { color: colors.foreground, width: 1.4 },
          hoverinfo: 'none',
        },
        {
          x: shown.dates,
          y: shown.cash.map(lakh),
          name: 'Liquid fund',
          type: 'scatter',
          mode: 'lines',
          visible: visible('cash'),
          line: { color: colors.text, width: 1.4, dash: 'dot' },
          hoverinfo: 'none',
        },
        ...view.comparisons.map((line, index) => ({
          x: shown.dates,
          y: line.values.map(lakh),
          name: line.name,
          type: 'scatter',
          mode: 'lines',
          visible: visible(`comparison:${index}`),
          line: { color: pickSeries(palette, index), width: 1.3, dash: 'dashdot' },
          hoverinfo: 'none',
        })),
        {
          x: rotationPoints.map((item) => item.date),
          y: rotationPoints.map((item) => item.value),
          name: 'Rotations',
          type: 'scatter',
          mode: 'markers',
          visible: visible(ROTATIONS_KEY),
          marker: {
            // Circles, coloured by what happened: names added, names out, both, or neither.
            symbol: 'circle',
            size: 9,
            line: { width: 1, color: colors.grid },
            color: rotationPoints.map((item) => colors[KIND_COLOR[item.kind]]),
          },
          hoverinfo: 'none',
        },
        ...view.overlays.map((run, index) => ({
          x: run.dates,
          y: run.values.map(lakh),
          name: run.name,
          type: 'scatter',
          mode: 'lines',
          visible: visible(`overlay:${index}`),
          line: {
            // Offset from the comparison lines above so an overlay and a comparison differ.
            color: pickSeries(palette, index + view.comparisons.length),
            width: 1.5,
            dash: 'dash',
          },
          hoverinfo: 'none',
        })),
      ];
      if (drawdownOpen) {
        traces.push(
          {
            x: shown.dates,
            y: shown.drawdown_strategy,
            name: 'Strategy drawdown',
            type: 'scatter',
            mode: 'lines',
            yaxis: 'y2',
            fill: 'tozeroy',
            fillcolor: withAlpha(colors.negative, 0.15),
            line: { color: colors.negative, width: 1.5 },
            hoverinfo: 'none',
          },
          {
            x: shown.dates,
            y: shown.drawdown_benchmark,
            name: 'Benchmark drawdown',
            type: 'scatter',
            mode: 'lines',
            yaxis: 'y2',
            line: { color: colors.foreground, width: 1 },
            hoverinfo: 'none',
          },
          {
            x: shown.dates,
            y: shown.rolling_52w_excess,
            name: '52 week edge',
            type: 'bar',
            yaxis: 'y3',
            marker: {
              color: shown.rolling_52w_excess.map((value) =>
                value === null ? 'rgba(0,0,0,0)' : value >= 0 ? colors.positive : colors.negative,
              ),
            },
            hoverinfo: 'none',
          },
        );
      }
      const layout: Record<string, unknown> = {
        height: drawdownOpen ? PLOT_HEIGHT_WITH_RISK : PLOT_HEIGHT,
        margin: { ...PLOT_MARGIN },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        ...plotlyChrome(colors),
        hovermode: 'x unified',
        dragmode: 'pan',
        uirevision: revisionKey,
        // The legend is our own row under the plot (values at the active week, click to toggle).
        showlegend: false,
        xaxis: {
          type: 'date',
          anchor: drawdownOpen ? 'y3' : 'y',
          gridcolor: colors.grid,
          rangeslider: { visible: false },
          showspikes: true,
          spikemode: 'across',
          spikethickness: 1,
          spikecolor: colors.text,
        },
        yaxis: {
          // With the risk rows open the plot is taller, so the value panel keeps its height.
          domain: drawdownOpen ? [0.4, 1] : [0, 1],
          gridcolor: colors.grid,
          tickprefix: '₹',
          ticksuffix: ' L',
          type: logScale ? 'log' : 'linear',
          title: { text: 'Value of ₹1 lakh invested', font: { size: 11, color: colors.text } },
          // y follows the visible x window (with headroom), so dragging pans time only.
          fixedrange: true,
          ...(yRange ? { range: yRange, autorange: false } : { autorange: true }),
        },
        ...(drawdownOpen
          ? {
              yaxis2: {
                domain: [0.2, 0.36],
                gridcolor: colors.grid,
                tickformat: '.0%',
                title: { text: 'Drawdown', font: { size: 11, color: colors.text } },
              },
              yaxis3: {
                domain: [0, 0.16],
                gridcolor: colors.grid,
                tickformat: '+.0%',
                title: { text: '52w edge', font: { size: 11, color: colors.text } },
              },
            }
          : {}),
      };
      await plotly.react(element, traces, layout, {
        responsive: true,
        displaylogo: false,
        displayModeBar: true,
        scrollZoom,
      });
      if (!mounted) return;
      const plotlyElement = element as PlotlyHTMLElement;
      for (const name of PLOT_EVENTS) plotlyElement.removeAllListeners?.(name);
      plotlyElement.on?.('plotly_hover', (event) => {
        const mouse = event.event as MouseEvent | undefined;
        if (mouse && typeof mouse.clientX === 'number') {
          cursorRef.current = { x: mouse.clientX, y: mouse.clientY };
        }
        const day = eventDay(event);
        if (day) setHoverDate(day);
      });
      plotlyElement.on?.('plotly_unhover', () => setHoverDate(null));
      // Traces are hoverinfo 'none', so a tap is the only readout a touch screen gets.
      plotlyElement.on?.('plotly_click', (event) => {
        const day = eventDay(event);
        if (day) setSelectedDate(day);
      });
      plotlyElement.on?.('plotly_relayout', (event) => {
        const pair = event['xaxis.range'] as unknown[] | undefined;
        const from = event['xaxis.range[0]'] ?? pair?.[0];
        const to = event['xaxis.range[1]'] ?? pair?.[1];
        if (from != null && to != null) {
          const next = {
            key: revisionKey,
            from: String(from).slice(0, 10),
            to: String(to).slice(0, 10),
          };
          // Unchanged days keep the same object, so a no-op relayout cannot re-render the plot.
          setZoom((current) =>
            current?.key === next.key && current.from === next.from && current.to === next.to
              ? current
              : next,
          );
        } else if (event['xaxis.autorange']) setZoom(null);
      });
    }

    void render();
    return () => {
      mounted = false;
    };
  }, [
    view,
    benchmarkName,
    rotationPoints,
    scrollZoom,
    logScale,
    theme,
    revisionKey,
    hidden,
    drawdownOpen,
    yRange,
  ]);

  const shown = view.series;
  const indexOf = (day: string | null) =>
    day === null ? -1 : shown.dates.findIndex((d) => d.slice(0, 10) === day);
  const hoverIndex = indexOf(hoverDate);
  const pinnedIndex = indexOf(selectedDate);
  const latestIndex = shown.dates.length - 1;
  // The week box follows the hovered week; the opened list only the pinned (or latest) one.
  const listIndex = pinnedIndex >= 0 ? pinnedIndex : latestIndex;
  const activeIndex = hoverIndex >= 0 ? hoverIndex : listIndex;
  const activeDay = shown.dates[activeIndex]?.slice(0, 10) ?? null;
  const listDay = shown.dates[listIndex]?.slice(0, 10) ?? null;
  const hoverDay = hoverIndex >= 0 ? activeDay : null;

  // About 45 % of the plot's width (the box fits the names to it), never under the minimum.
  const plotWidth = boxWidth === null ? null : boxWidth - PLOT_MARGIN.l - PLOT_MARGIN.r;
  const weekBoxWidth =
    plotWidth === null
      ? 320
      : Math.max(
          Math.min(Math.max(plotWidth * BOX_SHARE, BOX_MIN_WIDTH), plotWidth - 2 * BOX_INSET),
          0,
        );
  const activeRotation = activeDay === null ? undefined : rotationByWeek.get(activeDay);
  const activeHeld = heldAt(shown.holdings_count, activeIndex);
  const activeSummary = weekSummary(activeRotation, activeHeld, 0);
  const activeWeekReturn = weekReturn(shown.strategy, activeIndex);
  const weekStatus: WeekStatus =
    hoverIndex >= 0 ? 'Hovered' : pinnedIndex >= 0 ? 'Pinned' : 'Latest';
  const tooltipShown = advancedTooltip && hoverDay !== null;
  const listRotation = listDay === null ? undefined : rotationByWeek.get(listDay);
  const listSummary = weekSummary(listRotation, heldAt(shown.holdings_count, listIndex), 0);

  const legend: LegendItem[] = [
    {
      key: 'strategy',
      name: 'Strategy',
      value: shown.strategy[activeIndex] ?? null,
      dash: 'solid',
      swatchClass: 'border-primary',
    },
    {
      key: 'benchmark',
      name: benchmarkName,
      value: shown.benchmark[activeIndex] ?? null,
      dash: 'solid',
      swatchClass: 'border-foreground',
    },
    {
      key: 'cash',
      name: 'Liquid fund',
      value: shown.cash[activeIndex] ?? null,
      dash: 'dot',
      swatchClass: 'border-muted',
    },
    ...view.comparisons.map(
      (line, index): LegendItem => ({
        key: `comparison:${index}`,
        name: line.name,
        value: line.values[activeIndex] ?? null,
        dash: 'dashdot',
        swatchColor: seriesCssColor(index),
      }),
    ),
    ...view.overlays.map((run, index): LegendItem => {
      const at = activeDay === null ? -1 : run.dates.findIndex((d) => d.slice(0, 10) === activeDay);
      return {
        key: `overlay:${index}`,
        name: run.name,
        value: at >= 0 ? (run.values[at] ?? null) : null,
        dash: 'dash',
        swatchColor: seriesCssColor(index + view.comparisons.length),
      };
    }),
  ];

  const risk = drawdownStats(shown.dates, shown.drawdown_strategy);
  const latestEdge = latestValue(shown.dates, shown.rolling_52w_excess);
  const activeEdge = shown.rolling_52w_excess[activeIndex] ?? null;
  const rotationsHidden = hidden.has(ROTATIONS_KEY);

  const markerHint = !markersShown
    ? '(shown at 1Y or closer)'
    : thinned
      ? '(zoomed out: changes only)'
      : null;

  return (
    <Card className={flashing ? 'animate-result-flash' : ''}>
      <CardHeader
        title="Portfolio value"
        description={
          view.rebased && view.firstDay
            ? `Every line re-based to ₹1 lakh on ${formatDay(view.firstDay)} · hover a week to read it in the plot's corner, click to pin it · drag to pan`
            : "₹1 lakh starting value · hover a week to read it in the plot's corner, click to pin it · drag to pan"
        }
        className="flex-wrap"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {pinnedIndex >= 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setSelectedDate(null)}>
                Back to latest
              </Button>
            ) : null}
            <SegmentedControl
              ariaLabel="Chart range"
              size="sm"
              value={range}
              onChange={setRange}
              options={EQUITY_RANGES}
            />
            <Button
              size="sm"
              variant={scrollZoom ? 'primary' : 'secondary'}
              aria-pressed={scrollZoom}
              onClick={() => setScrollZoom((value) => !value)}
            >
              Touchpad zoom {scrollZoom ? 'on' : 'off'}
            </Button>
            <Button
              size="sm"
              variant={logScale ? 'primary' : 'secondary'}
              aria-pressed={logScale}
              onClick={() => setLogScale((value) => !value)}
            >
              Log scale
            </Button>
            <Button
              size="sm"
              variant={advancedTooltip ? 'primary' : 'secondary'}
              aria-pressed={advancedTooltip}
              title="Show the hovered week's full detail in a tooltip by the cursor"
              onClick={() => setAdvancedTooltip(!advancedTooltip)}
            >
              Advanced tooltip
            </Button>
          </div>
        }
      />
      <div ref={boxRef} className="relative min-w-0">
        {activeDay === null ? (
          <p className="mb-2 text-xs text-muted">No weeks in this run.</p>
        ) : null}
        <div className="relative">
          <div
            ref={chartRef}
            role="img"
            aria-label={
              drawdownOpen
                ? 'Strategy, benchmark and cash values with drawdown and trailing excess return'
                : 'Strategy, benchmark and cash values'
            }
            className="w-full"
            // Reserve the plot's height in the layout: Plotly positions its SVG absolutely after a
            // resize, so without this the box collapses and the rows below draw over the plot.
            style={{ height: drawdownOpen ? PLOT_HEIGHT_WITH_RISK : PLOT_HEIGHT }}
          />
          {activeDay !== null ? (
            <WeekBox
              day={activeDay}
              status={weekStatus}
              summary={activeSummary}
              rotation={activeRotation}
              idle={shown.idle_share[activeIndex] ?? 0}
              weekReturnValue={activeWeekReturn}
              maxWidth={weekBoxWidth}
            />
          ) : null}
        </div>
        {tooltipShown && hoverDay !== null ? (
          <WeekTooltip
            innerRef={tooltipRef}
            day={hoverDay}
            rotation={activeRotation}
            held={activeHeld}
            weekReturnValue={activeWeekReturn}
          />
        ) : null}
        {/* The line key, under the time axis: each line's value at the active week; click to hide
            or show it. The marker key and its toggle close the row. */}
        <fieldset
          aria-label="Chart series"
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
        >
          {legend.map((item) => (
            <LegendButton
              key={item.key}
              item={item}
              hidden={hidden.has(item.key)}
              onToggle={() => toggleTrace(item.key)}
            />
          ))}
          <button
            type="button"
            aria-pressed={!rotationsHidden}
            onClick={() => toggleTrace(ROTATIONS_KEY)}
            title={`${rotationsHidden ? 'Show' : 'Hide'} the rotation markers. Green: names were added. Red: names went out. Yellow: both in the same week. Grey: only top-ups, trims or a park.${broad ? ' Broad Momentum rotates almost every week, so its markers show only at 1Y or closer.' : ''}`}
            className={cn(
              'ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded px-1 py-0.5 text-xs text-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              rotationsHidden && 'opacity-50',
            )}
          >
            <span
              className={cn('inline-flex items-center gap-2', rotationsHidden && 'line-through')}
            >
              <span>
                <span aria-hidden="true" className="text-positive">
                  ●
                </span>{' '}
                added
              </span>
              <span>
                <span aria-hidden="true" className="text-negative">
                  ●
                </span>{' '}
                out
              </span>
              <span>
                <span aria-hidden="true" className="text-warning">
                  ●
                </span>{' '}
                both
              </span>
            </span>
            {markerHint ? <span className="text-faint">{markerHint}</span> : null}
          </button>
        </fieldset>
        {listDay === null ? null : (
          <div className="mt-3">
            {/* The full list, under the plot: it grows downward as far as the week needs, and pinning
            another week changes its height without moving the plot. */}
            <div className="rounded-lg border border-border bg-surface-2/30">
              <button
                type="button"
                aria-expanded={weekChangesOpen}
                onClick={() => setWeekChangesOpen(!weekChangesOpen)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-faint transition-transform',
                    weekChangesOpen && 'rotate-180',
                  )}
                  aria-hidden="true"
                />
                <span className="font-semibold text-foreground">Week changes</span>
                <span className="text-muted">
                  {formatDay(listDay)}: {weekChangeCounts(listSummary)}
                  {listSummary.kind === 'parked' ? ' · parked in the liquid fund' : ''}
                </span>
              </button>
              {weekChangesOpen ? (
                <WeekChanges
                  day={listDay}
                  rotation={listRotation}
                  holdingsRotation={rotationOnOrBefore(rotations, listDay)}
                  hoverDay={hoverDay}
                />
              ) : null}
            </div>
          </div>
        )}
        {/* Drawdown, collapsed to its numbers; the two sub-panels are one click away. */}
        <section
          aria-label="Drawdown"
          className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3"
        >
          <div className="min-w-0 space-y-1 text-xs">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Stat label="Max drawdown">
                <span className="text-negative">{formatPct(risk.max)}</span>
                {risk.troughDate ? (
                  <span className="font-normal text-muted">
                    {' '}
                    (trough {formatDay(risk.troughDate)})
                  </span>
                ) : null}
              </Stat>
              <Stat label="Now">
                <span className={signTone(risk.current)}>{formatPct(risk.current)}</span>
              </Stat>
              <Stat label="Longest under water">
                {risk.underwater ? (
                  <>
                    {formatInt(risk.underwater.weeks)} wk
                    <span className="font-normal text-muted">
                      {' '}
                      ({formatDay(risk.underwater.from)} →{' '}
                      {risk.underwater.ongoing
                        ? 'not yet recovered'
                        : formatDay(risk.underwater.to)}
                      )
                    </span>
                  </>
                ) : (
                  'never'
                )}
              </Stat>
              {latestEdge ? (
                <Stat label="52w edge">
                  <span className={signTone(latestEdge.value)}>
                    {formatPct(latestEdge.value, 1, { sign: true })}
                  </span>
                </Stat>
              ) : null}
            </div>
            {activeDay !== null ? (
              <p className="flex flex-wrap gap-x-3 text-faint">
                <span>Week of {formatDay(activeDay)}:</span>
                <span>
                  drawdown{' '}
                  <span className="tabular-nums text-muted">
                    {formatPct(shown.drawdown_strategy[activeIndex])}
                  </span>
                </span>
                <span>
                  {benchmarkName}{' '}
                  <span className="tabular-nums text-muted">
                    {formatPct(shown.drawdown_benchmark[activeIndex])}
                  </span>
                </span>
                <span>
                  52w edge{' '}
                  <span className={cn('tabular-nums', signTone(activeEdge))}>
                    {formatPct(activeEdge, 1, { sign: true })}
                  </span>
                </span>
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            aria-expanded={drawdownOpen}
            onClick={() => setDrawdownOpen(!drawdownOpen)}
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', drawdownOpen && 'rotate-180')}
              aria-hidden="true"
            />
            {drawdownOpen ? 'Hide drawdown & 52-week edge' : 'Show drawdown & 52-week edge'}
          </Button>
        </section>
      </div>
    </Card>
  );
}
