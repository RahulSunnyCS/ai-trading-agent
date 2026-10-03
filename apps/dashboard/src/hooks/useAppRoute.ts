'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import type { Tab } from '../components/shell/nav';
import { buildPath, parsePath } from '../lib/routes';

/**
 * The URL is the source of truth for which tab / sub-tab is open. `navigate`
 * pushes a history entry (back button works); `replace` is for corrections and
 * state-derived URL updates that should not add one.
 */
export function useAppRoute() {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const route = useMemo(() => parsePath(pathname), [pathname]);

  const navigate = useCallback(
    (tab: Tab, ...rest: Array<string | undefined>) => router.push(buildPath(tab, ...rest)),
    [router],
  );
  const replace = useCallback(
    (tab: Tab, ...rest: Array<string | undefined>) => router.replace(buildPath(tab, ...rest)),
    [router],
  );

  return { pathname, tab: route.tab, rest: route.rest, navigate, replace };
}
