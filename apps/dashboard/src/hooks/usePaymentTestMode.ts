/**
 * Returns true when the Razorpay public key is a test key (prefix `rzp_test_`).
 * The Vite build injects VITE_RAZORPAY_KEY_ID at compile time via import.meta.env.
 * VITE_RAZORPAY_KEY_ID must equal RAZORPAY_KEY_ID — it is the public key ID, safe
 * to expose to the browser (never the secret).
 */
export function usePaymentTestMode(): boolean {
  const keyId = import.meta.env.VITE_RAZORPAY_KEY_ID as string | undefined;
  return keyId?.startsWith('rzp_test_') ?? false;
}
