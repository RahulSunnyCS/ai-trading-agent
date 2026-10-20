import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History } from '../history.js';
import { JOBS, findJob, maxRunMinutes } from '../jobs.js';
import { decide, startLoop } from '../loop.js';
import { istAt } from '../schedule.js';
import { catchUpCheck, catchUpWindow, fyersLine } from '../summary.js';

const tmpHistory = () => new History(join(mkdtempSync(join(tmpdir(), 'bl143-')), 'scheduler.db'));

describe('BL-143: catch-ups after sleep in the morning summary', () => {
  it("lists the previous day's catch-up runs, due and ran, as one problem line", () => {
    const history = tmpHistory();
    const slot = new Date('2026-10-19T11:10:00Z'); // 16:40 IST
    const late = history.start(
      'algotest-evening',
      'catch-up',
      slot,
      '/x',
      new Date('2026-10-19T14:57:00Z'),
    );
    history.finish(late, 0, 1, new Date('2026-10-19T15:00:00Z'));
    const onTime = history.start(
      'quantiply-evening',
      'schedule',
      slot,
      '/x',
      new Date('2026-10-19T11:15:00Z'),
    );
    history.finish(onTime, 0, 1, new Date('2026-10-19T11:16:00Z'));
    const { since, until } = catchUpWindow('2026-10-20');
    const rows = history.catchUpsBetween(since, until);
    expect(rows.map((r) => r.job)).toEqual(['algotest-evening']);
    const check = catchUpCheck(rows);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('algotest-evening (due 16:40, ran 20:27)');
    expect(check?.detail).toContain('deploy/launchd/README.md');
    expect(catchUpCheck([])).toBeNull();
    history.close();
  });

  it('a restart of an interrupted run is not "ran late after sleep" (its slot has an earlier row)', () => {
    const history = tmpHistory();
    const slot = new Date('2026-10-19T03:34:00Z'); // 09:04 IST
    const first = history.start('trade-monitor', 'schedule', slot, '/x', slot);
    history.finish(first, -2, 0, new Date('2026-10-19T06:00:00Z'), 'interrupted');
    const again = history.start(
      'trade-monitor',
      'catch-up',
      slot,
      '/x',
      new Date('2026-10-19T06:05:00Z'),
    );
    history.finish(again, 0, 1, new Date('2026-10-19T10:00:00Z'));
    const { since, until } = catchUpWindow('2026-10-20');
    expect(history.catchUpsBetween(since, until)).toEqual([]);
    history.close();
  });

  it("on Monday, Friday's day only: a weekend job caught up is not flagged", () => {
    // Mon 2026-10-26: the previous trading day is Fri 2026-10-23
    const { since, until } = catchUpWindow('2026-10-26');
    expect(since.toISOString()).toBe(istAt('2026-10-23', '00:00').toISOString());
    expect(until.toISOString()).toBe(istAt('2026-10-24', '00:00').toISOString());
  });
});

