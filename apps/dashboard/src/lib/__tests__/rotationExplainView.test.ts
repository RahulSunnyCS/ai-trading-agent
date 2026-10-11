import { describe, expect, it } from 'vitest';

import type {
  RotationBoundary,
  RotationCriterion,
  RotationCriterionRow,
  RotationIc,
  RotationIcDay,
  RotationIcSummary,
  RotationVariantRow,
} from '../../types/rotationExplain';
import {
  bandIncludesZero,
  boundaryLines,
  differsFromEntry,
  dominantCriterion,
  icDomain,
  icLayout,
  icRows,
  icVerdict,
  nearestBar,
  orderedRows,
  provenanceFlags,
  roleLabel,
  snapDay,
  stackSegments,
  stepDay,
  supportOf,
  whyLine,
} from '../rotationExplainView';

function fit(weight: number, pct: number, days: number[]): RotationCriterionRow {
  return {
    value: 500,
    pct,
    weight,
    contribution: weight * pct,
    windows: [5, 21, 63, 126].map((lookback, i) => ({
      lookback,
      weight: 0.25,
      matching_days: days[i] ?? 0,
      mean: days[i] ? 500 : null,
      part: 0,
    })),
  };
}

function row(
  over: Partial<Record<RotationCriterion, RotationCriterionRow>> = {},
): RotationVariantRow {
  const criteria = {
    recent: { value: 9000, pct: 0.99, weight: 0.05, contribution: 0.0495 },
    weekday: fit(0.34, 0.94, [1, 4, 12, 23]),
    dte: fit(0.33, 0.9, [0, 4, 12, 22]),
    vix: fit(0.23, 0.9, [0, 0, 0, 2]),
    rfam: { value: 4000, pct: 0.8, weight: 0.05, contribution: 0.04, group: 'dir_B' },
    ...over,
  } as RotationVariantRow['criteria'];
  const composite = Object.values(criteria).reduce((s, c) => s + c.contribution, 0);
  return {
    variant: 'N_ditm1_1202',
    index: 'NIFTY',
    family: 'ditm1',
    kind: 'dir',
    slot: '12:02',
    role: 'core',
    rank: 1,
    pool_rank: 1,
    composite,
    criteria,
    family_band: 'dir_B',
  };
}

describe('stackSegments', () => {
  it('has one slice per weighted criterion whose widths add up to the composite', () => {
    const r = row();
    const segs = stackSegments(r);
    expect(segs.map((s) => s.key)).toEqual(['recent', 'weekday', 'dte', 'vix', 'rfam']);
    expect(segs.reduce((s, x) => s + x.widthPct, 0)).toBeCloseTo(r.composite * 100, 6);
  });

  it('leaves out a criterion the list gives no weight (REF has no family band)', () => {
    const r = row({ rfam: { value: 1, pct: 0.5, weight: 0, contribution: 0 } });
    expect(stackSegments(r).map((s) => s.key)).not.toContain('rfam');
  });
});

describe('dominantCriterion and whyLine', () => {
  it('names the criterion that put the most points in, and its share', () => {
    const d = dominantCriterion(row());
    expect(d?.key).toBe('weekday');
    expect(d?.share).toBeGreaterThan(0.3);
  });

  it('says how few days a fit rests on, and which other fits are thin', () => {
    const r = row({ weekday: fit(0.34, 0.99, [0, 0, 1, 2]) });
    const line = whyLine(r);
    expect(line).toContain('weekday fit');
    expect(line).toContain('only 2 matching days');
    expect(line).toContain('thin: VIX-band fit');
  });

  it('reads a well supported fit without a caveat', () => {
    const line = whyLine(row({ vix: fit(0.23, 0.5, [3, 6, 15, 30]) }));
    expect(line).toContain('23 matching days');
    expect(line).not.toContain('thin');
  });
});

