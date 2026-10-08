/**
 * Favourite status and groups (BL-051): Watching / Paper / Invested, the cap on Paper +
 * Invested. The rules themselves are enforced by
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
