import { usePaymentTestMode } from '../hooks/usePaymentTestMode';

/**
 * Renders a green "Test Mode" notice when using Razorpay test keys.
 * Drop this at the top of any payment modal or the pricing page.
 * Returns null in live mode — zero cost when not shown.
 *
 * Usage:
 *   <PaymentTestModeBanner />
 *   (no props needed — auto-detects from VITE_RAZORPAY_KEY_ID)
 */
export function PaymentTestModeBanner() {
  const isTest = usePaymentTestMode();
  if (!isTest) return null;

  return (
    <output className="flex items-center gap-2 rounded-md bg-green-100 px-4 py-2 text-sm font-medium text-green-800 ring-1 ring-inset ring-green-200">
      <svg
        className="h-4 w-4 shrink-0 text-green-600"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
        />
      </svg>
      Payment Test Mode — you will <strong className="font-semibold">not</strong> be charged.
    </output>
  );
}
