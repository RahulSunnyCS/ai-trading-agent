import {
  ARCHIVED_TABS,
  CONFIGURABLE_TABS,
  NAV_GROUPS,
  type NavGroup,
  PINNED_TABS,
  type Tab,
} from '../components/shell/nav';

const STORAGE_KEY = 'ata.navigation.v1';
const CONFIGURABLE_IDS = CONFIGURABLE_TABS.map((item) => item.id);
const CONFIGURABLE_SET = new Set<Tab>(CONFIGURABLE_IDS);

/**
 * The shape of the stored value. 1 (no `version` field): written before the Archived engine
 * section; 2: written since, so its `hidden` list is the reader's own choice.
 */
export const NAVIGATION_VERSION = 2;

export interface NavigationPreferences {
  hidden: Tab[];
  order: Tab[];
}

/** The frozen engine's tabs (the Archived engine section) start hidden. */
export const DEFAULT_NAVIGATION_PREFERENCES: NavigationPreferences = {
  hidden: [...ARCHIVED_TABS],
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

/**
 * A stored value, brought up to NAVIGATION_VERSION and normalised.
 *
 * A value from before version 2 was saved while the frozen engine's tabs (now the Archived engine
 * section) were shown by default, so a browser that kept those defaults would keep showing them.
 * Upgrading hides them once, and puts Live (which moved into the Options Lab section) after
 * Options Lab, where the old flat order had it before. A version-2 value is the reader's own
 * choice since the change, so an archived tab shown there again stays shown.
 */
export function migrateNavigationPreferences(value: unknown): NavigationPreferences {
  const preferences = normalizeNavigationPreferences(value);
  const version =
    value && typeof value === 'object' ? (value as { version?: unknown }).version : undefined;
  if (typeof version === 'number' && version >= NAVIGATION_VERSION) return preferences;

  const order: Tab[] = preferences.order.filter((id) => id !== 'live');
  order.splice(order.indexOf('optionslab') + 1, 0, 'live');
  return normalizeNavigationPreferences({
    hidden: [...preferences.hidden, ...ARCHIVED_TABS],
    order,
  });
}

export function loadNavigationPreferences(): NavigationPreferences {
  if (typeof window === 'undefined') return DEFAULT_NAVIGATION_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? migrateNavigationPreferences(JSON.parse(raw)) : DEFAULT_NAVIGATION_PREFERENCES;
  } catch {
    return DEFAULT_NAVIGATION_PREFERENCES;
  }
}

export function saveNavigationPreferences(preferences: NavigationPreferences): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: NAVIGATION_VERSION, ...normalizeNavigationPreferences(preferences) }),
  );
}

/** A tab's place in NAV_GROUPS, for the pinned tabs, which have no rank in `order`. */
const NAV_POSITION = new Map(
  NAV_GROUPS.flatMap((group) => group.items).map((item, index) => [item.id, index]),
);

/**
 * The sections and tabs the sidebar draws. A hidden tab is left out unless it is `activeTab`
 * (an archived screen opened by its link), so the reader still sees where they are. The pinned
 * tabs (Settings, then the Guide) close their section.
 */
export function visibleNavigationGroups(
  preferences: NavigationPreferences,
  activeTab?: Tab,
): NavGroup[] {
  const rank = new Map(preferences.order.map((id, index) => [id, index]));
  const hidden = new Set(preferences.hidden);
  // [pinned last, then the stored rank, or for a pinned tab its place in NAV_GROUPS]
  const key = (id: Tab): [number, number] =>
    PINNED_TABS.includes(id)
      ? [1, NAV_POSITION.get(id) ?? 0]
      : [0, rank.get(id) ?? Number.MAX_SAFE_INTEGER];
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: [...group.items]
      .filter(
        (item) => PINNED_TABS.includes(item.id) || !hidden.has(item.id) || item.id === activeTab,
      )
      .sort((a, b) => {
        const [pa, ra] = key(a.id);
        const [pb, rb] = key(b.id);
        return pa - pb || ra - rb;
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
