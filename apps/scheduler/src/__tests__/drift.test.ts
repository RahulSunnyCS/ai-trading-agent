import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { diskReaders } from '../checks/calendar.js';
import {
  FYERS_BSE_FO_URL,
  FYERS_NSE_FO_URL,
  type Fetcher,
  NIFTY50_LIVE_URL,
  checkExpiryCalendar,
  checkLotSizes,
  checkNifty50,
  expectedExpiries,
  jobs,
  liveSymbols,
  masterOptions,
  modalStep,
  openMembers,
} from '../checks/drift.js';

const fo = (nifty: number, bank: number) =>
  [
    `1,NIFTY 27 Oct 26 FUT,11,${nifty},0.2,,x,d,1,NSE:NIFTY26OCTFUT,10,11,1,NIFTY,26000`,
    `2,NIFTY 27 Oct 26 25000 CE,14,${nifty},0.05,,x,d,1,NSE:NIFTY2610625000CE,10,11,2,NIFTY,26000`,
    `3,BANKNIFTY 27 Oct 26 FUT,11,${bank},0.2,,x,d,1,NSE:BANKNIFTY26OCTFUT,10,11,3,BANKNIFTY,26009`,
    '4,RELIANCE 27 Oct 26 FUT,11,500,0.05,,x,d,1,NSE:RELIANCE26OCTFUT,10,11,4,RELIANCE,2885',
  ].join('\n');

const asOf = new Date('2026-10-08T00:00:00Z');
const serve =
  (map: Record<string, string>): Fetcher =>
  async (url) => {
    const body = map[url];
    if (body === undefined) throw new Error('unexpected url');
    return body;
  };
const unreachable: Fetcher = async () => {
  throw new Error('ENOTFOUND');
};

describe('lot-size check', () => {
  it('is ok when the master agrees', async () => {
    const r = await checkLotSizes(serve({ [FYERS_NSE_FO_URL]: fo(65, 30) }), asOf);
    expect(r.ok).toBe(true);
  });
  it('flags a changed lot size', async () => {
    const r = await checkLotSizes(serve({ [FYERS_NSE_FO_URL]: fo(75, 30) }), asOf);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('NIFTY: lot_sizes.csv 65, Fyers 75');
  });
  it('treats a network error as unreachable, not as drift', async () => {
    const r = await checkLotSizes(unreachable, asOf);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('could not reach the Fyers symbol master');
  });
  it('flags a master with no NIFTY rows', async () => {
    const r = await checkLotSizes(serve({ [FYERS_NSE_FO_URL]: 'junk,row' }), asOf);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('no NIFTY rows');
  });
});

const symbols = Array.from({ length: 50 }, (_, i) => `S${i}`);
const liveCsv = (syms: string[]) =>
  `Company Name,Industry,Symbol,Series,ISIN Code\r\n${syms.map((s) => `Co ${s},X,${s},EQ,INE${s}`).join('\r\n')}\r\n`;
const fileCsv = (open: string[]) =>
  [
    'company_id,symbol,from,to,kind,source,source2',
    'C1,OLD,2011-01-03,2020-01-01,investable,"a, b",',
    ...open.map((s) => `C9,${s},2011-01-03,,investable,"x, y",z`),
  ].join('\n');

