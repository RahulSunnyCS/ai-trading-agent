/**
 * A list's selection drift for the Rotation page's card. One request through the Fastify proxy;
 * the files behind it change once a night and at 09:16, so it is fetched when the list changes
 * and on Refresh, not polled.
 */

import { useSlippageUrl } from '../store/rotationSlippage';
import type { RotationListKey } from '../types/rotation';
import type { RotationDriftResponse } from '../types/rotationDrift';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useRotationDrift(list: RotationListKey) {
  return usePolledResource<RotationDriftResponse>(
    useSlippageUrl(`${BASE}/rotation/drift?list=${list}`),
  );
}
