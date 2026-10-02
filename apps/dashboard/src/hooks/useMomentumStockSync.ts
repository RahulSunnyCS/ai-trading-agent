/**
 * useMomentumStockSync — the "Refresh stock data" button's background job (B4): an
 * incremental bhavcopy fetch plus a shared-database migrate, the same work the Friday
 * 19:30 IST launchd job runs. Built on the generic single-flight job poller.
 */

import type { MomentumStockSyncJob } from '../types/momentum';
import { useMomentumBackgroundJob } from './useMomentumBackgroundJob';

export function useMomentumStockSync() {
  return useMomentumBackgroundJob<MomentumStockSyncJob>(
    '/api/momentum/weekly/stock-sync/jobs/latest',
    '/api/momentum/weekly/stock-sync',
  );
}