describe('nifty 50 membership check', () => {
  it('parses open rows only and the live Symbol column', () => {
    expect(openMembers(fileCsv(['A', 'B']))).toEqual(['A', 'B']);
    expect(liveSymbols(liveCsv(['A', 'B']))).toEqual(['A', 'B']);
  });
  it('is ok when the lists match', async () => {
    const r = await checkNifty50(serve({ [NIFTY50_LIVE_URL]: liveCsv(symbols) }), () =>
      fileCsv(symbols),
    );
    expect(r.ok).toBe(true);
  });
  it('names added and removed symbols', async () => {
    const live = [...symbols.slice(1), 'BSE'];
    const r = await checkNifty50(serve({ [NIFTY50_LIVE_URL]: liveCsv(live) }), () =>
      fileCsv(symbols),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not the file: BSE');
    expect(r.detail).toContain('not the live index: S0');
  });
  it('treats a network error as unreachable', async () => {
    const r = await checkNifty50(unreachable, () => fileCsv(symbols));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('could not reach niftyindices.com');
  });
  it('does not trust a truncated list', async () => {
    const r = await checkNifty50(serve({ [NIFTY50_LIVE_URL]: liveCsv(['A']) }), () =>
      fileCsv(symbols),
    );
    expect(r.ok).toBe(false);
  });
});

// Y4. Rows shaped like the Fyers master: expiry epoch in column 8, underlying 13, strike 15,
// option type 16. Expiries are 15:30 IST; holidays below make 2026-11-10 and 2026-11-24 shift.
const epoch = (day: string) => Date.parse(`${day}T10:00:00Z`) / 1000;
const opt = (u: string, day: string, strike: number, type = 'CE') =>
  `1,${u} x,14,65,0.05,,x,d,${epoch(day)},NSE:${u}X,10,11,1,${u},26000,${strike},${type},x`;
const chain = (u: string, day: string, step: number, n = 6, from = 25000) =>
  Array.from({ length: n }, (_, i) => opt(u, day, from + i * step)).join('\n');
const readers = (
  calendar: string,
  steps = 'underlying,step,effective_date\nNIFTY,50,2018-01-01\n',
) => ({
  readFile: (p: string) => {
    if (p.endsWith('holidays.csv')) {
      return 'date,description\n2026-11-10,"Diwali"\n2026-11-24,"Gurpurb"\n2026-12-25,"Christmas"\n';
    }
    if (p.endsWith('expiry_calendar.csv'))
      return `underlying,cadence,weekday,effective_date\n${calendar}`;
    if (p.endsWith('strike_step.csv')) return steps;
    throw new Error(`no ${p}`);
  },
  listDir: () => [],
});
const masters = (nse: string, bse = '') =>
  serve({ [FYERS_NSE_FO_URL]: nse, [FYERS_BSE_FO_URL]: bse });
// What NSE listed on 2026-10-28: Tuesdays, with 9 and 23 Nov moved to Monday by a holiday.
const niftyWeeklies = ['2026-11-03', '2026-11-09', '2026-11-17', '2026-11-23', '2026-12-01']
  .map((d) => chain('NIFTY', d, 50))
  .join('\n');
const today = '2026-10-28';

describe('expiry calendar check (Y4)', () => {
  it('passes when the listings follow the rule, holiday shifts included', async () => {
    const r = await checkExpiryCalendar(
      masters(niftyWeeklies),
      today,
      readers('NIFTY,WEEKLY,1,2018-01-01\n'),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('NIFTY 50');
  });

  it('flags an expiry weekday change', async () => {
    const thursdays = ['2026-10-29', '2026-11-05', '2026-11-12']
      .map((d) => chain('NIFTY', d, 50))
      .join('\n');
    const r = await checkExpiryCalendar(
      masters(thursdays),
      today,
      readers('NIFTY,WEEKLY,1,2018-01-01\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('off the WEEKLY weekday-1 rule: 2026-10-29');
    expect(r.detail).toContain('not listed: 2026-11-03, 2026-11-09, 2026-11-17');
  });

  it('honours a future rule row from its effective date', async () => {
    const r = await checkExpiryCalendar(
      masters(niftyWeeklies),
      today,
      readers('NIFTY,WEEKLY,1,2018-01-01\nNIFTY,WEEKLY,3,2026-11-15\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('2026-11-17');
    expect(r.detail).not.toContain('2026-11-03');
  });

  it('flags weeklies listed for a MONTHLY_LAST index, and checks the monthly', async () => {
    const bank = ['2026-11-03', '2026-11-23'].map((d) => chain('BANKNIFTY', d, 100)).join('\n');
    const r = await checkExpiryCalendar(
      masters(bank),
      today,
      readers('BANKNIFTY,MONTHLY_LAST,1,2018-01-01\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('off the MONTHLY_LAST weekday-1 rule: 2026-11-03');
    const ok = await checkExpiryCalendar(
      masters(chain('BANKNIFTY', '2026-11-23', 100)),
      today,
      readers('BANKNIFTY,MONTHLY_LAST,1,2018-01-01\n'),
    );
    expect(ok.ok).toBe(true);
  });

  it('reads SENSEX from the BSE master', async () => {
    const sensex = ['2026-10-29', '2026-11-05', '2026-11-12']
      .map((d) => chain('SENSEX', d, 100))
      .join('\n');
    const r = await checkExpiryCalendar(
      masters(niftyWeeklies, sensex),
      today,
      readers('NIFTY,WEEKLY,1,2018-01-01\nSENSEX,WEEKLY,3,2018-01-01\n'),
    );
    expect(r.ok).toBe(true);
  });

  it('does not judge years the holiday list does not cover', async () => {
    // 2027-01-25 is a Monday (26 Jan is a holiday) but holidays.csv has no 2027 rows yet.
    const r = await checkExpiryCalendar(
      masters(`${niftyWeeklies}\n${chain('NIFTY', '2027-01-25', 50)}`),
      today,
      readers('NIFTY,WEEKLY,1,2018-01-01\n'),
    );
    expect(r.ok).toBe(true);
  });

  it('flags an index with no options and a changed strike step', async () => {
    const r = await checkExpiryCalendar(
      masters(
        ['2026-11-03', '2026-11-09', '2026-11-17'].map((d) => chain('NIFTY', d, 100)).join('\n'),
      ),
      today,
      readers('NIFTY,WEEKLY,1,2018-01-01\nSENSEX,WEEKLY,3,2018-01-01\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('SENSEX: no options');
    expect(r.detail).toContain('NIFTY: strike_step.csv 50, listed strikes 100 apart');
  });

  it('treats a network error as unreachable', async () => {
    const r = await checkExpiryCalendar(unreachable, today, readers('NIFTY,WEEKLY,1,2018-01-01\n'));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('could not reach the Fyers symbol master');
  });

  it('ignores futures rows and takes the commonest strike gap', () => {
    const csv = `1,NIFTY FUT,11,65,0.1,,x,d,${epoch('2026-11-24')},NSE:NIFTYFUT,10,11,1,NIFTY,26000,-1.0,XX\n${chain('NIFTY', '2026-11-03', 50)}`;
    expect([...(masterOptions(csv).get('NIFTY')?.keys() ?? [])]).toEqual(['2026-11-03']);
    expect(modalStep([100, 125, 150, 175, 200, 300, 400])).toBe(25);
  });

  it('expects three weeklies or one monthly', () => {
    const covered = () => true;
    const holidays = new Set(['2026-11-10']);
    const weekly = { underlying: 'NIFTY', cadence: 'WEEKLY', weekday: 1, effective: '2018-01-01' };
    expect(expectedExpiries(weekly, today, holidays, covered)).toEqual([
      '2026-11-03',
      '2026-11-09',
      '2026-11-17',
    ]);
    const monthly = { ...weekly, cadence: 'MONTHLY_LAST' };
    // October's last Tuesday (27th) is past, so November's.
    expect(expectedExpiries(monthly, today, holidays, covered)).toEqual(['2026-11-24']);
    expect(expectedExpiries(monthly, '2026-10-26', holidays, covered)).toEqual(['2026-10-27']);
  });

  it('passes on the real reference CSVs', async () => {
    const real = diskReaders(resolve(import.meta.dirname, '../../../..'));
    const r = await checkExpiryCalendar(masters(niftyWeeklies), today, {
      ...real,
      // Only NIFTY is listed in this fake master.
      readFile: (p) =>
        p.endsWith('expiry_calendar.csv')
          ? real
              .readFile(p)
              .split('\n')
              .filter((l) => !/^(SENSEX|BANKNIFTY),/.test(l))
              .join('\n')
          : real.readFile(p),
    });
    expect(r.ok).toBe(true);
  });
});

describe('drift jobs', () => {
  it('retry network failures twice, 30 minutes apart', () => {
    expect(jobs.length).toBe(3);
    for (const j of jobs) {
      expect(j.retries).toBe(2);
      expect(j.retryDelayMinutes).toBe(30);
    }
  });
});
