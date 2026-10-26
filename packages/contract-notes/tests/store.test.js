const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readCursors,
  readDay,
  readStatus,
  saveRaw,
  storeRoot,
  writeCursors,
  writeLine,
} = require('../store');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-store-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('storeRoot()', () => {
  test('is TRADING_DATA_ROOT/contract-notes', () => {
    expect(storeRoot({ TRADING_DATA_ROOT: dir })).toBe(
      path.join(fs.realpathSync(dir), 'contract-notes'),
    );
  });

  test('refuses a root on a /Volumes disk that is not mounted', () => {
    expect(() => storeRoot({ TRADING_DATA_ROOT: '/Volumes/NoSuchDisk-bl168/TradingData' })).toThrow(
      /not mounted/,
    );
  });
});

describe('day lines', () => {
  const line = (account, status) => ({ day: '2026-10-23', broker: 'finvasia', account, status });

  test('a missing day reads as no lines', () => {
    expect(readDay(dir, '2026-10-23')).toEqual([]);
  });

  test('one line per account; writing again replaces it', () => {
    writeLine(dir, line('B', 'note'));
    writeLine(dir, line('A', 'no_trade'));
    writeLine(dir, line('A', 'note'));
    expect(readDay(dir, '2026-10-23').map((l) => [l.account, l.status])).toEqual([
      ['A', 'note'],
      ['B', 'note'],
    ]);
    expect(fs.readdirSync(path.join(dir, 'days'))).toEqual(['2026-10-23.jsonl']); // no temp file left
  });

  test('readStatus keys lines by day and account', () => {
    writeLine(dir, line('A', 'note'));
    expect(readStatus(dir, ['2026-10-23']).get('2026-10-23|finvasia/A').status).toBe('note');
  });
});

describe('raw notes and the bookmark', () => {
  test('saveRaw keeps the PDF and returns its hash', () => {
    const { file, sha256 } = saveRaw(dir, 'finvasia', 'A', '2026-10-23', Buffer.from('pdf'));
    expect(fs.readFileSync(file, 'utf8')).toBe('pdf');
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('cursors round-trip, and none is an empty map', () => {
    expect(readCursors(dir)).toEqual({});
    writeCursors(dir, { 'm|finvasia/A': { uidvalidity: '1', last_uid: 42, checked_at: 't' } });
    expect(readCursors(dir)['m|finvasia/A'].last_uid).toBe(42);
  });
});
