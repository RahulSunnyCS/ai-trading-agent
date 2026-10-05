/**
 * The top of Billing: what this instance has now, before any plan is offered. Credits come
 * from GET /api/payment/balance; whether checkouts are live or test from GET
 * /api/payment/status. The server exposes no access-pass status (its checkAccess result is
 * internal), so the pass tile appears only when a purchase in this session reported an expiry.
 */

import { CREDIT_UNIT, accessUntil } from '../../lib/billing';
import { formatInt } from '../../lib/format';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { StatCard } from '../ui/StatCard';

interface BillingSummaryProps {
  balance: number | null;
  balanceLoading: boolean;
  balanceError: string | null;
  onRefresh: () => void;
  testMode: boolean;
  /** Expiry of a monthly pass bought in this session, from POST /api/payment/verify. */
  passExpiresAt: string | null;
}

export function BillingSummary({
  balance,
  balanceLoading,
  balanceError,
  onRefresh,
  testMode,
  passExpiresAt,
}: BillingSummaryProps) {
  const pass = accessUntil(passExpiresAt);
  return (
    <Card>
      <CardHeader
        title="Your account"
        description="Credits and payment mode for this instance"
        actions={<RefreshButton onClick={onRefresh} loading={balanceLoading} />}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Credits"
          value={formatInt(balance)}
          loading={balanceLoading && balance === null}
          hint={CREDIT_UNIT}
          note={
            balanceError !== null
              ? `Couldn't read the balance: ${balanceError}`
              : balance !== null && balance > 0
                ? 'A positive balance also opens the gated views'
                : CREDIT_UNIT
          }
        />
        <StatCard
          label="Payments"
          value={testMode ? 'Test mode' : 'Live'}
          note={testMode ? 'Checkouts charge nothing' : 'Checkouts charge real money via Razorpay'}
        />
        {pass !== null ? (
          <StatCard label="Monthly pass" value={pass} note="From your purchase just now" />
        ) : null}
      </div>
    </Card>
  );
}
