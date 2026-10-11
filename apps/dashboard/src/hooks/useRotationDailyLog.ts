/**
 * Data hooks for Options Lab › Rotation › Daily log, on usePolledResource and behind the Fastify
 * proxy (/api/backtest/legwise/rotation/*). The placement record is written with apiPost: the only
 * write this screen makes, to a file nothing else reads.
 */

import { useCallback, useState } from 'react';

import { apiPost } from '../lib/api';
import type {
  PlacementStatus,
  PlacementWriteResult,
  RotationDay,
  RotationListKey,
  RotationLog,
  RotationLogSource,
} from '../types/rotationDailyLog';
import { usePolledResource } from './usePolledResource';

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

export function useRotationLog(
  source: RotationLogSource,
  range: { from?: string | undefined; to?: string | undefined } = {},
) {
  return usePolledResource<RotationLog>(
    `${BASE}/log${query({ source, from: range.from, to: range.to })}`,
    { intervalMs: LOG_POLL_MS },
  );
}

/** One day in full. Always fetches: mount the component that calls it only once a day is picked. */
export function useRotationDay(day: string) {
  return usePolledResource<RotationDay>(`${BASE}/day/${encodeURIComponent(day)}`);
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
