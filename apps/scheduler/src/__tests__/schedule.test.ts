import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allBuiltins } from '../builtins.js';
import { parseDotenv } from '../env.js';
import { JOBS } from '../jobs.js';
import { istAt, istDay, nextDue, onWeekdays, previousDue, tradingDays } from '../schedule.js';

const morning = { at: '08:00', on: tradingDays, label: '' };
/** The first time of day of a schedule (most jobs have exactly one). */
const firstAt = (at: string | string[] | undefined): string =>
  (Array.isArray(at) ? at[0] : at) ?? '';

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

  it('treats each of several times as a slot of its own, in any order given (BL-234)', () => {
    const many = { at: ['15:30', '07:30', '10:30'], on: tradingDays, label: '' };
    const tuesday = '2026-10-06';
    expect(previousDue(many, istAt(tuesday, '07:29'))?.toISOString()).toBe(
      istAt('2026-10-05', '15:30').toISOString(),
    );
    expect(previousDue(many, istAt(tuesday, '07:30'))?.toISOString()).toBe(
      istAt(tuesday, '07:30').toISOString(),
    );
    expect(previousDue(many, istAt(tuesday, '12:00'))?.toISOString()).toBe(
      istAt(tuesday, '10:30').toISOString(),
    );
    expect(nextDue(many, istAt(tuesday, '10:30'))?.toISOString()).toBe(
      istAt(tuesday, '15:30').toISOString(),
    );
    // the last slot of a day is followed by the first of the next trading day: Thu 1 Oct 15:31
    // -> Mon 5 Oct, since Fri 2 Oct is a holiday and the weekend follows
    expect(nextDue(many, istAt('2026-10-01', '15:31'))?.toISOString()).toBe(
      istAt('2026-10-05', '07:30').toISOString(),
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
      expect(job.steps.length > 0 || job.builtin !== undefined || job.chain !== undefined).toBe(
        true,
      );
    }
  });

  it('keeps every chain well formed: no job-level retries, unique steps, requires point backwards (BL-234)', () => {
    const chains = JOBS.filter((j) => j.chain);
    expect(chains.map((j) => j.id).sort()).toEqual(['close-out', 'evening', 'morning-topup']);
    for (const job of chains) {
      expect(job.steps, job.id).toEqual([]);
      expect(job.retries, job.id).toBe(0); // a step retries on its own, never the whole chain
      const seen: string[] = [];
      for (const step of job.chain ?? []) {
        expect(seen, `${job.id}/${step.id}`).not.toContain(step.id);
        for (const need of step.requires ?? []) expect(seen, `${step.id} requires`).toContain(need);
        expect(step.fixHint.length).toBeGreaterThan(0);
        expect(existsSync(join(repoRoot, step.cwd ?? job.cwd))).toBe(true);
        seen.push(step.id);
      }
    }
  });

  it('stores the day, then the T1 results, then sends the result only after 16:00, in the evening chain', () => {
    const evening = JOBS.find((job) => job.id === 'evening');
    expect(evening?.schedule.at).toBe('15:45');
    const chain = evening?.chain ?? [];
    const options = ['uv', 'run', '--directory', 'packages/option-backtesting', 'obt'];
    const ids = chain.map((step) => step.id);
    expect(ids).toEqual([
      'collect',
      'rotation-update',
      'derived-rebuild',
      't1-update',
      'result',
      'algotest-export',
      'algotest-upload',
      'algotest-setup',
      'quantiply-export',
      'quantiply-upload',
      't1-catch-up',
      't1-result',
    ]);
    const step = (id: string) => chain.find((s) => s.id === id);
    expect(step('collect')?.argv).toEqual([...options, 'daily']);
    expect(step('rotation-update')?.argv).toEqual([...options, 'rotation', 'update']);
    // a T1 failure alerts itself and exits 0 (--soft-fail): it can never stop the chain
    expect(step('t1-update')?.argv).toEqual([
      ...options,
      'rotation',
      'update',
      '--track',
      't1',
      '--soft-fail',
    ]);
    // the live update runs before the track's, which ranks over the same days
    expect(ids.indexOf('rotation-update')).toBeLessThan(ids.indexOf('t1-update'));
    // the data steps retry through the evening (15:45, 17:15, 18:45, 20:15) and stop the chain
    for (const id of ['collect', 'rotation-update', 'derived-rebuild']) {
      expect(step(id)?.retries, id).toBe(3);
      expect(step(id)?.retryDelayMinutes, id).toBe(90);
      expect(step(id)?.group, id).toBe('catalog');
      expect(step(id)?.onFail ?? 'stop', id).toBe('stop');
    }
    // the chain keeps no job-level group: its steps take theirs when they get to them
    expect(evening?.group).toBeUndefined();
    expect(evening?.catchUpHours).toBe(7.25);
  });

  it('sends the rotation result at 16:00, retrying every 5 minutes until 16:35, and never stops the uploads', () => {
    const result = JOBS.find((job) => job.id === 'evening')?.chain?.find((s) => s.id === 'result');
    expect(result?.notBefore).toBe('16:00');
    expect(result?.argv).toEqual([
      'uv',
      'run',
      '--directory',
      'packages/option-backtesting',
      'obt',
      'rotation',
      'result',
      '--wait-until',
      '16:25',
    ]);
    // 16:00 + 7 retries x 5 min = 16:35; the message goes at 16:25 at the latest, the rest is spare
    expect(result?.retries).toBe(7);
    expect(result?.retryDelayMinutes).toBe(5);
    expect(result?.onFail).toBe('continue');
    expect(result?.group).toBeUndefined(); // it only reads journal and result files
    expect(result?.alertsItself).toBeFalsy(); // a result that never completes alerts the owner
  });

  it('uploads to AlgoTest and Quantiply after the result, each platform on its own, held by its old job id', () => {
    const chain = JOBS.find((job) => job.id === 'evening')?.chain ?? [];
    const step = (id: string) => chain.find((s) => s.id === id);
    const at = (id: string) => chain.findIndex((s) => s.id === id);
    expect(at('algotest-export')).toBeGreaterThan(at('result'));
    expect(at('quantiply-export')).toBeGreaterThan(at('result'));
    // upload needs its export, setup its upload; a failed AlgoTest step never stops Quantiply's
    expect(step('algotest-upload')?.requires).toEqual(['algotest-export']);
    expect(step('algotest-setup')?.requires).toEqual(['algotest-upload']);
    expect(step('quantiply-upload')?.requires).toEqual(['quantiply-export']);
    for (const id of [
      'algotest-export',
      'algotest-upload',
      'algotest-setup',
      'quantiply-export',
      'quantiply-upload',
    ]) {
      expect(step(id)?.onFail, id).toBe('continue');
      expect(step(id)?.noRetryExitCodes, id).toEqual([3]);
      expect(step(id)?.holdId, id).toBe(
        id.startsWith('algotest') ? 'algotest-evening' : 'quantiply-evening',
      );
    }
    // only the Quantiply steps need the Quantiply group; AlgoTest has none
    expect(step('algotest-upload')?.group).toBeUndefined();
    expect(step('quantiply-upload')?.group).toBe('quantiply');
    // the AlgoTest upload keeps its delete flag (owner, 2026-10-20)
    expect(step('algotest-upload')?.argv).toContain('--allow-delete');
  });

  it('ends with the T1 catch-up: a strict update that retries, then the result', () => {
    const chain = JOBS.find((job) => job.id === 'evening')?.chain ?? [];
    expect(chain.at(-2)).toMatchObject({
      id: 't1-catch-up',
      retries: 2,
      retryDelayMinutes: 60,
      group: 'catalog',
    });
    expect(chain.at(-2)?.argv).not.toContain('--soft-fail'); // a failure is reported and retried
    expect(chain.at(-1)?.argv.at(-1)).toBe('result');
    expect(chain.at(-1)?.argv).not.toContain('--soft-fail'); // a failed result still alerts
  });

  it('is resumed after a restart until 23:00, and the old five jobs are gone', () => {
    expect(JOBS.find((job) => job.id === 'evening')?.restartIfInterruptedUntil).toBe('23:00');
    for (const id of [
      'options-evening',
      'options-rotation-result',
      'options-rotation-t1-update',
      'algotest-evening',
      'quantiply-evening',
    ])
      expect(
        JOBS.find((job) => job.id === id),
        id,
      ).toBeUndefined();
  });

  it('collects the MCX session after its close on weekdays, and a retry after midnight keeps that session', () => {
    const mcx = JOBS.find((job) => job.id === 'mcx-collect');
    expect(mcx?.schedule.at).toBe('23:31');
    expect(mcx?.steps).toEqual([
      ['uv', 'run', '--directory', 'packages/option-backtesting', 'obt', 'fyers', 'mcx-daily'],
    ]);
    // a missing or refused Fyers token (exit 2) is not retried: a retry cannot log in
    expect(mcx?.noRetryExitCodes).toEqual([2]);
    expect(mcx?.group).toBe('catalog');
    // the command waits up to 25 minutes for the winter close, then asks for ~5,000 contracts
    expect((mcx?.timeoutMinutes ?? 0) >= 90).toBe(true);
    // Mon-Fri including NSE holidays (MCX trades most holiday evenings); never Saturday
    const slot = mcx?.schedule;
    expect(slot?.on('2026-10-02')).toBe(true); // Gandhi Jayanti: an NSE holiday
    expect(slot?.on('2026-10-03')).toBe(false); // Saturday
    // at 00:20 the slot still due is yesterday's 23:31, inside the catch-up window (to 05:30)
    const after = istAt('2026-11-12', '00:20');
    const due = slot ? previousDue(slot, after) : null;
    expect(due?.toISOString()).toBe(istAt('2026-11-11', '23:31').toISOString());
    expect((after.getTime() - (due?.getTime() ?? 0)) / 3_600_000).toBeLessThan(
      mcx?.catchUpHours ?? 0,
    );
    // Friday night's slot is still caught up in the early hours of Saturday
    expect(previousDue(slot!, istAt('2026-11-14', '01:00'))?.toISOString()).toBe(
      istAt('2026-11-13', '23:31').toISOString(),
    );
  });

  it('the evening chain runs on trading days only', () => {
    const evening = JOBS.find((job) => job.id === 'evening');
    expect(evening?.schedule.on('2026-10-17')).toBe(false); // Saturday
    expect(evening?.schedule.on('2026-10-19')).toBe(true); // Monday
  });
});

