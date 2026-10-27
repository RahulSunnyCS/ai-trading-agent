'use client';

/**
 * The Days table: one row per session of the picked year, newest first. A day with a note that
 * failed to read is open and shown as such; a day with no note on any account says so; neither is
 * ever a zero. A row opens the day in the drawer.
 */

import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';

import { downloadCsv } from '../../lib/csv';
import { EMPTY, formatDay, formatInr, formatInt } from '../../lib/format';
import { type BookPoint, dayState } from '../../lib/tradeBookView';
import type { TradeBookDay } from '../../types/tradeBook';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { Inr, SourceBadge, Toggle } from './parts';

const FIRST_ROWS = 60;

export function TradeBookDays({
  rows,
  book,
  sources,
  selected,
  onOpen,
  fileName,
}: {
  rows: TradeBookDay[];
  /** The running figures within the year (same order as `rows`). */
  book: BookPoint[];
  /** The sources seen on each day (from the trips), when loaded. */
  sources: Map<string, string[]> | null;
  selected: string | null;
  onOpen: (day: string) => void;
  fileName: string;
}) {
  const [showEmpty, setShowEmpty] = useState(true);
  const [all, setAll] = useState(false);
  const byDay = useMemo(() => new Map(book.map((b) => [b.day, b])), [book]);
  const shown = useMemo(
    () => [...rows].reverse().filter((r) => showEmpty || r.notes > 0 || r.open > 0),
    [rows, showEmpty],
  );
  const visible = all ? shown : shown.slice(0, FIRST_ROWS);

  const csv = () =>
    downloadCsv(
      fileName,
      [
        ['day', 'Day'],
        ['notes', 'Notes'],
        ['failed', 'Failed'],
        ['net', 'Note net'],
        ['algos', 'Algos'],
        ['algo_fees', 'Algo fees'],
        ['profit', 'Net profit'],
        ['charges', 'Charges'],
        ['to_date', 'To date'],
        ['drawdown', 'Drawdown'],
        ['capital', 'Capital'],
      ],
      [...rows].map((r) => ({
        day: r.day,
        notes: r.notes,
        failed: r.open,
        net: r.net,
        algos: r.algos,
        algo_fees: r.algo_fees,
        profit: r.profit,
        charges: r.charges,
        to_date: byDay.get(r.day)?.toDate,
        drawdown: byDay.get(r.day)?.drawdown,
        capital: r.capital,
      })),
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Toggle on={showEmpty} onChange={setShowEmpty}>
          Show days with no note
        </Toggle>
        <Button size="sm" variant="ghost" onClick={csv} className="ml-auto">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          CSV
        </Button>
      </div>
      <Table maxHeight={640}>
        <THead>
          <Th dense>Day</Th>
          <Th dense>Notes</Th>
          <Th dense align="right">
            Net
          </Th>
          <Th dense align="right">
            Charges
          </Th>
          <Th dense align="right">
            Algos
          </Th>
          <Th dense align="right">
            To date
          </Th>
          <Th dense align="right">
            Drawdown
          </Th>
          <Th dense>Sources</Th>
        </THead>
        <tbody>
          {visible.map((r) => {
            const state = dayState(r);
            const b = byDay.get(r.day);
            const daySources = sources?.get(r.day) ?? [];
            return (
              <TRow
                key={r.day}
                selected={selected === r.day}
                onClick={() => onOpen(r.day)}
                className="whitespace-nowrap"
              >
                <Td dense>{formatDay(r.day, { weekday: true })}</Td>
                <Td dense>
                  <Badge tone={state.kind === 'open' ? 'warning' : 'neutral'}>{state.label}</Badge>
                </Td>
                <Td dense numeric align="right">
                  <Inr value={r.profit} />
                </Td>
                <Td dense numeric align="right">
                  {r.charges === null ? (
                    <span className="text-faint">{EMPTY}</span>
                  ) : (
                    formatInr(r.charges)
                  )}
                </Td>
                <Td dense numeric align="right">
                  {r.algos === null ? (
                    <span className="text-faint">{EMPTY}</span>
                  ) : (
                    formatInt(r.algos)
                  )}
                </Td>
                <Td dense numeric align="right">
                  {b ? formatInr(b.toDate) : EMPTY}
                </Td>
                <Td dense numeric align="right">
                  <Inr value={b ? b.drawdown : null} />
                </Td>
                <Td dense>
                  <span className="flex gap-1">
                    {daySources.map((s) => (
                      <SourceBadge key={s} source={s} />
                    ))}
                  </span>
                </Td>
              </TRow>
            );
          })}
        </tbody>
      </Table>
      {shown.length > FIRST_ROWS ? (
        <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${shown.length} days`}
        </Button>
      ) : null}
    </div>
  );
}
