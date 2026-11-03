/**
 * Data hooks for the Rotation page (BL-058 Phase 4), built on usePolledResource and behind the
 * Fastify proxy (/api/backtest/legwise/rotation/*). Results change nightly and the picks once a
 * morning, so nothing polls fast; a person refreshes with the page's Reload.
 */

import { useSlippageUrl } from '../store/rotationSlippage';
import type { RotationOverview, RotationSummary } from '../types/rotation';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/rotation';
const HALF_MINUTE = 30_000;

export function useRotationOverview() {
  return usePolledResource<RotationOverview>(useSlippageUrl(`${BASE}/overview`), {
    intervalMs: HALF_MINUTE,
  });
}

/** The owner trades one lot a pick (2026-10-19): the Rotation page shows every rupee figure at
 * this many lots a strategy (display only; the journal records 2 and the per-lot figures and the
 * verdict do not depend on it). The page's log, day view, replays and drawdowns all ask for it. */
export const ROTATION_PAGE_LOTS = 1;

/** Which journal and how many lots: `lots` sets the lots a strategy behind the rupee totals
 * (display only; the per-lot figures and the verdict do not move), `track` reads a parallel
 * track's journal (`t1`: Adaptive Tuned, list C only). Absent = the registered read-out. */
export interface RotationReadOptions {
  lots?: number;
  track?: 't1';
  /** Read the forward sessions from this day ('YYYY-MM-DD') instead of the journal's first. */
  from?: string;
}

/** "?lots=1&track=t1&from=2026-10-19", or "" for the defaults. */
export function readQuery(opts: RotationReadOptions = {}): string {
  const q = new URLSearchParams();
  if (opts.lots !== undefined) q.set('lots', String(opts.lots));
  if (opts.track) q.set('track', opts.track);
  if (opts.from) q.set('from', opts.from);
  const text = q.toString();
  return text ? `?${text}` : '';
}

export function useRotationSummary(opts: RotationReadOptions = {}) {
  return usePolledResource<RotationSummary>(useSlippageUrl(`${BASE}/summary${readQuery(opts)}`), {
    intervalMs: HALF_MINUTE * 4,
  });
}

export const ROTATION_API = BASE;
