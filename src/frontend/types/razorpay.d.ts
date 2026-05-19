/**
 * Minimal ambient type declarations for the Razorpay Checkout SDK loaded via
 * a <script> tag. Only the surface area the PricingPage uses is typed here;
 * other Razorpay options are omitted to avoid false confidence in unverified
 * fields.
 *
 * The `export {}` at the bottom turns this file into a module so the
 * `declare global` block is properly scoped. Without it, TypeScript treats the
 * file as a script and the global augmentation can conflict with other .d.ts
 * files in the project.
 */

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name?: string;
  description?: string;
  handler?: (response: RazorpayPaymentResponse) => void;
  modal?: { ondismiss?: () => void };
}

interface RazorpayPaymentResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayConstructor {
  new (options: RazorpayOptions): { open(): void };
}

declare global {
  interface Window {
    Razorpay: RazorpayConstructor;
  }
}

export {};
