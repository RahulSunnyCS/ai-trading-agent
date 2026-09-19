/**
 * usePersonalities — fetches GET /api/personalities on mount and returns the result.
 *
 * Built on usePolledResource: single fetch on mount, no polling (personality
 * configs change only via the evolution engine or manual admin action), and
 * a `refresh` callback for the view to trigger a re-fetch.
 *
 * This used to hand-roll its own AbortController + in-flight guard, and that
 * combination had a real bug: calling refresh() while the initial mount
 * fetch was still pending aborted that fetch and then ALSO skipped starting
 * a replacement (the in-flight guard was still set), so neither request ever
 * updated state and the view was stuck on "loading" until an unrelated call
 * happened to succeed later. usePolledResource's refetch() always cancels
 * and replaces instead of skipping, which fixes this by construction.
 *
 * @param includeInactive  When true, passes include_inactive=true to the server
 *   so all 10 personalities are returned regardless of active state.
 *   Defaults to false (active only).
 */

import type { ApiEnvelope, Personality } from '../types/trading.js';
import { usePolledResource } from './usePolledResource.js';

export interface PersonalitiesState {
  personalities: Personality[];
  loading: boolean;
  error: string | null;
  /** Call to re-fetch without remounting the component. */
  refresh: () => void;
}

export function usePersonalities(includeInactive = false): PersonalitiesState {
  const params = new URLSearchParams();
  if (includeInactive) params.set('include_inactive', 'true');
  const qs = params.toString();

  const { data, loading, error, refetch } = usePolledResource<ApiEnvelope<Personality[]>>(
    `/api/personalities${qs ? `?${qs}` : ''}`,
  );

  return { personalities: data?.data ?? [], loading, error, refresh: refetch };
}
