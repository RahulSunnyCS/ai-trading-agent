/**
 * A list's drawdown episodes for the Rotation page's card. One request through the Fastify proxy;
 * the files behind it change once a night, so it is fetched when the choice changes and on
 * Refresh, not polled.
 */

import type { RotationListKey } from '../types/rotation';
import type { DrawdownWindowId, RotationDrawdownsResponse } from '../types/rotationDrawdowns';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useRotationDrawdowns(p: {
  list: RotationListKey;
  window: DrawdownWindowId;
  minDepth: number;
}) {
  const q = new URLSearchParams({
    list: p.list,
    window: p.window,
    min_depth: String(p.minDepth),
  });
  return usePolledResource<RotationDrawdownsResponse>(`${BASE}/rotation/drawdowns?${q.toString()}`);
}
