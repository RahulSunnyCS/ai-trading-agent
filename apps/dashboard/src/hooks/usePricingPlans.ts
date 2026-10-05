/**
 * usePricingPlans — GET /api/payment/status and GET /api/payment/plans, on mount and on
 * `refresh`. Built on usePolledResource; the two requests run side by side (the plans
 * endpoint answers `{ plans: [] }` when payment is off, so it need not wait for the status).
 *
 * `testMode` here is the one source for the payment test-mode flag: the server derives it
 * from its own RAZORPAY_KEY_ID, the key that actually creates the orders.
 */

import { usePolledResource } from './usePolledResource';

// ---------------------------------------------------------------------------
// Public types — exported so the Billing page can import them without re-declaring.
// ---------------------------------------------------------------------------

export interface Plan {
  id: string;
  name: string;
  pricePaise: number;
  description: string;
}

export type RegionConfidence = 'high' | 'low' | 'unknown';

export interface PricingState {
  plans: Plan[];
  loading: boolean;
  error: string | null;
  paymentEnabled: boolean;
  /** ISO country code from the server's IP geolocation, or null when it could not tell. */
  region: string | null;
  /** How sure the geolocation is. */
  confidence: RegionConfidence;
  /** True when the server's Razorpay key is a test key: checkouts charge nothing. */
  testMode: boolean;
  /** Re-read status and plans. */
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Narrowing helpers — API responses are unknown; we narrow to the shape we
// depend on rather than casting blindly or using `any`.
// ---------------------------------------------------------------------------

/**
 * Checks that a value is a plain object (not null, not an array).
 * Used to safely access named properties on an unknown API response.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows the /api/payment/status response body.
 * All fields degrade gracefully — missing or wrong-typed fields fall back to
 * safe defaults so the UI never crashes on a malformed response.
 */
function extractStatus(body: unknown): {
  enabled: boolean;
  testMode: boolean;
  region: string | null;
  confidence: RegionConfidence;
} {
  if (!isPlainObject(body)) {
    return { enabled: false, testMode: false, region: null, confidence: 'unknown' };
  }
  const { confidence } = body;
  return {
    enabled: body.enabled === true,
    testMode: body.testMode === true,
    region: typeof body.region === 'string' ? body.region : null,
    confidence: confidence === 'high' || confidence === 'low' ? confidence : 'unknown',
  };
}

/**
 * Narrows a single element of the plans array.
 * Returns null if any required field is missing or has the wrong type, so the
 * caller can filter out malformed entries rather than crashing.
 */
function narrowPlan(item: unknown): Plan | null {
  if (!isPlainObject(item)) return null;
  const { id, name, pricePaise, description } = item;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof pricePaise !== 'number' ||
    !Number.isFinite(pricePaise) ||
    typeof description !== 'string'
  ) {
    return null;
  }
  return { id, name, pricePaise, description };
}

/**
 * Narrows the /api/payment/plans response body into a Plan[].
 * Invalid entries are dropped rather than throwing — a partial plan list is
 * safer than a full crash.
 */
function extractPlans(body: unknown): Plan[] {
  if (!isPlainObject(body)) return [];
  const raw = body.plans;
  if (!Array.isArray(raw)) return [];
  const result: Plan[] = [];
  for (const item of raw) {
    const plan = narrowPlan(item);
    if (plan !== null) {
      result.push(plan);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePricingPlans(): PricingState {
  const status = usePolledResource<unknown>('/api/payment/status');
  const plansResource = usePolledResource<unknown>('/api/payment/plans');
  const { enabled, testMode, region, confidence } = extractStatus(status.data);

  // Plans only matter once the status says payment is on; a plans failure while payment is
  // off is not an error the page needs to show.
  const loading =
    (status.loading && status.data === null) ||
    (enabled && plansResource.loading && plansResource.data === null);
  const error =
    status.data === null
      ? status.error
      : enabled && plansResource.data === null
        ? plansResource.error
        : null;

  return {
    plans: enabled ? extractPlans(plansResource.data) : [],
    loading,
    error,
    paymentEnabled: enabled,
    region,
    confidence,
    testMode,
    refresh: () => {
      status.refetch();
      plansResource.refetch();
    },
  };
}