describe('supportOf', () => {
  it('counts the longest window, and the windows that have a match', () => {
    const s = supportOf(fit(0.3, 0.5, [0, 2, 9, 11]));
    expect(s).toEqual({ days: 11, windowsWithDays: 3, windows: 4, thin: false });
  });
  it('is null for a criterion with no windows', () => {
    expect(supportOf({ value: 1, pct: 1, weight: 1, contribution: 1 })).toBeNull();
  });
});

describe('provenanceFlags', () => {
  const rec = (over: object = {}) => ({
    source: 'recorded' as const,
    matches: true,
    max_abs_diff: 0,
    picks_equal: true,
    overridden_equal: true,
    missing_in_rebuild: [],
    inputs_sha_recorded: 'a',
    inputs_sha_rebuilt: 'a',
    inputs_match: true,
    universe_match: true,
    ...over,
  });
  const prov = (over: object = {}) => ({
    source: 'recorded' as const,
    recorded_at: '2026-10-12T09:16:03+05:30',
    before_first_entry: true,
    ...over,
  });

  it('flags a research day as reconstructed with nothing to match', () => {
    const f = provenanceFlags({
      reconstruction: { ...rec(), source: 'reconstructed', matches: null, inputs_match: null },
      provenance: { source: 'reconstructed' },
    });
    expect(f.map((x) => x.label)).toEqual(['Reconstructed']);
  });

  it('says Recorded 09:16 and that the rebuild matches the entry', () => {
    const f = provenanceFlags({ reconstruction: rec(), provenance: prov() });
    expect(f.map((x) => x.label)).toEqual(['Recorded 09:16', 'Reconstructed, matches the entry']);
    expect(f.every((x) => x.tone === 'positive')).toBe(true);
  });

  it('warns when the inputs changed since recording, even if the picks still agree', () => {
    const f = provenanceFlags({ reconstruction: rec({ inputs_match: false }), provenance: prov() });
    expect(f[1]?.label).toBe('Reconstructed, inputs changed since recording');
    expect(f[1]?.tone).toBe('warning');
  });

  it('warns when the rebuild differs from the entry', () => {
    const f = provenanceFlags({
      reconstruction: rec({ matches: false, picks_equal: false }),
      provenance: prov(),
    });
    expect(f[1]?.id).toBe('changed');
  });

  it('marks a late entry as not forward', () => {
    const f = provenanceFlags({
      reconstruction: rec(),
      provenance: prov({ recorded_at: '2026-10-12T09:41:00+05:30', before_first_entry: false }),
    });
    expect(f[0]?.label).toBe('Recorded 09:41, late');
    expect(f[0]?.tone).toBe('warning');
    expect(f[0]?.detail).toContain('not a forward day');
  });
});

