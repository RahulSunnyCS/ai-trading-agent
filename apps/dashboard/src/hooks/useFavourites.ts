'use client';

/**
 * The stars on Strategies and baskets (BL-102), read and written through
 * `/api/backtest/legwise/favourites`.
 *
 * A toggle shows at once (optimistic). Saves go one at a time, and each one sends what the
 * person wants *now*, not what they wanted when it was queued, so a failed save followed by a
 * newer toggle cannot leave the screen and the server disagreeing, and two quick clicks are one
 * round trip, not a race. Once the saves have settled the screen goes back to the server's own
 * copy, so a change made on another device is shown, and a failed last save is simply undone
 * (with a toast). Until the server has answered, `set` is null: a picker that defaults to the
 * favourites waits for it instead of guessing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
  // What the screen shows while a save is outstanding; null when the server's copy is shown.
  const [local, setLocal] = useState<FavouriteSet | null>(null);
  // What the person wants, until a save of exactly that has finished; null when nothing is
  // outstanding. A ref, so two clicks in one frame both build on the same latest set.
  const desired = useRef<FavouriteSet | null>(null);
  const saving = useRef(false);
  const { refetch } = resource;

  const pump = useCallback(() => {
    if (saving.current) return;
    const sending = desired.current;
    if (sending === null) return;
    saving.current = true;
    void apiPut<Favourites>(FAVOURITES_URL, sending).then((result) => {
      saving.current = false;
      if (!result.ok) toast(`The star could not be saved: ${result.error}`, 'error');
      if (desired.current === sending) {
        // Nothing newer was asked for: settled. Show the server's copy again and re-read it.
        desired.current = null;
        if (result.ok)
          setLocal(setOf(result.data)); // until the re-read lands, no flicker
        else setLocal(null);
        refetch();
      } else {
        pump(); // a newer toggle arrived while this one was saving: send that instead
      }
    });
  }, [refetch]);

  // The re-read has arrived: the server's copy is what the screen shows from here on.
  useEffect(() => {
    if (resource.data && desired.current === null && !saving.current) setLocal(null);
  }, [resource.data]);

  const server = resource.data ? setOf(resource.data) : null;
  const set = local ?? server;

  const apply = useCallback(
    (next: (current: FavouriteSet) => FavouriteSet) => {
      const base = desired.current ?? (resource.data ? setOf(resource.data) : null);
      if (base === null) return;
      const updated = next(base);
      desired.current = updated;
      setLocal(updated);
      pump();
    },
    [resource.data, pump],
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
