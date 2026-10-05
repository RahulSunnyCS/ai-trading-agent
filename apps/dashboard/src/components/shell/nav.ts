import {
  Activity,
  Building2,
  CalendarClock,
  CreditCard,
  Database,
  FlaskConical,
  Layers,
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
  | 'live'
  | 'trades'
  | 'personalities'
  | 'pnl'
  | 'regime'
  | 'backfill'
  | 'replay'
  | 'backtest'
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
   * The first child is the one the view opens when the URL names none.
   */
  children?: NavChild[];
}

export type NavGroupId = 'live' | 'optionslab' | 'momentum' | 'data' | 'account';

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
 * Tab ids and URLs are unchanged from the old Trading / Research / Account
 * grouping; only the grouping and two labels moved. Screens the plan adds later
 * (Overview, Options Lab strategies/runs, a merged Data coverage page, Billing)
 * are deliberately absent until they exist.
 */
export const NAV_GROUPS: NavGroup[] = [
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
        children: [
          { segment: 'results', label: 'Daily results' },
          { segment: 'regimes', label: 'Market regimes' },
          { segment: 'builder', label: 'Strategy builder' },
        ],
      },
      { id: 'backtest', label: 'YAML backtest', icon: FlaskConical },
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
        ],
      },
    ],
  },
  {
    id: 'data',
    heading: 'Data',
    icon: Database,
    items: [
      { id: 'backfill', label: 'Backfill', icon: Database },
      { id: 'replay', label: 'Replay', icon: CalendarClock },
    ],
  },
  {
    id: 'account',
    heading: 'Account',
    icon: Settings,
    items: [
      { id: 'brokerLogins', label: 'Broker logins', icon: Building2 },
      { id: 'pricing', label: 'Pricing', icon: CreditCard },
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
 * tab, else the first child (the view's default). Undefined for a tab with no
 * sub-routes.
 */
export function activeNavChild(item: NavItem, rest: readonly string[]): NavChild | undefined {
  if (!item.children) return undefined;
  return item.children.find((child) => child.segment === rest[0]) ?? item.children[0];
}
