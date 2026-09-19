/**
 * Straddle Math — pure functions for straddle snapshot computation.
 *
 * This module contains ONLY stateless computation: straddle value, rate of
 * change (ROC), and acceleration (second derivative of straddle value).
 *
 * No DB access, no Redis, no clock, no I/O of any kind.
 *
 * Both the live calculator (straddle-calc.ts) and the historical reconstructor
 * (historical/reconstruct-straddle.ts) import from here so there is exactly
 * ONE implementation of straddle math for live and historical use.
 *
 * The semantics here exactly mirror the original inline logic in straddle-calc.ts
 * so that straddle-calc.test.ts continues to pass unchanged after the refactor.
 */

// ---------------------------------------------------------------------------
// Straddle value
// ---------------------------------------------------------------------------

/**
 * Compute the straddle value as the sum of call and put premiums.
 *
 * This is intentionally trivial but kept as a named function so:
 *   (a) both live and historical paths call the same code path, and
 *   (b) the formula is explicit and searchable if it ever needs to change.
 */
export function computeStraddleValue(callLtp: number, putLtp: number): number {
  return callLtp + putLtp;
}

// ---------------------------------------------------------------------------
// Rolling-buffer helpers
// ---------------------------------------------------------------------------

/**
 * Compute ROC (Rate of Change) from the last two straddle values in the buffer.
 *
 * Returns 0 when:
 *   - fewer than 2 values are present (not enough history), or
 *   - the previous value is 0 (would produce divide-by-zero / Infinity).
 *
 * Formula: (current - previous) / previous * 100
 *
 * Edge cases mirror the original straddle-calc.ts implementation exactly.
 */
export function computeRoc(buffer: readonly number[]): number {
  if (buffer.length < 2) return 0;
  const prev = buffer[buffer.length - 2];
  const curr = buffer[buffer.length - 1];
  // Both indexes are guaranteed non-undefined because of the length guard above,
  // but TypeScript with noUncheckedIndexedAccess requires explicit checks.
  if (prev === undefined || curr === undefined || prev === 0) return 0;
  return ((curr - prev) / prev) * 100;
}

/**
 * Compute acceleration (second derivative of straddle value) from the rolling
 * buffer by comparing the two most recent ROC values.
 *
 * Returns 0 when fewer than 3 values are in the buffer (need two consecutive
 * ROC intervals to compare).
 *
 * Computation:
 *   Given buffer = [... a, b, c]:
 *     roc_prev = (b - a) / a * 100
 *     roc_curr = (c - b) / b * 100
 *     acceleration = roc_curr - roc_prev
 *
 * Edge cases mirror the original straddle-calc.ts implementation exactly.
 */
export function computeAcceleration(buffer: readonly number[]): number {
  if (buffer.length < 3) return 0;

  const a = buffer[buffer.length - 3];
  const b = buffer[buffer.length - 2];
  const c = buffer[buffer.length - 1];

  if (a === undefined || b === undefined || c === undefined) return 0;
  if (a === 0 || b === 0) return 0;

  const rocPrev = ((b - a) / a) * 100;
  const rocCurr = ((c - b) / b) * 100;
  return rocCurr - rocPrev;
}

// ---------------------------------------------------------------------------
// Rolling buffer management
// ---------------------------------------------------------------------------

/**
 * Push a new straddle value onto the rolling buffer, capping its length at
 * `maxSize`. Mutates the array in place (matches the original straddle-calc.ts
 * behaviour so downstream comparisons are byte-identical).
 *
 * Returns the same buffer reference (mutated in place) for call-chain convenience.
 *
 * Why mutate in place rather than return a new array?
 * The live calculator already uses a mutable array with push/shift for
 * performance (avoids GC churn on every 15-second snapshot). The historical
 * reconstructor feeds values one at a time in chronological order, so the
 * same approach is safe.
 */
export function pushToBuffer(buffer: number[], value: number, maxSize: number): number[] {
  buffer.push(value);
  if (buffer.length > maxSize) {
    buffer.shift();
  }
  return buffer;
}
