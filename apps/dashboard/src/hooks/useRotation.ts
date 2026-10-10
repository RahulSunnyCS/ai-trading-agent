/**
 * Data hooks for the Rotation page (BL-058 Phase 4), built on usePolledResource and behind the
 * Fastify proxy (/api/backtest/legwise/rotation/*). Results change nightly and the picks once a
 * morning, so nothing polls fast; a person refreshes with the page's Reload.
 */

import type { RotationOverview, RotationSummary } from '../types/rotation';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/rotation';
const HALF_MINUTE = 30_000;

export function useRotationOverview() {
  return usePolledResource<RotationOverview>(`${BASE}/overview`, { intervalMs: HALF_MINUTE });
}

export function useRotationSummary() {
  return usePolledResource<RotationSummary>(`${BASE}/summary`, { intervalMs: HALF_MINUTE * 4 });
}

export const ROTATION_API = BASE;
