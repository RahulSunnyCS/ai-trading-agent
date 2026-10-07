'use client';

import { Fragment, useMemo, useState } from 'react';

import { cn } from '../../../lib/cn';
import { formatInr, formatInt, formatPct } from '../../../lib/format';
import {
  ALL_GROUPS,
  type ScoreSort,
  type ScoreSortKey,
  type SectorScore,
  type SignalMark,
  type StockScore,
  filterSectors,
  markKey,
  nextSort,
  parentGroups,
  sectorMembers,
  sortSectors,
} from '../../../lib/momentumScores';
import { Badge } from '../../ui/Badge';
import { Input, Select } from '../../ui/Input';
import { THead, TRow, Table, Td } from '../../ui/Table';
import { ScoreStrip } from './ScoreStrip';
import { SortTh } from './SortTh';

/**
 * The sub-sectors, each with the strip of its stocks' average score per lookback; a row opens to
 * the stocks in it. (The rotation map and the sector page replace this in BL-049 Phase 2.)
 */
export function SectorsTable({
  sectors,
  stocks,
  lookbacks,
  marks,
}: {
  sectors: readonly SectorScore[];
  stocks: readonly StockScore[];
  lookbacks: readonly number[];
  marks: ReadonlyMap<string, SignalMark> | undefined;
}) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(ALL_GROUPS);
  const [open, setOpen] = useState<string | null>(null);
  const longest = lookbacks.at(-1) ?? null;
  const [sort, setSort] = useState<ScoreSort>({ key: 'score', lookback: 26, ascending: false });
  const onSort = (key: ScoreSortKey, lookback: number | null): void =>
    setSort((current) => nextSort(current, key, lookback));
  const groups = useMemo(() => parentGroups(sectors), [sectors]);
  const rows = useMemo(
    () => sortSectors(filterSectors(sectors, { query, group }), sort),
    [sectors, query, group, sort],
  );
  const sortLookback = lookbacks.includes(sort.lookback ?? -1) ? sort.lookback : longest;

  return (
    <section
      aria-label="Sectors"
      className="rounded-xl border border-border bg-surface shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Input
          type="search"
          aria-label="Filter sectors"
          placeholder="Filter sectors…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-64"
        />
        <Select
          aria-label="Parent group"
          value={group}
          onChange={(event) => setGroup(event.target.value)}
          className="ml-auto w-auto max-w-[14rem]"
        >
          <option value={ALL_GROUPS}>All groups</option>
          {groups.map((option) => (
            <option key={option.group} value={option.group}>
              {option.group} ({formatInt(option.count)})
            </option>
          ))}
        </Select>
      </div>
      <Table stickyFirstCol maxHeight="70vh">
        <THead>
          <SortTh sort={sort} sortKey="name" onSort={onSort}>
            Sector
          </SortTh>
          <SortTh sort={sort} sortKey="members" onSort={onSort} align="right">
            Stocks
          </SortTh>
          <SortTh
            sort={{ ...sort, lookback: sortLookback }}
            sortKey="score"
            lookback={sortLookback}
            onSort={onSort}
            title="Score 1–10 by lookback, from the average of the sector's stocks; sorted by the longest window"
          >
            Score 1–10 · {lookbacks.map((weeks) => `${weeks}w`).join(' ')}
          </SortTh>
        </THead>
        <tbody>
          {rows.map((sector) => (
            <Fragment key={sector.cid}>
              <TRow>
                <Td dense>
                  <button
                    type="button"
                    className="text-left text-primary hover:underline"
                    aria-expanded={open === sector.cid}
                    onClick={() => setOpen(open === sector.cid ? null : sector.cid)}
                  >
                    {open === sector.cid ? '▾' : '▸'} {sector.subgroup}
                  </button>
                  <span className="ml-2 text-xs text-muted">{sector.parent_group}</span>
                </Td>
                <Td dense align="right" numeric>
                  {formatInt(sector.qualifying_count)} / {formatInt(sector.member_count)}
                </Td>
                <Td dense>
                  <ScoreStrip scores={sector.scores} lookbacks={lookbacks} />
                </Td>
              </TRow>
              {open === sector.cid ? (
                <tr>
                  <td colSpan={3} className="p-0">
                    <div className="overflow-x-auto border-l-2 border-primary/30 px-3 py-2">
                      <table className="w-full min-w-[640px] text-xs">
                        <tbody>
                          {sectorMembers(stocks, sector).map((stock) => (
                            <tr
                              key={stock.symbol}
                              className="border-t border-border/50 first:border-t-0"
                            >
                              <td className="max-w-[18rem] truncate py-1">
                                <span className="font-medium text-foreground">{stock.symbol}</span>{' '}
                                <span className="text-muted">{stock.company_name}</span>{' '}
                                {marks?.get(markKey(stock.symbol)) === 'held' ? (
                                  <Badge tone="primary">Held</Badge>
                                ) : null}
                              </td>
                              <td className="metric py-1 text-right">
                                {formatInr(stock.last_price, { dp: 2, trim: true })}
                              </td>
                              <td
                                className={cn(
                                  'metric py-1 text-right',
                                  (stock.change_1w_pct ?? 0) >= 0
                                    ? 'text-positive'
                                    : 'text-negative',
                                )}
                              >
                                {formatPct(stock.change_1w_pct, 1, { sign: true })}
                              </td>
                              <td className="py-1 text-right">
                                <ScoreStrip
                                  scores={stock.scores}
                                  returns={stock.returns}
                                  lookbacks={lookbacks}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </Table>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No matching sectors.</p>
      ) : null}
    </section>
  );
}
