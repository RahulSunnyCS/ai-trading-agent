/**
 * The Commodity Lab's two reads (api/mcx_routes.py): the four minis' expiries and collected data,
 * and the GOLDM Dir forward test's journal. Both change at most a few times a day (the nightly
 * collection, the 01:30 score), so they are fetched on mount and on Refresh, not polled.
 */

import type { CommodityForward, CommodityOverview } from '../types/commodity';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/mcx';

export function useCommodityOverview() {
  return usePolledResource<CommodityOverview>(`${BASE}/overview`);
}

export function useCommodityForward() {
  return usePolledResource<CommodityForward>(`${BASE}/forward`);
}
