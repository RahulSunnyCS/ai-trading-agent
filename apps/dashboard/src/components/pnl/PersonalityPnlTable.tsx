'use client';

import { useMemo, useState } from 'react';

import { EMPTY, formatInr, formatInt, formatPct } from '../../lib/format';
import {
  DEFAULT_PERSONALITY_SORT,
  type PersonalityPnlRow,
  type PersonalitySort,
  type PersonalitySortKey,
  nextPersonalitySort,
  sortPersonalityPnl,
} from '../../lib/pnl';
import { SortTh } from '../trades/SortTh';
import { Badge } from '../ui/Badge';
import { THead, TRow, Table, Td } from '../ui/Table';

function toneClass(value: number | null): string {
  if (value === null || value === 0) return 'text-muted';
  return value > 0 ? 'text-positive' : 'text-negative';
}

const BEAT_CLOCKWORK_HELP =
  "This personality's net P&L minus Clockwork's (the frozen benchmark) over the same range. Positive means it beat Clockwork.";

/** Net P&L, win rate and Beat-Clockwork Δ per personality, sortable. */
export function PersonalityPnlTable({ rows }: { rows: PersonalityPnlRow[] }) {
  const [sort, setSort] = useState<PersonalitySort>(DEFAULT_PERSONALITY_SORT);
  const sorted = useMemo(() => sortPersonalityPnl(rows, sort), [rows, sort]);
  const onSort = (key: PersonalitySortKey) =>
    setSort((current) => nextPersonalitySort(current, key));
  const th = (
    label: string,
    key: PersonalitySortKey,
    align: 'left' | 'right' = 'right',
    help?: string,
  ) => (
    <SortTh
      label={label}
      sortKey={key}
      activeKey={sort.key}
      dir={sort.dir}
      onSort={onSort}
      align={align}
      {...(help ? { help } : {})}
    />
  );

  return (
    <Table stickyFirstCol>
      <THead>
        {th('Personality', 'name', 'left')}
        {th('Trades', 'trades')}
        {th('Win rate', 'winRate')}
        {th('Net P&L', 'net')}
        {th('Beat-Clockwork Δ', 'beatClockwork', 'right', BEAT_CLOCKWORK_HELP)}
      </THead>
      <tbody>
        {sorted.map((row) => (
          <TRow key={row.personalityId ?? 'unassigned'}>
            <Td className="whitespace-nowrap font-medium">
              <span className={row.personalityId === null ? 'text-muted' : undefined}>
                {row.name}
              </span>
              {row.isClockwork ? (
                <Badge tone="neutral" className="ml-2">
                  Benchmark
                </Badge>
              ) : null}
            </Td>
            <Td numeric align="right">
              {formatInt(row.trades)}
            </Td>
            <Td numeric align="right">
              {formatPct(row.winRate, 1)}
            </Td>
            <Td numeric align="right" className="whitespace-nowrap">
              <span className={`font-medium ${toneClass(row.net)}`}>
                {formatInr(row.net, { dp: 2, sign: true })}
              </span>
            </Td>
            <Td numeric align="right" className="whitespace-nowrap">
              {row.beatClockwork === null ? (
                <span className="text-faint">{EMPTY}</span>
              ) : (
                <span className={toneClass(row.beatClockwork)}>
                  {formatInr(row.beatClockwork, { dp: 2, sign: true })}
                </span>
              )}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}
