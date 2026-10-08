'use client';

import { useCallback, useSyncExternalStore } from 'react';

import {
  MOMENTUM_SCORE_KINDS,
  type MomentumScoreKind,
  buildPath,
  oneOf,
  parsePath,
} from '../lib/routes';
import { readQueryParam } from './useQueryState';

/** Where the Momentum › Scores page is: which view, which sector, which sub-sector, which stock. */
export interface ScoresTarget {
  kind: MomentumScoreKind;
  /** A parent group's slug (the sector page). */
  group?: string | null;
  /** A sub-sector's slug, filtering the sector page's stocks. */
  sub?: string | null;
  /** A stock's symbol: its drawer is open. */
  stock?: string | null;
}

/** The URL for a target: `/momentum/scores/sectors/financials?sub=psu-banks&stock=SBIN`. */
export function scoresHref(target: ScoresTarget): string {
  const path = buildPath('momentum', 'scores', target.kind, target.group ?? undefined);
  const params = new URLSearchParams();
  if (target.sub) params.set('sub', target.sub);
  if (target.stock) params.set('stock', target.stock);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Marks the history entry the stock drawer pushed, so closing it can step back over it. */
interface DrawerState {
  scoresDrawer: true;
}

function pushedByDrawer(): boolean {
  return (window.history.state as Partial<DrawerState> | null)?.scoresDrawer === true;
}

/**
 * The Scores page's address, as state. The path says the view and the sector
 * (`/momentum/scores/<sectors|stocks>[/<group>]`), the query says the sub-sector (`?sub=`) and the
 * open stock (`?stock=`); a link reopens the same place and Back undoes the last click. Moves go
 * through `window.history`, not the Next router, for the reason `useAppRoute` gives.
 *
 * Opening a stock pushes an entry; closing it steps back over that entry when this page pushed it,
 * and otherwise (a link straight to a stock) just removes the key. Prev and next replace.
 */
export function useScoresRoute() {
  // The whole address is read from the browser and re-read after every move (`notify`, and
  // back/forward), so a move this hook makes shows at once whether or not Next has caught up.
  const address = useSyncExternalStore(
    subscribe,
    () => `${window.location.pathname}${window.location.search}`,
    () => '',
  );
  const [path = '', search = ''] = address.split(/(?=\?)/);
  const { rest } = parsePath(path);
  const kind: MomentumScoreKind = oneOf(MOMENTUM_SCORE_KINDS, rest[1]) ?? 'sectors';
  const group = kind === 'sectors' ? (rest[2] ?? null) : null;
  const sub = readQueryParam(search, 'sub');
  const stock = readQueryParam(search, 'stock');

  const go = useCallback((target: ScoresTarget, mode: 'push' | 'replace' = 'push') => {
    const href = scoresHref(target);
    if (href === `${window.location.pathname}${window.location.search}`) return;
    if (mode === 'replace') window.history.replaceState(window.history.state, '', href);
    else
      window.history.pushState(
        target.stock ? ({ scoresDrawer: true } as DrawerState) : null,
        '',
        href,
      );
    notify();
  }, []);

  /** Close the drawer: step back over the entry it pushed, else drop `?stock=` in place. */
  const closeStock = useCallback(
    (target: ScoresTarget) => {
      // Already closed (a second close before the first step back has landed): nothing to do.
      if (readQueryParam(window.location.search, 'stock') === null) return;
      if (pushedByDrawer()) window.history.back();
      else go({ ...target, stock: null }, 'replace');
    },
    [go],
  );

  return { kind, group, sub, stock, go, closeStock };
}
