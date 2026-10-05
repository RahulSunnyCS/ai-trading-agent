/**
 * Pure helpers for Account › Billing: plan prices and what each plan includes, which plan is
 * recommended, the region gate, and the messages a checkout produces. Prices come from the
 * server (`GET /api/payment/plans`, read from env there); Razorpay is the source of truth for
 * what is charged, so nothing here invents or rounds a price beyond display.
 */

import { EMPTY, formatDay, formatInr, formatInt, formatIstDate } from './format';

/** The plan ids the server offers (apps/server/src/server/routes/payment.ts). */
export type PlanId = 'monthly_pass' | 'credits_50' | 'credits_200';

/** The fields of a plan these helpers read. */
export interface PlanLike {
  id: string;
  pricePaise: number;
}

/**
 * The plan marked "Recommended". Rule: the Monthly Access Pass, because it is the only plan
 * that opens the gated views for a fixed period whatever is run; the credit packs are top-ups
 * for backtest runs, which need credits with or without a pass.
 */
export const RECOMMENDED_PLAN_ID: PlanId = 'monthly_pass';

/** What one credit buys, stated once wherever credits are shown. */
export const CREDIT_UNIT = '1 credit = 1 options backtest run (YAML or leg-wise builder)';

/**
 * A plan price from paise: whole rupees without decimals ("₹999"), otherwise with two
 * ("₹999.50"). en-IN grouping, via formatInr.
 */
export function formatPlanPrice(pricePaise: number): string {
  const dp = Number.isInteger(pricePaise) && pricePaise % 100 === 0 ? 0 : 2;
  return formatInr(pricePaise / 100, { dp });
}

/** The credits a credit-pack plan adds ("credits_50" -> 50), or null for any other plan. */
export function planCredits(planId: string): number | null {
  const match = /^credits_(\d+)$/.exec(planId);
  if (!match?.[1]) return null;
  const credits = Number(match[1]);
  return credits > 0 ? credits : null;
}

/** "₹9.98 per credit" for a credit pack, or null for any other plan. */
export function pricePerCredit(plan: PlanLike): string | null {
  const credits = planCredits(plan.id);
  if (credits === null) return null;
  return `${formatInr(plan.pricePaise / 100 / credits, { dp: 2 })} per credit`;
}

/**
 * What a plan includes, one line each. Matches the server's access rules: an active monthly
 * pass or a positive credit balance opens the gated views (checkAccess), and every backtest
 * run spends one credit either way (consumeCredit).
 */
export function planInclusions(plan: PlanLike): string[] {
  if (plan.id === 'monthly_pass') {
    return [
      '30 days of access from the day you pay',
      'Opens every gated view: Options Lab strategies, runs and daily results',
      'Backtest runs still use credits',
      'One-time payment; it does not renew by itself',
    ];
  }
  const credits = planCredits(plan.id);
  if (credits !== null) {
    return [
      `${formatInt(credits)} credits added to your balance`,
      CREDIT_UNIT,
      'A positive balance also opens the gated views',
      'One-time payment',
    ];
  }
  return [];
}

export type RegionGate = 'india' | 'outside' | 'unknown';

/**
 * Whether to offer checkout. Only a region the server positively places outside India blocks
 * it: an unknown region (geolocation failed or was inconclusive) still shows the plans, since
 * UPI itself needs an Indian bank account and is the real check.
 */
export function regionGate(region: string | null): RegionGate {
  if (region === null || region.trim() === '') return 'unknown';
  return region.toUpperCase() === 'IN' ? 'india' : 'outside';
}

/** A readable message for a create-order failure code from the server. */
export function orderErrorMessage(code: string): string {
  switch (code) {
    case 'payment_disabled':
      return 'Payments are switched off on this server.';
    case 'invalid_plan':
      return 'That plan is no longer offered. Reload the page and pick again.';
    default:
      return `Could not create the order (${code}). Please try again.`;
  }
}

/** The toast after a verified payment. The order id is included so it can be quoted. */
export function purchaseMessage(planName: string, orderId: string): string {
  return `Payment verified: ${planName}. Order ${orderId}`;
}

/** "Active until 04 Nov 2026" for an expiry instant, or null when there is none. */
export function accessUntil(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const formatted = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
    ? formatDay(expiresAt)
    : formatIstDate(expiresAt);
  return formatted === EMPTY ? null : `Active until ${formatted}`;
}
