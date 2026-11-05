/**
 * Today's and the next session's day type (weekday and each index's weekdays to expiry), for the
 * Settings › Automation page's day-type rules (BL-211): the "What trades" preview resolves the
 * draft rules against them. One read of `GET /legwise/rotation/day-type`; the labels are the
 * 09:16 pick's own (rotation/day_type.py), so the preview and the jobs agree.
 */

import type { DayTypes } from '../lib/automation';
import { usePolledResource } from './usePolledResource';

const URL = '/api/backtest/legwise/rotation/day-type';

export function useDayTypes() {
  const res = usePolledResource<DayTypes>(URL, { cache: true });
  const data = res.data;
  return {
    today: data?.today ?? null,
    tomorrow: data?.tomorrow ?? null,
    errors: data?.errors ?? [],
    loading: res.loading,
    error: res.error,
    refetch: res.refetch,
  };
}
