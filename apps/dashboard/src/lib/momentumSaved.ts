/**
 * Saved strategies (BL-052): names, differences from the defaults, trust and "why it moved"
 * wording, filters and the toast a saved run gets. The server decides what a strategy is and
 * why a result moved (`runs_store.py`, `saved_identity.py`); these helpers only describe it.
 */
import type {
  FavouriteStatus,
  MomentumSaveOutcome,
  MomentumSavedRun,
  ResultChange,
  ResultChangeLabel,
  SavedStrategy,
  StrategyTrust,
} from '../types/momentum';
import { formatDay, formatPct, formatPp } from './format';
import { type SettingDifference, completeConfig, differingSettings } from './momentumCompare';
import { BROAD_UNIVERSES, broadUniverse } from './momentumUniverse';

export const DATASET_SHORT: Record<string, string> = {
  etf: 'ETF',
  stock: 'Stocks',
  custom_index: 'Custom Index',
  broad: 'Broad',
};

/** Settings never shown as a difference: what the run is of, not how it is run. */
const NOT_A_DIFFERENCE = new Set(['dataset', 'universe', 'end', 'fresh']);

/** How many differences an automatic name lists before it stops. */
const NAME_DIFFERENCES = 3;

/**
 * The settings in which `strategy` differs from its dataset's defaults, as [this, default]
 * pairs: a setting the strategy never stored counts as the default, and a setting the dataset
 * never reads (`ignored`, from the server) is left out.
 */
export function strategyDifferences(
  config: Record<string, unknown>,
  defaults: Record<string, unknown>,
  ignored: ReadonlyArray<string> = [],
): SettingDifference[] {
  const skip = new Set([...NOT_A_DIFFERENCE, ...ignored]);
  // Weights count only for the ranksum score, and equal weights are the same as none (the
  // server's normalisation, saved_identity.normalise).
  const score = config.score ?? defaults.score ?? 'ranksum';
  const weights = Array.isArray(config.weights) ? (config.weights as unknown[]) : [];
  if (score !== 'ranksum' || weights.every((w) => w === weights[0])) skip.add('weights');
  const keep = (source: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(source).filter(([key]) => !skip.has(key)));
  const base = keep(defaults);
  return differingSettings([keep(completeConfig(base, config)), base]);
}

/** "Broad · Liquidity filter Off · Respect circuits Off", or "Broad · defaults". */
export function autoName(dataset: string, differences: ReadonlyArray<SettingDifference>): string {
  const label = DATASET_SHORT[dataset] ?? dataset;
  if (differences.length === 0) return `${label} · defaults`;
  const parts = differences
    .slice(0, NAME_DIFFERENCES)
    .map((difference) => `${difference.label} ${difference.values[0]}`);
  const more = differences.length - NAME_DIFFERENCES;
  return [label, ...parts].join(' · ') + (more > 0 ? ` +${more}` : '');
}

/** The name to show: the one typed, else an automatic one when the defaults are known. */
export function strategyName(
  strategy: Pick<SavedStrategy, 'name' | 'name_typed' | 'dataset' | 'config' | 'group'>,
  defaults: Record<string, unknown> | undefined,
  ignored: ReadonlyArray<string> = [],
): string {
  if (strategy.name_typed || strategy.group || !defaults) return strategy.name;
  return autoName(strategy.dataset, strategyDifferences(strategy.config, defaults, ignored));
}

type Tone = 'positive' | 'negative' | 'warning' | 'info' | 'neutral';

export const TRUST: Record<StrategyTrust, { label: string; tone: Tone; hint: string }> = {
  validated: {
    label: 'Validated',
    tone: 'positive',
    hint: "One of the frozen Phase 6 ensemble's configs: chosen by walk-forward and tested on data the choice never saw.",
  },
  not_tradable: {
    label: 'Not tradable',
    tone: 'warning',
    hint: 'Broad with the liquidity filter or the circuit rule off: it buys stocks too thin to fill or fills on circuit-locked days, so the result cannot be traded as tested.',
  },
  old_data: {
    label: 'Old data',
    tone: 'warning',
    hint: 'Its latest run ends more than a week before the newest saved data. Re-run it to compare it with the rest.',
  },
  in_sample: {
    label: 'In-sample',
    tone: 'neutral',
    hint: 'The best of what was tried on the same data. A high number here is expected and has not been tested out of sample.',
  },
};

