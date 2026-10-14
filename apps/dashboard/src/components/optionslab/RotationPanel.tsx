/**
 * Options Lab → Rotation: how the four registered lists (Steady A, Calendar B, Adaptive C,
 * Baseline REF) are doing on days nobody had seen, against Baseline, the owner's fixed base and random baskets, and whether today's data can
 * be trusted (BL-058 Phase 4).
 *
 * Overview is the short daily surface: health/read-out, the current baskets, and the headline
 * and chart once a forward session has been scored. Journal and Research are intentional drill-down
 * modes, so their heavier widgets are not mounted while Overview is selected.
 *
 * Gross only: the stored costs are zero. Lists are alternative baskets and are never added up.
 * Nothing on this page changes a list, a weight or the journal.
 */

import { useMemo, useState } from 'react';

import { usePortfolioStop } from '../../hooks/usePortfolioStop';
import { useQueryState } from '../../hooks/useQueryState';
import { useRotationOverview, useRotationSummary } from '../../hooks/useRotation';
import { useRotationPortfolioDays } from '../../hooks/useRotationPortfolio';
import { formatDay, formatIstTime, istToday } from '../../lib/format';
import { amountOf, buttonLabel, isOn, sameTrail, trailParam } from '../../lib/portfolioStop';
import { listName } from '../../lib/rotationListNames';
import { overlaySummary, unmatched } from '../../lib/rotationPortfolioView';
import {
  BENCHMARK_LABEL,
  BENCHMARK_NOTE,
  LIST_KEYS,
  type RotationBenchmark,
  benchmarkFigures,
  verdict as buildVerdict,
  headline,
  heroSeries,
} from '../../lib/rotationView';
import type { RotationListKey } from '../../types/rotation';
import { Accordion } from '../ui/Accordion';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { PortfolioStopButton } from './PortfolioStopButton';
import { RotationDailyLog } from './RotationDailyLog';
import { RotationDrawdowns } from './RotationDrawdowns';
import { RotationDrift } from './RotationDrift';
import { RotationExplain } from './RotationExplain';
import { RotationPulse } from './RotationPulse';
import { RotationRegime } from './RotationRegime';
import { RotationShadowScoreboard } from './RotationShadowScoreboard';
import { RotationBaskets } from './rotation/RotationBaskets';
import { RotationHeadline } from './rotation/RotationHeadline';
import { RotationHealthStrip } from './rotation/RotationHealth';
import { RotationHero } from './rotation/RotationHero';
import { RotationListCards } from './rotation/RotationListCards';
import { RotationReadoutBanner } from './rotation/RotationReadout';
import { RotationVerdict } from './rotation/RotationVerdict';

const FOCUS_OPTIONS: SegmentedOption<RotationListKey>[] = LIST_KEYS.map((value) => ({
  value,
  label: listName(value),
}));

const BENCHMARK_OPTIONS: SegmentedOption<RotationBenchmark>[] = (
  ['base', 'REF', 'random'] as const
).map((value) => ({ value, label: BENCHMARK_LABEL[value] }));

type RotationView = 'overview' | 'journal' | 'research';

const VIEW_OPTIONS: SegmentedOption<RotationView>[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'journal', label: 'Journal' },
  { value: 'research', label: 'Research' },
];

function rotationView(value: string | null): RotationView {
  return value === 'journal' || value === 'research' ? value : 'overview';
}

