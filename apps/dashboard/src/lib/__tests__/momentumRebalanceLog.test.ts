import { describe, expect, it } from 'vitest';

import type { RebalanceBlock } from '../../types/tradeBook';
import {
  foldedLine,
  holdingLine,
  kiteCheckLine,
  lineNote,
  rebalanceStatusLabel,
  rebalanceTitle,
} from '../momentumRebalanceLog';

const BLOCK: RebalanceBlock = {
  week: '2026-10-30',
  week_no: 3,
  lot: 'Lot 3',
  sleeve_id: 's',
  new_lot: true,
  status: 'not done',
  notes_final: true,
  first_trade_day: null,
  orders_at: null,
  lines: [],
  bought: 0,
  sold: 0,
  charges: null,
  holding_after: [],
  folded_into: { week: '2026-11-27', week_no: 7, scheduled: true },
};

describe('momentumRebalanceLog', () => {
  it('titles a block by week number, Friday and lot', () => {
    expect(rebalanceTitle(BLOCK)).toBe('Week 3 · Fri 30 Oct · Lot 3');
    expect(rebalanceStatusLabel('done')).toBe('Rebalance done');
  });

  it("says where a missed week went: the lot's next turn, scheduled or already stored", () => {
    expect(foldedLine(BLOCK)).toBe(
      "Folded into Lot 3's next turn, week 7 (Fri 27 Nov): it rebalances in full then.",
    );
    expect(
      foldedLine({ ...BLOCK, folded_into: { week: '2026-11-27', week_no: 7, scheduled: false } }),
    ).toBe('Folded into week 7 (Fri 27 Nov), when Lot 3 rebalanced in full.');
    expect(foldedLine({ ...BLOCK, folded_into: null })).toBeNull();
  });

  it('notes a line that is not a plain trade', () => {
    const line = { symbol: 'X', side: 'buy' as const, shares: null, value: 1, planned_shares: 21 };
    expect(lineNote({ ...line, status: 'missed' })).toBe('not traded (21 planned)');
    expect(lineNote({ ...line, shares: 20, status: 'shares differ' })).toBe('21 planned');
    expect(lineNote({ ...line, shares: 1, status: 'extra' })).toBe('not in the orders');
    expect(lineNote({ ...line, shares: 21, status: 'done' })).toBeNull();
  });

  it('lists the holding after, or says nothing is held', () => {
    expect(holdingLine(BLOCK)).toBe('nothing');
    expect(
      holdingLine({
        ...BLOCK,
        holding_after: [
          { symbol: 'NAZARA', shares: 33 },
          { symbol: 'CUPID', shares: 42 },
        ],
      }),
    ).toBe('NAZARA 33 · CUPID 42');
  });

  it('says whether Kite holds what the lots hold', () => {
    expect(kiteCheckLine(null)).toBeNull();
    const check = {
      synced_at: '2026-11-02T22:17:12+05:30',
      cash: 50429,
      matches: false,
      differences: [{ symbol: 'GRWRHITECH', kite: 3, lots: 2 }],
    };
    expect(kiteCheckLine(check)).toMatch(/differs from the lots: GRWRHITECH Kite 3, lots 2/);
    expect(kiteCheckLine({ ...check, matches: true, differences: [] })).toMatch(
      /holds exactly what the lots hold · free cash ₹50,429\.$/,
    );
  });
});
