'use client';

import { Plus, Search, X } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { cn } from '../../lib/cn';
import { Accordion } from '../ui/Accordion';
import { Badge } from '../ui/Badge';
import { InfoTooltip } from '../ui/InfoTooltip';
import { RadioCards } from '../ui/RadioCards';

export type Dataset = 'etf' | 'stock' | 'custom_index' | 'broad';

export interface Instrument {
  name: string;
  display_name?: string | null;
  include: string;
  group: string;
  has_data: boolean;
  first_week?: string | null;
}

export interface LookbackRow {
  weeks: number;
  weight: number;
}

export interface CoreSettings {
  start: string;
  end: string;
  topN: number;
  exitRank: number;
  lookbacks: LookbackRow[];
  selected: string[];
}

type Values = Record<string, unknown>;

const GROUP_ORDER: Record<Exclude<Dataset, 'broad'>, string[]> = {
  etf: ['Broad', 'Sector', 'Thematic', 'Commodity', 'International', 'Debt'],
  stock: ['Current member', 'Former member', 'Commodity', 'Debt'],
  custom_index: ['Official (NSE)', 'Custom', 'Commodity', 'International', 'Debt'],
};

const GROUP_NOTES: Record<string, string> = {
  Debt: 'only ranked in "Debt in ranking" crash-protection mode',
  'Former member': 'include these, or you are only testing survivorship-biased winners',
  Custom: 'hand-curated theme with no official NSE index',
};

function lookbackRows(pairs: Array<[number, number]>): LookbackRow[] {
  return pairs.map(([weeks, weight]) => ({ weeks, weight }));
}

const LOOKBACK_PRESETS: Array<[string, LookbackRow[]]> = [
  [
    'Equal 1·4·13·26·52',
    lookbackRows([
      [1, 1],
      [4, 1],
      [13, 1],
      [26, 1],
      [52, 1],
    ]),
  ],
  [
    'Recency tilt',
    lookbackRows([
      [1, 1.5],
      [4, 1.25],
      [13, 1],
      [26, 1],
      [52, 0.8],
    ]),
  ],
  [
    '4·13·26·52',
    lookbackRows([
      [4, 1],
      [13, 1],
      [26, 1],
      [52, 1],
    ]),
  ],
  [
    '1·4·13',
    lookbackRows([
      [1, 1],
      [4, 1],
      [13, 1],
    ]),
  ],
  [
    'Reversal (−26/−52)',
    lookbackRows([
      [1, 1],
      [4, 1],
      [26, -1],
      [52, -1],
    ]),
  ],
];

const inputClass =
  'mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground transition-colors hover:border-border-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50';

function Field({
  label,
  help,
  children,
  className,
}: {
  label: string;
  help?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: children is always the field's own input/select/textarea, wrapped for implicit label association
    <label className={cn('block text-xs font-medium text-muted', className)}>
      <span className="flex items-center gap-1.5">
        {label}
        {help ? <InfoTooltip text={help} /> : null}
      </span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
}: {
  label: string;
  help?: string | undefined;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean | undefined;
}) {
  return (
    <Field label={label} help={help}>
      <input
        type="number"
        className={inputClass}
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string | undefined;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-xs text-foreground">
      <input
        type="checkbox"
        className="mt-0.5 accent-[hsl(var(--primary))]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex items-center gap-1.5 font-medium">
        {label}
        {help ? <InfoTooltip text={help} /> : null}
      </span>
    </label>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted">{children}</p>;
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</p>
  );
}

function GroupTitle({ step, children }: { step: number; children: ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 px-1 pt-2 text-xs font-semibold uppercase tracking-wider text-faint">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[11px] text-primary">
        {step}
      </span>
      {children}
    </h3>
  );
}

