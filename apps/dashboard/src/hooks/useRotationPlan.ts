/**
 * The Today page's baskets with what the platforms hold (`/legwise/rotation/plan`). The ledgers
 * change at the evening upload, the morning top-up and the 15:40 switch-off, so it is fetched on
 * mount and on Reload, not polled.
 */

import { useSlippageUrl } from '../store/rotationSlippage';
import type { RotationPlan } from '../types/rotationPlan';
import { usePolledResource } from './usePolledResource';

export function useRotationPlan() {
  return usePolledResource<RotationPlan>(useSlippageUrl('/api/backtest/legwise/rotation/plan'));
}
