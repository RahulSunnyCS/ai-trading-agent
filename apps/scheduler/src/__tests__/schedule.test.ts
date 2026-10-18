import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allBuiltins } from '../builtins.js';
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

  it('has no scheduled Fyers login: Fyers put a human check on its login page (2026-10-10)', () => {
    expect(JOBS.find((j) => j.id === 'fyers-login')).toBeUndefined();
  });

  it('has a registered builtin for every job that names one', () => {
    const builtins = allBuiltins();
    for (const job of JOBS) if (job.builtin) expect(builtins[job.builtin]).toBeDefined();
  });

  it('has unique ids, real working directories and a fix hint for every job', () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    for (const job of JOBS) {
      expect(existsSync(join(repoRoot, job.cwd))).toBe(true);
      expect(job.fixHint.length).toBeGreaterThan(0);
      expect(job.steps.length > 0 || job.builtin !== undefined).toBe(true);
    }
  });

  it('stores the day, then the T1 results, in the evening run, and sends from it only after 16:00', () => {
    const evening = JOBS.find((job) => job.id === 'options-evening');
    expect(evening?.schedule.at).toBe('15:45');
    const options = ['uv', 'run', '--directory', 'packages/option-backtesting', 'obt'];
    expect(evening?.steps).toContainEqual([...options, 'rotation', 'update']);
    // a T1 failure alerts itself and exits 0 (--soft-fail): it can never fail the evening run,
    // whose retries would re-run `obt daily` and resend its Telegram summary
    expect(evening?.steps.at(-2)).toEqual([
      ...options,
      'rotation',
      'update',
      '--track',
      't1',
      '--soft-fail',
    ]);
    // the last step sends the result when this run only completes on a late retry (a failed
    // 16:00 slot is never caught up); before 16:00 it sends nothing, and it never fails the run
    expect(evening?.steps.at(-1)).toEqual([
      ...options,
      'rotation',
      'result',
      '--not-before',
      '16:00',
      '--soft-fail',
    ]);
    // the live update runs before the track's, which ranks over the same days
    const steps = evening?.steps.map((step) => step.join(' ')) ?? [];
    expect(steps.indexOf(`${options.join(' ')} rotation update`)).toBeLessThan(
      steps.indexOf(`${options.join(' ')} rotation update --track t1 --soft-fail`),
    );
    // only the two BL-125 steps are soft: every other step still fails the run (and retries it)
    expect(evening?.steps.filter((step) => step.includes('--soft-fail'))).toHaveLength(2);
  });

  it('sends what is owed at 21:00 before a strict T1 update that fails (and retries) the job', () => {
    const t1 = JOBS.find((job) => job.id === 'options-rotation-t1-update');
    // a soft result first, so a T1 failure never costs the Adaptive result
    expect(t1?.steps[0]?.includes('result') && t1?.steps[0]?.includes('--soft-fail')).toBe(true);
    // the update itself is strict: a failure fails the job, so its 22:00 / 23:00 retries run
    expect(t1?.steps[1]?.includes('--soft-fail')).toBe(false);
    expect(t1?.retries).toBeGreaterThan(0);
    expect(t1?.steps.at(-1)?.includes('--soft-fail')).toBe(false); // a failed result still alerts
  });

  it('sends the rotation result at 16:00, retrying every 5 minutes until 16:35', () => {
    const result = JOBS.find((job) => job.id === 'options-rotation-result');
    expect(result?.schedule.at).toBe('16:00');
    expect(result?.steps).toEqual([
      [
        'uv',
        'run',
        '--directory',
        'packages/option-backtesting',
        'obt',
        'rotation',
        'result',
        '--wait-until',
        '16:25',
      ],
    ]);
    // 16:00 + 7 retries x 5 min = 16:35; the message goes at 16:25 at the latest, the rest is spare
    expect(result?.retries).toBe(7);
    expect(result?.retryDelayMinutes).toBe(5);
    expect(result?.catchUpHours).toBeGreaterThan(0);
    expect(result?.group).toBeUndefined(); // it only reads journal and result files
    expect(result?.alertsItself).toBeFalsy(); // a result that never completes alerts the owner
  });

  it('runs on trading days only', () => {
    const result = JOBS.find((job) => job.id === 'options-rotation-result');
    expect(result?.schedule.on('2026-10-17')).toBe(false); // Saturday
    expect(result?.schedule.on('2026-10-19')).toBe(true); // Monday
  });
});

describe('T1 parallel track', () => {
  it('records the live and the track pick in one step, so one message can carry both', () => {
    const pick = JOBS.find((job) => job.id === 'options-rotation-pick');
    expect(pick?.steps).toEqual([['uv', 'run', 'obt', 'rotation', 'pick', '--with-t1']]);
    expect(pick?.alertsItself).toBe(true);
    expect(pick?.catchUpHours).toBe(0);
  });

  it('keeps a 21:00 catch-up that stores missing T1 days and delivers a late T1 result', () => {
    const t1 = JOBS.find((job) => job.id === 'options-rotation-t1-update');
    expect(t1?.schedule.at).toBe('21:00');
    const options = ['uv', 'run', '--directory', 'packages/option-backtesting', 'obt'];
    expect(t1?.steps).toEqual([
      [...options, 'rotation', 'result', '--soft-fail'],
      [...options, 'rotation', 'update', '--track', 't1'],
      [...options, 'rotation', 'result'],
    ]);
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

  it('drops the quotes when a quoted value is followed by an inline comment', () => {
    expect(parseDotenv('A="abc-100" # app id\nB=\'x y\'  # c')).toEqual({ A: 'abc-100', B: 'x y' });
  });
});
