/**
 * useRegimeTags — fetches GET /api/regime-tags on mount and returns the result.
 *
 * Built on usePolledResource: single fetch on mount, no polling interval
 * (regime tags change only after the EOD retrospection job runs), and a
 * `refresh` callback so the view can re-fetch after the user changes the
 * symbol/date filters.
 *
 * `{ cache: true }`: returning to the tab (or back to a window already viewed) starts from
 * the last answer for that URL while it revalidates.
 *
 * This used to hand-roll the same abort-then-skip-if-in-flight pattern as
 * usePersonalities, with the same bug: refresh() called while a fetch was
 * already pending could abort it and then skip starting a replacement,
 * leaving the view stuck loading. Fixed by usePolledResource's refetch(),
 * which always cancels and replaces instead of skipping.
 */

import type { ApiEnvelope, RegimeTag } from '../types/trading';
import { usePolledResource } from './usePolledResource';

/** One shared empty list, so a memo keyed on `tags` does not recompute every render. */
const NO_TAGS: RegimeTag[] = [];

export interface RegimeTagsState {
  tags: RegimeTag[];
  loading: boolean;
  error: string | null;
  /** Call to re-fetch with the same params without remounting. */
  refresh: () => void;
}

/**
 * Fetch daily regime tags from GET /api/regime-tags.
 *
 * @param symbol  Underlying symbol to query (default: 'NIFTY').
 * @param from    YYYY-MM-DD start date (optional; server defaults to 30 days ago).
 * @param to      YYYY-MM-DD end date (optional; server defaults to today).
 *
 * State transitions:
 *  - Initial mount        → loading: true, tags: [], error: null
 *  - Successful 200       → loading: false, tags: <array>, error: null
 *  - HTTP / network error → loading: false, tags: [], error: <message>
 *  - Unmount (AbortError) → state is NOT updated
 */
export function useRegimeTags(symbol = 'NIFTY', from?: string, to?: string): RegimeTagsState {
  const params = new URLSearchParams({ symbol });
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const { data, loading, error, refetch } = usePolledResource<ApiEnvelope<RegimeTag[]>>(
    `/api/regime-tags?${params.toString()}`,
    { cache: true },
  );

  // Another service answering on /api (a standalone preview) may not send the envelope.
  const tags = Array.isArray(data?.data) ? data.data : NO_TAGS;
  return { tags, loading, error, refresh: refetch };
}
