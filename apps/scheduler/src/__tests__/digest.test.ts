import { describe, expect, it } from 'bun:test';
import { type DigestFacts, formatDigest, lastTradingDay, summariseJobs } from '../checks/digest.js';
import type { RunRow } from '../history.js';

const row = (
  id: number,
  job: string,
  exit: number | null,
  error: string | null = null,
): RunRow => ({
  id,
  job,
  trigger: 'schedule',
  scheduled_for: null,
  started_at: '2026-10-05T03:00:00Z',
  ended_at: exit === null ? null : '2026-10-05T03:01:00Z',
  exit_code: exit,
  attempts: 1,
  pid: 1,
  log_path: '',
  error,
});

const green = (over: Partial<DigestFacts> = {}): DigestFacts => ({
  ciRuns: [{ conclusion: 'success', status: 'completed', createdAt: '', url: 'u' }],
  jobs: [{ job: 'a', ok: 5, failed: 0, missed: 0, last: 'ok' }],
  optionsLastDay: '2026-10-09',
  optionsExpected: '2026-10-09',
  backupLast: 'Sun, 04 Oct at 10:00',
  ...over,
});

describe('summariseJobs', () => {
  it('counts ok, failed and missed runs, ignores unfinished ones, reports the last result', () => {
    const rows = [
      row(1, 'a', 0),
      row(2, 'a', 1, 'exit 1'),
      row(3, 'a', -1, 'missed'),
      row(4, 'a', null),
    ];
    expect(summariseJobs(rows, ['a', 'b'])).toEqual([
      { job: 'a', ok: 1, failed: 1, missed: 1, last: 'missed' },
      { job: 'b', ok: 0, failed: 0, missed: 0, last: null },
    ]);
  });
});

describe('formatDigest', () => {
  it('collapses an all-green week into one line of facts', () => {
    const { ok, text } = formatDigest('2026-10-10', green());
    expect(ok).toBe(true);
    expect(text.split('\n').filter((l) => l.startsWith('❌'))).toEqual([]);
    expect(text).toContain('all green');
    expect(text).toContain('CI on main passing · 5 job runs, none failed or missed');
  });

  it('gives each problem its own line', () => {
    const { ok, text } = formatDigest(
      '2026-10-10',
      green({
        ciRuns: [
          { conclusion: 'failure', status: 'completed', createdAt: '', url: 'https://ci/1' },
        ],
        jobs: [{ job: 'options-daily', ok: 3, failed: 1, missed: 1, last: 'exit 1' }],
        optionsLastDay: '2026-10-07',
      }),
    );
    expect(ok).toBe(false);
    expect(text).toContain('3 problems');
    expect(text).toContain('❌ CI on main: latest run failure → https://ci/1');
    expect(text).toContain('❌ options-daily: 3 ok, 1 failed, 1 missed (last: exit 1)');
    expect(text).toContain('❌ Options data: last day 2026-10-07, expected 2026-10-09');
  });

  it('reports GitHub being unreachable as a problem rather than saying nothing', () => {
    expect(formatDigest('2026-10-10', green({ ciRuns: null })).text).toContain(
      'could not ask GitHub',
    );
  });
});

describe('lastTradingDay', () => {
  it('steps back over the weekend from a Saturday', () => {
    const weekday = (d: string) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
    expect(lastTradingDay('2026-10-10', weekday)).toBe('2026-10-09');
  });
});
