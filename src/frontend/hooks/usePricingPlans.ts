import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Public types — exported so PricingPage can import them without re-declaring.
// ---------------------------------------------------------------------------

export interface Plan {
  id: string;
  name: string;
  pricePaise: number;
  description: string;
}

export interface PricingState {
  plans: Plan[];
  loading: boolean;
  error: string | null;
  paymentEnabled: boolean;
  region: string | null;
  testMode: boolean;
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
} {
  if (!isPlainObject(body)) {
    return { enabled: false, testMode: false, region: null };
  }
  return {
    enabled: body.enabled === true,
    testMode: body.testMode === true,
    region: typeof body.region === 'string' ? body.region : null,
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

/**
 * Fetches payment status and plan list on mount.
 *
 * Flow:
 *   1. GET /api/payment/status — check enabled flag, region, testMode
 *   2. If enabled: GET /api/payment/plans — fetch the plan list
 *
 * Both fetches happen sequentially because the plan fetch is conditional on
 * the status response. An AbortController is used so that if the component
 * unmounts mid-fetch the in-flight request is cancelled and the state setter
 * is not called on an unmounted component (avoids the React no-op warning).
 */
export function usePricingPlans(): PricingState {
  const [state, setState] = useState<PricingState>({
    plans: [],
    loading: true,
    error: null,
    paymentEnabled: false,
    region: null,
    testMode: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function load(): Promise<void> {
      try {
        // Step 1: fetch status
        const statusRes = await fetch('/api/payment/status', { signal });
        if (!statusRes.ok) {
          throw new Error(`Status fetch failed: ${statusRes.status}`);
        }
        const statusBody: unknown = await statusRes.json();
        const { enabled, testMode, region } = extractStatus(statusBody);

        if (!enabled) {
          // Payment disabled — no need to fetch plans.
          setState({
            plans: [],
            loading: false,
            error: null,
            paymentEnabled: false,
            region,
            testMode,
          });
          return;
        }

        // Step 2: fetch plans (only when payment is enabled)
        const plansRes = await fetch('/api/payment/plans', { signal });
        if (!plansRes.ok) {
          throw new Error(`Plans fetch failed: ${plansRes.status}`);
        }
        const plansBody: unknown = await plansRes.json();
        const plans = extractPlans(plansBody);

        setState({
          plans,
          loading: false,
          error: null,
          paymentEnabled: true,
          region,
          testMode,
        });
      } catch (err: unknown) {
        // AbortError is not a real error — it means the component unmounted.
        // We silently ignore it so we do not flash a spurious error message.
        if (err instanceof DOMException && err.name === 'AbortError') return;

        const message = err instanceof Error ? err.message : 'Failed to load pricing information.';
        setState((prev) => ({
          ...prev,
          loading: false,
          error: message,
        }));
      }
    }

    void load();

    // Cancel the in-flight fetch when the component unmounts.
    return () => {
      controller.abort();
    };
  }, []); // Empty deps — fetch once on mount; plans do not change at runtime.

  return state;
}
