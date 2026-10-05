'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { apiGet, apiPost } from '../../lib/api';
import { describeConfig } from '../../lib/momentumConfig';
import type { MomentumRebalanceResult, MomentumSavedRun } from '../../types/momentum';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StateMessage } from '../ui/StateMessage';

type Dataset = 'stock' | 'broad';
type Holding = { id: number; asset: string; percent: string };
type Meta = {
  defaults: Record<string, unknown>;
  instruments: Array<{
    name: string;
    display_name?: string | null;
    has_data: boolean;
    include: string;
  }>;
  last_week: string;
};
type Scores = { stocks: Array<{ symbol: string; company_name: string }> };

function indiaToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function displayDate(value: string | null): string {
  if (!value) return 'none yet';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-IN', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
}

function cadenceLabel(schedule: MomentumRebalanceResult['rebalance_schedule']): string {
  if (!schedule) return 'Unknown cadence';
  if (schedule.cadence === 'monthly') return 'Monthly';
  return schedule.interval_weeks === 1
    ? 'Every week'
    : `Every ${schedule.interval_weeks ?? '—'} weeks`;
}

function parseHoldings(rows: Holding[]): Record<string, number> {
  const holdings: Record<string, number> = {};
  for (const [index, row] of rows.entries()) {
    const name = row.asset.trim();
    const weight = Number(row.percent);
    if (!name && !row.percent.trim()) continue;
    if (!name || !row.percent.trim() || !Number.isFinite(weight) || weight < 0 || weight > 100) {
      throw new Error(
        `Holding ${index + 1}: choose an asset and enter a percentage from 0 to 100.`,
      );
    }
    if (Object.hasOwn(holdings, name)) throw new Error(`Duplicate holding: ${name}.`);
    holdings[name] = weight;
  }
  if (Object.values(holdings).reduce((sum, weight) => sum + weight, 0) > 100.0001) {
    throw new Error('Current holding percentages total more than 100%.');
  }
  return holdings;
}

