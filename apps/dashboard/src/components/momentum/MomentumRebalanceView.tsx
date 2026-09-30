'use client';

import { useState } from 'react';

import { apiPost } from '../../lib/api';
import type { MomentumRebalanceResult } from '../../types/momentum';
import { FyersAuthCard } from '../FyersAuthCard';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StateMessage } from '../ui/StateMessage';

function parseHoldings(input: string): Record<string, number> {
  const holdings: Record<string, number> = {};
  for (const [index, raw] of input.split('\n').entries()) {
    if (!raw.trim()) continue;
    const pieces = raw.split(',');
    const name = pieces[0]?.trim();
    const weight = Number(pieces[1]?.trim());
    if (pieces.length !== 2 || !name || !Number.isFinite(weight) || weight < 0 || weight > 100) {
      throw new Error(`Line ${index + 1}: enter an asset identifier and percentage, separated by a comma.`);
    }
    if (Object.hasOwn(holdings, name)) throw new Error(`Duplicate holding: ${name}.`);
    holdings[name] = weight;
  }
  if (Object.values(holdings).reduce((sum, weight) => sum + weight, 0) > 100.0001) {
    throw new Error('Current holding percentages total more than 100%.');
  }
  return holdings;
}

export function MomentumRebalanceView({ dataset, buildConfig, onChooseDataset }: {
  dataset: 'etf' | 'stock' | 'custom_index' | 'broad';
  buildConfig: () => Record<string, unknown>;
  onChooseDataset: (value: 'stock' | 'broad') => void;
}) {
  const [holdingsText, setHoldingsText] = useState('');
  const [portfolioValue, setPortfolioValue] = useState('100000');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<MomentumRebalanceResult | null>(null);

  async function preview(): Promise<void> {
    setError(null);
    setPlan(null);
    try {
      const holdings = parseHoldings(holdingsText);
      const capital = Number(portfolioValue);
      if (!Number.isFinite(capital) || capital <= 0) throw new Error('Enter a positive portfolio value.');
      const config = buildConfig();
      setRunning(true);
      const response = await apiPost<MomentumRebalanceResult>('/api/momentum/rebalance-preview', {
        ...config, holdings_pct: holdings, portfolio_value: capital, auth_source: 'dashboard',
      });
      if (!response.ok) setError(response.error);
      else setPlan(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <FyersAuthCard />
      <Card>
        <CardHeader title="Rebalance now" description="Compare your actual holdings with a model target using live Fyers last traded prices. This is a read-only preview; it never places orders." />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={dataset === 'stock' ? 'primary' : 'ghost'} onClick={() => onChooseDataset('stock')}>Nifty 50 Stocks</Button>
          <Button size="sm" variant={dataset === 'broad' ? 'primary' : 'ghost'} onClick={() => onChooseDataset('broad')}>Broad Momentum</Button>
        </div>
        <p className="mt-3 text-xs text-muted">Uses the strategy settings selected in Backtest. Available during NSE market hours (09:15–15:30 IST). Authenticate with Fyers in the dashboard first if your session has expired.</p>
      </Card>
      <Card>
        <CardHeader title="Current portfolio" description="Enter each holding as an asset identifier and its current percentage, one per line. Any remainder is treated as idle cash." />
        <div className="grid gap-4 lg:grid-cols-3">
          <label className="text-xs text-muted lg:col-span-2">Holdings (asset, percent)
            <textarea className="mt-1 h-40 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground" value={holdingsText} onChange={(event) => setHoldingsText(event.target.value)} placeholder={dataset === 'broad' ? 'RELIANCE, 20\nTCS, 15' : 'C0001, 20\nGold, 15'} />
          </label>
          <label className="text-xs text-muted">Total portfolio value (₹)
            <input className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground" type="number" min="0.01" step="0.01" value={portfolioValue} onChange={(event) => setPortfolioValue(event.target.value)} />
          </label>
        </div>
        <Button className="mt-4" variant="primary" disabled={running || (dataset !== 'stock' && dataset !== 'broad')} onClick={() => void preview()}>
          {running ? 'Collecting LTPs and computing target…' : 'Preview rebalance'}
        </Button>
      </Card>
      {error ? <StateMessage variant="error" title="Rebalance preview unavailable" description={error} /> : null}
      {plan ? <Card>
        <CardHeader title="Indicative changes" description={`${plan.price_source} · ${new Date(plan.as_of).toLocaleString('en-IN')} · Signal week ${plan.signal_week}`} />
        {plan.rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted"><tr><th className="py-2 pr-3">Action</th><th className="py-2 pr-3">Asset / symbol</th><th className="py-2 pr-3 text-right">Current</th><th className="py-2 pr-3 text-right">Target</th><th className="py-2 pr-3 text-right">Change</th><th className="py-2 pr-3 text-right">LTP</th><th className="py-2 text-right">Indicative shares</th></tr></thead>
          <tbody>{plan.rows.map((row) => <tr key={row.asset} className="border-b border-border/50"><td className="py-2 pr-3 font-medium">{row.action}</td><td className="py-2 pr-3">{row.asset}<span className="block text-xs text-muted">{row.symbol ?? 'Cash allocation'}</span></td><td className="py-2 pr-3 text-right">{row.current_pct.toFixed(2)}%</td><td className="py-2 pr-3 text-right">{row.target_pct.toFixed(2)}%</td><td className="py-2 pr-3 text-right">{row.delta_pct > 0 ? '+' : ''}{row.delta_pct.toFixed(2)} pp</td><td className="py-2 pr-3 text-right">{row.ltp === null ? '—' : `₹${row.ltp.toLocaleString('en-IN')}`}</td><td className="py-2 text-right">{row.indicative_quantity ?? '—'}</td></tr>)}</tbody>
        </table></div> : <p className="text-sm text-muted">No weight changes are indicated.</p>}
        <p className="mt-4 text-xs text-muted">{plan.note}</p>
      </Card> : null}
    </div>
  );
}
