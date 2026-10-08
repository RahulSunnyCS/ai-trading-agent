'use client';

import { Search } from 'lucide-react';
import { type ReactNode, useDeferredValue, useMemo, useState } from 'react';

import { cn } from '../../../lib/cn';
import { EMPTY, formatInt, formatPct } from '../../../lib/format';
import {
  MOMENTUM_STEP,
  QUADRANT_LABEL,
  type Quadrant,
  type RotationGroup,
  type RotationRow,
  type StockScore,
  TAIL_CHOICES,
  buildRotationRows,
  leaderCount,
} from '../../../lib/momentumScores';
import { MIN_STOCK_CHOICES, useMomentumScoresStore } from '../../../store/momentumScores';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { RotationMap } from './RotationMap';
import { ScoreStrip } from './ScoreStrip';

const QUADRANT_TONE = {
  leading: 'positive',
  improving: 'info',
  weakening: 'warning',
  lagging: 'negative',
} as const satisfies Record<Quadrant, 'positive' | 'info' | 'warning' | 'negative'>;

const STRIP_WEEKS = [4, 13, 26] as const;

export function QuadrantBadge({ quadrant }: { quadrant: Quadrant | null }) {
  if (!quadrant) return <span className="text-faint">{EMPTY}</span>;
  return (
    <Badge tone={QUADRANT_TONE[quadrant]} dot>
      {QUADRANT_LABEL[quadrant]}
    </Badge>
  );
}

function Tooltip({ row }: { row: RotationRow }) {
  const { entry } = row;
  const leaders = leaderCount(row.stocks);
  return (
    <div className="space-y-1.5">
      <div className="font-semibold text-foreground">{entry.label}</div>
      <div className="text-muted">
        {formatInt(row.stocks.length)} stocks · {formatInt(entry.group.scored_count)} scored
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted">4w · 13w · 26w</span>
        <ScoreStrip scores={row.strip} lookbacks={STRIP_WEEKS} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted">Now</span>
        <QuadrantBadge quadrant={entry.quadrant} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted">{MOMENTUM_STEP} weeks ago</span>
        <QuadrantBadge quadrant={entry.before} />
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-muted">Above 40-week average</span>
        <span className="metric text-foreground">{formatPct(row.above, 0)}</span>
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-muted">Leaders</span>
        <span className="metric text-foreground">{formatInt(leaders)}</span>
      </div>
    </div>
  );
}

/**
 * The rotation map and the table beside it, for one set of groups (the parent groups, or the
 * sub-sectors of one). A search, "changed quadrant only", the fewest stocks for a dot and the
 * tail length sit above; hovering a dot lights its table row and the reverse. Clicking either
 * calls `onSelect`. Rows that cannot be placed (a theme basket, too few stocks) stay in the
 * table, greyed, with the reason.
 */
