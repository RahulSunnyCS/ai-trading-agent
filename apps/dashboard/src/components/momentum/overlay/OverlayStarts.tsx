'use client';

/**
 * Momentum › Options overlay › Fresh starts: the page's settings started afresh with the capital
 * on many days (every month, quarter or half-year), each held for one to three years. For a small
 * sleeve judged by what a start usually returns and how often it is lost, not by one start's
 * drawdown. One bar per start, on a log scale, coloured by how it ended.
 */

import { Loader2, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { OVERLAY_STARTS_JOBS_URL, useOptionsOverlayJob } from '../../../hooks/useOptionsOverlayJob';
import { getChartTheme, plotlyChrome } from '../../../lib/chartTheme';
import { formatDay, formatInr, formatInt } from '../../../lib/format';
import { startHover, startOutcome, startsAxis } from '../../../lib/optionsOverlay';
import { type PlotlyBasic, loadPlotly } from '../../../lib/plotly';
import { useThemeStore } from '../../../store/theme';
import type {
  OverlayRequest,
  OverlayStartsRequest,
  OverlayStartsResult,
} from '../../../types/optionsOverlay';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { StatCard } from '../../ui/StatCard';
import { StateMessage } from '../../ui/StateMessage';

type Every = '1' | '3' | '6';
type Years = '1' | '2' | '3';

export function OverlayStarts({
  request,
  problem,
}: {
  request: OverlayRequest;
  problem: string | null;
}) {
  const job = useOptionsOverlayJob<OverlayStartsResult, OverlayStartsRequest>(
    OVERLAY_STARTS_JOBS_URL,
  );
  const [every, setEvery] = useState<Every>('3');
  const [years, setYears] = useState<Years>('1');
  const [washout, setWashout] = useState('0.2');
  const result = job.job?.status === 'done' ? job.job.result : null;
  const [shown, setShown] = useState<OverlayStartsResult | null>(null);
  useEffect(() => {
    if (result) setShown(result);
  }, [result]);

  const run = () =>
    void job.start({
      ...request,
      every_months: Number(every) as 1 | 3 | 6,
      years: Number(years),
      washout: Number(washout),
    });

  const capital = shown?.settings.capital ?? request.capital;
  const s = shown?.summary ?? null;
  return (
    <section
      aria-label="Fresh starts"
      className="min-w-0 rounded-xl border border-border bg-surface shadow-card"
    >
      <header className="space-y-2 px-4 pb-2 pt-3">
        <div className="flex items-baseline gap-3">
          <h3 className="whitespace-nowrap text-sm font-semibold text-foreground">Fresh starts</h3>
          <p className="min-w-0 flex-1 truncate text-xs text-faint">
            The run bar&apos;s settings, started with{' '}
            {formatInr(request.capital, { compact: true })} on many days
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<Every>
            ariaLabel="Start every"
            size="sm"
            value={every}
            options={[
              { value: '1', label: 'Monthly' },
              { value: '3', label: 'Quarterly' },
              { value: '6', label: 'Half-yearly' },
            ]}
            onChange={setEvery}
          />
          <SegmentedControl<Years>
            ariaLabel="Held for"
            size="sm"
            value={years}
            options={[
              { value: '1', label: '1 year' },
              { value: '2', label: '2 years' },
              { value: '3', label: '3 years' },
            ]}
            onChange={setYears}
          />
          <Select
            aria-label="Washed out below"
            className="w-36"
            value={washout}
            onChange={(e) => setWashout(e.target.value)}
          >
            <option value="0.1">Wash-out 10 %</option>
            <option value="0.2">Wash-out 20 %</option>
            <option value="0.3">Wash-out 30 %</option>
            <option value="0.5">Wash-out 50 %</option>
          </Select>
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={run}
            loading={job.running}
            disabled={problem !== null}
            title={problem ?? undefined}
          >
            <Play className="h-3.5 w-3.5" aria-hidden /> Run starts
          </Button>
        </div>
      </header>
      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs text-muted">
          Each start is its own account: it buys only what it can pay for, ends at its capital plus
          the after-tax total (money taken out included), and is washed out if its account fell
          below the wash-out level at a week&apos;s close. The strategy&apos;s picks are its run
          over the page&apos;s window, joined on each start day.
        </p>
        {job.error ? (
          <StateMessage variant="error" title="The starts run failed" description={job.error} />
        ) : null}
        {job.running ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Running every start (a few minutes the first time, seconds after a run of the same
            settings)…
          </div>
        ) : null}
        {shown && s ? (
          <>
            <p className="text-xs text-faint">
              {formatInt(s.starts)} starts of {formatInr(capital, { compact: true })}, each held{' '}
              {shown.years} year{shown.years > 1 ? 's' : ''}
              {shown.strategy ? ` · ${shown.strategy}` : ''} · {shown.settings.moneyness}
              {shown.skipped ? ` · ${shown.skipped} too short to run` : ''}
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <StatCard
                label="Median end"
                value={formatInr(s.median_end_rs, { compact: true })}
                tone={s.median_end_rs > capital ? 'positive' : 'negative'}
                note="the typical start"
              />
              <StatCard
                label="Ended above start"
                value={`${formatInt(s.above_start)} of ${formatInt(s.starts)}`}
                tone={s.above_start * 2 >= s.starts ? 'positive' : 'negative'}
              />
              <StatCard
                label="Washed out"
                value={`${formatInt(s.washed_out)} of ${formatInt(s.starts)}`}
                tone={s.washed_out ? 'negative' : 'default'}
                note={`account below ${formatInr(shown.washout_rs, { compact: true })}`}
              />
              <StatCard
                label="Average end"
                value={formatInr(s.mean_end_rs, { compact: true })}
                tone={s.mean_end_rs > capital ? 'positive' : 'negative'}
                note="pulled up by the best few"
              />
              <StatCard
                label="Best"
                value={formatInr(s.best_rs, { compact: true })}
                tone="positive"
              />
              <StatCard
                label="Worst"
                value={formatInr(s.worst_rs, { compact: true })}
                tone="negative"
                note={`median ${formatInt(s.median_trades)} trades a start`}
              />
            </div>
            <StartsChart result={shown} />
            <p className="text-xs text-faint">
              Green ended above {formatInr(capital, { compact: true })}, red washed out, grey
              neither. Log scale: an end below {formatInr(capital / 100, { compact: true })} is
              drawn at it. Starts from {formatDay(shown.starts[0]?.start)} to{' '}
              {formatDay(shown.starts[shown.starts.length - 1]?.start)}.
            </p>
          </>
        ) : shown ? (
          <StateMessage
            variant="empty"
            title="No start fits"
            description="The window holds no start with its whole horizon in the data."
          />
        ) : null}
      </div>
    </section>
  );
}

