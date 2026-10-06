// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { describeDuration, recordDuration, usualDuration } from '../momentumDurations';

beforeEach(() => localStorage.clear());

describe('momentumDurations', () => {
  it('knows nothing until a run has been recorded', () => {
    expect(usualDuration('broad')).toBeNull();
  });

  it('shows the middle of the recent runs, per dataset', () => {
    for (const ms of [20_000, 4_000, 22_000]) recordDuration('broad', ms);
    recordDuration('etf', 2_000);
    expect(usualDuration('broad')).toBe(20_000);
    expect(usualDuration('etf')).toBe(2_000);
    expect(usualDuration('stock')).toBeNull();
  });

  it('averages the two middle runs when there is an even number', () => {
    for (const ms of [10_000, 20_000]) recordDuration('broad', ms);
    expect(usualDuration('broad')).toBe(15_000);
  });

  it('keeps only the last five, so one very old run stops counting', () => {
    recordDuration('broad', 1_000);
    for (const ms of [30_000, 31_000, 32_000, 33_000, 34_000]) recordDuration('broad', ms);
    expect(usualDuration('broad')).toBe(32_000);
  });

  it('ignores a nonsense duration and survives corrupt storage', () => {
    recordDuration('broad', 0);
    recordDuration('broad', Number.NaN);
    recordDuration('broad', -5);
    expect(usualDuration('broad')).toBeNull();
    localStorage.setItem('ata-momentum-durations', '{not json');
    expect(usualDuration('broad')).toBeNull();
    recordDuration('broad', 8_000); // and recovers on the next write
    expect(usualDuration('broad')).toBe(8_000);
  });

  it('puts a duration in words', () => {
    expect(describeDuration(400)).toBe('about 1 s');
    expect(describeDuration(19_600)).toBe('about 20 s');
    expect(describeDuration(65_000)).toBe('about 1 min 5 s');
    expect(describeDuration(120_000)).toBe('about 2 min');
  });
});