describe('live board (BL-203)', () => {
  it('runs one process from after the pick to the close, never retrying a refused login', () => {
    const board = JOBS.find((job) => job.id === 'rotation-live-board');
    expect(board?.schedule.at).toBe('09:18');
    expect(board?.steps).toEqual([
      ['/usr/bin/caffeinate', '-i', 'uv', 'run', 'obt', 'rotation', 'live-board', 'run'],
    ]);
    expect(board?.noRetryExitCodes).toEqual([3]);
    expect(board?.group).toBeUndefined();
    expect(board?.restartIfInterruptedUntil).toBe('15:25');
  });
});

describe('T1 parallel track', () => {
  it('records the live and the track entry in one step at 08:45, before the first entry', () => {
    const pick = JOBS.find((job) => job.id === 'options-rotation-pick');
    expect(pick?.steps).toEqual([['uv', 'run', 'obt', 'rotation', 'pick', '--with-t1']]);
    expect(pick?.alertsItself).toBe(true);
    expect(pick?.schedule).toMatchObject({ at: '08:45' });
    // caught up only while it can still record before the 09:17 first entry
    expect(pick?.catchUpHours).toBe(0.5);
  });
});

describe('Angel One login check', () => {
  const angel = JOBS.find((job) => job.id === 'angel-login-check');

  it('runs the guarded check at 08:00 on trading days, as a scheduled run', () => {
    expect(angel?.schedule.at).toBe('08:00');
    expect(angel?.schedule.on('2026-10-17')).toBe(false); // Saturday
    expect(angel?.schedule.on('2026-10-19')).toBe(true); // Monday
    expect(angel?.cwd).toBe('packages/option-backtesting');
    expect(angel?.steps).toEqual([['uv', 'run', 'obt', 'angel', 'test', '--scheduled']]);
  });

  it('retries once, after its own 60 s cool-down, and catches up only until 09:10', () => {
    expect(angel?.retries).toBe(1);
    expect((angel?.retryDelayMinutes ?? 0) * 60).toBeGreaterThan(60);
    expect(angel?.catchUpHours).toBeCloseTo(70 / 60);
    // the scheduler sends the failure alert: the CLI only exits non-zero
    expect(angel?.alertsItself).toBeFalsy();
  });

  it('has 33 jobs', () => {
    // BL-141: + live-capture, live-capture-retry; BL-143: + trade-monitor; BL-168: + contract-notes, contract-notes-retry, contract-notes-capital; + contract-notes-retry-1030, -1530
    // BL-012: + check-expiry-calendar (Y4), check-blocked-dates (Y3), universe-refresh-reminder (S3)
    // BL-024: + momentum-journal-score
    // BL-001 Phase 4: + momentum-history
    // phone login: + fyers-login-reminder, fyers-login-recheck, kite-login-reminder-monday
    // BL-203: + rotation-live-board
    // BL-197 Phase 2: + algotest-activate, - algotest-deploy, - algotest-topup
    // owner 2026-11-05: + momentum-orders-tentative (Thu 18:30)
    // BL-148 Phase 4: + mcx-collect (weekdays 23:31)
    // BL-219: + mcx-forward-spread (weekdays 18:00), mcx-forward-score (Tue-Sat 01:30)
    // BL-234 Phase 1: - 7 daily checks (9 become 2 suites), - 3 contract-notes retries
    // BL-234 Phase 2: - fyers-login-recheck, algotest-deploy-check, live-capture, live-capture-retry,
    // quantiply-disable, contract-notes-capital (6 become the close-out chain), - quantiply-topup,
    // quantiply-deploy-topup (2 become morning-topup)
    // BL-234 Phase 3: - options-evening, options-rotation-result, options-rotation-t1-update,
    // algotest-evening, quantiply-evening (5 become the evening chain)
    expect(JOBS).toHaveLength(33);
  });
});

