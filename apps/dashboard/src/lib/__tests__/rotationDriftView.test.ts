import { describe, expect, it } from 'vitest';

import {
  bandText,
  flagText,
  flagged,
  measureBand,
  measureValue,
  readingLine,
  spanText,
  tint,
} from '../rotationDriftView';
import { indexDimension, kindDimension, measure, response } from './rotationDriftFixture';

describe('tint', () => {
  it('runs light to dark and is never invisible', () => {
    const t = [0, 1, 2, 3].map((i) => tint(i, 4));
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(Math.min(...t)).toBeGreaterThan(0.1);
    expect(Math.max(...t)).toBeLessThanOrEqual(1);
    expect(tint(0, 1)).toBeGreaterThan(0);
  });
});

describe('words', () => {
  it('says a band, and that there is none yet', () => {
    expect(bandText({ p10: 0.49, p90: 0.76 })).toBe('49% to 76%');
    expect(bandText(null)).toBe('no band yet');
  });

  it('says a flag with its direction and the usual range', () => {
    const f = indexDimension().flags[1];
    expect(f && flagText(f)).toBe('SENSEX 100% over the last 21, above its usual 24% to 51%');
  });

  it('indexes the flags by category', () => {
    expect([...flagged(indexDimension()).keys()]).toEqual(['NIFTY', 'SENSEX']);
    expect(flagged(kindDimension()).size).toBe(0);
  });

  it('names the variant on the most-picked row and uses a dash before 21 sessions', () => {
    expect(measureValue(measure({ key: 'most_picked', last21: 3, name: 'N_p100_1217' }))).toBe(
      '3 · N_p100_1217',
    );
    expect(measureValue(measure({ last21: null }))).toBe('—');
    expect(measureBand(measure())).toBe('36 to 44');
    expect(measureBand(measure({ band: null }))).toBe('—');
  });

  it('says what the sessions are made of', () => {
    const d = response();
    expect(spanText(d, 'history')).toContain('202 sessions, all re-scored');
    const mixed = response({
      windows: {
        ...d.windows,
        last21: {
          from: '2026-09-14',
          to: '2026-10-12',
          n_days: 21,
          recorded: 3,
          reconstructed: 18,
        },
      },
    });
    expect(spanText(mixed, 'last21')).toContain('3 recorded, 18 re-scored');
    expect(
      spanText(
        response({ windows: { ...d.windows, last21: { ...d.windows.last21, n_days: 0 } } }),
        'last21',
      ),
    ).toBe('no sessions');
  });
});

describe('readingLine', () => {
  it('lists what is outside its range and says a flag is not a fault', () => {
    const text = readingLine(response());
    expect(text).toContain('Index: NIFTY 0% over the last 21, below its usual 49% to 76%');
    expect(text).toContain('Distinct variants picked (above)');
    expect(text).toContain('a description, not a fault');
  });

  it('says nothing is outside when nothing is', () => {
    const text = readingLine(
      response({
        dimensions: [kindDimension()],
        concentration: [measure({ flag: null })],
        flags: 0,
      }),
    );
    expect(text).toContain('nothing sits outside the range');
  });

  it('flags nothing while there is too little to read', () => {
    const text = readingLine(response({ enough: false }));
    expect(text).toContain('flags nothing');
  });
});
