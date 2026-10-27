/**
 * The daily log's table: one 32 px line a day, newest first. Per list the gross per lot-day (the
 * unit lists are compared in; the day's total for the list's lots is in the tooltip). A day with
 * no figure shows why. Clicking a line opens the day.
 *
 * "Live − paper" (dashboard review, 2026-10-28; it replaced the hand-marked Placed dots, which were
 * never used): the 15:40 live capture against paper for the focus book, per lot-day, both after the
 * same estimated costs (`liveForLog`). A day before the capture, waiting or not captured says so.
 */

import { useMemo, useState } from 'react';

import { cn } from '../../lib/cn';
import { EMPTY, formatDay, formatInr, formatNumber } from '../../lib/format';
import {
  LIST_KEYS,
  type RowFlag,
  STATUS_LABEL,
  STATUS_TONE,
  rowFlags,
} from '../../lib/rotationDailyLogView';
import { listLabel, listName } from '../../lib/rotationListNames';
import type { LogLive } from '../../lib/rotationLiveView';
import { stopFlag } from '../../lib/rotationPortfolioView';
import type { RotationListKey, RotationRow } from '../../types/rotationDailyLog';
import { Badge, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { pnlClass } from './shared';

const SHOWN = 30;

const FLAG_TONE: Record<RowFlag['tone'], Tone> = {
  negative: 'negative',
  warning: 'warning',
  info: 'info',
  neutral: 'neutral',
};

function ListCell({ row, list }: { row: RotationRow; list: RotationListKey }) {
  const block = row.lists[list];
  if (block === undefined) {
    return <span className="text-faint">{EMPTY}</span>;
  }
  if (block.per_lot_day === null || block.gross === null) {
    const why =
      block.missing.length > 0
        ? `No stored result yet for ${block.missing.join(', ')}`
        : 'No stored result yet';
    return (
      <span className="text-faint" title={`${listLabel(list)}: ${why}`}>
        {EMPTY}
      </span>
    );
  }
  const total = `${listLabel(list)}: ${formatInr(block.gross, { sign: true })} gross for ${block.lots} lots (${block.picks.length} strategies); ${formatInr(block.per_lot_day, { sign: true })} per lot-day`;
  const pf = block.pf;
  const stopped = pf !== undefined && pf.stop_label !== null;
  const notes = [
    stopped
      ? `With the portfolio stop (${pf.fired_by === 'lock' ? 'profit lock' : 'stop'} at ${pf.stop_label}); the log shows ${formatInr(pf.gross_without, { sign: true })} for ${block.lots} lots (${formatInr(pf.per_lot_day_without, { sign: true })} per lot-day)`
      : null,
    block.overridden ? 'the Widesl minimum replaced a top-ranked Dir' : null,
    block.buy_qualified ? 'a Buy strategy qualified and was added' : null,
  ].filter((n): n is string => n !== null);
  return (
    <span
      className={cn(
        'metric inline-flex flex-col items-end whitespace-nowrap leading-tight',
        pnlClass(block.per_lot_day),
      )}
      title={notes.length > 0 ? `${total}\n${notes.join('; ')}` : total}
    >
      {stopped ? (
        <span className="text-[10px] text-faint line-through">
          {formatInr(pf.per_lot_day_without, { sign: true })}
        </span>
      ) : null}
      <span>
        {formatInr(block.per_lot_day, { sign: true })}
        <span className="ml-0.5 inline-block w-4 text-left text-[10px] font-sans text-faint">
          {block.overridden ? 'W' : ''}
          {block.buy_qualified ? 'B' : ''}
        </span>
      </span>
    </span>
  );
}

const LIVE_WORD: Record<Exclude<LogLive['state'], 'captured'>, string> = {
  before: EMPTY,
  waiting: 'waiting',
  not_captured: 'not captured',
};

function LiveCell({ live }: { live: LogLive | null }) {
  if (live === null) return <span className="text-faint">{EMPTY}</span>;
  if (live.state !== 'captured') {
    return (
      <span
        className={cn('text-[11px]', live.state === 'not_captured' ? 'text-warning' : 'text-faint')}
        title={live.detail}
      >
        {LIVE_WORD[live.state]}
      </span>
    );
  }
  return (
    <span
      className={cn('metric', live.perLotDay === null ? 'text-faint' : pnlClass(live.perLotDay))}
      title={live.detail}
    >
      {live.perLotDay === null ? EMPTY : formatInr(live.perLotDay, { sign: true })}
    </span>
  );
}

function vixCell(row: RotationRow) {
  if (row.vix === null) return <span className="text-faint">{EMPTY}</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="metric">{formatNumber(row.vix.open, 2)}</span>
      {row.vix.source ? <span className="ml-1.5 text-xs text-faint">{row.vix.source}</span> : null}
    </span>
  );
}

