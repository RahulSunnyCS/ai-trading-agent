/**
 * URL <-> navigation state. Every tab and sub-tab has a real path so a refresh,
 * back/forward and a pasted link land on the same view:
 *
 *   /overview
 *   /live  /trades  /personalities  /pnl  /regime
 *   /optionslab/{strategies|builder|runs|results|regimes|correlation|rotation|matrix}
 *   /optionslab/builder/yaml        (the builder's YAML mode; /optionslab/builder is the form)
 *   /momentum/{backtest|scores|saved|week|rebalance|journal} (old /momentum/weekly redirects)
 *   /momentum/backtest/{etf|stock|custom_index|broad}
 *   /momentum/scores/{stocks|sectors}
 *   /coverage/{backfill|replay}
 *   /brokerLogins  /billing  /settings
 *   /guide/{start|momentum|optionslab|operations|glossary}/<page>
 *
 * A path's first segment is the tab id, except where TAB_SEGMENT says otherwise (the
 * `pricing` tab lives at /billing).
 *
 * PATH_ALIASES lists the other paths that resolve to one of those: old URLs
 * that must keep working, and the names later phases of the redesign will use.
 *
 * Kept free of React/Next so it can be unit-tested; hooks live in useAppRoute.
 */

import { NAV_GROUPS, type Tab, activeNavChild, navItem } from '../components/shell/nav';

/** Rendered while "/" (or an unknown path) is being redirected to the landing tab. */
export const DEFAULT_TAB: Tab = 'overview';

/**
 * Tabs whose URL segment differs from their id. Pricing was renamed Billing (BL-013 Phase 8):
 * the id stays `pricing`, so stored navigation preferences and `navigate('pricing')` callers
 * keep working, while the address bar says /billing.
 */
const TAB_SEGMENT: Readonly<Partial<Record<Tab, string>>> = { pricing: 'billing' };

/** The first path segment of a tab's URL. */
export function tabSegment(tab: Tab): string {
  return TAB_SEGMENT[tab] ?? tab;
}

/** First path segment -> tab. */
const TAB_BY_SEGMENT = new Map<string, Tab>(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [tabSegment(item.id), item.id])),
);

/** In display order. Must match the Options Lab nav item's children (a test checks it). */
export const OPTIONS_LAB_SECTIONS = [
  'strategies',
  'builder',
  'runs',
  'results',
  'regimes',
  'correlation',
  'rotation',
  'matrix',
] as const;
export type OptionsLabSection = (typeof OPTIONS_LAB_SECTIONS)[number];

/** What `/optionslab` opens. Daily results was the default before the other sections existed. */
export const OPTIONS_LAB_DEFAULT_SECTION: OptionsLabSection = 'results';

/** `/optionslab/builder` is the form; `/optionslab/builder/yaml` is the YAML engine. */
export const BUILDER_MODES = ['form', 'yaml'] as const;
export type BuilderMode = (typeof BUILDER_MODES)[number];

/** The builder mode a route's segments name (`rest` is what follows `/optionslab`). */
export function builderMode(rest: readonly string[]): BuilderMode {
  return rest[0] === 'builder' && rest[1] === 'yaml' ? 'yaml' : 'form';
}

/** Data › Coverage's sections, in display order. Must match the Coverage nav item's children. */
export const COVERAGE_SECTIONS = ['backfill', 'replay'] as const;
export type CoverageSection = (typeof COVERAGE_SECTIONS)[number];

/** What `/coverage` opens. */
export const COVERAGE_DEFAULT_SECTION: CoverageSection = 'backfill';

export const MOMENTUM_SECTIONS = [
  'backtest',
  'scores',
  'saved',
  'week',
  'rebalance',
  'journal',
] as const;
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
 * (`/pricing/x` -> `/billing/x`). The shell rewrites the address bar to the
 * canonical path, so an alias behaves like a redirect.
 *
 * When a later phase renames or merges a screen, its old path goes here.
 */
export const PATH_ALIASES: Readonly<Record<string, string>> = {
  // Weekly signal became This week (BL-051 Phase 2).
  '/momentum/weekly': '/momentum/week',
  // Pricing was renamed Billing (BL-013 Phase 8).
  '/pricing': '/billing',
  '/brokers': '/brokerLogins',
  '/brokerlogins': '/brokerLogins',
  // The Backfill and Replay tabs became Data › Coverage's two sections (BL-013 Phase 8).
  '/backfill': '/coverage/backfill',
  '/replay': '/coverage/replay',
  '/data/backfill': '/coverage/backfill',
  '/data/replay': '/coverage/replay',
  // The standalone YAML Backtest tab became the builder's YAML mode (BL-013 Phase 7).
  '/backtest': '/optionslab/builder/yaml',
  '/optionslab/yaml': '/optionslab/builder/yaml',
  // The Guide (BL-041) answers to the names people try first.
  '/help': '/guide',
  '/docs': '/guide',
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
  const tab = first === undefined ? undefined : TAB_BY_SEGMENT.get(first);
  return tab ? { tab, rest } : { tab: null, rest: [] };
}

export function buildPath(tab: Tab, ...rest: Array<string | undefined>): string {
  const parts = [tabSegment(tab), ...rest.filter((part): part is string => Boolean(part))];
  return `/${parts.map(encodeURIComponent).join('/')}`;
}

/** Returns `value` when it is one of `allowed`, otherwise null. */
export function oneOf<T extends string>(
  allowed: readonly T[],
  value: string | undefined,
): T | null {
  return allowed.find((item) => item === value) ?? null;
}

/**
 * A page laid out on the Analytics page pattern (apps/dashboard/CLAUDE.md): the navigation
 * shrinks to an icon rail and the page takes the full width, so its hero chart can too.
 * Momentum's Backtest section, the section `/momentum` opens on, is the first.
 */
export function isAnalyticsPage(tab: Tab | null, rest: readonly string[] = []): boolean {
  return tab === 'momentum' && (oneOf(MOMENTUM_SECTIONS, rest[0]) ?? 'backtest') === 'backtest';
}

export const APP_NAME = 'AI Trading Agent';

/**
 * Browser-tab title for a route: "Trades · AI Trading Agent", or with the
 * sub-section for tabs that have them: "Momentum › Scores · AI Trading Agent". The
 * builder's YAML mode adds its own level: "Options Lab › Builder › YAML · AI Trading Agent".
 */
export function documentTitle(tab: Tab | null, rest: readonly string[] = []): string {
  if (!tab) return APP_NAME;
  const item = navItem(tab);
  if (!item) return APP_NAME;
  const child = activeNavChild(item, rest);
  let view = child ? `${item.label} › ${child.label}` : item.label;
  if (tab === 'optionslab' && builderMode(rest) === 'yaml') view += ' › YAML';
  return `${view} · ${APP_NAME}`;
}
