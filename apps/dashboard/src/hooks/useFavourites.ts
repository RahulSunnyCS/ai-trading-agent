'use client';

/**
 * The stars on Strategies and baskets (BL-102), read and written through
 * `/api/backtest/legwise/favourites`.
 *
 * A toggle shows at once (optimistic) and is sent in order, one request at a time, so two quick
 * clicks cannot land out of order. When a save fails the stars go back to what the server last
 * confirmed and a toast says so. Until the server has answered, `set` is null: a picker that
 * defaults to the favourites waits for it instead of guessing.
 */

import { useCallback, useRef, useState } from 'react';

import { toast } from '../components/ui/Toast';
import { apiPut } from '../lib/api';
import {
  type FavouriteSet,
  isListStarred,
  isStrategyStarred,
  setOf,
  toggleList,
  toggleStrategy,
} from '../lib/favourites';
import type { FavouriteListKey, Favourites } from '../types/legwise';
import { usePolledResource } from './usePolledResource';

export const FAVOURITES_URL = '/api/backtest/legwise/favourites';

export function useFavourites() {
  const resource = usePolledResource<Favourites>(FAVOURITES_URL, { cache: true });
  // What the screen shows after a toggle, until the server's own answer arrives.
  const [local, setLocal] = useState<FavouriteSet | null>(null);
  // The last set the server confirmed, kept for the rollback; null until the first save.
  const confirmed = useRef<FavouriteSet | null>(null);
  // The set the next toggle starts from (a ref, so two clicks in one frame both count).
  const latest = useRef<FavouriteSet | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const server = resource.data ? setOf(resource.data) : null;
  const set = local ?? server;

  const apply = useCallback(
    (next: (current: FavouriteSet) => FavouriteSet) => {
      const base = latest.current ?? (resource.data ? setOf(resource.data) : null);
      if (base === null) return;
      if (confirmed.current === null) confirmed.current = base;
      const updated = next(base);
      latest.current = updated;
      setLocal(updated);
      queue.current = queue.current.then(async () => {
        const result = await apiPut<Favourites>(FAVOURITES_URL, updated);
        if (result.ok) {
          confirmed.current = setOf(result.data);
          return;
        }
        // Roll back to what the server holds; later queued saves carry their own full set.
        latest.current = confirmed.current;
        setLocal(confirmed.current);
        toast(`The star could not be saved: ${result.error}`, 'error');
      });
      void queue.current.then(() => resource.refetch());
    },
    [resource],
  );

  return {
    /** The starred lists and strategies, or null until the server has answered. */
    set,
    loading: resource.loading,
    error: resource.error,
    /** Why the stored file was not used (the defaults are showing), when it was not. */
    warning: resource.data?.warning ?? null,
    isDefault: resource.data?.is_default ?? false,
    isListStarred: (key: FavouriteListKey) => (set ? isListStarred(set, key) : false),
    isStrategyStarred: (name: string) => (set ? isStrategyStarred(set, name) : false),
    toggleList: (key: FavouriteListKey) => apply((s) => toggleList(s, key)),
    toggleStrategy: (name: string) => apply((s) => toggleStrategy(s, name)),
    refetch: resource.refetch,
  };
}
