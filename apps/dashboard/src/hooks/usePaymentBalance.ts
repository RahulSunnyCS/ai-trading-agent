import { usePolledResource } from './usePolledResource';

interface PaymentStatusResponse {
  enabled?: unknown;
}

interface PaymentBalanceResponse {
  balance?: unknown;
}

export interface PaymentBalanceState {
  /** True once /api/payment/status has said the payment system is on. */
  enabled: boolean;
  /** Feature-token credits left, or null when payment is off or the balance is not known. */
  balance: number | null;
}

const BALANCE_POLL_MS = 60_000;

/**
 * Credit balance for the top bar: /api/payment/status once (is billing on at all?) and
 * /api/payment/balance every minute. The balance endpoint answers 0 when payment is disabled,
 * which is why `balance` is only reported alongside `enabled`.
 */
export function usePaymentBalance(): PaymentBalanceState {
  const status = usePolledResource<PaymentStatusResponse>('/api/payment/status');
  const balance = usePolledResource<PaymentBalanceResponse>('/api/payment/balance', {
    intervalMs: BALANCE_POLL_MS,
  });

  const enabled = status.data?.enabled === true;
  const raw = balance.data?.balance;
  return {
    enabled,
    balance: enabled && typeof raw === 'number' && Number.isFinite(raw) ? raw : null,
  };
}
