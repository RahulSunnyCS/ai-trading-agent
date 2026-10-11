/**
 * The daily log's table: one 32 px line a day, newest first. Per list the gross per lot-day (the
 * unit lists are compared in; the day's total for the list's lots is in the tooltip). A day with
 * no figure shows why. Clicking a line opens the day.
 */

import { useMemo, useState } from 'react';

import { cn } from '../../lib/cn';
import { EMPTY, formatDay, formatInr, formatNumber } from '../../lib/format';
import {
  LIST_KEYS,
  PLACEMENT_LABEL,
  type RowFlag,
  STATUS_LABEL,
  STATUS_TONE,
  placementTally,
  rowFlags,
} from '../../lib/rotationDailyLogView';
import type { PlacementStatus, RotationListKey, RotationRow } from '../../types/rotationDailyLog';
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

const PLACEMENT_DOT: Record<PlacementStatus | 'none', string> = {
  placed: 'bg-positive',
  changed: 'bg-warning',
  not_placed: 'bg-negative',
  none: 'bg-surface-2 ring-1 ring-inset ring-border',
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
      <span className="text-faint" title={`${list}: ${why}`}>
        {EMPTY}
      </span>
    );
  }
  const total = `${list}: ${formatInr(block.gross, { sign: true })} gross for ${block.lots} lots (${block.picks.length} strategies); ${formatInr(block.per_lot_day, { sign: true })} per lot-day`;
  const notes = [
    block.overridden ? 'the Widesl minimum replaced a top-ranked Dir' : null,
    block.buy_qualified ? 'a Buy strategy qualified and was added' : null,
  ].filter((n): n is string => n !== null);
  return (
    <span
      className={cn('metric', pnlClass(block.per_lot_day))}
      title={notes.length > 0 ? `${total}\n${notes.join('; ')}` : total}
    >
      {formatInr(block.per_lot_day, { sign: true })}
      <span className="ml-0.5 inline-block w-4 text-left text-[10px] font-sans text-faint">
        {block.overridden ? 'W' : ''}
        {block.buy_qualified ? 'B' : ''}
      </span>
    </span>
  );
}

function PlacedCell({ row }: { row: RotationRow }) {
  if (row.source !== 'recorded') return <span className="text-faint">{EMPTY}</span>;
  const tally = placementTally(row);
  const title = LIST_KEYS.filter((k) => row.lists[k] !== undefined)
    .map((k) => {
      const p = row.placement[k];
      return `${k}: ${p ? `${PLACEMENT_LABEL[p.status]}${p.note ? ` (${p.note})` : ''}` : 'not marked'}`;
    })
    .join('\n');
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`${tally.marked} of ${tally.of} lists marked\n${title}`}
    >
      {LIST_KEYS.map((k) => (
        <span
          key={k}
          aria-hidden="true"
          className={cn(
            'h-2.5 w-2.5 rounded-full',
            PLACEMENT_DOT[row.placement[k]?.status ?? 'none'],
            row.lists[k] === undefined && 'opacity-30',
          )}
        />
      ))}
      <span className="sr-only">{`${tally.marked} of ${tally.of} lists marked`}</span>
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
}: {
  rows: readonly RotationRow[];
  focus: RotationListKey;
  selectedDay: string | null;
  onOpen: (day: string) => void;
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
              {k}
            </Th>
          ))}
          <Th dense>Flags</Th>
          <Th dense align="center">
            Placed
          </Th>
          <Th dense>Status</Th>
        </THead>
        <tbody>
          {shown.map((row) => {
            const flags = rowFlags(row);
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
                <Td dense align="center">
                  <PlacedCell row={row} />
                </Td>
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
        ₹ gross per lot-day, hover for the list's total. <span className="font-semibold">W</span>:
        the Widesl minimum replaced a top-ranked Dir. <span className="font-semibold">B</span>: a
        Buy strategy qualified and was added.
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
