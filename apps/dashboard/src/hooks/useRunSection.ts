import { useEffect } from 'react';

import { type MomentumSectionState, useMomentumRunsStore } from '../store/momentumRuns';
import type { MomentumResult, MomentumSectionName } from '../types/momentum';

export interface RunSection<T> {
  /** The section, once loaded. `null` means the run has none (it could not be computed);
   * `undefined` means it is not here yet. */
  data: T | null | undefined;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * One heavy part of a background run's result (trades, the circuit card, …), fetched when the
 * component showing it mounts. A run's own result holds the core only; this reads the rest from
 * the run once it has arrived, and asks the store for it when it has not (BL-005). A whole result
 * that already has the section (a synchronous run) needs no request.
 */
export function useRunSection<K extends MomentumSectionName>(
  runId: string,
  name: K,
): RunSection<NonNullable<MomentumResult[K]>> {
  const run = useMomentumRunsStore((state) => state.runs.find((r) => r.id === runId));
  const loadSection = useMomentumRunsStore((state) => state.loadSection);
  const data = run?.result?.[name] as NonNullable<MomentumResult[K]> | null | undefined;
  const announced = run?.result?.sections_available?.includes(name) ?? false;
  const state: MomentumSectionState | undefined = run?.sections?.[name];
  const missing = data === undefined && announced;

  useEffect(() => {
    // A failed fetch is not retried by itself, which would loop: `retry` asks again.
    if (missing && state === undefined) void loadSection(runId, name);
  }, [missing, state, loadSection, runId, name]);

  return {
    data,
    loading: missing && state?.status !== 'failed',
    error: state?.status === 'failed' ? (state.error ?? 'Could not load this section.') : null,
    retry: () => void loadSection(runId, name),
  };
}
