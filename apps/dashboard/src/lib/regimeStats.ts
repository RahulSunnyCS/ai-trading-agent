/**
 * Statistics behind the Options Lab's "Market regimes" tab. Pure and seeded, so every
 * number on screen is reproducible and unit-testable.
 *
 * The question these answer is the owner's hypothesis — "market behaviour comes in
 * persistent periods" — so every pattern is reported next to what pure chance would
 * produce: a permutation test shuffles the day order (destroying any serial structure
 * but keeping the label mix) and asks how often chance does at least as well.
 *
 * Caveat the UI repeats: a label is only known AFTER its day. Persistence found here is
 * only actionable when read lag-1 (yesterday's label vs today's outcome).
 */

export type Label = string | null;

/** Small deterministic PRNG (mulberry32) — Math.random would make p-values flicker. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const known = (l: Label | undefined): l is string =>
  l !== null && l !== undefined && l !== 'UNKNOWN';

/** Share of each label among the known ones. */
export function baseRates(labels: Label[]): Record<string, number> {
  const counts: Record<string, number> = {};
  let n = 0;
  for (const l of labels) {
    if (!known(l)) continue;
    counts[l] = (counts[l] ?? 0) + 1;
    n++;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) out[k] = v / n;
  return out;
}

export interface Transitions {
  states: string[];
  /** counts[from][to] */
  counts: Record<string, Record<string, number>>;
  /** P(to | from); a state that never occurs as "from" has an empty row. */
  probs: Record<string, Record<string, number>>;
  /** Observations leaving each state. */
  fromTotals: Record<string, number>;
}

/** Day-to-day transition counts over CONSECUTIVE entries; a pair with an unknown end is skipped. */
export function transitions(labels: Label[], states: string[]): Transitions {
  const counts: Record<string, Record<string, number>> = {};
  const fromTotals: Record<string, number> = {};
  for (const s of states) {
    counts[s] = Object.fromEntries(states.map((t) => [t, 0]));
    fromTotals[s] = 0;
  }
  for (let i = 1; i < labels.length; i++) {
    const a = labels[i - 1];
    const b = labels[i];
    if (!known(a) || !known(b) || !counts[a] || counts[a][b] === undefined) continue;
    counts[a][b] += 1;
    fromTotals[a] = (fromTotals[a] ?? 0) + 1;
  }
  const probs: Record<string, Record<string, number>> = {};
  for (const s of states) {
    probs[s] = {};
    const total = fromTotals[s] ?? 0;
    if (total > 0) for (const t of states) probs[s][t] = (counts[s]?.[t] ?? 0) / total;
  }
  return { states, counts, probs, fromTotals };
}

/** Share of consecutive known pairs whose label did not change. */
export function stayRate(labels: Label[]): number | null {
  let same = 0;
  let pairs = 0;
  for (let i = 1; i < labels.length; i++) {
    const a = labels[i - 1];
    const b = labels[i];
    if (!known(a) || !known(b)) continue;
    pairs++;
    if (a === b) same++;
  }
  return pairs ? same / pairs : null;
}

export interface Permutation {
  observed: number;
  /** Mean of the statistic over shuffles — what chance alone gives. */
  chanceMean: number;
  /** One-sided: share of shuffles with statistic >= observed, +1 smoothed (never exactly 0). */
  p: number;
  iterations: number;
}

export function permutationTest(
  labels: Label[],
  statistic: (shuffledLabels: Label[]) => number | null,
  iterations = 1000,
  seed = 12345,
): Permutation | null {
  const observed = statistic(labels);
  if (observed === null) return null;
  const rand = seededRandom(seed);
  let atLeast = 0;
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    const s = statistic(shuffled(labels, rand));
    const v = s ?? 0;
    sum += v;
    if (v >= observed - 1e-12) atLeast++;
  }
  return {
    observed,
    chanceMean: sum / iterations,
    p: (atLeast + 1) / (iterations + 1),
    iterations,
  };
}

