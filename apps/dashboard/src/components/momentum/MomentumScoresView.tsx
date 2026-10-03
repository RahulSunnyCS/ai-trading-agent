'use client';

import { Fragment, useMemo, useState } from 'react';

import { useAppRoute } from '../../hooks/useAppRoute';
import { usePolledResource } from '../../hooks/usePolledResource';
import { MOMENTUM_SCORE_KINDS, type MomentumScoreKind, oneOf } from '../../lib/routes';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

interface StockScore {
  symbol: string;
  company_name: string;
  parent_group: string;
  subgroup: string;
  last_price: number | null;
  change_1w_pct: number | null;
  returns: Record<string, number | null>;
  scores: Record<string, number | null>;
}

interface SectorScore {
  cid: string;
  parent_group: string;
  subgroup: string;
  member_count: number;
  qualifying_count: number;
  scores: Record<string, number | null>;
}

interface MomentumScores {
  as_of: string | null;
  universe_size: number;
  lookbacks: number[];
  missing_symbols: string[];
  stocks: StockScore[];
  sectors: SectorScore[];
}

function number(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined
    ? '—'
    : value.toLocaleString('en-IN', { maximumFractionDigits: digits });
}

function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${number(value * 100, digits)}%`;
}

function Score({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  const tone =
    value <= 40
      ? 'bg-negative/10 text-negative'
      : value <= 60
        ? 'bg-warning/10 text-warning'
        : 'bg-positive/10 text-positive';
  return (
    <span
      className={`inline-block min-w-9 rounded px-1.5 py-0.5 text-center font-semibold ${tone}`}
    >
      {number(value, 0)}
    </span>
  );
}

type SortKey = 'score' | 'name' | 'change' | 'price' | 'members';

function compareNumbers(
  a: number | null | undefined,
  b: number | null | undefined,
  ascending: boolean,
): number {
  if (a == null) return 1;
  if (b == null) return -1;
  return ascending ? a - b : b - a;
}

export function MomentumScoresView() {
  const { data, loading, error, refetch } =
    usePolledResource<MomentumScores>('/api/momentum/scores');
  const { rest, navigate } = useAppRoute();
  const kind: MomentumScoreKind = oneOf(MOMENTUM_SCORE_KINDS, rest[1]) ?? 'stocks';
  const setKind = (next: MomentumScoreKind) => navigate('momentum', 'scores', next);
  const [query, setQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [selectedStock, setSelectedStock] = useState<StockScore | null>(null);
  const [lookback, setLookback] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [ascending, setAscending] = useState(false);

  const activeLookback =
    lookback && data?.lookbacks.includes(lookback) ? lookback : data?.lookbacks.at(-1);
  function chooseSort(key: SortKey) {
    if (sortKey === key) setAscending((value) => !value);
    else {
      setSortKey(key);
      setAscending(key === 'name');
    }
  }
  const stocks = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.stocks
      .filter(
        (stock) =>
          !needle ||
          `${stock.symbol} ${stock.company_name} ${stock.subgroup}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        if (sortKey === 'name')
          return ascending ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol);
        if (sortKey === 'change')
          return compareNumbers(a.change_1w_pct, b.change_1w_pct, ascending);
        if (sortKey === 'price') return compareNumbers(a.last_price, b.last_price, ascending);
        return compareNumbers(
          a.scores[String(activeLookback)],
          b.scores[String(activeLookback)],
          ascending,
        );
      });
  }, [data, activeLookback, query, sortKey, ascending]);
  const sectors = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.sectors
      .filter(
        (sector) =>
          !needle || `${sector.subgroup} ${sector.parent_group}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        if (sortKey === 'name')
          return ascending
            ? a.subgroup.localeCompare(b.subgroup)
            : b.subgroup.localeCompare(a.subgroup);
        if (sortKey === 'members')
          return compareNumbers(a.qualifying_count, b.qualifying_count, ascending);
        return compareNumbers(
          a.scores[String(activeLookback)],
          b.scores[String(activeLookback)],
          ascending,
        );
      });
  }, [data, activeLookback, query, sortKey, ascending]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Momentum Scores"
          description={
            data
              ? `Prices as of ${data.as_of ?? 'latest data'} · ${data.stocks.length} scored of ${data.universe_size} stocks`
              : 'Current stock and sector momentum'
          }
          actions={
            <Button size="sm" onClick={refetch} disabled={loading}>
              Refresh
            </Button>
          }
        />
        <p className="mb-3 text-sm text-muted">
          Each 0–100 score ranks a stock’s return against the eligible universe for that lookback.
          100 is strongest. The 4, 13 and 26 week windows approximate 1, 3 and 6 months.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={kind === 'stocks' ? 'primary' : 'secondary'}
            onClick={() => {
              setKind('stocks');
              setSelectedSector(null);
            }}
          >
            Stocks
          </Button>
          <Button
            size="sm"
            variant={kind === 'sectors' ? 'primary' : 'secondary'}
            onClick={() => {
              setKind('sectors');
              setSelectedStock(null);
            }}
          >
            Sectors
          </Button>
          <input
            type="search"
            aria-label={`Filter ${kind}`}
            placeholder={`Filter ${kind}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ml-auto min-w-48 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
          />
        </div>
        {data ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
            <label>
              Rank by{' '}
              <select
                aria-label="Score lookback"
                value={activeLookback}
                onChange={(event) => {
                  setLookback(Number(event.target.value));
                  setSortKey('score');
                  setAscending(false);
                }}
                className="rounded border border-border bg-surface px-2 py-1 text-foreground"
              >
                {data.lookbacks.map((weeks) => (
                  <option key={weeks} value={weeks}>
                    {weeks} weeks
                  </option>
                ))}
              </select>
            </label>
            <span>0–40 weaker · 41–60 middle · 61–100 stronger</span>
            <span>
              {kind === 'stocks' ? stocks.length : sectors.length} matching {kind}
            </span>
          </div>
        ) : null}
      </Card>

      {error ? (
        <StateMessage variant="error" title="Couldn't load momentum scores" description={error} />
      ) : null}
      {loading && !data ? <p className="text-sm text-muted">Loading momentum scores…</p> : null}
      {data?.missing_symbols.length ? (
        <details className="text-xs text-warning">
          <summary>
            {data.missing_symbols.length} symbols have no usable price history and are excluded
          </summary>
          <p className="mt-1 text-muted">{data.missing_symbols.join(', ')}</p>
        </details>
      ) : null}

      {data && kind === 'stocks' ? (
        <Card>
          <Table>
            <THead>
              <Th
                aria-sort={sortKey === 'name' ? (ascending ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" onClick={() => chooseSort('name')}>
                  Stock ↕
                </button>
              </Th>
              <Th>Sector</Th>
              <Th
                align="right"
                aria-sort={sortKey === 'price' ? (ascending ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" onClick={() => chooseSort('price')}>
                  Last price ↕
                </button>
              </Th>
              <Th
                align="right"
                aria-sort={sortKey === 'change' ? (ascending ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" onClick={() => chooseSort('change')}>
                  1 week ↕
                </button>
              </Th>
              {data.lookbacks.map((lookback) => (
                <Th
                  key={lookback}
                  align="right"
                  aria-sort={
                    sortKey === 'score' && activeLookback === lookback
                      ? ascending
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (sortKey === 'score' && activeLookback === lookback)
                        setAscending((value) => !value);
                      else {
                        setLookback(lookback);
                        setSortKey('score');
                        setAscending(false);
                      }
                    }}
                  >
                    {lookback}w score ↕
                  </button>
                </Th>
              ))}
            </THead>
            <tbody>
              {stocks.map((stock) => (
                <Fragment key={stock.symbol}>
                  <TRow>
                    <Td>
                      <button
                        type="button"
                        className="text-left text-primary hover:underline"
                        aria-expanded={selectedStock?.symbol === stock.symbol}
                        onClick={() =>
                          setSelectedStock(selectedStock?.symbol === stock.symbol ? null : stock)
                        }
                      >
                        {selectedStock?.symbol === stock.symbol ? '▾' : '▸'} {stock.symbol}
                      </button>
                      <span className="block text-xs text-muted">{stock.company_name}</span>
                    </Td>
                    <Td>{stock.subgroup}</Td>
                    <Td align="right" numeric>
                      ₹{number(stock.last_price, 2)}
                    </Td>
                    <Td align="right" numeric>
                      {percent(stock.change_1w_pct, 2)}
                    </Td>
                    {data.lookbacks.map((lookback) => (
                      <Td key={lookback} align="right" numeric>
                        <Score value={stock.scores[String(lookback)]} />
                      </Td>
                    ))}
                  </TRow>
                  {selectedStock?.symbol === stock.symbol ? (
                    <tr>
                      <td colSpan={4 + data.lookbacks.length} className="bg-surface-2/30 px-3 py-3">
                        <p className="mb-2 text-xs text-muted">
                          {stock.parent_group} · {stock.subgroup}
                        </p>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {data.lookbacks.map((weeks) => (
                            <div
                              key={weeks}
                              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                            >
                              <strong>{weeks} week return</strong>
                              <p>
                                {percent(stock.returns[String(weeks)], 1)} · relative score{' '}
                                {number(stock.scores[String(weeks)], 0)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
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
          <Table>
            <THead>
              <Th
                aria-sort={sortKey === 'name' ? (ascending ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" onClick={() => chooseSort('name')}>
                  Sector ↕
                </button>
              </Th>
              <Th
                align="right"
                aria-sort={
                  sortKey === 'members' ? (ascending ? 'ascending' : 'descending') : 'none'
                }
              >
                <button type="button" onClick={() => chooseSort('members')}>
                  Members ↕
                </button>
              </Th>
              {data.lookbacks.map((lookback) => (
                <Th
                  key={lookback}
                  align="right"
                  aria-sort={
                    sortKey === 'score' && activeLookback === lookback
                      ? ascending
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (sortKey === 'score' && activeLookback === lookback)
                        setAscending((value) => !value);
                      else {
                        setLookback(lookback);
                        setSortKey('score');
                        setAscending(false);
                      }
                    }}
                  >
                    {lookback}w score ↕
                  </button>
                </Th>
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
                      {sector.qualifying_count} / {sector.member_count}
                    </Td>
                    {data.lookbacks.map((lookback) => (
                      <Td key={lookback} align="right" numeric>
                        <Score value={sector.scores[String(lookback)]} />
                      </Td>
                    ))}
                  </TRow>
                  {selectedSector === sector.cid ? (
                    <tr>
                      <td colSpan={2 + data.lookbacks.length} className="bg-surface-2/30 px-3 py-3">
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[520px] text-xs">
                            <thead>
                              <tr className="text-left text-muted">
                                <th className="pb-2">Member stock</th>
                                <th className="pb-2 text-right">Last price</th>
                                <th className="pb-2 text-right">1 week</th>
                                {data.lookbacks.map((weeks) => (
                                  <th key={weeks} className="pb-2 text-right">
                                    {weeks}w score
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {data.stocks
                                .filter(
                                  (stock) =>
                                    stock.parent_group === sector.parent_group &&
                                    stock.subgroup === sector.subgroup,
                                )
                                .map((stock) => (
                                  <tr key={stock.symbol} className="border-t border-border/50">
                                    <td className="py-1.5">
                                      {stock.symbol} · {stock.company_name}
                                    </td>
                                    <td className="py-1.5 text-right">
                                      ₹{number(stock.last_price, 2)}
                                    </td>
                                    <td className="py-1.5 text-right">
                                      {percent(stock.change_1w_pct, 2)}
                                    </td>
                                    {data.lookbacks.map((weeks) => (
                                      <td key={weeks} className="py-1.5 text-right">
                                        <Score value={stock.scores[String(weeks)]} />
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
