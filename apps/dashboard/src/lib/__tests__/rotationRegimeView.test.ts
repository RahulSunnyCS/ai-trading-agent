import { describe, expect, it } from 'vitest';

import {
  closerText,
  quantileText,
  readingLine,
  segmentTitle,
  shade,
  shares,
} from '../rotationRegimeView';
import { period, response } from './rotationRegimeFixture';

describe('shares', () => {
  it('are fractions of the sessions that sum to one', () => {
    const p = period('P1', {}, { weekday: [1, 1, 1, 1, 0] });
    const s = shares(p.mix?.weekday ?? { categories: [], counts: [], n: 0 });
    expect(s).toEqual([0.25, 0.25, 0.25, 0.25, 0]);
  });

  it('are all zero for an empty mix, not NaN', () => {
    expect(shares({ categories: ['a', 'b'], counts: [0, 0], n: 0 })).toEqual([0, 0]);
  });
});

describe('shade', () => {
  it('runs light to dark and is never invisible', () => {
    const s = [0, 1, 2, 3].map((i) => shade(i, 4));
    expect(s).toEqual([...s].sort((a, b) => a - b));
    expect(Math.min(...s)).toBeGreaterThan(0.1);
    expect(Math.max(...s)).toBeLessThanOrEqual(1);
    expect(shade(0, 1)).toBeGreaterThan(0);
  });
});

describe('quantileText', () => {
  it('gives P10 · P50 · P90 with the unit', () => {
    expect(quantileText({ n: 5, p10: 0.47, p50: 0.84, p90: 1.63 }, 2, '%')).toBe(
      '0.47% · 0.84% · 1.63%',
    );
  });

  it('is an em dash when there is nothing', () => {
    expect(quantileText(null, 1)).toBe('—');
    expect(quantileText({ n: 0, p10: null, p50: null, p90: null }, 1)).toBe('—');
  });
});

describe('words', () => {
  it('names the nearer period, a tie and nothing', () => {
    expect(closerText('P2')).toBe('P2');
    expect(closerText('neither')).toBe('neither');
    expect(closerText(null)).toBe('—');
  });

  it('gives a segment tooltip with its count and share', () => {
    expect(segmentTitle('13-15', 9, 0.5)).toBe('13-15: 9 sessions (50%)');
  });
});

describe('readingLine', () => {
  it('names the nearer period overall, where the rows disagree, and that it is noisy when thin', () => {
    const text = readingLine(response());
    expect(text).toContain('nearer P1');
    expect(text).toContain('VIX band is nearer P2');
    expect(text).toContain('not evidence about the lists');
    expect(text).toContain('18 forward sessions');
  });

  it('does not call a nearer period inside the tie band', () => {
    const r = response();
    if (r.distances) {
      r.distances = { ...r.distances, closer: 'neither' };
    }
    expect(readingLine(r)).toContain('not clearly nearer either period');
  });

  it('drops the thin warning once there are enough sessions', () => {
    const text = readingLine(response({ thin: false, forward_days: 60 }));
    expect(text).toContain('does not test the lists');
    expect(text).not.toContain('noisy');
  });

  it('is empty with no forward sessions', () => {
    expect(readingLine(response({ distances: null }))).toBe('');
  });
});