describe('boundaryLines', () => {
  // `rank` is the rank among every variant; `pool` the rank among the non-Buy pool (null for Buy)
  const v = (variant: string, rank: number, composite = 0.9, pool: number | null = rank) => ({
    variant,
    index: 'NIFTY',
    family: 'wide',
    kind: 'wide',
    slot: '09:17',
    rank,
    pool_rank: pool,
    composite,
  });
  const base: RotationBoundary = {
    n_core: 3,
    min_wide: 2,
    override: { fired: false, wide_in_unconstrained: 2, swaps: [] },
    unconstrained_core: [],
    weakest_pick: v('N_wide_0917', 3),
    best_excluded: { ...v('N_dir_1117', 4), gap: 0.0123, kept_out_by: null },
    nearest_excluded: [],
    buy: {
      top: 10,
      size: 1,
      qualified: false,
      picked: [],
      best_buy: null,
      tenth_composite: null,
      gap_to_top: null,
    },
  };

  it('says rank decided the core when no swap happened', () => {
    const lines = boundaryLines(base);
    expect(lines[0]?.text).toContain('Rank decided the core');
    expect(lines[1]?.text).toContain('0.012 below the weakest pick');
  });

  it('names what the Widesl minimum displaced and what replaced it', () => {
    const lines = boundaryLines({
      ...base,
      override: {
        fired: true,
        wide_in_unconstrained: 0,
        swaps: [{ dropped: v('N_dir_1202', 2), added: v('N_p100_0917', 27) }],
      },
      best_excluded: { ...v('N_dir_1202', 2), gap: -0.1375, kept_out_by: 'widesl_minimum' },
    });
    expect(lines[0]?.text).toContain('N_dir_1202 (rank 2) replaced by N_p100_0917 (rank 27)');
    expect(lines[0]?.text).toContain('the top 3 non-Buy held 0 Widesl');
    expect(lines[0]?.tone).toBe('warning');
    expect(lines[1]?.text).toContain('0.138 above the weakest pick');
  });

  it('quotes the rank among the non-Buy pool, the one the rule counts, not the overall rank', () => {
    // two Buy variants sit above these: overall rank 4 and 8 are pool rank 2 and 6
    const lines = boundaryLines({
      ...base,
      override: {
        fired: true,
        wide_in_unconstrained: 0,
        swaps: [{ dropped: v('S_ditm1_1447', 4, 0.9, 2), added: v('S_wide_1047', 8, 0.8, 6) }],
      },
      best_excluded: { ...v('S_dir_1047', 5, 0.91, 3), gap: -0.1, kept_out_by: 'widesl_minimum' },
    });
    expect(lines[0]?.text).toContain('S_ditm1_1447 (rank 2) replaced by S_wide_1047 (rank 6)');
    expect(lines[0]?.text).not.toContain('rank 4');
    expect(lines[1]?.text).toContain('S_dir_1047 (rank 3)');
  });

  it('quotes the overall rank in the Buy sentence, which counts every variant', () => {
    const line = boundaryLines({
      ...base,
      buy: { ...base.buy, best_buy: v('N_buy_1332', 19, 0.84, null), gap_to_top: 0.04 },
    }).at(-1);
    expect(line?.text).toContain('N_buy_1332 (rank 19 overall)');
  });

  it('explains why Buy did or did not qualify', () => {
    const no = boundaryLines({
      ...base,
      buy: { ...base.buy, best_buy: v('N_buy_1332', 19, 0.8444), gap_to_top: 0.0422 },
    });
    expect(no.at(-1)?.text).toContain('outside the overall top 10, 0.042 short');
    const yes = boundaryLines({
      ...base,
      buy: {
        ...base.buy,
        qualified: true,
        picked: [v('N_buy_1047', 4)],
        best_buy: v('N_buy_1047', 4),
      },
    });
    expect(yes.at(-1)?.text).toContain('Buy qualified: N_buy_1047 (rank 4 overall)');
  });
});

describe('day stepping', () => {
  const days = ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09'];
  it('snaps a typed day to the latest explainable day on or before it', () => {
    expect(snapDay(days, '2026-10-07')).toBe('2026-10-06');
    expect(snapDay(days, '2026-10-08')).toBe('2026-10-08');
    expect(snapDay(days, '2026-12-01')).toBe('2026-10-09');
    expect(snapDay(days, '2026-01-01')).toBe('2026-10-05');
    expect(snapDay([], '2026-10-07')).toBeNull();
  });
  it('steps through explainable days and stops at the ends', () => {
    expect(stepDay(days, '2026-10-06', 1)).toBe('2026-10-08');
    expect(stepDay(days, '2026-10-06', -1)).toBe('2026-10-05');
    expect(stepDay(days, '2026-10-05', -1)).toBe('2026-10-05');
    expect(stepDay(days, '2026-10-09', 1)).toBe('2026-10-09');
  });
});

function summary(over: Partial<RotationIcSummary> = {}): RotationIcSummary {
  return {
    n: 0,
    mean: null,
    sd: null,
    se: null,
    lo: null,
    hi: null,
    t: null,
    readable: false,
    pos: null,
    ...over,
  };
}

