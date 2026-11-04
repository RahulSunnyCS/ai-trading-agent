/**
 * One book's daily candles for the Rotation page's candle card. A cold request replays hundreds of
 * book-days, so the API may answer "warming" first; `useWarmingResource` asks again until the
 * answer arrives. Not polled otherwise: the files behind it change once a night and at 09:16.
 * `enabled: false` fetches nothing (the base line when the card already shows the base).
 */

import { candlesUrl } from '../lib/rotationCandlesView';
import { useSlippageUrl } from '../store/rotationSlippage';
import type { CandleBook, RotationCandlesResponse } from '../types/rotationCandles';
import { useWarmingResource } from './useWarmingResource';

export function useRotationCandles(book: CandleBook, lots: number, enabled = true) {
  return useWarmingResource<RotationCandlesResponse>(useSlippageUrl(candlesUrl(book, lots)), {
    enabled,
  });
}
