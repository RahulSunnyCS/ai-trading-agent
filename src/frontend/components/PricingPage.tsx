/**
 * PricingPage — shows available payment plans and drives the Razorpay checkout.
 *
 * Conditional rendering order (matches the task spec):
 *   1. Loading skeleton while fetching from the API
 *   2. Error state if the API call failed
 *   3. Payment disabled message (dev / self-hosted mode)
 *   4. Non-India region gate
 *   5. Plan cards with Buy Now buttons
 *
 * The Razorpay Checkout SDK is loaded via a <script> tag in index.html and
 * accessed through the typed `window.Razorpay` global. We guard against it
 * being absent (e.g. network failure, ad-blocker) and show an error rather
 * than crashing.
 *
 * Security notes:
 * - The Razorpay public key ID (returned by /api/payment/create-order) is safe
 *   to pass to the client-side widget; it is NOT the secret key.
 * - Payment verification always happens server-side via POST /api/payment/verify.
 *   The client only forwards the three Razorpay-provided fields for the server
 *   to re-verify with the HMAC secret it holds. The client cannot forge these.
 * - No default export (project convention).
 */

import { useState } from 'react';

import { type Plan, usePricingPlans } from '../hooks/usePricingPlans';
import { PaymentTestModeBanner } from './PaymentTestModeBanner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats an integer paise amount to a human-readable rupee string.
 * e.g. 99900 → "₹999.00"
 *
 * toFixed(2) always produces exactly two decimal places, which is consistent
 * with how Indian prices are displayed.
 */
function formatPrice(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// API response shape for create-order
// ---------------------------------------------------------------------------

interface CreateOrderSuccess {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
}

/**
 * Narrows the create-order API response.
 * Returns null when any required field is absent or wrong-typed so the caller
 * can surface a meaningful error rather than crashing on property access.
 */
function narrowCreateOrder(body: unknown): CreateOrderSuccess | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;
  const { orderId, amount, currency, keyId } = obj;
  if (
    typeof orderId !== 'string' ||
    typeof amount !== 'number' ||
    typeof currency !== 'string' ||
    typeof keyId !== 'string'
  ) {
    return null;
  }
  return { orderId, amount, currency, keyId };
}

// ---------------------------------------------------------------------------
// PlanCard sub-component
// ---------------------------------------------------------------------------

interface PlanCardProps {
  plan: Plan;
  onBuy: (planId: string) => void;
  buying: boolean;
}

/**
 * Renders a single plan card. The `buying` flag is true when any purchase is
 * in progress (not just this card's plan), which disables all Buy Now buttons
 * to prevent double-submission.
 */