export const CHANGE: Record<ResultChangeLabel, { label: string; tone: Tone; hint: string }> = {
  data_revised: {
    label: 'Data revised',
    tone: 'info',
    hint: 'Same code, new data: expected when prices or corporate actions are revised.',
  },
  intended: {
    label: 'Intended change',
    tone: 'info',
    hint: 'The code changed and an accepted golden change of this dataset lies in between.',
  },
  check: {
    label: 'Check',
    tone: 'warning',
    hint: 'The code changed but no accepted golden change of this dataset explains it, or code and data both changed. Possibly a bug the goldens miss.',
  },
  not_reproducible: {
    label: 'Not reproducible',
    tone: 'negative',
    hint: 'Same settings, same code, same data, different result: a bug.',
  },
  unknown: {
    label: 'Unknown',
    tone: 'neutral',
    hint: 'Saved before runs recorded their code and data, so the cause cannot be told.',
  },
};

/** The CAGR move a change made, as a fraction (for `formatPp`). */
export function cagrMove(change: Pick<ResultChange, 'kpis_before' | 'kpis_after'>): number | null {
  const before = change.kpis_before?.cagr;
  const after = change.kpis_after?.cagr;
  return typeof before === 'number' && typeof after === 'number' ? after - before : null;
}

/** One sentence on why a result moved, for the drawer and the toast. */
export function changeSentence(change: ResultChange): string {
  const from = change.first_difference
    ? ` The curves first differ in the week of ${formatDay(change.first_difference)}.`
    : '';
  switch (change.label) {
    case 'data_revised': {
      const what = change.changed?.length ? change.changed.join(', ') : 'the data';
      return `Same code, new data: ${what} changed.${from}`;
    }
    case 'intended':
      return `The code changed with an accepted golden change of this dataset: "${change.detail?.reason ?? 'no reason written'}".${from}`;
    case 'check':
      return `The code changed and no accepted golden change of this dataset explains it.${from} Re-run it to check.`;
    case 'not_reproducible':
      return `Same settings, code and data gave a different result: a bug.${from}`;
    default:
      return `Saved before runs recorded their code and data, so the cause cannot be told.${from}`;
  }
}

/** A commit id or data version as shown: the first 7 characters, "+dirty" kept. */
export function shortVersion(value: string | null | undefined): string {
  if (!value) return 'not recorded';
  const dirty = value.endsWith('+dirty');
  const base = dirty ? value.slice(0, -'+dirty'.length) : value;
  return `${base.slice(0, 7)}${dirty ? ' +dirty' : ''}`;
}

export type DatasetFilter = 'all' | 'etf' | 'stock' | 'custom_index' | 'broad';
export type StatusFilter = 'any' | 'favourites' | FavouriteStatus;

export function matchesStrategy(
  strategy: SavedStrategy,
  name: string,
  dataset: DatasetFilter,
  status: StatusFilter,
  query: string,
): boolean {
  if (dataset !== 'all' && strategy.dataset !== dataset) return false;
  if (status === 'favourites' && !strategy.favorite) return false;
  if (status !== 'any' && status !== 'favourites' && strategy.status !== status) return false;
  const needle = query.trim().toLowerCase();
  return !needle || name.toLowerCase().includes(needle);
}