function StartsChart({ result }: { result: OverlayStartsResult }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((state) => state.theme);

  useEffect(() => {
    const element = ref.current;
    if (!element || result.starts.length === 0) return;
    let mounted = true;
    let plotly: PlotlyBasic | null = null;

    async function render(): Promise<void> {
      const loaded = await loadPlotly();
      if (!mounted || !element) return;
      plotly = loaded;
      const colors = getChartTheme(theme);
      const capital = result.settings.capital;
      const axis = startsAxis(capital, result.summary?.best_rs ?? capital);
      const tone = { above: colors.positive, washed: colors.negative, below: colors.text };
      const x = result.starts.map((r) => r.start);
      const traces: Array<Record<string, unknown>> = [
        {
          x,
          y: result.starts.map((r) => Math.max(r.end_rs, axis.floor)),
          type: 'bar',
          marker: { color: result.starts.map((r) => tone[startOutcome(r, capital)]) },
          text: result.starts.map((r) => startHover(r)),
          hovertemplate: '%{text}<extra></extra>',
          textposition: 'none',
          showlegend: false,
        },
      ];
      const line = (y: number, dash: string) => ({
        type: 'line',
        xref: 'paper',
        x0: 0,
        x1: 1,
        y0: y,
        y1: y,
        line: { color: colors.border, width: 1, dash },
      });
      const layout: Record<string, unknown> = {
        height: 300,
        margin: { l: 64, r: 18, t: 10, b: 36 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        ...plotlyChrome(colors),
        bargap: 0.25,
        xaxis: { gridcolor: colors.grid, type: 'date', hoverformat: '%d %b %Y' },
        yaxis: {
          type: 'log',
          gridcolor: colors.grid,
          tickvals: axis.tickvals,
          ticktext: axis.ticktext,
          range: [Math.log10(axis.floor) - 0.25, Math.log10(axis.top * 1.2)],
        },
        shapes: [line(capital, 'solid'), line(result.washout_rs, 'dot')],
      };
      await plotly.react(element, traces, layout, {
        responsive: true,
        displaylogo: false,
        displayModeBar: false,
      });
    }

    void render();
    return () => {
      mounted = false;
      if (plotly && element) plotly.purge(element);
    };
  }, [result, theme]);

  return (
    <div
      ref={ref}
      className="w-full"
      role="img"
      aria-label="What each start ended at, one bar per start day"
    />
  );
}