describe('gold Dir forward test (BL-219)', () => {
  it('reads the spread at 18:00 on weekdays and scores the evening just held at 01:30', () => {
    const spread = JOBS.find((job) => job.id === 'mcx-forward-spread');
    expect(spread?.schedule.at).toBe('18:00');
    expect(spread?.steps).toEqual([
      ['uv', 'run', '--directory', 'packages/option-backtesting', 'obt', 'mcx-forward', 'spread'],
    ]);
    expect(spread?.schedule.on('2026-11-23')).toBe(true); // a Monday
    expect(spread?.schedule.on('2026-11-28')).toBe(false); // a Saturday
    const score = JOBS.find((job) => job.id === 'mcx-forward-score');
    expect(score?.schedule.at).toBe('01:30');
    expect(score?.steps).toEqual([
      ['uv', 'run', '--directory', 'packages/option-backtesting', 'obt', 'mcx-forward', 'score'],
    ]);
    // 01:30 Tuesday scores Monday's evening: Tue-Sat only, never Sunday or Monday morning
    expect(score?.schedule.on('2026-11-24')).toBe(true);
    expect(score?.schedule.on('2026-11-28')).toBe(true); // Saturday 01:30 = Friday's session
    expect(score?.schedule.on('2026-11-29')).toBe(false);
    expect(score?.schedule.on('2026-11-30')).toBe(false);
    expect(score?.group).toBe('catalog'); // queues behind the collector
    expect(score?.noRetryExitCodes).toEqual([2]);
  });
});

