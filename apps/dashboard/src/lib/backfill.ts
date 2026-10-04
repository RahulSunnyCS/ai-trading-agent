import type { BackfillRangeRow, BackfillStatus } from '../types/trading';

/**
 * Whether a backfill range in each status has its candles written and can be replayed.
 * Keyed by the full status union so a status added to the API fails typecheck here.
 */
export const REPLAYABLE_BY_STATUS: Record<BackfillStatus, boolean> = {
  completed: true,
  in_progress: false,
  failed: false,
};

export function isReplayable(row: Pick<BackfillRangeRow, 'status'>): boolean {
  return REPLAYABLE_BY_STATUS[row.status] === true;
}