export function RotationDailyLogTable({
  rows,
  focus,
  selectedDay,
  onOpen,
  live,
}: {
  rows: readonly RotationRow[];
  focus: RotationListKey;
  selectedDay: string | null;
  onOpen: (day: string) => void;
  /** The focus book's live result for a day; absent for reconstructed days. */
  live?: ((day: string) => LogLive | null) | undefined;
}) {
  const [all, setAll] = useState(false);
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  const shown = all ? newestFirst : newestFirst.slice(0, SHOWN);
  return (
    <div>
      <Table maxHeight={640}>
        <THead>
          <Th dense>Day</Th>
          <Th dense align="right">
            VIX open
          </Th>
          <Th dense align="right">
            DTE N / S
          </Th>
          <Th dense align="right">
            Recorded
          </Th>
          {LIST_KEYS.map((k) => (
            <Th dense align="right" key={k} className={cn(k === focus && 'text-foreground')}>
              {listName(k)} <span className="text-[10px] font-normal text-faint">{k}</span>
            </Th>
          ))}
          <Th dense>Flags</Th>
          {live ? (
            <Th dense align="right" title="Live minus paper per lot-day, both after the same costs">
              Live − paper
            </Th>
          ) : null}
          <Th dense>Status</Th>
        </THead>
        <tbody>
          {shown.map((row) => {
            const flags = rowFlags(row);
            const pfFlag = stopFlag(row, focus);
            return (
              <TRow
                key={row.day}
                className="h-8"
                selected={row.day === selectedDay}
                onClick={() => onOpen(row.day)}
              >
                <Td dense className="whitespace-nowrap">
                  <span className="text-faint">{row.weekday}</span> {formatDay(row.day)}
                </Td>
                <Td dense align="right">
                  {vixCell(row)}
                </Td>
                <Td dense align="right" numeric>
                  {row.dte ? `${row.dte.NIFTY ?? EMPTY} / ${row.dte.SENSEX ?? EMPTY}` : EMPTY}
                </Td>
                <Td dense align="right" numeric>
                  {row.recorded?.time ?? EMPTY}
                </Td>
                {LIST_KEYS.map((k) => (
                  <Td dense align="right" key={k}>
                    <ListCell row={row} list={k} />
                  </Td>
                ))}
                <Td dense className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {flags.slice(0, 3).map((f) => (
                      <span key={f.id} title={f.title}>
                        <Badge tone={FLAG_TONE[f.tone]} className="px-1.5 py-0 text-[11px]">
                          {f.label}
                        </Badge>
                      </span>
                    ))}
                    {pfFlag ? (
                      <span title={pfFlag.title}>
                        <Badge tone="warning" className="px-1.5 py-0 text-[11px]">
                          {pfFlag.label}
                        </Badge>
                      </span>
                    ) : null}
                    {flags.length > 3 ? (
                      <span
                        className="text-xs text-faint"
                        title={flags
                          .slice(3)
                          .map((f) => f.label)
                          .join(', ')}
                      >
                        +{flags.length - 3}
                      </span>
                    ) : null}
                  </span>
                </Td>
                {live ? (
                  <Td dense align="right">
                    <LiveCell live={row.source === 'recorded' ? live(row.day) : null} />
                  </Td>
                ) : null}
                <Td dense className="whitespace-nowrap">
                  <span title={row.status_detail || STATUS_LABEL[row.status]}>
                    <Badge tone={STATUS_TONE[row.status]} className="px-1.5 py-0 text-[11px]">
                      {STATUS_LABEL[row.status]}
                    </Badge>
                  </span>
                </Td>
              </TRow>
            );
          })}
        </tbody>
      </Table>
      <p className="mt-2 text-[11px] text-faint">
        ₹ gross per lot-day, hover for the list's total.{' '}
        {live
          ? 'Live − paper: the 15:40 capture against paper per lot-day, after the same costs; + means live did better. '
          : ''}
        <span className="font-semibold">W</span>: the Widesl minimum replaced a top-ranked Dir.{' '}
        <span className="font-semibold">B</span>: a Buy strategy qualified and was added.
      </p>
      {newestFirst.length > SHOWN ? (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? `Show the latest ${SHOWN}` : `Show all ${newestFirst.length} days`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