describe('login reminders (phone login)', () => {
  const byId = (id: string) => JOBS.find((j) => j.id === id);
  it('reminds about Fyers at 08:05 on trading days, never retried; the 15:30 re-check is a close-out step', () => {
    const job = byId('fyers-login-reminder');
    expect(job?.schedule.at).toBe('08:05');
    expect(job?.steps).toEqual([
      ['uv', 'run', 'mbt', 'token-remind', '--send', '--when', 'morning'],
    ]);
    expect(job?.retries).toBe(0);
    expect(job?.schedule.on('2026-10-28')).toBe(true); // a Wednesday
    expect(job?.schedule.on('2026-10-31')).toBe(false); // a Saturday
    const recheck = byId('close-out')?.chain?.find((s) => s.id === 'fyers-login-recheck');
    expect(recheck?.argv).toEqual([
      'uv',
      'run',
      'mbt',
      'token-remind',
      '--send',
      '--when',
      'evening',
    ]);
    // a reminder to log in before the 15:45 collection is of no use after it
    expect(recheck?.notAfter).toBe('15:45');
    expect(byId('fyers-login-recheck')).toBeUndefined();
  });
  it('reminds about Kite on trading Mondays at 08:45 with the Monday wording', () => {
    const job = byId('kite-login-reminder-monday');
    expect(job?.schedule.at).toBe('08:45');
    expect(job?.steps[0]).toContain('monday');
    expect(job?.schedule.on('2026-10-26')).toBe(true); // a Monday
    expect(job?.schedule.on('2026-10-30')).toBe(false); // a Friday
    expect(byId('kite-login-reminder')?.schedule.on('2026-10-30')).toBe(true);
  });
});