function icDay(
  day: string,
  composite: number | null,
  kind: RotationIcDay['kind'] = 'research',
): RotationIcDay {
  return {
    day,
    kind,
    composite,
    recent: null,
    weekday: null,
    dte: null,
    vix: null,
    rfam: null,
    n: 298,
    top: null,
    bottom: null,
    spread: null,
    matches_entry: null,
  };
}

describe('icVerdict', () => {
  it('has nothing to say with no days, and does not read a handful of days', () => {
    expect(icVerdict(summary())).toBe('No day to read yet.');
    // a band above zero on five days is a number, not a reading
    const short = summary({ n: 5, mean: 0.1, lo: 0.02, hi: 0.18, t: 2.776, readable: false });
    expect(icVerdict(short)).toContain('too short to read');
    expect(icVerdict(short)).not.toContain('above zero');
  });
  it('compares the band with zero once it can be read', () => {
    const read = { t: 2.0, readable: true };
    expect(icVerdict(summary({ n: 60, mean: 0.05, lo: -0.01, hi: 0.11, ...read }))).toContain(
      'includes zero',
    );
    expect(icVerdict(summary({ n: 60, mean: 0.05, lo: 0.01, hi: 0.09, ...read }))).toContain(
      'above zero',
    );
    expect(icVerdict(summary({ n: 60, mean: -0.05, lo: -0.09, hi: -0.01, ...read }))).toContain(
      'below zero',
    );
  });
  it('gives no emphasis to a band on too few days', () => {
    const early = summary({ n: 6, mean: 0.1, lo: 0.02, hi: 0.18, readable: false });
    expect(bandIncludesZero(early)).toBeNull();
    expect(bandIncludesZero({ ...early, n: 12, readable: true })).toBe(false);
  });
});

describe('icRows', () => {
  it('lists the criteria in the order of the research calibration with the reference beside them', () => {
    const ic = {
      summary: Object.fromEntries(
        ['recent', 'weekday', 'dte', 'vix', 'rfam', 'composite', 'spread'].map((k) => [
          k,
          summary({ n: 30, mean: 0.04, lo: -0.01, hi: 0.09, t: 2.045, readable: true }),
        ]),
      ),
      reference: {
        list: 'A',
        from: '2025-12-03',
        to: '2026-10-08',
        variants: 248,
        source: 'BL-081 step 1',
        values: { weekday: 0.036, dte: 0.028, vix: 0.041, recent: 0.062, composite: 0.048 },
      },
    } as unknown as RotationIc;
    const rows = icRows(ic);
    expect(rows.map((r) => r.key)).toEqual([
      'weekday',
      'dte',
      'vix',
      'recent',
      'rfam',
      'composite',
    ]);
    expect(rows.map((r) => r.reference)).toEqual([0.036, 0.028, 0.041, 0.062, null, 0.048]);
    expect(rows.every((r) => r.includesZero === true)).toBe(true);
  });
});

