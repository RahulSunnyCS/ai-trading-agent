/**
 * Minimal TypeScript declaration shim for the `razorpay` npm package.
 *
 * The full package provides its own types but requires `bun install` to be run.
 * This shim covers only the SDK surface used in src/payment/razorpay.ts so that
 * `tsc --noEmit` passes before the package is installed.
 *
 * Once `bun install` has been run, the installed package's own types take
 * precedence and this file becomes redundant (but harmless — skipLibCheck:true
 * prevents conflicts).
 */

declare module 'razorpay' {
  interface RazorpayConfig {
    key_id: string;
    key_secret: string;
  }

  interface OrderCreateOptions {
    amount: number;
    currency: string;
    receipt?: string;
    notes?: Record<string, string>;
  }

  interface Order {
    id: string;
    amount: number;
    currency: string;
    receipt?: string;
    status: string;
    created_at: number;
  }

  interface Orders {
    create(options: OrderCreateOptions): Promise<Order>;
  }

  class Razorpay {
    constructor(config: RazorpayConfig);
    orders: Orders;
  }

  export = Razorpay;
}
