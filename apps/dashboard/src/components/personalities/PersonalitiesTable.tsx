import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Lock, Pencil } from 'lucide-react';
import { Fragment } from 'react';

import { cn } from '../../lib/cn';
import { EMPTY, formatInr, formatInt, formatIstDateTimeShort, formatPct } from '../../lib/format';
import {
  FROZEN_EDIT_REASON,
  type PersonalityPerformance,
  type PersonalitySort,
  type PersonalitySortKey,
  STATE_BADGE,
  ariaSort,
  paramEntries,
  personalityState,
} from '../../lib/personalities';
import type { Personality } from '../../types/trading';
import { Badge, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

function managementTone(style: string): Tone {
  switch (style) {
    case 'hold':
      return 'info';
    case 'roll':
      return 'warning';
    case 'cut_reenter':
      return 'accent';
    default:
      return 'neutral';
  }
}

const MANAGEMENT_LABEL: Readonly<Record<string, string>> = {
  hold: 'Hold',
  roll: 'Roll',
  cut_reenter: 'Cut + re-enter',
};

const ENTRY_LABEL: Readonly<Record<string, string>> = {
  fixed_time: 'Fixed time',
  momentum_exhaustion: 'Momentum exhaustion',
  any_signal: 'Any signal',
  sr_anchored: 'S/R anchored',
};

function humanise(raw: string): string {
  const text = raw.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: PersonalitySortKey;
  sort: PersonalitySort | null;
  onSort: (key: PersonalitySortKey) => void;
  align?: 'left' | 'right';
}) {
  const state = ariaSort(sort, sortKey);
  const Icon = state === 'none' ? ArrowUpDown : state === 'ascending' ? ArrowUp : ArrowDown;
  return (
    <Th align={align} aria-sort={state}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 rounded uppercase tracking-wider hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          state !== 'none' && 'text-foreground',
        )}
      >
        {label}
        <Icon className={cn('h-3 w-3', state === 'none' && 'opacity-50')} aria-hidden />
      </button>
    </Th>
  );
}

function StatusBadges({ personality }: { personality: Personality }) {
  const state = STATE_BADGE[personalityState(personality)];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span title={state.description}>
        <Badge tone={state.tone} dot={personality.is_active}>
          {state.label}
        </Badge>
      </span>
      {personality.is_frozen ? (
        <span title={STATE_BADGE.frozen.description}>
          <Badge tone={STATE_BADGE.frozen.tone}>
            <Lock className="h-3 w-3" aria-hidden />
            {STATE_BADGE.frozen.label}
          </Badge>
        </span>
      ) : null}
    </div>
  );
}

function ParamsDetail({ personality }: { personality: Personality }) {
  const entries = paramEntries(personality.params);
  return (
    <div className="max-w-3xl space-y-3 px-2 py-1">
      {entries.length === 0 ? (
        <p className="text-sm text-muted">No parameters set.</p>
      ) : (
        <dl className="grid gap-x-10 sm:grid-cols-2">
          {entries.map((entry) => (
            <div
              key={entry.key}
              className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5"
            >
              <dt className="text-sm text-muted" title={entry.key}>
                {entry.label}
              </dt>
              <dd className="metric text-sm text-foreground">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-xs text-faint">
        {personality.group_type === 'learning' ? 'Learning' : 'Reference'} personality · phase{' '}
        {formatInt(personality.phase)} · last changed{' '}
        {formatIstDateTimeShort(personality.updated_at)}
      </p>
    </div>
  );
}

const COLUMNS = 9;

interface PersonalitiesTableProps {
  personalities: Personality[];
  performance: ReadonlyMap<string, PersonalityPerformance>;
  sort: PersonalitySort | null;
  onSort: (key: PersonalitySortKey) => void;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onEdit: (p: Personality) => void;
}

export function PersonalitiesTable({
  personalities,
  performance,
  sort,
  onSort,
  expanded,
  onToggle,
  onEdit,
}: PersonalitiesTableProps) {
  return (
    <Table>
      <THead>
        <Th className="w-8">
          <span className="sr-only">Expand</span>
        </Th>
        <SortHeader label="Name" sortKey="name" sort={sort} onSort={onSort} />
        <SortHeader label="Status" sortKey="status" sort={sort} onSort={onSort} />
        <Th>Entry</Th>
        <Th>Management</Th>
        <SortHeader label="Net P&L" sortKey="netPnl" sort={sort} onSort={onSort} align="right" />
        <SortHeader label="Win %" sortKey="winRate" sort={sort} onSort={onSort} align="right" />
        <SortHeader label="Trades" sortKey="trades" sort={sort} onSort={onSort} align="right" />
        <Th>
          <span className="sr-only">Actions</span>
        </Th>
      </THead>
      <tbody>
        {personalities.map((p) => {
          const perf = performance.get(p.id);
          const open = expanded.has(p.id);
          const net = perf?.netPnl ?? null;
          return (
            <Fragment key={p.id}>
              <TRow onClick={() => onToggle(p.id)} selected={open}>
                <Td className="pr-0 text-faint">
                  <ChevronRight
                    className={cn('h-4 w-4 transition-transform', open && 'rotate-90')}
                    aria-label={open ? 'Hide parameters' : 'Show parameters'}
                  />
                </Td>
                <Td>
                  <span className="font-medium text-foreground">{p.display_name}</span>
                  {p.phase > 1 ? (
                    <span className="ml-1.5 text-xs text-faint">phase {formatInt(p.phase)}</span>
                  ) : null}
                </Td>
                <Td>
                  <StatusBadges personality={p} />
                </Td>
                <Td className="whitespace-nowrap text-muted">
                  {ENTRY_LABEL[p.entry_type] ?? humanise(p.entry_type)}
                </Td>
                <Td>
                  <Badge tone={managementTone(p.management_style)}>
                    {MANAGEMENT_LABEL[p.management_style] ?? humanise(p.management_style)}
                  </Badge>
                </Td>
                <Td
                  numeric
                  align="right"
                  className={cn(
                    net !== null && net > 0 && 'text-positive',
                    net !== null && net < 0 && 'text-negative',
                    net === null && 'text-faint',
                  )}
                >
                  {net === null ? EMPTY : formatInr(net, { sign: true })}
                </Td>
                <Td numeric align="right" className="text-muted">
                  {formatPct(perf?.winRate ?? null, 0)}
                </Td>
                <Td numeric align="right" className="text-muted">
                  {formatInt(perf?.trades ?? 0)}
                </Td>
                <Td align="right">
                  {p.is_frozen ? (
                    <span title={FROZEN_EDIT_REASON} className="inline-flex">
                      <Button size="sm" variant="ghost" disabled>
                        <Lock className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                      <span className="sr-only">{FROZEN_EDIT_REASON}</span>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEdit(p);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  )}
                </Td>
              </TRow>
              {open ? (
                <tr className="border-b border-border/60 bg-surface-2/40">
                  <Td colSpan={COLUMNS} className="pt-2">
                    <ParamsDetail personality={p} />
                  </Td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}
