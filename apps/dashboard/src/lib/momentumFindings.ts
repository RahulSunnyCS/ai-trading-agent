/**
 * Findings on the Saved runs page (BL-052 Phase 3): a few lines worked out from the saved
 * strategies themselves, each pointing at where to act. No charts. The order is how much a
 * finding needs you: a moved result to review, a top result that cannot be traded, a result that
 * moved, a strategy that cannot be compared, the in-sample gap, then what was folded together.
 */
import type { SavedStrategy } from '../types/momentum';
import { formatDay, formatPct, formatPp } from './format';
import { cagrMove } from './momentumSaved';

export const MAX_FINDINGS = 5;

/** The two Broad settings whose "off" makes a result untradable (`runs_store._trust`). */
const REALISM_FLAGS = ['broad_liquidity_filter', 'broad_respect_circuits'] as const;
/** Never part of the comparison between a strategy and its tradable version. */
const NOT_COMPARED = new Set(['dataset', 'universe', 'end', 'fresh', ...REALISM_FLAGS]);

export type FindingAction =
  | { kind: 'open'; id: string; label: string }
  | { kind: 'compare'; ids: [string, string]; label: string }
  | { kind: 'guide'; label: string };

export interface Finding {
  id: string;
  tone: 'negative' | 'warning' | 'info' | 'neutral';
  title: string;
  detail: string;
  action: FindingAction | null;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cagr(strategy: SavedStrategy): number | null {
  const value = strategy.latest.kpis.cagr;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${key}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The saved strategy that is `strategy` with the tradability filter and the circuit rule both
 * on, all else equal (settings the dataset never reads aside): what its result would have been
 * if it could be traded. Null when none is saved.
 */
export function tradableTwin(
  strategy: SavedStrategy,
  strategies: ReadonlyArray<SavedStrategy>,
  ignored: ReadonlyArray<string> = [],
): SavedStrategy | null {
  if (strategy.dataset !== 'broad' || strategy.trust !== 'not_tradable') return null;
  const skip = new Set([...NOT_COMPARED, ...ignored]);
  const key = (config: Record<string, unknown>) =>
    canonical(Object.fromEntries(Object.entries(config).filter(([name]) => !skip.has(name))));
  const own = key(strategy.config_full);
  return (
    strategies.find(
      (other) =>
        other.id !== strategy.id &&
        other.dataset === 'broad' &&
        !other.group &&
        REALISM_FLAGS.every((flag) => other.config_full[flag] === true) &&
        key(other.config_full) === own,
    ) ?? null
  );
}

/** The findings, most pressing first, at most `MAX_FINDINGS`. `nameOf` gives the shown name. */
export function savedFindings(
  strategies: ReadonlyArray<SavedStrategy>,
  nameOf: (strategy: SavedStrategy) => string,
  ignoredFields: Record<string, ReadonlyArray<string>> = {},
): Finding[] {
  const all = strategies.flatMap((s) => [s, ...(s.members ?? [])]).filter((s) => !s.group);
  const findings: Finding[] = [];

  // 1. Moved results nobody has reviewed: Not reproducible before Check.
  const toReview = all
    .filter((s) => s.change?.needs_review)
    .sort(
      (a, b) =>
        Number(b.change?.label === 'not_reproducible') -
        Number(a.change?.label === 'not_reproducible'),
    );
  const first = toReview[0];
  if (first?.change) {
    const bug = first.change.label === 'not_reproducible';
    findings.push({
      id: 'review',
      tone: bug ? 'negative' : 'warning',
      title:
        toReview.length > 1
          ? `${toReview.length} moved results need a look`
          : bug
            ? `${nameOf(first)}: result not reproducible`
            : `${nameOf(first)}: result moved with no known cause`,
      detail: bug
        ? 'Same settings, code and data gave a different result: a bug. Open it to see where the curves first differ.'
        : 'The code changed and no accepted change to the frozen test results explains it. Re-run it to check, then mark it reviewed.',
      action: { kind: 'open', id: first.id, label: 'Review it ›' },
    });
  }

  // 2. The highest CAGR cannot be traded as tested.
  const ranked = all
    .filter((s) => cagr(s) !== null)
    .sort((a, b) => (cagr(b) ?? 0) - (cagr(a) ?? 0));
  const top = ranked[0];
  if (top?.trust === 'not_tradable') {
    const twin = tradableTwin(top, all, ignoredFields.broad ?? []);
    findings.push({
      id: 'not-tradable',
      tone: 'warning',
      title: 'Your highest CAGR is not tradable as tested',
      detail: twin
        ? `${nameOf(top)} (${formatPct(cagr(top))}) buys stocks too thin to fill or fills on circuit-locked days. The same settings with both rules on is ${nameOf(twin)}: ${formatPct(cagr(twin))}.`
        : `${nameOf(top)} (${formatPct(cagr(top))}) was run with the tradability filter or the circuit rule off. Re-run it with both on to see what is tradable.`,
      action: twin
        ? { kind: 'compare', ids: [top.id, twin.id], label: 'Compare the two ›' }
        : { kind: 'open', id: top.id, label: 'Open it ›' },
    });
  }

  // 3. A result that moved for a known (or unrecorded) reason.
  const moved = all.find(
    (s) => s.change && !s.change.needs_review && s.latest.outcome === 'new_result',
  );
  if (moved?.change) {
    const before = moved.change.kpis_before?.cagr;
    const after = moved.change.kpis_after?.cagr;
    const why =
      moved.change.label === 'data_revised'
        ? 'the data was revised in between'
        : moved.change.label === 'intended'
          ? 'an accepted code change explains it'
          : 'it was saved before runs recorded their code and data, so the cause is unknown';
    findings.push({
      id: 'moved',
      tone: 'info',
      title: 'Same settings, different result',
      detail: `${nameOf(moved)}: ${formatPct(before)} then ${formatPct(after)} (${formatPp(cagrMove(moved.change))}); ${why}.`,
      action: { kind: 'open', id: moved.id, label: 'See its history ›' },
    });
  }

  // 4. A strategy that cannot be compared with the rest: old data, or another start.
  const starts = new Map<string, number>();
  for (const s of all) {
    const start = String(s.config_full.start ?? '');
    starts.set(start, (starts.get(start) ?? 0) + 1);
  }
  const usual = [...starts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const odd = all.find(
    (s) =>
      s.trust === 'old_data' || (all.length > 2 && String(s.config_full.start ?? '') !== usual),
  );
  if (odd) {
    const reasons = [
      odd.trust === 'old_data' && odd.latest.data_through
        ? `its data ends ${formatDay(odd.latest.data_through)}`
        : null,
      String(odd.config_full.start ?? '') !== usual
        ? `it starts ${formatDay(String(odd.config_full.start))} while most start ${formatDay(usual ?? '')}`
        : null,
    ].filter(Boolean);
    findings.push({
      id: 'not-comparable',
      tone: 'warning',
      title: `${nameOf(odd)} is not comparable with the rest`,
      detail: `${capitalise(reasons.join(', and '))}. Re-run it on the latest data with the usual start to compare it.`,
      action: { kind: 'open', id: odd.id, label: 'Open it ›' },
    });
  }

  // 5. The validated favourites score lower than the best in-sample results, as they should.
  const validated = all.filter((s) => s.trust === 'validated');
  const bestValidated = Math.max(...validated.map((s) => cagr(s) ?? Number.NEGATIVE_INFINITY));
  const higher = all.filter(
    (s) => s.trust !== 'validated' && (cagr(s) ?? Number.NEGATIVE_INFINITY) > bestValidated,
  );
  if (validated.length > 0 && higher.length > 0) {
    findings.push({
      id: 'in-sample',
      tone: 'neutral',
      title: 'The validated strategies are lower than the best backtests, by design',
      detail: `${higher.length} saved ${higher.length === 1 ? 'strategy beats' : 'strategies beat'} the best validated one (${formatPct(bestValidated)}). They are the best of what was tried on the same data (in-sample); the validated ones were chosen by walk-forward and tested on data their choice never saw.`,
      action: { kind: 'guide', label: 'What in-sample means ›' },
    });
  }

  // 6. Repeats folded into their strategies.
  const runs = all.reduce((sum, s) => sum + s.runs, 0);
  if (runs > all.length) {
    findings.push({
      id: 'folded',
      tone: 'neutral',
      title: `${runs} saved runs are ${all.length} strategies`,
      detail:
        'Runs of the same settings are one strategy: a repeat adds to its run count, a different result to its history. Each keeps its last three repeats.',
      action: null,
    });
  }

  return findings.slice(0, MAX_FINDINGS);
}
