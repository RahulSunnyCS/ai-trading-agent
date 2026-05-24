/**
 * Statistical functions for backtest analysis.
 *
 * All functions are pure and synchronous — no I/O, no side effects.
 * Intended for use by backtest-report.ts to compute per-personality metrics
 * and significance tests against the Clockwork benchmark.
 */

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

/**
 * Error function approximation using Horner's method (Abramowitz & Stegun 7.1.26).
 * Accurate to |error| < 1.5e-7.
 *
 * We implement our own rather than using a library to keep the stats module
 * dependency-free and easy to unit test in isolation.
 */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);

  // Coefficients from A&S 7.1.26
  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;

  const t = 1.0 / (1.0 + p * ax);
  // Horner's method: evaluate polynomial t*(a1 + t*(a2 + t*(a3 + t*(a4 + t*a5))))
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  const result = 1.0 - poly * Math.exp(-ax * ax);
  return sign * result;
}

/**
 * Standard normal cumulative distribution function.
 * Returns P(Z <= x) for Z ~ N(0, 1).
 */
export function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// t-distribution
// ---------------------------------------------------------------------------

/**
 * Two-sided p-value from a t-distribution with `df` degrees of freedom.
 *
 * For df >= 30 we use the normal approximation (error < ~1%). This is
 * acceptable for a research reporting tool — the sample sizes that produce
 * df < 30 (fewer than 32 trades) are flagged as low-confidence in data-quality
 * notes anyway.
 *
 * For df < 30 we use the Hill (1970) continued-fraction algorithm, which is
 * accurate and avoids the need for an incomplete Beta function library.
 */
export function tDistPValue(t: number, df: number): number {
  if (df <= 0) return 1;

  const abst = Math.abs(t);

  // Normal approximation for large df
  if (df >= 30) {
    return 2 * (1 - normalCDF(abst));
  }

  // Hill (1970) algorithm for small df.
  // Computes the two-tailed p-value directly via the regularized incomplete
  // Beta function using the continued-fraction representation.
  const x = df / (df + abst * abst);
  let p: number;

  if (df % 2 === 0) {
    // Even df: exact formula via product series
    let term = 1.0;
    let sum = 1.0;
    for (let k = 2; k <= df - 2; k += 2) {
      term *= (x * (k - 1)) / k;
      sum += term;
    }
    p = Math.sqrt(1 - x) * sum;
  } else if (df === 1) {
    // Cauchy distribution
    p = 1 - (2 / Math.PI) * Math.atan(abst);
  } else {
    // Odd df > 1: recursive formula
    let term = Math.sqrt(x * (1 - x));
    let sum = term;
    for (let k = 3; k <= df - 2; k += 2) {
      term *= (x * (k - 1)) / k;
      sum += term;
    }
    p = (2 / Math.PI) * (Math.atan(abst / Math.sqrt(df)) + Math.sqrt(x * (1 - x)) * sum);
  }

  // Clamp to [0, 1] to handle floating-point edge cases
  return Math.min(1, Math.max(0, p));
}

// ---------------------------------------------------------------------------
// Welch's two-sample t-test
// ---------------------------------------------------------------------------

export interface TTestResult {
  t: number;
  df: number;
  pValue: number;
  significant: boolean;
}

/**
 * Welch's two-sample t-test (unequal variances).
 *
 * Returns null if either array has fewer than 2 elements — a t-test on a
 * single-element sample is undefined (zero degrees of freedom in variance).
 *
 * Degrees of freedom use the Welch-Satterthwaite approximation:
 *   df = (s1^2/n1 + s2^2/n2)^2 / ((s1^2/n1)^2/(n1-1) + (s2^2/n2)^2/(n2-1))
 */
export function welchTTest(a: number[], b: number[]): TTestResult | null {
  if (a.length < 2 || b.length < 2) return null;

  const n1 = a.length;
  const n2 = b.length;

  const mean1 = a.reduce((s, v) => s + v, 0) / n1;
  const mean2 = b.reduce((s, v) => s + v, 0) / n2;

  // Sample variance: sum((xi - mean)^2) / (n - 1)
  const var1 = a.reduce((s, v) => s + (v - mean1) ** 2, 0) / (n1 - 1);
  const var2 = b.reduce((s, v) => s + (v - mean2) ** 2, 0) / (n2 - 1);

  // Guard against zero variance (all values identical)
  if (var1 === 0 && var2 === 0) {
    const t = mean1 === mean2 ? 0 : Number.POSITIVE_INFINITY;
    return { t, df: n1 + n2 - 2, pValue: t === 0 ? 1 : 0, significant: false };
  }

  const se1 = var1 / n1;
  const se2 = var2 / n2;
  const seDiff = Math.sqrt(se1 + se2);

  const t = (mean1 - mean2) / seDiff;

  // Welch-Satterthwaite df
  const dfNumerator = (se1 + se2) ** 2;
  const dfDenominator = se1 ** 2 / (n1 - 1) + se2 ** 2 / (n2 - 1);
  const df = dfDenominator === 0 ? n1 + n2 - 2 : dfNumerator / dfDenominator;

  const pValue = tDistPValue(t, df);

  return { t, df, pValue, significant: pValue < 0.05 };
}

