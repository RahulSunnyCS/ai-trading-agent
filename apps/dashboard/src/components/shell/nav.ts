import {
  Activity,
  Building2,
  CreditCard,
  Database,
  Layers,
  LayoutDashboard,
  LineChart,
  type LucideIcon,
  Repeat,
  Settings,
  Tag,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';

/** The dashboard views. */
export type Tab =
  | 'overview'
  | 'live'
  | 'trades'
  | 'personalities'
  | 'pnl'
  | 'regime'
  | 'coverage'
  | 'optionslab'
  | 'momentum'
  | 'brokerLogins'
  | 'pricing'
  | 'settings';

/** A deep link to a sub-route of a tab, e.g. /momentum/scores. */
export interface NavChild {
  /** First path segment after the tab. */
  segment: string;
  label: string;
}

export interface NavItem {
  id: Tab;
  label: string;
  icon: LucideIcon;
  /**
   * The tab's sub-routes, shown nested under it while it is the active tab.
   * The view opens `defaultSegment` when the URL names none, else the first child.
   */
  children?: NavChild[];
  /** The child the bare tab path opens, when that is not the first one listed. */
  defaultSegment?: string;
}

export type NavGroupId = 'overview' | 'live' | 'optionslab' | 'momentum' | 'data' | 'account';

export interface NavGroup {
  id: NavGroupId;
  heading: string;
  /** Stands for the whole section in the mobile bottom bar. */
  icon: LucideIcon;
  items: NavItem[];
}

/**
 * Navigation grouped by product. Drives the sidebar, the mobile drawer, the
 * mobile bottom bar and the Settings tab list.
 *
 * Overview (the landing view) is its own first group. The YAML backtest is no
 * longer a tab: it is the Options Lab builder's YAML mode (/optionslab/builder/yaml),
 * and /backtest redirects there. Backfill and Replay are the two sections of Data ›
 * Coverage (/coverage/backfill, /coverage/replay); their old paths redirect. Pricing is
 * labelled Billing and lives at /billing, keeping its `pricing` id (see TAB_SEGMENT in
 * lib/routes.ts) so stored preferences and existing callers need no change.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    heading: 'Overview',
    icon: LayoutDashboard,
    items: [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }],
  },
  {
    id: 'live',
    heading: 'Live',
    icon: Activity,
    items: [
      { id: 'live', label: 'Live', icon: Activity },
      { id: 'trades', label: 'Trades', icon: Repeat },
      { id: 'pnl', label: 'P&L', icon: Wallet },
      { id: 'personalities', label: 'Personalities', icon: Users },
      { id: 'regime', label: 'Regimes', icon: Tag },
    ],
  },
  {
    id: 'optionslab',
    heading: 'Options Lab',
    icon: Layers,
    items: [
      {
        id: 'optionslab',
        label: 'Options Lab',
        icon: Layers,
        // /optionslab keeps opening Daily results, as it did before Strategies and Runs existed.
        defaultSegment: 'results',
        children: [
          { segment: 'strategies', label: 'Strategies' },
          { segment: 'builder', label: 'Builder' },
          { segment: 'runs', label: 'Runs' },
          { segment: 'results', label: 'Daily results' },
          { segment: 'regimes', label: 'Regimes' },
        ],
      },
    ],
  },
  {
    id: 'momentum',
    heading: 'Momentum',
    icon: LineChart,
    items: [
      {
        id: 'momentum',
        label: 'Momentum',
        icon: LineChart,
        children: [
          { segment: 'backtest', label: 'Backtest' },
          { segment: 'scores', label: 'Scores' },
          { segment: 'saved', label: 'Saved runs' },
          { segment: 'weekly', label: 'Weekly signal' },
          { segment: 'rebalance', label: 'Rebalance' },
          { segment: 'journal', label: 'Journal' },
        ],
      },
    ],
  },
  {
    id: 'data',
    heading: 'Data',
    icon: Database,
    items: [
      {
        id: 'coverage',
        label: 'Coverage',
        icon: Database,
        children: [
          { segment: 'backfill', label: 'Backfill' },
          { segment: 'replay', label: 'Replay' },
        ],
      },
    ],
  },
  {
    id: 'account',
    heading: 'Account',
    icon: Settings,
    items: [
      { id: 'brokerLogins', label: 'Broker logins', icon: Building2 },
      { id: 'pricing', label: 'Billing', icon: CreditCard },
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

/** Settings is pinned so users can always restore tabs they have hidden. */
export const CONFIGURABLE_TABS = NAV_GROUPS.flatMap((group) => group.items).filter(
  (item) => item.id !== 'settings',
);

export const BrandIcon = TrendingUp;

export function navItem(tab: Tab): NavItem | undefined {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.id === tab);
    if (item) return item;
  }
  return undefined;
}

export function tabLabel(tab: Tab): string {
  return navItem(tab)?.label ?? tab;
}

/** The group a tab sits in. */
export function tabGroupId(tab: Tab): NavGroupId | undefined {
  return NAV_GROUPS.find((group) => group.items.some((item) => item.id === tab))?.id;
}

/**
 * The child a route points at: the one named by the first segment after the
 * tab, else the view's default (`defaultSegment`, or the first child). Undefined
 * for a tab with no sub-routes.
 */
export function activeNavChild(item: NavItem, rest: readonly string[]): NavChild | undefined {
  if (!item.children) return undefined;
  const find = (segment: string | undefined) =>
    item.children?.find((child) => child.segment === segment);
  return find(rest[0]) ?? find(item.defaultSegment) ?? item.children[0];
}
