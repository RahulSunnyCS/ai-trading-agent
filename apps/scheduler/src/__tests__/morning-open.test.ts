import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertResult } from '../alerts.js';
import { planChain, renderPlan } from '../chain-plan.js';
import { splitDryRun } from '../cli.js';
import { History } from '../history.js';
import { JOBS, type Job, groupsOf } from '../jobs.js';
import { PAUSE_JOBS } from '../pause.js';
import { type RunContext, runJob } from '../runner.js';
import { istAt } from '../schedule.js';
import { STOP_HELD_JOBS } from '../stop-hold.js';

/**
 * BL-234 Phase 4: the `morning-open` chain, the real definition with every command replaced by a
 * script that records its step and exits as the test says. No login, no browser, no network.
 */
const real = JOBS.find((j) => j.id === 'morning-open') as Job;
const ids = (real.chain ?? []).map((s) => s.id);
const DAY = '2026-11-18';

let dir: string;
let ctx: RunContext;
const waits: number[] = [];
const sent: string[] = [];
const sink = async (text: string) => {
  sent.push(text);
};
const ranFile = () => join(dir, 'ran');
const marks = () =>
  existsSync(ranFile()) ? readFileSync(ranFile(), 'utf8').trim().split('\n') : [];

/** the real chain with each command swapped for a script exiting `codes[step]` (default 0) */
function fake(codes: Record<string, number> = {}): Job {
  return {
    ...real,
    cwd: '.',
    chain: (real.chain ?? []).map((s) => ({
      ...s,
      cwd: '.',
      argv: ['/bin/sh', '-c', `echo ${s.id} >> ${ranFile()}; exit ${codes[s.id] ?? 0}`],
    })),
  };
}

const statuses = (result: { steps?: Array<{ id: string; status: string }> }) =>
  Object.fromEntries((result.steps ?? []).map((s) => [s.id, s.status]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'morning-open-'));
  waits.length = 0;
  sent.length = 0;
  ctx = {
    repoRoot: dir,
    env: { PATH: '/usr/bin:/bin', SCHEDULER_STATE_DIR: dir },
    logDir: join(dir, 'logs'),
    history: new History(':memory:'),
    busyPollMs: 10,
    sleep: async (ms) => {
      waits.push(ms);
    },
    now: () => istAt(DAY, '08:00'),
  };
});
afterEach(() => ctx.history.close());

const at = (hhmm: string) => {
  ctx.now = () => istAt(DAY, hhmm);
};

