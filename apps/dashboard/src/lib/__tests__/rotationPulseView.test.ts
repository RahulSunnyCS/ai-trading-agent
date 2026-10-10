import { describe, expect, it } from 'vitest';

import type { PulseAvailable, PulseCell, PulseStat } from '../../types/rotationPulse';
import { EMPTY } from '../format';
import {
  asOfLine,
  bandText,
  chipGroups,
  criterionNote,
  figure,
  flagNote,
  flagView,
  isShort,
  matrixHref,
  nearestIndex,
  picksHeader,
  rankView,
  shareSource,
  shareView,
  sourceLine,
  sparkGeometry,
} from '../rotationPulseView';

const stat = (over: Partial<PulseStat> = {}): PulseStat => ({
  st: 'ok',
  avg: 675.74,
  n: 21,
  nv: 336,
  variants: 16,
  first: '2026-09-09',
  last: '2026-10-09',
  forward: 0,
  ...over,
});

function cell(over: Partial<PulseCell> = {}): PulseCell {
  return {
    key: 'dir_A',
    kind: 'dir',
    band: 'A',
    label: 'Dir 09:17-10:02',
    kind_label: 'Dir',
    band_label: '09:17-10:02',
    slots: ['0917', '0932', '0947', '1002'],
    variants: 16,
    st: 'ok',
    windows: { '5': stat({ n: 5 }), '21': stat(), '63': stat({ n: 63 }) },
    p1: stat({ avg: 311.89, n: 210 }),
    p2: stat({ avg: 384.6, n: 160 }),
    flag: { state: 'above', windows: 190, p10: -181.25, p90: 639.67, last21: 675.74 },
    rank: { value: 4080.01, rank: 1, of: 12 },
    chips: [],
    share: { recorded: null, reconstructed: { core: 3, share: 0.0476, buy_days: 0 } },
    matrix: { view: 'pulse', family: 'dirs', slot: '0917,0932,0947,1002', index: null },
    ...over,
  };
}

function pulse(over: Partial<PulseAvailable> = {}): PulseAvailable {
  return {
    available: true,
    basis: 'gross',
    as_of: '2026-10-09',
    as_of_requested: null,
    store: { first: '2024-10-09', last: '2026-10-09', sessions: 490, weekend_excluded: [] },
    next_pick_day: '2026-10-12',
    list: 'A',
    index: 'both',
    windows: [5, 21, 63],
    periods: {
      P1: { label: 'P1', from: '2025-12-03', to: '2026-10-08' },
      P2: { label: 'P2', from: '2025-01-10', to: '2025-08-29' },
    },
    rank: {
      available: true,
      reason: null,
      history_days: 486,
      history_to: '2026-10-09',
      of: 12,
      basis: 'net',
      for: '2026-10-12',
      weights: { A: 0.05, B: 0.05, C: 0.05, REF: 0 },
    },
    picks: { source: null, day: null, late: false, lists: {} },
    share: { list: 'A', sessions: 21, recorded: null, reconstructed: null },
    journal: {
      entries: 0,
      on_time: 0,
      late: [],
      chain: { intact: true, problems: [], error: null },
    },
    flag_rule: 'rule',
    cells: [cell()],
    ...over,
  };
}

describe('figures', () => {
  it('shows the mean with sessions and variants, signed by tone', () => {
    const f = figure(stat(), 'Last 21 sessions');
    expect(f.text).toBe('₹676');
    expect(f.counts).toBe('21·16');
    expect(f.tone).toBe('positive');
    expect(f.title).toContain('336 variant-days over 21 sessions');
    expect(f.missing).toBe(false);
  });

  it('a negative mean is negative and a genuine zero is a number, not a dash', () => {
    expect(figure(stat({ avg: -121.2 }), 'x').tone).toBe('negative');
    const zero = figure(stat({ avg: 0 }), 'x');
    expect(zero.text).toBe('₹0');
    expect(zero.missing).toBe(false);
  });

  it('a window with no stored result is a dash with its reason, never zero', () => {
    const f = figure(
      {
        st: 'missing',
        avg: null,
        n: 0,
        nv: 0,
        variants: 0,
        reason: 'no stored result in this window',
      },
      'P2',
    );
    expect(f.text).toBe(EMPTY);
    expect(f.counts).toBe('');
    expect(f.title).toBe('P2: no stored result in this window');
    expect(f.missing).toBe(true);
    expect(figure(undefined, 'P1').text).toBe(EMPTY);
  });

  it('flags a window shorter than asked', () => {
    expect(isShort(stat({ n: 12 }), 21)).toBe(true);
    expect(isShort(stat({ n: 21 }), 21)).toBe(false);
    expect(isShort(undefined, 21)).toBe(false);
  });
});

