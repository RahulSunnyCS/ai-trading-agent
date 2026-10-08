'use client';

import { Columns3, Search, X } from 'lucide-react';
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../../lib/cn';
import { EMPTY, formatInr, formatInt, formatPct } from '../../../lib/format';
import {
  ALL_GROUPS,
  type BuyZone,
  DEFAULT_STOCKS_SORT,
  STOCK_VIEWS,
  type ScoreSort,
  type ScoreSortKey,
  type SignalMark,
  type StockScore,
  type StockView,
  type StocksViewSettings,
  filterStocks,
  inView,
  markKey,
  nextSort,
  parentGroups,
  rankChange,
  settingsFit,
  sortStocks,
  trendOf,
  viewCounts,
} from '../../../lib/momentumScores';
import {
  SCORE_COLUMNS,
  type ScoreColumn,
  useMomentumScoresStore,
} from '../../../store/momentumScores';
import { useMomentumScoresViewsStore } from '../../../store/momentumScoresViews';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CheckboxMenu } from '../../ui/CheckboxMenu';
import { Input, Select } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { SavedViewsMenu } from './SavedViewsMenu';
import { ScoreStrip, Spark, TrendBadge } from './ScoreStrip';
import { SortTh } from './SortTh';

/** Rows drawn at first and added by each "Show more". */
const PAGE = 100;
const TABLE_MAX_HEIGHT = '70vh';

function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function RankChange({ stock }: { stock: StockScore }) {
  const change = rankChange(stock);
  if (change === null) return <span className="text-faint">{EMPTY}</span>;
  if (change === 0) return <span className="text-faint">–</span>;
  return (
    <span className={change > 0 ? 'text-positive' : 'text-negative'}>
      {change > 0 ? '▲' : '▼'}
      {Math.abs(change)}
    </span>
  );
}

