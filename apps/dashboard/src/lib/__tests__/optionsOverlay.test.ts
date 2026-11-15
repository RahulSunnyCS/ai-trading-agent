import { describe, expect, it } from 'vitest';

import { DEFAULT_REQUEST, countRows, requestChips, requestProblem } from '../optionsOverlay';

describe('options overlay helpers', () => {
  it('needs a strategy only where calls are bought on its picks', () => {
    expect(requestProblem({ ...DEFAULT_REQUEST, direction: 'calls' })).toMatch(/strategy/);
    expect(requestProblem({ ...DEFAULT_REQUEST, direction: 'puts' })).toBeNull();
    expect(requestProblem({ ...DEFAULT_REQUEST, direction: 'mirror' })).toBeNull();
    expect(
      requestProblem({ ...DEFAULT_REQUEST, direction: 'puts', sizing: 'capital_share' }),
    ).toMatch(/share of capital/);
  });

  it('says what the next run tests in chips', () => {
    const chips = requestChips(
      { ...DEFAULT_REQUEST, direction: 'switch', favourite_id: 'x' },
      'Trio',
    );
    expect(chips[0]).toBe('Trio');
    expect(chips).toContain('Market switch');
    expect(chips).toContain('NIFTY below its 200-day average');
    expect(requestChips({ ...DEFAULT_REQUEST, direction: 'mirror' }, null)).not.toContain(
      'No strategy',
    );
  });

  it('lists the skip counts largest first without zeros or the total', () => {
    const rows = countRows({ entries: 100, thin: 3, banned: 0, restruck: 7 });
    expect(rows.map((r) => r.value)).toEqual([7, 3]);
  });
});
