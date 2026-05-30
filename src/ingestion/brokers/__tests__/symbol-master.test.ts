/**
 * Unit tests for SymbolMaster.
 *
 * No real network or filesystem persistence outside the per-test tmp dir.
 * The fetch is mocked via dependency injection; the cache dir is a unique
 * tmpdir per test so runs don't pollute each other.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymbolMaster } from '../symbol-master';

// ---------------------------------------------------------------------------
// Fixture: a handful of real-shape rows. The columns we use are 8 (expiry
// epoch) and 9 (Fyers symbol); we pad the other positions so the row has the
// expected 21+ fields. Epochs are real Tuesdays/Thursdays in June 2026.
// ---------------------------------------------------------------------------

const NIFTY_JUN_02_EPOCH = Math.floor(new Date('2026-06-02T00:00:00Z').getTime() / 1000);
const NIFTY_JUN_09_EPOCH = Math.floor(new Date('2026-06-09T00:00:00Z').getTime() / 1000);
const SENSEX_JUN_04_EPOCH = Math.floor(new Date('2026-06-04T00:00:00Z').getTime() / 1000);

function makeRow(symbol: string, expiryEpoch: number): string {
  // 21 columns; we only populate the ones we read (8 = epoch, 9 = symbol).
  const cols = new Array(21).fill('');
  cols[8] = String(expiryEpoch);
  cols[9] = symbol;
  return cols.join(',');
}

const NSE_FIXTURE = [
  makeRow('NSE:NIFTY2660223550CE', NIFTY_JUN_02_EPOCH),
  makeRow('NSE:NIFTY2660223550PE', NIFTY_JUN_02_EPOCH),
  makeRow('NSE:NIFTY2660923500CE', NIFTY_JUN_09_EPOCH),
  // A FUT row should be ignored (does not end in CE/PE).
  makeRow('NSE:NIFTY26JUNFUT', NIFTY_JUN_02_EPOCH),
  // An unrecognised underlying (FINNIFTY) should be ignored.
  makeRow('NSE:FINNIFTY2660223000CE', NIFTY_JUN_02_EPOCH),
].join('\n');

const BSE_FIXTURE = [makeRow('BSE:SENSEX2660481000CE', SENSEX_JUN_04_EPOCH)].join('\n');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-master-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Build a SymbolMaster with an in-memory fetchFn over the two fixtures. */
function makeMaster(opts: { now?: number; maxAgeMs?: number } = {}): SymbolMaster {
  const fakeFetch = async (url: string) => {
    const body = url.includes('NSE_FO') ? NSE_FIXTURE : url.includes('BSE_FO') ? BSE_FIXTURE : '';
    return new Response(body, { status: 200 });
  };
  return new SymbolMaster({
    cacheDir: tmpDir,
    fetchFn: fakeFetch,
    now: () => opts.now ?? Date.now(),
    ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SymbolMaster — parsing', () => {
  it('isSymbolListed() returns true for parsed options and false for non-listed', async () => {
    const m = makeMaster();
    await m.load();
    expect(m.isSymbolListed('NSE:NIFTY2660223550CE')).toBe(true);
    expect(m.isSymbolListed('NSE:NIFTY2660223550PE')).toBe(true);
    expect(m.isSymbolListed('BSE:SENSEX2660481000CE')).toBe(true);
    // Thursday-encoded (the bug we just fixed) — must NOT be in master.
    expect(m.isSymbolListed('NSE:NIFTY2660423550CE')).toBe(false);
  });

  it('ignores futures and unrecognised underlyings', async () => {
    const m = makeMaster();
    await m.load();
    expect(m.isSymbolListed('NSE:NIFTY26JUNFUT')).toBe(false);
    expect(m.isSymbolListed('NSE:FINNIFTY2660223000CE')).toBe(false);
  });

  it('resolveCurrentExpiry returns the nearest expiry on or after the ref date', async () => {
    const m = makeMaster();
    await m.load();
    // refDate before any expiry → first one (Jun 02).
    const before = m.resolveCurrentExpiry('NIFTY', new Date('2026-05-30T00:00:00Z'));
    expect(before?.toISOString().slice(0, 10)).toBe('2026-06-02');
    // refDate ON the first expiry → that expiry.
    const onFirst = m.resolveCurrentExpiry('NIFTY', new Date('2026-06-02T00:00:00Z'));
    expect(onFirst?.toISOString().slice(0, 10)).toBe('2026-06-02');
    // refDate after first → second.
    const afterFirst = m.resolveCurrentExpiry('NIFTY', new Date('2026-06-03T00:00:00Z'));
    expect(afterFirst?.toISOString().slice(0, 10)).toBe('2026-06-09');
    // refDate after all → null.
    const afterAll = m.resolveCurrentExpiry('NIFTY', new Date('2027-01-01T00:00:00Z'));
    expect(afterAll).toBeNull();
    // Sensex resolves against the BSE master.
    const sensex = m.resolveCurrentExpiry('SENSEX', new Date('2026-06-01T00:00:00Z'));
    expect(sensex?.toISOString().slice(0, 10)).toBe('2026-06-04');
  });

  it('getListedExpiries returns the unique sorted expiry set per underlying', async () => {
    const m = makeMaster();
    await m.load();
    expect(m.getListedExpiries('NIFTY').map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-06-02',
      '2026-06-09',
    ]);
    expect(m.getListedExpiries('SENSEX').map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-06-04',
    ]);
    expect(m.getListedExpiries('BANKNIFTY')).toEqual([]);
  });
});

