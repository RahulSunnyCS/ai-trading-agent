/**
 * One description of a Momentum config, shared by every place that summarises a run in words:
 * the settings summary chips above the Backtest results, the result's assumption chips, the run
 * tabs' "what changed" tooltip and the Rebalance preview. Kept in one helper so those summaries cannot disagree.
 *
 * Broad Momentum ignores the generic `top_n` / `exit_rank` (the form still carries them); its
 * selection comes from the `broad_*` keys, which differ by category mode.
 */

import { formatNumber } from './format';

/**
 * The settings accordions, by id. The settings panel renders one accordion per id, the summary
 * chips point at one, and the "modified" dots are keyed by one.
 */
export type MomentumSettingsSection =
  | 'universe'
  | 'period'
  | 'selection'
  | 'ranking'
  | 'portfolio'
  | 'limits'
  | 'inner'
  | 'protection'
  | 'costs';

/** One summary chip: what it says and which settings accordion changes it. */
export interface MomentumConfigChip {
  id: string;
  label: string;
  section: MomentumSettingsSection;
}

export interface MomentumConfigDescription {
  /** "2017-01-06 → 2026-09-25" */
  period: string;
  /** Lower-case cadence for a sentence: "weekly", "every 2 weeks", "monthly". */
  cadence: string;
  /** Standalone chip: "Weekly rebalance", "Every 2 weeks (phase 1)", "Monthly rebalance". */
  cadenceChip: string;
  /** "top 5, exit after rank 10" */
  selection: string;
  /** Compact form for a one-line summary: "top 5 / exit >10". */
  selectionShort: string;
  /** Benchmark name, or an em dash when none is set. */
  benchmark: string;
  /** The same facts as ordered chips, each naming the settings accordion it belongs to. */
  chips: MomentumConfigChip[];
}

const EMPTY = '—';

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function count(value: unknown): string {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n)
    ? String(n)
    : EMPTY;
}

export function describeConfig(
  config: Record<string, unknown>,
  dataset: string,
): MomentumConfigDescription {
  const every = Number(config.rebalance_every ?? 1);
  const monthly = config.rebalance === 'monthly';
  const everyN = !monthly && Number.isFinite(every) && every > 1;
  const cadence = monthly ? 'monthly' : everyN ? `every ${every} weeks` : 'weekly';
  const cadenceChip = monthly
    ? 'Monthly rebalance'
    : everyN
      ? `Every ${every} weeks (phase ${Number(config.rebalance_offset ?? 0) + 1})`
      : 'Weekly rebalance';

  let selection: string;
  let selectionShort: string;
  if (dataset === 'broad' && config.broad_category_mode !== 'off') {
    const held = count(config.broad_category_top_n);
    const picks = count(config.broad_picks_per_category);
    const exit = count(config.broad_category_exit_rank);
    selection = `top ${held} categories × ${picks} stocks each, sell a category after rank ${exit}`;
    selectionShort = `top ${held} categories × ${picks} / exit >${exit}`;
  } else if (dataset === 'broad') {
    const held = count(config.broad_off_top_n);
    const exit = count(config.broad_off_exit_rank);
    selection = `top ${held} stocks, exit after rank ${exit}`;
    selectionShort = `top ${held} stocks / exit >${exit}`;
  } else {
    const held = count(config.top_n);
    const exit = count(config.exit_rank);
    selection = `top ${held}, exit after rank ${exit}`;
    selectionShort = `top ${held} / exit >${exit}`;
  }

  const period = `${text(config.start, 'Start')} → ${text(config.end, 'latest')}`;
  const benchmark = text(config.benchmark, EMPTY);
  const broad = dataset === 'broad';

  const chips: MomentumConfigChip[] = [{ id: 'period', label: period, section: 'period' }];
  if (broad) {
    const wholeMarket = config.broad_universe === 'all_liquid';
    const filtered = wholeMarket || config.broad_liquidity_filter === true;
    chips.push({
      id: 'universe',
      label: `${wholeMarket ? 'Whole NSE market' : 'Nifty Total Market'}${
        filtered ? ` · ≥ ₹${count(config.broad_liq_min_turnover_cr)} Cr/day` : ''
      }`,
      section: 'universe',
    });
  } else if (Array.isArray(config.universe)) {
    const noun = dataset === 'etf' ? 'ETFs' : dataset === 'custom_index' ? 'categories' : 'stocks';
    chips.push({
      id: 'universe',
      label: `${config.universe.length} ${noun}`,
      section: 'universe',
    });
  }
  chips.push(
    {
      id: 'selection',
      label: selectionShort,
      section: broad ? 'selection' : 'portfolio',
    },
    { id: 'cadence', label: cadenceChip, section: 'portfolio' },
    {
      id: 'portfolio',
      label: config.portfolio === 'slots' ? 'Fixed slots' : 'Buffer rule',
      section: 'portfolio',
    },
    { id: 'benchmark', label: `vs ${benchmark}`, section: 'period' },
    {
      id: 'costs',
      label:
        config.cost_model === 'itemised'
          ? 'Itemised costs'
          : `${count(config.cost_pct)}% cost per side`,
      section: 'costs',
    },
  );
  if (!broad) {
    chips.push({ id: 'tax', label: config.tax ? 'After tax' : 'Pre-tax', section: 'costs' });
  }

  return {
    period,
    cadence,
    cadenceChip,
    selection,
    selectionShort,
    benchmark,
    chips,
  };
}

