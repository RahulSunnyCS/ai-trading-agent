import type { MomentumAlertsResponse } from '../types/momentum';
import { type PolledResourceResult, usePolledResource } from './usePolledResource';

/** How often the bell asks again; the checks behind it only change when a job runs. */
export const ALERTS_POLL_MS = 3 * 60_000;

/** Open alerts and the ones that just cleared (`GET /api/momentum/alerts`), for the bell and the
 * pop-up. Cached, so a page that mounts late starts from the last answer. */
export function useMomentumAlerts(): PolledResourceResult<MomentumAlertsResponse> {
  return usePolledResource<MomentumAlertsResponse>('/api/momentum/alerts', {
    intervalMs: ALERTS_POLL_MS,
    cache: true,
  });
}
