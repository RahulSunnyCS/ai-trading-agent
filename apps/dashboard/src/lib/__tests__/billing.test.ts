import { describe, expect, it } from 'vitest';

import {
  CREDIT_UNIT,
  RECOMMENDED_PLAN_ID,
  accessUntil,
  formatPlanPrice,
  orderErrorMessage,
  planCredits,
  planInclusions,
  pricePerCredit,
  purchaseMessage,
  regionGate,
} from '../billing';

describe('formatPlanPrice', () => {
  it('shows whole rupees without decimals, with ₹ and en-IN grouping', () => {
    expect(formatPlanPrice(99_900)).toBe('₹999');
    expect(formatPlanPrice(14_99_900)).toBe('₹14,999');
    expect(formatPlanPrice(1_00_00_000)).toBe('₹1,00,000');
  });

  it('keeps paise when the price has them', () => {
    expect(formatPlanPrice(99_950)).toBe('₹999.50');
    expect(formatPlanPrice(99_901)).toBe('₹999.01');
  });
});

describe('plans', () => {
  it('reads the credits a pack adds from its id', () => {
    expect(planCredits('credits_50')).toBe(50);
    expect(planCredits('credits_200')).toBe(200);
    expect(planCredits('monthly_pass')).toBeNull();
    expect(planCredits('credits_0')).toBeNull();
    expect(planCredits('credits_')).toBeNull();
  });

  it('prices a credit within a pack', () => {
    expect(pricePerCredit({ id: 'credits_50', pricePaise: 49_900 })).toBe('₹9.98 per credit');
    expect(pricePerCredit({ id: 'monthly_pass', pricePaise: 99_900 })).toBeNull();
  });

  it('lists what each plan includes', () => {
    const pass = planInclusions({ id: 'monthly_pass', pricePaise: 99_900 });
    expect(pass[0]).toContain('30 days');
    expect(pass.join(' ')).toContain('still use credits');
    const pack = planInclusions({ id: 'credits_200', pricePaise: 1_49_900 });
    expect(pack).toContain('200 credits added to your balance');
    expect(pack).toContain(CREDIT_UNIT);
    expect(planInclusions({ id: 'mystery', pricePaise: 1 })).toEqual([]);
  });

  it('recommends the monthly pass', () => {
    expect(RECOMMENDED_PLAN_ID).toBe('monthly_pass');
  });
});

describe('regionGate', () => {
  it.each([
    ['IN', 'india'],
    ['in', 'india'],
    ['US', 'outside'],
    [null, 'unknown'],
    ['', 'unknown'],
  ] as const)('%s -> %s', (region, gate) => {
    expect(regionGate(region)).toBe(gate);
  });
});

describe('messages', () => {
  it('explains create-order failures', () => {
    expect(orderErrorMessage('payment_disabled')).toContain('switched off');
    expect(orderErrorMessage('invalid_plan')).toContain('no longer offered');
    expect(orderErrorMessage('boom')).toContain('(boom)');
  });

  it('puts the order id in the success message', () => {
    expect(purchaseMessage('50 Credits Pack', 'order_ABC123')).toBe(
      'Payment verified: 50 Credits Pack. Order order_ABC123',
    );
  });

  it('formats an access expiry as an IST date, or nothing', () => {
    // 18:30 UTC is already the next day in IST.
    expect(accessUntil('2026-11-03T18:30:00.000Z')).toBe('Active until 04 Nov 2026');
    expect(accessUntil(null)).toBeNull();
    expect(accessUntil('garbage')).toBeNull();
  });
});
