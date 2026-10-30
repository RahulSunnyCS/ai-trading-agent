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
 * Gross only: the stored costs are zero. The Slippage switch (on by default, display only) reads
 * every paper figure with each entry and exit filled 0.5% against the trade; the picks are ranked
 * without it. Lists are alternative baskets and are never added up.
 * Rupee totals are at 1 lot a strategy (`lots=1`, display only: the per-lot figures, the verdict
 * and the journal's recorded 2 lots do not change). Adaptive Classic's portfolio stop is the one
 * every widget below follows; Adaptive Tuned and the Fixed base have their own, on their rows only.
 * The Show selector (owner, 2026-10-30; first on the bar, kept per browser in
 * `store/rotationBook.ts`) picks the book the page leads with: Adaptive Tuned (the default),
 * Adaptive Classic or the Fixed base. The hero chart, the Books table's order and focus row, the
 * Daily log and calendar (Tuned reads the T1 track's journal) and the order of the latest baskets
 * follow it. The diagnostics that exist only for Adaptive Classic stay on it and say so.
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
import { useRotationPlan } from '../../hooks/useRotationPlan';
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
import { SLIPPAGE_TEXT } from '../../lib/rotationSlippage';
import {
  BENCHMARKS,
  BENCHMARK_LABEL,
  BENCHMARK_NOTE,
  type RotationBenchmark,
  verdict as buildVerdict,
  heroSeries,
  lotsWord,
} from '../../lib/rotationView';
import { type RotationBookView, useRotationBook } from '../../store/rotationBook';
import { useRotationSlippage } from '../../store/rotationSlippage';
import type { RotationListKey } from '../../types/rotation';
import { Accordion } from '../ui/Accordion';
import { Button } from '../ui/Button';
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
import { PlanPickLine, RotationTomorrow, recordedSession } from './rotation/RotationPlan';
import { RotationReadoutChip } from './rotation/RotationReadout';
import { RotationVerdict } from './rotation/RotationVerdict';
import { SlippageSwitch } from './rotation/SlippageSwitch';

const BENCHMARK_OPTIONS: SegmentedOption<RotationBenchmark>[] = BENCHMARKS.map((value) => ({
  value,
  label: BENCHMARK_LABEL[value],
}));

/** The Show selector: which book the page leads with (Tuned first, the owner's primary). */
const VIEW_OPTIONS: SegmentedOption<RotationBookView>[] = [
  { value: 'tuned', label: ADAPTIVE_CARD.tuned.name },
  { value: 'core', label: ADAPTIVE_CARD.classic.name },
  { value: 'base', label: BASE_CARD.name },
];

/** The Tuned view's hero draws the T1 track's list C under Adaptive Tuned's name. */
const TUNED_SHOWN: ReadonlySet<RotationListKey> = new Set<RotationListKey>(['C']);
const NO_LISTS: ReadonlySet<RotationListKey> = new Set<RotationListKey>();
const tunedName = (k: RotationListKey): string =>
  k === 'C' ? ADAPTIVE_CARD.tuned.name : listName(k);
const noop = () => undefined;

/** The line on a diagnostic that reads Adaptive Classic only, when the page leads with another
 * book; null in the Classic view. */
function classicOnlyNote(view: RotationBookView): string | null {
  if (view === 'core') return null;
  return view === 'tuned'
    ? `${ADAPTIVE_CARD.classic.name} only: these reads have no ${ADAPTIVE_CARD.tuned.name} history yet.`
    : `${ADAPTIVE_CARD.classic.name} only: the fixed base has no picks for these reads to explain.`;
}

function ClassicOnlyNote({ view }: { view: RotationBookView }) {
  const note = classicOnlyNote(view);
  return note ? <p className="mb-3 text-xs text-muted">{note}</p> : null;
}

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
  // Each pick's settings and upload state, and the next session's tentative list.
  const planRes = useRotationPlan();
  const plan = planRes.data;
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
  // Display only: every paper figure below is read after 0.5% slippage while this is on.
  const slippage = useRotationSlippage();
  // Which book the page leads with (Adaptive Tuned by default).
  const [view, setView] = useRotationBook();

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
  // The Tuned view: the T1 track's list C (under its own stop) with the base over its days.
  const tunedPoints = useMemo(() => (tunedShown ? heroSeries(tunedShown, 'C') : []), [tunedShown]);
  // The Fixed base view: the base alone (under its own stop) over Classic's scored sessions.
  const basePoints = useMemo(
    () =>
      baseShown ? heroSeries(baseShown, 'C').map((p) => ({ ...p, lists: {}, band: null })) : [],
    [baseShown],
  );
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
    const books: BookLine[] = [
      {
        row: listBook('C', shown_s ?? null, s, benchmark),
        name: ADAPTIVE_CARD.classic.name,
        note: ADAPTIVE_CARD.classic.note,
        focus: view === 'core',
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
        focus: view === 'tuned',
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
        focus: view === 'base',
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
    // The book the page leads with comes first; the others keep their order.
    return [...books.filter((l) => l.focus), ...books.filter((l) => !l.focus)];
  }, [
    view,
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
    planRes.refetch();
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
  const coreSession = recordedSession(plan, entryDay);
  const tunedSession = recordedSession(plan, tunedBaskets?.entry?.day ?? null);
  const coreDetail =
    plan && coreSession
      ? (name: string) => <PlanPickLine plan={plan} session={coreSession} book="core" name={name} />
      : undefined;
  const tunedDetail =
    plan && tunedSession
      ? (name: string) => <PlanPickLine plan={plan} session={tunedSession} book="t1" name={name} />
      : undefined;

  // A const, so the baskets card's callbacks keep its narrowing.
  const ovData = overview.data;
  const slipText = slippage ? ` After ${SLIPPAGE_TEXT} slippage on every entry and exit.` : '';

  /** The late and waiting days a read-out leaves out, under its chart. */
  const leftOut = (r: NonNullable<typeof s>) => (
    <>
      {r.late_entries.length > 0 ? (
        <p className="mt-3 text-xs text-warning">
          Left out as late (recorded after 09:17, not forward): {r.late_entries.join(', ')}.
        </p>
      ) : null}
      {Object.keys(r.pending_reasons).length > 0 ? (
        <ul className="mt-3 space-y-0.5 text-xs text-muted">
          {Object.entries(r.pending_reasons).map(([day, why]) => (
            <li key={day}>
              <span className="font-mono">{day}</span> waiting: {why}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );

  /** The hero chart for the book the page leads with (called only once Classic's read-out has
   * scored days: the Fixed base is drawn over Classic's sessions). */
  const hero = () => {
    if (!s) return null;
    if (view === 'base') {
      return (
        <Card>
          <CardHeader
            title={`Cumulative gross, ${BASE_CARD.name}`}
            description={`${s.n_days} scored forward sessions (Adaptive Classic's), ${lotsWord(s.settings?.lots_per_strategy)} per strategy, 3 strategies a day, no ranking.${slipText}${baseShown !== s ? ' With its portfolio stop applied.' : ''}`}
          />
          <RotationHero
            points={basePoints}
            focus="C"
            shown={NO_LISTS}
            onToggle={noop}
            showBase
            onToggleBase={noop}
            baseOnly
          />
        </Card>
      );
    }
    if (view === 'tuned') {
      if (!t) {
        return tuned.error ? (
          <StateMessage
            variant="error"
            title={`Could not read ${ADAPTIVE_CARD.tuned.name}'s read-out`}
            description={tuned.error}
          />
        ) : (
          <SkeletonRows rows={4} />
        );
      }
      if (t.n_days === 0) {
        return (
          <Card className="py-4">
            <p className="text-sm font-semibold text-foreground">
              No scored {ADAPTIVE_CARD.tuned.name} session yet
            </p>
            <p className="mt-0.5 text-sm text-muted">
              {Object.values(t.pending_reasons)[0] ??
                'The first T1 entry is scored after the evening update.'}
            </p>
          </Card>
        );
      }
      return (
        <Card>
          <CardHeader
            title={`Cumulative gross, ${ADAPTIVE_CARD.tuned.name} and the fixed base`}
            description={`${t.n_days} scored forward sessions${t.first_day ? ` from ${formatDay(t.first_day)}` : ''}, ${lotsWord(t.settings?.lots_per_strategy)} per strategy.${slipText}${tunedShown !== t ? ' With its portfolio stop applied.' : ''} Late entries and unscored days are left out.`}
          />
          <RotationHero
            points={tunedPoints}
            focus="C"
            shown={TUNED_SHOWN}
            onToggle={noop}
            showBase={showBase}
            onToggleBase={() => setShowBase((v) => !v)}
            nameOf={tunedName}
          />
          {leftOut(t)}
        </Card>
      );
    }
    return (
      <Card>
        <CardHeader
          title={
            SEVERAL_LISTS_VISIBLE
              ? 'Cumulative gross by list'
              : `Cumulative gross, ${ADAPTIVE_CARD.classic.name} and the fixed base`
          }
          description={`${s.n_days} scored forward sessions, ${lotsWord(s.settings?.lots_per_strategy)} per strategy.${slipText}${stopped ? ' With the portfolio stop applied.' : ''} Late entries and unscored days are left out.`}
        />
        <RotationHero
          points={points}
          focus={focus}
          shown={visible}
          onToggle={toggle}
          showBase={showBase}
          onToggleBase={() => setShowBase((v) => !v)}
        />
        {leftOut(s)}
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          Show
          <SegmentedControl
            value={view}
            options={VIEW_OPTIONS}
            onChange={setView}
            ariaLabel="Book shown"
            size="sm"
          />
        </div>
        {view === 'core' ? (
          <ListPicker
            value={focus}
            onChange={setFocus}
            ariaLabel="Focus list"
            label="Focus"
            format={listWithUniverse}
            single="text"
          />
        ) : null}
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
        <SlippageSwitch />
        <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
          Forward · gross{slippage ? ` · ${SLIPPAGE_TEXT} slippage` : ''} · 1 lot per strategy
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
              {hero()}
            </>
          )}
          {ovData ? (
            <Card>
              <CardHeader
                title={
                  ovData.baskets.entry === null
                    ? 'Next entry'
                    : entryDay === istToday()
                      ? "Today's baskets"
                      : 'Latest baskets'
                }
                description={
                  ovData.baskets.entry === null
                    ? `${SEVERAL_LISTS_VISIBLE ? 'The lists' : 'The list'} to be recorded at 09:16, before the day's results are known.`
                    : entryDay === istToday()
                      ? "Recorded at 09:16, before the day's results were known; scored after the evening run. What each list holds and what changed since the entry before."
                      : `Recorded for ${formatDay(entryDay ?? '')}; the next entry is recorded at 09:16 on the next session. What each list holds and what changed since the entry before.`
                }
              />
              <div className="grid gap-6 lg:grid-cols-2">
                {/* the book the page leads with first; Tuned first in the Fixed base view too */}
                {(view === 'core' ? ['core', 'tuned'] : ['tuned', 'core']).map((b) =>
                  b === 'core' ? (
                    <RotationBaskets
                      key="core"
                      baskets={ovData.baskets}
                      specs={ovData.lists}
                      firstEntryDay={ovData.first_entry_day}
                      title={ADAPTIVE_CARD.classic.name}
                      {...(coreDetail ? { detail: coreDetail } : {})}
                    />
                  ) : tunedBaskets?.entry ? (
                    <RotationBaskets
                      key="tuned"
                      baskets={tunedBaskets}
                      specs={ovData.lists}
                      firstEntryDay={ovData.first_entry_day}
                      title={ADAPTIVE_CARD.tuned.name}
                      {...(tunedDetail ? { detail: tunedDetail } : {})}
                    />
                  ) : null,
                )}
              </div>
              {plan ? (
                <div className="mt-4">
                  <RotationTomorrow plan={plan} />
                </div>
              ) : null}
              {planRes.error ? (
                <p className="mt-3 text-xs text-negative">
                  Where the picks are uploaded could not be read: {planRes.error}
                </p>
              ) : null}
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
        {view === 'tuned' ? (
          <RotationDailyLog
            key="t1"
            focus="C"
            portfolio={tunedStop}
            track="t1"
            bookName={ADAPTIVE_CARD.tuned.name}
          />
        ) : view === 'core' ? (
          <RotationDailyLog key="core" focus={focus} portfolio={portfolio} />
        ) : (
          <Card className="py-4">
            <p className="text-sm text-muted">
              The fixed base has no daily picks to log: it holds the same three strategies every
              day. Its figures are in the Books table and the chart above.
            </p>
            <div className="mt-3">
              <Button size="sm" onClick={() => setView('tuned')}>
                Show {ADAPTIVE_CARD.tuned.name}
              </Button>
            </div>
          </Card>
        )}
        <Accordion
          title="Drawdowns and selection drift"
          description="How deep the falls were, and what the list has been holding"
          defaultOpen={false}
        >
          <ClassicOnlyNote view={view} />
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
          <ClassicOnlyNote view={view} />
          <RotationPulse focus={focus} />
          <RotationExplain list={focus} onList={setFocus} />
        </Accordion>
        <Accordion
          title="What market did the forward days test?"
          description="Forward days versus the research periods"
          defaultOpen={false}
        >
          <ClassicOnlyNote view={view} />
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
          <ClassicOnlyNote view={view} />
          <RotationShadowScoreboard />
        </Accordion>
      </section>
    </div>
  );
}
