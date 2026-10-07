'use client';

import { ChevronDown, ChevronLeft, ChevronRight, Pin, X } from 'lucide-react';
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
  countVisibleWeeks,
  fitNames,
  fittedNamesText,
  headroomRange,
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
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
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

/** The held count at a week; a week the series leaves blank carries the last known count. */
function heldAt(counts: ReadonlyArray<number | null>, index: number): number | null {
  for (let i = Math.min(index, counts.length - 1); i >= 0; i--) {
    const value = counts[i];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The value panel fills the rest of the first screen under the run bar and the headline numbers
 * (the Analytics page pattern's hero chart), about 60% of the window; before it is measured it
 * is assumed to start 40% down.
 */
const PLOT_SHARE_OF_WINDOW = 0.6;
/** The legend row and the card's padding under the plot. */
const PLOT_FOOTER_PX = 56;
const PLOT_HEIGHT_MIN = 380;
const PLOT_HEIGHT_MAX = 820;
/** Before the window is measured (server render, first paint). */
const PLOT_HEIGHT_FALLBACK = 560;
/** Extra height for the drawdown and 52-week-edge panes: 30 px gap, 130 + 30 + 90. */
const RISK_PANES_PX = 280;
const RISK_DD_PX = 130;
const RISK_EDGE_PX = 90;
const RISK_GAP_PX = 30;
/** The plot's margins; the pinned card sits just inside the top-left corner of the plot area. */
const PLOT_MARGIN = { l: 66, r: 18, t: 8, b: 36 } as const;
const PIN_INSET = 8;
/** Names per list in the follow tooltip before "+N more". */
const TIP_ROWS = 4;
/** Rows per list in the pinned card before "+N more". */
const PINNED_MAX_ROWS = 10;
/** Characters for the topped-up / trimmed name lists. */
const TOOLTIP_NAME_CHARS = 48;
const ROTATIONS_KEY = 'rotations';
const CASH_KEY = 'cash';
const comparisonKey = (name: string) => `comparison:${name}`;

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

/**
 * The plot height that ends the chart at the bottom of the first screen: the window's height
 * less where the plot starts on the page (measured at the top of the page, so scrolling does not
 * change it) and the legend row under it. Kept between the minimum and maximum, re-measured on
 * resize.
 */
function usePlotHeight(plotRef: RefObject<HTMLElement>): number {
  const [height, setHeight] = useState(PLOT_HEIGHT_FALLBACK);
  useEffect(() => {
    const measure = (): void => {
      const top = plotRef.current
        ? plotRef.current.getBoundingClientRect().top + window.scrollY
        : window.innerHeight * (1 - PLOT_SHARE_OF_WINDOW);
      const fit = window.innerHeight - top - PLOT_FOOTER_PX;
      setHeight(Math.min(Math.max(Math.round(fit), PLOT_HEIGHT_MIN), PLOT_HEIGHT_MAX));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [plotRef]);
  return height;
}

/** A key typed into a field, not at the page: the chart's shortcuts leave it alone. */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
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
  /** A line the reader adds ("+ Nifty 50"), rather than one shown by default. */
  optional?: boolean;
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
  if (item.optional && hidden) {
    return (
      <button
        type="button"
        aria-pressed={false}
        onClick={onToggle}
        title={`Add ${item.name} to the chart`}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        + {item.name}
      </button>
    );
  }
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

/** The week's return, signed and coloured. */
function WeekChange({ value }: { value: number | null }) {
  return (
    <span className={cn('font-mono tabular-nums', signTone(value))}>
      {formatPct(value, 1, { sign: true })}
    </span>
  );
}

/** Strategy and benchmark at the week: value and that week's change, one row each. */
interface WeekValue {
  key: string;
  name: string;
  value: number | null;
  change: number | null;
  swatchClass: string;
}

function WeekValues({ rows }: { rows: WeekValue[] }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-0.5">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn('h-2 w-2 shrink-0 rounded-sm', row.swatchClass)}
            />
            <span className="truncate text-muted">{row.name}</span>
          </span>
          <span className="text-right font-mono tabular-nums text-foreground">
            {formatInr(row.value, { compact: true })}
          </span>
          <span className="w-14 text-right">
            <WeekChange value={row.change} />
          </span>
        </div>
      ))}
    </div>
  );
}

function TipHeading({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <p className={cn('mb-0.5 mt-2 text-[11px] font-semibold uppercase tracking-wider', tone)}>
      {children}
    </p>
  );
}

function TipMore({ count }: { count: number }) {
  return count > 0 ? <p className="text-faint">+{formatInt(count)} more</p> : null;
}

/**
 * The follow tooltip: a short read of the hovered week (values, what came in and went out),
 * centred about 1 cm below the cursor so the line either side of it stays clear. It ignores the
 * pointer. The parent positions it (through `innerRef`) after every render and on every move.
 */
function WeekTooltip({
  innerRef,
  day,
  rotation,
  values,
  pinned,
}: {
  innerRef: RefObject<HTMLDivElement>;
  day: string;
  rotation: MomentumRotation | undefined;
  values: WeekValue[];
  pinned: boolean;
}) {
  const entries = (rotation?.ins ?? []).filter((row) => !row.top_up);
  const outs = rotation?.outs ?? [];
  const topUps = (rotation?.ins ?? []).filter((row) => row.top_up).length;
  const trims = rotation?.trims.length ?? 0;
  return (
    <div
      ref={innerRef}
      role="tooltip"
      className="pointer-events-none absolute left-0 top-0 z-30 w-[300px] rounded-lg border border-border-strong bg-surface px-3 py-2 text-xs shadow-elevated"
    >
      <p className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-semibold text-foreground">Week of {formatDay(day)}</span>
        {rotation ? (
          <span className="text-[11px] font-medium text-primary">Rebalance</span>
        ) : (
          <span className="text-[11px] text-faint">no trades</span>
        )}
      </p>
      <WeekValues rows={values} />
      {rotation?.parked ? (
        <p className="mt-2 text-warning">Nothing qualified: the money went to the liquid fund.</p>
      ) : null}
      {outs.length > 0 ? (
        <>
          <TipHeading tone="text-negative">Sold · {formatInt(outs.length)}</TipHeading>
          {outs.slice(0, TIP_ROWS).map((row) => (
            <p key={row.asset} className="flex justify-between gap-3">
              <span className="truncate text-foreground">↓ {row.asset}</span>
              <span className="shrink-0 font-mono tabular-nums text-muted">
                {row.weeks_held == null ? '' : `${formatInt(row.weeks_held)}w · `}
                <span className={signTone(row.return)}>
                  {formatPct(row.return, 1, { sign: true })}
                </span>
              </span>
            </p>
          ))}
          <TipMore count={outs.length - TIP_ROWS} />
        </>
      ) : null}
      {entries.length > 0 ? (
        <>
          <TipHeading tone="text-positive">Bought · {formatInt(entries.length)}</TipHeading>
          {entries.slice(0, TIP_ROWS).map((row) => (
            <p key={row.asset} className="flex justify-between gap-3">
              <span className="truncate text-foreground">↑ {row.asset}</span>
              <span className="shrink-0 font-mono tabular-nums text-muted">
                {row.rank == null ? '' : `rank ${formatInt(row.rank)}`}
              </span>
            </p>
          ))}
          <TipMore count={entries.length - TIP_ROWS} />
        </>
      ) : null}
      {topUps > 0 || trims > 0 ? (
        <p className="mt-1.5 text-muted">
          {[
            topUps > 0 ? `Topped up ${formatInt(topUps)}` : null,
            trims > 0 ? `Trimmed ${formatInt(trims)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-faint">
        {pinned ? 'Click to pin this week instead' : 'Click to pin the full detail'}
      </p>
    </div>
  );
}

/**
 * The pinned week's full detail, in the plot's top-left corner (the curve rarely reaches it:
 * the y axis keeps headroom above the lines). It stays while the cursor moves on, until it is
 * closed (× or Esc) or another week is clicked; ‹ › and ← → step between rebalance weeks.
 */
function PinnedWeekCard({
  day,
  rotation,
  held,
  values,
  maxHeight,
  onPrevious,
  onNext,
  onClose,
}: {
  day: string;
  rotation: MomentumRotation | undefined;
  held: number | null;
  values: WeekValue[];
  maxHeight: number;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}) {
  const share = new Map((rotation?.holdings ?? []).map((row) => [row.asset, row.share]));
  const entries = (rotation?.ins ?? []).filter((row) => !row.top_up);
  const topUps = (rotation?.ins ?? []).filter((row) => row.top_up).map((row) => row.asset);
  const outs = rotation?.outs ?? [];
  const trims = (rotation?.trims ?? []).map((row) => row.asset);
  const parked = Boolean(rotation?.parked) || held === 0;
  return (
    <section
      aria-label="Pinned week"
      className="absolute z-20 w-[360px] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-lg border border-border-strong bg-surface/95 px-3 py-2 text-xs shadow-elevated backdrop-blur-sm"
      style={{ left: PLOT_MARGIN.l + PIN_INSET, top: PLOT_MARGIN.t + PIN_INSET, maxHeight }}
    >
      <div className="mb-1.5 flex items-center gap-1">
        <Pin className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="flex-1 font-semibold text-foreground">Week of {formatDay(day)}</span>
        <button
          type="button"
          onClick={onPrevious ?? undefined}
          disabled={!onPrevious}
          aria-label="Previous rebalance"
          title="Previous rebalance (←)"
          className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNext ?? undefined}
          disabled={!onNext}
          aria-label="Next rebalance"
          title="Next rebalance (→)"
          className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Unpin week"
          title="Unpin (Esc)"
          className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <WeekValues rows={values} />
      {!rotation ? <p className="mt-2 text-muted">No trades this week.</p> : null}
      {rotation?.parked ? (
        <p className="mt-2 text-warning">Nothing qualified: the money went to the liquid fund.</p>
      ) : null}
      {outs.length > 0 ? (
        <>
          <TipHeading tone="text-negative">Sold · {formatInt(outs.length)}</TipHeading>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3">
            {outs.slice(0, PINNED_MAX_ROWS).map((row) => (
              <div key={row.asset} className="contents" title={row.reason || undefined}>
                <span className="truncate text-foreground">↓ {row.asset}</span>
                <span className="text-right font-mono tabular-nums text-muted">
                  {row.weeks_held == null ? EMPTY : `${formatInt(row.weeks_held)} wk`}
                </span>
                <span className={cn('text-right font-mono tabular-nums', signTone(row.return))}>
                  {formatPct(row.return, 1, { sign: true })}
                </span>
                {row.reason ? (
                  <span className="col-span-3 -mt-0.5 mb-0.5 truncate pl-3 text-[11px] text-faint">
                    {row.reason}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          <TipMore count={outs.length - PINNED_MAX_ROWS} />
        </>
      ) : null}
      {entries.length > 0 ? (
        <>
          <TipHeading tone="text-positive">Bought · {formatInt(entries.length)}</TipHeading>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3">
            {entries.slice(0, PINNED_MAX_ROWS).map((row) => (
              <div key={row.asset} className="contents">
                <span className="truncate text-foreground">↑ {row.asset}</span>
                <span className="text-right font-mono tabular-nums text-muted">
                  {row.rank == null ? EMPTY : `rank ${formatInt(row.rank)}`}
                </span>
                <span className="text-right font-mono tabular-nums text-muted">
                  {formatPct(share.get(row.asset))}
                </span>
              </div>
            ))}
          </div>
          <TipMore count={entries.length - PINNED_MAX_ROWS} />
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
      {rotation?.holdings.length ? (
        <>
          <TipHeading tone="text-faint">
            Holding after · {formatInt(rotation.holdings.length)}
          </TipHeading>
          <p className="text-muted">
            {fittedNamesText(
              fitNames(
                rotation.holdings.map((row) => `${row.asset} ${formatPct(row.share, 0)}`),
                TOOLTIP_NAME_CHARS * 3,
              ),
            )}
          </p>
        </>
      ) : null}
      <p className="mt-2 border-t border-border pt-1.5 text-muted">
        {parked ? (
          <span className="font-medium text-warning">Parked in the liquid fund</span>
        ) : (
          <>Held {held === null ? EMPTY : formatInt(held)}</>
        )}
      </p>
    </section>
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

/**
 * The hero chart: portfolio value against the picked benchmark, about two-thirds of the first
 * screen. Hovering shows the follow tooltip under the cursor; clicking pins a week's full detail
 * in the plot's corner, and ← → then step from rebalance to rebalance. The drawdown and
 * 52-week-edge panes are off by default (the Drawdowns widget below the chart has the numbers).
 *
 * `series` already carries the picked benchmark (`withBenchmark`); `comparisons` are the other
 * indices, offered as "+ name" chips and drawn only once added.
 */
export function MomentumEquityChart({
  series,
  benchmarkName,
  rotations,
  overlays = [],
  comparisons = [],
  flashKey = null,
  broad = false,
  onPainted,
}: {
  series: MomentumSeries;
  benchmarkName: string;
  rotations: MomentumRotation[];
  overlays?: MomentumSavedRun[];
  comparisons?: Array<Pick<MomentumComparison, 'name' | 'series'>>;
  flashKey?: number | null;
  /** A Broad Momentum result: its rotation markers show only at a year or less. */
  broad?: boolean;
  /** Called after each draw; the page uses the first to start loading what is below. */
  onPainted?: () => void;
}) {
  const flashing = useResultFlash(flashKey);
  const onPaintedRef = useRef(onPainted);
  onPaintedRef.current = onPainted;
  const chartRef = useRef<HTMLDivElement>(null);
  const plotlyRef = useRef<PlotlyBasic | null>(null);
  const [scrollZoom, setScrollZoom] = useState(false);
  // Log by default: ten years of compounding on a linear axis flattens the early years.
  const [logScale, setLogScale] = useState(true);
  const [range, setRange] = useState<EquityRange>('all');
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ key: string; from: string; to: string } | null>(null);
  /** Default lines switched off, by key. The liquid fund starts off. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set([CASH_KEY]));
  /** Optional lines (the other indices) the reader has added, by key. */
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  const boxRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  /** The last mouse position over the plot (client coordinates); null once it leaves. */
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const theme = useThemeStore((state) => state.theme);
  const weekChangesOpen = useMomentumViewStore((state) => state.weekChangesOpen);
  const setWeekChangesOpen = useMomentumViewStore((state) => state.setWeekChangesOpen);
  const drawdownOpen = useMomentumViewStore((state) => state.drawdownOpen);
  const setDrawdownOpen = useMomentumViewStore((state) => state.setDrawdownOpen);
  const plotHeight = usePlotHeight(chartRef);
  const totalHeight = drawdownOpen ? plotHeight + RISK_PANES_PX : plotHeight;

  const isHidden = useCallback(
    (key: string): boolean => (key.startsWith('comparison:') ? !added.has(key) : hidden.has(key)),
    [added, hidden],
  );

  function toggleTrace(key: string): void {
    const flip = (current: ReadonlySet<string>): ReadonlySet<string> => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    };
    if (key.startsWith('comparison:')) setAdded(flip);
    else setHidden(flip);
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

  /** Rebalance weeks in the visible window, oldest first: what ← → step through. */
  const rotationDays = useMemo(
    () => view.rotations.map((rotation) => rotation.week.slice(0, 10)).sort(),
    [view.rotations],
  );

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

  // The main axis is ours: the visible window of every visible line, with headroom on top so
  // the curve rarely reaches the pinned card in the corner. Null leaves it to Plotly.
  const yRange = useMemo(() => {
    const lines: RangeLine[] = [];
    const add = (key: string, dates: ReadonlyArray<string>, values: Array<number | null>) => {
      if (!isHidden(key)) lines.push({ dates, values: values.map(lakh) });
    };
    const shownSeries = view.series;
    add('strategy', shownSeries.dates, shownSeries.strategy);
    add('benchmark', shownSeries.dates, shownSeries.benchmark);
    add(CASH_KEY, shownSeries.dates, shownSeries.cash);
    for (const line of view.comparisons) {
      add(comparisonKey(line.name), shownSeries.dates, line.values);
    }
    view.overlays.forEach((run, index) => {
      add(`overlay:${index}`, run.dates, run.values);
    });
    return headroomRange(lines, activeZoom?.from ?? null, activeZoom?.to ?? null, logScale);
  }, [view, isHidden, activeZoom, logScale]);

  /** Puts the follow tooltip under the cursor, inside the visible part of the card. */
  const placeTooltip = useCallback((): void => {
    const tip = tooltipRef.current;
    const host = boxRef.current;
    const cursor = cursorRef.current;
    if (!tip || !host) return;
    // No mouse position (a tap on a touch screen): no floating tooltip; a tap pins instead.
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
    // The cursor is stored on every move, but the tooltip is placed once per frame: placing it
    // reads layout and writes styles, which would otherwise be forced on every mouse event.
    let frame: number | null = null;
    const move = (event: MouseEvent): void => {
      cursorRef.current = { x: event.clientX, y: event.clientY };
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        placeTooltip();
      });
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
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [placeTooltip]);

  // A new hovered week changes the tooltip's size: place it again before the browser paints.
  useLayoutEffect(() => {
    placeTooltip();
  });

  // ← → step the pinned week between rebalances; Esc unpins. Only while a week is pinned, and
  // never while typing into a field.
  useEffect(() => {
    if (selectedDate === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || typingTarget(event.target)) return;
      if (event.key === 'Escape') {
        setSelectedDate(null);
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const next =
        event.key === 'ArrowRight'
          ? rotationDays.find((day) => day > selectedDate)
          : [...rotationDays].reverse().find((day) => day < selectedDate);
      if (next) {
        event.preventDefault();
        setSelectedDate(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedDate, rotationDays]);

  // Purge once, on unmount. The render effect below only ever calls Plotly.react(), so a
  // re-render (theme, thinned markers, an overlay) keeps the user's pan and zoom.
  useEffect(() => {
    const element = chartRef.current;
    return () => {
      if (plotlyRef.current && element) plotlyRef.current.purge(element);
    };
  }, []);

  // The plot's own `responsive` only listens for window resizes; the card can also change width
  // on its own (the settings drawer, the sidebar), so watch the box itself.
  useEffect(() => {
    const node = boxRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const element = chartRef.current;
      if (node.clientWidth > 0 && element?.classList.contains('js-plotly-plot')) {
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
        isHidden(key) ? 'legendonly' : true;
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
          line: { color: colors.foreground, width: 1.6 },
          hoverinfo: 'none',
        },
        {
          x: shown.dates,
          y: shown.cash.map(lakh),
          name: 'Liquid fund',
          type: 'scatter',
          mode: 'lines',
          visible: visible(CASH_KEY),
          line: { color: colors.text, width: 1.4, dash: 'dot' },
          hoverinfo: 'none',
        },
        ...view.comparisons.map((line, index) => ({
          x: shown.dates,
          y: line.values.map(lakh),
          name: line.name,
          type: 'scatter',
          mode: 'lines',
          visible: visible(comparisonKey(line.name)),
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
            // Small, so ten years of weekly rotations read as dots on the line, not a band.
            size: 6,
            line: { width: 0.5, color: colors.grid },
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
            line: { color: colors.foreground, width: 1, dash: 'dot' },
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
      // Pane domains from pixel heights, so the value panel keeps its height with the panes open.
      const share = (px: number) => px / totalHeight;
      const layout: Record<string, unknown> = {
        height: totalHeight,
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
          domain: drawdownOpen ? [share(RISK_PANES_PX), 1] : [0, 1],
          gridcolor: colors.grid,
          tickprefix: '₹',
          ticksuffix: ' L',
          type: logScale ? 'log' : 'linear',
          // y follows the visible x window (with headroom), so dragging pans time only.
          fixedrange: true,
          ...(yRange ? { range: yRange, autorange: false } : { autorange: true }),
        },
        ...(drawdownOpen
          ? {
              yaxis2: {
                domain: [
                  share(RISK_EDGE_PX + RISK_GAP_PX),
                  share(RISK_EDGE_PX + RISK_GAP_PX + RISK_DD_PX),
                ],
                gridcolor: colors.grid,
                tickformat: '.0%',
                title: { text: 'Drawdown', font: { size: 11, color: colors.text } },
              },
              yaxis3: {
                domain: [0, share(RISK_EDGE_PX)],
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
        displayModeBar: false,
        scrollZoom,
      });
      if (!mounted) return;
      onPaintedRef.current?.();
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
      // Click pins the week; clicking the pinned week again unpins it.
      plotlyElement.on?.('plotly_click', (event) => {
        const day = eventDay(event);
        if (day) setSelectedDate((current) => (current === day ? null : day));
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
    isHidden,
    drawdownOpen,
    yRange,
    totalHeight,
  ]);

  const shown = view.series;
  const indexOf = (day: string | null) =>
    day === null ? -1 : shown.dates.findIndex((d) => d.slice(0, 10) === day);
  const hoverIndex = indexOf(hoverDate);
  const pinnedIndex = indexOf(selectedDate);
  const latestIndex = shown.dates.length - 1;
  // The legend reads the hovered week, else the pinned one, else the latest.
  const listIndex = pinnedIndex >= 0 ? pinnedIndex : latestIndex;
  const activeIndex = hoverIndex >= 0 ? hoverIndex : listIndex;
  const activeDay = shown.dates[activeIndex]?.slice(0, 10) ?? null;
  const listDay = shown.dates[listIndex]?.slice(0, 10) ?? null;
  const hoverDay = hoverIndex >= 0 ? activeDay : null;
  const pinnedDay = pinnedIndex >= 0 ? (shown.dates[pinnedIndex]?.slice(0, 10) ?? null) : null;
  // A pin the shown weeks no longer contain (another run, a shorter range) is dropped, so the
  // arrow keys do not keep stepping from a week that is not on screen.
  useEffect(() => {
    if (selectedDate !== null && pinnedIndex < 0) setSelectedDate(null);
  }, [selectedDate, pinnedIndex]);

  const weekValues = (index: number): WeekValue[] => [
    {
      key: 'strategy',
      name: 'Strategy',
      value: shown.strategy[index] ?? null,
      change: weekReturn(shown.strategy, index),
      swatchClass: 'bg-primary',
    },
    {
      key: 'benchmark',
      name: benchmarkName,
      value: shown.benchmark[index] ?? null,
      change: weekReturn(shown.benchmark, index),
      swatchClass: 'bg-foreground',
    },
  ];

  const hoverRotation = hoverDay === null ? undefined : rotationByWeek.get(hoverDay);
  const pinnedRotation = pinnedDay === null ? undefined : rotationByWeek.get(pinnedDay);
  const listRotation = listDay === null ? undefined : rotationByWeek.get(listDay);
  const listSummary = weekSummary(listRotation, heldAt(shown.holdings_count, listIndex), 0);
  const previousRebalance =
    pinnedDay === null ? undefined : [...rotationDays].reverse().find((day) => day < pinnedDay);
  const nextRebalance =
    pinnedDay === null ? undefined : rotationDays.find((day) => day > pinnedDay);

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
      key: CASH_KEY,
      name: 'Liquid fund',
      value: shown.cash[activeIndex] ?? null,
      dash: 'dot',
      swatchClass: 'border-muted',
    },
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
    ...view.comparisons.map(
      (line, index): LegendItem => ({
        key: comparisonKey(line.name),
        name: line.name,
        value: line.values[activeIndex] ?? null,
        dash: 'dashdot',
        swatchColor: seriesCssColor(index),
        optional: true,
      }),
    ),
  ];

  const rotationsHidden = isHidden(ROTATIONS_KEY);
  const markerHint = !markersShown
    ? '(shown at 1Y or closer)'
    : thinned
      ? '(zoomed out: changes only)'
      : null;

  return (
    <Card className={cn('px-4 py-3', flashing && 'animate-result-flash')}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-sm font-semibold text-foreground">Equity curve</h3>
        <p className="min-w-0 flex-1 truncate text-xs text-faint">
          {view.rebased && view.firstDay
            ? `Re-based to ₹1 lakh on ${formatDay(view.firstDay)} · hover a week, click to pin it, drag to pan`
            : '₹1 lakh at the start · hover a week, click to pin it, drag to pan'}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SegmentedControl
            ariaLabel="Chart range"
            size="sm"
            value={range}
            onChange={setRange}
            options={EQUITY_RANGES}
          />
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
            variant={drawdownOpen ? 'primary' : 'secondary'}
            aria-pressed={drawdownOpen}
            title="Show the drawdown and 52-week-edge panes under the curve"
            onClick={() => setDrawdownOpen(!drawdownOpen)}
          >
            Drawdown pane
          </Button>
          <Button
            size="sm"
            variant={scrollZoom ? 'primary' : 'secondary'}
            aria-pressed={scrollZoom}
            onClick={() => setScrollZoom((value) => !value)}
          >
            Touchpad zoom {scrollZoom ? 'on' : 'off'}
          </Button>
        </div>
      </div>
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
                ? 'Strategy and benchmark values with drawdown and trailing excess return'
                : 'Strategy and benchmark values'
            }
            className="w-full"
            // Reserve the plot's height in the layout: Plotly positions its SVG absolutely after a
            // resize, so without this the box collapses and the rows below draw over the plot.
            style={{ height: totalHeight }}
          />
          {pinnedDay !== null ? (
            <PinnedWeekCard
              day={pinnedDay}
              rotation={pinnedRotation}
              held={heldAt(shown.holdings_count, pinnedIndex)}
              values={weekValues(pinnedIndex)}
              maxHeight={plotHeight - PLOT_MARGIN.t - PLOT_MARGIN.b - 2 * PIN_INSET}
              onPrevious={previousRebalance ? () => setSelectedDate(previousRebalance) : null}
              onNext={nextRebalance ? () => setSelectedDate(nextRebalance) : null}
              onClose={() => setSelectedDate(null)}
            />
          ) : null}
        </div>
        {hoverDay !== null ? (
          <WeekTooltip
            innerRef={tooltipRef}
            day={hoverDay}
            rotation={hoverRotation}
            values={weekValues(hoverIndex)}
            pinned={pinnedDay !== null && pinnedDay !== hoverDay}
          />
        ) : null}
        {/* The line key, under the time axis: each line's value at the active week; click to hide
            or show it, or to add one of the other indices. The marker key closes the row. */}
        <fieldset
          aria-label="Chart series"
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
        >
          {legend.map((item) => (
            <LegendButton
              key={item.key}
              item={item}
              hidden={isHidden(item.key)}
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
                <span className="truncate text-muted">
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
      </div>
    </Card>
  );
}
