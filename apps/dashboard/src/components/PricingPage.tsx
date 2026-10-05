/**
 * PricingPage — Account › Billing (`/billing`; the tab id stays `pricing`). Shows the
 * instance's credits and payment mode first, then the plans, and drives the Razorpay checkout.
 *
 * Rendering order:
 *   1. Test-mode banner (only here, from the server's flag)
 *   2. Loading skeleton / error while status and plans load
 *   3. Payments off on this server (the free / self-hosted configuration)
 *   4. Account summary: credits balance and payment mode
 *   5. Region gate: only a region the server places outside India blocks checkout; an
 *      unknown region still sees the plans
 *   6. Plan cards, each with its own Buy button and busy state, and the last checkout's outcome
 *
 * The server exposes no purchase-history or access-pass endpoint, so neither is shown.
 *
 * The Razorpay Checkout SDK is loaded by Next.js when this page mounts and accessed through
 * the typed `window.Razorpay` global. We guard against it being absent and show an error
 * rather than crashing.
 *
 * Security notes:
 * - The Razorpay public key ID (returned by /api/payment/create-order) is safe
 *   to pass to the client-side widget; it is NOT the secret key.
 * - Payment verification always happens server-side via POST /api/payment/verify.
 * - No default export (project convention).
 */

import Script from 'next/script';
import { useState } from 'react';

import { usePaymentBalance } from '../hooks/usePaymentBalance';
import { type Plan, usePricingPlans } from '../hooks/usePricingPlans';
import { apiPost } from '../lib/api';
import { orderErrorMessage, purchaseMessage, regionGate } from '../lib/billing';
import { PaymentTestModeBanner } from './PaymentTestModeBanner';
import { BillingSummary } from './billing/BillingSummary';
import { CheckoutOutcome, type CheckoutResult } from './billing/CheckoutOutcome';
import { PlanCard } from './billing/PlanCard';
import { Card } from './ui/Card';
import { Skeleton } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';
import { toast } from './ui/Toast';

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

/** POST /api/payment/verify's success body: `expiresAt` is set for a monthly pass. */
interface VerifyResponse {
  success?: unknown;
  grantType?: unknown;
  expiresAt?: unknown;
}

function PaymentsOff() {
  return (
    <Card className="py-10 text-center">
      <p className="text-foreground">Payments are off on this server.</p>
      <p className="mt-1 text-sm text-muted">
        Every feature is open: no pass or credits are needed.
      </p>
      {process.env.NODE_ENV !== 'production' ? (
        <p className="mt-3 text-xs text-faint">
          Development: set RAZORPAY_KEY_ID on the server to turn billing on.
        </p>
      ) : null}
    </Card>
  );
}

function OutsideIndia() {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 p-6 text-center">
      <p className="font-medium text-foreground">Currently available in India only.</p>
      <p className="mt-1 text-sm text-muted">
        Checkout needs UPI or an Indian debit or credit card. International payments are planned for
        a later release.
      </p>
    </div>
  );
}

