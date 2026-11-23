import { describe, expect, it } from 'vitest';

import type { CommodityForward, CommodityRoot, ForwardEntry } from '../../types/commodity';
import {
  COMMODITY_SECTIONS,
  COMMODITY_SECTION_META,
  SWEEP_FINALISTS,
  cumulativeLines,
  expiryText,
  medianHalfSpreadPct,
  passRuleLines,
  staleWeekdays,
} from '../commodityView';

const entry = (day: string, net: number): ForwardEntry => ({
  day,
  expiry: '2026-11-27',
  k: 4,
  season: 'winter',
  gross: net + 10,
  charges: 10,
  net,
  'net_0.5pct': net + 5,
  net_0pct: net + 10,
  stopped_by: null,
  future_at_18: 124487,
  recorded_at: '2026-11-24T01:30:27+05:30',
  trades: [],
  notes: [],
});

const root = (over: Partial<CommodityRoot>): CommodityRoot => ({
  root: 'GOLDM',
  name: 'Gold mini',
  point_value: 10,
  nearest_expiry: '2026-11-27',
  future: 'MCX:GOLDM26DECFUT',
  weekdays_to_expiry: 3,
  upcoming: [],
  calendar_ends: '2027-01-29',
  days_collected: 541,
  first_day: '2024-10-21',
  last_day: '2026-11-23',
  days_last_30: 22,
  ...over,
});

describe('sections', () => {
  it('has a meta entry for every section', () => {
    for (const s of COMMODITY_SECTIONS) expect(COMMODITY_SECTION_META[s].question).toBeTruthy();
  });
});

describe('the recorded sweep verdict', () => {
  it('has exactly one finalist that broke no rule', () => {
    expect(SWEEP_FINALISTS.filter((f) => f.failed.length === 0).map((f) => f.name)).toEqual([
      'GOLDM Dir · expiry week',
    ]);
  });
});

describe('cumulativeLines', () => {
  it('runs the totals in order at each slippage', () => {
    const lines = cumulativeLines([entry('2026-11-23', 100), entry('2026-11-24', -30)]);
    const [main, half, none] = lines as [
      (typeof lines)[number],
      (typeof lines)[number],
      (typeof lines)[number],
    ];
    expect(main.points.map((p) => p.value)).toEqual([100, 70]);
    expect(half.points.map((p) => p.value)).toEqual([105, 80]);
    expect(none.points.map((p) => p.value)).toEqual([110, 90]);
  });
});

describe('passRuleLines', () => {
  const base = {
    pass_rule: { expiries: 6, expiries_up: 4, slippage_pct: 1 },
    summary: { sessions: 1, expiries: 1, expiries_up: 1, net: 90, pass_rule_met: false },
  } as unknown as CommodityForward;
  it('says it is not decided before the sixth expiry', () => {
    const lines = passRuleLines(base);
    expect(lines[0]).toContain('1 session scored across 1 of 6');
    expect(lines.at(-1)).toContain('Not decided yet');
  });
});

describe('medianHalfSpreadPct', () => {
  it('is null with no snapshot and half the median full spread otherwise', () => {
    expect(medianHalfSpreadPct([])).toBeNull();
    const snap = (a: number, b: number) => ({
      day: 'd',
      contracts: {
        ITM1_CE: { symbol: 'x', bid: 1, ask: 2, lp: 1, spread_pct_of_mid: a },
        ITM1_PE: { symbol: 'y', bid: 1, ask: 2, lp: 1, spread_pct_of_mid: b },
      },
    });
    expect(medianHalfSpreadPct([snap(2, 4), snap(6, 8)])).toBe(2.5);
  });
});

describe('overview helpers', () => {
  it('words the expiry, or where a calendar ends', () => {
    expect(expiryText(root({}))).toContain('3 weekdays');
    expect(expiryText(root({ nearest_expiry: null, calendar_ends: '2026-10-28' }))).toContain(
      'Calendar ends',
    );
  });
  it('counts weekdays since the last collected day', () => {
    expect(staleWeekdays(root({}), '2026-11-24')).toBe(1);
    expect(staleWeekdays(root({ last_day: '2026-11-20' }), '2026-11-24')).toBe(2);
    expect(staleWeekdays(root({ last_day: null }), '2026-11-24')).toBeNull();
  });
});