// ---------------------------------------------------------------------------
// Which accordion a config key lives in, and what the settings panel calls it.
// ---------------------------------------------------------------------------

type DatasetRule = { only?: readonly string[]; not?: readonly string[] };

interface KeyInfo extends DatasetRule {
  section: MomentumSettingsSection;
  /** The settings panel's own label for the field. */
  label: string;
  /** Stored as a 0–1 fraction and shown as a percentage. */
  fraction?: boolean;
}

const BROAD = { only: ['broad'] } as const;
const NOT_BROAD = { not: ['broad'] } as const;
const ETF = { only: ['etf'] } as const;
const CUSTOM = { only: ['custom_index'] } as const;

const KEYS: Record<string, KeyInfo> = {
  universe: { section: 'universe', label: 'Universe', ...NOT_BROAD },
  broad_universe: { section: 'universe', label: 'Universe', ...BROAD },
  broad_liquidity_filter: { section: 'universe', label: 'Tradability filter', ...BROAD },
  broad_respect_circuits: { section: 'universe', label: 'Respect circuit locks', ...BROAD },
  broad_liq_min_turnover_cr: {
    section: 'universe',
    label: 'Minimum daily turnover (₹ crore)',
    ...BROAD,
  },
  broad_liq_floor_ratio: {
    section: 'universe',
    label: 'Worst-day floor',
    fraction: true,
    ...BROAD,
  },
  broad_liq_min_price: { section: 'universe', label: 'Minimum price (₹)', ...BROAD },
  broad_liq_circuit: {
    section: 'universe',
    label: 'Skip stocks stuck at circuit limits',
    ...BROAD,
  },
  broad_liq_circuit_run: {
    section: 'universe',
    label: 'Stuck-at-circuit run (sessions)',
    ...BROAD,
  },
  broad_liq_max_circuit_days: { section: 'universe', label: 'Circuit days allowed', ...BROAD },
  broad_pool_top_n: { section: 'universe', label: 'Pool top N', ...BROAD },
  broad_pool_exit_rank: { section: 'universe', label: 'Pool exit rank', ...BROAD },

  start: { section: 'period', label: 'From' },
  end: { section: 'period', label: 'To' },
  benchmark: { section: 'period', label: 'Benchmark' },

  broad_category_mode: { section: 'selection', label: 'Rank categories', ...BROAD },
  broad_category_top_n: { section: 'selection', label: 'Categories held', ...BROAD },
  broad_category_exit_rank: {
    section: 'selection',
    label: 'Sell category when rank >',
    ...BROAD,
  },
  broad_picks_per_category: { section: 'selection', label: 'Top stocks per category', ...BROAD },
  broad_coverage_floor: {
    section: 'selection',
    label: 'Coverage floor',
    fraction: true,
    ...BROAD,
  },
  broad_off_top_n: { section: 'selection', label: 'Stocks to hold', ...BROAD },
  broad_off_exit_rank: { section: 'selection', label: 'Sell when rank >', ...BROAD },
  broad_every_week: { section: 'selection', label: 'Simulate every week', ...BROAD },

  score: { section: 'ranking', label: 'Ranking rule' },
  voladj_skip_recent_month: { section: 'ranking', label: 'Skip the most recent month' },
  lookbacks: { section: 'ranking', label: 'Lookbacks (weeks)' },
  weights: { section: 'ranking', label: 'Lookback weights' },
  reversal_tilt: { section: 'ranking', label: 'Beaten-down tilt', fraction: true, ...ETF },
  reversal_screen_pct: {
    section: 'ranking',
    label: 'Screen: top % by short-term momentum',
    fraction: true,
    ...ETF,
  },
  broad_reversal_tilt: {
    section: 'ranking',
    label: 'Beaten-down tilt',
    fraction: true,
    ...BROAD,
  },
  broad_reversal_screen_pct: {
    section: 'ranking',
    label: 'Screen: top % by short-term momentum',
    fraction: true,
    ...BROAD,
  },

  portfolio: { section: 'portfolio', label: 'Portfolio rule' },
  entry: { section: 'portfolio', label: 'New name, nothing sold' },
  top_n: { section: 'portfolio', label: 'Top N', ...NOT_BROAD },
  exit_rank: { section: 'portfolio', label: 'Sell when rank >', ...NOT_BROAD },
  rebalance: { section: 'portfolio', label: 'Rebalance' },
  rebalance_every: { section: 'portfolio', label: 'Rebalance every (weeks)' },
  rebalance_offset: { section: 'portfolio', label: 'Which Fridays (phase)' },
  sell_every_week: { section: 'portfolio', label: 'Sell exits weekly' },
  momentum_sizing: { section: 'portfolio', label: 'Win-rate position sizing' },
  momentum_sizing_window: { section: 'portfolio', label: 'Sizing window (trades)' },
  momentum_sizing_floor: { section: 'portfolio', label: 'Min size floor', fraction: true },

  max_position: { section: 'limits', label: 'Max per holding', fraction: true },
  max_category: { section: 'limits', label: 'Max per category', fraction: true, ...BROAD },
  cap_band: { section: 'limits', label: 'Trim when above by', fraction: true },
  max_stock_price: { section: 'limits', label: 'Max price to buy ₹', ...BROAD },
  exclude_high_vol: {
    section: 'limits',
    label: 'Skip most volatile % (new buys)',
    fraction: true,
    ...ETF,
  },

  inner_top_n: { section: 'inner', label: 'Stocks per category', ...CUSTOM },
  inner_exit_rank: { section: 'inner', label: 'Sell from category when rank >', ...CUSTOM },
  commodity_copies: { section: 'inner', label: 'Gold/Silver slots', ...CUSTOM },
  debt_copies: { section: 'inner', label: 'Cash/Gilt slots', ...CUSTOM },

  defensive: { section: 'protection', label: 'Crash protection', ...NOT_BROAD },
  filter_lookback: { section: 'protection', label: 'Must beat cash over (weeks)', ...NOT_BROAD },

  cost_model: { section: 'costs', label: 'Cost model' },
  cost_pct: { section: 'costs', label: 'Cost per side %' },
  capital: { section: 'costs', label: 'Capital ₹' },
  slippage_bps: { section: 'costs', label: 'Slippage (bps)' },
  signal_delay: { section: 'costs', label: 'Trade delay (weeks)' },
  track: { section: 'costs', label: 'P&L on', ...ETF },
  execution: { section: 'costs', label: 'Fill at', ...ETF },
  tax: { section: 'costs', label: 'Apply capital-gains tax', ...NOT_BROAD },
  slab_rate: { section: 'costs', label: 'Slab', fraction: true, ...NOT_BROAD },
};

