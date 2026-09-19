const {
  normaliseLabel,
  isTotalRow,
  classifySegment,
  parseAmounts,
  splitBySegment,
} = require('../../brokers/segments');

describe('classifySegment()', () => {
  test('recognises F&O labels from both brokers', () => {
    for (const label of [
      'NSEFNO-NCL',
      'BSEFNO-ICCL',
      'NSE FNO - NCL',
      'BSE-FUTURES',
      'NSE-FUTURES',
      'NSE-OPTIONS',
      'NSE-DERIVATIVES',
    ]) {
      expect(classifySegment(label)).toBe('fno');
    }
  });

  test('recognises cash/equity labels', () => {
    for (const label of [
      // Regression: NSECAP-NCL is what Finvasia actually prints for the cash
      // segment. It was classified "unknown" and failed the whole note.
      'NSECAP-NCL',
      'BSECAP-ICCL',
      'NSECASH-NCL',
      'BSECASH-ICCL',
      'NSE-CASH',
      'NSE-CAPITAL',
      'BSE-EQUITY',
      'NSE-CM',
      'BSE-EQ',
    ]) {
      expect(classifySegment(label)).toBe('equity');
    }
  });

  test('recognises other non-equity-derivative segments', () => {
    for (const label of ['NSECUR-NCL', 'NSE-CDS', 'MCXCOM-MCXCCL', 'NCDEX-FUTURES']) {
      expect(classifySegment(label)).toBe('other');
    }
  });

  test('returns unknown for labels the pipeline has never seen', () => {
    expect(classifySegment('NSEWOMBAT-NCL')).toBe('unknown');
    expect(classifySegment('')).toBe('unknown');
    expect(classifySegment(null)).toBe('unknown');
  });
});

describe('isTotalRow()', () => {
  test('matches summary rows', () => {
    expect(isTotalRow('TOTAL(NET)')).toBe(true);
    expect(isTotalRow('Total')).toBe(true);
    expect(isTotalRow('GRAND TOTAL')).toBe(true);
  });

  test('does not match segment rows', () => {
    expect(isTotalRow('NSEFNO-NCL')).toBe(false);
    expect(isTotalRow('BSE-FUTURES')).toBe(false);
  });
});

describe('normaliseLabel()', () => {
  test('upper-cases and strips whitespace and dots', () => {
    expect(normaliseLabel(' nse fno - ncl ')).toBe('NSEFNO-NCL');
  });
});

describe('parseAmounts()', () => {
  test('parses signed amounts and strips thousands separators', () => {
    expect(parseAmounts('447.00 -10,015.11 0.00')).toEqual([447, -10015.11, 0]);
  });

  test('returns an empty array when there are no amounts', () => {
    expect(parseAmounts('no numbers here')).toEqual([]);
    expect(parseAmounts(null)).toEqual([]);
  });
});

describe('splitBySegment()', () => {
  const rows = [
    { label: 'TOTAL(NET)', amounts: [] },
    { label: 'NSECASH-NCL', amounts: [1] },
    { label: 'NSEFNO-NCL', amounts: [2] },
    { label: 'NSEWOMBAT-NCL', amounts: [3] },
  ];

  test('keeps F&O rows, drops known non-F&O rows, flags unknown ones', () => {
    const { kept, dropped, unknown } = splitBySegment(rows);
    expect(kept.map((r) => r.label)).toEqual(['NSEFNO-NCL']);
    expect(dropped).toEqual(['NSECASH-NCL (equity)']);
    expect(unknown).toEqual(['NSEWOMBAT-NCL']);
  });

  test('skips total rows without classifying them', () => {
    const { kept, dropped, unknown } = splitBySegment([{ label: 'TOTAL(NET)', amounts: [] }]);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
    expect(unknown).toEqual([]);
  });
});
