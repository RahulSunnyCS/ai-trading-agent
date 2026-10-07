import {
  CONFIGURABLE_TABS,
  NAV_GROUPS,
  type NavGroup,
  PINNED_TABS,
  type Tab,
} from '../components/shell/nav';

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

/**
 * Retired tab id -> the tab that absorbed it. Unlike `backtest` (dropped), these were merged
 * one-for-one into a tab that shows the same thing.
 */
export const MERGED_TABS: ReadonlyMap<string, Tab> = new Map<string, Tab>([
  ['backfill', 'coverage'],
  ['replay', 'coverage'],
]);

/** Tab -> the retired ids merged into it. */
const MERGED_FROM = new Map<Tab, string[]>();
for (const [old, tab] of MERGED_TABS) {
  MERGED_FROM.set(tab, [...(MERGED_FROM.get(tab) ?? []), old]);
}

/** The current id for a stored one: a merged id becomes its new tab, anything else is kept. */
function mergedTab(id: unknown): unknown {
  return (typeof id === 'string' && MERGED_TABS.get(id)) || id;
}

/**
 * Repair stale/partial browser preferences when tabs are added or removed.
 *
 * `order` is one flat ranking of tab ids and says nothing about groups:
 * `visibleNavigationGroups` only uses it to sort tabs *within* each group. So a
 * value stored under an earlier grouping (Trading / Research / Account) needs no
 * migration and no new storage key when the groups change: hidden tabs stay
 * hidden and any two tabs that share a group keep their relative order.
 *
 * An id that is no longer a tab (`backtest`, which became Options Lab › Builder › YAML) is
 * dropped from both lists. It is not mapped onto another tab: a user who hid the YAML
 * backtest did not ask to hide Options Lab.
 *
 * Ids that were merged into one tab (`backfill` and `replay`, now the two sections of
 * Coverage) are renamed to it, see MERGED_TABS: in `order` the merged tab takes the place of
 * whichever old id ranked first, and in `hidden` it stays hidden only when every old id it
 * replaces was hidden. Hiding just Replay never hid the backfill controls, so it does not
 * hide Coverage now.
 *
 * A tab the stored value has never seen is placed where the default order has it:
 * straight after the tab that precedes it there, or first when nothing does. So a
 * newly added first tab (Overview) leads a stored order too, and becomes the
 * landing tab, instead of being appended behind every older tab.
 */
export function normalizeNavigationPreferences(value: unknown): NavigationPreferences {
  const candidate =
    value && typeof value === 'object' ? (value as { hidden?: unknown; order?: unknown }) : {};
  const storedOrder = Array.isArray(candidate.order) ? (candidate.order as unknown[]) : [];
  const storedHidden = Array.isArray(candidate.hidden) ? (candidate.hidden as unknown[]) : [];
  const order = storedOrder
    .map(mergedTab)
    .filter((id): id is Tab => CONFIGURABLE_SET.has(id as Tab));
  const uniqueOrder = [...new Set(order)];
  CONFIGURABLE_IDS.forEach((id, index) => {
    if (uniqueOrder.includes(id)) return;
    // Every earlier default tab is already present (stored, or inserted on a previous pass).
    const previous = CONFIGURABLE_IDS[index - 1];
    uniqueOrder.splice(previous === undefined ? 0 : uniqueOrder.indexOf(previous) + 1, 0, id);
  });

  const hiddenIds = new Set(storedHidden);
  const hidden = [
    ...new Set(
      storedHidden
        .filter((id) => {
          const sources = MERGED_FROM.get(mergedTab(id) as Tab);
          // A merged tab named by an old id is hidden only when all of its old ids were.
          return !sources?.includes(id as string) || sources.every((old) => hiddenIds.has(old));
        })
        .map(mergedTab)
        .filter((id): id is Tab => CONFIGURABLE_SET.has(id as Tab)),
    ),
  ];
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
      .filter((item) => PINNED_TABS.includes(item.id) || !hidden.has(item.id))
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