export function MomentumRebalanceView({
  currentBroadConfig,
}: {
  currentBroadConfig: Record<string, unknown> | null;
}) {
  const [dataset, setDataset] = useState<Dataset>('broad');
  const [choice, setChoice] = useState('default');
  const [runs, setRuns] = useState<MomentumSavedRun[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ value: string; label: string }>>([]);
  const [holdings, setHoldings] = useState<Holding[]>([{ id: 0, asset: '', percent: '' }]);
  const [nextId, setNextId] = useState(1);
  const [portfolioValue, setPortfolioValue] = useState('100000');
  const [strategyStartDate, setStrategyStartDate] = useState(indiaToday);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<MomentumRebalanceResult | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setChoice('default');
    setPlan(null);
    void Promise.all([
      apiGet<MomentumSavedRun[]>(`/api/momentum/saved-runs?dataset=${dataset}`),
      apiGet<Meta>(`/api/momentum/meta?dataset=${dataset}`),
      dataset === 'broad' ? apiGet<Scores>('/api/momentum/scores') : Promise.resolve(null),
    ]).then(([saved, metadata, scores]) => {
      if (!alive) return;
      setRuns(saved.ok ? saved.data : []);
      setMeta(metadata.ok ? metadata.data : null);
      setSuggestions(
        dataset === 'broad'
          ? scores?.ok
            ? scores.data.stocks.map((item) => ({ value: item.symbol, label: item.company_name }))
            : []
          : metadata.ok
            ? metadata.data.instruments
                .filter((item) => item.has_data)
                .map((item) => ({ value: item.name, label: item.display_name ?? item.name }))
            : [],
      );
      setLoadError(!metadata.ok ? metadata.error : !saved.ok ? saved.error : null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [dataset]);

  const selectedRun = runs.find((run) => run.id === choice);
  const config = useMemo(() => {
    if (choice === 'current') return currentBroadConfig;
    if (selectedRun) return selectedRun.config;
    if (!meta) return null;
    return {
      ...meta.defaults,
      dataset,
      universe:
        dataset === 'broad'
          ? ['broad_momentum']
          : meta.instruments
              .filter((item) => item.has_data && item.include !== 'optional')
              .map((item) => item.name),
    };
  }, [choice, currentBroadConfig, dataset, meta, selectedRun]);
  const described = useMemo(
    () => (config ? describeConfig(config, dataset) : null),
    [config, dataset],
  );
  const allocated = holdings.reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
  const cash = 100 - allocated;

  function updateHolding(id: number, patch: Partial<Holding>) {
    setHoldings((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setPlan(null);
  }

  function chooseDataset(next: Dataset) {
    if (next === dataset) return;
    setDataset(next);
    setHoldings([{ id: nextId, asset: '', percent: '' }]);
    setNextId((id) => id + 1);
    setPlan(null);
  }

  async function preview(): Promise<void> {
    setError(null);
    setPlan(null);
    try {
      const currentHoldings = parseHoldings(holdings);
      const capital = Number(portfolioValue);
      if (!Number.isFinite(capital) || capital <= 0)
        throw new Error('Enter a positive portfolio value.');
      if (!strategyStartDate) throw new Error('Choose the date you started this strategy.');
      if (!config) throw new Error('Strategy settings are still loading.');
      setRunning(true);
      const response = await apiPost<MomentumRebalanceResult>('/api/momentum/rebalance-preview', {
        ...config,
        holdings_pct: currentHoldings,
        portfolio_value: capital,
        strategy_start_date: strategyStartDate,
        auth_source: 'dashboard',
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
      <Card>
        <CardHeader
          title="Rebalance preview"
          description="Compare your actual holdings with the model target at any time. Market hours use live Fyers prices; otherwise the preview uses the latest database close. It never places orders."
        />
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Rebalance dataset</legend>
          <Button
            size="sm"
            variant={dataset === 'stock' ? 'primary' : 'ghost'}
            aria-pressed={dataset === 'stock'}
            onClick={() => chooseDataset('stock')}
          >
            Nifty 50 Stocks
          </Button>
          <Button
            size="sm"
            variant={dataset === 'broad' ? 'primary' : 'ghost'}
            aria-pressed={dataset === 'broad'}
            onClick={() => chooseDataset('broad')}
          >
            Broad Momentum
          </Button>
        </fieldset>
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="text-xs font-medium text-muted">
            Strategy settings
            <select
              className="mt-1 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value);
                setPlan(null);
              }}
              disabled={loading}
            >
              <option value="default">
                Default {dataset === 'stock' ? 'Nifty 50 Stocks' : 'Broad Momentum'} settings
              </option>
              {dataset === 'broad' && currentBroadConfig ? (
                <option value="current">Current Backtest settings</option>
              ) : null}
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name}
                  {run.active ? ' · Telegram active' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted">Data through {meta?.last_week ?? '—'}</p>
        </div>
        {config && described ? (
          <p className="mt-3 rounded-lg bg-surface-2/50 px-3 py-2 text-xs text-muted">
            {described.period}
            {' · '}
            {described.cadence} rebalancing
            {' · '}
            {described.selection}
            {' · '}benchmark {described.benchmark}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          Live prices are used during NSE market hours (09:15–15:30 IST). Outside market hours, or
          when live quotes are unavailable, the result is clearly marked as an as-of preview.
        </p>
        {loadError ? (
          <div className="mt-3">
            <StateMessage
              variant="error"
              title="Could not load strategy choices"
              description={loadError}
            />
          </div>
        ) : null}
      </Card>
      <Card>
        <CardHeader
          title="Current portfolio"
          description="Enter what you hold now. Any unallocated percentage is treated as cash."
        />
        <datalist id="rebalance-assets">
          {suggestions.map((item) => (
            <option key={item.value} value={item.value} label={item.label} />
          ))}
        </datalist>
        <div className="space-y-2">
          {holdings.map((row, index) => (
            <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-end gap-2">
              <label className="text-xs text-muted">
                Asset {index + 1}
                <input
                  list="rebalance-assets"
                  value={row.asset}
                  onChange={(event) => updateHolding(row.id, { asset: event.target.value })}
                  placeholder={dataset === 'broad' ? 'RELIANCE' : 'Company ID or Gold'}
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
                />
              </label>
              <label className="text-xs text-muted">
                Weight %
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={row.percent}
                  onChange={(event) => updateHolding(row.id, { percent: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
                />
              </label>
              <Button
                size="sm"
                aria-label={`Remove holding ${index + 1}`}
                onClick={() => {
                  setHoldings((rows) => rows.filter((item) => item.id !== row.id));
                  setPlan(null);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          className="mt-3"
          onClick={() => {
            setHoldings((rows) => [...rows, { id: nextId, asset: '', percent: '' }]);
            setNextId((id) => id + 1);
          }}
        >
          <Plus className="h-3.5 w-3.5" /> Add holding
        </Button>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <span className={cash < -0.0001 ? 'text-negative' : 'text-muted'}>
            Allocated {allocated.toFixed(2)}%
          </span>
          <span className="text-muted">Cash remainder {cash.toFixed(2)}%</span>
        </div>
        {allocated <= 0.0001 ? (
          <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
            <p className="text-sm font-medium text-foreground">First allocation</p>
            <p className="mt-0.5 text-sm text-muted">
              No invested allocation is entered, so the portfolio is treated as 100% cash and this
              preview is labelled as your first allocation.
            </p>
          </div>
        ) : null}
        <div className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2">
          <label className="text-xs text-muted">
            Total portfolio value (₹)
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={portfolioValue}
              onChange={(event) => {
                setPortfolioValue(event.target.value);
                setPlan(null);
              }}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted">
            Strategy live start date
            <input
              type="date"
              required
              value={strategyStartDate}
              onChange={(event) => {
                setStrategyStartDate(event.target.value);
                setPlan(null);
              }}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            />
            <span className="mt-1 block">
              Anchors which Friday is week 1 for an every-2, every-3 or every-4-week strategy.
            </span>
          </label>
        </div>
        <Button
          className="mt-4"
          variant="primary"
          disabled={running || loading || !config || cash < -0.0001}
          onClick={() => void preview()}
        >
          {running ? 'Computing preview…' : 'Preview rebalance'}
        </Button>
      </Card>
      {error ? (
        <StateMessage variant="error" title="Rebalance preview unavailable" description={error} />
      ) : null}
      {plan ? (
        <Card>
          <CardHeader
            title="Indicative changes"
            description={`${plan.price_source} · ${
              plan.price_mode === 'live'
                ? `${new Date(plan.as_of).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`
                : `as of ${plan.as_of}`
            } · Signal week ${plan.signal_week}`}
          />
          {plan.rebalance_schedule ? (
            <div
              className={`mb-4 rounded-lg border px-4 py-3 ${
                plan.rebalance_schedule.is_rebalance_week
                  ? 'border-positive/30 bg-positive/5'
                  : 'border-warning/30 bg-warning/10'
              }`}
            >
              <p className="text-sm font-medium text-foreground">
                {plan.first_allocation ? 'First allocation · ' : ''}
                {plan.rebalance_schedule.is_rebalance_week
                  ? 'Rebalance is scheduled this week'
                  : 'No rebalance is scheduled this week'}
              </p>
              <p className="mt-1 text-sm text-muted">
                {cadenceLabel(plan.rebalance_schedule)} from the live start date{' '}
                {displayDate(plan.rebalance_schedule.strategy_start_date)}. Previous rebalance:{' '}
                {displayDate(plan.rebalance_schedule.previous_rebalance_date)} · Next rebalance:{' '}
                {displayDate(plan.rebalance_schedule.next_rebalance_date)}.
              </p>
              {!plan.rebalance_schedule.is_rebalance_week ? (
                <p className="mt-1 text-sm text-muted">
                  The table below shows the changes needed to match the current model target; it is
                  not a scheduled rebalance for this signal week.
                </p>
              ) : null}
            </div>
          ) : null}
          {plan.rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted">
                  <tr>
                    <th className="py-2 pr-3">Action</th>
                    <th className="py-2 pr-3">Asset / symbol</th>
                    <th className="py-2 pr-3 text-right">Current</th>
                    <th className="py-2 pr-3 text-right">Target</th>
                    <th className="py-2 pr-3 text-right">Change</th>
                    <th className="py-2 pr-3 text-right">Price</th>
                    <th className="py-2 pr-3 text-right">Indicative value</th>
                    <th className="py-2 text-right">Shares</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((row) => (
                    <tr key={row.asset} className="border-b border-border/50">
                      <td className="py-2 pr-3 font-medium">{row.action}</td>
                      <td className="py-2 pr-3">
                        {row.asset}
                        <span className="block text-xs text-muted">
                          {row.symbol ?? 'Cash allocation'}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right">{row.current_pct.toFixed(2)}%</td>
                      <td className="py-2 pr-3 text-right">{row.target_pct.toFixed(2)}%</td>
                      <td className="py-2 pr-3 text-right">
                        {row.delta_pct > 0 ? '+' : ''}
                        {row.delta_pct.toFixed(2)} pp
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {row.ltp === null ? '—' : `₹${row.ltp.toLocaleString('en-IN')}`}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        ₹{row.indicative_value.toLocaleString('en-IN')}
                      </td>
                      <td className="py-2 text-right">{row.indicative_quantity ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">No weight changes are indicated.</p>
          )}
          <p className="mt-4 text-xs text-muted">{plan.note}</p>
        </Card>
      ) : null}
    </div>
  );
}
