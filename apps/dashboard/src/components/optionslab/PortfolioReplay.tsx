/**
 * "Replay the list" (BL-095): one list's whole basket on one day, minute by minute, under the
 * portfolio stop. The basket's combined P&L, the level it stops at (a step line when trailing), a
 * marker where it closed, and each pick as a thin line. Read-only; it re-simulates the strategy
 * files (the same call the nightly update made) and says whether the no-stop total equals the log.
 */

import type { ISeriesApi, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { useChart } from '../../hooks/useChart';
import { useRotationPortfolioDay } from '../../hooks/useRotationPortfolio';
import { getChartTheme, getSeriesPalette, pickSeries, withAlpha } from '../../lib/chartTheme';
import { formatDay, formatInr } from '../../lib/format';
import { type PortfolioStopSetting, buttonLabel, isOn } from '../../lib/portfolioStop';
import { listLabel } from '../../lib/rotationListNames';
import type { RotationListKey, RotationLogSource } from '../../types/rotationDailyLog';
import type { PortfolioDay } from '../../types/rotationPortfolio';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { pnlClass } from './shared';

const SESSION_OPEN_MINUTE = 9 * 60 + 15;

/** Minute index (0 = 09:15) as a chart time: the exchange clock read as UTC, so the axis shows it. */
function stamp(day: string, minute: number): UTCTimestamp {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const seconds = Date.UTC(y, m - 1, d, 0, SESSION_OPEN_MINUTE + minute) / 1000;
  return seconds as UTCTimestamp;
}

function firedText(book: PortfolioDay['book']): string {
  if (book.stop_label === null)
    return 'The basket never reached the level: the day ran to the close.';
  const what =
    book.fired_by === 'lock'
      ? 'the profit lock'
      : book.fired_by === 'trail'
        ? 'the trailed stop'
        : 'the portfolio stop';
  return `Closed by ${what} at ${book.stop_label}.`;
}

function Chart({ d }: { d: PortfolioDay }) {
  const container = useRef<HTMLDivElement>(null);
  const { chartRef, ready, theme } = useChart(container, false);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || !ready) return;
    const t = getChartTheme(theme);
    const palette = getSeriesPalette(theme);
    const added: ISeriesApi<'Line' | 'Baseline'>[] = [];
    const times = d.combined.map((_, i) => stamp(d.day, i));
    const line = (values: (number | null)[]) =>
      values.flatMap((v, i) => (v === null ? [] : [{ time: times[i] as UTCTimestamp, value: v }]));

    d.picks.forEach((p, i) => {
      const s = chart.addLineSeries({
        color: withAlpha(pickSeries(palette, i), 0.7),
        lineWidth: 1,
        title: p.name,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      s.setData(line(p.path));
      added.push(s);
    });

    if (d.book.stop_minute !== null) {
      const raw = chart.addLineSeries({
        color: withAlpha(t.text, 0.7),
        lineWidth: 1,
        lineStyle: 2,
        title: 'No portfolio stop',
        priceLineVisible: false,
        lastValueVisible: false,
      });
      raw.setData(line(d.combined));
      added.push(raw);
    }

    const book = chart.addBaselineSeries({
      baseValue: { type: 'price', price: 0 },
      topLineColor: t.positive,
      topFillColor1: withAlpha(t.positive, 0.2),
      topFillColor2: withAlpha(t.positive, 0.03),
      bottomLineColor: t.negative,
      bottomFillColor1: withAlpha(t.negative, 0.03),
      bottomFillColor2: withAlpha(t.negative, 0.2),
      lineWidth: 2,
      title: 'Basket ₹',
      priceLineVisible: false,
    });
    book.setData(line(d.stopped));
    added.push(book);

    if (d.level.some((v) => v !== null)) {
      const level = chart.addLineSeries({
        color: t.warning,
        lineWidth: 2,
        lineType: 1,
        title: 'Stop level',
        priceLineVisible: false,
        lastValueVisible: true,
      });
      level.setData(line(d.level));
      added.push(level);
    }

    if (d.book.stop_minute !== null) {
      const marker: SeriesMarker<Time> = {
        time: times[d.book.stop_minute] as UTCTimestamp,
        position: 'aboveBar',
        shape: 'arrowDown',
        color: t.negative,
        text: `stop ${d.book.stop_label ?? ''}`,
      };
      book.setMarkers([marker]);
    }
    chart.timeScale().fitContent();
    return () => {
      for (const s of added) {
        try {
          chart.removeSeries(s);
        } catch {
          // chart already disposed on unmount
        }
      }
    };
  }, [d, ready, theme, chartRef]);

  return <div ref={container} className="w-full" style={{ minHeight: 300 }} />;
}

export function PortfolioReplay({
  day,
  list,
  source,
  setting,
  onClose,
}: {
  day: string;
  list: RotationListKey;
  source: RotationLogSource;
  setting: PortfolioStopSetting;
  onClose: () => void;
}) {
  const res = useRotationPortfolioDay(day, list, source, setting);
  // Only an answer for this day, list and setting is drawn (the hook keeps the previous one).
  const d = res.data !== null && res.data.day === day && res.data.list === list ? res.data : null;
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            {listLabel(list)} as one basket · {formatDay(day)}
          </h3>
          <p className="text-xs text-muted">
            {buttonLabel(setting)}. Replayed from the strategy files, gross, minute close.
          </p>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close the list replay" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {res.error && !d ? (
        <div className="mt-3">
          <StateMessage
            variant="error"
            title="Could not replay this list"
            description={`${res.error}. The replay needs this day's 1-minute bars on the machine running the API.`}
          />
        </div>
      ) : !d ? (
        <output aria-busy="true" aria-label="Replaying the list" className="mt-3 block">
          <Skeleton className="h-72 w-full" />
        </output>
      ) : (
        <div className="mt-3 space-y-3">
          <Chart d={d} />
          <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-faint">With the stop</dt>
              <dd className={`metric text-sm ${pnlClass(d.book.gross_with)}`}>
                {formatInr(d.book.gross_with, { sign: true })}
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-faint">Without</dt>
              <dd className={`metric text-sm ${pnlClass(d.book.gross_without)}`}>
                {formatInr(d.book.gross_without, { sign: true })}
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-faint">Lots</dt>
              <dd className="metric">{d.book.lots}</dd>
            </div>
            <span className="text-muted">{isOn(setting) ? firedText(d.book) : 'No stop set.'}</span>
          </dl>
          {!d.book.matches_log ? (
            <p className="text-xs text-warning">
              The replay without a stop ({formatInr(d.book.gross_without, { sign: true })}) differs
              from the log ({formatInr(d.book.gross_log, { sign: true })}): the day's data was
              repaired after the nightly update, or a strategy file changed.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
