'use client';

import { AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatDuration,
  formatInr,
  formatInt,
  formatIstTime,
  formatNumber,
  formatPct,
  formatPp,
} from '../../lib/format';
import {
  type BenchmarkOption,
  type BenchmarkView,
  trailingReturn,
  yearToDate,
  yearlyRows,
} from '../../lib/momentumBenchmark';
import {
  type CompanionLine,
  EVALUATION_REVIEW_URL,
  companionLine,
  hindsightWarning,
  trustNote,
} from '../../lib/momentumConfig';
import { BROAD_UNIVERSES, broadUniverse } from '../../lib/momentumUniverse';
import { useMomentumRunsStore } from '../../store/momentumRuns';
import { useMomentumViewStore } from '../../store/momentumView';
import type { MomentumResult, MomentumSeries } from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { InfoTooltip } from '../ui/InfoTooltip';
import { RadioMenu } from '../ui/RadioMenu';
import { MomentumInsights } from './MomentumInsights';
import { MomentumKpiCards, previousComparableRun } from './MomentumKpiCards';
import { type MomentumRunInfo, assumptionChips, dataNotes } from './MomentumResultDetails';
import { useResultFlash } from './MomentumRunProgress';

type Tone = 'positive' | 'negative' | 'neutral';

const DATASET_LABELS: Record<string, string> = {
  etf: 'ETF Rotation',
  stock: 'Nifty 50 Stocks',
  custom_index: 'Custom Index',
  broad: 'Broad Momentum',
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const toneOf = (value: number | null): Tone =>
  value === null || value === 0 ? 'neutral' : value > 0 ? 'positive' : 'negative';

const VALUE_TONE: Record<Tone, string> = {
  positive: 'text-positive',
  negative: 'text-negative',
  neutral: 'text-foreground',
};

/**
 * One headline number: the strategy's figure, large, then the benchmark's on one line with the
 * gap as a badge. Never wraps; the explanation and the change against the previous run are in
 * the label's (i).
 */
function Headline({
  label,
  help,
  value,
  tone = 'neutral',
  benchmark,
  gap,
  gapTone = 'neutral',
  note = null,
}: {
  label: string;
  help: string;
  value: string;
  tone?: Tone;
  benchmark: string;
  gap: string | null;
  gapTone?: Tone;
  /** A muted third line, for a companion figure. It wraps rather than truncating the figure. */
  note?: CompanionLine | null;
}) {
  return (
    <div className="min-w-0 border-border px-4 py-3 sm:px-5 lg:border-l lg:first:border-l-0">
      <p className="flex items-center gap-1 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-faint">
        {label}
        <InfoTooltip text={help} label={`About ${label}`} />
      </p>
      <p
        className={cn(
          'metric mt-1 text-[28px] font-semibold leading-tight tracking-tight',
          VALUE_TONE[tone],
        )}
      >
        {value}
      </p>
      <p className="mt-1 flex items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-muted">
        <span className="truncate">
          Benchmark <span className="metric text-foreground">{benchmark}</span>
        </span>
        {gap ? (
          <Badge tone={gapTone === 'neutral' ? 'neutral' : gapTone} className="shrink-0">
            {gap}
          </Badge>
        ) : null}
      </p>
      {note ? (
        <p className="mt-0.5 break-words text-xs text-faint" title={note.title}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

/** The benchmark picker: the five indices, each with its CAGR over this run's period. */
export function BenchmarkPicker({
  options,
  view,
  onPick,
}: {
  options: BenchmarkOption[];
  view: BenchmarkView;
  onPick: (name: string) => void;
}) {
  if (options.length === 0) {
    // A result computed before the picker existed: its own benchmark, fixed.
    return (
      <span className="whitespace-nowrap text-xs text-muted">
        Benchmark <span className="font-medium text-foreground">{view.label}</span>
      </span>
    );
  }
  return (
    <RadioMenu
      ariaLabel={`Benchmark: ${view.label}. Change benchmark`}
      prefix="Benchmark"
      swatchClass="bg-foreground"
      value={view.fallback ? '' : view.name}
      valueLabel={view.label}
      heading="Compare against · CAGR same period"
      options={options.map((option) => ({
        value: option.name,
        label: option.label,
        detail: option.available ? formatPct(option.cagr) : 'no data',
        disabled: !option.available,
        title: option.reason ?? undefined,
      }))}
      onChange={onPick}
      footer="Dividends included (TRI). Switching re-compares the whole page; the backtest does not run again."
    />
  );
}

/** "label value" with the value in the figures face, for the one-line secondary metrics. */
function Inline({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      {label} <span className="metric text-foreground">{children}</span>
    </span>
  );
}

/**
 * The headline strip (Analytics page pattern): what was tested, the numbers that decide it,
 * each against the picked benchmark, and the secondary metrics on one line. "All metrics"
 * opens the full set, the assumptions behind the run and the one-sentence takeaway.
 */
export function MomentumHeadline({
  result,
  series,
  config,
  view,
  options,
  stale = false,
  lastRunFailed = false,
  runInfo = null,
}: {
  result: MomentumResult;
  /** The run's series with the picked benchmark swapped in (`withBenchmark`). */
  series: MomentumSeries;
  config: Record<string, unknown>;
  view: BenchmarkView;
  options: BenchmarkOption[];
  stale?: boolean;
  /** The last Run click failed, so these are the PREVIOUS run's results. */
  lastRunFailed?: boolean;
  runInfo?: MomentumRunInfo | null;
}) {
  const flashing = useResultFlash(runInfo?.finishedAt ?? null);
  const metricsOpen = useMomentumViewStore((state) => state.metricsOpen);
  const setMetricsOpen = useMomentumViewStore((state) => state.setMetricsOpen);
  const setBenchmark = useMomentumViewStore((state) => state.setBenchmark);
  const runs = useMomentumRunsStore((state) => state.runs);
  const previous = previousComparableRun(runs, result);
  const k = result.kpis;
  const dates = series.dates;
  const notes = dataNotes(result);
  const warning = hindsightWarning(config);
  const baseLabel = DATASET_LABELS[String(config.dataset)] ?? 'Backtest';
  const label =
    config.dataset === 'broad'
      ? `${baseLabel} · ${BROAD_UNIVERSES[broadUniverse(config)].short}`
      : baseLabel;
  const trust = trustNote(config);
  const companion = companionLine(result.companion);

  const since = (key: string, now: number | null, digits = 'pp'): string => {
    const before = num(previous?.result?.kpis[key]);
    if (now === null || before === null) return '';
    const change = now - before;
    const text =
      digits === 'pp'
        ? formatPp(change)
        : digits === 'ratio'
          ? formatNumber(change, 2, { sign: true })
          : formatInr(change, { compact: true, sign: true });
    return ` Against ${previous?.savedAs ?? 'the previous run'}: ${text}.`;
  };

  const cagr = num(k.cagr);
  const maxDd = num(k.max_drawdown);
  const sharpe = num(k.sharpe);
  const finalValue = num(k.final_value);
  const last12 = trailingReturn(dates, series.strategy);
  const benchLast12 = trailingReturn(dates, view.values);
  const ytd = yearToDate(dates, series.strategy);
  const ddGap = maxDd !== null && view.maxDrawdown !== null ? maxDd - view.maxDrawdown : null;
  const sharpeGap = sharpe !== null && view.sharpe !== null ? sharpe - view.sharpe : null;
  const ratio =
    finalValue !== null && view.finalValue !== null && view.finalValue > 0
      ? finalValue / view.finalValue
      : null;
  const weeks = dates.length;

  return (
    <section
      aria-label="Headline numbers"
      className={cn(
        'rounded-xl border border-border bg-surface shadow-card',
        flashing && 'animate-result-flash',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-faint">
            {label} · {formatDay(dates[0])} → {formatDay(dates.at(-1))} · {formatInt(weeks)} weeks
          </h2>
          {runInfo ? (
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-positive" aria-hidden="true" />
              Updated {formatIstTime(runInfo.finishedAt, { seconds: true })} · took{' '}
              {formatDuration(runInfo.durationMs)}
              {runInfo.fresh ? ' · recomputed from scratch' : ''}
              {runInfo.savedAs ? ` · saved as ${runInfo.savedAs}` : ''}
            </p>
          ) : null}
        </div>
        {lastRunFailed ? (
          <Badge tone="negative">Last run failed: these are the previous results</Badge>
        ) : stale ? (
          <Badge tone="warning">Results use previous settings</Badge>
        ) : null}
        <BenchmarkPicker options={options} view={view} onPick={setBenchmark} />
      </div>
      {warning ? (
        <div
          role="note"
          className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm sm:mx-5"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">{warning.headline}</p>
            <p className="text-muted">{warning.detail}</p>
            {warning.realismOff.length ? (
              <p className="text-muted">
                This run also ignores {warning.realismOff.join(' and ')}. On the default Broad
                settings, turning both on takes about 13 points off the CAGR.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="mt-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Headline
          label="CAGR"
          help={`Compound annual growth rate: the strategy's average yearly return, smoothed over the whole period.${since('cagr', cagr)}`}
          value={formatPct(cagr)}
          tone={toneOf(cagr)}
          benchmark={formatPct(view.cagr)}
          gap={view.excessCagr === null ? null : formatPp(view.excessCagr)}
          gapTone={toneOf(view.excessCagr)}
          note={companion}
        />
        <Headline
          label="Max drawdown"
          help={`The worst peak-to-trough fall in portfolio value: how far down you'd have been at the low point.${since('max_drawdown', maxDd)}`}
          value={formatPct(maxDd)}
          tone="negative"
          benchmark={formatPct(view.maxDrawdown)}
          gap={
            ddGap === null
              ? null
              : `${formatPp(Math.abs(ddGap), 1, { sign: false })} ${ddGap >= 0 ? 'shallower' : 'deeper'}`
          }
          gapTone={toneOf(ddGap)}
        />
        <Headline
          label="Sharpe"
          help={`Return above cash per unit of volatility, the same definition for the strategy and the benchmark. Above 1 is generally good.${since('sharpe', sharpe, 'ratio')}`}
          value={formatNumber(sharpe)}
          benchmark={view.sharpe === null ? EMPTY : formatNumber(view.sharpe)}
          gap={sharpeGap === null ? null : formatNumber(sharpeGap, 2, { sign: true })}
          gapTone={toneOf(sharpeGap)}
        />
        <Headline
          label="₹1 lakh became"
          help={`Final value of ₹1 lakh invested at the start and left running under this strategy.${since('final_value', finalValue, 'inr')}`}
          value={formatInr(finalValue, { compact: true })}
          benchmark={formatInr(view.finalValue, { compact: true })}
          gap={ratio === null ? null : `${formatNumber(ratio, 2)}×`}
        />
        <Headline
          label="Last 12 months"
          help="Return over the last 12 months of the run (by date), and since the end of last year."
          value={formatPct(last12, 1, { sign: true })}
          tone={toneOf(last12)}
          benchmark={formatPct(benchLast12, 1, { sign: true })}
          gap={ytd === null ? null : `YTD ${formatPct(ytd, 1, { sign: true })}`}
        />
      </div>
      {trust ? (
        <p
          role="note"
          className="border-t border-border bg-surface-2/50 px-4 py-2 text-xs text-muted sm:px-5"
        >
          {trust}{' '}
          <a
            href={EVALUATION_REVIEW_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Evaluation review
          </a>
        </p>
      ) : null}
      {view.replaced ? (
        <p className="border-t border-border bg-warning/10 px-4 py-1.5 text-xs text-muted sm:px-5">
          {view.replaced.label} has no usable data for this run
          {view.replaced.reason ? ` (${view.replaced.reason})` : ''}, so {view.label} is shown
          instead.
        </p>
      ) : null}
      <div className="flex items-center gap-x-5 gap-y-1 overflow-hidden border-t border-border px-4 py-2 text-xs text-muted sm:px-5">
        {/* One line, never wrapping: what does not fit fades out, and "All metrics" has the rest. */}
        <div
          className="flex min-w-0 flex-1 items-center gap-x-5 overflow-hidden [mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]"
          title="All metrics shows the full set"
        >
          <Inline label="Sortino">{formatNumber(num(k.sortino))}</Inline>
          <Inline label="Volatility">{formatPct(num(k.volatility))}</Inline>
          <Inline label="Beat it">
            {view.yearsBeating === null ? EMPTY : formatInt(view.yearsBeating)} of{' '}
            {formatInt(num(k.years))} yrs
          </Inline>
          <Inline label="Exits / yr">{formatNumber(num(k.exits_per_year), 1)}</Inline>
          <Inline label="Avg holding">{formatNumber(num(k.avg_weeks_held), 0)} wk</Inline>
          <Inline label="Win rate">{formatPct(num(k.win_rate), 0)}</Inline>
          <Inline label="In cash/debt">{formatPct(num(k.time_in_cash), 0)}</Inline>
          {config.tax ? (
            <Inline label="Tax paid">{formatInr(num(k.tax_paid), { compact: true })}</Inline>
          ) : null}
          {notes.length ? (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-warning">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              {notes.length} data {notes.length === 1 ? 'note' : 'notes'}
            </span>
          ) : null}
          {view.asOf ? (
            <span className="whitespace-nowrap text-faint">
              {view.label} closes to {formatDay(view.asOf)}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          aria-expanded={metricsOpen}
          onClick={() => setMetricsOpen(!metricsOpen)}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {metricsOpen ? 'Fewer metrics' : 'All metrics'}
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', metricsOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </div>
      {metricsOpen ? (
        <div className="space-y-3 border-t border-border px-4 py-3 sm:px-5">
          <div className="flex flex-wrap gap-1.5">
            {assumptionChips(config).map((chip) => (
              <span
                key={chip}
                className="whitespace-nowrap rounded-full border border-border bg-surface-2/50 px-2.5 py-0.5 text-xs text-muted"
              >
                {chip}
              </span>
            ))}
          </div>
          {notes.length ? (
            <div className="space-y-1 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-muted">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          ) : null}
          {view.note ? (
            <p className="text-xs text-faint">
              {view.label}: {view.note}.
            </p>
          ) : null}
          <MomentumInsights result={result} view={view} yearly={yearlyRows(series)} />
          <MomentumKpiCards result={result} tax={Boolean(config.tax)} />
        </div>
      ) : null}
    </section>
  );
}
