'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';

import { useAppRoute } from '../../hooks/useAppRoute';
import { usePolledResource } from '../../hooks/usePolledResource';
import { cn } from '../../lib/cn';
import { EMPTY, formatDay, formatInr, formatInt, formatNumber, formatPct } from '../../lib/format';
import {
  ALL_GROUPS,
  type MomentumScores,
  type ScoreSort,
  type ScoreSortKey,
  type SignalMark,
  type StockScore,
  activeSignalFromJob,
  ariaSort,
  filterSectors,
  filterStocks,
  markKey,
  nextSort,
  parentGroups,
  scoreBand,
  sectorMembers,
  signOf,
  sortSectors,
  sortStocks,
} from '../../lib/momentumScores';
import { MOMENTUM_SCORE_KINDS, type MomentumScoreKind, oneOf } from '../../lib/routes';
import type { MomentumSavedRun } from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { InfoTooltip } from '../ui/InfoTooltip';
import { Input, Select } from '../ui/Input';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { MomentumScoresSkeleton } from './MomentumSkeletons';

const SCORE_HELP =
  'Score is a 0–100 percentile: where this return ranks in the eligible universe for that lookback. Higher is better; 100 is the strongest. It is not the backtest signals table’s rank score, where lower is better.';

/** The table scrolls inside the card, so the header and the symbol column stay in view. */
const TABLE_MAX_HEIGHT = '70vh';

const BAND_TONE = {
  weak: 'bg-negative/10 text-negative',
  middle: 'bg-warning/10 text-warning',
  strong: 'bg-positive/10 text-positive',
} as const;

function signTone(value: number | null | undefined): string {
  const sign = signOf(value);
  return sign === 1 ? 'text-positive' : sign === -1 ? 'text-negative' : 'text-muted';
}

function Score({ value }: { value: number | null | undefined }) {
  const band = scoreBand(value);
  if (!band) return <span className="inline-block min-w-9 text-center text-muted">{EMPTY}</span>;
  return (
    <span
      className={cn(
        'inline-block min-w-9 rounded px-1.5 py-0.5 text-center font-semibold',
        BAND_TONE[band],
      )}
    >
      {formatNumber(value, 0)}
    </span>
  );
}

/** A signed percentage coloured by its sign. */
function SignedPct({
  value,
  dp,
  className,
}: {
  value: number | null | undefined;
  dp: number;
  className?: string;
}) {
  return (
    <span className={cn(signTone(value), className)}>{formatPct(value, dp, { sign: true })}</span>
  );
}

/** One lookback: the 0–100 score pill, with the raw return beside it when the row has one. */
function LookbackCell({ score, ret }: { score: number | null | undefined; ret?: number | null }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <Score value={score} />
      {ret !== undefined ? <SignedPct value={ret} dp={1} className="w-16 text-xs" /> : null}
    </span>
  );
}

function MarkBadge({ mark }: { mark: SignalMark | undefined }) {
  if (!mark) return null;
  return mark === 'held' ? (
    <Badge tone="primary">Held</Badge>
  ) : (
    <Badge tone="info">Candidate</Badge>
  );
}

/** A sortable column header: an arrow for the active column, a neutral glyph otherwise. */
function SortTh({
  children,
  sort,
  sortKey,
  lookback = null,
  onSort,
  align = 'left',
  title,
}: {
  children: ReactNode;
  sort: ScoreSort;
  sortKey: ScoreSortKey;
  lookback?: number | null;
  onSort: (key: ScoreSortKey, lookback: number | null) => void;
  align?: 'left' | 'right';
  title?: string;
}) {
  const state = ariaSort(sort, sortKey, lookback);
  const Icon =
    state === 'ascending' ? ArrowUp : state === 'descending' ? ArrowDown : ChevronsUpDown;
  return (
    <Th align={align} aria-sort={state}>
      <button
        type="button"
        title={title}
        onClick={() => onSort(sortKey, lookback)}
        className={cn(
          'inline-flex items-center gap-1 rounded uppercase tracking-wider transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          state !== 'none' && 'text-foreground',
        )}
      >
        {children}
        <Icon
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0', state === 'none' && 'opacity-50')}
        />
      </button>
    </Th>
  );
}

