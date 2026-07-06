import {
  Activity,
  CalendarClock,
  CreditCard,
  Database,
  type LucideIcon,
  Repeat,
  Tag,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';

/** The eight dashboard views. */
export type Tab =
  | 'live'
  | 'trades'
  | 'personalities'
  | 'pnl'
  | 'regime'
  | 'backfill'
  | 'replay'
  | 'pricing';

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
    ],
  },
  {
    heading: 'Account',
    items: [{ id: 'pricing', label: 'Pricing', icon: CreditCard }],
  },
];

export const BrandIcon = TrendingUp;

export function tabLabel(tab: Tab): string {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.id === tab);
    if (item) return item.label;
  }
  return tab;
}
