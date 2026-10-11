import { useEffect, useState } from 'react';

import { usePolledResource } from './usePolledResource';

export interface LiquidityExcludedStock {
  symbol: string;
  reason: string;
  median_turnover_cr: number | null;
  price: number | null;
}

export interface LiquidityPreview {
  as_of: string | null;
  data_through: string | null;
  warning: string | null;
  universe: number;
  eligible: number;
  reasons: Record<string, number>;
  excluded: LiquidityExcludedStock[];
  median_turnover_cr_p50: number | null;
}

export interface LiquidityPreviewParams {
  min_turnover_cr: number;
  floor_ratio: number;
  min_price: number;
  circuit: boolean;
  circuit_run: number;
  max_circuit_days: number | null;
  universe: 'total_market' | 'all_liquid' | 'turnover_rank';
}

/** Query string for the preview route; an unset circuit-days cap is simply omitted. */
export function liquidityPreviewUrl(params: LiquidityPreviewParams): string {
  const query = new URLSearchParams({
    min_turnover_cr: String(params.min_turnover_cr),
    floor_ratio: String(params.floor_ratio),
    min_price: String(params.min_price),
    circuit: String(params.circuit),
    circuit_run: String(params.circuit_run),
    universe: params.universe,
  });
  if (params.max_circuit_days !== null) {
    query.set('max_circuit_days', String(params.max_circuit_days));
  }
  return `/api/momentum/liquidity-preview?${query.toString()}`;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Live "how many stocks pass" preview; waits for typing to settle before asking the server. */
export function useLiquidityPreview(params: LiquidityPreviewParams) {
  const url = useDebounced(liquidityPreviewUrl(params), 400);
  return usePolledResource<LiquidityPreview>(url);
}
