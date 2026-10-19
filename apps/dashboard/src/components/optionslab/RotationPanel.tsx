/**
 * Options Lab → Rotation: how the followed list is doing on days nobody had seen, against the
 * owner's fixed base and random baskets, and whether today's data can be trusted (BL-058 Phase 4).
 * The page shows the lists in `VISIBLE_LIST_KEYS`; the journal still records all four registered
 * lists (Steady A, Calendar B, Adaptive C, Baseline REF).
 *
 * One page, in reading order (BL-102): the list cards, health/read-out, the headline, chart and
 * current baskets once a forward session has been scored; then What happened (the day log),
 * Is the rule still working? and Experiments. The diagnostics sit in closed accordions that mount
 * their widget only when opened, so the page stays light. The bands do not wait for the read-out:
 * the day log loads alongside it.
 *
 * Gross only: the stored costs are zero. Lists are alternative baskets and are never added up.
 * Rupee totals are at 1 lot a strategy (`lots=1`, display only: the per-lot figures, the verdict
 * and the journal's recorded 2 lots do not change). Two cards: Adaptive Classic (the live journal,
 * Core-298) with its portfolio stop, which every widget below follows, and Adaptive Tuned (the T1
 * track's journal) with its own. Nothing on this page changes a list, a weight or the journal.
 */

import { useMemo, useState } from 'react';