function PlanCard({ plan, onBuy, buying }: PlanCardProps) {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-sm">
      <div>
        <h3 className="text-lg font-semibold text-white">{plan.name}</h3>
        <p className="mt-1 text-sm text-gray-400">{plan.description}</p>
        <p className="mt-4 text-3xl font-bold text-white">{formatPrice(plan.pricePaise)}</p>
      </div>

      <button
        type="button"
        onClick={() => onBuy(plan.id)}
        disabled={buying}
        className="mt-6 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {buying ? 'Processing…' : 'Buy Now'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PricingPage() {
  const { plans, loading, error, paymentEnabled, region, testMode } = usePricingPlans();

  // `buying` tracks whether a checkout flow is active. We disable all Buy Now
  // buttons during the flow to prevent concurrent orders.
  const [buying, setBuying] = useState(false);

  // `checkoutError` is surfaced beneath the plan cards if any step of the
  // checkout flow fails (create-order, Razorpay widget, verify).
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // `successMessage` replaces the error after a verified payment.
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // Payment flow
  // ------------------------------------------------------------------

  async function handleBuyNow(planId: string): Promise<void> {
    setCheckoutError(null);
    setSuccessMessage(null);
    setBuying(true);

    try {
      // Step 1: create a Razorpay order on the server.
      const orderRes = await fetch('/api/payment/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      });

      const orderBody: unknown = await orderRes.json();

      if (!orderRes.ok) {
        // Surface the server error code if available, otherwise a generic message.
        const errCode =
          typeof orderBody === 'object' &&
          orderBody !== null &&
          'error' in orderBody &&
          typeof (orderBody as Record<string, unknown>).error === 'string'
            ? (orderBody as Record<string, unknown>).error
            : 'unknown_error';
        setCheckoutError(`Could not create order (${String(errCode)}). Please try again.`);
        setBuying(false);
        return;
      }

      const order = narrowCreateOrder(orderBody);
      if (order === null) {
        setCheckoutError('Unexpected response from server. Please try again.');
        setBuying(false);
        return;
      }

      // Step 2: guard against Razorpay SDK not being loaded.
      // The SDK is injected via <script> in index.html; it may be absent if
      // the user's network blocked the script or the CDN is down.
      if (typeof window.Razorpay === 'undefined') {
        setCheckoutError(
          'Payment widget could not be loaded. Please check your connection and try again.',
        );
        setBuying(false);
        return;
      }

      // Step 3: open the Razorpay checkout widget.
      // We wrap this in a Promise so we can await the outcome (success / dismiss)
      // before re-enabling the Buy Now button.
      await new Promise<void>((resolve) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: 'AI Trading Agent',
          description: testMode ? '[Test Mode] No charge' : 'Subscription',
          handler: (response) => {
            // Step 4: verify the payment on the server.
            // We intentionally do not await here — resolve() is called
            // immediately so the modal closes, and the verify call runs
            // asynchronously. The UI transitions to "loading" state via
            // setBuying(true) which remains true during the verify call.
            void verifyPayment({
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
              plan: planId,
              resolve,
            });
          },
          modal: {
            ondismiss: () => {
              // User closed the widget without paying.
              setCheckoutError('Payment was cancelled.');
              resolve();
            },
          },
        });
        rzp.open();
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setCheckoutError(message);
    } finally {
      setBuying(false);
    }
  }

  /**
   * Calls POST /api/payment/verify and updates UI state.
   * Extracted from handleBuyNow to keep the callback small and avoid nesting.
   */
  async function verifyPayment(params: {
    orderId: string;
    paymentId: string;
    signature: string;
    plan: string;
    resolve: () => void;
  }): Promise<void> {
    const { orderId, paymentId, signature, plan, resolve } = params;
    try {
      const verifyRes = await fetch('/api/payment/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, paymentId, signature, plan }),
      });

      if (verifyRes.ok) {
        setSuccessMessage('Payment verified! Your access has been granted.');
      } else {
        setCheckoutError('Payment received but verification failed. Please contact support.');
      }
    } catch {
      setCheckoutError('Could not reach server to verify payment. Please contact support.');
    } finally {
      // Re-enable the UI regardless of verify outcome.
      setBuying(false);
      resolve();
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-6">
      {/* Test mode banner — self-hides in live mode */}
      <PaymentTestModeBanner />

      <div>
        <h2 className="text-2xl font-bold text-white">Pricing</h2>
        <p className="mt-1 text-sm text-gray-400">Choose the plan that works for you.</p>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="rounded-lg bg-gray-900 p-8 text-center">
          <p className="text-gray-400">Loading plans…</p>
        </div>
      )}

      {/* Fetch error */}
      {!loading && error !== null && (
        <div className="rounded-lg border border-red-700 bg-red-950 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Payment disabled (development / self-hosted mode) */}
      {!loading && error === null && !paymentEnabled && (
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-8 text-center">
          <p className="text-gray-300">Payment is not required in this configuration.</p>
          <p className="mt-1 text-sm text-gray-500">
            Running in development mode — all features are available without a subscription.
          </p>
        </div>
      )}

      {/* Region gate — only India is supported in Phase 1 */}
      {!loading && error === null && paymentEnabled && region !== 'IN' && (
        <div className="rounded-lg border border-yellow-700 bg-yellow-950 p-6 text-center">
          <p className="text-yellow-300 font-medium">Currently available for India only.</p>
          <p className="mt-1 text-sm text-yellow-500">
            UPI payment is required. International payment support is planned for a future release.
          </p>
        </div>
      )}

      {/* Plan cards — only shown when payment is enabled and region is India */}
      {!loading && error === null && paymentEnabled && region === 'IN' && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                onBuy={(planId) => void handleBuyNow(planId)}
                buying={buying}
              />
            ))}
          </div>

          {/* Success message */}
          {successMessage !== null && (
            <div className="rounded-lg border border-green-700 bg-green-950 p-4 text-sm text-green-300">
              {successMessage}
            </div>
          )}

          {/* Checkout error */}
          {checkoutError !== null && (
            <div className="rounded-lg border border-red-700 bg-red-950 p-4 text-sm text-red-300">
              {checkoutError}
            </div>
          )}
        </>
      )}
    </div>
  );
}
