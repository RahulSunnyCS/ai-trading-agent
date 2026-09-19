import { BadgeCheck } from 'lucide-react';

import { usePaymentTestMode } from '../hooks/usePaymentTestMode';

/**
 * Renders a "Test Mode" notice when using Razorpay test keys. Theme-aware via
 * the design tokens (reads correctly in light and dark). Returns null in live
 * mode — zero cost when not shown.
 *
 * Usage:
 *   <PaymentTestModeBanner />
 *   (no props needed — auto-detects from VITE_RAZORPAY_KEY_ID)
 */
export function PaymentTestModeBanner() {
  const isTest = usePaymentTestMode();
  if (!isTest) return null;

  return (
    <output className="mb-4 flex items-center gap-2 rounded-lg border border-positive/25 bg-positive/10 px-4 py-2.5 text-sm font-medium text-positive">
      <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="text-foreground">
        Payment Test Mode — you will <strong className="font-semibold">not</strong> be charged.
      </span>
    </output>
  );
}
