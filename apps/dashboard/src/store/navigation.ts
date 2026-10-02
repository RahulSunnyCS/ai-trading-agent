import { CONFIGURABLE_TABS, NAV_GROUPS, type NavGroup, type Tab } from '../components/shell/nav';

const STORAGE_KEY = 'ata.navigation.v1';
const CONFIGURABLE_IDS = CONFIGURABLE_TABS.map((item) => item.id);
const CONFIGURABLE_SET = new Set<Tab>(CONFIGURABLE_IDS);

export interface NavigationPreferences {
  hidden: Tab[];
  order: Tab[];
}

export const DEFAULT_NAVIGATION_PREFERENCES: NavigationPreferences = {
  hidden: [],
  order: [...CONFIGURABLE_IDS],
};

/** Repair stale/partial browser preferences when tabs are added or removed. */
export function normalizeNavigationPreferences(value: unknown): NavigationPreferences {
  const candidate =
    value && typeof value === 'object' ? (value as Partial<NavigationPreferences>) : {};
  const order = Array.isArray(candidate.order)
    ? candidate.order.filter((id): id is Tab => CONFIGURABLE_SET.has(id as Tab))
    : [];
  const uniqueOrder = [...new Set(order)];
  for (const id of CONFIGURABLE_IDS) {
    if (!uniqueOrder.includes(id)) uniqueOrder.push(id);
  }

  const hidden = Array.isArray(candidate.hidden)
    ? [...new Set(candidate.hidden.filter((id): id is Tab => CONFIGURABLE_SET.has(id as Tab)))]
    : [];
  return { hidden, order: uniqueOrder };
}

export function loadNavigationPreferences(): NavigationPreferences {
  if (typeof window === 'undefined') return DEFAULT_NAVIGATION_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeNavigationPreferences(JSON.parse(raw)) : DEFAULT_NAVIGATION_PREFERENCES;
  } catch {
    return DEFAULT_NAVIGATION_PREFERENCES;
  }
}

export function saveNavigationPreferences(preferences: NavigationPreferences): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(normalizeNavigationPreferences(preferences)),
  );
}

export function visibleNavigationGroups(preferences: NavigationPreferences): NavGroup[] {
  const rank = new Map(preferences.order.map((id, index) => [id, index]));
  const hidden = new Set(preferences.hidden);
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: [...group.items]
      .filter((item) => item.id === 'settings' || !hidden.has(item.id))
      .sort((a, b) => {
        if (a.id === 'settings') return 1;
        if (b.id === 'settings') return -1;
        return (
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        );
      }),
  })).filter((group) => group.items.length > 0);
}

export function moveTabBefore(order: Tab[], dragged: Tab, target: Tab): Tab[] {
  if (dragged === target || !order.includes(dragged) || !order.includes(target)) return order;
  const next = order.filter((id) => id !== dragged);
  next.splice(next.indexOf(target), 0, dragged);
  return next;
}

export function firstVisibleTab(preferences: NavigationPreferences): Tab {
  const hidden = new Set(preferences.hidden);
  return preferences.order.find((id) => !hidden.has(id)) ?? 'settings';
}
