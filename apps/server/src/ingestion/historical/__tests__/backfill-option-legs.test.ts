/**
 * Unit tests for the option-leg backfill orchestrator.
 *
 * planLegs is a pure function (deeply tested for strike-band + expiry grouping).
 * backfillOptionLegs is tested with injected queryDailyOHLC + runBackfillFn so
 * no DB or network is touched.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Pool } from 'pg';

import { type DailyOHLC, backfillOptionLegs, planLegs } from '../backfill-option-legs';

// 2026 Tuesdays (NIFTY weekly expiry days).
const TUE_2026_04_07 = new Date('2026-04-07T00:00:00Z');

function ohlc(day: string, low: number, high: number): DailyOHLC {
  return { day: new Date(`${day}T00:00:00Z`), low, high };
}

// ---------------------------------------------------------------------------
// planLegs — pure planner
// ---------------------------------------------------------------------------

describe('planLegs', () => {
  it('builds CE+PE legs for the rounded strike band of one trading day', () => {
    // NIFTY @ 22,410..22,510 with interval 50 and bufferAbove/Below=0:
    // ATM(22410)=22400, ATM(22510)=22500. Band = [22400, 22450, 22500].
    const plans = planLegs(
      [ohlc('2026-04-06', 22410, 22510)], // Monday — Tuesday-04-07 expiry
      'NIFTY',
      new Date('2026-04-06T00:00:00Z'),
      new Date('2026-04-07T00:00:00Z'),
      0,
      0,
    );
    expect(plans).toHaveLength(6); // 3 strikes × 2 types
    expect(plans.map((p) => p.symbol)).toEqual([
      'NSE:NIFTY2640722400CE',
      'NSE:NIFTY2640722400PE',
      'NSE:NIFTY2640722450CE',
      'NSE:NIFTY2640722450PE',
      'NSE:NIFTY2640722500CE',
      'NSE:NIFTY2640722500PE',
    ]);
    for (const p of plans) {
      expect(p.expiry.toISOString().slice(0, 10)).toBe('2026-04-07');
    }
  });

  it('extends the band by bufferStrikesAbove / bufferStrikesBelow', () => {
    const plans = planLegs(
      [ohlc('2026-04-06', 22500, 22500)],
      'NIFTY',
      new Date('2026-04-06T00:00:00Z'),
      new Date('2026-04-07T00:00:00Z'),
      2, // above
      1, // below
    );
    // ATM = 22500. With buffer below=1, above=2: [22450, 22500, 22550, 22600]
    const strikes = [...new Set(plans.map((p) => p.strike))].sort((a, b) => a - b);
    expect(strikes).toEqual([22450, 22500, 22550, 22600]);
  });

  it('unions strikes across days that share the same expiry', () => {
    const plans = planLegs(
      [
        ohlc('2026-04-06', 22400, 22500), // Mon → expiry 04-07; strikes 22400..22500
        ohlc('2026-04-07', 22500, 22600), // Tue → expiry 04-07; strikes 22500..22600
      ],
      'NIFTY',
      new Date('2026-04-06T00:00:00Z'),
      new Date('2026-04-07T00:00:00Z'),
      0,
      0,
    );
    const strikes = [...new Set(plans.map((p) => p.strike))].sort((a, b) => a - b);
    expect(strikes).toEqual([22400, 22450, 22500, 22550, 22600]); // union, dedup
    for (const p of plans) {
      expect(p.expiry.getTime()).toBe(TUE_2026_04_07.getTime());
    }
  });

  it('groups days into the correct expiry weeks (NIFTY = Tuesday)', () => {
    const plans = planLegs(
      [
        ohlc('2026-04-06', 22500, 22500), // → expiry 04-07
        ohlc('2026-04-08', 22500, 22500), // Wed → next Tue = 04-14
      ],
      'NIFTY',
      new Date('2026-04-06T00:00:00Z'),
      new Date('2026-04-14T00:00:00Z'),
      0,
      0,
    );
    const expiries = [...new Set(plans.map((p) => p.expiry.toISOString().slice(0, 10)))].sort();
    expect(expiries).toEqual(['2026-04-07', '2026-04-14']);
  });

  it('sets each leg.from/to to its expiry-week, clipped to [runFrom, runTo]', () => {
    const plans = planLegs(
      [ohlc('2026-04-08', 22500, 22500)], // expiry 04-14, weekStart = 04-08
      'NIFTY',
      new Date('2026-04-10T00:00:00Z'), // runFrom is INSIDE the week → clips weekStart up
      new Date('2026-04-30T00:00:00Z'), // runTo is past expiry → expiry used
      0,
      0,
    );
    expect(plans[0]!.from.toISOString().slice(0, 10)).toBe('2026-04-10');
    expect(plans[0]!.to.toISOString().slice(0, 10)).toBe('2026-04-14');
  });

  it('uses the Sensex Thursday expiry rule (and BSE prefix)', () => {
    // 2026-04-08 (Wed) → next Thursday = 2026-04-09. Sensex interval = 100.
    const plans = planLegs(
      [ohlc('2026-04-08', 81000, 81000)],
      'SENSEX',
      new Date('2026-04-08T00:00:00Z'),
      new Date('2026-04-09T00:00:00Z'),
      0,
      0,
    );
    expect(plans.map((p) => p.symbol)).toEqual([
      'BSE:SENSEX2640981000CE',
      'BSE:SENSEX2640981000PE',
    ]);
  });
});

// ---------------------------------------------------------------------------
// backfillOptionLegs — orchestrator (with injected deps)
// ---------------------------------------------------------------------------

describe('backfillOptionLegs', () => {
  const fakePool = {} as Pool;

  it('throws when no intraday index data exists', async () => {
    await expect(
      backfillOptionLegs(fakePool, {
        underlying: 'NIFTY',
        from: new Date('2026-04-06T00:00:00Z'),
        to: new Date('2026-04-13T00:00:00Z'),
        resolution: '1',
        queryDailyOHLC: async () => [],
        runBackfillFn: async () => ({
          status: 'complete',
          rowsWritten: 0,
          totalRowsWritten: 0,
          gaps: [],
          rangeId: 0,
        }),
      }),
    ).rejects.toThrow(/no intraday index data/);
  });

  it('calls runBackfill once per planned leg and aggregates results', async () => {
    const calls: Array<{ symbol: string; from: string; to: string }> = [];

    const summary = await backfillOptionLegs(fakePool, {
      underlying: 'NIFTY',
      from: new Date('2026-04-06T00:00:00Z'),
      to: new Date('2026-04-14T00:00:00Z'),
      resolution: '1',
      bufferStrikesAbove: 0,
      bufferStrikesBelow: 0,
      queryDailyOHLC: async () => [
        ohlc('2026-04-06', 22500, 22500), // 1 strike → 2 legs
      ],
      runBackfillFn: async (_db, opts) => {
        calls.push({
          symbol: opts.symbol,
          from: opts.from.toISOString().slice(0, 10),
          to: opts.to.toISOString().slice(0, 10),
        });
        return {
          status: 'complete',
          rowsWritten: 375,
          totalRowsWritten: 375,
          gaps: [],
          rangeId: 1,
        };
      },
    });

    expect(calls).toEqual([
      { symbol: 'NSE:NIFTY2640722500CE', from: '2026-04-06', to: '2026-04-07' },
      { symbol: 'NSE:NIFTY2640722500PE', from: '2026-04-06', to: '2026-04-07' },
    ]);
    expect(summary.legsAttempted).toBe(2);
    expect(summary.legsCompleted).toBe(2);
    expect(summary.totalRowsWritten).toBe(750);
    expect(summary.expiriesProcessed).toBe(1);
    expect(summary.legsFailed).toEqual([]);
  });

  it('captures per-leg failures without aborting the rest of the run', async () => {
    const summary = await backfillOptionLegs(fakePool, {
      underlying: 'NIFTY',
      from: new Date('2026-04-06T00:00:00Z'),
      to: new Date('2026-04-14T00:00:00Z'),
      resolution: '1',
      bufferStrikesAbove: 0,
      bufferStrikesBelow: 0,
      queryDailyOHLC: async () => [ohlc('2026-04-06', 22450, 22550)], // 3 strikes
      runBackfillFn: vi
        .fn()
        // 1st leg OK
        .mockResolvedValueOnce({
          status: 'complete',
          rowsWritten: 100,
          totalRowsWritten: 100,
          gaps: [],
          rangeId: 1,
        })
        // 2nd leg throws an arbitrary non-resume error
        .mockRejectedValueOnce(new Error('Fyers history API error: invalid')) //
        // remaining legs OK
        .mockResolvedValue({
          status: 'gapped',
          rowsWritten: 50,
          totalRowsWritten: 50,
          gaps: [],
          rangeId: 2,
        }),
    });

    expect(summary.legsAttempted).toBe(6); // 3 strikes × 2 types
    expect(summary.legsCompleted).toBe(5);
    expect(summary.legsFailed).toEqual([
      { symbol: expect.any(String), error: 'Fyers history API error: invalid' },
    ]);
  });
});
