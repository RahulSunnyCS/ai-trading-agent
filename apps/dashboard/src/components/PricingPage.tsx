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
 * being absent and show an error rather than crashing.
 *
 * Security notes:
 * - The Razorpay public key ID (returned by /api/payment/create-order) is safe
 *   to pass to the client-side widget; it is NOT the secret key.
 * - Payment verification always happens server-side via POST /api/payment/verify.
 * - No default export (project convention).
 *
 * This file's redesign is presentation-only — the checkout/verify logic below
 * is unchanged.
 */

import { useState } from 'react';

import { type Plan, usePricingPlans } from '../hooks/usePricingPlans';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { StateMessage } from './ui/StateMessage';

/** Formats an integer paise amount to a human-readable rupee string. */
function formatPrice(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

interface CreateOrderSuccess {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
}

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

function PlanCard({
  plan,
  onBuy,
  buying,
}: {
  plan: Plan;
  onBuy: (planId: string) => void;
  buying: boolean;
}) {
  return (
    <Card className="flex flex-col justify-between transition-shadow hover:shadow-elevated">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{plan.name}</h3>
        <p className="mt-1 text-sm text-muted">{plan.description}</p>
        <p className="metric mt-5 text-3xl font-semibold tracking-tight text-foreground">
          {formatPrice(plan.pricePaise)}
        </p>
      </div>
      <Button
        variant="primary"
        onClick={() => onBuy(plan.id)}
        disabled={buying}
        className="mt-6 w-full"
      >
        {buying ? 'Processing…' : 'Buy Now'}
      </Button>
    </Card>
  );
}

export function PricingPage() {
  const { plans, loading, error, paymentEnabled, region, testMode } = usePricingPlans();
  const [buying, setBuying] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleBuyNow(planId: string): Promise<void> {
    setCheckoutError(null);
    setSuccessMessage(null);
    setBuying(true);

    try {
      const orderRes = await fetch('/api/payment/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      });

      const orderBody: unknown = await orderRes.json();

      if (!orderRes.ok) {
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

      if (typeof window.Razorpay === 'undefined') {
        setCheckoutError(
          'Payment widget could not be loaded. Please check your connection and try again.',
        );
        setBuying(false);
        return;
      }

      await new Promise<void>((resolve) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: 'AI Trading Agent',
          description: testMode ? '[Test Mode] No charge' : 'Subscription',
          handler: (response) => {
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
      setBuying(false);
      resolve();
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h2 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
          Pricing
        </h2>
        <p className="mt-1 text-sm text-muted">Choose the plan that works for you.</p>
      </div>

      {loading && (
        <Card className="py-10 text-center">
          <p className="text-muted">Loading plans…</p>
        </Card>
      )}

      {!loading && error !== null && (
        <StateMessage variant="error" title="Couldn't load plans" description={error} />
      )}

      {!loading && error === null && !paymentEnabled && (
        <Card className="py-10 text-center">
          <p className="text-foreground">Payment is not required in this configuration.</p>
          <p className="mt-1 text-sm text-muted">
            Running in development mode — all features are available without a subscription.
          </p>
        </Card>
      )}

      {!loading && error === null && paymentEnabled && region !== 'IN' && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-6 text-center">
          <p className="font-medium text-warning">Currently available for India only.</p>
          <p className="mt-1 text-sm text-muted">
            UPI payment is required. International payment support is planned for a future release.
          </p>
        </div>
      )}

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

          {successMessage !== null && (
            <div className="rounded-lg border border-positive/30 bg-positive/10 p-4 text-sm text-positive">
              {successMessage}
            </div>
          )}

          {checkoutError !== null && (
            <div className="rounded-lg border border-negative/30 bg-negative/10 p-4 text-sm text-negative">
              {checkoutError}
            </div>
          )}
        </>
      )}
    </div>
  );
}
