import { CheckCircle2, Info, XCircle } from 'lucide-react';

import { accessUntil } from '../../lib/billing';
import { CopyButton } from '../ui/CopyButton';

/** How the last checkout ended. A closed checkout is not an error. */
export type CheckoutResult =
  | { kind: 'success'; planName: string; orderId: string; expiresAt: string | null }
  | { kind: 'cancelled'; planName: string }
  | { kind: 'error'; message: string; orderId?: string };

/** The note under the plans after a checkout: positive, neutral or negative. */
export function CheckoutOutcome({ result }: { result: CheckoutResult }) {
  if (result.kind === 'cancelled') {
    return (
      <output className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
        <span>
          Checkout for {result.planName} was closed before paying. Nothing was charged; pick a plan
          whenever you are ready.
        </span>
      </output>
    );
  }

  if (result.kind === 'error') {
    return (
      <div
        role="alert"
        className="flex items-start gap-2.5 rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm"
      >
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-negative" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground">{result.message}</p>
          {result.orderId ? <OrderId orderId={result.orderId} /> : null}
        </div>
      </div>
    );
  }

  const until = accessUntil(result.expiresAt);
  return (
    <output className="flex items-start gap-2.5 rounded-lg border border-positive/30 bg-positive/10 px-4 py-3 text-sm">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-positive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          Payment verified: {result.planName}.{until ? ` ${until}.` : ''}
        </p>
        <OrderId orderId={result.orderId} />
      </div>
    </output>
  );
}

/** The Razorpay order id, copyable, for quoting to support or matching a receipt. */
function OrderId({ orderId }: { orderId: string }) {
  return (
    <p className="mt-1 flex items-center gap-1.5 text-muted">
      Order <code className="font-mono text-foreground">{orderId}</code>
      <CopyButton text={orderId} label="Copy order id" />
    </p>
  );
}