describe('icLayout', () => {
  const size = { width: 400, height: 200, left: 40, right: 10, top: 10, bottom: 20 };
  const days = [icDay('2026-10-05', 0.1), icDay('2026-10-06', -0.05), icDay('2026-10-07', null)];
  const running = [
    { day: '2026-10-05', n: 1, mean: 0.1, lo: null, hi: null },
    { day: '2026-10-06', n: 2, mean: 0.025, lo: -0.3, hi: 0.35 },
    { day: '2026-10-07', n: 2, mean: 0.025, lo: -0.3, hi: 0.35 },
  ];

  it('uses a symmetric domain in whole tenths that holds the bars and the band', () => {
    expect(icDomain(days, running)).toEqual({ min: -0.4, max: 0.4 });
    expect(icDomain([icDay('d', 0.01)], [])).toEqual({ min: -0.1, max: 0.1 });
  });

  it('draws positive bars above zero, negative below, and a missing day as no bar', () => {
    const l = icLayout(days, running, size);
    const [a, b, c] = l.bars;
    expect(a?.y).toBeLessThan(l.zeroY);
    expect(a?.y).toBeCloseTo(l.yFor(0.1));
    expect(b?.y).toBeCloseTo(l.zeroY);
    expect((b?.y ?? 0) + (b?.height ?? 0)).toBeCloseTo(l.yFor(-0.05));
    expect(c?.value).toBeNull();
    expect(c?.height).toBe(0);
  });

  it('has no band until two days carry one', () => {
    const l = icLayout(days, running, size);
    expect(l.line.split(' ')).toHaveLength(3);
    expect(l.band).not.toBe('');
    expect(icLayout([days[0] as RotationIcDay], running.slice(0, 1), size).band).toBe('');
  });

  it('finds the bar nearest the pointer', () => {
    const l = icLayout(days, running, size);
    const target = l.bars[1];
    expect(nearestBar(l, (target?.x ?? 0) + 1)?.day).toBe('2026-10-06');
  });

  it('puts a reference line only where it is inside the range', () => {
    const l = icLayout(days, running, size);
    expect(l.referenceY(0.048)).toBeCloseTo(l.yFor(0.048));
    expect(l.referenceY(0.9)).toBeNull();
    expect(l.referenceY(null)).toBeNull();
  });
});

describe('roleLabel and orderedRows', () => {
  const boundary = {
    override: {
      fired: true,
      wide_in_unconstrained: 0,
      swaps: [
        {
          dropped: {
            variant: 'N_dir_1202',
            index: 'NIFTY',
            family: 'dir',
            kind: 'dir',
            slot: '12:02',
            rank: 2,
            pool_rank: 2,
            composite: 0.93,
          },
          added: {
            variant: 'N_p100_0917',
            index: 'NIFTY',
            family: 'p100',
            kind: 'wide',
            slot: '09:17',
            rank: 27,
            pool_rank: 27,
            composite: 0.8,
          },
        },
      ],
    },
  };

  it('names a pick by its role, a displaced strategy as displaced, and the rest as nothing', () => {
    const base = row();
    expect(roleLabel({ ...base, role: 'core_override' }, boundary)).toBe('Swapped in');
    expect(roleLabel({ ...base, role: 'buy' }, boundary)).toBe('Buy');
    expect(roleLabel({ ...base, role: 'other', variant: 'N_dir_1202' }, boundary)).toBe(
      'Displaced',
    );
    expect(roleLabel({ ...base, role: 'other', variant: 'S_wide_0917' }, boundary)).toBe('—');
  });

  it('lists the picks first, in rank order, then the best of the rest', () => {
    const r = (
      variant: string,
      rank: number,
      role: RotationVariantRow['role'],
    ): RotationVariantRow => ({
      ...row(),
      variant,
      rank,
      role,
    });
    const rows = orderedRows(
      [r('p27', 27, 'core_override'), r('p1', 1, 'core'), r('buy4', 4, 'buy')],
      [r('t3', 3, 'other'), r('t2', 2, 'other')],
    );
    expect(rows.map((x) => x.variant)).toEqual(['p1', 'buy4', 'p27', 't2', 't3']);
  });
});