function Chip({
  active,
  onClick,
  children,
}: { active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-primary bg-primary/15 text-primary'
          : 'border-border bg-surface-2/40 text-muted hover:border-border-strong hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Percent input over a stored 0–1 fraction; `nullWhenZero` maps 0 to "no limit" (null). */
function PercentField({
  label,
  help,
  values,
  name,
  onChange,
  max = 100,
  step = 5,
  nullWhenZero,
  disabled,
}: {
  label: string;
  help?: string | undefined;
  values: Values;
  name: string;
  onChange: (key: string, value: unknown) => void;
  max?: number;
  step?: number;
  nullWhenZero?: boolean;
  disabled?: boolean | undefined;
}) {
  const raw = values[name];
  const shown = typeof raw === 'number' ? Math.round(raw * 1000) / 10 : 0;
  return (
    <NumberField
      label={label}
      help={help}
      value={shown}
      min={0}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(value) => onChange(name, nullWhenZero && value <= 0 ? null : value / 100)}
    />
  );
}

function shiftYears(isoDate: string, years: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function UniverseSection({
  dataset,
  instruments,
  selected,
  onChange,
}: {
  dataset: Exclude<Dataset, 'broad'>;
  instruments: Instrument[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const groups = useMemo(() => {
    const known = GROUP_ORDER[dataset];
    const extra = [...new Set(instruments.map((item) => item.group))].filter(
      (group) => !known.includes(group),
    );
    return [...known, ...extra]
      .map((group) => ({ group, items: instruments.filter((item) => item.group === group) }))
      .filter((entry) => entry.items.length > 0);
  }, [dataset, instruments]);
  const needle = query.trim().toLowerCase();
  const usable = instruments.filter((item) => item.has_data);

  function setGroup(items: Instrument[], on: boolean): void {
    const names = new Set(items.filter((item) => item.has_data).map((item) => item.name));
    onChange(
      on ? [...new Set([...selected, ...names])] : selected.filter((name) => !names.has(name)),
    );
  }

  const heading = { etf: 'ETFs', stock: 'Nifty 50 stocks', custom_index: 'Categories' }[dataset];
  return (
    <Accordion
      title={heading}
      badge={
        <Badge tone="primary">
          {selected.length} / {usable.length}
        </Badge>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        <Chip
          onClick={() =>
            onChange(usable.filter((item) => item.include !== 'optional').map((item) => item.name))
          }
        >
          Recommended
        </Chip>
        <Chip onClick={() => onChange(usable.map((item) => item.name))}>All</Chip>
        <Chip onClick={() => onChange([])}>None</Chip>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find by name or symbol"
          className={cn(inputClass, 'mt-0 pl-8')}
        />
      </div>
      <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
        {groups.map(({ group, items }) => {
          const visible = needle
            ? items.filter((item) =>
                `${item.display_name ?? ''} ${item.name}`.toLowerCase().includes(needle),
              )
            : items;
          if (visible.length === 0) return null;
          const withData = items.filter((item) => item.has_data);
          const allOn = withData.length > 0 && withData.every((item) => selectedSet.has(item.name));
          return (
            <div key={group}>
              <label className="flex cursor-pointer items-center gap-2 border-b border-border pb-1 text-xs font-semibold text-foreground">
                <input
                  type="checkbox"
                  className="accent-[hsl(var(--primary))]"
                  checked={allOn}
                  onChange={(event) => setGroup(items, event.target.checked)}
                />
                {group}
                {GROUP_NOTES[group] ? (
                  <span className="font-normal text-faint">— {GROUP_NOTES[group]}</span>
                ) : null}
              </label>
              <div className="mt-1.5 grid gap-x-3 gap-y-1 sm:grid-cols-2">
                {visible.map((item) => {
                  const year = item.first_week ? Number(item.first_week.slice(0, 4)) : null;
                  return (
                    <label
                      key={item.name}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs text-foreground hover:bg-surface-2/60',
                        !item.has_data && 'cursor-not-allowed opacity-50',
                      )}
                      title={item.name}
                    >
                      <input
                        type="checkbox"
                        className="accent-[hsl(var(--primary))]"
                        checked={selectedSet.has(item.name)}
                        disabled={!item.has_data}
                        onChange={() =>
                          onChange(
                            selectedSet.has(item.name)
                              ? selected.filter((name) => name !== item.name)
                              : [...selected, item.name],
                          )
                        }
                      />
                      <span className="truncate">{item.display_name ?? item.name}</span>
                      {year && year > 2016 ? (
                        <span className="ml-auto shrink-0 rounded bg-warning/15 px-1 text-[10px] text-warning">
                          from {year}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Accordion>
  );
}

function LookbackTable({
  rows,
  onChange,
}: { rows: LookbackRow[]; onChange: (rows: LookbackRow[]) => void }) {
  function update(index: number, patch: Partial<LookbackRow>): void {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <SubHeading>Lookbacks</SubHeading>
        <InfoTooltip text="Each lookback's return is ranked (1 = best) and score = Σ rank × weight; lowest score wins. A NEGATIVE weight flips that lookback: it rewards the worst performers over it. E.g. −1 on 26 and 52 weeks with +1 on 1 and 4 weeks hunts for long-term laggards that are turning up (a reversal signal)." />
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="bg-surface-2/60 text-faint">
            <tr>
              <th className="px-2.5 py-1.5 text-left font-medium">Weeks</th>
              <th className="px-2.5 py-1.5 text-left font-medium">Weight</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id (freely added/removed/reordered); every cell is controlled by index already
              <tr key={index} className="border-t border-border">
                <td className="px-1.5 py-1">
                  <input
                    type="number"
                    min={1}
                    max={260}
                    className={cn(inputClass, 'mt-0 py-1')}
                    value={row.weeks}
                    onChange={(event) => update(index, { weeks: Number(event.target.value) })}
                    aria-label={`Lookback ${index + 1} weeks`}
                  />
                </td>
                <td className="px-1.5 py-1">
                  <input
                    type="number"
                    step={0.25}
                    className={cn(
                      inputClass,
                      'mt-0 py-1',
                      row.weight < 0 && 'border-negative/50 text-negative',
                    )}
                    value={row.weight}
                    onChange={(event) => update(index, { weight: Number(event.target.value) })}
                    aria-label={`Lookback ${index + 1} weight`}
                  />
                </td>
                <td className="px-1 text-center">
                  <button
                    type="button"
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
                    disabled={rows.length === 1}
                    aria-label={`Remove lookback ${index + 1}`}
                    className="rounded p-1 text-faint hover:bg-negative/10 hover:text-negative disabled:opacity-30"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Chip onClick={() => onChange([...rows, { weeks: 8, weight: 1 }])}>
          <span className="inline-flex items-center gap-1">
            <Plus className="h-3 w-3" /> lookback
          </span>
        </Chip>
        {LOOKBACK_PRESETS.map(([label, preset]) => (
          <Chip key={label} onClick={() => onChange(preset)}>
            {label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/** Defaults for every field this panel owns, before the backend's own `meta.defaults` overlay. */
export const SETTINGS_FALLBACKS: Values = {
  portfolio: 'buffer',
  entry: 'wait',
  max_position: 0.35,
  cap_band: 0.05,
  max_category: null,
  max_stock_price: null,
  score: 'ranksum',
  voladj_skip_recent_month: true,
  rebalance: 'weekly',
  rebalance_every: 1,
  rebalance_offset: 0,
  exclude_high_vol: 0,
  cost_model: 'flat',
  cost_pct: 0.1,
  capital: 1_000_000,
  slippage_bps: 5,
  signal_delay: 0,
  momentum_sizing: false,
  momentum_sizing_window: 10,
  momentum_sizing_floor: 0,
  defensive: 'off',
  filter_lookback: 13,
  tax: false,
  slab_rate: 0.3,
  track: 'etf',
  execution: 'fri_close',
  inner_top_n: 2,
  inner_exit_rank: 8,
  commodity_copies: 1,
  debt_copies: 1,
  broad_category_mode: 'on',
  broad_pool_top_n: 200,
  broad_pool_exit_rank: 250,
  broad_coverage_floor: 0.4,
  broad_every_week: false,
  broad_category_top_n: 4,
  broad_category_exit_rank: 8,
  broad_picks_per_category: 2,
  broad_off_top_n: 10,
  broad_off_exit_rank: 20,
};

export function momentumSettingsDefaults(metaDefaults: Values): Values {
  return { ...SETTINGS_FALLBACKS, ...metaDefaults };
}

/**
 * Settings panel for the Momentum backtest, grouped and explained the way
 * the legacy `mbt ui` page was: numbered groups, collapsible panels, and
 * every non-obvious choice described in place rather than as a bare
 * dropdown label.
 */
export function MomentumSettingsPanel({
  dataset,
  instruments,
  firstWeek,
  lastWeek,
  benchmarks,
  core,
  onCoreChange,
  values,
  onChange,
}: {
  dataset: Dataset;
  instruments: Instrument[];
  firstWeek: string;
  lastWeek: string;
  benchmarks: string[];
  core: CoreSettings;
  onCoreChange: (patch: Partial<CoreSettings>) => void;
  values: Values;
  onChange: (key: string, value: unknown) => void;
}) {
  const str = (key: string, fallback: string) =>
    typeof values[key] === 'string' ? (values[key] as string) : fallback;
  const num = (key: string, fallback: number) =>
    typeof values[key] === 'number' ? (values[key] as number) : fallback;
  const bool = (key: string) => Boolean(values[key]);

  const broad = dataset === 'broad';
  const customIndex = dataset === 'custom_index';
  const buffer = str('portfolio', 'buffer') === 'buffer';
  const broadOn = broad && str('broad_category_mode', 'on') === 'on';
  const score = str('score', 'ranksum');
  const itemised = str('cost_model', 'flat') === 'itemised';
  const holdingNoun = customIndex ? 'category' : dataset === 'etf' ? 'ETF' : 'stock';

  const periods: Array<[string, string, string]> = [
    ['Full', firstWeek, lastWeek],
    ['Last 1y', shiftYears(lastWeek, 1), lastWeek],
    ['Last 3y', shiftYears(lastWeek, 3), lastWeek],
    ['Last 5y', shiftYears(lastWeek, 5), lastWeek],
    ['2017–21', '2017-01-01', '2021-12-31'],
    ['2022–now', '2022-01-01', lastWeek],
  ];

  const maxLookbackWeeks = Math.max(
    0,
    ...core.lookbacks.map((row) => row.weeks).filter((w) => Number.isFinite(w) && w > 0),
  );
  const periodWeeks =
    core.start && core.end
      ? Math.round(
          (new Date(`${core.end}T00:00:00Z`).getTime() -
            new Date(`${core.start}T00:00:00Z`).getTime()) /
            (7 * 86_400_000),
        )
      : null;

  const portfolioHint = (() => {
    const unit = customIndex ? 'categories' : dataset === 'etf' ? 'ETFs' : 'stocks';
    const unitOne = customIndex ? 'category' : dataset === 'etf' ? 'ETF' : 'stock';
    if (broad) return null;
    let hint = buffer
      ? `Holds between ${core.topN} and ${core.exitRank} ${unit}: anything bought is kept until its rank passes ${core.exitRank}.`
      : `Always ${core.topN} positions; ranks ${core.topN + 1}–${core.exitRank} are kept but block a new buy until sold.`;
    const cap = typeof values.max_position === 'number' ? values.max_position : null;
    const band = typeof values.cap_band === 'number' ? values.cap_band : 0.05;
    if (buffer && cap) {
      const capPct = Math.round(cap * 100);
      hint += ` No ${unitOne} is bought past ${capPct}%; one that grows past ${Math.round((cap + band) * 100)}% is trimmed back to ${capPct}%.`;
      if (core.topN * cap < 1) {
        hint += ` With top ${core.topN} × ${capPct}%, only ${Math.round(core.topN * cap * 100)}% can be invested — the rest waits in cash.`;
      }
    }
    return hint;
  })();

  return (
    <div className="space-y-3">
      <GroupTitle step={1}>Universe &amp; period</GroupTitle>

      {broad ? (
        <Accordion title="Broad Momentum universe" description="Nifty Total Market pool">
          <Hint>
            Stocks in the Nifty Total Market universe are screened using available membership data
            and the pool is refreshed quarterly; each pool member&apos;s own rank still updates
            weekly.
          </Hint>
          <RadioCards
            name="broad_category_mode"
            value={str('broad_category_mode', 'on')}
            onChange={(value) => onChange('broad_category_mode', value)}
            options={[
              {
                value: 'on',
                label: 'Rank categories',
                description:
                  "rank eligible categories by their stocks' momentum, then hold the strongest categories and their top stocks. Gold, Silver, Nasdaq 100 and Hang Seng compete alongside them.",
              },
              {
                value: 'off',
                label: 'Rank stocks directly',
                description:
                  'skip categories and pick stocks from the eligible pool purely by their own momentum.',
              },
            ]}
          />
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Pool top N"
              help="How many of the top-momentum, currently-qualifying stocks form the pool the strategy picks from."
              value={num('broad_pool_top_n', 200)}
              min={10}
              max={500}
              onChange={(value) => onChange('broad_pool_top_n', value)}
            />
            <NumberField
              label="Pool exit rank"
              help="A pool stock is only dropped once its rank falls past this (hysteresis), so the pool doesn't churn every quarter."
              value={num('broad_pool_exit_rank', 250)}
              min={10}
              max={700}
              onChange={(value) => onChange('broad_pool_exit_rank', value)}
            />
          </div>
          <Toggle
            label="Simulate every week (recommended)"
            help="Off reproduces the original engine rule: a week with fewer ranked stocks than categories × picks is skipped entirely, so nothing is sold or bought and the chart jumps several weeks. That hit about 190 of 508 weeks since 2017 and overstated CAGR by about 6 points and Sharpe by about 0.6. On trades every week, holding fewer names plus cash when few categories qualify."
            checked={bool('broad_every_week')}
            onChange={(value) => onChange('broad_every_week', value)}
          />
          {broadOn ? (
            <div className="grid grid-cols-2 gap-3">
              <PercentField
                label="Coverage floor %"
                help="A category needs at least this share of its member stocks inside the pool to be scored at all — stops a category with 1 lucky stock from ranking."
                values={values}
                name="broad_coverage_floor"
                onChange={onChange}
              />
              <NumberField
                label="Categories held"
                help="How many top-ranked categories to buy fresh."
                value={num('broad_category_top_n', 4)}
                min={1}
                max={20}
                onChange={(value) => onChange('broad_category_top_n', value)}
              />
              <NumberField
                label="Sell category when rank >"
                help="A held category is only sold once its rank falls past this — the buffer between this and 'Categories held' avoids selling on a small slip."
                value={num('broad_category_exit_rank', 8)}
                min={1}
                max={40}
                onChange={(value) => onChange('broad_category_exit_rank', value)}
              />
              <NumberField
                label="Top stocks per category"
                help="How many of each held category's strongest stocks to own."
                value={num('broad_picks_per_category', 2)}
                min={1}
                max={5}
                onChange={(value) => onChange('broad_picks_per_category', value)}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Stocks to hold"
                help="How many of the top-ranked pool stocks to buy."
                value={num('broad_off_top_n', 10)}
                min={1}
                max={50}
                onChange={(value) => onChange('broad_off_top_n', value)}
              />
              <NumberField
                label="Sell when rank >"
                help="A held stock is only sold once its rank falls past this."
                value={num('broad_off_exit_rank', 20)}
                min={1}
                max={100}
                onChange={(value) => onChange('broad_off_exit_rank', value)}
              />
            </div>
          )}
        </Accordion>
      ) : (
        <UniverseSection
          dataset={dataset}
          instruments={instruments}
          selected={core.selected}
          onChange={(selected) => onCoreChange({ selected })}
        />
      )}

      <Accordion
        title="Period"
        description={`${core.start || firstWeek} → ${core.end || lastWeek}`}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <input
              type="date"
              className={inputClass}
              value={core.start}
              min={firstWeek}
              max={lastWeek}
              onChange={(event) => onCoreChange({ start: event.target.value })}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={inputClass}
              value={core.end}
              min={firstWeek}
              max={lastWeek}
              onChange={(event) => onCoreChange({ end: event.target.value })}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {periods.map(([label, start, end]) => (
            <Chip
              key={label}
              active={core.start === start && core.end === end}
              onClick={() => onCoreChange({ start, end })}
            >
              {label}
            </Chip>
          ))}
        </div>
        <Hint>
          Data available {firstWeek} → {lastWeek}.
        </Hint>
        {maxLookbackWeeks > 0 ? (
          <Hint>
            Ranking needs {maxLookbackWeeks} weeks of history, so a{' '}
            {customIndex ? 'category' : dataset === 'etf' ? 'ETF' : 'stock'} joins{' '}
            {maxLookbackWeeks} weeks after its data starts.
          </Hint>
        ) : null}
        {periodWeeks !== null && maxLookbackWeeks > 0 && periodWeeks < maxLookbackWeeks ? (
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
            The selected period ({periodWeeks} weeks) is shorter than the longest lookback (
            {maxLookbackWeeks} weeks) — the strategy will have little or no history to rank on.
          </p>
        ) : null}
      </Accordion>

      <GroupTitle step={2}>Selection &amp; portfolio</GroupTitle>

      <Accordion title="Ranking rule" description="How instruments are scored each week">
        <RadioCards
          name="score"
          value={score}
          onChange={(value) => onChange('score', value)}
          options={[
            {
              value: 'ranksum',
              label: 'Rank-sum',
              description:
                "rank each lookback's return (1 = best) and add the weighted ranks; lowest total wins. Simple and robust (default).",
            },
            {
              value: 'voladj',
              label: 'Volatility-adjusted',
              description:
                'return divided by volatility — prefers steady climbers over jumpy names with the same return.',
            },
            {
              value: 'blend',
              label: 'Blend',
              description: 'average of rank-sum and volatility-adjusted.',
            },
          ]}
        />
        {score !== 'ranksum' ? (
          <Toggle
            label="Skip the most recent month"
            help="Ignore the latest ~4 weeks when computing the volatility-adjusted score — a standard momentum tweak that avoids short-term reversal noise."
            checked={bool('voladj_skip_recent_month')}
            onChange={(value) => onChange('voladj_skip_recent_month', value)}
          />
        ) : (
          <>
            <LookbackTable
              rows={core.lookbacks}
              onChange={(lookbacks) => onCoreChange({ lookbacks })}
            />
            {core.lookbacks.every((row) => row.weight < 0) ? (
              <p className="rounded-lg border border-info/30 bg-info/10 px-2.5 py-1.5 text-xs text-info">
                Every weight is negative — this ranks purely on who performed worst (a pure
                reversal/mean-reversion strategy), not a momentum-plus-reversal blend.
              </p>
            ) : null}
          </>
        )}
      </Accordion>

      <Accordion title="Portfolio rule" description={buffer ? 'Buffer' : 'Fixed slots'}>
        <RadioCards
          name="portfolio"
          value={str('portfolio', 'buffer')}
          onChange={(value) => onChange('portfolio', value)}
          options={[
            {
              value: 'buffer',
              label: 'Buffer',
              description:
                "buy the top N and keep each holding until its rank falls past the exit rank, so a name slipping from #5 to #7 isn't sold. Money from a sale is reinvested equally across the top N.",
            },
            {
              value: 'slots',
              label: 'Fixed slots',
              description:
                "exactly N equal positions; when one is sold, its money buys the best-ranked name you don't already hold.",
            },
          ]}
        />
        {buffer ? (
          <div className="space-y-2">
            <SubHeading>A new name enters the top N but nothing was sold</SubHeading>
            <RadioCards
              name="entry"
              value={str('entry', 'wait')}
              onChange={(value) => onChange('entry', value)}
              options={[
                {
                  value: 'wait',
                  label: 'Wait',
                  description:
                    'buy it only when the next sale frees up money — fewer trades, but a new leader can be bought late.',
                },
                {
                  value: 'make_room',
                  label: 'Make room',
                  description:
                    'buy it now, trimming every current holding equally to fund it — tracks the ranking closely at the cost of more trading.',
                },
              ]}
            />
          </div>
        ) : null}
        {broad ? (
          <Hint>Broad Momentum sets its own top N / exit rank in the universe panel above.</Hint>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Top N"
                help={`How many of the highest-ranked ${customIndex ? 'categories' : 'names'} to buy.`}
                value={core.topN}
                min={1}
                max={20}
                onChange={(topN) => onCoreChange({ topN })}
              />
              <NumberField
                label="Sell when rank >"
                help="A holding is only sold once its rank falls past this. The gap between Top N and this number is the buffer that stops a name being sold the moment it slips a place or two."
                value={core.exitRank}
                min={1}
                max={40}
                onChange={(exitRank) => onCoreChange({ exitRank })}
              />
            </div>
            {core.exitRank < core.topN ? (
              <p className="rounded-lg border border-negative/30 bg-negative/10 px-2.5 py-1.5 text-xs text-negative">
                Exit rank is below Top N — every purchase would immediately qualify for sale. Set
                exit rank ≥ Top N.
              </p>
            ) : portfolioHint ? (
              <Hint>{portfolioHint}</Hint>
            ) : null}
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Rebalance"
            help="Weekly acts on every Friday's ranking. Every 2 or 4 weeks trades only on those Fridays (the ranking is still recomputed weekly). Monthly only trades in the last week of each month. Slower cadences churn less but react later."
          >
            <select
              className={inputClass}
              value={
                str('rebalance', 'weekly') === 'monthly'
                  ? 'monthly'
                  : `every${num('rebalance_every', 1)}`
              }
              onChange={(event) => {
                const choice = event.target.value;
                onChange('rebalance', choice === 'monthly' ? 'monthly' : 'weekly');
                onChange('rebalance_every', choice === 'monthly' ? 1 : Number(choice.slice(5)));
                onChange('rebalance_offset', 0);
              }}
            >
              <option value="every1">Weekly</option>
              <option value="every2">Every 2 weeks</option>
              <option value="every4">Every 4 weeks</option>
              <option value="monthly">Monthly (month-end only)</option>
            </select>
          </Field>
          {num('rebalance_every', 1) > 1 && str('rebalance', 'weekly') === 'weekly' ? (
            <Field
              label="Which Fridays"
              help="Trading weeks are fixed on the calendar (counted from 1 Jan 2016), so each choice is a different set of Fridays. Comparing them shows how much of a result is down to lucky timing."
            >
              <select
                className={inputClass}
                value={num('rebalance_offset', 0)}
                onChange={(event) => onChange('rebalance_offset', Number(event.target.value))}
              >
                {Array.from({ length: num('rebalance_every', 1) }, (_, i) => i).map((phase) => (
                  <option key={phase} value={phase}>
                    Phase {phase + 1} of {num('rebalance_every', 1)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
        <Toggle
          label="Win-rate position sizing"
          help="Shrink new and top-up buys after a run of losing trades, ramping back to full size as wins return. In the worst case it sits entirely in cash. Buffer rule only."
          checked={bool('momentum_sizing')}
          onChange={(value) => onChange('momentum_sizing', value)}
        />
        {bool('momentum_sizing') ? (
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Sizing window (trades)"
              help="How many of the most recent closed trades feed the win-rate. Shorter reacts faster to a fresh streak but is noisier; longer is steadier but slower to recover."
              value={num('momentum_sizing_window', 10)}
              min={1}
              max={52}
              onChange={(value) => onChange('momentum_sizing_window', value)}
            />
            <PercentField
              label="Min size floor %"
              help="Floor on the size multiplier. 0% means an all-loss streak can deploy nothing (full cash); a higher floor keeps at least that much invested."
              values={values}
              name="momentum_sizing_floor"
              onChange={onChange}
            />
          </div>
        ) : null}
      </Accordion>

      <Accordion title="Position limits" description="Caps on any one holding" defaultOpen={false}>
        {!buffer ? (
          <Hint>
            Position and category caps only apply to the Buffer rule — switch the portfolio rule to
            Buffer to use them.
          </Hint>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <PercentField
            label={`Max per ${holdingNoun} %`}
            help={`No single ${holdingNoun} may grow beyond this share of the portfolio; the excess is trimmed and spread over the others. 0 = no cap.`}
            values={values}
            name="max_position"
            onChange={onChange}
            nullWhenZero
            disabled={!buffer}
          />
          {broadOn ? (
            <PercentField
              label="Max per category %"
              help="Everything held through one category (its top stocks together) is limited to this share of the portfolio. 0 = no cap."
              values={values}
              name="max_category"
              onChange={onChange}
              nullWhenZero
              disabled={!buffer}
            />
          ) : null}
          <NumberField
            label="Trim when above by (pts)"
            help="A holding is only trimmed once it passes its cap by this many percentage points — stops a position sitting right at the cap being trimmed every week."
            value={Math.round(num('cap_band', 0.05) * 1000) / 10}
            min={0}
            max={50}
            onChange={(value) => onChange('cap_band', value / 100)}
            disabled={!buffer}
          />
          {broad ? (
            <NumberField
              label="Max price to buy ₹"
              help="A stock priced above this can't be newly bought and the next-best stock takes its slot, so a small budget is never asked to buy one very expensive share. Existing holdings are kept. Gold, Silver and international ETFs are exempt. 0 = no limit."
              value={num('max_stock_price', 0)}
              min={0}
              step={1000}
              onChange={(value) => onChange('max_stock_price', value > 0 ? value : null)}
            />
          ) : null}
          {dataset === 'etf' ? (
            <PercentField
              label="Skip most volatile % (new buys)"
              help="Never freshly buy the instruments in the most volatile X% of the ranked list that week (26-week weekly volatility); the next-best name takes the slot and holdings stay until their rank says sell. Measured 2017–2026 on the live ETF strategy: skipping the top 20% lifted CAGR 25.8% → 27.9% and Sharpe 0.99 → 1.12, better in about 9 of 10 rolling 3-year windows. It mostly keeps out Realty and PSU Bank. It hurt stock strategies, so it is ETF only. 0 = off."
              values={values}
              name="exclude_high_vol"
              onChange={onChange}
              max={50}
            />
          ) : null}
        </div>
      </Accordion>

      {customIndex ? (
        <Accordion title="Inner rotation" description="Stocks within each category">
          <Hint>
            Each held category is itself a rotation: its top-K tagged stocks, rotated on their own
            tighter threshold — separate from the category-vs-category rule above.
          </Hint>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Stocks per category"
              help="How many of a held category's strongest stocks to own."
              value={num('inner_top_n', 2)}
              min={1}
              max={10}
              onChange={(value) => onChange('inner_top_n', value)}
            />
            <NumberField
              label="Sell from category when rank >"
              help="A stock inside a held category is sold once its rank within that category falls past this."
              value={num('inner_exit_rank', 8)}
              min={1}
              max={40}
              onChange={(value) => onChange('inner_exit_rank', value)}
            />
            <NumberField
              label="Gold/Silver slots"
              help="How many ranked slots Gold and Silver may each take at once when their momentum is strong. 1 = ordinary single-instrument behaviour."
              value={num('commodity_copies', 1)}
              min={1}
              max={10}
              onChange={(value) => onChange('commodity_copies', value)}
            />
            <NumberField
              label="Cash/Gilt slots"
              help="How many ranked slots Cash and Gilt may each take at once. 1 = ordinary single-instrument behaviour."
              value={num('debt_copies', 1)}
              min={1}
              max={10}
              onChange={(value) => onChange('debt_copies', value)}
            />
          </div>
        </Accordion>
      ) : null}

      {!broad ? (
        <>
          <GroupTitle step={3}>Risk protection</GroupTitle>
          <Accordion
            title="Crash protection"
            description={
              { off: 'Off', ranked: 'Debt in ranking', filter: 'Cash filter' }[
                str('defensive', 'off')
              ]
            }
            defaultOpen={false}
          >
            <RadioCards
              name="defensive"
              value={str('defensive', 'off')}
              onChange={(value) => onChange('defensive', value)}
              options={[
                {
                  value: 'off',
                  label: 'Off',
                  description: 'always fully invested in the top-ranked names.',
                },
                {
                  value: 'ranked',
                  label: 'Debt in ranking',
                  description:
                    'the selected Debt rows (liquid fund, gilt) compete like any other asset, so in a sell-off they rise into the top N and the strategy rotates into them.',
                },
                {
                  value: 'filter',
                  label: 'Cash filter',
                  description:
                    "only hold names beating cash over the lookback below; money that can't find a qualifying name waits in cash.",
                },
              ]}
            />
            {str('defensive', 'off') === 'filter' ? (
              <NumberField
                label="Must beat cash over (weeks)"
                help="The window over which a name's return must exceed the liquid fund's to be held."
                value={num('filter_lookback', 13)}
                min={1}
                max={104}
                onChange={(value) => onChange('filter_lookback', value)}
              />
            ) : null}
          </Accordion>
        </>
      ) : null}

      <GroupTitle step={broad ? 3 : 4}>Execution &amp; tax</GroupTitle>
      <Accordion title="Costs, timing & tax" defaultOpen={false}>
        <RadioCards
          name="cost_model"
          value={str('cost_model', 'flat')}
          onChange={(value) => onChange('cost_model', value)}
          columns={2}
          options={[
            {
              value: 'flat',
              label: 'Flat %',
              description: 'one percentage charged on every buy and sell.',
            },
            {
              value: 'itemised',
              label: 'Itemised',
              description:
                'real Indian charges — STT, stamp duty, exchange/SEBI fees, DP charges and slippage — on an actual rupee capital.',
            },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          {itemised ? (
            <>
              <NumberField
                label="Capital ₹"
                help="The rupee amount traded. Matters for itemised costs because DP charges are a flat ₹ per sell, which hurts small portfolios more."
                value={num('capital', 1_000_000)}
                min={1}
                step={10000}
                onChange={(value) => onChange('capital', value)}
              />
              <NumberField
                label="Slippage (bps)"
                help="Assumed gap between the signal price and your actual fill, in basis points (5 bps = 0.05%)."
                value={num('slippage_bps', 5)}
                min={0}
                step={0.5}
                onChange={(value) => onChange('slippage_bps', value)}
              />
            </>
          ) : (
            <NumberField
              label="Cost per side %"
              help="Charged on each buy and each sell — 0.10% per side is roughly a 0.2% round trip."
              value={num('cost_pct', 0.1)}
              min={0}
              max={5}
              step={0.05}
              onChange={(value) => onChange('cost_pct', value)}
            />
          )}
          <Field
            label="Trade"
            help="Trade at the signal week's close, or 1–2 weeks later — shows how sensitive the strategy is to acting late."
          >
            <select
              className={inputClass}
              value={num('signal_delay', 0)}
              onChange={(event) => onChange('signal_delay', Number(event.target.value))}
            >
              <option value={0}>at the signal close</option>
              <option value={1}>1 week later</option>
              <option value={2}>2 weeks later</option>
            </select>
          </Field>
        </div>
        {dataset === 'etf' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="P&L on"
              help="The ranking always uses the index. This picks what profit and loss is measured on — the index itself, or the ETF you would actually trade (index less TER before the ETF listed)."
            >
              <select
                className={inputClass}
                value={str('track', 'etf')}
                onChange={(event) => onChange('track', event.target.value)}
              >
                <option value="index">the index (underlying)</option>
                <option value="etf">the ETF you&apos;d trade</option>
              </select>
            </Field>
            <Field label="Fill at" help="When a trade decided at Friday's close actually fills.">
              <select
                className={inputClass}
                value={str('execution', 'fri_close')}
                onChange={(event) => onChange('execution', event.target.value)}
              >
                <option value="fri_close">Friday close</option>
                <option value="mon_open">Monday open</option>
                <option value="mon_10am">Monday 10:00</option>
              </select>
            </Field>
          </div>
        ) : null}
        {!broad ? (
          <div className="grid grid-cols-2 items-end gap-3">
            <Toggle
              label="Apply capital-gains tax"
              help="Deduct Indian capital-gains tax on every sale (short or long term by holding period, including a final sale at the end)."
              checked={bool('tax')}
              onChange={(value) => onChange('tax', value)}
            />
            <Field
              label="Slab"
              help="Your income-tax slab, used for gains taxed at slab rate (e.g. debt funds)."
            >
              <select
                className={inputClass}
                value={num('slab_rate', 0.3)}
                disabled={!bool('tax')}
                onChange={(event) => onChange('slab_rate', Number(event.target.value))}
              >
                {[0, 0.05, 0.1, 0.2, 0.3].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate * 100}%
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}
        <Field
          label="Benchmark"
          help="What the strategy is compared against in the chart, the KPIs and the year-by-year table."
        >
          <select
            className={inputClass}
            value={str('benchmark', benchmarks[0] ?? '')}
            onChange={(event) => onChange('benchmark', event.target.value)}
          >
            {benchmarks.map((benchmark) => (
              <option key={benchmark} value={benchmark}>
                {benchmark}
              </option>
            ))}
          </select>
        </Field>
      </Accordion>
    </div>
  );
}
