/**
 * Returns true when the Razorpay public key is a test key (prefix `rzp_test_`).
 * Next exposes NEXT_PUBLIC_RAZORPAY_KEY_ID to client components at build time.
 * It must equal RAZORPAY_KEY_ID — it is the public key ID, safe
 * to expose to the browser (never the secret).
 */
export function usePaymentTestMode(): boolean {
  const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  return keyId?.startsWith('rzp_test_') ?? false;
}
