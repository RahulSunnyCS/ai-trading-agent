/**
 * A list's drawdown episodes for the Rotation page's card. One request through the Fastify proxy;
 * the files behind it change once a night, so it is fetched when the choice changes and on
 * Refresh, not polled.
 */

import { type PortfolioStopSetting, queryOf } from '../lib/portfolioStop';
import type { RotationListKey } from '../types/rotation';
import type { DrawdownWindowId, RotationDrawdownsResponse } from '../types/rotationDrawdowns';
import { ROTATION_PAGE_LOTS } from './useRotation';
import { useWarmingResource } from './useWarmingResource';

const BASE = '/api/backtest/legwise';

export function useRotationDrawdowns(p: {
  list: RotationListKey;
  window: DrawdownWindowId;
  minDepth: number;
  /** BL-095: also run the series through the portfolio stop (nothing is added when it is off). */
  portfolio?: PortfolioStopSetting | undefined;
}) {
  const q = new URLSearchParams({
    list: p.list,
    window: p.window,
    min_depth: String(p.minDepth),
  });
  if (p.portfolio) {
    const { stop, trail } = queryOf(p.portfolio);
    if (stop) q.set('stop', stop);
    if (trail) q.set('trail', trail);
    // the stop is set for the page's lots a strategy, so the replay books each pick at them
    if (stop || trail) q.set('lots', String(ROTATION_PAGE_LOTS));
  }
  return useWarmingResource<RotationDrawdownsResponse>(
    `${BASE}/rotation/drawdowns?${q.toString()}`,
    { pending: (d) => d.with_stop_pending === true },
  );
}
