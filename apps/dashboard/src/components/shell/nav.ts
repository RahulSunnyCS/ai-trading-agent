import {
  Activity,
  BookOpen,
  Building2,
  CalendarClock,
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
  | 'jobs'
  | 'optionslab'
  | 'momentum'
  | 'brokerLogins'
  | 'pricing'
  | 'settings'
  | 'guide';

/** A deep link to a sub-route of a tab, e.g. /momentum/scores. */
export interface NavChild {
  /** First path segment after the tab. */
  segment: string;
  label: string;
  /**
   * A heading the sidebar shows above the first child of each run of children sharing it
   * (Options Lab's workspaces: Today, Explore data, Build and test).
   */
  group?: string;
  /**
   * Reachable by URL and still a valid sub-route, but not listed in the sidebar (Options Lab's
   * Daily results, hidden in BL-102; its links and Guide walkthroughs keep working).
   */
  hidden?: boolean;
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

export type NavGroupId =
  | 'overview'
  | 'live'
  | 'optionslab'
  | 'momentum'
  | 'data'
  | 'account'
  | 'help';

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
 * lib/routes.ts) so stored preferences and existing callers need no change. The Guide (BL-041)
 * is the last group; its children are the guide's chapters (guide/registry.ts, a test checks).
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
        // Three workspaces (BL-102): /optionslab opens Today, the rotation lists' page.
        defaultSegment: 'rotation',
        children: [
          { segment: 'rotation', label: 'Today', group: 'Today' },
          { segment: 'heatmap', label: 'Heatmap', group: 'Explore data' },
          { segment: 'matrix', label: 'Matrix', group: 'Explore data' },
          { segment: 'correlation', label: 'Correlation', group: 'Explore data' },
          { segment: 'regimes', label: 'Regimes', group: 'Explore data' },
          { segment: 'strategies', label: 'Strategies', group: 'Build and test' },
          { segment: 'builder', label: 'Builder', group: 'Build and test' },
          { segment: 'runs', label: 'Runs', group: 'Build and test' },
          { segment: 'results', label: 'Daily results', group: 'Build and test', hidden: true },
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
          { segment: 'week', label: 'This week' },
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
      { id: 'jobs', label: 'Jobs', icon: CalendarClock },
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
  {
    id: 'help',
    heading: 'Help',
    icon: BookOpen,
    items: [
      {
        id: 'guide',
        label: 'Guide',
        icon: BookOpen,
        children: [
          { segment: 'start', label: 'Start here' },
          { segment: 'momentum', label: 'Momentum' },
          { segment: 'optionslab', label: 'Options Lab' },
          { segment: 'operations', label: 'Data & operations' },
          { segment: 'glossary', label: 'Glossary' },
        ],
      },
    ],
  },
];

/**
 * Tabs that cannot be hidden: Settings, so users can always restore tabs they have hidden, and
 * the Guide, so the help is always one click away.
 */
export const PINNED_TABS: readonly Tab[] = ['settings', 'guide'];

export const CONFIGURABLE_TABS = NAV_GROUPS.flatMap((group) => group.items).filter(
  (item) => !PINNED_TABS.includes(item.id),
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
