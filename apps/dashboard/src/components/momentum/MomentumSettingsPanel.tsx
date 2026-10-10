'use client';

import { Plus, Search, X } from 'lucide-react';
import { type ReactNode, createContext, useContext, useMemo, useState } from 'react';

import { type LiquidityPreviewParams, useLiquidityPreview } from '../../hooks/useLiquidityPreview';
import { cn } from '../../lib/cn';
import { formatInr, formatInt, formatNumber } from '../../lib/format';
import type { MomentumSettingsSection } from '../../lib/momentumConfig';
import {
  BROAD_UNIVERSES,
  BROAD_UNIVERSE_ORDER,
  broadUniverse,
  isGatedUniverse,
} from '../../lib/momentumUniverse';
import { Badge } from '../ui/Badge';
import { InfoTooltip } from '../ui/InfoTooltip';
import { Input, Select, NumberField as UiNumberField } from '../ui/Input';
import { RadioCards } from '../ui/RadioCards';
import { SettingsAccordion } from './backtest/SettingsAccordion';

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

/** Which accordions start open; the parent's `openSections` overrides these per id. */
const SECTION_DEFAULT_OPEN: Record<MomentumSettingsSection, boolean> = {
  universe: true,
  period: true,
  selection: true,
  ranking: false,
  portfolio: true,
  limits: false,
  inner: false,
  protection: false,
  costs: false,
};

/** DOM id of a settings accordion, for scrolling to it from outside the panel. */
export function settingsSectionDomId(section: MomentumSettingsSection): string {
  return `momentum-settings-${section}`;
}

interface SectionState {
  open: Readonly<Partial<Record<MomentumSettingsSection, boolean>>>;
  onToggle: (section: MomentumSettingsSection, open: boolean) => void;
  modified: ReadonlySet<MomentumSettingsSection>;
}

const NO_SECTIONS: ReadonlySet<MomentumSettingsSection> = new Set();

const SectionContext = createContext<SectionState>({
  open: {},
  onToggle: () => {},
  modified: NO_SECTIONS,
});

