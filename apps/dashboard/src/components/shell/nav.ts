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

export interface NavItem {
  id: Tab;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/** Grouped navigation — drives both the sidebar and the mobile drawer. */
export const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Trading',
    items: [
      { id: 'live', label: 'Live', icon: Activity },
      { id: 'trades', label: 'Trades', icon: Repeat },
      { id: 'personalities', label: 'Personalities', icon: Users },
      { id: 'pnl', label: 'P&L', icon: Wallet },
    ],
  },
  {
    heading: 'Research',
    items: [
      { id: 'regime', label: 'Regimes', icon: Tag },
      { id: 'backfill', label: 'Backfill', icon: Database },
      { id: 'replay', label: 'Replay', icon: CalendarClock },
      { id: 'backtest', label: 'Backtest', icon: FlaskConical },
      { id: 'optionslab', label: 'Options Lab', icon: Layers },
      { id: 'momentum', label: 'Momentum', icon: LineChart },
    ],
  },
  {
    heading: 'Account',
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

export function tabLabel(tab: Tab): string {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.id === tab);
    if (item) return item.label;
  }
  return tab;
}
