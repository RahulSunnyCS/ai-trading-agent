import { describe, expect, it } from 'vitest';

import { CARD_KEYS } from '../rotationListCards';

describe('CARD_KEYS', () => {
  it('is Adaptive alone, never Steady, Calendar or Baseline', () => {
    expect(CARD_KEYS).toEqual(['C']);
  });
});