/** The settings panel's label for each config key, for any place that names a setting. */
export const MOMENTUM_SETTING_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KEYS).map(([key, info]) => [key, info.label]),
);

function applies(rule: DatasetRule, dataset: string): boolean {
  if (rule.only && !rule.only.includes(dataset)) return false;
  if (rule.not?.includes(dataset)) return false;
  return true;
}

/**
 * The accordion a config key is edited in for this dataset, or null when the dataset ignores
 * the key (Broad ignores `top_n`; ETF ignores every `broad_*` key) or the panel has no field
 * for it.
 */
export function settingsSectionOf(key: string, dataset: string): MomentumSettingsSection | null {
  const info = KEYS[key];
  return info && applies(info, dataset) ? info.section : null;
}

/** Order-insensitive for the universe (a set of names); exact for everything else. */
function comparable(key: string, value: unknown): string {
  if (key === 'universe' && Array.isArray(value)) {
    return JSON.stringify([...value].map(String).sort());
  }
  return JSON.stringify(value ?? null);
}

/** Keys the panel has a field for but that the current mode makes inert. */
function inert(key: string, config: Record<string, unknown>): boolean {
  if (key.startsWith('broad_category_') && key !== 'broad_category_mode') {
    return config.broad_category_mode === 'off';
  }
  if (key === 'broad_picks_per_category' || key === 'broad_coverage_floor') {
    return config.broad_category_mode === 'off';
  }
  if (key === 'broad_off_top_n' || key === 'broad_off_exit_rank') {
    return config.broad_category_mode !== 'off';
  }
  return false;
}

