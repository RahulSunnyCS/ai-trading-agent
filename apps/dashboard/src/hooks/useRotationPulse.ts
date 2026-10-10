/**
 * The Family pulse card's data: one request through the Fastify proxy
 * (`/api/backtest/legwise/rotation/pulse`). The files behind it change once a night and the picks
 * once a morning, so it is fetched on mount, when the focus list or index changes, and on Reload.
 */

import type { PulseIndex, PulseListKey, PulseResponse } from '../types/rotationPulse';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/rotation/pulse';

export function useRotationPulse(list: PulseListKey, index: PulseIndex) {
  const q = new URLSearchParams({ list });
  if (index !== 'both') q.set('index', index);
  return usePolledResource<PulseResponse>(`${BASE}?${q.toString()}`, { cache: true });
}