export function MomentumScoresView() {
  // Cached: the ~300 KB payload changes once a day, so coming back to this section shows the last
  // copy straight away while it revalidates.
  const { data, loading, error, refetch } = usePolledResource<MomentumScores>(
    '/api/momentum/scores',
    { cache: true },
  );
  // Read-only: the most recent manual weekly run this service still remembers. It is the only
  // GET that carries a signal's rows; nothing here ever starts a run.
  const latestJob = usePolledResource<unknown>('/api/momentum/weekly/jobs/latest');
  const favorites = usePolledResource<MomentumSavedRun[]>('/api/momentum/favorite-strategies', {
    cache: true,
  });
  const { rest, navigate } = useAppRoute();
  const kind: MomentumScoreKind = oneOf(MOMENTUM_SCORE_KINDS, rest[1]) ?? 'stocks';
  const setKind = (next: MomentumScoreKind) => navigate('momentum', 'scores', next);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>(ALL_GROUPS);
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [chosenSort, setChosenSort] = useState<ScoreSort>({
    key: 'score',
    lookback: null,
    ascending: false,
  });

  // The sort in force: a column the current table lacks, or a lookback the payload lacks, falls
  // back to the longest lookback's score, strongest first.
  const lookbacks = data?.lookbacks;
  const sort = useMemo<ScoreSort>(() => {
    const longest = lookbacks?.at(-1) ?? null;
    const applies =
      chosenSort.key === 'name' ||
      chosenSort.key === 'score' ||
      (kind === 'stocks' ? chosenSort.key !== 'members' : chosenSort.key === 'members');
    if (!applies) return { key: 'score', lookback: longest, ascending: false };
    if (chosenSort.key !== 'score') return chosenSort;
    const known = chosenSort.lookback !== null && lookbacks?.includes(chosenSort.lookback);
    return known ? chosenSort : { ...chosenSort, lookback: longest };
  }, [chosenSort, kind, lookbacks]);
  const onSort = (key: ScoreSortKey, lookback: number | null) =>
    setChosenSort(nextSort(sort, key, lookback));

  const groups = useMemo(
    () => (data ? parentGroups(kind === 'stocks' ? data.stocks : data.sectors) : []),
    [data, kind],
  );
  const activeGroup = groups.some((option) => option.group === group) ? group : ALL_GROUPS;
  const stocks = useMemo(
    () => (data ? sortStocks(filterStocks(data.stocks, { query, group: activeGroup }), sort) : []),
    [data, query, activeGroup, sort],
  );
  const sectors = useMemo(
    () =>
      data ? sortSectors(filterSectors(data.sectors, { query, group: activeGroup }), sort) : [],
    [data, query, activeGroup, sort],
  );

  const activeSignal = useMemo(() => activeSignalFromJob(latestJob.data), [latestJob.data]);
  const marks = activeSignal?.marks;
  const markOf = (stock: StockScore) => marks?.get(markKey(stock.symbol));
  const markCounts = useMemo(() => {
    let held = 0;
    let candidate = 0;
    for (const stock of data?.stocks ?? []) {
      const mark = marks?.get(markKey(stock.symbol));
      if (mark === 'held') held += 1;
      else if (mark === 'candidate') candidate += 1;
    }
    return { held, candidate };
  }, [data, marks]);
  const activeFavorite = favorites.data?.find((favorite) => favorite.active);
  const signalNote = (() => {
    if (activeSignal) {
      if (activeSignal.blocked)
        return `${activeSignal.name} produced no signal in the latest weekly run, so no rows are marked Held or Candidate.`;
      if (markCounts.held + markCounts.candidate === 0)
        return `${activeSignal.name}’s latest signal names nothing listed here (it trades other instruments), so no rows are marked Held or Candidate.`;
      return `Marked from ${activeSignal.name}’s signal for the week ending ${formatDay(activeSignal.week)}: ${formatInt(markCounts.held)} held, ${formatInt(markCounts.candidate)} candidates.`;
    }
    if (latestJob.loading || favorites.loading) return null;
    return activeFavorite
      ? `Held and Candidate marks come from ${activeFavorite.name}’s latest weekly run, and no run result is available right now. They appear after the next run from Weekly signal.`
      : 'Held and Candidate marks need an active favourite strategy and a weekly run; neither is available right now.';
  })();

  const matching = kind === 'stocks' ? stocks.length : sectors.length;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Momentum Scores"
          description={
            data
              ? `Prices as of ${data.as_of ? formatDay(data.as_of) : 'latest data'} · ${formatInt(data.stocks.length)} scored of ${formatInt(data.universe_size)} stocks`
              : 'Current stock and sector momentum'
          }
          actions={<RefreshButton onClick={refetch} loading={loading} />}
        />
        <p className="mb-3 flex flex-wrap items-center gap-1.5 text-sm text-muted">
          <span>
            Score is a 0–100 percentile of the return against the eligible universe for that
            lookback: higher is better.
          </span>
          <InfoTooltip text={SCORE_HELP} label="About Score" />
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            ariaLabel="Score kind"
            size="sm"
            value={kind}
            options={[
              { value: 'stocks', label: 'Stocks' },
              { value: 'sectors', label: 'Sectors' },
            ]}
            onChange={(next) => {
              setKind(next);
              if (next === 'stocks') setSelectedSector(null);
            }}
          />
          <Select
            aria-label="Parent group"
            value={activeGroup}
            onChange={(event) => setGroup(event.target.value)}
            className="ml-auto w-auto max-w-full"
            disabled={!data}
          >
            <option value={ALL_GROUPS}>All groups</option>
            {groups.map((option) => (
              <option key={option.group} value={option.group}>
                {option.group} ({formatInt(option.count)})
              </option>
            ))}
          </Select>
          <Input
            type="search"
            aria-label={`Filter ${kind}`}
            placeholder={`Filter ${kind}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-auto min-w-48"
          />
        </div>
        {data ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>0–40 weaker · 41–60 middle · 61–100 stronger</span>
            <span>The 4, 13 and 26 week windows approximate 1, 3 and 6 months</span>
            <span>
              {formatInt(matching)} matching {kind}
            </span>
          </div>
        ) : null}
        {data && signalNote ? <p className="mt-2 text-xs text-muted">{signalNote}</p> : null}
      </Card>

      {error ? (
        <StateMessage variant="error" title="Couldn't load momentum scores" description={error} />
      ) : null}
      {loading && !data && !error ? <MomentumScoresSkeleton /> : null}
      {data?.missing_symbols.length ? (
        <details className="text-xs text-warning">
          <summary>
            {formatInt(data.missing_symbols.length)} symbols have no usable price history and are
            excluded
          </summary>
          <p className="mt-1 text-muted">{data.missing_symbols.join(', ')}</p>
        </details>
      ) : null}

      {data && kind === 'stocks' ? (
        <Card>
          <Table stickyFirstCol maxHeight={TABLE_MAX_HEIGHT}>
            <THead>
              <SortTh sort={sort} sortKey="name" onSort={onSort}>
                Stock
              </SortTh>
              <Th>Sector</Th>
              <SortTh sort={sort} sortKey="price" onSort={onSort} align="right">
                Last price
              </SortTh>
              <SortTh sort={sort} sortKey="change" onSort={onSort} align="right">
                1 week
              </SortTh>
              {data.lookbacks.map((weeks) => (
                <SortTh
                  key={weeks}
                  sort={sort}
                  sortKey="score"
                  lookback={weeks}
                  onSort={onSort}
                  align="right"
                  title={`Sort by the ${weeks} week Score (0–100 percentile, higher is better). The return over the same ${weeks} weeks is shown beside it.`}
                >
                  {weeks}w score · return
                </SortTh>
              ))}
            </THead>
            <tbody>
              {stocks.map((stock) => (
                <TRow key={stock.symbol}>
                  <Td>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{stock.symbol}</span>
                      <MarkBadge mark={markOf(stock)} />
                    </span>
                    <span className="block text-xs text-muted">{stock.company_name}</span>
                  </Td>
                  <Td>
                    {stock.subgroup}
                    <span className="block text-xs text-muted">{stock.parent_group}</span>
                  </Td>
                  <Td align="right" numeric>
                    {formatInr(stock.last_price, { dp: 2, trim: true })}
                  </Td>
                  <Td align="right" numeric>
                    <SignedPct value={stock.change_1w_pct} dp={2} />
                  </Td>
                  {data.lookbacks.map((weeks) => (
                    <Td key={weeks} align="right" numeric>
                      <LookbackCell
                        score={stock.scores[String(weeks)]}
                        ret={stock.returns[String(weeks)] ?? null}
                      />
                    </Td>
                  ))}
                </TRow>
              ))}
            </tbody>
          </Table>
          {stocks.length === 0 ? (
            <p className="py-5 text-center text-sm text-muted">No matching stocks.</p>
          ) : null}
        </Card>
      ) : null}

      {data && kind === 'sectors' ? (
        <Card>
          <Table stickyFirstCol maxHeight={TABLE_MAX_HEIGHT}>
            <THead>
              <SortTh sort={sort} sortKey="name" onSort={onSort}>
                Sector
              </SortTh>
              <SortTh sort={sort} sortKey="members" onSort={onSort} align="right">
                Members
              </SortTh>
              {data.lookbacks.map((weeks) => (
                <SortTh
                  key={weeks}
                  sort={sort}
                  sortKey="score"
                  lookback={weeks}
                  onSort={onSort}
                  align="right"
                  title={`Sort by the ${weeks} week Score (0–100, higher is better)`}
                >
                  {weeks}w score
                </SortTh>
              ))}
            </THead>
            <tbody>
              {sectors.map((sector) => (
                <Fragment key={sector.cid}>
                  <TRow>
                    <Td>
                      <button
                        type="button"
                        className="text-left text-primary hover:underline"
                        aria-expanded={selectedSector === sector.cid}
                        onClick={() =>
                          setSelectedSector(selectedSector === sector.cid ? null : sector.cid)
                        }
                      >
                        {selectedSector === sector.cid ? '▾' : '▸'} {sector.subgroup}
                      </button>
                      <span className="block text-xs text-muted">{sector.parent_group}</span>
                    </Td>
                    <Td align="right" numeric>
                      {formatInt(sector.qualifying_count)} / {formatInt(sector.member_count)}
                    </Td>
                    {data.lookbacks.map((weeks) => (
                      <Td key={weeks} align="right" numeric>
                        <LookbackCell score={sector.scores[String(weeks)]} />
                      </Td>
                    ))}
                  </TRow>
                  {selectedSector === sector.cid ? (
                    <tr>
                      <td colSpan={2 + data.lookbacks.length} className="p-0">
                        <div className="overflow-x-auto border-l-2 border-primary/30 px-3 py-3">
                          <table className="w-full min-w-[640px] text-xs">
                            <thead>
                              <tr className="text-left text-muted">
                                <th className="bg-surface pb-2">Member stock</th>
                                <th className="pb-2 text-right">Last price</th>
                                <th className="pb-2 text-right">1 week</th>
                                {data.lookbacks.map((weeks) => (
                                  <th key={weeks} className="pb-2 text-right">
                                    {weeks}w score · return
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {sectorMembers(data.stocks, sector).map((stock) => (
                                <tr key={stock.symbol} className="border-t border-border/50">
                                  <td className="py-1.5">
                                    <span className="flex flex-wrap items-center gap-2">
                                      <span>
                                        {stock.symbol} · {stock.company_name}
                                      </span>
                                      <MarkBadge mark={markOf(stock)} />
                                    </span>
                                  </td>
                                  <td className="py-1.5 text-right font-mono tabular-nums">
                                    {formatInr(stock.last_price, { dp: 2, trim: true })}
                                  </td>
                                  <td className="py-1.5 text-right font-mono tabular-nums">
                                    <SignedPct value={stock.change_1w_pct} dp={2} />
                                  </td>
                                  {data.lookbacks.map((weeks) => (
                                    <td
                                      key={weeks}
                                      className="py-1.5 text-right font-mono tabular-nums"
                                    >
                                      <LookbackCell
                                        score={stock.scores[String(weeks)]}
                                        ret={stock.returns[String(weeks)] ?? null}
                                      />
                                    </td>
                                  ))}
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
          {sectors.length === 0 ? (
            <p className="py-5 text-center text-sm text-muted">No matching sectors.</p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
