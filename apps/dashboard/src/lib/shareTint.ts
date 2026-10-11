/**
 * The light-to-dark ramp of the stacked share bars (`components/optionslab/StackedShare.tsx`):
 * the i-th of n categories gets an alpha from 0.18 to 0.9, never invisible.
 */
export function shade(i: number, n: number): number {
  return n <= 1 ? 0.6 : 0.18 + (0.72 * i) / (n - 1);
}