export interface Run {
  label: string;
  length: number;
}

/** Maximal runs of the same known label; an unknown/missing day ends the run. */
export function runs(labels: Label[]): Run[] {
  const out: Run[] = [];
  let cur: Run | null = null;
  for (const l of labels) {
    if (!known(l)) {
      cur = null;
      continue;
    }
    if (cur && cur.label === l) cur.length++;
    else {
      cur = { label: l, length: 1 };
      out.push(cur);
    }
  }
  return out;
}

export function meanRunLength(labels: Label[]): number | null {
  const r = runs(labels);
  return r.length ? r.reduce((a, b) => a + b.length, 0) / r.length : null;
}

/** Rolling share (0..100) of days matching `pick` over a trailing window. */
export function rollingShare(
  days: { day: string; value: boolean | null }[],
  window: number,
): { time: string; value: number }[] {
  const out: { time: string; value: number }[] = [];
  const buf: boolean[] = [];
  for (const d of days) {
    if (d.value === null) continue;
    buf.push(d.value);
    if (buf.length > window) buf.shift();
    if (buf.length === window) {
      out.push({ time: d.day, value: (buf.filter(Boolean).length / window) * 100 });
    }
  }
  return out;
}

export interface CrossTab {
  rows: string[];
  cols: string[];
  counts: Record<string, Record<string, number>>;
  rowTotals: Record<string, number>;
  n: number;
}

/** Pairs (a[i], b[i]) from the same day, e.g. open-segment label vs close-segment label. */
export function crossTab(a: Label[], b: Label[], rows: string[], cols: string[]): CrossTab {
  const counts: Record<string, Record<string, number>> = {};
  const rowTotals: Record<string, number> = {};
  for (const r of rows) {
    counts[r] = Object.fromEntries(cols.map((c) => [c, 0]));
    rowTotals[r] = 0;
  }
  let n = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (!known(x) || !known(y) || !counts[x] || counts[x][y] === undefined) continue;
    counts[x][y] += 1;
    rowTotals[x] = (rowTotals[x] ?? 0) + 1;
    n++;
  }
  return { rows, cols, counts, rowTotals, n };
}

/** Pearson chi-square of independence; null when there is nothing to test. */
export function chiSquare(t: CrossTab): number | null {
  if (t.n === 0) return null;
  const colTotals = Object.fromEntries(
    t.cols.map((c) => [c, t.rows.reduce((s, r) => s + (t.counts[r]?.[c] ?? 0), 0)]),
  );
  let chi = 0;
  for (const r of t.rows) {
    for (const c of t.cols) {
      const expected = ((t.rowTotals[r] ?? 0) * (colTotals[c] ?? 0)) / t.n;
      if (expected > 0) chi += ((t.counts[r]?.[c] ?? 0) - expected) ** 2 / expected;
    }
  }
  return chi;
}

/** Does knowing segment A's label tell you anything about segment B's, beyond chance? */
export function associationTest(
  a: Label[],
  b: Label[],
  rows: string[],
  cols: string[],
  iterations = 1000,
  seed = 12345,
): Permutation | null {
  const observed = chiSquare(crossTab(a, b, rows, cols));
  if (observed === null) return null;
  const rand = seededRandom(seed);
  let atLeast = 0;
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    const v = chiSquare(crossTab(a, shuffled(b, rand), rows, cols)) ?? 0;
    sum += v;
    if (v >= observed - 1e-12) atLeast++;
  }
  return {
    observed,
    chanceMean: sum / iterations,
    p: (atLeast + 1) / (iterations + 1),
    iterations,
  };
}

/** A row (a conditioning state) with fewer observations than this is faded out. */
export const MIN_ROW_N = 20;
/** A cell is only called out when at least this many cases are behind it. */
export const MIN_CELL_COUNT = 5;