describe('a broken or unreadable journal', () => {
  const rec = {
    source: 'recorded' as const,
    matches: true,
    max_abs_diff: 0,
    picks_equal: true,
    overridden_equal: true,
    missing_in_rebuild: [],
    inputs_sha_recorded: 'a',
    inputs_sha_rebuilt: 'a',
    inputs_match: true,
    universe_match: true,
  };
  const prov = {
    source: 'recorded' as const,
    recorded_at: '2026-10-12T09:16:03+05:30',
    before_first_entry: true,
  };

  it('never gives the Recorded badge when the chain is broken', () => {
    const flags = provenanceFlags({
      reconstruction: rec,
      provenance: prov,
      chain: {
        intact: false,
        problems: ['entry 1 (2026-10-12): content does not match its hash'],
        error: null,
      },
    });
    expect(flags.map((f) => f.label)).toEqual(['Journal chain broken', 'Reconstructed']);
    expect(flags.some((f) => f.label.startsWith('Recorded'))).toBe(false);
    expect(flags[0]?.tone).toBe('warning');
  });

  it('says the journal is unreadable rather than silently showing a reconstruction', () => {
    const flags = provenanceFlags({
      reconstruction: { ...rec, source: 'reconstructed', matches: null },
      provenance: { source: 'reconstructed' },
      chain: {
        intact: false,
        problems: ['journal.jsonl line 3 is not valid JSON'],
        error: 'line 3',
      },
    });
    expect(flags.map((f) => f.label)).toEqual(['Journal unreadable', 'Reconstructed']);
  });

  it('keeps the plain flags when the chain holds', () => {
    const flags = provenanceFlags({
      reconstruction: rec,
      provenance: prov,
      chain: { intact: true, problems: [], error: null },
    });
    expect(flags.map((f) => f.label)).toEqual([
      'Recorded 09:16',
      'Reconstructed, matches the entry',
    ]);
  });
});

describe('recorded picks beside the rebuilt ones', () => {
  const r = (
    variant: string,
    rank: number,
    role: RotationVariantRow['role'],
  ): RotationVariantRow => ({
    ...row(),
    variant,
    rank,
    role,
  });
  const boundary = { override: { fired: false, wide_in_unconstrained: 2, swaps: [] } };

  it('puts the recorded picks first and does not list a variant twice', () => {
    const recorded = [
      {
        variant: 'rec1',
        role: 'core' as const,
        recorded_composite: 0.9,
        rebuilt_composite: 0.7,
        rebuilt_rank: 12,
        rebuilt_pool_rank: 10,
        rebuilt_pick: false,
        row: r('rec1', 12, 'recorded_core'),
      },
      {
        variant: 'both',
        role: 'core' as const,
        recorded_composite: 0.8,
        rebuilt_composite: 0.8,
        rebuilt_rank: 1,
        rebuilt_pool_rank: 1,
        rebuilt_pick: true,
        row: r('both', 1, 'recorded_core'),
      },
    ];
    const rows = orderedRows(
      [r('both', 1, 'core'), r('new1', 2, 'core')],
      [r('t3', 3, 'other')],
      recorded,
    );
    expect(rows.map((x) => [x.variant, x.role])).toEqual([
      ['both', 'recorded_core'],
      ['rec1', 'recorded_core'],
      ['new1', 'core'],
      ['t3', 'other'],
    ]);
  });

  it('labels the rebuilt picks as rebuilt when the entry differs, and the recorded ones as recorded', () => {
    expect(roleLabel(r('x', 1, 'core'), boundary, true)).toBe('Rebuilt core');
    expect(roleLabel(r('x', 1, 'core'), boundary, false)).toBe('Core');
    expect(roleLabel(r('x', 1, 'recorded_buy'), boundary, true)).toBe('Recorded Buy');
  });

  it('flags a recorded day whose rebuild does not match', () => {
    const base = { recorded_picks: [] };
    const recon = (matches: boolean | null, source: 'recorded' | 'reconstructed') => ({
      source,
      matches,
      max_abs_diff: 0.2,
      picks_equal: false,
      overridden_equal: true,
      missing_in_rebuild: [],
      inputs_sha_recorded: null,
      inputs_sha_rebuilt: 'x',
      inputs_match: null,
      universe_match: null,
    });
    expect(differsFromEntry({ ...base, reconstruction: recon(false, 'recorded') })).toBe(true);
    expect(differsFromEntry({ ...base, reconstruction: recon(true, 'recorded') })).toBe(false);
    expect(differsFromEntry({ ...base, reconstruction: recon(null, 'reconstructed') })).toBe(false);
  });
});
