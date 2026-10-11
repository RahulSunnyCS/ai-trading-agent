/**
 * One day's basket for the Correlation tab's "Today's basket" preset. One request through the
 * Fastify proxy; the files behind it change once a night, so it is fetched when the choice
 * changes and on Refresh, not polled.
 */

import type {
  BasketListKey,
  BasketWindowId,
  RotationBasketResponse,
} from '../types/rotationBasket';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useRotationBasket(p: {
  list: BasketListKey;
  day?: string | undefined;
  window: BasketWindowId;
}) {
  const q = new URLSearchParams({ list: p.list, window: p.window });
  if (p.day && p.list !== 'BASE') q.set('day', p.day);
  return usePolledResource<RotationBasketResponse>(`${BASE}/rotation/basket?${q.toString()}`);
}