/** Strategies per dataset filter and per status filter, for the filters' labels. */
export function strategyCounts(strategies: ReadonlyArray<SavedStrategy>): {
  dataset: Record<DatasetFilter, number>;
  status: Record<StatusFilter, number>;
} {
  const dataset: Record<DatasetFilter, number> = {
    all: strategies.length,
    etf: 0,
    stock: 0,
    custom_index: 0,
    broad: 0,
  };
  const status: Record<StatusFilter, number> = {
    any: strategies.length,
    favourites: 0,
    watching: 0,
    paper: 0,
    invested: 0,
  };
  for (const strategy of strategies) {
    if (strategy.dataset in dataset) dataset[strategy.dataset as DatasetFilter] += 1;
    if (strategy.favorite) status.favourites += 1;
    if (strategy.status) status[strategy.status] += 1;
  }
  return { dataset, status };
}

/**
 * A strategy in the shape the existing sorting and Compare view take (`MomentumSavedRun`): its
 * latest run's numbers and curve, under the strategy's id and shown name.
 */
export function asSavedRun(strategy: SavedStrategy, name: string): MomentumSavedRun {
  return {
    id: strategy.id,
    created_at: strategy.last_run,
    n: 0,
    name,
    config: { dataset: strategy.dataset, ...strategy.config },
    kpis: strategy.latest.kpis,
    dates: strategy.latest.dates,
    strategy: strategy.latest.strategy,
    overlay: strategy.overlay,
    favorite: strategy.favorite,
    active: strategy.active,
    status: strategy.status,
    group: strategy.group,
    member_of: strategy.member_of,
  };
}

/** What the Backtest page says once a finished run is saved: where it went (BL-052). */
export function saveToast(saved: MomentumSaveOutcome): {
  message: string;
  tone: 'success' | 'info' | 'error';
} {
  const ref = saved.strategy_ref;
  const dataset = DATASET_SHORT[String(saved.config?.dataset ?? '')] ?? '';
  const name =
    ref?.name_typed && ref.name
      ? `"${ref.name}"`
      : dataset
        ? `a saved ${dataset} strategy`
        : 'a saved strategy';
  if (saved.outcome === 'repeat') {
    return { message: `Same settings and result as ${name}: no new strategy saved.`, tone: 'info' };
  }
  if (saved.outcome === 'new_result' && saved.change) {
    const move = cagrMove(saved.change);
    const label = CHANGE[saved.change.label].label;
    return {
      message: `Same settings as ${name}, but the result moved${move === null ? '' : ` ${formatPp(move)} CAGR`}: ${label}. Added to its history.`,
      tone:
        saved.change.label === 'check' || saved.change.label === 'not_reproducible'
          ? 'error'
          : 'info',
    };
  }
  return { message: 'Saved as a new strategy in Saved runs.', tone: 'success' };
}

/**
 * Which stocks a Broad strategy ranks, as a short tag for the Saved runs list: two strategies
 * with the same CAGR on different universes are not the same claim. `config_full` has every
 * request default spelled out, so an old run with no stored universe reads as today's list.
 */
export function universeTag(
  strategy: Pick<SavedStrategy, 'dataset' | 'config' | 'config_full'>,
): string | null {
  if (strategy.dataset !== 'broad') return null;
  return BROAD_UNIVERSES[broadUniverse(strategy.config_full ?? strategy.config)].short;
}

export interface ExtendedFigure {
  cagr: number;
  maxDrawdown: number | null;
}

/** The extended-tags figure stored beside a run's KPIs; null on a run saved before it existed. */
export function extendedKpis(kpis: Record<string, number | null>): ExtendedFigure | null {
  const cagr = kpis.extended_cagr;
  if (typeof cagr !== 'number') return null;
  const drawdown = kpis.extended_max_drawdown;
  return { cagr, maxDrawdown: typeof drawdown === 'number' ? drawdown : null };
}

/** "With extended tags: 33.4% CAGR · -38.6% max DD", for a title or the drawer. */
export function extendedSentence(figure: ExtendedFigure): string {
  return `With extended tags: ${formatPct(figure.cagr)} CAGR${
    figure.maxDrawdown === null ? '' : ` · ${formatPct(figure.maxDrawdown)} max DD`
  }`;
}