describe('rank and flag', () => {
  it('prints the rank among the twelve, and says why when the ranking cannot be rebuilt', () => {
    const r = pulse();
    expect(rankView(cell(), r).text).toBe('1/12');
    const short = pulse({
      rank: { ...r.rank, available: false, reason: 'the ranking needs 63 stored sessions' },
    });
    const v = rankView(cell({ rank: null }), short);
    expect(v.text).toBe(EMPTY);
    expect(v.rank).toBeNull();
    expect(v.title).toContain('63');
  });

  it('flags above and below the cell’s own P1 range, and nothing for inside or unknown', () => {
    expect(flagView({ state: 'above', windows: 190, p10: 1, p90: 2, last21: 3 })?.label).toBe(
      'Above its P1 range',
    );
    expect(flagView({ state: 'below', windows: 190, p10: 1, p90: 2, last21: 0 })?.label).toBe(
      'Below its P1 range',
    );
    expect(flagView({ state: 'inside', windows: 190, p10: 1, p90: 3, last21: 2 })).toBeNull();
    const unknown = {
      state: 'unknown',
      windows: 10,
      reason: 'only 10 rolling-21 windows in P1',
    } as const;
    expect(flagView(unknown)).toBeNull();
    expect(flagNote(unknown)).toContain('only 10');
  });
});

describe('picks and share', () => {
  it('groups chips by list, in list order, with a count and the focus marked', () => {
    const groups = chipGroups(
      [
        { list: 'REF', variant: 'N_dir_0917', role: 'core' },
        { list: 'A', variant: 'N_dir_0932', role: 'core' },
        { list: 'A', variant: 'S_dir_0917', role: 'core' },
      ],
      'A',
    );
    expect(groups.map((g) => [g.list, g.count, g.focus])).toEqual([
      ['A', 2, true],
      ['REF', 1, false],
    ]);
    expect(groups[0]?.title).toContain('N_dir_0932');
    expect(chipGroups(undefined, 'A')).toEqual([]);
  });

  it('labels the picks as recorded, reconstructed, late, or absent', () => {
    expect(picksHeader(pulse()).label).toBeNull();
    const recon = picksHeader(
      pulse({ picks: { source: 'reconstructed', day: '2026-10-09', late: false, lists: {} } }),
    );
    expect(recon.label).toBe('Reconstructed 09 Oct 2026');
    expect(recon.note).toContain('not a record');
    const late = picksHeader(
      pulse({ picks: { source: 'recorded', day: '2026-10-14', late: true, lists: {} } }),
    );
    expect(late.label).toBe('Recorded 14 Oct 2026');
    expect(late.note).toContain('not forward');
    const ok = picksHeader(
      pulse({ picks: { source: 'recorded', day: '2026-10-12', late: false, lists: {} } }),
    );
    expect(ok.note).toBeNull();
  });

  it('prefers recorded picks for the share and falls back to reconstructed, never both', () => {
    const summary = {
      sessions: 21,
      core_total: 63,
      list: 'A',
      from: '2026-09-09',
      to: '2026-10-09',
    } as const;
    expect(shareSource(pulse())).toBeNull();
    expect(
      shareSource(
        pulse({ share: { list: 'A', sessions: 21, recorded: null, reconstructed: summary } }),
      ),
    ).toBe('reconstructed');
    expect(
      shareSource(
        pulse({
          share: {
            list: 'A',
            sessions: 21,
            recorded: { ...summary, sessions: 3 },
            reconstructed: summary,
          },
        }),
      ),
    ).toBe('recorded');
  });

  it('shows a core pick share for Widesl and Dir, and add-on days for a Buy cell', () => {
    const r = pulse({
      share: {
        list: 'A',
        sessions: 21,
        recorded: null,
        reconstructed: {
          sessions: 21,
          core_total: 63,
          list: 'A',
          from: '2026-09-09',
          to: '2026-10-09',
        },
      },
    });
    const dir = shareView(cell(), r);
    expect(dir.text).toBe('5% · 3/63');
    expect(dir.title).toContain('Reconstructed picks of list A');
    const buy = shareView(
      cell({
        kind: 'buy',
        share: { recorded: null, reconstructed: { core: 0, share: null, buy_days: 5 } },
      }),
      r,
    );
    expect(buy.text).toBe('5 of 21 d');
    expect(shareView(cell(), pulse()).text).toBe(EMPTY);
  });
});

