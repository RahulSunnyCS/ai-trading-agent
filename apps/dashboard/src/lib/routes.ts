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
 * PATH_ALIASES lists the other paths that resolve to one of those: old URLs
 * that must keep working, and the names later phases of the redesign will use.
 *
 * Kept free of React/Next so it can be unit-tested; hooks live in useAppRoute.
 */

import { NAV_GROUPS, type Tab, activeNavChild, navItem } from '../components/shell/nav';

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

/**
 * Alias path -> the canonical path it resolves to. Matched on whole leading
 * segments, longest alias first, and whatever follows the alias is kept
 * (`/data/backfill/x` -> `/backfill/x`). The shell rewrites the address bar to
 * the canonical path, so an alias behaves like a redirect.
 *
 * When a later phase renames or merges a screen, its old path goes here.
 */
export const PATH_ALIASES: Readonly<Record<string, string>> = {
  '/billing': '/pricing',
  '/brokers': '/brokerLogins',
  '/brokerlogins': '/brokerLogins',
  '/data/backfill': '/backfill',
  '/data/replay': '/replay',
  '/optionslab/yaml': '/backtest',
};

const ALIASES = Object.entries(PATH_ALIASES)
  .map(([from, to]) => ({ from: splitPath(from), to: splitPath(to) }))
  .sort((a, b) => b.from.length - a.from.length);

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function resolveAlias(segments: string[]): string[] | null {
  for (const alias of ALIASES) {
    if (alias.from.every((segment, index) => segments[index] === segment)) {
      return [...alias.to, ...segments.slice(alias.from.length)];
    }
  }
  return null;
}

/** The canonical path an alias points at, or null when `pathname` is not an alias. */
export function aliasTarget(pathname: string): string | null {
  const resolved = resolveAlias(splitPath(pathname));
  return resolved ? `/${resolved.map(encodeURIComponent).join('/')}` : null;
}

export function parsePath(pathname: string): ParsedRoute {
  const raw = splitPath(pathname);
  const [first, ...rest] = resolveAlias(raw) ?? raw;
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

export const APP_NAME = 'AI Trading Agent';

/**
 * Browser-tab title for a route: "Trades · AI Trading Agent", or with the
 * sub-section for tabs that have them: "Momentum › Scores · AI Trading Agent".
 */
export function documentTitle(tab: Tab | null, rest: readonly string[] = []): string {
  if (!tab) return APP_NAME;
  const item = navItem(tab);
  if (!item) return APP_NAME;
  const child = activeNavChild(item, rest);
  const view = child ? `${item.label} › ${child.label}` : item.label;
  return `${view} · ${APP_NAME}`;
}