/**
 * The accordions holding at least one setting that differs from the dataset's defaults, for the
 * "modified" dot on each header. Both arguments are full configs in the shape a run is sent in
 * (`start`, `top_n`, `lookbacks`, `universe`, …). Keys the dataset ignores never count.
 */
export function modifiedSections(
  config: Record<string, unknown>,
  defaults: Record<string, unknown>,
  dataset: string,
): Set<MomentumSettingsSection> {
  const modified = new Set<MomentumSettingsSection>();
  for (const key of Object.keys(KEYS)) {
    const section = settingsSectionOf(key, dataset);
    if (section === null || modified.has(section)) continue;
    if (!(key in config) && !(key in defaults)) continue;
    if (inert(key, config)) continue;
    if (comparable(key, config[key]) !== comparable(key, defaults[key])) modified.add(section);
  }
  return modified;
}

function shown(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') {
    return KEYS[key]?.fraction
      ? `${formatNumber(value * 100, 2, { trim: true })}%`
      : formatNumber(value, 2, { trim: true });
  }
  if (Array.isArray(value)) {
    return key === 'universe' ? `${value.length} selected` : value.map(String).join('/');
  }
  return String(value);
}

/**
 * What changed between two run configs, as short "Top N 5 → 8" lines labelled with the settings
 * panel's own words (the raw key when the panel has no field for it). Keys the newer run's
 * dataset ignores are left out; a dataset change is reported on its own, since every other key
 * then means something different.
 */
export function diffConfigs(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const dataset = String(next.dataset ?? '');
  if (String(previous.dataset ?? '') !== dataset) {
    return [`Dataset ${shown('dataset', previous.dataset)} → ${shown('dataset', next.dataset)}`];
  }
  const known = Object.keys(KEYS);
  const extra = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => !(key in KEYS) && key !== 'dataset' && key !== 'fresh')
    .sort();
  const lines: string[] = [];
  for (const key of [...known, ...extra]) {
    const info = KEYS[key];
    if (info && !applies(info, dataset)) continue;
    if (!(key in previous) && !(key in next)) continue;
    if (inert(key, previous) && inert(key, next)) continue;
    if (comparable(key, previous[key]) === comparable(key, next[key])) continue;
    if (key === 'universe' && Array.isArray(previous[key]) && Array.isArray(next[key])) {
      const before = new Set((previous[key] as unknown[]).map(String));
      const after = new Set((next[key] as unknown[]).map(String));
      const added = [...after].filter((name) => !before.has(name)).length;
      const removed = [...before].filter((name) => !after.has(name)).length;
      lines.push(`Universe ${before.size} → ${after.size} (+${added} / −${removed})`);
      continue;
    }
    lines.push(`${info?.label ?? key} ${shown(key, previous[key])} → ${shown(key, next[key])}`);
  }
  return lines;
}

/**
 * Why a result's CAGR should not be read as an expected return, for the datasets whose history
 * uses hindsight (BL-010: today's stock list for every year, categories built from 2026
 * themes). Null for datasets without a known leak (ETF Rotation, the survivorship-free Nifty
 * 50 stock set). `realismOff` names the Broad realism switches this run left off.
 */
export interface HindsightWarning {
  headline: string;
  detail: string;
  realismOff: string[];
}

export function hindsightWarning(config: Record<string, unknown>): HindsightWarning | null {
  const dataset = config.dataset;
  if (dataset === 'broad') {
    const realismOff = [
      config.broad_respect_circuits === true ? null : 'circuit locks',
      config.broad_liquidity_filter === true || config.broad_universe === 'all_liquid'
        ? null
        : 'the tradability filter',
    ].filter((item): item is string => item !== null);
    return {
      headline: 'Treat this CAGR as an upper bound, not an expected return.',
      detail:
        "Every year since 2017 uses today's stock list, so most stocks that later fell out or were delisted are missing, and the categories come from 2026 themes. Real returns are likely well below this until BL-010 re-measures it point-in-time.",
      realismOff,
    };
  }
  if (dataset === 'custom_index') {
    return {
      headline: 'Treat this CAGR as an upper bound, not an expected return.',
      detail:
        "The categories and their member stocks come from 2026 themes and today's lists, so earlier years benefit from hindsight (BL-010).",
      realismOff: [],
    };
  }
  return null;
}
