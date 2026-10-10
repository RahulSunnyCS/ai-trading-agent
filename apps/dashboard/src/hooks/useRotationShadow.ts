/**
 * The Shadow scoreboard's data (BL-083 triggers against their placebo, the override against the
 * pick it displaces, BL-081's forward candidates). One request through the Fastify proxy; the
 * files behind it change once a night, so it is fetched on mount and on Refresh, not polled.
 */

import type { RotationShadowResponse } from '../types/rotationShadow';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useRotationShadow(
  range: { from?: string | undefined; to?: string | undefined } = {},
) {
  const q = new URLSearchParams();
  if (range.from) q.set('from', range.from);
  if (range.to) q.set('to', range.to);
  const text = q.toString();
  return usePolledResource<RotationShadowResponse>(
    `${BASE}/rotation/shadow${text ? `?${text}` : ''}`,
  );
}
