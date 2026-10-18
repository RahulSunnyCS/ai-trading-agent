import { freshTotp, waitForNextWindow } from '@trading/broker-identity';

export { generateTotp, freshTotp, waitForNextWindow } from '@trading/broker-identity';

const STEP_MS = 30_000;

/** The 30-second TOTP window `atMs` falls in. */
export function totpWindow(atMs: number = Date.now()): number {
  return Math.floor(atMs / STEP_MS);
}

/** The window of the last Angel One code this process typed, or null before the first. */
let lastAngelWindow: number | null = null;

/**
 * A fresh Angel One code from a window this process has not typed a code from yet. Quantiply and
 * AlgoTest both log in through Angel's SmartAPI page with the same TOTP seed; Angel may refuse a
 * code that was already used, so the second login waits for the next window rather than reuse one.
 * Normally they are minutes apart (Quantiply runs before AlgoTest's 08:15 window opens) and this
 * waits for nothing.
 */
export async function angelTotp(secret: string): Promise<string> {
  if (lastAngelWindow !== null && totpWindow() <= lastAngelWindow) await waitForNextWindow();
  const code = await freshTotp(secret);
  lastAngelWindow = totpWindow();
  return code;
}

/** Tests only: forget the last window, so back-to-back scenarios don't wait 30 s each. */
export function resetAngelTotpWindow(): void {
  lastAngelWindow = null;
}
