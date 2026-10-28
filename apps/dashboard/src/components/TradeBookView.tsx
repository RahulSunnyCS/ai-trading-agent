'use client';

/**
 * The Trade book (BL-168): the real P&L from the brokers' contract notes, on the Analytics page
 * pattern. Four views share one run bar — F&O (the owner's sheet: headline against a benchmark,
 * hero chart, the sheet's ratios, summary, months and FY, accounts, days), Trades (round trips by
 * source with their best and worst point), Money (ledger e-mails) and Momentum (the Zerodha
 * notes) — plus the day drawer and the inputs dialog. The view is the path
 * (`/tradebook/<fno|trades|money|momentum>`); year, account, benchmark and the open day are in
 * the query (`fy`, `acct`, `bench`, `day`). Every figure comes from
 * `/api/backtest/legwise/contract-notes/*` (`realised/` in the Python package); the page shapes
 * them in `lib/tradeBookView.ts` and computes none of the sheet's figures itself.
 */

import { AlertTriangle, NotebookText } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { useAppRoute } from '../hooks/useAppRoute';
import { navigateToLink, useQueryState } from '../hooks/useQueryState';
import { useTodayIst } from '../hooks/useTodayIst';
import {
  type TradeBookRange,
  useTradeBookDays,
  useTradeBookMonths,
  useTradeBookSummary,
  useTradeBookTrips,
} from '../hooks/useTradeBook';
import { formatDay, formatDayShort } from '../lib/format';
import { TRADE_BOOK_SECTIONS, type TradeBookSection, buildPath, oneOf } from '../lib/routes';
import {
  DEFAULT_BENCHMARK_KEY,
  accountLabel,
  benchmarkKey,
  fiscalYearOf,
  fyLabel,
  fyOptions,
  fyRange,
  headlineTiles,
  lastYearLine,
  parseBenchmark,
  parseFy,
  runningBook,
  sourcesByDay,
  targetLine,
  yearEarlier,
} from '../lib/tradeBookView';
import { TradeBookDayDrawer } from './tradebook/TradeBookDayDrawer';
import { TradeBookDays } from './tradebook/TradeBookDays';
import { TradeBookHeadline } from './tradebook/TradeBookHeadline';
import { TradeBookHero } from './tradebook/TradeBookHero';
import { TradeBookMomentum } from './tradebook/TradeBookMomentum';
import { TradeBookMoney } from './tradebook/TradeBookMoney';
import { TradeBookRatios } from './tradebook/TradeBookRatios';
import { TradeBookTrades } from './tradebook/TradeBookTrades';
import { TradeBookAccounts, TradeBookMonths } from './tradebook/TradeBookWidgets';
import { LoadError, TradeBookWidget } from './tradebook/parts';
import { Button } from './ui/Button';
import { CopyButton } from './ui/CopyButton';
import { RadioMenu } from './ui/RadioMenu';
import { RefreshButton } from './ui/RefreshButton';
import { SegmentedControl } from './ui/SegmentedControl';
import { Skeleton, SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';

const SECTION_LABELS: Record<TradeBookSection, string> = {
  fno: 'F&O',
  trades: 'Trades',
  money: 'Money',
  momentum: 'Momentum',
};

const ALL_TIME: TradeBookRange = { from: null, to: null };

export function TradeBookView() {
  const { rest } = useAppRoute();
  const section = oneOf(TRADE_BOOK_SECTIONS, rest[0]) ?? 'fno';
  const today = useTodayIst();
  const [fyParam, setFy] = useQueryState('fy');
  const [accountParam, setAccount] = useQueryState('acct');
  const [benchParam, setBench] = useQueryState('bench');
  const [day, setDay] = useQueryState('day');

  // The whole store (no range, no account): years, accounts, the newest note, open days.
  const book = useTradeBookSummary(ALL_TIME, null);
  const accounts = useMemo(() => (book.data?.accounts ?? []).map((a) => a.account), [book.data]);
  const account = accountParam && accounts.includes(accountParam) ? accountParam : null;
  const storeYears = (book.data?.fiscal_years ?? []).map((y) => y.fy);
  const years = fyOptions(storeYears, today);
  const newestWithData = storeYears.length ? parseFy(storeYears.at(-1)) : null;
  const fy = parseFy(fyParam) ?? newestWithData ?? fiscalYearOf(today);
  const range = useMemo(() => fyRange(fy), [fy]);

  const openSection = (next: TradeBookSection) =>
    navigateToLink(`${buildPath('tradebook', next)}${window.location.search}`);

  const share = typeof window === 'undefined' ? '' : window.location.href;
  const [refreshKey, setRefreshKey] = useState(0);
  const refetchBook = book.refetch;
  const refresh = useCallback(() => {
    refetchBook();
    setRefreshKey((k) => k + 1);
  }, [refetchBook]);
  // The year and account are chosen only once the store's years and accounts are known, so the
  // first load never reads (or draws) a fallback year or all accounts and then switches.
  const bookReady = book.data !== null || book.error !== null;
  // A view re-mounts for another year or account: it starts from that exact read's cache or
  // from nothing, never from the previous year's figures under the new label.
  const viewKey = `${refreshKey}|${fy}|${account ?? ''}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          ariaLabel="Trade book view"
          value={section}
          onChange={openSection}
          options={TRADE_BOOK_SECTIONS.map((s) => ({ value: s, label: SECTION_LABELS[s] }))}
        />
        <RadioMenu
          ariaLabel={`Year: ${fyLabel(fy)}. Change year`}
          prefix="Year"
          value={String(fy)}
          valueLabel={fyLabel(fy)}
          options={years.map((y) => ({ value: String(y), label: fyLabel(y) }))}
          onChange={(v) => setFy(v)}
        />
        {section !== 'momentum' ? (
          <RadioMenu
            ariaLabel="Accounts"
            prefix="Accounts"
            value={account ?? ''}
            valueLabel={
              account ? accountLabel(account, accounts) : `All ${accounts.length || ''}`.trim()
            }
            options={[
              { value: '', label: 'All accounts' },
              ...accounts.map((a) => ({ value: a, label: accountLabel(a, accounts) })),
            ]}
            onChange={(v) => setAccount(v || null)}
            footer="One account uses its own notes only: the day's algo fees are the whole book's and are left out."
          />
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {book.data?.last_note_day ? (
            <span className="hidden items-center gap-1.5 whitespace-nowrap rounded-full border border-border-strong px-2.5 py-1 text-xs text-muted sm:inline-flex">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-positive" />
              Notes in through {formatDayShort(book.data.last_note_day, { weekday: true })} ·{' '}
              {accounts.length} accounts
            </span>
          ) : null}
          <RefreshButton onClick={refresh} loading={book.loading} />
          <CopyButton text={share} label="Copy a link to this view" />
        </span>
      </div>

      {book.error && !book.data ? <LoadError error={book.error} retry={book.refetch} /> : null}
      <OpenDaysBanner
        openDays={book.data?.open_days ?? []}
        problems={book.data?.problems ?? []}
        onOpen={setDay}
      />

      {!bookReady ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-[440px] w-full rounded-xl" />
        </div>
      ) : section === 'fno' ? (
        <FnoView
          key={viewKey}
          fy={fy}
          range={range}
          account={account}
          accounts={accounts}
          storeYears={storeYears}
          newestWithData={newestWithData}
          benchParam={benchParam}
          onBench={setBench}
          onFy={(y) => setFy(String(y))}
          onOpenDay={setDay}
          selectedDay={day}
          today={today}
        />
      ) : section === 'trades' ? (
        <TradeBookTrades
          key={viewKey}
          range={range}
          account={account}
          allAccounts={accounts}
          onOpenDay={setDay}
          fileName={`trade-book-trips-${fy}`}
        />
      ) : section === 'money' ? (
        <MoneyView
          key={viewKey}
          range={range}
          account={account}
          accounts={accounts}
          onOpenDay={setDay}
        />
      ) : (
        <TradeBookMomentum key={viewKey} range={range} />
      )}

      <DrawerHost
        day={day}
        account={account}
        accounts={accounts}
        onDay={setDay}
        onSaved={() => {
          book.refetch();
          refresh();
        }}
      />
    </div>
  );
}

/** The drawer needs the open day's year for previous / next (the open-days banner and a
 * ledger row can open a day outside the picked year). */
function DrawerHost({
  day,
  account,
  accounts,
  onDay,
  onSaved,
}: {
  day: string | null;
  account: string | null;
  accounts: string[];
  onDay: (day: string | null) => void;
  onSaved: () => void;
}) {
  const range = useMemo(() => (day ? fyRange(fiscalYearOf(day)) : ALL_TIME), [day]);
  const days = useTradeBookDays(range, account, day !== null);
  const list = useMemo(() => (days.data?.days ?? []).map((d) => d.day), [days.data]);
  return (
    <TradeBookDayDrawer
      day={day}
      days={list}
      allAccounts={accounts}
      onDay={onDay}
      onSaved={() => {
        days.refetch();
        onSaved();
      }}
    />
  );
}

function OpenDaysBanner({
  openDays,
  problems,
  onOpen,
}: {
  openDays: string[];
  problems: string[];
  onOpen: (day: string) => void;
}) {
  if (!openDays.length && !problems.length) return null;
  return (
    <output className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      {openDays.length ? (
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground">
            {openDays.length === 1
              ? `A note for ${formatDay(openDays[0], { weekday: true })} failed to read.`
              : `Notes on ${openDays.length} days failed to read.`}
          </span>{' '}
          <span className="text-muted">
            The day stays open and every figure leaves that note out until it is read; the next run
            looks again.
          </span>
        </span>
      ) : null}
      {problems.length ? (
        <span className="min-w-0 flex-1 text-muted" title={problems.join('\n')}>
          {problems.length} damaged line{problems.length === 1 ? '' : 's'} in the store, left out.
        </span>
      ) : null}
      {openDays.length ? (
        <span className="flex flex-wrap gap-1.5">
          {openDays.slice(-3).map((d) => (
            <Button key={d} size="sm" variant="secondary" onClick={() => onOpen(d)}>
              Open {formatDayShort(d)}
            </Button>
          ))}
        </span>
      ) : null}
    </output>
  );
}

function FnoView({
  fy,
  range,
  account,
  accounts,
  storeYears,
  newestWithData,
  benchParam,
  onBench,
  onFy,
  onOpenDay,
  selectedDay,
  today,
}: {
  fy: number;
  range: TradeBookRange;
  account: string | null;
  accounts: string[];
  storeYears: string[];
  newestWithData: number | null;
  benchParam: string | null;
  onBench: (v: string | null) => void;
  onFy: (fy: number) => void;
  onOpenDay: (day: string) => void;
  selectedDay: string | null;
  today: string;
}) {
  const [painted, setPainted] = useState(false);
  const summary = useTradeBookSummary(range, account);
  const days = useTradeBookDays(range, account);
  // All time, so April and May get their 3-month average from the year before; the cells pick
  // the year's twelve by key.
  const months = useTradeBookMonths(ALL_TIME, account, painted);
  const allYears = useTradeBookSummary(ALL_TIME, account, painted);
  const trips = useTradeBookTrips(range, account, { enabled: painted });

  const benchmark = parseBenchmark(benchParam);
  const lastDay = summary.data?.summary.last_day ?? null;
  const prevLabel = fyLabel(fy - 1).slice(3);
  const lastYearAvailable = storeYears.includes(prevLabel);
  const wantLastYear = benchmark.id === 'lastfy' && lastYearAvailable && lastDay !== null;
  const prevRange: TradeBookRange = {
    from: fyRange(fy - 1).from,
    to: lastDay ? yearEarlier(lastDay) : null,
  };
  const prevSummary = useTradeBookSummary(prevRange, account, wantLastYear);
  const prevDays = useTradeBookDays(prevRange, account, wantLastYear);

  const rows = days.data?.days ?? [];
  const book = useMemo(() => runningBook(rows), [rows]);
  const prevBook = useMemo(() => runningBook(prevDays.data?.days ?? []), [prevDays.data]);
  const bench = useMemo(() => {
    const dayList = rows.map((r) => r.day);
    if (benchmark.id === 'lastfy') return wantLastYear ? lastYearLine(dayList, prevBook) : [];
    return targetLine(dayList, summary.data?.summary.capital ?? null, benchmark.ratePct);
  }, [rows, benchmark.id, benchmark.ratePct, wantLastYear, prevBook, summary.data]);
  const daySources = useMemo(
    () => (trips.data ? sourcesByDay(trips.data.trips) : null),
    [trips.data],
  );

  const loadError = summary.error ?? days.error;
  const retry = () => {
    summary.refetch();
    days.refetch();
  };
  if (!summary.data || !days.data) {
    if (loadError) return <LoadError error={loadError} retry={retry} />;
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-[440px] w-full rounded-xl" />
      </div>
    );
  }
  const s = summary.data.summary;
  if (s.sessions === 0) {
    return (
      <StateMessage
        variant="empty"
        icon={<NotebookText className="h-7 w-7" />}
        title={`${fyLabel(fy)}${account ? ` for ${accountLabel(account, accounts)}` : ''}: no notes yet`}
        description={
          <span className="inline-flex flex-col items-center gap-3">
            <span>
              {fyRange(fy).from > today
                ? `The year starts on ${formatDay(fyRange(fy).from)}.`
                : 'The first contract note of the year lands here the night after its first session.'}
            </span>
            {newestWithData !== null && newestWithData !== fy ? (
              <Button size="sm" variant="secondary" onClick={() => onFy(newestWithData)}>
                See {fyLabel(newestWithData)}
              </Button>
            ) : null}
          </span>
        }
      />
    );
  }
  const tiles = headlineTiles(
    s,
    benchmark,
    wantLastYear && prevSummary.data ? prevSummary.data.summary : null,
  );
  const benchLabel =
    benchmark.id === 'pace'
      ? `Target pace ${benchmark.ratePct}% a year`
      : wantLastYear
        ? `Last FY (${prevLabel}) on the same days`
        : null;

  return (
    <div className="space-y-4">
      {loadError ? <LoadError error={loadError} retry={retry} /> : null}
      <TradeBookHeadline
        summary={s}
        ratios={summary.data.ratios}
        tiles={tiles}
        benchmark={benchmark}
        onBenchmark={(b) =>
          onBench(benchmarkKey(b) === DEFAULT_BENCHMARK_KEY ? null : benchmarkKey(b))
        }
        lastYearAvailable={lastYearAvailable}
        lastYearLabel={prevLabel}
      />
      <section
        aria-label="Net to date"
        className="rounded-xl border border-border bg-surface px-4 pb-3 pt-3 shadow-card"
      >
        <TradeBookHero
          points={book}
          bench={bench}
          benchLabel={benchLabel}
          onPickDay={onOpenDay}
          onPainted={() => setPainted(true)}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <TradeBookWidget
          title="Ratios"
          badge="the sheet's formulas"
          description="Rolling over the last 50 or 100 sessions, the same columns as your sheet (T, U, V, W, Z), counted from the store's first day."
          ready={painted}
        >
          {() => <TradeBookRatios rows={rows} />}
        </TradeBookWidget>
        <TradeBookWidget
          title="Monthly returns"
          description="Your monthly tab: gain, % of the month's average capital, the 3-month average; the FY rows below."
          ready={painted}
        >
          {() =>
            months.data && allYears.data ? (
              <TradeBookMonths
                start={fy}
                months={months.data.months}
                years={allYears.data.fiscal_years}
                lastDay={lastDay}
                onPickYear={onFy}
              />
            ) : months.error || allYears.error ? (
              <LoadError
                error={months.error ?? allYears.error ?? ''}
                retry={() => {
                  months.refetch();
                  allYears.refetch();
                }}
              />
            ) : (
              <SkeletonRows rows={5} />
            )
          }
        </TradeBookWidget>
        <TradeBookWidget
          title="By account"
          badge={fyLabel(fy)}
          description="Each account's net, average capital and return; charges by kind below."
          ready={painted}
        >
          {() => (
            <TradeBookAccounts
              accounts={
                account
                  ? (summary.data?.accounts.filter((a) => a.account === account) ?? [])
                  : (summary.data?.accounts ?? [])
              }
              summary={s}
              allAccounts={accounts}
              showAlgoFees={account === null}
            />
          )}
        </TradeBookWidget>
        <TradeBookWidget
          title="Days"
          badge={`${rows.length} sessions`}
          description="One row per session, newest first; a failed note keeps its day open, and a day with no note says so, never a zero. A row opens the day."
          wide
          ready={painted}
        >
          {() => (
            <TradeBookDays
              rows={rows}
              book={book}
              sources={daySources}
              selected={selectedDay}
              onOpen={onOpenDay}
              fileName={`trade-book-days-${fy}`}
            />
          )}
        </TradeBookWidget>
      </div>
    </div>
  );
}

function MoneyView({
  range,
  account,
  accounts,
  onOpenDay,
}: {
  range: TradeBookRange;
  account: string | null;
  accounts: string[];
  onOpenDay: (day: string) => void;
}) {
  const summary = useTradeBookSummary(range, account);
  const days = useTradeBookDays(range, account);
  return (
    <div className="space-y-4">
      <TradeBookMoney
        range={range}
        account={account}
        allAccounts={accounts}
        summary={summary.data?.summary ?? null}
        rows={days.data?.days ?? []}
        onOpenDay={onOpenDay}
      />
    </div>
  );
}