describe('the morning-open chain (BL-234 Phase 4)', () => {
  it('is the four old jobs in one: the order, the start and the group', () => {
    expect(real.schedule.at).toBe('08:00');
    expect(real.schedule.on('2026-11-18')).toBe(true);
    expect(real.schedule.on('2026-11-21')).toBe(false); // a Saturday
    expect(ids).toEqual([
      'angel-check',
      'quantiply-login',
      'quantiply-deploy',
      'quantiply-deploy-shoonya',
      'algotest-login',
      'algotest-catch-up',
      'algotest-activate',
      'morning-message',
    ]);
    // Quantiply is switched on BEFORE AlgoTest's window; AlgoTest's login waits for 08:16
    expect(ids.indexOf('quantiply-deploy-shoonya')).toBeLessThan(ids.indexOf('algotest-login'));
    expect(real.chain?.find((s) => s.id === 'algotest-login')?.notBefore).toBe('08:16');
    // the old four jobs are gone
    for (const old of [
      'broker-login',
      'angel-login-check',
      'quantiply-deploy',
      'algotest-activate',
    ])
      expect(JOBS.find((j) => j.id === old)).toBeUndefined();
    // the group is taken at the first Quantiply step, so the Angel One check waits for nobody
    expect(real.group).toBeUndefined();
    expect(groupsOf(real)).toEqual(['quantiply']);
    expect(real.chain?.find((s) => s.id === 'angel-check')?.group).toBeUndefined();
    expect(real.retries).toBe(0);
  });

  it('never retries a login or an activation, and none is left out of the stop hold', () => {
    for (const id of [
      'quantiply-login',
      'quantiply-deploy',
      'quantiply-deploy-shoonya',
      'algotest-login',
      'algotest-catch-up',
      'algotest-activate',
    ])
      expect(real.chain?.find((s) => s.id === id)?.retries ?? 0, id).toBe(0);
    // the steps that upload, enable or deploy are held under the old job ids
    const hold = (id: string) => real.chain?.find((s) => s.id === id)?.holdId;
    expect(hold('quantiply-deploy')).toBe('quantiply-deploy');
    expect(hold('quantiply-deploy-shoonya')).toBe('quantiply-deploy');
    expect(hold('algotest-catch-up')).toBe('algotest-activate');
    expect(hold('algotest-activate')).toBe('algotest-activate');
    for (const id of ['quantiply-deploy', 'algotest-activate'] as const) {
      expect(STOP_HELD_JOBS).toContain(id);
      expect(PAUSE_JOBS).toContain(id);
    }
    // logins are never held: the stop button holds what changes platforms, not the sign-in
    expect(hold('quantiply-login')).toBeUndefined();
    expect(hold('algotest-login')).toBeUndefined();
  });

  it('runs every step in order and waits for 08:16 only before the AlgoTest login', async () => {
    const result = await runJob(fake(), ctx, 'schedule', istAt(DAY, '08:00'));
    expect(result.ok).toBe(true);
    expect(marks()).toEqual(ids);
    expect(waits).toEqual([16 * 60_000]);
  });

  it('a failed Angel One check stops nothing', async () => {
    const job = fake({ 'angel-check': 1 });
    const result = await runJob(job, ctx, 'schedule', istAt(DAY, '08:00'));
    expect(marks()).toEqual(ids);
    expect(statuses(result)['angel-check']).toBe('failed');
    expect(result.ok).toBe(false);
  });

  it('a failed Quantiply · Angel One login skips only that account’s switch-on, Shoonya’s still runs', async () => {
    const result = await runJob(
      fake({ 'quantiply-login': 1 }),
      ctx,
      'schedule',
      istAt(DAY, '08:00'),
    );
    expect(marks()).toEqual([
      'angel-check',
      'quantiply-login',
      'quantiply-deploy-shoonya',
      'algotest-login',
      'algotest-catch-up',
      'algotest-activate',
      'morning-message',
    ]);
    expect(statuses(result)['quantiply-deploy']).toBe('skipped');
    expect(statuses(result)['quantiply-deploy-shoonya']).toBe('ok');
    expect(statuses(result)['algotest-activate']).toBe('ok');
  });

  it('a failed AlgoTest login skips nothing: the activation does not depend on it (the old 08:11 job did not)', async () => {
    // `local-login.ts --part algotest` exits 1 when only one of the two brokers, or only Quantiply ·
    // Shoonya, failed: the brokers that did log in must still be activated
    const result = await runJob(
      fake({ 'algotest-login': 1 }),
      ctx,
      'schedule',
      istAt(DAY, '08:00'),
    );
    expect(marks()).toEqual(ids);
    expect(statuses(result)['algotest-login']).toBe('failed');
    expect(statuses(result)['algotest-activate']).toBe('ok');
    expect(statuses(result)['quantiply-deploy']).toBe('ok');
  });

  it('one alert names each failed step with its own fix, and the logins that alert themselves are left out', async () => {
    const job = fake({ 'angel-check': 1, 'quantiply-login': 1, 'quantiply-deploy': 0 });
    const result = await runJob(job, ctx, 'schedule', istAt(DAY, '08:00'));
    await alertResult(sink, job, result, ctx.history);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('morning-open failed');
    expect(sent[0]).toContain('• angel-check: exit 1');
    expect(sent[0]).toContain('• quantiply-deploy: skipped: quantiply-login did not pass');
    // quantiply-login sends its own login report
    expect(sent[0]).not.toContain('• quantiply-login');
  });

  it('is held by the stop button: the switch-on and the activation never run, the logins and the message do', async () => {
    writeFileSync(
      join(dir, 'stop-hold.json'),
      JSON.stringify({ at: '2026-11-18T02:00:00Z', by: 'test' }),
    );
    const result = await runJob(fake(), ctx, 'schedule', istAt(DAY, '08:00'));
    expect(marks()).toEqual([
      'angel-check',
      'quantiply-login',
      'algotest-login',
      'morning-message',
    ]);
    expect(statuses(result)).toMatchObject({
      'quantiply-deploy': 'held',
      'quantiply-deploy-shoonya': 'held',
      'algotest-catch-up': 'held',
      'algotest-activate': 'held',
    });
    expect(result.ok).toBe(true); // a hold is not a failure
  });

  describe('a laptop that slept through the morning', () => {
    it('at 09:30 still logs in to Quantiply and AlgoTest, skips the 09:05 switch-ons and names them', async () => {
      at('09:30');
      const job = fake();
      const result = await runJob(job, ctx, 'catch-up', istAt(DAY, '08:00'));
      expect(marks()).toEqual([
        'quantiply-login',
        'algotest-login',
        'algotest-catch-up',
        'algotest-activate',
        'morning-message',
      ]);
      expect(waits).toEqual([]); // 08:16 has passed: no waiting
      expect(statuses(result)).toMatchObject({
        'angel-check': 'late',
        'quantiply-login': 'ok',
        'quantiply-deploy': 'late',
        'quantiply-deploy-shoonya': 'late',
      });
      expect(result.ok).toBe(false);
      await alertResult(sink, job, result, ctx.history);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('• angel-check: too late: 09:10 IST has passed');
      expect(sent[0]).toContain('• quantiply-deploy: too late: 09:05 IST has passed');
      expect(sent[0]).toContain('• quantiply-deploy-shoonya: too late: 09:05 IST has passed');
    });

    it('at 13:00 still logs in (the old 7 h window), activates nothing and says so once', async () => {
      at('13:00');
      const job = fake();
      const result = await runJob(job, ctx, 'catch-up', istAt(DAY, '08:00'));
      expect(marks()).toEqual(['quantiply-login', 'algotest-login', 'morning-message']);
      expect(statuses(result)).toMatchObject({
        'angel-check': 'late',
        'quantiply-login': 'ok',
        'quantiply-deploy': 'late',
        'algotest-login': 'ok',
        'algotest-catch-up': 'late',
        'algotest-activate': 'late',
      });
      await alertResult(sink, job, result, ctx.history);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('• algotest-activate: too late: 12:40 IST has passed');
    });

    it('at 15:30 is past every login window: only the message runs', async () => {
      at('15:30');
      const result = await runJob(fake(), ctx, 'catch-up', istAt(DAY, '08:00'));
      expect(marks()).toEqual(['morning-message']);
      expect(statuses(result)).toMatchObject({
        'quantiply-login': 'late',
        'algotest-login': 'late',
        'algotest-activate': 'late',
      });
    });
  });

  it('never repeats a login or an activation that was running when the run was cut off', async () => {
    const h = ctx.history;
    const slot = istAt(DAY, '08:00');
    // an earlier run of this slot: the check and Quantiply's steps passed, the AlgoTest login was
    // running when the scheduler stopped (it may have sent a PIN)
    const cut = h.start('morning-open', 'schedule', slot, '', slot);
    for (const id of [
      'angel-check',
      'quantiply-login',
      'quantiply-deploy',
      'quantiply-deploy-shoonya',
    ]) {
      const row = h.startStep(cut, id, slot);
      h.finishStep(row, 'ok', 0, 1, slot);
    }
    h.startStep(cut, 'algotest-login', istAt(DAY, '08:16'));
    h.finish(cut, -2, 1, istAt(DAY, '08:17'), 'interrupted');
    const again = await runJob(fake(), ctx, 'schedule', slot);
    expect(again.ok).toBe(false);
    expect(again.exitCode).toBe(4);
    expect(again.error).toContain('algotest-login was running');
    expect(marks()).toEqual([]); // nothing ran, not even the steps that had passed
  });
});

