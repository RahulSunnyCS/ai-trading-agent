'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * One query-string key as React state: `const [status, setStatus] = useQueryState('status')`.
 *
 * Writing uses `history.replaceState` (no new history entry, no Next router navigation, which
 * would re-mount the shell — see useAppRoute) and keeps the path and hash. Setting `null` or ''
 * removes the key. Every hook instance, for any key, re-reads after a write or back/forward.
 *
 * The server snapshot is null, so the first client render matches the server HTML and the
 * value from the URL follows straight after hydration.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/** The value of `key` in a search string ("?a=1&b=2" or "a=1"), or null when absent or empty. */
export function readQueryParam(search: string, key: string): string | null {
  const value = new URLSearchParams(search).get(key);
  return value === null || value === '' ? null : value;
}

/** `search` with `key` set to `value` (or removed for null / ''), as "?…" or "" when empty. */
export function withQueryParam(search: string, key: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value === null || value === '') params.delete(key);
  else params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function setQueryParam(key: string, value: string | null): void {
  const { pathname, search, hash } = window.location;
  const next = withQueryParam(search, key, value);
  if (next === search || (next === '' && search === '?')) return;
  window.history.replaceState(null, '', `${pathname}${next}${hash}`);
  for (const listener of listeners) listener();
}

export function useQueryState(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readQueryParam(window.location.search, key),
    () => null,
  );
  const setValue = useCallback((next: string | null) => setQueryParam(key, next), [key]);
  return [value, setValue];
}