function SignedPct({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-faint">{EMPTY}</span>;
  return (
    <span className={value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : 'text-muted'}>
      {formatPct(value, 1, { sign: true })}
    </span>
  );
}

const StockRow = memo(function StockRow({
  stock,
  lookbacks,
  zone,
  mark,
  hidden,
  active,
  onOpen,
  onSector,
}: {
  stock: StockScore;
  lookbacks: readonly number[];
  zone: BuyZone;
  mark: SignalMark | undefined;
  hidden: ReadonlySet<ScoreColumn>;
  /** The stock whose drawer is open. */
  active: boolean;
  onOpen: ((symbol: string) => void) | undefined;
  onSector: ((stock: StockScore) => void) | undefined;
}) {
  const rank = stock.composite_rank ?? null;
  const edge =
    rank !== null && rank <= zone.topN
      ? 'border-l-primary'
      : rank !== null && rank <= zone.exitRank
        ? 'border-l-primary/40'
        : 'border-l-transparent';
  return (
    <TRow onClick={onOpen ? () => onOpen(stock.symbol) : undefined} selected={active}>
      <Td dense numeric align="right" className={cn('border-l-2', edge)}>
        {rank ?? <span className="text-faint">{EMPTY}</span>}
      </Td>
      <Td dense numeric align="right">
        <RankChange stock={stock} />
      </Td>
      <Td dense className="max-w-[15rem]">
        <span
          className="flex items-center gap-2 truncate"
          title={`${stock.symbol} · ${stock.company_name}`}
        >
          <span className="font-semibold text-foreground">{stock.symbol}</span>
          {mark === 'held' ? (
            <Badge tone="primary">Held</Badge>
          ) : mark === 'candidate' ? (
            <Badge tone="info">Candidate</Badge>
          ) : null}
          <span className="truncate text-xs text-muted">{stock.company_name}</span>
        </span>
      </Td>
      {hidden.has('sector') ? null : (
        <Td dense className="max-w-[8rem] truncate text-muted" title={stock.subgroup}>
          {onSector && stock.subgroup ? (
            <button
              type="button"
              className="max-w-full truncate text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                onSector(stock);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {stock.subgroup}
            </button>
          ) : (
            stock.subgroup || EMPTY
          )}
        </Td>
      )}
      {hidden.has('trend') ? null : (
        <Td dense>
          <TrendBadge trend={trendOf(stock)} />
        </Td>
      )}
      <Td dense>
        <ScoreStrip scores={stock.scores} returns={stock.returns} lookbacks={lookbacks} />
      </Td>
      {hidden.has('spark') ? null : (
        <Td dense>
          <Spark values={stock.spark} label={`${stock.symbol}: last 26 weeks`} />
        </Td>
      )}
      {hidden.has('return13') ? null : (
        <Td dense numeric align="right">
          <SignedPct value={stock.returns['13']} />
        </Td>
      )}
      {hidden.has('return26') ? null : (
        <Td dense numeric align="right">
          <SignedPct value={stock.returns['26']} />
        </Td>
      )}
      {hidden.has('high') ? null : (
        <Td dense numeric align="right">
          {stock.high_52w_gap == null ? (
            <span className="text-faint">{EMPTY}</span>
          ) : stock.high_52w_gap > -0.0005 ? (
            <span className="text-positive">at high</span>
          ) : (
            <span className="text-muted">{formatPct(stock.high_52w_gap, 1)}</span>
          )}
        </Td>
      )}
      {hidden.has('price') ? null : (
        <Td dense numeric align="right">
          {formatInr(stock.last_price, { dp: 2, trim: true })}
        </Td>
      )}
    </TRow>
  );
});

/**
 * Every scored stock, strongest first: Broad Momentum's own ranking with its weekly change, the
 * score strip, trend tag and the context a momentum investor checks before buying. Search (the `/`
 * key focuses it), quick views, a sector filter, optional columns and paged rendering keep it
 * fast with 700+ rows.
 */
export function StocksLeaderboard({
  stocks,
  lookbacks,
  zone,
  marks,
  scoredCount,
  heading,
  chip,
  showGroupFilter = true,
  savedViews = false,
  top,
  activeSymbol = null,
  onOpenStock,
  onOrder,
  onSector,
}: {
  stocks: readonly StockScore[];
  lookbacks: readonly number[];
  zone: BuyZone;
  marks: ReadonlyMap<string, SignalMark> | undefined;
  scoredCount: number;
  /** A title for the card, with the list's size beside it. */
  heading?: string;
  /** A filter applied from outside (a sub-sector), shown as a removable chip. */
  chip?: { label: string; onClear: () => void };
  /** The sector-group filter; off where the list is already one sector. */
  showGroupFilter?: boolean;
  /** The Views menu: named quick view + sector + search + sort combinations kept in the browser. */
  savedViews?: boolean;
  /** Just the strongest `limit` stocks, no search or paging, and a link to the whole list. */
  top?: { limit: number; onShowAll: () => void };
  /** The stock whose drawer is open, lit in the list. */
  activeSymbol?: string | null;
  onOpenStock?: (symbol: string) => void;
  /** Told the symbols in the order shown, so the drawer can step to the next one. */
  onOrder?: (symbols: string[]) => void;
  /** A sector name in a row was clicked. */
  onSector?: (stock: StockScore) => void;
}) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<StockView>('all');
  const [group, setGroup] = useState(ALL_GROUPS);
  const [sort, setSort] = useState<ScoreSort>(DEFAULT_STOCKS_SORT);
  const [shown, setShown] = useState(top?.limit ?? PAGE);
  const searchRef = useRef<HTMLInputElement>(null);
  const hidden = useMomentumScoresStore((state) => state.hidden);
  const setColumnShown = useMomentumScoresStore((state) => state.setColumnShown);
  const views = useMomentumScoresViewsStore((state) => state.views);
  const saveView = useMomentumScoresViewsStore((state) => state.saveView);
  const deleteView = useMomentumScoresViewsStore((state) => state.deleteView);

  const deferredQuery = useDeferredValue(query);
  const counts = useMemo(() => viewCounts(stocks, marks), [stocks, marks]);
  const groups = useMemo(() => parentGroups(stocks), [stocks]);
  const rows = useMemo(
    () =>
      sortStocks(
        filterStocks(
          stocks.filter((stock) => inView(stock, view, marks)),
          { query: deferredQuery, group },
        ),
        sort,
      ),
    [stocks, view, marks, deferredQuery, group, sort],
  );

  const current = useMemo<StocksViewSettings>(
    () => ({ view, group, sort, query }),
    [view, group, sort, query],
  );
  const applySettings = (settings: StocksViewSettings): void => {
    const fit = settingsFit(
      settings,
      groups.map((option) => option.group),
      lookbacks,
    );
    setView(fit.view);
    setGroup(fit.group);
    setSort(fit.sort);
    setQuery(fit.query);
  };

  // Told only when the order really changed: a parent that keeps what it is told in state must
  // not be woken by a list that was rebuilt to the same symbols.
  const toldRef = useRef('');
  useEffect(() => {
    const symbols = rows.map((stock) => stock.symbol);
    const key = symbols.join(',');
    if (key === toldRef.current) return;
    toldRef.current = key;
    onOrder?.(symbols);
  }, [rows, onOrder]);

  // Any change to what is listed starts again from the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the inputs ARE the trigger
  useEffect(() => setShown(top?.limit ?? PAGE), [deferredQuery, view, group, sort, top?.limit]);

  // "/" jumps to the search box, as on most sites, unless you are already typing somewhere.
  const hasSearch = !top;
  useEffect(() => {
    if (!hasSearch) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typingInField(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSearch]);

  const onSort = (key: ScoreSortKey, lookback: number | null): void =>
    setSort((current) => nextSort(current, key, lookback));
  const visibleColumns = new Set<string>(
    SCORE_COLUMNS.filter((column) => !hidden.has(column.id)).map((column) => column.id),
  );
  const sortedByStrip = sort.key === 'score';

  return (
    <section
      aria-label={heading ?? 'Stocks'}
      className="rounded-xl border border-border bg-surface shadow-card"
    >
      {heading ? (
        <header className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <h3 className="text-sm font-semibold text-foreground">{heading}</h3>
          {chip ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs text-primary">
              {chip.label}
              <button
                type="button"
                aria-label={`Remove the ${chip.label} filter`}
                onClick={chip.onClear}
                className="rounded-full p-0.5 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ) : null}
          <span className="text-xs text-faint">
            {top
              ? `top ${formatInt(top.limit)} of ${formatInt(rows.length)} by rank`
              : `${formatInt(rows.length)} of ${formatInt(stocks.length)}`}
          </span>
          {top ? (
            <Button size="sm" variant="secondary" className="ml-auto" onClick={top.onShowAll}>
              All {formatInt(scoredCount)} stocks →
            </Button>
          ) : null}
        </header>
      ) : null}
      {top ? null : (
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
              aria-hidden="true"
            />
            <Input
              ref={searchRef}
              type="search"
              aria-label="Search stocks"
              placeholder="Search symbol, company or sector (/)"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-72 pl-8"
            />
          </div>
          <div className="min-w-0 overflow-x-auto">
            <SegmentedControl
              ariaLabel="Quick view"
              size="sm"
              value={view}
              onChange={setView}
              options={STOCK_VIEWS.map((option) => ({
                value: option.id,
                label: (
                  <span className="whitespace-nowrap">
                    {option.label}{' '}
                    <span className="metric text-faint">{formatInt(counts[option.id])}</span>
                  </span>
                ),
              }))}
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            {showGroupFilter ? (
              <Select
                aria-label="Sector group"
                value={group}
                onChange={(event) => setGroup(event.target.value)}
                className="w-auto max-w-[14rem]"
              >
                <option value={ALL_GROUPS}>All sectors</option>
                {groups.map((option) => (
                  <option key={option.group} value={option.group}>
                    {option.group} ({formatInt(option.count)})
                  </option>
                ))}
              </Select>
            ) : null}
            {savedViews ? (
              <SavedViewsMenu
                views={views}
                current={current}
                onApply={applySettings}
                onSave={(name) => saveView(name, current)}
                onDelete={deleteView}
              />
            ) : null}
            <CheckboxMenu
              ariaLabel="Choose columns"
              heading="Columns"
              trigger={
                <>
                  <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
                  Columns
                </>
              }
              options={SCORE_COLUMNS.map((column) => ({ value: column.id, label: column.label }))}
              checked={visibleColumns}
              onCheckedChange={(value, on) => setColumnShown(value as ScoreColumn, on)}
            />
          </div>
        </div>
      )}

      <Table stickyFirstCol maxHeight={TABLE_MAX_HEIGHT}>
        <THead>
          <SortTh
            sort={sort}
            sortKey="rank"
            onSort={onSort}
            align="right"
            title="Broad Momentum's ranking among the stocks scored here: 1 is the strongest"
          >
            Rank
          </SortTh>
          <Th dense align="right" title="Places gained (up) or lost (down) since last week">
            Δ wk
          </Th>
          <SortTh sort={sort} sortKey="name" onSort={onSort}>
            Stock
          </SortTh>
          {hidden.has('sector') ? null : <Th dense>Sector</Th>}
          {hidden.has('trend') ? null : <Th dense>Trend</Th>}
          <Th
            dense
            aria-sort={sortedByStrip ? (sort.ascending ? 'ascending' : 'descending') : 'none'}
          >
            <span className="flex flex-col gap-0.5">
              <span>Score 1–10 by lookback</span>
              <span className="inline-flex gap-0.5 normal-case tracking-normal">
                {lookbacks.map((weeks) => (
                  <button
                    key={weeks}
                    type="button"
                    onClick={() => onSort('score', weeks)}
                    aria-label={`Sort by the ${weeks}-week score`}
                    title={`Sort by the ${weeks}-week score`}
                    className={cn(
                      'w-6 rounded text-center text-[10px] font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      sortedByStrip && sort.lookback === weeks ? 'text-foreground underline' : '',
                    )}
                  >
                    {weeks}w
                  </button>
                ))}
              </span>
            </span>
          </Th>
          {hidden.has('spark') ? null : <Th dense>26 weeks</Th>}
          {hidden.has('return13') ? null : (
            <SortTh sort={sort} sortKey="return" lookback={13} onSort={onSort} align="right">
              13w
            </SortTh>
          )}
          {hidden.has('return26') ? null : (
            <SortTh sort={sort} sortKey="return" lookback={26} onSort={onSort} align="right">
              26w
            </SortTh>
          )}
          {hidden.has('high') ? null : (
            <SortTh
              sort={sort}
              sortKey="high"
              onSort={onSort}
              align="right"
              title="Distance below the 52-week high (weekly closes)"
            >
              52w high
            </SortTh>
          )}
          {hidden.has('price') ? null : (
            <SortTh sort={sort} sortKey="price" onSort={onSort} align="right">
              Last price
            </SortTh>
          )}
        </THead>
        <tbody>
          {rows.slice(0, shown).map((stock) => (
            <StockRow
              key={stock.symbol}
              stock={stock}
              lookbacks={lookbacks}
              zone={zone}
              mark={marks?.get(markKey(stock.symbol))}
              hidden={hidden}
              active={stock.symbol === activeSymbol}
              onOpen={onOpenStock}
              onSector={onSector}
            />
          ))}
        </tbody>
      </Table>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No stocks match.</p>
      ) : null}

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-3 py-2.5 text-xs text-muted">
        {top ? null : (
          <span>
            Showing {formatInt(Math.min(shown, rows.length))} of {formatInt(rows.length)}
          </span>
        )}
        {!top && rows.length > shown ? (
          <Button size="sm" variant="ghost" onClick={() => setShown((count) => count + PAGE)}>
            Show {formatInt(Math.min(PAGE, rows.length - shown))} more
          </Button>
        ) : null}
        <span className="ml-auto">
          Score 1–10: the decile of the return against all {formatInt(scoredCount)} scored stocks,
          10 the strongest tenth.
        </span>
        <span>
          <span className="mr-1 inline-block h-3 w-0.5 bg-primary align-middle" /> top {zone.topN}{' '}
          buy zone · <span className="mr-1 inline-block h-3 w-0.5 bg-primary/40 align-middle" /> top{' '}
          {zone.exitRank} hold zone (
          {zone.source === 'favourite' ? 'your headline favourite' : "Broad Momentum's defaults"})
        </span>
      </footer>
    </section>
  );
}
