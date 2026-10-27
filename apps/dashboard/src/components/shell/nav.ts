import {
  Activity,
  Archive,
  BookOpen,
  Building2,
  CalendarClock,
  CreditCard,
  Database,
  Layers,
  LayoutDashboard,
  LineChart,
  type LucideIcon,
  NotebookText,
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
  | 'tradebook'
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
   * (Options Lab's workspaces: Today, Explore data, Build and test, Advanced).
   */
  group?: string;
  /**
   * Reachable by URL and still a valid sub-route, but not listed in the sidebar (Options Lab's
   * a page kept out of the sidebar but still routed).
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
  | 'optionslab'
  | 'momentum'
  | 'tradebook'
  | 'operations'
  | 'archived';

export interface NavGroup {
  id: NavGroupId;
  heading: string;
  /** Stands for the whole section in the mobile bottom bar. */
  icon: LucideIcon;
  items: NavItem[];
  /** One line under the section's heading in Settings › Navigation. */
  note?: string;
}

/**
 * Navigation grouped by product. Drives the sidebar, the mobile drawer, the
 * mobile bottom bar and the Settings tab list.
 *
 * The pages used every day come first: Overview (the landing view), Options Lab (with Live, the
 * replay of a collected day, whose data comes from the options API), Momentum, Trade book, then
 * Operations (Jobs, Broker logins, Settings and the Guide). The last group, Archived engine, holds
 * the frozen personality engine's screens and the two that read the same frozen server (Coverage,
 * Billing); its tabs start hidden (store/navigation.ts), Settings › Navigation shows them again,
 * and each still opens by its link.
 *
 * The YAML backtest is no longer a tab: it is the Options Lab builder's YAML mode
 * (/optionslab/builder/yaml), and /backtest redirects there. Backfill and Replay are the two
 * sections of Coverage (/coverage/backfill, /coverage/replay); their old paths redirect. Pricing
 * is labelled Billing and lives at /billing, keeping its `pricing` id (see TAB_SEGMENT in
 * lib/routes.ts) so stored preferences and existing callers need no change. The Guide's children
 * are the guide's chapters (guide/registry.ts, a test checks).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    heading: 'Overview',
    icon: LayoutDashboard,
    items: [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }],
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
          { segment: 'strategies', label: 'Strategies and baskets', group: 'Build and test' },
          { segment: 'builder', label: 'Builder', group: 'Build and test' },
          { segment: 'runs', label: 'Runs', group: 'Build and test' },
          // Kept, but out of the daily path (BL-102): index regimes are only known after the day.
          { segment: 'regimes', label: 'Regimes', group: 'Advanced' },
        ],
      },
      // The replay of a collected day, read from the options API until live capture exists.
      // Its path stays /live.
      { id: 'live', label: 'Live', icon: Activity },
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
          { segment: 'journal', label: 'Journal' },
        ],
      },
    ],
  },
  {
    id: 'tradebook',
    heading: 'Trade book',
    icon: NotebookText,
    items: [
      {
        id: 'tradebook',
        label: 'Trade book',
        icon: NotebookText,
        // The realised book from the brokers' contract notes (BL-168): F&O opens first.
        children: [
          { segment: 'fno', label: 'F&O' },
          { segment: 'trades', label: 'Trades' },
          { segment: 'money', label: 'Money' },
          { segment: 'momentum', label: 'Momentum' },
        ],
      },
    ],
  },
  {
    id: 'operations',
    heading: 'Operations',
    icon: CalendarClock,
    items: [
      { id: 'jobs', label: 'Jobs', icon: CalendarClock },
      { id: 'brokerLogins', label: 'Broker logins', icon: Building2 },
      { id: 'settings', label: 'Settings', icon: Settings },
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
  {
    id: 'archived',
    heading: 'Archived engine',
    icon: Archive,
    note: 'The frozen paper-trading engine and the screens that read its server (Coverage, Billing). Hidden until you show them here; each still opens by its link.',
    items: [
      { id: 'trades', label: 'Trades', icon: Repeat },
      { id: 'pnl', label: 'P&L', icon: Wallet },
      { id: 'personalities', label: 'Personalities', icon: Users },
      { id: 'regime', label: 'Regimes', icon: Tag },
      {
        id: 'coverage',
        label: 'Coverage',
        icon: Database,
        children: [
          { segment: 'backfill', label: 'Backfill' },
          { segment: 'replay', label: 'Replay' },
        ],
      },
      { id: 'pricing', label: 'Billing', icon: CreditCard },
    ],
  },
];

/** The Archived engine's tabs: hidden from the sidebar by default, still opened by their URL. */
export const ARCHIVED_TABS: readonly Tab[] =
  NAV_GROUPS.find((group) => group.id === 'archived')?.items.map((item) => item.id) ?? [];

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
