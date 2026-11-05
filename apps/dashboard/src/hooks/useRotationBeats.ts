/**
 * One book's beats-random share over the last 60 sessions and 6 months, for the Books table. A
 * cold request re-derives about 440 days of picks, so the API may answer "warming" first;
 * `useWarmingResource` asks again until the answer arrives. Not polled otherwise: the files
 * behind it change once a night and at 09:16.
 */

import { useSlippageUrl } from '../store/rotationSlippage';
import type { BeatsBook, RotationBeatsResponse } from '../types/rotationBeats';
import { useWarmingResource } from './useWarmingResource';

export function useRotationBeats(book: BeatsBook) {
  return useWarmingResource<RotationBeatsResponse>(
    useSlippageUrl(`/api/backtest/legwise/rotation/beats?book=${book}`),
  );
}
