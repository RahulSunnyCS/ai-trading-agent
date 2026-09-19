/**
 * usePersonalities — fetches GET /api/personalities on mount and returns the result.
 *
 * Design follows the useBackfillStatus / useRegimeTags pattern:
 *  - Single fetch on mount with AbortController cleanup on unmount.
 *  - A manual `refresh` callback for the view to trigger a re-fetch.
 *  - No polling: personality configs change only via the evolution engine or
 *    manual admin action — continuous polling would be wasted traffic.
 *
 * @param includeInactive  When true, passes include_inactive=true to the server
 *   so all 10 personalities are returned regardless of active state.
 *   Defaults to false (active only).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet } from '../lib/api.js';
import type { ApiEnvelope, Personality } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

export interface PersonalitiesState {
  personalities: Personality[];
  loading: boolean;
  error: string | null;
  /** Call to re-fetch without remounting the component. */
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePersonalities(includeInactive = false): PersonalitiesState {
  const [state, setState] = useState<Omit<PersonalitiesState, 'refresh'>>({
    personalities: [],
    loading: true,
    error: null,
  });

  // Guard: prevents concurrent in-flight fetches when refresh is called rapidly.
  const inFlightRef = useRef(false);
  // Keep the controller in a ref so refresh() can abort the current request
  // and start a fresh one without remounting.
  const controllerRef = useRef<AbortController | null>(null);

  const fetch = useCallback(async () => {
    // Abort any previous in-flight request before starting a new one.
    if (controllerRef.current) {
      controllerRef.current.abort();
    }

    if (inFlightRef.current) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = true;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    // Build the query string — include_inactive only when explicitly requested.
    const params = new URLSearchParams();
    if (includeInactive) params.set('include_inactive', 'true');
    const qs = params.toString();

    const result = await apiGet<ApiEnvelope<Personality[]>>(
      `/api/personalities${qs ? `?${qs}` : ''}`,
      controller.signal,
    );

    inFlightRef.current = false;

    // AbortError is a cleanup cancellation — do not update state.
    if (!result.ok && result.error === 'AbortError') return;

    if (!result.ok) {
      setState((prev) => ({ ...prev, loading: false, error: result.error }));
      return;
    }

    setState({
      personalities: result.data.data ?? [],
      loading: false,
      error: null,
    });
  }, [includeInactive]);

  useEffect(() => {
    void fetch();

    return () => {
      // Abort in-flight request on unmount to prevent setState on unmounted component.
      if (controllerRef.current) {
        controllerRef.current.abort();
      }
    };
  }, [fetch]);

  return { ...state, refresh: fetch };
}
