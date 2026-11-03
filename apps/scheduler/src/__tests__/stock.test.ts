import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DeadlinesReport,
  type UniverseFile,
  builtins,
  caAgeCheck,
  checkUniverseRefresh,
  diskUniverseReader,
  evaluateCaAge,
  evaluateReviews,
  jobs,
  lastReviewDay,
  momentumDataDir,
  reviewQueueCheck,
} from '../checks/stock.js';
import type { BuiltinContext } from '../runner.js';

describe('universe refresh reminder (S3)', () => {
  const both =
    (info: UniverseFile | null, other: UniverseFile | null = info) =>
    (file: string) =>
      file === 'total_market_membership.csv' ? info : other;

  test('the review day is the latest 1 Apr or 1 Oct', () => {
    expect(lastReviewDay('2026-10-28')).toBe('2026-10-01');
    expect(lastReviewDay('2026-09-30')).toBe('2026-04-01');
    expect(lastReviewDay('2026-03-31')).toBe('2025-10-01');
    expect(lastReviewDay('2026-04-01')).toBe('2026-04-01');
  });
  test('quiet when refreshed since the last review', () => {
    const r = checkUniverseRefresh(
      '2026-10-28',
      both({ refreshedDay: '2026-10-02', newestYear: 2026 }),
    );
    expect(r.ok).toBe(true);
  });
  test('due when last refreshed before the review (the state on 2026-10-28)', () => {
    const r = checkUniverseRefresh(
      '2026-10-28',
      both(
        { refreshedDay: '2026-09-29', newestYear: 2026 },
        { refreshedDay: '2026-09-28', newestYear: 2026 },
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(
      'Total Market universe (total_market_membership.csv): last refreshed 2026-09-29',
    );
    expect(r.detail).toContain(
      'category membership (category_membership.csv): last refreshed 2026-09-28',
    );
  });
  test('due in a new year with no rows for it, and when a file is missing', () => {
    const jan = checkUniverseRefresh(
      '2027-01-04',
      both({ refreshedDay: '2026-10-05', newestYear: 2026 }),
    );
    expect(jan.ok).toBe(false);
    expect(jan.detail).toContain('no 2027 rows');
    const missing = checkUniverseRefresh(
      '2026-10-28',
      both(null, { refreshedDay: '2026-10-05', newestYear: 2026 }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('total_market_membership.csv does not exist');
    expect(missing.detail).not.toContain('category membership');
  });
  test('reads the file day and newest year from disk, and honours MOMENTUM_DATA_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'universe-'));
    mkdirSync(join(dir, 'categories'));
    const path = join(dir, 'categories', 'total_market_membership.csv');
    writeFileSync(path, 'category,year,symbol\nTotal Market,2025,A\nTotal Market,2026,B\n');
    const at = new Date('2026-09-29T08:00:00Z');
    utimesSync(path, at, at);
    const read = diskUniverseReader(dir);
    expect(read('total_market_membership.csv')).toEqual({
      refreshedDay: '2026-09-29',
      newestYear: 2026,
    });
    expect(read('category_membership.csv')).toBeNull();
    const ctx = { repoRoot: '/r', env: { MOMENTUM_DATA_DIR: dir } } as unknown as BuiltinContext;
    expect(momentumDataDir(ctx)).toBe(dir);
    expect(momentumDataDir({ ...ctx, env: {} })).toBe('/r/packages/momentum-backtesting/data');
  });
});

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
