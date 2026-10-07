/**
 * The benchmark a Momentum result is compared against, picked on the page (the headline
 * benchmark picker) rather than fixed by the run. Every backtest result carries five
 * dividend-inclusive indices (`result.benchmarks`); this module turns the picked one into what
 * the page draws and quotes, and derives the series the run used to carry for its single
 * benchmark (drawdown, 52-week edge, yearly returns, worst falls). The statistics that need the
 * run's cash series and the engine's definitions (CAGR, Sharpe, Sortino, max drawdown) come
 * from the server; nothing here re-derives them.
 *
 * A result computed before the picker existed has no `benchmarks`: it falls back to the run's
 * own benchmark (`benchmark_name`, `series.benchmark`, `kpis.benchmark_*`), and so does a pick
 * whose index has no data for this run.
 */
import type { MomentumResult, MomentumSeries } from '../types/momentum';

type Series = ReadonlyArray<number | null>;

/** The picker's default: the buyable momentum index this strategy has to beat to be worth it. */
export const DEFAULT_BENCHMARK = 'Nifty200 Momentum 30 TRI';

export interface BenchmarkOption {
  name: string;
  label: string;
  available: boolean;
  cagr: number | null;
}

export interface BenchmarkView {
  /** The key the picker stores ("Nifty200 Momentum 30 TRI"), or the run's own benchmark. */
  name: string;
  /** For display: "Nifty 200 Momentum 30". */
  label: string;
  /** Rupees on `series.dates`, ₹1 lakh at the first week. */
  values: Array<number | null>;
  cagr: number | null;
  excessCagr: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  sortino: number | null;
  volatility: number | null;
  finalValue: number | null;
  yearsBeating: number | null;
  /** Last real close; null when it is the final week or unknown. */
  asOf: string | null;
  note: string | null;
  /** True when this is the run's own benchmark, not a picker index. */
  fallback: boolean;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** "Nifty200 Momentum 30 TRI" -> "Nifty 200 Momentum 30"; any other name loses " TRI" only. */
export function benchmarkLabel(name: string): string {
  return name.replace(/ TRI$/, '').replace(/^Nifty(\d)/, 'Nifty $1');
}

/** The picker's menu for this result, in the server's order; empty for an older result. */
export function benchmarkOptions(result: MomentumResult): BenchmarkOption[] {
  return (result.benchmarks ?? []).map((choice) => ({
    name: choice.name,
    label: benchmarkLabel(choice.name),
    available: choice.available,
    cagr: choice.available ? num(choice.cagr) : null,
  }));
}

/** The picked index as the page uses it, or the run's own benchmark when it has no data. */
export function resolveBenchmark(result: MomentumResult, picked: string): BenchmarkView {
  const choice = result.benchmarks?.find((entry) => entry.name === picked);
  const lastWeek = result.series.dates.at(-1)?.slice(0, 10) ?? null;
  if (choice?.available) {
    return {
      name: choice.name,
      label: benchmarkLabel(choice.name),
      values: choice.series,
      cagr: num(choice.cagr),
      excessCagr: num(choice.excess_cagr),
      maxDrawdown: num(choice.max_drawdown),
      sharpe: num(choice.sharpe),
      sortino: num(choice.sortino),
      volatility: num(choice.volatility),
      finalValue: num(choice.final_value),
      yearsBeating: num(choice.years_beating),
      asOf: choice.as_of && choice.as_of !== lastWeek ? choice.as_of : null,
      note: choice.note,
      fallback: false,
    };
  }
  const k = result.kpis;
  return {
    name: result.benchmark_name,
    label: result.benchmark_name,
    values: result.series.benchmark,
    cagr: num(k.benchmark_cagr),
    excessCagr: num(k.excess_cagr),
    maxDrawdown: num(k.benchmark_max_drawdown),
    sharpe: null,
    sortino: null,
    volatility: null,
    finalValue: num(k.benchmark_final_value),
    yearsBeating: num(k.years_beating_benchmark),
    asOf: null,
    note: null,
    fallback: true,
  };
}

/** Peak-to-date fall: value / running max - 1. A gap keeps the running max and stays null. */
export function drawdownSeries(values: Series): Array<number | null> {
  let peak = Number.NEGATIVE_INFINITY;
  return values.map((value) => {
    if (value === null || !Number.isFinite(value)) return null;
    peak = Math.max(peak, value);
    return peak > 0 ? value / peak - 1 : null;
  });
}

/** The strategy's 52-week return minus the benchmark's, week by week (null for the first year). */
export function rolling52Excess(
  strategy: Series,
  benchmark: Series,
  weeks = 52,
): Array<number | null> {
  return strategy.map((value, index) => {
    if (index < weeks) return null;
    const s0 = strategy[index - weeks];
    const b0 = benchmark[index - weeks];
    const b1 = benchmark[index];
    if (value === null || s0 === null || b0 === null || b1 === null) return null;
    if (s0 === undefined || b0 === undefined || b1 === undefined) return null;
    if (s0 <= 0 || b0 <= 0) return null;
    return value / s0 - b1 / b0;
  });
}

/** The run's series with its benchmark line, drawdown and 52-week edge swapped for `view`. */
export function withBenchmark(series: MomentumSeries, view: BenchmarkView): MomentumSeries {
  if (view.fallback) return series;
  return {
    ...series,
    benchmark: view.values,
    drawdown_benchmark: drawdownSeries(view.values),
    rolling_52w_excess: rolling52Excess(series.strategy, view.values),
  };
}

/** Return over the last `weeks` weeks (52 = the last 12 months); null when the run is shorter. */
export function trailingReturn(values: Series, weeks = 52): number | null {
  const last = values.length - 1;
  if (last - weeks < 0) return null;
  const end = values[last];
  const start = values[last - weeks];
  if (end == null || start == null || start <= 0) return null;
  return end / start - 1;
}

/** Return since the last week of the previous calendar year; null in the run's first year. */
export function yearToDate(dates: ReadonlyArray<string>, values: Series): number | null {
  const last = dates.length - 1;
  if (last < 1) return null;
  const year = dates[last]?.slice(0, 4);
  let index = last;
  while (index >= 0 && dates[index]?.slice(0, 4) === year) index -= 1;
  if (index < 0) return null;
  const end = values[last];
  const start = values[index];
  if (end == null || start == null || start <= 0) return null;
  return end / start - 1;
}

export interface YearlyRow {
  year: number;
  strategy: number | null;
  benchmark: number | null;
  cash: number | null;
  vs_benchmark: number | null;
}

/**
 * Calendar-year returns of the strategy, the benchmark and cash, as the engine's
 * `metrics.yearly` computes them: year-end to year-end, the first year from the first week.
 */
export function yearlyRows(series: MomentumSeries): YearlyRow[] {
  const ends = new Map<number, number>();
  series.dates.forEach((date, index) => ends.set(Number(date.slice(0, 4)), index));
  const rows: YearlyRow[] = [];
  let previous = 0;
  for (const [year, end] of ends) {
    const change = (values: Series): number | null => {
      const a = values[previous];
      const b = values[end];
      return a == null || b == null || a <= 0 ? null : b / a - 1;
    };
    const strategy = change(series.strategy);
    const benchmark = change(series.benchmark);
    rows.push({
      year,
      strategy,
      benchmark,
      cash: change(series.cash),
      vs_benchmark: strategy === null || benchmark === null ? null : strategy - benchmark,
    });
    previous = end;
  }
  return rows;
}

export interface Episode {
  /** Indexes into the series. */
  peak: number;
  trough: number;
  /** First week back at the peak's value; null while still under water. */
  recovered: number | null;
  depth: number;
}

/**
 * The `count` deepest peak-to-trough falls that do not overlap, deepest first: the engine's
 * `metrics.worst_episodes`, with the recovery week kept.
 */
export function worstEpisodes(values: Series, count = 6): Episode[] {
  const dd = drawdownSeries(values);
  const used = new Array<boolean>(values.length).fill(false);
  const out: Episode[] = [];
  while (out.length < count) {
    let trough = -1;
    dd.forEach((value, index) => {
      if (used[index] || value === null) return;
      const best = trough < 0 ? null : dd[trough];
      if (best == null || value < best) trough = index;
    });
    const depth = trough < 0 ? null : dd[trough];
    if (depth == null || depth >= 0) break;
    let peak = 0;
    for (let i = 0; i <= trough; i += 1) {
      const v = values[i];
      const best = values[peak];
      if (v != null && (best == null || v > best)) peak = i;
    }
    const peakValue = values[peak] ?? 0;
    let recovered: number | null = null;
    for (let i = trough; i < values.length; i += 1) {
      const v = values[i];
      if (v != null && v >= peakValue) {
        recovered = i;
        break;
      }
    }
    const end = recovered ?? values.length - 1;
    for (let i = peak; i <= end; i += 1) used[i] = true;
    out.push({ peak, trough, recovered, depth });
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/** values[to] / values[from] - 1, or null across a gap. */
export function changeBetween(values: Series, from: number, to: number): number | null {
  const a = values[from];
  const b = values[to];
  return a == null || b == null || a <= 0 ? null : b / a - 1;
}