describe('header texts and links', () => {
  it('derives the criterion note from the lists’ own weights', () => {
    expect(criterionNote(pulse())).toBe(
      'The family-band criterion carries 5% of the composite in A, B and C and none in REF.',
    );
    const none = pulse({
      rank: { ...pulse().rank, weights: { A: 0, B: 0, C: 0, REF: 0 } },
    });
    expect(criterionNote(none)).toBe('The family-band criterion carries no weight in any list.');
  });

  it('says where the windows come from', () => {
    expect(sourceLine(pulse())).toContain('no forward session has been recorded yet');
    const some = pulse({
      journal: {
        entries: 2,
        on_time: 2,
        late: [],
        chain: { intact: true, problems: [], error: null },
      },
    });
    expect(sourceLine(some)).toContain('none scored yet');
    const scored = pulse({
      journal: {
        entries: 3,
        on_time: 3,
        late: [],
        chain: { intact: true, problems: [], error: null },
      },
      cells: [
        cell({
          windows: {
            '5': stat({ n: 5, forward: 3 }),
            '21': stat({ forward: 3 }),
            '63': stat({ n: 63, forward: 3 }),
          },
        }),
      ],
    });
    expect(sourceLine(scored)).toContain('3 scored forward sessions');
  });

  it('prints the as-of line and the band with an en dash', () => {
    expect(asOfLine(pulse())).toBe(
      'As of 09 Oct 2026 · ranking sees: the pick of 12 Oct 2026 · gross per lot-day',
    );
    expect(bandText('09:17-10:02')).toBe('09:17–10:02');
  });

  it('opens the matrix’s pulse view filtered to the cell’s kind and band', () => {
    expect(matrixHref(cell())).toBe(
      '/optionslab/matrix?view=pulse&family=dirs&slot=0917%2C0932%2C0947%2C1002',
    );
    const nifty = cell({
      matrix: { view: 'pulse', family: 'widesl', slot: '0917', index: 'NIFTY' },
    });
    expect(matrixHref(nifty)).toBe(
      '/optionslab/matrix?view=pulse&family=widesl&slot=0917&index=NIFTY',
    );
    expect(matrixHref(cell({ matrix: undefined as never }))).toBeNull();
  });
});

describe('sparkline geometry', () => {
  it('puts the mean line inside the scale and leaves gaps for missing values', () => {
    const g = sparkGeometry([0, 10, null, 20], 5, 100, 20, 2);
    expect(g.path.startsWith('M2.0 18.0')).toBe(true);
    expect(g.path).toContain('M'); // a second sub-path after the gap
    expect(g.path.match(/M/g)?.length).toBe(2);
    expect(g.ys[2]).toBeNull();
    expect(g.meanY).toBeCloseTo(14, 5);
    expect(g.xs[3]).toBeCloseTo(98, 5);
  });

  it('a mean outside the series stretches the scale, so the dashed line is never cut', () => {
    const g = sparkGeometry([10, 12], 100, 100, 20, 2);
    expect(g.meanY).toBeCloseTo(2, 5);
    expect(g.ys[0]).toBeCloseTo(18, 5);
  });

  it('a flat series sits mid-height and an empty one draws nothing', () => {
    const flat = sparkGeometry([5, 5, 5], null, 100, 20);
    expect(flat.ys.every((y) => y === 10)).toBe(true);
    expect(flat.meanY).toBeNull();
    const none = sparkGeometry([null, null], null, 100, 20);
    expect(none.path).toBe('');
    expect(none.meanY).toBeNull();
  });

  it('finds the nearest point under the pointer, clamped to the ends', () => {
    expect(nearestIndex(2, 100, 126)).toBe(0);
    expect(nearestIndex(98, 100, 126)).toBe(125);
    expect(nearestIndex(50, 100, 3)).toBe(1);
    expect(nearestIndex(500, 100, 3)).toBe(2);
    expect(nearestIndex(10, 100, 1)).toBe(0);
  });
});
