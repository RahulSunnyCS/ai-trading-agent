/**
 * Favourite status and groups (BL-051): Watching / Paper / Invested, the cap on Paper +
 * Invested, and the filters the Saved runs list offers. The rules themselves are enforced by
 * the Momentum service (`runs_store.py`); these helpers only describe them on screen.
 */
import type { FavouriteStatus, MomentumSavedRun } from '../types/momentum';

/** Paper + Invested favourites allowed at once, across every dataset (`MAX_FOLLOWED`). */
export const MAX_FOLLOWED = 8;

export const FAVOURITE_STATUSES: ReadonlyArray<FavouriteStatus> = ['watching', 'paper', 'invested'];

export const STATUS_LABEL: Record<FavouriteStatus, string> = {
  watching: 'Watching',
  paper: 'Paper',
  invested: 'Invested',
};

export const STATUS_HINT: Record<FavouriteStatus, string> = {
  watching: 'Journalled every Friday; not tracked against your rules.',
  paper: 'Tracked against your live-money rules as if it had money.',
  invested: 'Real money follows it.',
};

export function isFollowed(status: FavouriteStatus | null | undefined): boolean {
  return status === 'paper' || status === 'invested';
}

/** Paper + Invested favourites; a group counts once and its members not at all. */
export function followedCount(favourites: ReadonlyArray<MomentumSavedRun>): number {
  return favourites.filter((run) => !run.member_of && isFollowed(run.status)).length;
}

export type SavedRunFilter = 'all' | 'favourites' | FavouriteStatus;

export function matchesFilter(run: MomentumSavedRun, filter: SavedRunFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'favourites') return run.favorite;
  // A member is listed under its group's status.
  return run.status === filter;
}

/** How many runs each filter would show, for the filter's labels. */
export function filterCounts(
  runs: ReadonlyArray<MomentumSavedRun>,
): Record<SavedRunFilter, number> {
  const counts: Record<SavedRunFilter, number> = {
    all: runs.length,
    favourites: 0,
    watching: 0,
    paper: 0,
    invested: 0,
  };
  for (const run of runs) {
    if (run.favorite) counts.favourites += 1;
    if (run.status) counts[run.status] += 1;
  }
  return counts;
}

/** The group a member belongs to, by id, from the same list. */
export function groupOf(
  run: MomentumSavedRun,
  runs: ReadonlyArray<MomentumSavedRun>,
): MomentumSavedRun | null {
  return run.member_of ? (runs.find((other) => other.id === run.member_of) ?? null) : null;
}