import { usePortfolioStop } from '../../hooks/usePortfolioStop';
import {
  ROTATION_PAGE_LOTS,
  type RotationReadOptions,
  useRotationOverview,
  useRotationSummary,
} from '../../hooks/useRotation';
import { useRotationPortfolioDays } from '../../hooks/useRotationPortfolio';
import { formatDay, formatIstTime, istToday } from '../../lib/format';
import {
  DEFAULT_SETTING,
  DEFAULT_T1_SETTING,
  type PortfolioStopSetting,
  T1_STOP_KEYS,
} from '../../lib/portfolioStop';
import { tunedCard } from '../../lib/rotationListCards';
import {
  ADAPTIVE_CARD,
  DEFAULT_LIST,
  SEVERAL_LISTS_VISIBLE,
  listName,
  listWithUniverse,
} from '../../lib/rotationListNames';
import { bookFor, overlaySummary, stopNote, unmatched } from '../../lib/rotationPortfolioView';
import {
  BENCHMARKS,
  BENCHMARK_LABEL,
  BENCHMARK_NOTE,
  type RotationBenchmark,
  benchmarkFigures,
  verdict as buildVerdict,
  headline,
  heroSeries,
  lotsWord,
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
import { RotationLotPlans } from './RotationLotPlans';
import { RotationPulse } from './RotationPulse';
import { RotationRegime } from './RotationRegime';
import { RotationShadowScoreboard } from './RotationShadowScoreboard';
import { EveningRunBar } from './results/EveningRunBar';
import { ListPicker } from './rotation/ListPicker';
import { RotationBaskets } from './rotation/RotationBaskets';
import { RotationHeadline } from './rotation/RotationHeadline';
import { RotationHealthStrip } from './rotation/RotationHealth';
import { RotationHero } from './rotation/RotationHero';
import { RotationListCards } from './rotation/RotationListCards';
import { RotationReadoutBanner } from './rotation/RotationReadout';
import { RotationVerdict } from './rotation/RotationVerdict';

const BENCHMARK_OPTIONS: SegmentedOption<RotationBenchmark>[] = BENCHMARKS.map((value) => ({
  value,
  label: BENCHMARK_LABEL[value],
}));

/** The owner trades one lot a pick (2026-10-19): every rupee total on the page is at 1 lot. */
const ONE_LOT: RotationReadOptions = { lots: ROTATION_PAGE_LOTS };
/** Adaptive Tuned: the T1 track's journal, at 1 lot. */
const TUNED: RotationReadOptions = { lots: ROTATION_PAGE_LOTS, track: 't1' };

/** A card's portfolio stop: its button and the line saying what the replay did. */
function CardStop({
  setting,
  onChange,
  defaults,
  title,
  note,
}: {
  setting: PortfolioStopSetting;
  onChange: (next: PortfolioStopSetting) => void;
  defaults: PortfolioStopSetting;
  title: string;
  note: string | null;
}) {
  return (
    <>
      <PortfolioStopButton
        setting={setting}
        onChange={onChange}
        defaults={defaults}
        dialogTitle={`Portfolio stop · ${title}`}
      />
      {note ? (
        <p className="text-[11px] text-muted" aria-live="polite">
          {note}
        </p>
      ) : null}
    </>
  );
}

export function RotationPanel() {
  const overview = useRotationOverview();
  const summary = useRotationSummary(ONE_LOT);
  const tuned = useRotationSummary(TUNED);
  const [focus, setFocus] = useState<RotationListKey>(DEFAULT_LIST);
  const [benchmark, setBenchmark] = useState<RotationBenchmark>('base');
  const [shown, setShown] = useState<ReadonlySet<RotationListKey>>(new Set([DEFAULT_LIST]));
  const [showBase, setShowBase] = useState(true);
  // BL-095: Adaptive Classic's portfolio stop, which every widget below that shows stopped
  // figures follows; Adaptive Tuned has its own (own URL keys, own storage, ₹9,000 default).
  const [portfolio, setPortfolio] = usePortfolioStop();
  const [tunedStop, setTunedStop] = usePortfolioStop(T1_STOP_KEYS);

  const readoutDays = overview.data?.readout_days ?? 60;
  const s = summary.data;

  // BL-095: the forward sessions replayed under the portfolio stop. Only an answer for this
  // setting is laid over the read-out; the verdict, the intervals and the random baskets always
  // stay on the registered basis (the pre-registered test does not move with a typed level).
  const book = useRotationPortfolioDays('recorded', {}, portfolio, ONE_LOT);
  const bookNow = bookFor(book.data, portfolio);
  const shown_s = useMemo(() => (s ? overlaySummary(s, bookNow) : s), [s, bookNow]);
  const stopped = shown_s !== s;
  const skipped = unmatched(bookNow);

  // Adaptive Tuned (the T1 track): its own read-out and its own stop, on its card only.
  const t = tuned.data;
  const tunedBook = useRotationPortfolioDays('recorded', {}, tunedStop, TUNED);
  const tunedBookNow = bookFor(tunedBook.data, tunedStop);
  const tunedShown = useMemo(() => (t ? overlaySummary(t, tunedBookNow) : t), [t, tunedBookNow]);
  const tunedNote = stopNote({
    setting: tunedStop,
    scoredDays: t?.n_days ?? 0,
    stopped: tunedShown !== t,
    error: tunedBook.error,
    skipped: unmatched(tunedBookNow),
  });

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
    tuned.refetch();
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
        <ListPicker
          value={focus}
          onChange={setFocus}
          ariaLabel="Focus list"
          label="Focus"
          format={listWithUniverse}
          single="text"
        />
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
          Forward · gross · 1 lot per strategy
        </span>
        <span className="flex-1" />
        <RefreshButton
          onClick={reload}
          loading={overview.loading || summary.loading}
          label="Reload"
        />
      </div>
      <p className="text-xs text-faint">{BENCHMARK_NOTE[benchmark]}</p>

      <EveningRunBar underlying={null} onFinished={reload} />

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
      ) : (
        <>
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
                        ? `${SEVERAL_LISTS_VISIBLE ? 'The lists' : 'The list'} to be recorded at 09:16, before the day's results are known.`
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
                action={
                  <CardStop
                    setting={portfolio}
                    onChange={setPortfolio}
                    defaults={DEFAULT_SETTING}
                    title={ADAPTIVE_CARD.classic.name}
                    note={stopNote({
                      setting: portfolio,
                      scoredDays: s.n_days,
                      stopped,
                      error: book.error,
                      skipped,
                    })}
                  />
                }
                extra={[
                  {
                    card: tunedCard(tunedShown),
                    basket: t?.baskets?.lists.C,
                    entryDay: t?.baskets?.entry?.day ?? null,
                    action: (
                      <>
                        <CardStop
                          setting={tunedStop}
                          onChange={setTunedStop}
                          defaults={DEFAULT_T1_SETTING}
                          title={ADAPTIVE_CARD.tuned.name}
                          note={tunedNote}
                        />
                        {tuned.error ? (
                          <p className="text-[11px] text-negative">
                            The T1 read-out could not be read: {tuned.error}
                          </p>
                        ) : t && t.n_days === 0 ? (
                          <p className="text-[11px] text-muted">
                            {Object.values(t.pending_reasons)[0] ??
                              'No scored forward session yet: the first T1 entry is scored after the evening update.'}
                          </p>
                        ) : null}
                      </>
                    ),
                  },
                ]}
              />
              <RotationHeadline figures={figures} benchmarkLabel={bench?.label ?? ''} />
              {verdictFor ? <RotationVerdict verdict={verdictFor} /> : null}
              <Card>
                <CardHeader
                  title={
                    SEVERAL_LISTS_VISIBLE
                      ? 'Cumulative gross by list'
                      : `Cumulative gross, ${listName(focus)} and the fixed base`
                  }
                  description={`${s.n_days} scored forward sessions, ${lotsWord(s.settings?.lots_per_strategy)} per strategy.${stopped ? ' With the portfolio stop applied.' : ''} Late entries and unscored days are left out.`}
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
                    description="What the list holds and what changed since the entry before."
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
      )}

      <section aria-labelledby="band-happened" className="space-y-3">
        <header>
          <h2 id="band-happened" className="text-base font-semibold tracking-tight text-foreground">
            What happened
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            What the list picked, what happened afterwards, and where the risk came from.
          </p>
        </header>
        <RotationDailyLog focus={focus} portfolio={portfolio} />
        <Accordion
          title="Drawdowns and selection drift"
          description="How deep the falls were, and what the list has been holding"
          defaultOpen={false}
        >
          <RotationDrawdowns list={focus} portfolio={portfolio} />
          <RotationDrift list={focus} />
        </Accordion>
      </section>

      <section aria-labelledby="band-lot-plans" className="space-y-3">
        <header>
          <h2
            id="band-lot-plans"
            className="text-base font-semibold tracking-tight text-foreground"
          >
            Lot plans
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            The same morning picks traded three ways, tracked forward for the live book and T1.
          </p>
        </header>
        <RotationLotPlans />
      </section>

      <section aria-labelledby="band-working" className="space-y-3">
        <header>
          <h2 id="band-working" className="text-base font-semibold tracking-tight text-foreground">
            Is the rule still working?
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Diagnostics for the ranking and its forward behaviour. Open only what you need; each
            loads when opened.
          </p>
        </header>
        <Accordion
          title="Why these picks, and is morning short-premium working?"
          description="The family pulse, a pick criterion by criterion, and rank correlation"
          defaultOpen={false}
        >
          <RotationPulse focus={focus} />
          <RotationExplain list={focus} onList={setFocus} />
        </Accordion>
        <Accordion
          title="What market did the forward days test?"
          description="Forward days versus the research periods"
          defaultOpen={false}
        >
          <RotationRegime />
        </Accordion>
      </section>

      <section aria-labelledby="band-experiments" className="space-y-3">
        <h2
          id="band-experiments"
          className="text-base font-semibold tracking-tight text-foreground"
        >
          Experiments
        </h2>
        <Accordion
          title="Ideas being watched"
          description="Unregistered candidates and trigger studies, each against what it replaced"
          defaultOpen={false}
        >
          <RotationShadowScoreboard />
        </Accordion>
      </section>
    </div>
  );
}
