'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { getChartTheme, plotlyChrome } from '../../lib/chartTheme';
import { formatInt, formatPct } from '../../lib/format';
import { TIMELINE_TOP_N, longestHeldAssets } from '../../lib/momentumResult';
import { type PlotlyBasic, loadPlotly } from '../../lib/plotly';
import { useThemeStore } from '../../store/theme';
import { Button } from '../ui/Button';
import { ResultSection } from './ResultSection';

/**
 * One row per instrument, time left to right — a Gantt of every closed and open position.
 * Capped to the instruments held longest (a Broad run holds hundreds of names over its life,
 * which is unreadable as one chart), with a toggle to show them all in a scrolling box.
 */
export function MomentumTimelineChart({
  rows: allRows,
  topN = TIMELINE_TOP_N,
}: {
  rows: Array<Record<string, unknown>>;
  /** How many instruments to show before "Show all". */
  topN?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((state) => state.theme);
  const [showAll, setShowAll] = useState(false);

  const longest = useMemo(() => longestHeldAssets(allRows, topN), [allRows, topN]);
  const capped = longest.total > topN;
  const rows = useMemo(() => {
    if (!capped || showAll) return allRows;
    const keep = new Set(longest.assets);
    return allRows.filter((row) => keep.has(String(row.asset)));
  }, [allRows, capped, showAll, longest]);

  const assetOrder = useMemo(() => {
    const firstSeen = new Map<string, string>();
    for (const row of rows) {
      const asset = String(row.asset);
      const start = String(row.start);
      const known = firstSeen.get(asset);
      if (known === undefined || start < known) firstSeen.set(asset, start);
    }
    return [...firstSeen.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([asset]) => asset);
  }, [rows]);

  useEffect(() => {
    const element = ref.current;
    if (!element || rows.length === 0) return;
    let mounted = true;
    let plotly: PlotlyBasic | null = null;

    async function render(): Promise<void> {
      const loaded = await loadPlotly();
      if (!mounted || !element) return;
      plotly = loaded;
      const colors = getChartTheme(theme);
      const durationsMs = rows.map((row) => {
        const start = new Date(String(row.start)).getTime();
        const end = new Date(String(row.end)).getTime();
        return Math.max(end - start, 86_400_000 * 3);
      });
      const trace: Record<string, unknown> = {
        type: 'bar',
        orientation: 'h',
        y: rows.map((row) => String(row.asset)),
        x: durationsMs,
        base: rows.map((row) => String(row.start)),
        marker: {
          color: rows.map((row) => {
            const open = Boolean(row.open);
            const ret = typeof row.return === 'number' ? row.return : 0;
            if (open) return colors.primary;
            return ret >= 0 ? colors.positive : colors.negative;
          }),
        },
        customdata: rows.map((row) => [
          String(row.start).slice(0, 10),
          String(row.end).slice(0, 10),
          formatPct(typeof row.return === 'number' ? row.return : null),
          String(row.weeks ?? '–'),
          row.open ? 'open' : 'closed',
        ]),
        hovertemplate:
          '%{y}<br>%{customdata[0]} → %{customdata[1]} (%{customdata[3]}w)<br>Return %{customdata[2]} · %{customdata[4]}<extra></extra>',
      };
      const layout: Record<string, unknown> = {
        // Every instrument gets a readable row; "show all" scrolls inside its box instead of
        // squeezing hundreds of rows into a fixed height.
        height: Math.max(220, assetOrder.length * 22 + 40),
        margin: { l: 110, r: 18, t: 10, b: 30 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        ...plotlyChrome(colors, 11),
        showlegend: false,
        xaxis: { type: 'date', gridcolor: colors.grid },
        yaxis: {
          categoryorder: 'array',
          categoryarray: assetOrder,
          gridcolor: colors.grid,
          automargin: true,
        },
      };
      await plotly.react(element, [trace], layout, {
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
  }, [rows, assetOrder, theme]);

  return (
    <ResultSection
      title="Trade timeline"
      description="One bar per position held — green closed a winner, red a loser, the accent colour is still open. Hover for dates and return."
      padded={false}
      actions={
        capped ? (
          <Button size="sm" aria-pressed={showAll} onClick={() => setShowAll((value) => !value)}>
            {showAll
              ? `Show the ${formatInt(topN)} longest-held`
              : `Show all ${formatInt(longest.total)}`}
          </Button>
        ) : null
      }
    >
      {capped ? (
        <p className="text-xs text-muted">
          {showAll
            ? `Showing all ${formatInt(longest.total)} instruments, oldest entry first.`
            : `Showing the ${formatInt(topN)} longest-held of ${formatInt(longest.total)}.`}
        </p>
      ) : null}
      {allRows.length === 0 ? (
        <p className="text-sm text-muted">No trades for this run.</p>
      ) : (
        <div className="max-h-[640px] overflow-y-auto">
          <div ref={ref} className="w-full" />
        </div>
      )}
    </ResultSection>
  );
}
