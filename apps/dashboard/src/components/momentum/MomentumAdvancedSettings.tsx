'use client';

import { Card, CardHeader } from '../ui/Card';

type Dataset = 'etf' | 'stock' | 'custom_index' | 'broad';
type Option = [string, string];

interface Setting {
  key: string;
  label: string;
  kind: 'number' | 'select' | 'boolean';
  options?: Option[];
  step?: number;
}

const COMMON: Setting[] = [
  { key: 'portfolio', label: 'Portfolio rule', kind: 'select', options: [['buffer', 'Buffer'], ['slots', 'Fixed slots']] },
  { key: 'entry', label: 'New entry', kind: 'select', options: [['wait', 'Wait for sale'], ['make_room', 'Make room']] },
  { key: 'max_position', label: 'Max position share (0–1)', kind: 'number', step: 0.05 },
  { key: 'cap_band', label: 'Cap trim band (0–1)', kind: 'number', step: 0.01 },
  { key: 'score', label: 'Ranking score', kind: 'select', options: [['ranksum', 'Rank sum'], ['voladj', 'Volatility adjusted'], ['blend', 'Blend']] },
  { key: 'voladj_skip_recent_month', label: 'Volatility score skips recent month', kind: 'boolean' },
  { key: 'rebalance', label: 'Rebalance', kind: 'select', options: [['weekly', 'Weekly'], ['monthly', 'Monthly']] },
  { key: 'cost_model', label: 'Trading costs', kind: 'select', options: [['flat', 'Flat'], ['itemised', 'Itemised']] },
  { key: 'cost_pct', label: 'Flat cost per side (%)', kind: 'number', step: 0.01 },
  { key: 'capital', label: 'Capital (₹)', kind: 'number', step: 10000 },
  { key: 'slippage_bps', label: 'Slippage (basis points)', kind: 'number', step: 1 },
  { key: 'signal_delay', label: 'Signal delay (weeks)', kind: 'number', step: 1 },
  { key: 'momentum_sizing', label: 'Momentum sizing', kind: 'boolean' },
  { key: 'momentum_sizing_window', label: 'Sizing window (trades)', kind: 'number', step: 1 },
  { key: 'momentum_sizing_floor', label: 'Sizing floor (0–1)', kind: 'number', step: 0.05 },
];

const STANDARD: Setting[] = [
  { key: 'defensive', label: 'Defensive rule', kind: 'select', options: [['off', 'Off'], ['ranked', 'Debt in ranking'], ['filter', 'Cash filter']] },
  { key: 'filter_lookback', label: 'Cash filter lookback (weeks)', kind: 'number', step: 1 },
  { key: 'tax', label: 'Account for tax', kind: 'boolean' },
  { key: 'slab_rate', label: 'Tax slab rate (0–0.5)', kind: 'number', step: 0.05 },
];

const ETF: Setting[] = [
  { key: 'track', label: 'P&L priced on', kind: 'select', options: [['etf', 'Traded ETF'], ['index', 'Ranking index']] },
  { key: 'execution', label: 'Execution price', kind: 'select', options: [['fri_close', 'Friday close'], ['mon_open', 'Monday open'], ['mon_10am', 'Monday 10:00']] },
];

const CUSTOM: Setting[] = [
  { key: 'inner_top_n', label: 'Stocks per category', kind: 'number', step: 1 },
  { key: 'inner_exit_rank', label: 'Inner exit rank', kind: 'number', step: 1 },
  { key: 'commodity_copies', label: 'Commodity slots', kind: 'number', step: 1 },
  { key: 'debt_copies', label: 'Debt slots', kind: 'number', step: 1 },
];

const BROAD: Setting[] = [
  { key: 'broad_category_mode', label: 'Category mode', kind: 'select', options: [['on', 'Rank categories'], ['off', 'Rank stocks directly']] },
  { key: 'broad_pool_top_n', label: 'Pool top N', kind: 'number', step: 1 },
  { key: 'broad_pool_exit_rank', label: 'Pool exit rank', kind: 'number', step: 1 },
  { key: 'broad_coverage_floor', label: 'Category coverage floor (0–1)', kind: 'number', step: 0.05 },
  { key: 'broad_category_top_n', label: 'Categories held', kind: 'number', step: 1 },
  { key: 'broad_category_exit_rank', label: 'Category exit rank', kind: 'number', step: 1 },
  { key: 'broad_picks_per_category', label: 'Stocks per category', kind: 'number', step: 1 },
  { key: 'broad_off_top_n', label: 'Direct stocks top N', kind: 'number', step: 1 },
  { key: 'broad_off_exit_rank', label: 'Direct stocks exit rank', kind: 'number', step: 1 },
];

const FALLBACKS: Record<string, unknown> = {
  portfolio: 'buffer', entry: 'wait', max_position: 0.35, cap_band: 0.05,
  score: 'ranksum', voladj_skip_recent_month: true, rebalance: 'weekly', cost_model: 'flat',
  cost_pct: 0.1, capital: 1_000_000, slippage_bps: 5, signal_delay: 0,
  momentum_sizing: false, momentum_sizing_window: 10, momentum_sizing_floor: 0,
  defensive: 'off', filter_lookback: 13, tax: false, slab_rate: 0.3,
  track: 'etf', execution: 'fri_close', inner_top_n: 2, inner_exit_rank: 8,
  commodity_copies: 1, debt_copies: 1,
  broad_category_mode: 'on', broad_pool_top_n: 200, broad_pool_exit_rank: 250,
  broad_coverage_floor: 0.4, broad_category_top_n: 4, broad_category_exit_rank: 8,
  broad_picks_per_category: 2, broad_off_top_n: 10, broad_off_exit_rank: 20,
};

export function MomentumAdvancedSettings({ dataset, values, benchmarks, onChange }: {
  dataset: Dataset;
  values: Record<string, unknown>;
  benchmarks: string[];
  onChange: (key: string, value: unknown) => void;
}) {
  const settings = [
    ...COMMON,
    ...(dataset === 'broad' ? BROAD : STANDARD),
    ...(dataset === 'etf' ? ETF : []),
    ...(dataset === 'custom_index' ? CUSTOM : []),
  ];
  return (
    <Card>
      <CardHeader title="Advanced settings" description="Portfolio rules, ranking, execution, costs and dataset controls" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {settings.map((setting) => {
          const value = values[setting.key] ?? FALLBACKS[setting.key];
          if (setting.kind === 'boolean') return <label key={setting.key} className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(setting.key, event.target.checked)} />{setting.label}</label>;
          if (setting.kind === 'select') return <label key={setting.key} className="text-xs text-muted">{setting.label}<select value={String(value)} onChange={(event) => onChange(setting.key, event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground">{setting.options?.map(([option, label]) => <option key={option} value={option}>{label}</option>)}</select></label>;
          return <label key={setting.key} className="text-xs text-muted">{setting.label}<input type="number" step={setting.step ?? 1} value={Number(value)} onChange={(event) => onChange(setting.key, Number(event.target.value))} className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground" /></label>;
        })}
        <label className="text-xs text-muted">Benchmark<select value={String(values.benchmark ?? benchmarks[0] ?? '')} onChange={(event) => onChange('benchmark', event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground">{benchmarks.map((benchmark) => <option key={benchmark} value={benchmark}>{benchmark}</option>)}</select></label>
      </div>
    </Card>
  );
}

export function advancedDefaults(metaDefaults: Record<string, unknown>): Record<string, unknown> {
  return { ...FALLBACKS, ...metaDefaults };
}