describe('forward-journal score (BL-024 Phases 2-3)', () => {
  const job = JOBS.find((j) => j.id === 'momentum-journal-score');
  it('runs on Fridays after the 19:30 run and before the 21:00 check, in the catalog group', () => {
    expect(job?.schedule.at).toBe('20:30');
    expect(job?.group).toBe('catalog');
    expect(job?.steps).toEqual([['uv', 'run', 'mbt', 'journal', 'score']]);
    // it sends nothing itself, so the scheduler alerts a failure
    expect(job?.alertsItself).toBeFalsy();
  });
});

describe('momentum history check (BL-001 Phase 4)', () => {
  const job = JOBS.find((j) => j.id === 'momentum-history');
  const friday = '2026-10-30';

  it('runs mbt verify history --send on Fridays, after the 19:30 stock sync has had its time', () => {
    const ingest = JOBS.find((j) => j.id === 'momentum-stock-ingest');
    expect(job?.steps).toEqual([['uv', 'run', 'mbt', 'verify', 'history', '--send']]);
    expect(job?.cwd).toBe('packages/momentum-backtesting');
    expect(job?.schedule.on(friday)).toBe(true);
    expect(job?.schedule.on('2026-10-29')).toBe(false); // Thursday
    const ingestEnd =
      istAt(friday, firstAt(ingest?.schedule.at)).getTime() +
      (ingest?.timeoutMinutes ?? 0) * 60_000;
    expect(istAt(friday, firstAt(job?.schedule.at)).getTime()).toBeGreaterThanOrEqual(ingestEnd);
  });

  it('shares the catalog group with every Friday momentum job that can still run at its slot', () => {
    // Read-only, but DuckDB will not open the catalog read-only while another process writes:
    // the group is what keeps it apart from the stock sync and the 21:00 / 21:30 checks.
    expect(job?.group).toBe('catalog');
    for (const id of ['momentum-stock-ingest', 'momentum-journal-check', 'momentum-live-rules'])
      expect(JOBS.find((j) => j.id === id)?.group).toBe('catalog');
  });

  it('sends its own alerts, so the scheduler never repeats one', () => {
    expect(job?.alertsItself).toBe(true);
  });
});

