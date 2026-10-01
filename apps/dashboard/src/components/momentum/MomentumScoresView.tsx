'use client';

import { useMemo, useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
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
  return value === null || value === undefined ? '—' : value.toLocaleString('en-IN', { maximumFractionDigits: digits });
}

function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${number(value * 100, digits)}%`;
}

export function MomentumScoresView() {
  const { data, loading, error, refetch } = usePolledResource<MomentumScores>('/api/momentum/scores');
  const [kind, setKind] = useState<'stocks' | 'sectors'>('stocks');
  const [query, setQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [selectedStock, setSelectedStock] = useState<StockScore | null>(null);

  const latestLookback = data?.lookbacks.at(-1);
  const stocks = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.stocks
      .filter((stock) => !needle || `${stock.symbol} ${stock.company_name} ${stock.subgroup}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.scores[String(latestLookback)] ?? -1) - (a.scores[String(latestLookback)] ?? -1));
  }, [data, latestLookback, query]);
  const sectors = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.sectors
      .filter((sector) => !needle || `${sector.subgroup} ${sector.parent_group}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.scores[String(latestLookback)] ?? -1) - (a.scores[String(latestLookback)] ?? -1));
  }, [data, latestLookback, query]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Momentum Scores"
          description={data ? `As of ${data.as_of ?? 'latest data'} · ${data.universe_size} stocks in the universe` : 'Current stock and sector momentum'}
          actions={<Button size="sm" onClick={refetch} disabled={loading}>Refresh</Button>}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={kind === 'stocks' ? 'primary' : 'secondary'} onClick={() => { setKind('stocks'); setSelectedSector(null); }}>Stocks</Button>
          <Button size="sm" variant={kind === 'sectors' ? 'primary' : 'secondary'} onClick={() => { setKind('sectors'); setSelectedStock(null); }}>Sectors</Button>
          <input
            type="search"
            aria-label={`Filter ${kind}`}
            placeholder={`Filter ${kind}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ml-auto min-w-48 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
          />
        </div>
      </Card>

      {error ? <StateMessage variant="error" title="Couldn't load momentum scores" description={error} /> : null}
      {loading && !data ? <p className="text-sm text-muted">Loading momentum scores…</p> : null}
      {data?.missing_symbols.length ? <p className="text-xs text-warning">{data.missing_symbols.length} symbols have no usable price history and are excluded.</p> : null}

      {data && kind === 'stocks' ? (
        <Card>
          <Table>
            <THead><Th>Stock</Th><Th>Sector</Th><Th align="right">Last price</Th><Th align="right">1 week</Th>{data.lookbacks.map((lookback) => <Th key={lookback} align="right">{lookback}w score</Th>)}</THead>
            <tbody>
              {stocks.map((stock) => (
                <TRow key={stock.symbol}>
                  <Td><button type="button" className="text-left text-primary hover:underline" onClick={() => setSelectedStock(stock)}>{stock.symbol}</button><span className="block text-xs text-muted">{stock.company_name}</span></Td>
                  <Td>{stock.subgroup}</Td>
                  <Td align="right" numeric>₹{number(stock.last_price, 2)}</Td>
                  <Td align="right" numeric>{percent(stock.change_1w_pct, 2)}</Td>
                  {data.lookbacks.map((lookback) => <Td key={lookback} align="right" numeric>{number(stock.scores[String(lookback)], 0)}</Td>)}
                </TRow>
              ))}
            </tbody>
          </Table>
          {stocks.length === 0 ? <p className="py-5 text-center text-sm text-muted">No matching stocks.</p> : null}
        </Card>
      ) : null}

      {data && kind === 'sectors' ? (
        <Card>
          <Table>
            <THead><Th>Sector</Th><Th align="right">Members</Th>{data.lookbacks.map((lookback) => <Th key={lookback} align="right">{lookback}w score</Th>)}</THead>
            <tbody>
              {sectors.map((sector) => (
                <TRow key={sector.cid}>
                  <Td><button type="button" className="text-left text-primary hover:underline" onClick={() => setSelectedSector(selectedSector === sector.cid ? null : sector.cid)}>{sector.subgroup}</button><span className="block text-xs text-muted">{sector.parent_group}</span>{selectedSector === sector.cid ? <span className="mt-2 block text-xs text-foreground">{data.stocks.filter((stock) => stock.parent_group === sector.parent_group && stock.subgroup === sector.subgroup).map((stock) => stock.symbol).join(', ') || 'No qualifying members'}</span> : null}</Td>
                  <Td align="right" numeric>{sector.qualifying_count} / {sector.member_count}</Td>
                  {data.lookbacks.map((lookback) => <Td key={lookback} align="right" numeric>{number(sector.scores[String(lookback)], 0)}</Td>)}
                </TRow>
              ))}
            </tbody>
          </Table>
          {sectors.length === 0 ? <p className="py-5 text-center text-sm text-muted">No matching sectors.</p> : null}
        </Card>
      ) : null}

      {selectedStock && kind === 'stocks' ? (
        <Card>
          <CardHeader title={`${selectedStock.symbol} · ${selectedStock.company_name}`} description={`${selectedStock.parent_group} · ${selectedStock.subgroup}`} actions={<Button size="sm" onClick={() => setSelectedStock(null)}>Close</Button>} />
          <div className="grid gap-3 sm:grid-cols-3">
            {data?.lookbacks.map((lookback) => <div key={lookback} className="rounded-lg bg-surface-2/50 p-3 text-sm"><strong>{lookback} week</strong><p>Return: {percent(selectedStock.returns[String(lookback)], 1)}</p><p>Relative score: {number(selectedStock.scores[String(lookback)], 0)}</p></div>)}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
