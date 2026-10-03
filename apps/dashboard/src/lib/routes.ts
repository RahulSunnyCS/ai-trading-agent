/**
 * URL <-> navigation state. Every tab and sub-tab has a real path so a refresh,
 * back/forward and a pasted link land on the same view:
 *
 *   /live  /trades  /personalities  /pnl  /regime  /backfill  /replay  /backtest
 *   /optionslab/{results|regimes|builder}
 *   /momentum/{backtest|scores|saved|weekly|rebalance}
 *   /momentum/backtest/{etf|stock|custom_index|broad}
 *   /momentum/scores/{stocks|sectors}
 *   /brokerLogins  /pricing  /settings
 *
 * Kept free of React/Next so it can be unit-tested; hooks live in useAppRoute.
 */

import { NAV_GROUPS, type Tab } from '../components/shell/nav';

export const DEFAULT_TAB: Tab = 'live';

const TABS = new Set<string>(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)));

export const OPTIONS_LAB_SECTIONS = ['results', 'regimes', 'builder'] as const;
export type OptionsLabSection = (typeof OPTIONS_LAB_SECTIONS)[number];

export const MOMENTUM_SECTIONS = ['backtest', 'scores', 'saved', 'weekly', 'rebalance'] as const;
export type MomentumSection = (typeof MOMENTUM_SECTIONS)[number];

export const MOMENTUM_DATASETS = ['etf', 'stock', 'custom_index', 'broad'] as const;
export type MomentumDatasetId = (typeof MOMENTUM_DATASETS)[number];

export const MOMENTUM_SCORE_KINDS = ['stocks', 'sectors'] as const;
export type MomentumScoreKind = (typeof MOMENTUM_SCORE_KINDS)[number];

export interface ParsedRoute {
  /** null when the first segment is not a known tab (including "/"). */
  tab: Tab | null;
  /** Path segments after the tab, e.g. ['backtest', 'broad']. */
  rest: string[];
}

export function parsePath(pathname: string): ParsedRoute {
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [first, ...rest] = segments;
  return first && TABS.has(first) ? { tab: first as Tab, rest } : { tab: null, rest: [] };
}

export function buildPath(tab: Tab, ...rest: Array<string | undefined>): string {
  const parts = [tab, ...rest.filter((part): part is string => Boolean(part))];
  return `/${parts.map(encodeURIComponent).join('/')}`;
}

/** Returns `value` when it is one of `allowed`, otherwise null. */
export function oneOf<T extends string>(
  allowed: readonly T[],
  value: string | undefined,
): T | null {
  return allowed.find((item) => item === value) ?? null;
}
