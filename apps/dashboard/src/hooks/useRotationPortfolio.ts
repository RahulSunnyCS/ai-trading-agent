/**
 * Data hooks for the portfolio stop (BL-092), on usePolledResource and behind the Fastify proxy
 * (/api/backtest/legwise/rotation/portfolio/*). Read-only. Nothing is fetched while the setting
 * changes nothing (no stop, no lock): the page then shows the log's own figures.
 */

import { type PortfolioStopSetting, isOn, queryOf } from '../lib/portfolioStop';
import type { RotationListKey, RotationLogSource } from '../types/rotationDailyLog';
import type { PortfolioDay, PortfolioDays } from '../types/rotationPortfolio';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/rotation/portfolio';

function query(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const text = q.toString();
  return text ? `?${text}` : '';
}

/** What `source` the API understands: the log's `all` has no portfolio view. */
function sourceOf(source: RotationLogSource): string {
  return source === 'reconstructed' ? 'reconstructed' : 'recorded';
}

/** Every scored list-day in the window with and without the stop. The first call over the whole
 * history replays about 600 strategy-days (tens of seconds); later calls are served warm. */
export function useRotationPortfolioDays(
  source: RotationLogSource,
  range: { from?: string | undefined; to?: string | undefined },
  setting: PortfolioStopSetting,
) {
  const { stop, trail } = queryOf(setting);
  return usePolledResource<PortfolioDays>(
    `${BASE}/days${query({ source: sourceOf(source), from: range.from, to: range.to, stop, trail })}`,
    { enabled: isOn(setting) },
  );
}

/** One list's basket on one day. Mount the component that calls it only when a replay is asked for. */
export function useRotationPortfolioDay(
  day: string,
  list: RotationListKey,
  source: RotationLogSource,
  setting: PortfolioStopSetting,
) {
  const { stop, trail } = queryOf(setting);
  return usePolledResource<PortfolioDay>(
    `${BASE}/day${query({ day, list, source: sourceOf(source), stop, trail })}`,
  );
}
