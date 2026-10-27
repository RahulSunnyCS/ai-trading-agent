/**
 * Options Lab → Rotation: how the followed list is doing on days nobody had seen, against the
 * owner's fixed base and random baskets, and whether today's data can be trusted (BL-058 Phase 4).
 * The page shows the lists in `VISIBLE_LIST_KEYS`; the journal still records all four registered
 * lists (Steady A, Calendar B, Adaptive C, Baseline REF).
 *
 * One page, in reading order. The first screen (dashboard review, 2026-10-28) is the run bar (focus,
 * benchmark, the read-out's day count, the evening run), the data health line, the Books table
 * (Adaptive Classic, Adaptive Tuned and the Fixed base, each with its own portfolio stop, and the
 * registered verdict under it) and the cumulative chart; then the latest baskets, What happened
 * (the day log, with the live result per day), Live vs paper, Is the rule still working? and
 * Experiments (Lot plans and the ideas being watched). The
 * diagnostics sit in closed accordions that mount their widget only when opened.
 *
 * Gross only: the stored costs are zero. Lists are alternative baskets and are never added up.
 * Rupee totals are at 1 lot a strategy (`lots=1`, display only: the per-lot figures, the verdict
 * and the journal's recorded 2 lots do not change). Adaptive Classic's portfolio stop is the one
 * every widget below follows; Adaptive Tuned and the Fixed base have their own, on their rows only.
 * Nothing on this page changes a list, a weight or the journal.
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
  BASE_STOP_KEYS,
  DEFAULT_BASE_SETTING,
  DEFAULT_SETTING,
  DEFAULT_T1_SETTING,
  T1_STOP_KEYS,
} from '../../lib/portfolioStop';
import { baseBook, listBook, vsHeader } from '../../lib/rotationBooks';
import {
  ADAPTIVE_CARD,
  BASE_CARD,
  DEFAULT_LIST,
  SEVERAL_LISTS_VISIBLE,
  listName,
  listWithUniverse,
} from '../../lib/rotationListNames';
import {
  bookFor,
  overlayBase,
  overlaySummary,
  stopEffect,
  stopNote,
  unmatched,
} from '../../lib/rotationPortfolioView';
import {
  BENCHMARKS,
  BENCHMARK_LABEL,
  BENCHMARK_NOTE,
  type RotationBenchmark,
  verdict as buildVerdict,
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
import { RotationDailyLog } from './RotationDailyLog';
import { RotationDrawdowns } from './RotationDrawdowns';
import { RotationDrift } from './RotationDrift';
import { RotationExplain } from './RotationExplain';
import { RotationLiveVsPaper } from './RotationLiveVsPaper';
import { RotationLotPlans } from './RotationLotPlans';
import { RotationPulse } from './RotationPulse';
import { RotationRegime } from './RotationRegime';
import { RotationShadowScoreboard } from './RotationShadowScoreboard';
import { EveningRunBar } from './results/EveningRunBar';
import { ListPicker } from './rotation/ListPicker';
import { RotationBaskets } from './rotation/RotationBaskets';
import { type BookLine, RotationBooks } from './rotation/RotationBooks';
import { RotationHealthStrip } from './rotation/RotationHealth';
import { RotationHero } from './rotation/RotationHero';
import { RotationReadoutChip } from './rotation/RotationReadout';
import { RotationVerdict } from './rotation/RotationVerdict';

const BENCHMARK_OPTIONS: SegmentedOption<RotationBenchmark>[] = BENCHMARKS.map((value) => ({
  value,
  label: BENCHMARK_LABEL[value],
}));

/** The owner trades one lot a pick (2026-10-19): every rupee total on the page is at 1 lot. */
const ONE_LOT: RotationReadOptions = { lots: ROTATION_PAGE_LOTS };
/** Adaptive Tuned: the T1 track's journal, at 1 lot. */
const TUNED: RotationReadOptions = { lots: ROTATION_PAGE_LOTS, track: 't1' };
/** The Fixed base as a book under its own stop, at 1 lot a strategy (2 Widesl + 1 Dir). */
const BASE_BOOK = { lots: ROTATION_PAGE_LOTS, book: 'base' } as const;

/**
 * A row's short stop line, only while the replay is running or failed: the full sentence goes in
 * its tooltip, and what a stop does is explained once, in the dialog.
 */