export function RotationPanel() {
  const overview = useRotationOverview();
  const summary = useRotationSummary();
  const [viewParam, setViewParam] = useQueryState('rotationView');
  const view = rotationView(viewParam);
  const [focus, setFocus] = useState<RotationListKey>('A');
  const [benchmark, setBenchmark] = useState<RotationBenchmark>('base');
  const [shown, setShown] = useState<ReadonlySet<RotationListKey>>(new Set(['A']));
  const [showBase, setShowBase] = useState(true);
  // BL-095: one portfolio stop for every widget below that shows stopped figures.
  const [portfolio, setPortfolio] = usePortfolioStop();

  const readoutDays = overview.data?.readout_days ?? 60;
  const s = summary.data;

  // BL-095: the forward sessions replayed under the portfolio stop. Only an answer for this
  // setting is laid over the read-out; the verdict, the intervals and the random baskets always
  // stay on the registered basis (the pre-registered test does not move with a typed level).
  const book = useRotationPortfolioDays('recorded', {}, portfolio);
  const bookNow =
    book.data !== null &&
    book.data.setting?.amount === amountOf(portfolio) &&
    sameTrail(book.data.setting?.trail, trailParam(portfolio)) &&
    Array.isArray(book.data.rows)
      ? book.data
      : null;
  const shown_s = useMemo(() => (s ? overlaySummary(s, bookNow) : s), [s, bookNow]);
  const stopped = shown_s !== s;
  const skipped = unmatched(bookNow);

  const visible = useMemo(() => new Set<RotationListKey>([...shown, focus]), [shown, focus]);
  const figures = useMemo(
    () => (shown_s ? headline(shown_s, focus, benchmark, readoutDays) : []),
    [shown_s, focus, benchmark, readoutDays],
  );
  const points = useMemo(() => (shown_s ? heroSeries(shown_s, focus) : []), [shown_s, focus]);
  const verdictFor = useMemo(() => (s ? buildVerdict(s, focus) : null), [s, focus]);
  const bench = shown_s ? benchmarkFigures(shown_s, benchmark, focus) : null;

  const reload = () => {
    overview.refetch();
    summary.refetch();
  };
  const toggle = (k: RotationListKey) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          Focus
          <SegmentedControl
            value={focus}
            options={FOCUS_OPTIONS}
            onChange={setFocus}
            ariaLabel="Focus list"
            size="sm"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          Compare with
          <SegmentedControl
            value={benchmark}
            options={BENCHMARK_OPTIONS}
            onChange={setBenchmark}
            ariaLabel="Benchmark"
            size="sm"
          />
        </div>
        <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
          Forward · gross · 2 lots per strategy
        </span>
        <PortfolioStopButton setting={portfolio} onChange={setPortfolio} />
        <span className="flex-1" />
        <RefreshButton
          onClick={reload}
          loading={overview.loading || summary.loading}
          label="Reload"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={view}
          options={VIEW_OPTIONS}
          onChange={setViewParam}
          ariaLabel="Rotation view"
          size="sm"
        />
        <p className="text-xs text-faint">{BENCHMARK_NOTE[benchmark]}</p>
      </div>

      {overview.error && overview.data ? (
        <StateMessage
          variant="error"
          title="The journal could not be re-read"
          description={`Showing what was read at ${formatIstTime(overview.data.health.as_of)} IST; the last request failed: ${overview.error}`}
        />
      ) : null}
      {summary.error && s ? (
        <StateMessage
          variant="error"
          title="The read-out could not be refreshed"
          description={`The figures below are the last ones received. ${summary.error}`}
        />
      ) : null}

      {overview.error && !overview.data ? (
        <StateMessage
          variant="error"
          title="Could not read the rotation journal"
          description={overview.error}
        />
      ) : overview.data ? (
        <>
          <RotationHealthStrip health={overview.data.health} />
          <RotationReadoutBanner
            scoredDays={s ? s.n_days : null}
            total={readoutDays}
            firstDay={s?.first_day ?? null}
            lastDay={s?.last_day ?? null}
            firstEntryDay={overview.data.first_entry_day}
          />
        </>
      ) : (
        <SkeletonRows rows={2} />
      )}

      {summary.error && !s ? (
        <StateMessage
          variant="error"
          title="Could not compute the read-out"
          description={summary.error}
        />
      ) : s === null ? (
        <SkeletonRows rows={5} />
      ) : view === 'overview' ? (
        <>
          {isOn(portfolio) && s.n_days > 0 ? (
            <p className="text-xs text-muted" aria-live="polite">
              {stopped
                ? `With the ${buttonLabel(portfolio).replace('Portfolio stop ', '')} portfolio stop replayed over these sessions: cumulative gross, ₹ per lot-day, the drawdowns and the curves. Beats random baskets, the verdict and the read-out stay on the registered basis, without a stop.${skipped > 0 ? ` ${skipped} list-day${skipped === 1 ? '' : 's'} no longer replay to their logged figure (bars repaired since the nightly update) and keep the registered one.` : ''}`
                : book.error
                  ? `The portfolio stop could not be replayed (${book.error}); the registered figures are shown.`
                  : 'Replaying the sessions under the portfolio stop; the registered figures are shown meanwhile.'}
            </p>
          ) : null}
          {s.n_days === 0 ? (
            <>
              {overview.data ? (
                <Card>
                  <CardHeader
                    title={
                      overview.data.baskets.entry === null
                        ? 'Next entry'
                        : overview.data.baskets.entry.day === istToday()
                          ? "Today's baskets"
                          : 'Latest recorded baskets'
                    }
                    description={
                      overview.data.baskets.entry === null
                        ? "The lists to be recorded at 09:16, before the day's results are known."
                        : overview.data.baskets.entry.day === istToday()
                          ? "Recorded at 09:16, before the day's results were known; scored after the evening run."
                          : `Recorded on ${formatDay(overview.data.baskets.entry.day)}; the next entry is recorded at 09:16 on the next session.`
                    }
                  />
                  <RotationBaskets
                    baskets={overview.data.baskets}
                    specs={overview.data.lists}
                    firstEntryDay={overview.data.first_entry_day}
                  />
                </Card>
              ) : null}
              <Card className="py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      No scored forward sessions yet
                    </p>
                    <p className="mt-0.5 text-sm text-muted">
                      {Object.values(s.pending_reasons)[0] ??
                        (s.late_entries.length > 0
                          ? `${s.late_entries.length} late entr${s.late_entries.length === 1 ? 'y' : 'ies'} excluded from the forward read-out.`
                          : 'The first entry is recorded at 09:16 and scored after the evening update.')}
                    </p>
                  </div>
                  <span className="rounded-full border border-info/30 bg-info/10 px-2.5 py-1 text-xs text-info">
                    {readoutDays} sessions to read-out
                  </span>
                </div>
              </Card>
            </>
          ) : (
            <>
              <RotationListCards
                summary={shown_s}
                baskets={overview.data?.baskets.lists}
                entryDay={overview.data?.baskets.entry?.day ?? null}
                today={istToday()}
                focus={focus}
                onFocus={setFocus}
              />
              <RotationHeadline figures={figures} benchmarkLabel={bench?.label ?? ''} />
              {verdictFor ? <RotationVerdict verdict={verdictFor} /> : null}
              <Card>
                <CardHeader
                  title="Cumulative gross by list"
                  description={`${s.n_days} scored forward sessions, 2 lots per strategy.${stopped ? ' With the portfolio stop applied.' : ''} Late entries and unscored days are left out.`}
                />
                <RotationHero
                  points={points}
                  focus={focus}
                  shown={visible}
                  onToggle={toggle}
                  showBase={showBase}
                  onToggleBase={() => setShowBase((v) => !v)}
                />
                {s.late_entries.length > 0 ? (
                  <p className="mt-3 text-xs text-warning">
                    Left out as late (recorded after 09:17, not forward):{' '}
                    {s.late_entries.join(', ')}.
                  </p>
                ) : null}
                {Object.keys(s.pending_reasons).length > 0 ? (
                  <ul className="mt-3 space-y-0.5 text-xs text-muted">
                    {Object.entries(s.pending_reasons).map(([day, why]) => (
                      <li key={day}>
                        <span className="font-mono">{day}</span> waiting: {why}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
              {overview.data ? (
                <Card>
                  <CardHeader
                    title={
                      overview.data.baskets.entry?.day === istToday()
                        ? "Today's baskets"
                        : 'Latest baskets'
                    }
                    description="What each list holds and what changed since the entry before."
                  />
                  <RotationBaskets
                    baskets={overview.data.baskets}
                    specs={overview.data.lists}
                    firstEntryDay={overview.data.first_entry_day}
                  />
                </Card>
              ) : null}
            </>
          )}
        </>
      ) : view === 'journal' ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">Journal</h2>
            <p className="mt-0.5 text-sm text-muted">
              What each list picked, what happened afterwards, and where the risk came from.
            </p>
          </div>
          <RotationDailyLog focus={focus} portfolio={portfolio} />
          <Accordion
            title="Risk review"
            description="Drawdowns and changes in the selected list"
            defaultOpen={false}
          >
            <RotationDrawdowns list={focus} portfolio={portfolio} />
            <RotationDrift list={focus} />
          </Accordion>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">Research</h2>
            <p className="mt-0.5 text-sm text-muted">
              Diagnostics for understanding the ranking and its forward behaviour. Open only the
              section you need.
            </p>
          </div>
          <Accordion
            title="Decision diagnostics"
            description="Why the next basket looks the way it does"
            defaultOpen
          >
            <RotationPulse focus={focus} />
            <RotationExplain list={focus} onList={setFocus} />
          </Accordion>
          <Accordion
            title="Market context"
            description="Forward days versus research periods"
            defaultOpen={false}
          >
            <RotationRegime />
          </Accordion>
          <Accordion
            title="Shadow experiments"
            description="Unregistered candidates and trigger studies"
            defaultOpen={false}
          >
            <RotationShadowScoreboard />
          </Accordion>
        </div>
      )}
    </div>
  );
}