describe("BL-143: the morning summary's one Fyers check", () => {
  it('passes a token Fyers accepts', () => {
    const c = fyersLine(
      'ok: token from broker_tokens, expires 2026-10-21 06:00 IST (Fyers accepts it)',
    );
    expect(c.ok).toBe(true);
  });

  it('fails a rejected or unconfirmable token, with what to do', () => {
    const c = fyersLine(
      'not ready: the token from env has no known expiry and Fyers could not be asked',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('no known expiry');
    expect(c.detail).toContain('Broker logins');
    expect(fyersLine('').ok).toBe(false);
  });

  it('is a summary line, not a second 09:00 job', () => {
    expect(findJob('fyers-token-reminder')).toBeUndefined();
  });
});

describe('BL-143: the trade monitor job', () => {
  it('starts 09:04, outside the quantiply group, and never retries a held login', () => {
    const job = findJob('trade-monitor');
    expect(job?.schedule.at).toBe('09:04');
    expect(job?.group).toBeUndefined();
    expect(job?.noRetryExitCodes).toEqual([3]);
    expect(job?.steps).toEqual([
      ['/usr/bin/caffeinate', '-i', 'node_modules/.bin/tsx', 'src/trade-monitor.ts'],
    ]);
    expect((job?.timeoutMinutes ?? 0) >= 15 * 60 + 30 - (9 * 60 + 4)).toBe(true);
    expect(JOBS.filter((j) => j.id === 'trade-monitor')).toHaveLength(1);
  });

  it('starts again after a restart cut it off, while the session lasts', () => {
    const job = findJob('trade-monitor');
    if (!job) throw new Error('no trade-monitor job');
    const history = tmpHistory();
    const slot = istAt('2026-10-21', '09:04');
    const since = istAt('2026-10-01', '00:00');
    const id = history.start('trade-monitor', 'schedule', slot, '/x', slot);
    // the scheduler stopped mid-session: reaped as interrupted
    history.finish(id, -2, 0, istAt('2026-10-21', '11:00'), 'interrupted');
    const d = decide(job, istAt('2026-10-21', '11:05'), history, since);
    expect(d).toEqual({ kind: 'run', slot, trigger: 'catch-up' });
    // after 15:25 it stays down
    expect(decide(job, istAt('2026-10-21', '15:26'), history, since).kind).toBe('idle');
    // a run that ended normally is served
    const ok = history.start('trade-monitor', 'catch-up', slot, '/x', istAt('2026-10-21', '11:05'));
    history.finish(ok, 0, 1, istAt('2026-10-21', '15:30'));
    expect(decide(job, istAt('2026-10-21', '15:20'), history, since).kind).toBe('idle');
    history.close();
  });

  it("a scheduler restart closes the monitor's open row and startLoop starts it again", async () => {
    const real = findJob('trade-monitor');
    if (!real) throw new Error('no trade-monitor job');
    // the real job's schedule and restart rule, a stand-in step
    const job = { ...real, steps: [['/bin/sh', '-c', 'true']], cwd: '.' };
    const dir = mkdtempSync(join(tmpdir(), 'bl143-restart-'));
    const history = new History(join(dir, 'scheduler.db'));
    history.firstStart(istAt('2026-10-01', '00:00'));
    history.jobFirstSeen('trade-monitor', istAt('2026-10-01', '00:00'));
    const slot = istAt('2026-10-21', '09:04');
    // the previous scheduler started it at 09:04, then the laptop restarted: the row stays open
    const first = history.start('trade-monitor', 'schedule', slot, '/x', slot);
    const noon = istAt('2026-10-21', '12:00');
    const stop = startLoop({
      ctx: { repoRoot: dir, env: { PATH: '/usr/bin:/bin' }, logDir: dir, history, now: () => noon },
      jobs: [job],
      alerts: async () => undefined,
      tickMs: 60_000,
      pidAlive: () => false, // the old scheduler's process is gone
    });
    stop();
    expect(history.get(first)).toMatchObject({ exit_code: -2 });
    // the first tick started it again as a catch-up of the same slot
    let again = history.forSlot('trade-monitor', slot);
    for (let i = 0; i < 100 && (again?.id === first || again?.ended_at === null); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      again = history.forSlot('trade-monitor', slot);
    }
    expect(again).toMatchObject({ trigger: 'catch-up', exit_code: 0 });
    expect(again?.id).not.toBe(first);
    history.close();
  });

  it("each job's longest run: every attempt, the delays and its group's wait", () => {
    const at = (id: string) => {
      const job = findJob(id);
      if (!job) throw new Error(`no ${id}`);
      return maxRunMinutes(job);
    };
    expect(at('algotest-topup')).toBe(10 * 3 + 2 * 2);
    expect(at('quantiply-deploy-topup')).toBe(10 + 10); // one attempt + the group's wait
    expect(at('quantiply-topup')).toBe(10 * 2 + 2 + 10);
  });

  it("GET /jobs' reader is never kept waiting by a row whose process is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), 'bl143-reap-'));
    const path = join(dir, 'scheduler.db');
    const history = new History(path);
    const id = history.start('algotest-topup', 'manual', null, '', istAt('2026-10-21', '09:30'));
    // a Ctrl-C'd `jobs run`: its pid is gone
    const db = new Database(path);
    db.query('UPDATE runs SET pid = ? WHERE id = ?').run(999_999_999, id);
    db.close();
    expect(history.reapDead(istAt('2026-10-21', '12:00'))).toBe(1);
    expect(history.get(id)).toMatchObject({ exit_code: -2 });
    history.close();
  });

  it('other jobs treat an interrupted slot as served', () => {
    const job = findJob('options-evening');
    if (!job) throw new Error('no options-evening job');
    const history = tmpHistory();
    const slot = istAt('2026-10-21', '15:45');
    const id = history.start('options-evening', 'schedule', slot, '/x', slot);
    history.finish(id, -2, 0, istAt('2026-10-21', '16:00'), 'interrupted');
    expect(
      decide(job, istAt('2026-10-21', '16:05'), history, istAt('2026-10-01', '00:00')).kind,
    ).toBe('idle');
    history.close();
  });
});
