'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import type { Tab } from '../components/shell/nav';
import { buildPath, parsePath } from '../lib/routes';

/**
 * The URL is the source of truth for which tab / sub-tab is open. `navigate`
 * pushes a history entry (back button works); `replace` is for corrections and
 * state-derived URL updates that should not add one.
 *
 * Both go through `window.history`, not `router.push`: every path is the same
 * `[[...slug]]` page, and a router navigation to a different slug re-mounts that
 * page — the whole shell and every view in it — so each sub-tab click used to
 * throw away all component state and refetch everything. Next keeps
 * `usePathname` in sync with `pushState`/`replaceState` (and back/forward), so
 * the view updates in place instead.
 */
export function useAppRoute() {
  const pathname = usePathname() ?? '/';
  const route = useMemo(() => parsePath(pathname), [pathname]);

  const navigate = useCallback((tab: Tab, ...rest: Array<string | undefined>) => {
    const path = buildPath(tab, ...rest);
    if (path !== window.location.pathname) window.history.pushState(null, '', path);
  }, []);
  const replace = useCallback((tab: Tab, ...rest: Array<string | undefined>) => {
    window.history.replaceState(null, '', buildPath(tab, ...rest));
  }, []);

  return { pathname, tab: route.tab, rest: route.rest, navigate, replace };
}
