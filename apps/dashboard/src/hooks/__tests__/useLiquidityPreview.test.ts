import { describe, expect, it } from 'vitest';

import { liquidityPreviewUrl } from '../useLiquidityPreview';

const base = {
  min_turnover_cr: 1,
  floor_ratio: 0.25,
  min_price: 20,
  circuit: true,
  circuit_run: 3,
  max_circuit_days: null,
  universe: 'total_market' as const,
};

describe('liquidityPreviewUrl', () => {
  it('omits the circuit-days cap when it is unset', () => {
    const url = liquidityPreviewUrl(base);
    expect(url).toContain('/api/momentum/liquidity-preview?');
    expect(url).toContain('min_turnover_cr=1');
    expect(url).toContain('universe=total_market');
    expect(url).not.toContain('max_circuit_days');
  });

  it('sends the cap, including zero, when it is set', () => {
    expect(liquidityPreviewUrl({ ...base, max_circuit_days: 0 })).toContain('max_circuit_days=0');
    expect(liquidityPreviewUrl({ ...base, max_circuit_days: 8, universe: 'all_liquid' })).toContain(
      'universe=all_liquid',
    );
  });
});
