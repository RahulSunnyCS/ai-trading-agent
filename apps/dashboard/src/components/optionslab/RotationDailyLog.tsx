/**
 * Options Lab › Rotation › Daily log: the decision-to-result record.
 *
 * For each trading day, what the shown lists (VISIBLE_LIST_KEYS; the journal still records all four
 * registered lists) picked at 09:16 and what those picks then did on the day's data, beside the context the entry was scored on and what the owner placed.
 * A calendar to scan, a dense day table to read, a drawer for one day in full. Counters at the
 * foot say how often the structural things happened (a Buy qualified, the Widesl minimum applied,
 * the lists agreed, a stop fired).
 *
 * Gross basis; ₹ per lot-day is the unit lists are compared in (they hold 6 lots, or 8 with the
 * Buy add-on) and they are alternative baskets, never added together. A day with no figure shows
 * its reason. The filters are for browsing: a set selected by its outcome is biased, so no
 * total is shown for a filtered set.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { usePortfolioStop } from '../../hooks/usePortfolioStop';
import { useRotationLog } from '../../hooks/useRotationDailyLog';
import { useRotationPortfolioDays } from '../../hooks/useRotationPortfolio';
import { cn } from '../../lib/cn';
import { formatDay, formatInr, istToday } from '../../lib/format';
import {
  type PortfolioStopSetting,
  amountOf,
  isOn,
  sameTrail,
  trailParam,
} from '../../lib/portfolioStop';
import {
  FILTERS,
  FILTER_HELP,
  FILTER_LABEL,
  type Month,
  type RowFilter,
  WINDOW_LABEL,
  type WindowChoice,
  applyFilter,
  counterParts,
  defaultWindow,
  emptyHeadline,
  initialMonth,
  logMatches,
  monthOf,
  windowRange,
} from '../../lib/rotationDailyLogView';
import { DEFAULT_LIST, isVisibleList, listLabel, listName } from '../../lib/rotationListNames';
import { hasOverlay, overlayBook, unmatched } from '../../lib/rotationPortfolioView';
import type { RotationListKey, RotationLog, RotationLogSource } from '../../types/rotationDailyLog';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { Skeleton } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { DayForensics } from './DayForensics';
import { PortfolioReplay } from './PortfolioReplay';
import { PortfolioStopButton } from './PortfolioStopButton';
import { RotationDailyLogCalendar } from './RotationDailyLogCalendar';
import { RotationDailyLogDrawer } from './RotationDailyLogDrawer';
import { RotationDailyLogTable } from './RotationDailyLogTable';
import { ListPicker } from './rotation/ListPicker';

const SOURCE_OPTIONS: SegmentedOption<RotationLogSource>[] = [
  { value: 'recorded', label: 'Recorded' },
  { value: 'reconstructed', label: 'Reconstructed' },
];

const FILTER_OPTIONS: SegmentedOption<RowFilter>[] = FILTERS.map((value) => ({
  value,
  label: FILTER_LABEL[value],
}));

const WINDOW_OPTIONS: SegmentedOption<WindowChoice>[] = (['all', '126', '63', '21'] as const).map(
  (value) => ({ value, label: WINDOW_LABEL[value] }),
);

function EmptyJournal({ log, onBrowseHistory }: { log: RotationLog; onBrowseHistory: () => void }) {
  const can = log.reconstructable.available > 0;
  return (
    <div className="rounded-lg border border-dashed border-border px-6 py-8">
      <p className="text-base font-semibold text-foreground">{emptyHeadline(log)}</p>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Before {log.registered.cutoff_time} on each trading day the job writes down what the list
        picks, in a chain that cannot be edited afterwards. After that evening's results arrive,
        each day appears here with what its picks did. Until then there is nothing to show.
      </p>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-faint">
        The list followed
      </p>
      <ul className="mt-1 space-y-1 text-sm">
        {log.registered.lists
          .filter((l) => isVisibleList(l.key))
          .map((l) => (
            <li key={l.key} className="flex gap-2">
              <span className="w-20 shrink-0 font-semibold text-foreground">{listName(l.key)}</span>
              <span className="text-muted">{l.description}</span>
            </li>
          ))}
      </ul>
      <p className="mt-3 text-xs text-faint">
        Each holds {log.registered.lots_per_strategy} lots in each of 3 strategies, plus a Buy
        add-on when one ranks in the overall top 10.
      </p>
      {can ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={onBrowseHistory}>
            Browse the reconstructed history
          </Button>
          <span className="text-xs text-faint">
            {log.reconstructable.available} days, {formatDay(log.reconstructable.first)} to{' '}
            {formatDay(log.reconstructable.last)}: what the rule would have picked, labelled as
            such.
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function RotationDailyLog({
  focus: focusProp,
  portfolio,
}: {
  focus?: RotationListKey;
  /** The page's portfolio stop; used on its own, the widget keeps (and offers) its own. */
  portfolio?: PortfolioStopSetting;
} = {}) {
  const today = useMemo(() => istToday(), []);
  const [ownPortfolio, setOwnPortfolio] = usePortfolioStop();
  const setting = portfolio ?? ownPortfolio;
  const [source, setSource] = useState<RotationLogSource>('recorded');
  const [windowChoice, setWindowChoice] = useState<WindowChoice>(defaultWindow('recorded'));
  // The page's focus list when it passes one; otherwise this widget's own (the first shown list).
  const [ownFocus, setFocus] = useState<RotationListKey>(DEFAULT_LIST);
  const focus = focusProp ?? ownFocus;
  const [filter, setFilter] = useState<RowFilter>('all');
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [month, setMonth] = useState<Month | null>(null);
  // One pick's day, replayed from its strategy file: shown above the calendar, drawer closed.
  const [replay, setReplay] = useState<{ variant: string; day: string } | null>(null);
  const replayRef = useRef<HTMLDivElement>(null);
  // One list's whole basket for a day under the portfolio stop (BL-095).
  const [listReplay, setListReplay] = useState<{ list: RotationListKey; day: string } | null>(null);
  useEffect(() => {
    if (replay || listReplay)
      replayRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [replay, listReplay]);

  const range = useMemo(
    () => windowRange(windowChoice, today, source),
    [windowChoice, today, source],
  );
  const res = useRotationLog(source, range);
  // `usePolledResource` keeps the previous response while a new URL loads: only an answer to THIS
  // request is shown, so reconstructed rows never sit under a Recorded label or the reverse.
  const log = res.data !== null && logMatches(res.data, source, range) ? res.data : null;

  // The stopped figures (BL-095). Only an answer to THIS source and setting is laid over the log;
  // until it lands the log's own figures stay, and the note below says so.
  const book = useRotationPortfolioDays(source, range, setting);
  const bookNow =
    book.data !== null &&
    book.data.source === (source === 'reconstructed' ? 'reconstructed' : 'recorded') &&
    book.data.setting?.amount === amountOf(setting) &&
    sameTrail(book.data.setting?.trail, trailParam(setting)) &&
    Array.isArray(book.data.rows)
      ? book.data
      : null;
  const pending = isOn(setting) && bookNow === null && book.error === null;
  // Replay failures of the shown lists only: a hidden list's figure is never drawn.
  const replayErrors = (bookNow?.errors ?? []).filter((e) => isVisibleList(e.list));

  function pickSource(next: RotationLogSource) {
    setSource(next);
    setWindowChoice(defaultWindow(next));
    setMonth(null);
    setFilter('all');
  }

  const rows = useMemo(() => overlayBook(log?.rows ?? [], bookNow), [log, bookNow]);
  const shownMonth = month ?? initialMonth(rows, log?.today ?? today);
  const filtered = useMemo(() => applyFilter(rows, filter, focus), [rows, filter, focus]);
  const counters = log
    ? log.counters[source === 'reconstructed' ? 'reconstructed' : 'recorded']
    : null;
  const first = rows[0]?.day;
  const last = rows[rows.length - 1]?.day;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Daily log"
          description="What the list picked at 09:16, and what those picks then did. Gross, per lot-day."
          actions={<RefreshButton onClick={res.refetch} loading={res.loading} />}
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Show</span>
            <SegmentedControl
              value={source}
              options={SOURCE_OPTIONS}
              onChange={pickSource}
              ariaLabel="Recorded entries or reconstructed history"
              size="sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Window</span>
            <SegmentedControl
              value={windowChoice}
              options={WINDOW_OPTIONS}
              onChange={(v) => {
                setWindowChoice(v);
                setMonth(null);
              }}
              ariaLabel="Window"
              size="sm"
            />
          </div>
          {portfolio === undefined ? (
            <PortfolioStopButton setting={setting} onChange={setOwnPortfolio} />
          ) : null}
          {focusProp === undefined ? (
            <ListPicker
              value={focus}
              onChange={setFocus}
              ariaLabel="List the calendar is shaded by"
              label="Shade by list"
              format={listLabel}
            />
          ) : null}
          {log ? (
            <span
              className="ml-auto flex items-center gap-1.5 text-xs text-faint"
              title={
                log.chain.problems.join('\n') || 'Every entry verifies against the one before it.'
              }
            >
              <Badge tone={log.chain.intact ? 'positive' : 'negative'}>
                {log.chain.intact ? 'Journal intact' : 'Journal does not verify'}
              </Badge>
              {log.chain.entries} {log.chain.entries === 1 ? 'entry' : 'entries'}
              {log.chain.head ? ` · head ${log.chain.head}` : ''}
            </span>
          ) : null}
        </div>
      </Card>

      {res.error && !log ? (
        <div className="space-y-3">
          <StateMessage
            variant="error"
            title="Could not load the daily log"
            description={res.error}
          />
          <Button size="sm" onClick={res.refetch}>
            Retry
          </Button>
        </div>
      ) : !log ? (
        <output aria-busy="true" aria-label="Loading the daily log" className="block space-y-3">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-72 w-full" />
        </output>
      ) : (
        <>
          {log.placement_skipped_lines > 0 ? (
            <StateMessage
              variant="error"
              title="Part of the placement record could not be read"
              description={`${log.placement_skipped_lines} line${log.placement_skipped_lines === 1 ? '' : 's'} of rotation/placements.jsonl ${log.placement_skipped_lines === 1 ? 'is' : 'are'} not a valid row (torn or edited by hand) and ${log.placement_skipped_lines === 1 ? 'is' : 'are'} left out of the Placed column.`}
            />
          ) : null}
          {res.error ? (
            <StateMessage
              variant="error"
              title="Showing the last data received"
              description={`The latest refresh failed: ${res.error}`}
            />
          ) : null}
          {pending ? (
            <output className="block rounded-lg border border-border bg-surface-2/60 px-4 py-2.5 text-sm text-muted">
              Replaying the baskets under the portfolio stop. The log's own figures stay until it is
              done; the first time over the whole history takes a few minutes.
            </output>
          ) : null}
          {book.error && isOn(setting) && bookNow === null ? (
            <StateMessage
              variant="error"
              title="Could not replay the baskets under the portfolio stop"
              description={`${book.error}. The log's own figures are shown.`}
            />
          ) : null}
          {replayErrors.length > 0 ? (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-xs text-foreground">
              {replayErrors.length} list-day{replayErrors.length === 1 ? '' : 's'} could not be
              replayed (e.g. {replayErrors[0]?.day} {listLabel(replayErrors[0]?.list ?? '')}:{' '}
              {replayErrors[0]?.error}) and show the log's own figure.
            </div>
          ) : null}
          {bookNow && unmatched(bookNow) > 0 ? (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-xs text-foreground">
              {unmatched(bookNow)} list-day{unmatched(bookNow) === 1 ? '' : 's'} no longer replay to
              the logged figure (their bars were repaired after the nightly update) and keep the
              log's own figure, with no stopped one.
            </div>
          ) : null}
          {source === 'reconstructed' ? (
            <div className="rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-sm text-muted">
              <span className="font-medium text-foreground">Reconstructed, not recorded.</span>{' '}
              These days come from the research history, re-scored afterwards with only the results
              before each day. The weights were chosen on this history, so these rows describe the
              rule; they are not evidence that it works. Forward statistics count recorded days
              only.
              {log.reconstructable.error ? (
                <span className="block text-negative">
                  History could not be read: {log.reconstructable.error}
                </span>
              ) : null}
            </div>
          ) : null}

          {listReplay ? (
            <div ref={replayRef}>
              <PortfolioReplay
                key={`${listReplay.list}-${listReplay.day}`}
                day={listReplay.day}
                list={listReplay.list}
                source={source}
                setting={setting}
                onClose={() => setListReplay(null)}
              />
            </div>
          ) : null}

          {replay ? (
            <div ref={replayRef}>
              <DayForensics
                key={`${replay.variant}-${replay.day}`}
                strategy={replay.variant}
                day={replay.day}
                sha={undefined}
                rotationVariant
                onClose={() => setReplay(null)}
                fallback={
                  <p className="text-xs text-muted">
                    The replay needs this day's 1-minute bars on the machine running the API.
                  </p>
                }
              />
            </div>
          ) : null}

          {rows.length === 0 ? (
            log.journal_entries === 0 && source === 'recorded' ? (
              <EmptyJournal log={log} onBrowseHistory={() => pickSource('reconstructed')} />
            ) : (
              <StateMessage
                variant="empty"
                title="No days in this window"
                description={
                  source === 'reconstructed'
                    ? 'Widen the window to see more of the research history.'
                    : 'Widen the window, or wait for the next entry.'
                }
              />
            )
          ) : (
            <>
              <Card>
                <CardHeader
                  title="Calendar"
                  description={`Shaded by the ${listName(focus)} list's gross per lot-day. Click a day to open it.`}
                />
                <RotationDailyLogCalendar
                  month={shownMonth}
                  onMonth={setMonth}
                  rows={rows}
                  holidays={log.holidays}
                  focus={focus}
                  today={log.today}
                  selectedDay={openDay}
                  onOpen={setOpenDay}
                  firstMonth={first ? monthOf(first) : null}
                  lastMonth={last ? monthOf(last) : null}
                />
              </Card>

              <Card>
                <CardHeader
                  title="Days"
                  description={`${
                    rows.length === filtered.length
                      ? `${rows.length} days, newest first.`
                      : `${filtered.length} of ${rows.length} days, newest first.`
                  }${
                    hasOverlay(rows)
                      ? ` With a ${formatInr(amountOf(setting))} portfolio stop applied; the log's own figure is struck through where the stop fired. In-sample, gross.`
                      : ''
                  }`}
                  actions={
                    <SegmentedControl
                      value={filter}
                      options={FILTER_OPTIONS}
                      onChange={setFilter}
                      ariaLabel="Browse by"
                      size="sm"
                    />
                  }
                />
                <p className="-mt-2 mb-3 text-xs text-faint">
                  {FILTER_HELP[filter]} Filters are for browsing the days; a set chosen by its
                  outcome is biased, so read no average off it.
                </p>
                {filtered.length === 0 ? (
                  <StateMessage variant="empty" title="No day matches this filter" />
                ) : (
                  <RotationDailyLogTable
                    rows={filtered}
                    focus={focus}
                    selectedDay={openDay}
                    onOpen={setOpenDay}
                  />
                )}
                {counters ? (
                  <dl
                    className={cn(
                      'mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t border-border pt-3 text-xs',
                    )}
                    aria-label="Counters"
                  >
                    {counterParts(
                      counters,
                      source === 'reconstructed' ? 'reconstructed' : 'recorded',
                      log.rows,
                    ).map((p) => (
                      <div key={p.id} className="flex items-baseline gap-1.5" title={p.title}>
                        <dt className="text-faint">{p.label}</dt>
                        <dd className="metric text-foreground">{p.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </Card>
            </>
          )}
        </>
      )}

      <RotationDailyLogDrawer
        day={openDay}
        onClose={() => setOpenDay(null)}
        onChanged={res.refetch}
        onReplay={(variant, day) => {
          setOpenDay(null);
          setListReplay(null);
          setReplay({ variant, day });
        }}
        onReplayList={(list, day) => {
          setOpenDay(null);
          setReplay(null);
          setListReplay({ list, day });
        }}
      />
    </div>
  );
}
