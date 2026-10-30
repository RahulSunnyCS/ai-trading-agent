/**
 * Data hooks for Options Lab › Rotation › Daily log, on usePolledResource and behind the Fastify
 * proxy (/api/backtest/legwise/rotation/*). The placement record is written with apiPost: the only
 * write this screen makes, to a file nothing else reads.
 */

import { useCallback, useState } from 'react';

import { apiPost } from '../lib/api';
import { useSlippageUrl } from '../store/rotationSlippage';
import type {
  PlacementStatus,
  PlacementWriteResult,
  RotationDay,
  RotationListKey,
  RotationLog,
  RotationLogSource,
} from '../types/rotationDailyLog';
import { usePolledResource } from './usePolledResource';
import { ROTATION_PAGE_LOTS } from './useRotation';

const LOTS = String(ROTATION_PAGE_LOTS);

const BASE = '/api/backtest/legwise/rotation';

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const text = q.toString();
  return text ? `?${text}` : '';
}

/** How often the log refreshes itself: the 09:16 entry and the nightly scoring both land while the
 * page is open. Poll ticks pause while the tab is hidden. */
export const LOG_POLL_MS = 60_000;

/** A parallel track's journal (`t1`: Adaptive Tuned, list C only, recorded days from 19 Oct; a
 * track has no reconstructed research days). Absent = the live journal (Adaptive Classic). */
export type RotationLogTrack = 't1';

export function useRotationLog(
  source: RotationLogSource,
  range: { from?: string | undefined; to?: string | undefined } = {},
  track?: RotationLogTrack,
) {
  return usePolledResource<RotationLog>(
    useSlippageUrl(
      `${BASE}/log${query({ source, from: range.from, to: range.to, lots: LOTS, track })}`,
    ),
    { intervalMs: LOG_POLL_MS },
  );
}

/** One day in full. Always fetches: mount the component that calls it only once a day is picked.
 * Both it and the log show each list at the page's lots a strategy (ROTATION_PAGE_LOTS). */
export function useRotationDay(day: string, track?: RotationLogTrack) {
  return usePolledResource<RotationDay>(
    useSlippageUrl(`${BASE}/day/${encodeURIComponent(day)}${query({ lots: LOTS, track })}`),
  );
}

export interface PlacementInput {
  day: string;
  list: RotationListKey;
  status: PlacementStatus;
  note: string;
}

/** Save one placement row. Nothing is applied optimistically: the caller shows what the server
 * answered, then refetches the log and the day. */
export function useSavePlacement() {
  const [saving, setSaving] = useState(false);
  const save = useCallback(async (input: PlacementInput) => {
    setSaving(true);
    try {
      return await apiPost<PlacementWriteResult>(`${BASE}/placement`, input);
    } finally {
      setSaving(false);
    }
  }, []);
  return { save, saving };
}

export const ROTATION_API = BASE;
