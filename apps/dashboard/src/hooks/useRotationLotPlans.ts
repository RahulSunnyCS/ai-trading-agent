/**
 * One book's lot plans for the Rotation page's "Lot plans" card (BL-135). One request through the
 * Fastify proxy; the files behind it change once a night and at 09:16, so it is fetched when the
 * book changes and on Refresh, not polled.
 */

import { useSlippageUrl } from '../store/rotationSlippage';
import type { LotPlanBook, RotationLotPlansResponse } from '../types/rotationLotPlans';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise';

export function useRotationLotPlans(book: LotPlanBook) {
  return usePolledResource<RotationLotPlansResponse>(
    useSlippageUrl(`${BASE}/rotation/lot-plans?book=${book}`),
  );
}
