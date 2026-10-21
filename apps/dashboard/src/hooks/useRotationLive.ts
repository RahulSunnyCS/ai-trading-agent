/**
 * The days' live results beside the paper ones, for the Rotation page's "Live vs paper" card
 * (BL-141). One request through the Fastify proxy; the capture files change at 15:40 and when a
 * back-fill lands, so it is fetched on mount and on Refresh, not polled.
 */

import type { RotationLiveResponse } from '../types/rotationLive';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useRotationLive() {
  return usePolledResource<RotationLiveResponse>(`${BASE}/rotation/live`);
}