describe('live capture (BL-141), in the close-out chain (BL-234)', () => {
  const close = () => JOBS.find((j) => j.id === 'close-out');
  const step = (id: string) => close()?.chain?.find((s) => s.id === id);
  const minutes = (hhmm?: string) => {
    const [h = 0, m = 0] = (hhmm ?? '').split(':').map(Number);
    return h * 60 + m;
  };

  it('the chain starts at 15:30 on trading days, in the Quantiply group, resumed after a restart', () => {
    expect(close()?.schedule.at).toBe('15:30');
    expect(close()?.schedule.on('2026-10-20')).toBe(false); // a market holiday
    expect(close()?.group).toBe('quantiply');
    expect(close()?.restartIfInterruptedUntil).toBe('16:30');
    expect(close()?.chain?.map((s) => s.id)).toEqual([
      'fyers-login-recheck',
      'algotest-deploy-check',
      'live-capture',
      'quantiply-disable',
      'contract-notes-capital',
      'live-capture-retry',
    ]);
  });

  it('no failed step stops the others: the switch-off is the safety net and always runs', () => {
    for (const s of close()?.chain ?? []) expect(s.onFail, s.id).toBe('continue');
    expect(step('quantiply-disable')?.requires).toBeUndefined();
    expect(step('quantiply-disable')?.holdId).toBeUndefined(); // never held by the stop button
  });

  it('one attempt at 15:40, after the last exit, that never holds the chain past 15:50', () => {
    const capture = step('live-capture');
    expect(minutes(capture?.notBefore)).toBeGreaterThan(15 * 60 + 28); // the last exit
    expect(capture?.retries ?? 0).toBe(0);
    expect(minutes(capture?.notBefore) + (capture?.timeoutMinutes ?? 99)).toBeLessThanOrEqual(
      15 * 60 + 50,
    );
    expect(capture?.argv).toEqual(['node_modules/.bin/tsx', 'src/live-capture.ts', '--soft-fail']);
  });

  it('its retry comes after the capital reading and ends before the 16:45 Quantiply upload', () => {
    const retry = step('live-capture-retry');
    const start = minutes(retry?.notBefore);
    expect(start).toBeGreaterThan(minutes(step('contract-notes-capital')?.notBefore));
    expect(start).toBeGreaterThan(minutes(step('live-capture')?.notBefore));
    const tries = (retry?.retries ?? 0) + 1;
    const end =
      start +
      tries * (retry?.timeoutMinutes ?? 0) +
      (retry?.retries ?? 0) * (retry?.retryDelayMinutes ?? 0);
    expect(end).toBeLessThanOrEqual(16 * 60 + 30);
    expect(end).toBeLessThan(minutes('16:45'));
    expect(retry?.argv).toEqual(['node_modules/.bin/tsx', 'src/live-capture.ts', '--no-backfill']);
    expect(retry?.noRetryExitCodes).toEqual([3]);
  });

  it('the old jobs are gone', () => {
    for (const id of [
      'live-capture',
      'live-capture-retry',
      'quantiply-disable',
      'algotest-deploy-check',
    ])
      expect(JOBS.find((j) => j.id === id)).toBeUndefined();
  });
});

describe('contract notes (BL-168)', () => {
  const job = (id: string) => JOBS.find((j) => j.id === id);

  const minutes = (at?: string | string[]) => {
    const [h = 0, m = 0] = firstAt(at).split(':').map(Number);
    return h * 60 + m;
  };

  it('is one job that runs every day, Saturday included, at 00:00, 07:30, 10:30 and 15:30 (BL-234)', () => {
    const notes = job('contract-notes');
    expect(notes?.schedule.at).toEqual(['00:00', '07:30', '10:30', '15:30']);
    expect(notes?.schedule.on('2026-10-24')).toBe(true); // a Saturday
    expect(notes?.steps).toEqual([['node', 'run.js']]);
    expect(notes?.cwd).toBe('packages/contract-notes');
    expect(notes?.group).toBe('contract-notes');
    // the three jobs it replaced are gone
    for (const id of [
      'contract-notes-retry',
      'contract-notes-retry-1030',
      'contract-notes-retry-1530',
    ])
      expect(job(id)).toBeUndefined();
  });

  it('serves the latest of its slots, so a slept-through slot is not reported missed', () => {
    const notes = job('contract-notes');
    const slot = notes?.schedule;
    if (!slot) throw new Error('contract-notes is not registered');
    // woken at 12:00: the slot due is 10:30 (the 07:30 and 00:00 ones are not run, not missed)
    expect(previousDue(slot, istAt('2026-10-24', '12:00'))?.toISOString()).toBe(
      istAt('2026-10-24', '10:30').toISOString(),
    );
    // after 15:30 the next one is tomorrow's midnight
    expect(nextDue(slot, istAt('2026-10-24', '15:31'))?.toISOString()).toBe(
      istAt('2026-10-25', '00:00').toISOString(),
    );
    // the longest wait between two slots (15:30 to 00:00) is inside the catch-up window
    const times = [...(slot.at as string[])].sort();
    const gaps = times.map((t, i) => {
      const next = times[(i + 1) % times.length] ?? t;
      return (minutes(next) - minutes(t) + 24 * 60) % (24 * 60);
    });
    expect(Math.max(...gaps) / 60).toBeLessThanOrEqual(notes?.catchUpHours ?? 0);
  });

  it('reads the capital at 15:50, a step of the close-out chain, through obt', () => {
    const capital = JOBS.find((j) => j.id === 'close-out')?.chain?.find(
      (s) => s.id === 'contract-notes-capital',
    );
    expect(capital?.notBefore).toBe('15:50');
    expect(capital?.argv).toEqual(['uv', 'run', 'obt', 'realised', 'capital']);
    expect(JOBS.find((j) => j.id === 'contract-notes-capital')).toBeUndefined();
  });

  it('a 00:00 run missed while asleep still runs before the 07:30 one', () => {
    expect(job('contract-notes')?.catchUpHours).toBeGreaterThanOrEqual(7);
  });
});