export function PricingPage() {
  const { plans, loading, error, paymentEnabled, region, testMode } = usePricingPlans();
  const credits = usePaymentBalance();
  const gate = regionGate(region);

  /** The plan whose checkout is being opened or is open; null when none is. */
  const [buyingPlanId, setBuyingPlanId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CheckoutResult | null>(null);
  /** A monthly pass bought in this session reports its expiry; the server has no other source. */
  const [passExpiresAt, setPassExpiresAt] = useState<string | null>(null);

  async function handleBuy(plan: Plan): Promise<void> {
    setOutcome(null);
    setBuyingPlanId(plan.id);

    try {
      const orderRes = await apiPost<unknown>('/api/payment/create-order', { plan: plan.id });
      if (!orderRes.ok) {
        setOutcome({ kind: 'error', message: orderErrorMessage(orderRes.error) });
        return;
      }

      const order = narrowCreateOrder(orderRes.data);
      if (order === null) {
        setOutcome({
          kind: 'error',
          message: 'Unexpected response from server. Please try again.',
        });
        return;
      }

      if (typeof window.Razorpay === 'undefined') {
        setOutcome({
          kind: 'error',
          message: 'The payment widget could not be loaded. Check your connection and try again.',
        });
        return;
      }

      await new Promise<void>((resolve) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: 'AI Trading Agent',
          description: testMode ? `[Test mode] ${plan.name}, no charge` : plan.name,
          handler: (response) => {
            void verifyPayment({
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
              plan,
            }).finally(resolve);
          },
          modal: {
            // Closing the checkout is a choice, not a failure: a neutral note, not an error.
            ondismiss: () => {
              setOutcome({ kind: 'cancelled', planName: plan.name });
              resolve();
            },
          },
        });
        rzp.open();
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setOutcome({ kind: 'error', message });
    } finally {
      setBuyingPlanId(null);
    }
  }

  async function verifyPayment(params: {
    orderId: string;
    paymentId: string;
    signature: string;
    plan: Plan;
  }): Promise<void> {
    const { orderId, paymentId, signature, plan } = params;
    const verifyRes = await apiPost<VerifyResponse>('/api/payment/verify', {
      orderId,
      paymentId,
      signature,
      plan: plan.id,
    });

    if (!verifyRes.ok) {
      setOutcome({
        kind: 'error',
        message:
          verifyRes.status === undefined
            ? 'Could not reach the server to verify the payment. Contact support with this order id.'
            : 'Payment received but verification failed. Contact support with this order id.',
        orderId,
      });
      return;
    }

    const expiresAt =
      typeof verifyRes.data.expiresAt === 'string' ? verifyRes.data.expiresAt : null;
    if (expiresAt !== null) setPassExpiresAt(expiresAt);
    setOutcome({ kind: 'success', planName: plan.name, orderId, expiresAt });
    toast(purchaseMessage(plan.name, orderId));
    credits.refresh();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {paymentEnabled && gate !== 'outside' && (
        <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" />
      )}
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Billing</h2>
        <p className="mt-1 text-sm text-muted">
          Your credits and plans. One-time payments through Razorpay; nothing renews by itself.
        </p>
      </div>

      <PaymentTestModeBanner testMode={testMode} />

      {loading && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}

      {!loading && error !== null && (
        <StateMessage variant="error" title="Couldn't load billing" description={error} />
      )}

      {!loading && error === null && !paymentEnabled && <PaymentsOff />}

      {!loading && error === null && paymentEnabled && (
        <>
          <BillingSummary
            balance={credits.balance}
            balanceLoading={credits.loading}
            balanceError={credits.error}
            onRefresh={credits.refresh}
            testMode={testMode}
            passExpiresAt={passExpiresAt}
          />

          {gate === 'outside' ? (
            <OutsideIndia />
          ) : (
            <section aria-labelledby="billing-plans" className="space-y-4">
              <div>
                <h3
                  id="billing-plans"
                  className="text-base font-semibold tracking-tight text-foreground"
                >
                  Plans
                </h3>
                {gate === 'unknown' ? (
                  <p className="mt-0.5 text-sm text-muted">
                    Checkout takes UPI or an Indian debit or credit card.
                  </p>
                ) : null}
              </div>
              {plans.length === 0 ? (
                <StateMessage
                  variant="empty"
                  title="No plans are offered right now"
                  description="The server returned no plans."
                />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {plans.map((plan) => (
                    <PlanCard
                      key={plan.id}
                      plan={plan}
                      onBuy={(next) => void handleBuy(next)}
                      buying={buyingPlanId === plan.id}
                      disabled={buyingPlanId !== null && buyingPlanId !== plan.id}
                    />
                  ))}
                </div>
              )}

              {outcome !== null ? <CheckoutOutcome result={outcome} /> : null}
            </section>
          )}
        </>
      )}
    </div>
  );
}
