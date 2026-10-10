/**
 * Options Lab › Rotation › Daily log: the decision-to-result record.
 *
 * For each trading day, what the four registered lists picked at 09:16 and what those picks then
 * did on the day's data, beside the context the entry was scored on and what the owner placed.
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

import { useRotationLog } from '../../hooks/useRotationDailyLog';
import { cn } from '../../lib/cn';
import { formatDay, istToday } from '../../lib/format';
import {
  FILTER_HELP,
  FILTER_LABEL,
  LIST_KEYS,
  type Month,
  type RowFilter,
  WINDOW_LABEL,
  type WindowChoice,
  applyFilter,
  counterParts,
  defaultWindow,
  emptyHeadline,
  initialMonth,
  monthOf,
  windowRange,
} from '../../lib/rotationDailyLogView';
import type { RotationListKey, RotationLog, RotationLogSource } from '../../types/rotationDailyLog';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { Skeleton } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { DayForensics } from './DayForensics';
import { RotationDailyLogCalendar } from './RotationDailyLogCalendar';
import { RotationDailyLogDrawer } from './RotationDailyLogDrawer';
import { RotationDailyLogTable } from './RotationDailyLogTable';

const SOURCE_OPTIONS: SegmentedOption<RotationLogSource>[] = [
  { value: 'recorded', label: 'Recorded' },
  { value: 'reconstructed', label: 'Reconstructed' },
];

const FOCUS_OPTIONS: SegmentedOption<RotationListKey>[] = LIST_KEYS.map((value) => ({
  value,
  label: value,
}));

const FILTER_OPTIONS: SegmentedOption<RowFilter>[] = (
  ['all', 'losing', 'stops', 'differ'] as const
).map((value) => ({ value, label: FILTER_LABEL[value] }));

const WINDOW_OPTIONS: SegmentedOption<WindowChoice>[] = (['all', '126', '63', '21'] as const).map(
  (value) => ({ value, label: WINDOW_LABEL[value] }),
);

function EmptyJournal({ log, onBrowseHistory }: { log: RotationLog; onBrowseHistory: () => void }) {
  const can = log.reconstructable.available > 0;
  return (
    <div className="rounded-lg border border-dashed border-border px-6 py-8">
      <p className="text-base font-semibold text-foreground">{emptyHeadline(log)}</p>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Before {log.registered.cutoff_time} on each trading day the job writes down what every list
        picks, in a chain that cannot be edited afterwards. After that evening's results arrive,
        each day appears here with what its picks did. Until then there is nothing to show.
      </p>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-faint">
        The registered lists
      </p>
      <ul className="mt-1 space-y-1 text-sm">
        {log.registered.lists.map((l) => (
          <li key={l.key} className="flex gap-2">
            <span className="w-10 shrink-0 font-semibold text-foreground">{l.key}</span>
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

export function RotationDailyLog({ focus: focusProp }: { focus?: RotationListKey } = {}) {
  const today = useMemo(() => istToday(), []);
  const [source, setSource] = useState<RotationLogSource>('recorded');
  const [windowChoice, setWindowChoice] = useState<WindowChoice>(defaultWindow('recorded'));
  // The page's focus list when it passes one; otherwise this widget's own (A, the owner's default).
  const [ownFocus, setFocus] = useState<RotationListKey>('A');
  const focus = focusProp ?? ownFocus;
  const [filter, setFilter] = useState<RowFilter>('all');
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [month, setMonth] = useState<Month | null>(null);
  // One pick's day, replayed from its strategy file: shown above the calendar, drawer closed.
  const [replay, setReplay] = useState<{ variant: string; day: string } | null>(null);
  const replayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (replay) replayRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [replay]);

  const range = useMemo(
    () => windowRange(windowChoice, today, source),
    [windowChoice, today, source],
  );
  const res = useRotationLog(source, range);
  const log = res.data;

  function pickSource(next: RotationLogSource) {
    setSource(next);
    setWindowChoice(defaultWindow(next));
    setMonth(null);
    setFilter('all');
  }

  const rows = log?.rows ?? [];
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
          description="What each list picked at 09:16, and what those picks then did. Gross, per lot-day; the lists are alternative baskets and are never added together."
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
          {focusProp === undefined ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Shade by list</span>
              <SegmentedControl
                value={focus}
                options={FOCUS_OPTIONS}
                onChange={setFocus}
                ariaLabel="List the calendar is shaded by"
                size="sm"
              />
            </div>
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
          {res.error ? (
            <StateMessage
              variant="error"
              title="Showing the last data received"
              description={`The latest refresh failed: ${res.error}`}
            />
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
                  description={`Shaded by list ${focus}'s gross per lot-day. Click a day to open it.`}
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
                  description={
                    rows.length === filtered.length
                      ? `${rows.length} days, newest first.`
                      : `${filtered.length} of ${rows.length} days, newest first.`
                  }
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
          setReplay({ variant, day });
        }}
      />
    </div>
  );
}
