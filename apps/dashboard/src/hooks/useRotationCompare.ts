/**
 * The Books table's head-to-head with the fixed base (Classic and Tuned per window, the edge over
 * random, the drift alarm). A cold request re-derives about 440 days of picks for three books, so
 * the API may answer "warming" first; `useWarmingResource` asks again until the answer arrives.
 * Not polled otherwise: the files behind it change once a night and at 09:16.
 */

import { useSlippageUrl } from '../store/rotationSlippage';
import type { RotationCompareResponse } from '../types/rotationCompare';
import { useWarmingResource } from './useWarmingResource';

export function useRotationCompare() {
  return useWarmingResource<RotationCompareResponse>(
    useSlippageUrl('/api/backtest/legwise/rotation/beats/compare'),
  );
}
