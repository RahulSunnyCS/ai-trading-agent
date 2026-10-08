import { describe, expect, it } from 'vitest';

import { DEFAULT_MOMENTUM_SAVED, parseStoredMomentumSaved } from './momentumSaved';

describe('momentumSaved preferences', () => {
  it('reads the stored choice and falls back on anything else', () => {
    expect(parseStoredMomentumSaved('{"findingsHidden":true}')).toEqual({ findingsHidden: true });
    expect(parseStoredMomentumSaved(null)).toEqual(DEFAULT_MOMENTUM_SAVED);
    expect(parseStoredMomentumSaved('not json')).toEqual(DEFAULT_MOMENTUM_SAVED);
    expect(parseStoredMomentumSaved('{"findingsHidden":"yes"}')).toEqual({ findingsHidden: false });
  });
});
