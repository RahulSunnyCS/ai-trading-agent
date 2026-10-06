import { describe, expect, test } from 'bun:test';
import {
  type DeadlinesReport,
  builtins,
  caAgeCheck,
  evaluateCaAge,
  evaluateReviews,
  jobs,
  reviewQueueCheck,
} from '../checks/stock.js';
import type { BuiltinContext } from '../runner.js';

const ev = (age_days: number, company_id = 'C1') => ({
  company_id,
  ex_date: '2026-09-01',
  change: 'added',
  age_days,
  detail: 'x',
});
const report = (over: Partial<DeadlinesReport>): DeadlinesReport => ({
  ca_diff: { baseline: true, events: [] },
  reviews: { pending_count: 0, manual_review_after: '2026-09-25' },
  ...over,
});

describe('corporate-action baseline age', () => {
  test('nothing un-pinned is fine', () => {
    expect(evaluateCaAge(report({})).ok).toBe(true);
  });
  test('19 days is quiet, 20 warns, 31 says the sync is failing', () => {
    expect(evaluateCaAge(report({ ca_diff: { baseline: true, events: [ev(19)] } })).ok).toBe(true);
    const warn = evaluateCaAge(report({ ca_diff: { baseline: true, events: [ev(20)] } }));
    expect(warn.ok).toBe(false);
    expect(warn.detail).toContain('starts failing after 30 days');
    const failing = evaluateCaAge(report({ ca_diff: { baseline: true, events: [ev(31), ev(5)] } }));
    expect(failing.detail).toContain('already failing');
    expect(failing.detail).toContain('oldest 31 days');
  });
  test('no baseline is fine; a helper error is a problem', () => {
    expect(evaluateCaAge(report({ ca_diff: { baseline: false, events: [] } })).ok).toBe(true);
    const bad = evaluateCaAge(report({ ca_diff: { error: 'FileNotFoundError: daily.parquet' } }));
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('could not be checked');
  });
});

describe('review queue', () => {
  test('zero is fine', () => {
    expect(evaluateReviews(report({})).ok).toBe(true);
  });
  test('N events to review, with the dashboard link', () => {
    const r = evaluateReviews(
      report({ reviews: { pending_count: 3, manual_review_after: '2026-09-25' } }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('3 events to review');
    expect(r.detail).toContain('/momentum/weekly');
  });
  test('an unreadable catalog is a problem', () => {
    expect(evaluateReviews(report({ reviews: { error: 'locked' } })).ok).toBe(false);
  });
});

describe('builtins', () => {
  const ctx = { log: () => {}, repoRoot: '/x', env: {} } as unknown as BuiltinContext;
  test('exit codes follow the result, with the reader injected', async () => {
    const quiet = await caAgeCheck(async () => report({}))(ctx);
    expect(quiet).toEqual({ code: 0, error: null });
    const loud = await reviewQueueCheck(async () =>
      report({ reviews: { pending_count: 2, manual_review_after: 'd' } }),
    )(ctx);
    expect(loud.code).toBe(1);
    expect(loud.error).toContain('2 events to review');
  });
  test('every job has a builtin, none writes the catalog', () => {
    for (const job of jobs) {
      expect(builtins[job.builtin ?? '']).toBeDefined();
      expect(job.group).toBeUndefined();
    }
  });
});