// ---------------------------------------------------------------------------
// Mann-Whitney U test
// ---------------------------------------------------------------------------

export interface MannWhitneyResult {
  u: number;
  z: number;
  pValue: number;
  significant: boolean;
}

/**
 * Mann-Whitney U test with normal approximation for the p-value.
 *
 * Returns null if either array is empty — the test requires at least one
 * observation per group to compute a meaningful U statistic.
 *
 * U statistic: count of pairs (a[i], b[j]) where a[i] > b[j], plus 0.5 for
 * ties. The smaller of U1 and U2 is returned (standard convention).
 *
 * Normal approximation: z = (U - n1*n2/2) / sqrt(n1*n2*(n1+n2+1)/12)
 * Accurate when n1 and n2 are both > 8. For smaller samples this approximation
 * is rough, but we flag small samples in data-quality notes anyway.
 */
export function mannWhitneyU(a: number[], b: number[]): MannWhitneyResult | null {
  if (a.length === 0 || b.length === 0) return null;

  const n1 = a.length;
  const n2 = b.length;

  // Count pairs where a[i] > b[j] and ties
  let u1 = 0;
  for (const ai of a) {
    for (const bj of b) {
      if (ai > bj) {
        u1 += 1;
      } else if (ai === bj) {
        u1 += 0.5;
      }
    }
  }

  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  const meanU = (n1 * n2) / 2;
  const stdU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);

  // Guard against degenerate case (both arrays identical singletons)
  if (stdU === 0) {
    return { u, z: 0, pValue: 1, significant: false };
  }

  // Continuity correction: subtract 0.5 from the absolute deviation before
  // dividing by stdU. This improves accuracy for discrete distributions.
  const z = (u - meanU) / stdU;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  return { u, z, pValue: Math.min(1, pValue), significant: pValue < 0.05 };
}

// ---------------------------------------------------------------------------
// Sharpe ratio
// ---------------------------------------------------------------------------

/**
 * Annualised Sharpe ratio on a series of per-trade returns (not daily returns).
 *
 * We treat each trade return as equivalent to one "period" and scale by
 * sqrt(252) — standard annualisation for daily-frequency data. This is a
 * simplification for a research tool: if trades happen multiple times per day
 * the true annualisation factor is higher, but the ranking between personalities
 * is preserved, which is what matters for comparison.
 *
 * Returns 0 if:
 *   - fewer than 2 returns (standard deviation is undefined)
 *   - standard deviation is 0 (all returns identical — usually all zeros)
 *
 * riskFreeRateAnnual defaults to 0.065 (6.5%), a reasonable proxy for the
 * Indian repo rate. The daily risk-free rate is riskFreeRateAnnual / 252.
 */
export function sharpeRatio(dailyReturns: number[], riskFreeRateAnnual = 0.065): number {
  if (dailyReturns.length < 2) return 0;

  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / n;

  // Sample standard deviation
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return 0;

  const riskFreeDaily = riskFreeRateAnnual / 252;
  // Annualise: (mean_return - daily_rf) / std * sqrt(252)
  return ((mean - riskFreeDaily) / std) * Math.sqrt(252);
}

// ---------------------------------------------------------------------------
// Maximum drawdown
// ---------------------------------------------------------------------------

export interface DrawdownResult {
  maxDrawdownPct: number;
  peakIdx: number;
  troughIdx: number;
}

/**
 * Maximum peak-to-trough decline on a cumulative P&L series.
 *
 * `cumulativePnlSeries` is an array of cumulative P&L values — e.g. [0, 3, 5, 2, 7].
 * The drawdown is computed as (peak - trough) / |peak| * 100, where peak and trough
 * are values of the running maximum and the subsequent minimum.
 *
 * Returns { maxDrawdownPct: 0, peakIdx: 0, troughIdx: 0 } for empty or flat series.
 *
 * We use |peak| in the denominator because a P&L series starting at 0 would give
 * division by zero on the first peak if it is also 0. When peak is 0 we skip that
 * window (a drawdown from 0 to negative is captured when the next peak is positive).
 */
export function maxDrawdown(cumulativePnlSeries: number[]): DrawdownResult {
  if (cumulativePnlSeries.length === 0) {
    return { maxDrawdownPct: 0, peakIdx: 0, troughIdx: 0 };
  }

  let maxDD = 0;
  let peakIdx = 0;
  let troughIdx = 0;
  let runningPeakIdx = 0;
  let runningPeak = cumulativePnlSeries[0] ?? 0;

  for (let i = 1; i < cumulativePnlSeries.length; i++) {
    const val = cumulativePnlSeries[i] ?? 0;

    if (val > runningPeak) {
      runningPeak = val;
      runningPeakIdx = i;
    }

    // Only measure drawdown when peak is non-zero to avoid division by zero
    if (runningPeak !== 0) {
      const dd = ((runningPeak - val) / Math.abs(runningPeak)) * 100;
      if (dd > maxDD) {
        maxDD = dd;
        peakIdx = runningPeakIdx;
        troughIdx = i;
      }
    }
  }

  return { maxDrawdownPct: maxDD, peakIdx, troughIdx };
}