/** One settings accordion. Its open state and "modified" dot come from the panel's parent. */
function Section({
  id,
  title,
  description,
  badge,
  children,
}: {
  id: MomentumSettingsSection;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const { open, onToggle, modified } = useContext(SectionContext);
  return (
    <SettingsAccordion
      id={settingsSectionDomId(id)}
      title={title}
      description={description}
      badge={badge}
      modified={modified.has(id)}
      open={open[id] ?? SECTION_DEFAULT_OPEN[id]}
      onToggle={(next) => onToggle(id, next)}
    >
      {children}
    </SettingsAccordion>
  );
}

/** The long-form reasoning or research behind a setting, kept out of its one-line tooltip. */
function Why({ children }: { children: ReactNode }) {
  return (
    <details className="mt-1.5 text-xs">
      <summary className="w-fit cursor-pointer rounded font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Why?
      </summary>
      <p className="mt-1.5 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2 font-normal leading-relaxed text-muted">
        {children}
      </p>
    </details>
  );
}

function Field({
  label,
  help,
  why,
  children,
  className,
}: {
  label: string;
  help?: string | undefined;
  /** Long write-up shown behind a "Why?" disclosure under the field. */
  why?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  const field = (
    // biome-ignore lint/a11y/noLabelWithoutControl: children is always the field's own input/select/textarea, wrapped for implicit label association
    <label className={cn('block text-xs font-medium text-muted', why ? undefined : className)}>
      <span className="flex items-center gap-1.5">
        {label}
        {help ? <InfoTooltip text={help} label={`About ${label}`} /> : null}
      </span>
      {children}
    </label>
  );
  if (!why) return field;
  return (
    <div className={className}>
      {field}
      <Why>{why}</Why>
    </div>
  );
}

function NumberField({
  label,
  help,
  why,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
}: {
  label: string;
  help?: string | undefined;
  why?: string | undefined;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean | undefined;
}) {
  return (
    <Field label={label} help={help} why={why}>
      <UiNumberField
        className="mt-1"
        value={Number.isFinite(value) ? value : 0}
        onChange={onChange}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        step={step}
        disabled={disabled}
      />
    </Field>
  );
}

function Toggle({
  label,
  help,
  why,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  help?: string | undefined;
  why?: string | undefined;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean | undefined;
}) {
  const toggle = (
    <label
      className={cn(
        'flex items-start gap-2.5 text-xs text-foreground',
        disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 accent-[hsl(var(--primary))]"
        disabled={disabled}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex items-center gap-1.5 font-medium">
        {label}
        {help ? <InfoTooltip text={help} label={`About ${label}`} /> : null}
      </span>
    </label>
  );
  if (!why) return toggle;
  return (
    <div>
      {toggle}
      <div className="pl-6">
        <Why>{why}</Why>
      </div>
    </div>
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
  why,
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
  why?: string | undefined;
  values: Values;
  name: string;
  onChange: (key: string, value: unknown) => void;
  max?: number;
  step?: number;
  nullWhenZero?: boolean;
  disabled?: boolean | undefined;
}) {
  const raw = values[name];
  const shown = typeof raw === 'number' ? Math.round(raw * 10000) / 100 : 0;
  return (
    <NumberField
      label={label}
      help={help}
      why={why}
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
    <Section
      id="universe"
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
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find by name or symbol"
          className="pl-8"
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
    </Section>
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
        <InfoTooltip
          label="About Lookbacks"
          text="Each lookback's return is ranked (1 = best) and score = Σ rank × weight; lowest score wins."
        />
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
                  <Input
                    type="number"
                    min={1}
                    max={260}
                    className="py-1"
                    value={row.weeks}
                    onChange={(event) => update(index, { weeks: Number(event.target.value) })}
                    aria-label={`Lookback ${index + 1} weeks`}
                  />
                </td>
                <td className="px-1.5 py-1">
                  <Input
                    type="number"
                    step={0.25}
                    className={cn('py-1', row.weight < 0 && 'border-negative/50 text-negative')}
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
      <Why>
        A NEGATIVE weight flips that lookback: it rewards the worst performers over it. E.g. −1 on
        26 and 52 weeks with +1 on 1 and 4 weeks hunts for long-term laggards that are turning up (a
        reversal signal).
      </Why>
    </div>
  );
}

/** Defaults for every field this panel owns, before the backend's own `meta.defaults` overlay. */
export const TURNOVER_PRESETS = [0.5, 1, 2, 5, 10];

/** Live "how many stocks pass" card, with the reason each rejected stock failed. */
function LiquidityPreviewCard({
  params,
  positionRupees,
  poolTopN,
}: {
  params: LiquidityPreviewParams;
  positionRupees: number;
  poolTopN: number;
}) {
  const { data, loading, error } = useLiquidityPreview(params);
  if (error && !data) {
    return <Hint>Couldn&apos;t load the tradability preview: {error}</Hint>;
  }
  if (!data) {
    return <Hint>{loading ? 'Checking which stocks pass…' : 'No preview available.'}</Hint>;
  }
  const reasons = Object.entries(data.reasons).sort((a, b) => b[1] - a[1]);
  const ratio =
    positionRupees > 0 ? Math.round((params.min_turnover_cr * 10_000_000) / positionRupees) : null;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2/40 p-3">
      <p className="text-xs text-foreground">
        As of <span className="font-medium">{data.as_of ?? '—'}</span>:{' '}
        <span className="font-semibold text-primary">{formatInt(data.eligible)}</span> of{' '}
        {formatInt(data.universe)} stocks pass
        {loading ? ' (updating…)' : ''}.
      </p>
      {reasons.length > 0 ? (
        <p className="text-[11px] leading-relaxed text-muted">
          Dropped: {reasons.map(([reason, count]) => `${count} ${reason}`).join(' · ')}.
        </p>
      ) : null}
      {data.warning ? <p className="text-[11px] text-warning">{data.warning}</p> : null}
      {data.eligible < Math.max(300, poolTopN) ? (
        <p className="text-[11px] text-warning">
          Only {data.eligible} stocks pass, so the top-{poolTopN} pool will be thin. Loosen a
          threshold if that is more than you want.
        </p>
      ) : null}
      {ratio !== null && ratio > 0 ? (
        <p className="text-[11px] text-muted">
          One full position (~{formatInr(positionRupees)}, from Capital × Max position) is about 1/
          {formatInt(ratio)} of the minimum daily turnover.
        </p>
      ) : null}
      {data.excluded.length > 0 ? (
        <details className="text-[11px] text-muted">
          <summary className="cursor-pointer font-medium text-foreground">
            Stocks dropped today ({data.excluded.length}
            {data.excluded.length >= 200 ? '+, thinnest first' : ''})
          </summary>
          <div className="mt-2 max-h-60 overflow-auto rounded-md border border-border">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-surface text-faint">
                <tr>
                  <th className="px-2 py-1 font-medium">Stock</th>
                  <th className="px-2 py-1 font-medium">Why</th>
                  <th className="px-2 py-1 text-right font-medium">Median ₹ Cr/day</th>
                  <th className="px-2 py-1 text-right font-medium">Price</th>
                </tr>
              </thead>
              <tbody>
                {data.excluded.map((row) => (
                  <tr key={row.symbol} className="border-t border-border">
                    <td className="px-2 py-1 font-medium text-foreground">{row.symbol}</td>
                    <td className="px-2 py-1">{row.reason}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {row.median_turnover_cr ?? '—'}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{row.price ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Broad Momentum's universe choice and tradability filter. The filter is optional on today's
 * Total Market list and mandatory on the point-in-time and whole-market universes, where it is
 * what narrows the listed stocks down to the ones you could really buy and sell.
 */
function BroadUniverseControls({
  values,
  onChange,
}: {
  values: Values;
  onChange: (key: string, value: unknown) => void;
}) {
  const num = (key: string, fallback: number) =>
    typeof values[key] === 'number' ? (values[key] as number) : fallback;
  const universe = broadUniverse(values);
  const gated = isGatedUniverse(universe);
  const active = gated || Boolean(values.broad_liquidity_filter);
  const minTurnover = num('broad_liq_min_turnover_cr', 1);
  const maxCircuitRaw = values.broad_liq_max_circuit_days;
  const maxCircuitDays = typeof maxCircuitRaw === 'number' ? maxCircuitRaw : null;
  const positionRupees = num('capital', 1_000_000) * num('max_position', 0.35);

  return (
    <div className="space-y-3">
      <RadioCards
        name="broad_universe"
        value={universe}
        onChange={(value) => onChange('broad_universe', value)}
        options={BROAD_UNIVERSE_ORDER.map((id) => ({
          value: id,
          label: BROAD_UNIVERSES[id].label,
          description: BROAD_UNIVERSES[id].description,
        }))}
      />
      <Toggle
        label={gated ? 'Tradability filter (always on for this universe)' : 'Tradability filter'}
        disabled={gated}
        help="Each week, keep only stocks with enough daily turnover to buy and sell your position, that are not pinned at a circuit limit. Uses only data available at that date. Always on for the point-in-time and whole-market universes."
        checked={active}
        onChange={(value) => onChange('broad_liquidity_filter', value)}
      />
      <Toggle
        label="Respect circuit locks (realistic fills)"
        help="When on, the backtest cannot buy a stock locked at the upper circuit or sell one locked at the lower circuit."
        why="Off (default): the backtest fills at any Friday close, even when the stock was locked that day. On: it cannot buy a stock locked at the upper circuit, and cannot sell one locked at the lower circuit, so a holding that locks down is held through the fall until the lock lifts. A lock means 3 or more sessions in a row closing at a price-band edge. The results card shows the CAGR both ways whichever you pick."
        checked={values.broad_respect_circuits === true}
        onChange={(value) => onChange('broad_respect_circuits', value)}
      />
      {active ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <NumberField
              label="Minimum daily turnover (₹ crore, median of last 60 sessions)"
              help="A stock must trade at least this much, on a typical day, to stay in. Higher is safer for exits and removes thin stocks, but it also removes some of the strongest small-cap momentum."
              value={minTurnover}
              min={0.1}
              max={1000}
              step={0.5}
              onChange={(value) => onChange('broad_liq_min_turnover_cr', value)}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TURNOVER_PRESETS.map((preset) => (
                <Chip
                  key={preset}
                  active={minTurnover === preset}
                  onClick={() => onChange('broad_liq_min_turnover_cr', preset)}
                >
                  ₹{preset} Cr
                </Chip>
              ))}
            </div>
          </div>
          <Toggle
            label="Skip stocks stuck at circuit limits"
            help="Drops a stock that closed at a price-band edge (2%, 5%, 10% or 20%) in the same direction for several sessions in a row within the last ~6 months. You can't reliably buy or sell a stock that is locked."
            checked={values.broad_liq_circuit !== false}
            onChange={(value) => onChange('broad_liq_circuit', value)}
          />
          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              Advanced tradability settings
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <PercentField
                label="Worst-day floor (% of minimum)"
                help="The quietest 10% of days must still reach this share of the minimum turnover, so an exit is possible on a thin day."
                values={values}
                name="broad_liq_floor_ratio"
                onChange={onChange}
                step={5}
              />
              <NumberField
                label="Minimum price (₹)"
                help="Skips very low-priced stocks, where spreads and tick sizes eat the trade."
                value={num('broad_liq_min_price', 20)}
                min={0}
                max={100000}
                onChange={(value) => onChange('broad_liq_min_price', value)}
              />
              <NumberField
                label="Stuck-at-circuit run (sessions)"
                help="How many sessions in a row at the same band edge count as 'stuck'."
                value={num('broad_liq_circuit_run', 3)}
                min={2}
                max={20}
                disabled={values.broad_liq_circuit === false}
                onChange={(value) => onChange('broad_liq_circuit_run', value)}
              />
              <Field
                label="Circuit days allowed (last 60 sessions)"
                help="Most LC or UC days a stock may have in its last 60 sessions. Blank = no limit."
                why="Most LC or UC days (closing at a band edge, either direction) a stock may have in its last 60 sessions, even if they weren't in a row. Blank = no limit. A 2% move also happens on ordinary volatile stocks, so start around 8 or higher."
              >
                <Input
                  type="number"
                  className="mt-1"
                  placeholder="No limit"
                  min={0}
                  max={60}
                  value={maxCircuitDays ?? ''}
                  onChange={(event) =>
                    onChange(
                      'broad_liq_max_circuit_days',
                      event.target.value === '' ? null : Number(event.target.value),
                    )
                  }
                />
              </Field>
            </div>
          </details>
          <LiquidityPreviewCard
            params={{
              min_turnover_cr: minTurnover,
              floor_ratio: num('broad_liq_floor_ratio', 0.25),
              min_price: num('broad_liq_min_price', 20),
              circuit: values.broad_liq_circuit !== false,
              circuit_run: num('broad_liq_circuit_run', 3),
              max_circuit_days: maxCircuitDays,
              universe,
            }}
            positionRupees={positionRupees}
            poolTopN={num('broad_pool_top_n', 200)}
          />
        </div>
      ) : null}
    </div>
  );
}

const SETTINGS_FALLBACKS: Values = {
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
  sell_every_week: false,
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
  reversal_tilt: 0,
  reversal_screen_pct: 0,
  broad_reversal_tilt: 0,
  broad_reversal_screen_pct: 0,
  commodity_copies: 1,
  debt_copies: 1,
  broad_category_mode: 'on',
  broad_pool_top_n: 200,
  broad_pool_exit_rank: 250,
  broad_coverage_floor: 0.4,
  broad_every_week: true,
  broad_category_top_n: 4,
  broad_category_exit_rank: 8,
  broad_picks_per_category: 2,
  broad_off_top_n: 10,
  broad_off_exit_rank: 20,
  broad_universe: 'turnover_rank',
  broad_liquidity_filter: true,
  broad_respect_circuits: true,
  broad_liq_min_turnover_cr: 1,
  broad_liq_floor_ratio: 0.25,
  broad_liq_min_price: 20,
  broad_liq_circuit: true,
  broad_liq_circuit_run: 3,
  broad_liq_max_circuit_days: null,
};

export function momentumSettingsDefaults(metaDefaults: Values): Values {
  return { ...SETTINGS_FALLBACKS, ...metaDefaults };
}

/**
 * Settings panel for the Momentum backtest, grouped and explained the way
 * the retired standalone Momentum page was: numbered groups, collapsible panels, and
 * every non-obvious choice described in place rather than as a bare
 * dropdown label.
 */
export function MomentumSettingsPanel({
  dataset,
  instruments,
  firstWeek,
  lastWeek,
  core,
  onCoreChange,
  values,
  onChange,
  openSections,
  onToggleSection,
  modifiedSections = NO_SECTIONS,
}: {
  dataset: Dataset;
  instruments: Instrument[];
  firstWeek: string;
  lastWeek: string;
  core: CoreSettings;
  onCoreChange: (patch: Partial<CoreSettings>) => void;
  values: Values;
  onChange: (key: string, value: unknown) => void;
  /**
   * Which accordions are open, by id; an id that is absent uses the panel's default. Owned by
   * the parent so the state survives this panel being collapsed (unmounted) and reopened.
   */
  openSections: Readonly<Partial<Record<MomentumSettingsSection, boolean>>>;
  onToggleSection: (section: MomentumSettingsSection, open: boolean) => void;
  /** Accordions holding a setting that differs from the dataset's defaults. */
  modifiedSections?: ReadonlySet<MomentumSettingsSection>;
}) {
  const sectionState = useMemo<SectionState>(
    () => ({ open: openSections, onToggle: onToggleSection, modified: modifiedSections }),
    [openSections, onToggleSection, modifiedSections],
  );
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
    <SectionContext.Provider value={sectionState}>
      <div className="space-y-3">
        <GroupTitle step={1}>Universe &amp; period</GroupTitle>

        {broad ? (
          <Section
            id="universe"
            title="Universe &amp; tradability"
            description={BROAD_UNIVERSES[broadUniverse(values)].short}
          >
            <Hint>
              The pool is refreshed quarterly from the universe you pick; each pool member&apos;s
              own rank still updates weekly. &quot;As each year saw it&quot; removes the survivor
              bias of today&apos;s list; the categories are still today&apos;s themes.
            </Hint>
            <BroadUniverseControls values={values} onChange={onChange} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          </Section>
        ) : (
          <UniverseSection
            dataset={dataset}
            instruments={instruments}
            selected={core.selected}
            onChange={(selected) => onCoreChange({ selected })}
          />
        )}

        <Section
          id="period"
          title="Period"
          description={`${core.start || firstWeek} → ${core.end || lastWeek}`}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="From">
              <Input
                type="date"
                className="mt-1"
                value={core.start}
                min={firstWeek}
                max={lastWeek}
                onChange={(event) => onCoreChange({ start: event.target.value })}
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                className="mt-1"
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
        </Section>

        <GroupTitle step={2}>Selection &amp; portfolio</GroupTitle>

        {broad ? (
          <Section
            id="selection"
            title="Selection"
            description={broadOn ? 'Categories, then their top stocks' : 'Stocks ranked directly'}
          >
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
            {broadOn ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <Toggle
              label="Simulate every week (recommended)"
              help="When on, the strategy trades every week, holding fewer names plus cash when few categories qualify."
              why="Off reproduces the original engine rule: a week with fewer ranked stocks than categories × picks is skipped entirely, so nothing is sold or bought and the chart jumps several weeks. That hit about 190 of 508 weeks since 2017 and overstated CAGR by about 6 points and Sharpe by about 0.6. On trades every week, holding fewer names plus cash when few categories qualify."
              checked={bool('broad_every_week')}
              onChange={(value) => onChange('broad_every_week', value)}
            />
          </Section>
        ) : null}

        <Section
          id="ranking"
          title="Ranking rule"
          description="Advanced · how instruments are scored"
        >
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
          {dataset === 'etf' ? (
            <div className="space-y-2 border-t border-border pt-3">
              <SubHeading>Beaten-down tilt (new, ETF only)</SubHeading>
              <Hint>
                Replaces the ranking above with: rank the short lookbacks (1/4/13w) on their own,
                rank the long lookbacks (26/52w) on their own with the worst performer first, turn
                both into a 0-100% score within that week's names, then add them — tilt is how much
                the long-term beaten-down score counts. 0% is plain short-term momentum. A stock
                making a fresh 52-week low is never freshly bought, whatever the tilt.
              </Hint>
              <Why>
                Measured: around 30% tilt beats both plain short-term momentum and the shipped
                5-lookback strategy on CAGR, Sharpe and drawdown in most rolling 3-year windows —
                the strongest result of this whole study; much above that (100%+) overshoots and
                gets worse.
              </Why>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <PercentField
                  label="Tilt"
                  help="0% ranks purely on 1/4/13-week momentum. 100% weighs the beaten-down score as much as the momentum score; above 100% starts to favour it."
                  values={values}
                  name="reversal_tilt"
                  onChange={onChange}
                  max={200}
                />
                <PercentField
                  label="Screen: top % by short-term momentum"
                  help="Optional hard filter applied before the tilt: only names in this top share by 1/4/13-week momentum are ranked at all. 0% = no filter, rank everyone."
                  values={values}
                  name="reversal_screen_pct"
                  onChange={onChange}
                  max={90}
                />
              </div>
            </div>
          ) : null}
          {dataset === 'broad' ? (
            <div className="space-y-2 border-t border-border pt-3">
              <SubHeading>Beaten-down tilt (new)</SubHeading>
              <Hint>
                Does not change which categories or pool stocks qualify — it only re-orders the
                stocks the funnel already picked: rank the short lookbacks (1/4/13w) on their own,
                rank the long lookbacks (26/52w) on their own with the worst performer first, turn
                both into a 0-100% score, then add them — tilt is how much the long-term beaten-down
                score counts. 0% leaves today's plain-momentum order untouched. A stock making a
                fresh 52-week low is never freshly bought, whatever the tilt (an already-held stock
                may still be topped up).
              </Hint>
              <Why>
                Measured: unlike the ETF version, it does NOT help here — every tilt setting loses
                to plain momentum on both return and risk-adjusted return in almost every rolling
                window. On individual stocks the momentum leaders, not the beaten-down names, are
                what drives the return. Left at 0% by default for this reason.
              </Why>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <PercentField
                  label="Tilt"
                  help="0% keeps today's plain-momentum order within the current selection. 100% weighs the beaten-down score as much as the momentum score; above 100% starts to favour it."
                  values={values}
                  name="broad_reversal_tilt"
                  onChange={onChange}
                  max={200}
                />
                <PercentField
                  label="Screen: top % by short-term momentum"
                  help="Optional hard filter applied before the tilt, within the funnel's own selection: only names in this top share by 1/4/13-week momentum are ranked at all. 0% = no filter."
                  values={values}
                  name="broad_reversal_screen_pct"
                  onChange={onChange}
                  max={90}
                />
              </div>
            </div>
          ) : null}
        </Section>

        <Section
          id="portfolio"
          title="Portfolio rule"
          description={buffer ? 'Buffer' : 'Fixed slots'}
        >
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
          {broad ? null : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Rebalance"
              help="How often the strategy acts on the weekly ranking."
              why="Weekly acts on every Friday's ranking. Every 2 or 4 weeks trades only on those Fridays (the ranking is still recomputed weekly). Monthly only trades in the last week of each month. Slower cadences churn less but react later."
            >
              <Select
                className="mt-1"
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
              </Select>
            </Field>
            {num('rebalance_every', 1) > 1 && str('rebalance', 'weekly') === 'weekly' ? (
              <Field
                label="Which Fridays"
                help="Trading weeks are fixed on the calendar (counted from 1 Jan 2016), so each choice is a different set of Fridays. Comparing them shows how much of a result is down to lucky timing."
              >
                <Select
                  className="mt-1"
                  value={num('rebalance_offset', 0)}
                  onChange={(event) => onChange('rebalance_offset', Number(event.target.value))}
                >
                  {Array.from({ length: num('rebalance_every', 1) }, (_, i) => i).map((phase) => (
                    <option key={phase} value={phase}>
                      Phase {phase + 1} of {num('rebalance_every', 1)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          {num('rebalance_every', 1) > 1 && str('rebalance', 'weekly') === 'weekly' && buffer ? (
            <Toggle
              label="Sell exits weekly, buy only on the cadence"
              help="Sell a dropped-rank holding the week it is due instead of waiting for the next cadence Friday."
              why="Normally a dropped-rank holding waits for the next cadence Friday to be sold, same as a new buy. Switch this on and exits happen the week they're due - only new buys and cap trims still wait. Measured: it mostly reverses the cadence's own edge (every 4 weeks on Broad: +5.2 points a year became -10.3) in exchange for a shallower drawdown more often - not recommended."
              checked={bool('sell_every_week')}
              onChange={(value) => onChange('sell_every_week', value)}
            />
          ) : null}
          <Toggle
            label="Win-rate position sizing"
            help="Shrink new and top-up buys after a run of losing trades, ramping back to full size as wins return. In the worst case it sits entirely in cash. Buffer rule only."
            checked={bool('momentum_sizing')}
            onChange={(value) => onChange('momentum_sizing', value)}
          />
          {bool('momentum_sizing') ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        </Section>

        <Section id="limits" title="Position limits" description="Caps on any one holding">
          {!buffer ? (
            <Hint>
              Position and category caps only apply to the Buffer rule — switch the portfolio rule
              to Buffer to use them.
            </Hint>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                help="A stock priced above this can't be newly bought; 0 = no limit."
                why="A stock priced above this can't be newly bought and the next-best stock takes its slot, so a small budget is never asked to buy one very expensive share. Existing holdings are kept. Gold, Silver and international ETFs are exempt. 0 = no limit."
                value={num('max_stock_price', 0)}
                min={0}
                step={1000}
                onChange={(value) => onChange('max_stock_price', value > 0 ? value : null)}
              />
            ) : null}
            {dataset === 'etf' ? (
              <PercentField
                label="Skip most volatile % (new buys)"
                help="Never freshly buy the instruments in the most volatile X% of the ranked list that week; 0 = off."
                why="Never freshly buy the instruments in the most volatile X% of the ranked list that week (26-week weekly volatility); the next-best name takes the slot and holdings stay until their rank says sell. Measured 2017–2026 on the live ETF strategy: skipping the top 20% lifted CAGR 25.8% → 27.9% and Sharpe 0.99 → 1.12, better in about 9 of 10 rolling 3-year windows. It mostly keeps out Realty and PSU Bank. It hurt stock strategies, so it is ETF only. 0 = off."
                values={values}
                name="exclude_high_vol"
                onChange={onChange}
                max={50}
              />
            ) : null}
          </div>
        </Section>

        {customIndex ? (
          <Section
            id="inner"
            title="Inner rotation"
            description="Advanced · stocks within each category"
          >
            <Hint>
              Each held category is itself a rotation: its top-K tagged stocks, rotated on their own
              tighter threshold — separate from the category-vs-category rule above.
            </Hint>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          </Section>
        ) : null}

        {!broad ? (
          <>
            <GroupTitle step={3}>Risk protection</GroupTitle>
            <Section
              id="protection"
              title="Crash protection"
              description={
                { off: 'Off', ranked: 'Debt in ranking', filter: 'Cash filter' }[
                  str('defensive', 'off')
                ]
              }
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
            </Section>
          </>
        ) : null}

        <GroupTitle step={broad ? 3 : 4}>Execution &amp; tax</GroupTitle>
        <Section
          id="costs"
          title={broad ? 'Costs & timing' : 'Costs, timing & tax'}
          description={
            itemised
              ? 'Itemised costs'
              : `${formatNumber(num('cost_pct', 0.1), 2, { trim: true })}% per side`
          }
        >
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <Select
                className="mt-1"
                value={num('signal_delay', 0)}
                onChange={(event) => onChange('signal_delay', Number(event.target.value))}
              >
                <option value={0}>at the signal close</option>
                <option value={1}>1 week later</option>
                <option value={2}>2 weeks later</option>
              </Select>
            </Field>
          </div>
          {dataset === 'etf' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="P&L on"
                help="The ranking always uses the index. This picks what profit and loss is measured on — the index itself, or the ETF you would actually trade (index less TER before the ETF listed)."
              >
                <Select
                  className="mt-1"
                  value={str('track', 'etf')}
                  onChange={(event) => onChange('track', event.target.value)}
                >
                  <option value="index">the index (underlying)</option>
                  <option value="etf">the ETF you&apos;d trade</option>
                </Select>
              </Field>
              <Field label="Fill at" help="When a trade decided at Friday's close actually fills.">
                <Select
                  className="mt-1"
                  value={str('execution', 'fri_close')}
                  onChange={(event) => onChange('execution', event.target.value)}
                >
                  <option value="fri_close">Friday close</option>
                  <option value="mon_open">Monday open</option>
                  <option value="mon_10am">Monday 10:00</option>
                </Select>
              </Field>
            </div>
          ) : null}
          {!broad ? (
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
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
                <Select
                  className="mt-1"
                  value={num('slab_rate', 0.3)}
                  disabled={!bool('tax')}
                  onChange={(event) => onChange('slab_rate', Number(event.target.value))}
                >
                  {[0, 0.05, 0.1, 0.2, 0.3].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate * 100}%
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : null}
        </Section>
      </div>
    </SectionContext.Provider>
  );
}