describe('the dry run (BL-234 Phase 4)', () => {
  it('prints the order and the 08:16 wait without starting anything', () => {
    const lines = planChain(real, {
      start: istAt(DAY, '08:00'),
      env: { SCHEDULER_STATE_DIR: dir },
    });
    expect(lines.filter((l) => l.action !== 'wait').map((l) => l.step)).toEqual(ids);
    const wait = lines.find((l) => l.action === 'wait');
    expect(wait).toMatchObject({ step: 'algotest-login', text: 'waits 16 min for 08:16 IST' });
    const clocks = lines.map((l) => l.at.getTime());
    expect([...clocks].sort((a, b) => a - b)).toEqual(clocks);
    expect(lines.every((l) => l.action === 'run' || l.action === 'wait')).toBe(true);
    // a plan starts nothing: no run row, no log
    expect(ctx.history.recent(10)).toEqual([]);
    expect(existsSync(ranFile())).toBe(false);
    const text = renderPlan(real, lines).join('\n');
    expect(text).toContain('nothing is started');
    expect(text).toContain('src/local-login.ts --part quantiply');
  });

  it('shows what a late start skips, and what a hold holds', () => {
    const late = planChain(real, { start: istAt(DAY, '09:30'), env: { SCHEDULER_STATE_DIR: dir } });
    expect(Object.fromEntries(late.map((l) => [l.step, l.action]))).toMatchObject({
      'angel-check': 'late',
      'quantiply-login': 'run',
      'quantiply-deploy': 'late',
      'quantiply-deploy-shoonya': 'late',
      'algotest-login': 'run',
      'algotest-activate': 'run',
    });
    writeFileSync(join(dir, 'stop-hold.json'), JSON.stringify({ at: 'x', by: 'test' }));
    const held = planChain(real, { start: istAt(DAY, '08:00'), env: { SCHEDULER_STATE_DIR: dir } });
    expect(held.find((l) => l.step === 'quantiply-deploy')?.action).toBe('held');
    expect(held.find((l) => l.step === 'quantiply-deploy-shoonya')?.action).toBe('held');
    expect(held.find((l) => l.step === 'algotest-activate')?.action).toBe('held');
    expect(held.find((l) => l.step === 'algotest-login')?.action).toBe('wait');
  });

  it('parses --dry-run and --at, leaving the other flags alone', () => {
    expect(splitDryRun(['--dry-run', '--at', '08:20'])).toEqual({
      dryRun: true,
      at: '08:20',
      rest: [],
    });
    expect(splitDryRun(['--resume'])).toEqual({ dryRun: false, at: null, rest: ['--resume'] });
  });
});
