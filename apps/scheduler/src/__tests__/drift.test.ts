import { describe, expect, it } from 'bun:test';
import {
  FYERS_NSE_FO_URL,
  type Fetcher,
  NIFTY50_LIVE_URL,
  checkLotSizes,
  checkNifty50,
  jobs,
  liveSymbols,
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

describe('drift jobs', () => {
  it('retry network failures twice, 30 minutes apart', () => {
    expect(jobs.length).toBe(2);
    for (const j of jobs) {
      expect(j.retries).toBe(2);
      expect(j.retryDelayMinutes).toBe(30);
    }
  });
});
