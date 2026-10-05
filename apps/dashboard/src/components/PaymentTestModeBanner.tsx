import { Info } from 'lucide-react';

/**
 * "Test mode" notice for the Billing page, in the info tone. Shown only there, and only when
 * the server says its Razorpay key is a test key (`testMode` from GET /api/payment/status,
 * read by usePricingPlans: the one source for the flag). Renders nothing otherwise.
 */
export function PaymentTestModeBanner({ testMode }: { testMode: boolean }) {
  if (!testMode) return null;

  return (
    <output className="flex items-center gap-2 rounded-lg border border-info/25 bg-info/10 px-4 py-2.5 text-sm">
      <Info className="h-4 w-4 shrink-0 text-info" aria-hidden="true" />
      <span className="text-foreground">
        Payment test mode: checkouts use Razorpay test keys and you will{' '}
        <strong className="font-semibold">not</strong> be charged.
      </span>
    </output>
  );
}
