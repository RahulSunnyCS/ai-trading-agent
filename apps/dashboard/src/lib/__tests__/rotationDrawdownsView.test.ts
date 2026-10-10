import { describe, expect, it } from 'vitest';

import {
  areaPath,
  asDepth,
  asWindow,
  baseText,
  durationText,
  episodeSpans,
  geometry,
  linePath,
  niceStep,
  readingLine,
} from '../rotationDrawdownsView';
import { episode, point, response } from './rotationDrawdownsFixture';

describe('controls', () => {
  it('fall back to P1 and the registered ₹500 for anything unknown', () => {
    expect(asWindow(null)).toBe('P1');
    expect(asWindow('custom')).toBe('P1');
    expect(asWindow('forward')).toBe('forward');
    expect(asDepth(null)).toBe(500);
    expect(asDepth('7')).toBe(500);
    expect(asDepth('1000')).toBe(1000);
  });
});

describe('niceStep', () => {
  it.each([
    [10000, 2500],
    [1500, 500],
    [900, 250],
    [60, 20],
    [0, 1],
  ])('gives a tidy gridline step for %s', (span, step) => {
    expect(niceStep(span)).toBe(step);
  });
});

describe('geometry', () => {
  it('puts zero at the top and the deepest value (list or base) at the bottom', () => {
    const g = geometry([point('a', 0), point('b', -1000, { base_underwater: -3000 })]);
    expect(g.y(0)).toBe(g.top);
    expect(g.y(g.min)).toBeCloseTo(g.height - g.bottom);
    expect(g.min).toBeLessThan(-3000); // padded below the base's depth
    expect(g.ticks[0]).toBe(0);
    expect(g.x(0)).toBe(g.left);
    expect(g.x(1)).toBe(g.width - g.right);
  });

  it('copes with a series that never falls and with one point', () => {
    const flat = geometry([point('a', 0), point('b', 0)]);
    expect(Number.isFinite(flat.y(0))).toBe(true);
    expect(flat.min).toBeLessThan(0);
    const one = geometry([point('a', -5)]);
    expect(Number.isFinite(one.x(0))).toBe(true);
  });
});

describe('paths', () => {
  const g = geometry(response().series);

  it('breaks a line where a value is missing, never drawing through it', () => {
    const d = linePath([0, -100, null, -300, -200], g);
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d.match(/L/g)?.length).toBe(2);
  });

  it('closes an area against the zero line', () => {
    const d = areaPath([0, -100, -50], g);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(areaPath([], g)).toBe('');
  });
});

describe('episodeSpans', () => {
  const series = response().series;

  it('runs from the day after the peak to the day back at it', () => {
    expect(episodeSpans(series, [episode()])).toEqual([{ n: 1, from: 1, to: 5 }]);
  });

  it('runs an open episode to the last day, and a start-of-series one from the first', () => {
    const open = episode({ peak_day: null, end_day: null, open: true, sessions_back: null });
    expect(episodeSpans(series, [open])).toEqual([{ n: 1, from: 0, to: series.length - 1 }]);
  });

  it('skips an episode whose trough is not in the series', () => {
    expect(episodeSpans(series, [episode({ trough_day: '2020-01-01' })])).toEqual([]);
  });
});

describe('words', () => {
  it('says how long it was down and whether it came back', () => {
    expect(durationText(episode())).toBe('3 down, 2 to recover');
    expect(durationText(episode({ open: true, sessions_back: null }))).toBe('3 down, still open');
  });

  it('gives the base over the same days, with the days it was missing', () => {
    expect(baseText(episode({ base_change: -400 }))).toBe('-₹400');
    expect(baseText(episode({ base_change: 1200, base_missing: 2 }))).toBe(
      '+₹1,200 (2 days missing)',
    );
    expect(baseText(episode({ base_change: null }))).toBe('—');
  });
});

describe('readingLine', () => {
  it('gives the worst fall against the base, how many fell, and how many it hid', () => {
    const text = readingLine(response());
    expect(text).toContain('worst fall was -₹1,500 per lot');
    expect(text).toContain('-₹3,000 for the fixed base');
    expect(text).toContain('1 fall of at least ₹500 per lot (2 smaller ones hidden)');
    expect(text).toContain('description, not a test');
  });

  it('says where it is now and calls forward the unseen sessions', () => {
    const text = readingLine(
      response({
        in_sample: false,
        current: { underwater: -800, since: '2026-03-02', sessions: 4 },
      }),
    );
    expect(text).toContain('It is now ₹800 per lot below its peak of');
    expect(text).toContain('4 sessions on');
    expect(text).toContain('only ones the weights had not seen');
  });

  it('says so when nothing reached the threshold', () => {
    expect(readingLine(response({ episodes: [], all_episodes: 2 }))).toContain(
      'No fall reached ₹500 per lot.',
    );
  });

  it('is empty with no sessions', () => {
    expect(readingLine(response({ n_days: 0, series: [], episodes: [] }))).toBe('');
  });
});
