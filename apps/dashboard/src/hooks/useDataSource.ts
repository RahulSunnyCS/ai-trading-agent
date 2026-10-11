import { type SourceStatus, attentionDays } from '../lib/dataSource';
import { usePolledResource } from './usePolledResource';

const URL = '/api/backtest/legwise/source';
const POLL_MS = 5 * 60_000;

/** Days of options data that came from the Angel One fallback and are still unrepaired. */
export function useDataSource() {
  const { data, error } = usePolledResource<SourceStatus>(URL, {
    intervalMs: POLL_MS,
    cache: true,
  });
  return { status: data, days: attentionDays(data), error };
}