export function RotationPanel({
  groups,
  stocksOf,
  lookbacks,
  selectedKey,
  onSelect,
  title,
  meta,
  unit,
  hint,
}: {
  groups: readonly RotationGroup[];
  stocksOf: (group: RotationGroup) => StockScore[];
  lookbacks: readonly number[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  title: string;
  meta: string;
  /** What the rows are called, singular: "group" or "sub-sector". */
  unit: string;
  /** What a click does, for the hint under the table. */
  hint: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [tail, setTail] = useState<number>(4);
  const [hover, setHover] = useState<string | null>(null);
  const minStocks = useMomentumScoresStore((state) => state.minStocks);
  const setMinStocks = useMomentumScoresStore((state) => state.setMinStocks);
  const deferredQuery = useDeferredValue(query);

  const rows = useMemo(
    () =>
      buildRotationRows(groups, stocksOf, {
        tail,
        minStocks,
        query: deferredQuery,
        changedOnly,
        lookbacks,
      }),
    [groups, stocksOf, tail, minStocks, deferredQuery, changedOnly, lookbacks],
  );
  const mapRows = rows.filter((row) => row.onMap);
  const byKey = useMemo(() => new Map(rows.map((row) => [row.entry.key, row])), [rows]);
  const entries = useMemo(() => mapRows.map((row) => row.entry), [mapRows]);
  const sizeOf = useMemo(() => {
    const scored = new Map(mapRows.map((row) => [row.entry.key, row.entry.group.scored_count]));
    return (entry: { key: string }) => scored.get(entry.key) ?? 1;
  }, [mapRows]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3 shadow-card">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={`Find a ${unit}`}
            placeholder={`Find a ${unit}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-56 pl-8"
          />
        </div>
        <Button
          size="sm"
          variant={changedOnly ? 'primary' : 'secondary'}
          aria-pressed={changedOnly}
          onClick={() => setChangedOnly((on) => !on)}
          title={`Only the ${unit}s that moved to another quadrant in the last ${MOMENTUM_STEP} weeks`}
        >
          Changed quadrant only
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            aria-label="Fewest scored stocks for a dot"
            value={minStocks}
            onChange={(event) => setMinStocks(Number(event.target.value))}
            className="w-auto"
          >
            {MIN_STOCK_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                Min {choice} {choice === 1 ? 'stock' : 'stocks'}
              </option>
            ))}
          </Select>
          <SegmentedControl
            ariaLabel="Tail length"
            size="sm"
            value={String(tail)}
            onChange={(value) => setTail(Number(value))}
            options={TAIL_CHOICES.map((weeks) => ({
              value: String(weeks),
              label: `Tails ${weeks}w`,
            }))}
          />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section
          aria-label={`${title}: rotation map`}
          className="min-w-0 rounded-xl border border-border bg-surface p-2 shadow-card"
        >
          <RotationMap
            entries={entries}
            sizeOf={sizeOf}
            hover={hover}
            selected={selectedKey}
            showTails={changedOnly}
            labelAll={mapRows.length <= 24}
            onHover={setHover}
            onSelect={onSelect}
            tooltip={(entry) => {
              const row = byKey.get(entry.key);
              return row ? <Tooltip row={row} /> : null;
            }}
            ariaLabel={`${title}: where each ${unit} stands and which way it is moving`}
          />
        </section>

        <section
          aria-label={title}
          className="min-w-0 rounded-xl border border-border bg-surface shadow-card"
        >
          <header className="flex items-baseline gap-2 px-4 pb-1 pt-3">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="min-w-0 truncate text-xs text-faint">{meta}</p>
          </header>
          <Table maxHeight="560px">
            <THead>
              <Th dense>{unit === 'group' ? 'Sector' : 'Sub-sector'}</Th>
              <Th dense>4w · 13w · 26w</Th>
              <Th dense>Quadrant</Th>
              <Th dense align="right" title="Share of its stocks above their 40-week average">
                Above 40w
              </Th>
            </THead>
            <tbody>
              {rows.map((row) => (
                <TRow
                  key={row.entry.key}
                  onClick={() => onSelect(row.entry.key)}
                  selected={row.entry.key === selectedKey}
                  highlighted={row.entry.key === hover}
                  onHover={(on) => setHover(on ? row.entry.key : null)}
                  className={cn(!row.onMap && 'text-faint')}
                >
                  <Td dense className="max-w-[12rem]">
                    <span className="flex items-baseline gap-2 truncate" title={row.entry.label}>
                      <span className={cn('truncate font-medium', row.onMap && 'text-foreground')}>
                        {row.entry.label}
                      </span>
                      <span className="metric text-xs text-faint">
                        {formatInt(row.stocks.length)}
                      </span>
                    </span>
                  </Td>
                  <Td dense>
                    <ScoreStrip scores={row.strip} lookbacks={STRIP_WEEKS} />
                  </Td>
                  <Td dense>
                    {row.onMap ? (
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <QuadrantBadge quadrant={row.entry.quadrant} />
                        {row.entry.changed && row.entry.before ? (
                          <span className="text-xs text-faint">
                            was {QUADRANT_LABEL[row.entry.before]}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="whitespace-nowrap text-xs">{row.why}</span>
                    )}
                  </Td>
                  <Td dense numeric align="right">
                    {formatPct(row.above, 0)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">No {unit} matches.</p>
          ) : null}
          <p className="border-t border-border px-4 py-2 text-xs text-muted">{hint}</p>
        </section>
      </div>
    </div>
  );
}
