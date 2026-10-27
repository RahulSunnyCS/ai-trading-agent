const {
  angelFills,
  angelTrades,
  chooseTrades,
  finvasiaFills,
  finvasiaTrades,
} = require('../../brokers/fnoTrades');

// Rows in each broker's layout; every number, contract and time is invented.

test('Finvasia summary row', () => {
  const { trades, bad } = finvasiaTrades(
    'FNO OPTIDX NIFTY 27OCT2026 22400.00 PEB 50.00 0.00 10.00 0.1000 10.10 0.00-505.00',
  );
  expect(bad).toEqual([]);
  expect(trades).toEqual([
    expect.objectContaining({
      underlying: 'NIFTY',
      expiry: '2026-10-27',
      strike: 22400,
      kind: 'PE',
      side: 'buy',
      qty: 50,
      wap: 10,
      net_total: -505,
    }),
  ]);
});

test('Finvasia annexure fill, with its times', () => {
  const text = [
    '1000000000000001234567B',
    ' 50 10.0000 0.1000 10.1000-505.00OPTIDX NIFTY 27OCT2026 22400.00 PE',
    '09:20:0009:20:01',
  ].join('\n');
  expect(finvasiaFills(text).trades).toEqual([
    expect.objectContaining({ side: 'buy', qty: 50, price: 10, net_total: -505, time: '09:20:01' }),
  ]);
});

test('Angel One summary row: quantity and price split where they multiply to the total', () => {
  const { trades } = angelTrades(
    'OPTIDX NIFTY Oct 27 2026 22400.00  PE(BT)SELL5020.000.000020.000.001000.00',
  );
  expect(trades[0]).toMatchObject({
    side: 'sell',
    qty: 50,
    wap: 20,
    net_total: 1000,
    strike: 22400,
  });
});

test('Angel One summary row: a WAP rounded to 2 decimals still splits (several fills)', () => {
  // 75 sold at a true average of 40.0667 prints as 40.07; 75 × 40.07 misses 3005.00 by ₹0.25.
  const { trades, bad } = angelTrades(
    'OPTIDX NIFTY Oct 27 2026 22400.00  PE(BT)SELL7540.070.000040.070.003005.00',
  );
  expect(bad).toEqual([]);
  expect(trades[0]).toMatchObject({ qty: 75, wap: 40.07, net_total: 3005 });
});

test('Angel One summary row: a split giving a rate with a leading 0 is never taken', () => {
  // "75" + "0.50" and "750" + ".50" would both be read without the rule; only 750 × 0.50 = 375.
  const { trades } = angelTrades(
    'OPTIDX NIFTY Oct 27 2026 22400.00  PE(BT)SELL7500.500.00000.500.00375.00',
  );
  expect(trades[0]).toMatchObject({ qty: 750, wap: 0.5 });
});

test('Angel One annexure fill: a buy is paid even though printed unsigned', () => {
  const text = [
    '100000000000000109:30:00123456709:30:00',
    'OPTIDX NIFTY Oct 27 2026',
    '22400.00 PE (BT)',
    'BUY5020.00000.000020.00000.00001000.0000',
  ].join('\n');
  expect(angelFills(text).trades).toEqual([
    expect.objectContaining({
      side: 'buy',
      qty: 50,
      price: 20,
      net_total: -1000,
      time: '09:30:00',
    }),
  ]);
});

test('chooseTrades prefers fills that add up, then the summary, else marks unmatched', () => {
  const fill = [
    '1000000000000001234567S',
    ' 50 10.0000 0.0000 10.0000 500.00OPTIDX NIFTY 27OCT2026 22400.00 PE',
    '09:20:0009:20:01',
  ].join('\n');
  expect(chooseTrades(fill, 'finvasia', 500).trades_check).toBe('fills');
  expect(chooseTrades(fill, 'finvasia', 999).trades_check).toBe('unmatched');
  const summary =
    'FNO OPTIDX NIFTY 27OCT2026 22400.00 PES 50.00 0.00 10.00 0.0000 10.00 0.00 500.00';
  expect(chooseTrades(summary, 'finvasia', 500).trades_check).toBe('summary');
});
