/**
 * The "Forward days vs research periods" card's data (rotation/regime.py). One request through
 * the Fastify proxy; the files behind it change once a night, so it is fetched on mount and on
 * Refresh, not polled.
 */

import type { RotationRegimeResponse } from '../types/rotationRegime';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useRotationRegime() {
  return usePolledResource<RotationRegimeResponse>(`${BASE}/rotation/regime`);
}
