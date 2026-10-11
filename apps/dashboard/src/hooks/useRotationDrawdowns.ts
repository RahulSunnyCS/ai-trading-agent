/**
 * A list's drawdown episodes for the Rotation page's card. One request through the Fastify proxy;
 * the files behind it change once a night, so it is fetched when the choice changes and on
 * Refresh, not polled.
 */

import { type PortfolioStopSetting, queryOf } from '../lib/portfolioStop';
import type { RotationListKey } from '../types/rotation';
import type { DrawdownWindowId, RotationDrawdownsResponse } from '../types/rotationDrawdowns';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useRotationDrawdowns(p: {
  list: RotationListKey;
  window: DrawdownWindowId;
  minDepth: number;
  /** BL-092: also run the series through the portfolio stop (nothing is added when it is off). */
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
  }
  return usePolledResource<RotationDrawdownsResponse>(`${BASE}/rotation/drawdowns?${q.toString()}`);
}
