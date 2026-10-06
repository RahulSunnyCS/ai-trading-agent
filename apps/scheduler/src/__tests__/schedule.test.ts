import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDotenv } from '../env.js';
import { JOBS } from '../jobs.js';
import { istAt, istDay, nextDue, onWeekdays, previousDue, tradingDays } from '../schedule.js';

const morning = { at: '08:00', on: tradingDays, label: '' };

describe('IST time', () => {
  it('converts IST wall-clock to the right UTC instant', () => {
    expect(istAt('2026-10-06', '08:00').toISOString()).toBe('2026-10-06T02:30:00.000Z');
    expect(istDay(new Date('2026-10-05T19:00:00Z'))).toBe('2026-10-06'); // 00:30 IST
  });
});

describe('schedules', () => {
  it('skips weekends and NSE holidays for trading-day jobs', () => {
    // Thu 1 Oct 2026 21:00 IST → next is Mon 5 Oct: Fri 2 Oct is Gandhi Jayanti.
    const now = istAt('2026-10-01', '21:00');
    expect(nextDue(morning, now)?.toISOString()).toBe(istAt('2026-10-05', '08:00').toISOString());
  });

  it('finds the most recent slot, including today once its time has passed', () => {
    expect(previousDue(morning, istAt('2026-10-06', '07:59'))?.toISOString()).toBe(
      istAt('2026-10-05', '08:00').toISOString(),
    );
    expect(previousDue(morning, istAt('2026-10-06', '08:00'))?.toISOString()).toBe(
      istAt('2026-10-06', '08:00').toISOString(),
    );
  });

  it('runs weekday jobs on holidays too (momentum handles a closed market itself)', () => {
    const friday = { at: '14:40', on: onWeekdays(5), label: '' };
    expect(nextDue(friday, istAt('2026-10-01', '12:00'))?.toISOString()).toBe(
      istAt('2026-10-02', '14:40').toISOString(),
    );
  });
});

describe('job registry', () => {
  const repoRoot = resolve(import.meta.dirname, '../../../..');

  it('has unique ids, real working directories and a fix hint for every job', () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    for (const job of JOBS) {
      expect(existsSync(join(repoRoot, job.cwd))).toBe(true);
      expect(job.fixHint.length).toBeGreaterThan(0);
      expect(job.steps.length).toBeGreaterThan(0);
    }
  });
});

describe('.env parsing', () => {
  it('handles export, quotes and comments', () => {
    const env = parseDotenv(
      [
        '# comment',
        'export A=1',
        'B="two words"',
        "C='x#y'",
        'D=plain # trailing',
        'bad line',
      ].join('\n'),
    );
    expect(env).toEqual({ A: '1', B: 'two words', C: 'x#y', D: 'plain' });
  });
});