describe('Quantiply deploy jobs (BL-139 Phase 4)', () => {
  const job = (id: string) => JOBS.find((j) => j.id === id);
  const stepOf = (chain: string, id: string) => job(chain)?.chain?.find((s) => s.id === id);
  const minutes = (id: string) => {
    const [h = 0, m = 0] = firstAt(job(id)?.schedule.at).split(':').map(Number);
    return h * 60 + m;
  };

  it('disable after the session, before the upload; enable after each upload', () => {
    // BL-234: the switch-off is a close-out step (15:30 chain, 15:40 earliest) before the 16:45 upload
    expect(job('close-out')?.chain?.map((s) => s.id)).toContain('quantiply-disable');
    expect(minutes('close-out')).toBeLessThan(minutes('evening'));
    // BL-172: the switch-on is in the morning, after the 08:00 login, before the first entry
    expect(minutes('quantiply-deploy')).toBeGreaterThan(8 * 60);
    expect(minutes('quantiply-deploy')).toBeLessThan(9 * 60 + 15);
    // BL-234: the top-up and its enable are one chain, in that order
    expect(job('morning-topup')?.chain?.map((s) => s.id)).toEqual([
      'quantiply-export',
      'quantiply-topup',
      'quantiply-deploy-topup',
    ]);
    // one group: a deploy waits for the upload (and its retries); logins never overlap
    for (const id of ['close-out', 'morning-topup', 'quantiply-deploy']) {
      expect(job(id)?.group).toBe('quantiply');
      expect(job(id)?.schedule.on('2026-10-20')).toBe(false); // a market holiday
    }
    // BL-234 Phase 3: the evening chain's Quantiply steps take the same group when they get to them
    expect(
      job('evening')
        ?.chain?.filter((s) => s.group === 'quantiply')
        .map((s) => s.id),
    ).toEqual(['quantiply-export', 'quantiply-upload']);
    // the loop starts due jobs in this order: a disable caught up with the upload goes first
    const ids = JOBS.map((j) => j.id);
    expect(ids.indexOf('close-out')).toBeLessThan(ids.indexOf('evening'));
  });

  it('never retries an enable; both accounts run, each with --apply', () => {
    expect(job('quantiply-deploy')?.retries).toBe(0);
    const morning = job('quantiply-deploy')?.steps.at(-1)?.at(-1) ?? '';
    expect(morning).toContain('--broker angelone --mode enable --morning --apply');
    expect(morning).toContain('--broker finvasia --mode enable --morning --apply');
    const topup = stepOf('morning-topup', 'quantiply-deploy-topup');
    expect(topup?.retries ?? 0).toBe(0);
    const cmd = topup?.argv.at(-1) ?? '';
    expect(cmd).toContain('--broker angelone --mode enable --apply');
    expect(cmd).toContain('--broker finvasia --mode enable --apply');
    const disable = stepOf('close-out', 'quantiply-disable');
    expect(disable?.retries).toBeGreaterThan(0); // disabling again changes nothing
    expect(disable?.noRetryExitCodes).toEqual([3]);
    expect(disable?.argv.at(-1)).toContain('--mode disable --apply');
  });

  it('the top-up steps hold under their old job ids, a failed top-up never stops the enable', () => {
    const chain = job('morning-topup')?.chain ?? [];
    expect(chain.map((s) => [s.id, s.holdId])).toEqual([
      ['quantiply-export', 'quantiply-topup'],
      ['quantiply-topup', 'quantiply-topup'],
      ['quantiply-deploy-topup', 'quantiply-deploy-topup'],
    ]);
    expect(chain.find((s) => s.id === 'quantiply-topup')?.requires).toEqual(['quantiply-export']);
    expect(chain.find((s) => s.id === 'quantiply-deploy-topup')?.requires).toBeUndefined();
    // the top-up is of no use late, the enable is caught up for 3 hours
    expect(chain[1]?.notAfter).toBe('09:49');
    expect(chain[2]?.notAfter).toBeUndefined();
    expect(job('morning-topup')?.catchUpHours).toBe(3);
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