describe('SymbolMaster — cache freshness', () => {
  it('re-downloads only when the cached CSV is stale', async () => {
    let fetches = 0;
    const fakeFetch = async (url: string) => {
      fetches += 1;
      return new Response(url.includes('NSE_FO') ? NSE_FIXTURE : BSE_FIXTURE, { status: 200 });
    };
    // Freshness is mtime-based, so we must control the cache file's mtime to
    // get deterministic results — wall-clock mtime would race with the virtual
    // `now()` we inject below.
    const writtenAt = Date.parse('2026-05-30T00:00:00Z') / 1000;

    const m1 = new SymbolMaster({
      cacheDir: tmpDir,
      fetchFn: fakeFetch,
      maxAgeMs: 24 * 60 * 60 * 1000,
      now: () => Date.parse('2026-05-30T00:00:00Z'),
    });
    await m1.load();
    expect(fetches).toBe(2); // NSE + BSE
    for (const f of ['NSE_FO.csv', 'BSE_FO.csv']) {
      await fs.utimes(path.join(tmpDir, f), writtenAt, writtenAt);
    }

    // 1h after the cache's mtime — still fresh; no extra fetches.
    const m2 = new SymbolMaster({
      cacheDir: tmpDir,
      fetchFn: fakeFetch,
      maxAgeMs: 24 * 60 * 60 * 1000,
      now: () => Date.parse('2026-05-30T01:00:00Z'),
    });
    await m2.load();
    expect(fetches).toBe(2);

    // 25h after the cache's mtime — stale; both files re-downloaded.
    const m3 = new SymbolMaster({
      cacheDir: tmpDir,
      fetchFn: fakeFetch,
      maxAgeMs: 24 * 60 * 60 * 1000,
      now: () => Date.parse('2026-05-31T01:00:00Z'),
    });
    await m3.load();
    expect(fetches).toBe(4);
  });
});

describe('SymbolMaster — concurrent load dedup', () => {
  it('parallel load() calls share a single download', async () => {
    let fetches = 0;
    const fakeFetch = async (url: string) => {
      fetches += 1;
      // Tiny delay to widen the race window.
      await new Promise((r) => setTimeout(r, 5));
      return new Response(url.includes('NSE_FO') ? NSE_FIXTURE : BSE_FIXTURE, { status: 200 });
    };
    const m = new SymbolMaster({ cacheDir: tmpDir, fetchFn: fakeFetch });
    await Promise.all([m.load(), m.load(), m.load()]);
    expect(fetches).toBe(2); // only one download per exchange despite 3 callers
  });
});
