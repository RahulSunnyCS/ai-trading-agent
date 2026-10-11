import { describe, expect, it } from 'vitest';

import { universeSettings } from '../momentumUniverse';

describe('universeSettings', () => {
  it('sets the tradability filter with a universe that forces it on', () => {
    expect(universeSettings('turnover_rank')).toEqual({
      broad_universe: 'turnover_rank',
      broad_liquidity_filter: true,
    });
    expect(universeSettings('all_liquid')).toEqual({
      broad_universe: 'all_liquid',
      broad_liquidity_filter: true,
    });
  });

  it("leaves the filter alone on Today's list, where it is the person's choice", () => {
    expect(universeSettings('total_market')).toEqual({ broad_universe: 'total_market' });
  });
});