function stopStatus(
  note: string | null,
  stopped: boolean,
  error: string | null,
): { text: string; detail: string } | null {
  if (stopped || note === null) return null;
  return { text: error ? 'replay failed' : 'replaying…', detail: note };
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
  const [baseStop, setBaseStop] = usePortfolioStop(BASE_STOP_KEYS);

  const readoutDays = overview.data?.readout_days ?? 60;
  const s = summary.data;

  // BL-095: the forward sessions replayed under the portfolio stop. Only an answer for this
  // setting is laid over the read-out; the verdict, the intervals and the random baskets always
  // stay on the registered basis (the pre-registered test does not move with a typed level).
  const book = useRotationPortfolioDays('recorded', {}, portfolio, ONE_LOT);
  const bookNow = bookFor(book.data, portfolio);
  const shown_s = useMemo(() => (s ? overlaySummary(s, bookNow) : s), [s, bookNow]);
  const stopped = shown_s !== s;

  // Adaptive Tuned (the T1 track): its own read-out and its own stop, on its row only.
  const t = tuned.data;
  const tunedBook = useRotationPortfolioDays('recorded', {}, tunedStop, TUNED);
  const tunedBookNow = bookFor(tunedBook.data, tunedStop);
  const tunedShown = useMemo(() => (t ? overlaySummary(t, tunedBookNow) : t), [t, tunedBookNow]);

  // The Fixed base: the read-out's own base over Classic's sessions, under its own stop (its row
  // only; the comparisons with the base always use the base without a stop).
  const baseBookRes = useRotationPortfolioDays('recorded', {}, baseStop, BASE_BOOK);
  const baseBookNow = bookFor(baseBookRes.data, baseStop);
  const baseShown = useMemo(() => (s ? overlayBase(s, baseBookNow) : s), [s, baseBookNow]);

  // What each stop changed, over that book's own scored days.
  const classicDays = useMemo(() => (s?.days ?? []).map((d) => d.day), [s]);
  const tunedDays = useMemo(() => (t?.days ?? []).map((d) => d.day), [t]);
  const classicEffect = useMemo(
    () => stopEffect(bookNow, 'C', classicDays),
    [bookNow, classicDays],
  );
  const tunedEffect = useMemo(
    () => stopEffect(tunedBookNow, 'C', tunedDays),
    [tunedBookNow, tunedDays],
  );
  const baseEffect = useMemo(
    () => stopEffect(baseBookNow, 'BASE', classicDays),
    [baseBookNow, classicDays],
  );

  const visible = useMemo(() => new Set<RotationListKey>([...shown, focus]), [shown, focus]);
  const points = useMemo(() => (shown_s ? heroSeries(shown_s, focus) : []), [shown_s, focus]);
  const verdictFor = useMemo(() => (s ? buildVerdict(s, focus) : null), [s, focus]);

  const lines = useMemo((): BookLine[] => {
    if (!s) return [];
    const tunedMessage = tuned.error
      ? { text: `The T1 read-out could not be read: ${tuned.error}`, error: true }
      : !t
        ? { text: 'Reading the T1 read-out…', error: false }
        : t.n_days === 0
          ? {
              text:
                Object.values(t.pending_reasons)[0] ??
                'No scored forward session yet: the first T1 entry is scored after the evening update.',
              error: false,
            }
          : null;
    return [
      {
        row: listBook('C', shown_s ?? null, s, benchmark),
        name: ADAPTIVE_CARD.classic.name,
        note: ADAPTIVE_CARD.classic.note,
        focus: true,
        stop: {
          setting: portfolio,
          onChange: setPortfolio,
          defaults: DEFAULT_SETTING,
          title: `Portfolio stop · ${ADAPTIVE_CARD.classic.name}`,
          effect: classicEffect,
          status: stopStatus(
            stopNote({
              setting: portfolio,
              scoredDays: s.n_days,
              stopped,
              error: book.error,
              skipped: unmatched(bookNow),
            }),
            stopped,
            book.error,
          ),
        },
      },
      {
        row: listBook('T1', tunedShown ?? null, t ?? null, benchmark),
        name: ADAPTIVE_CARD.tuned.name,
        note: ADAPTIVE_CARD.tuned.note,
        focus: false,
        message: tunedMessage,
        stop: {
          setting: tunedStop,
          onChange: setTunedStop,
          defaults: DEFAULT_T1_SETTING,
          title: `Portfolio stop · ${ADAPTIVE_CARD.tuned.name}`,
          effect: tunedEffect,
          status: stopStatus(
            stopNote({
              setting: tunedStop,
              scoredDays: t?.n_days ?? 0,
              stopped: tunedShown !== t,
              error: tunedBook.error,
              skipped: unmatched(tunedBookNow),
            }),
            tunedShown !== t,
            tunedBook.error,
          ),
        },
      },
      {
        row: baseBook(baseShown ?? null),
        name: BASE_CARD.name,
        note: BASE_CARD.note,
        focus: false,
        stop: {
          setting: baseStop,
          onChange: setBaseStop,
          defaults: DEFAULT_BASE_SETTING,
          title: `Portfolio stop · ${BASE_CARD.name}`,
          effect: baseEffect,
          status: stopStatus(
            stopNote({
              setting: baseStop,
              scoredDays: s.n_days,
              stopped: baseShown !== s,
              error: baseBookRes.error,
              skipped: unmatched(baseBookNow, ['BASE']),
            }),
            baseShown !== s,
            baseBookRes.error,
          ),
        },
      },
    ];
  }, [
    s,
    t,
    shown_s,
    tunedShown,
    baseShown,
    benchmark,
    tuned.error,
    portfolio,
    setPortfolio,
    tunedStop,
    setTunedStop,
    baseStop,
    setBaseStop,
    classicEffect,
    tunedEffect,
    baseEffect,
    stopped,
    book.error,
    bookNow,
    tunedBook.error,
    tunedBookNow,
    baseBookRes.error,
    baseBookNow,
  ]);

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

  const entryDay = overview.data?.baskets.entry?.day ?? null;
  const tunedBaskets = t?.baskets;

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
        <RotationReadoutChip
          scoredDays={s ? s.n_days : null}
          total={readoutDays}
          firstDay={s?.first_day ?? null}
          lastDay={s?.last_day ?? null}
          firstEntryDay={overview.data?.first_entry_day ?? null}
        />
        <span className="flex-1" />
        <EveningRunBar underlying={null} onFinished={reload} compact />
        <RefreshButton
          onClick={reload}
          loading={overview.loading || summary.loading}
          label="Reload"
        />
      </div>
      <p className="text-xs text-faint">{BENCHMARK_NOTE[benchmark]}</p>

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
        <RotationHealthStrip health={overview.data.health} />
      ) : (
        <SkeletonRows rows={1} />
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
          ) : (
            <>
              <RotationBooks
                lines={lines}
                vsHeader={vsHeader(benchmark)}
                footer={verdictFor ? <RotationVerdict verdict={verdictFor} plain /> : null}
              />
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
            </>
          )}
          {overview.data ? (
            <Card>
              <CardHeader
                title={
                  overview.data.baskets.entry === null
                    ? 'Next entry'
                    : entryDay === istToday()
                      ? "Today's baskets"
                      : 'Latest baskets'
                }
                description={
                  overview.data.baskets.entry === null
                    ? `${SEVERAL_LISTS_VISIBLE ? 'The lists' : 'The list'} to be recorded at 09:16, before the day's results are known.`
                    : entryDay === istToday()
                      ? "Recorded at 09:16, before the day's results were known; scored after the evening run. What each list holds and what changed since the entry before."
                      : `Recorded for ${formatDay(entryDay ?? '')}; the next entry is recorded at 09:16 on the next session. What each list holds and what changed since the entry before.`
                }
              />
              <div className="grid gap-6 lg:grid-cols-2">
                <RotationBaskets
                  baskets={overview.data.baskets}
                  specs={overview.data.lists}
                  firstEntryDay={overview.data.first_entry_day}
                  title={ADAPTIVE_CARD.classic.name}
                />
                {tunedBaskets?.entry ? (
                  <RotationBaskets
                    baskets={tunedBaskets}
                    specs={overview.data.lists}
                    firstEntryDay={overview.data.first_entry_day}
                    title={ADAPTIVE_CARD.tuned.name}
                  />
                ) : null}
              </div>
            </Card>
          ) : null}
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

      <section aria-labelledby="band-live-vs-paper" className="space-y-3">
        <header>
          <h2
            id="band-live-vs-paper"
            className="text-base font-semibold tracking-tight text-foreground"
          >
            Live vs paper
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            What AlgoTest and Quantiply actually made, against the backtest for the same picks.
          </p>
        </header>
        <RotationLiveVsPaper />
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
          title="Lot plans · from 19 Oct"
          description="The same morning picks traded three ways (As picked, Dir Boost, Duo), for Core and T1, judged at 60 forward days"
          defaultOpen={false}
        >
          <RotationLotPlans />
        </Accordion>
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
