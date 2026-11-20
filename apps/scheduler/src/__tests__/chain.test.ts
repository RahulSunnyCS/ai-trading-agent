import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertResult } from '../alerts.js';
import { History } from '../history.js';
import { type ChainStep, type Job, groupsOf, maxRunMinutes } from '../jobs.js';
import { type RunContext, runJob } from '../runner.js';
import { istAt } from '../schedule.js';

function chainJob(id: string, chain: ChainStep[], extra: Partial<Job> = {}): Job {
  return {
    id,
    description: `${id} chain`,
    schedule: { at: '15:30', on: () => true, label: '' },
    steps: [],
    chain,
    cwd: '.',
    timeoutMinutes: 1,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 0,
    fixHint: 'fix the chain',
    ...extra,
  };
}

const sh = (id: string, script: string, extra: Partial<ChainStep> = {}): ChainStep => ({
  id,
  argv: ['/bin/sh', '-c', script],
  fixHint: `fix ${id}`,
  ...extra,
});

let dir: string;
let ctx: RunContext;
const waits: number[] = [];

/** One line appended to `ran` each time a step's script runs: what really executed. */
const ran = () => join(dir, 'ran');
const marks = () => (existsSync(ran()) ? readFileSync(ran(), 'utf8').trim().split('\n') : []);
const step = (id: string, extra: Partial<ChainStep> = {}, body = 'true') =>
  sh(id, `echo ${id} >> ${ran()}; ${body}`, extra);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chain-'));
  waits.length = 0;
  ctx = {
    repoRoot: dir,
    env: { PATH: '/usr/bin:/bin', SCHEDULER_STATE_DIR: dir },
    logDir: join(dir, 'logs'),
    history: new History(':memory:'),
    busyPollMs: 10,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
});

afterEach(() => ctx.history.close());

const statuses = (result: { steps?: Array<{ id: string; status: string }> }) =>
  Object.fromEntries((result.steps ?? []).map((s) => [s.id, s.status]));

describe('a chain', () => {
  it('runs its steps in order and records each one', async () => {
    const result = await runJob(chainJob('c', [step('a'), step('b'), step('c')]), ctx, 'manual');
    expect(result).toMatchObject({ ok: true, exitCode: 0, error: null });
    expect(marks()).toEqual(['a', 'b', 'c']);
    expect(statuses(result)).toEqual({ a: 'ok', b: 'ok', c: 'ok' });
    expect(ctx.history.steps(result.runId).map((s) => [s.step, s.status])).toEqual([
      ['a', 'ok'],
      ['b', 'ok'],
      ['c', 'ok'],
    ]);
  });

  it('ends at the first failure by default and says which later steps did not run', async () => {
    const result = await runJob(
      chainJob('c', [step('a'), step('b', {}, 'exit 3'), step('c')]),
      ctx,
      'manual',
    );
    expect(result).toMatchObject({ ok: false, exitCode: 3 });
    expect(marks()).toEqual(['a', 'b']);
    expect(statuses(result)).toEqual({ a: 'ok', b: 'failed', c: 'skipped' });
    expect(result.error).toContain('b: exit 3');
    expect(result.error).toContain('c: not run: b failed and ends the chain');
  });

  it('runs on after a failure when the step says continue, and still reports the failure', async () => {
    const result = await runJob(
      chainJob('close-out', [step('capture', { onFail: 'continue' }, 'exit 1'), step('disable')]),
      ctx,
      'manual',
    );
    expect(marks()).toEqual(['capture', 'disable']); // the safety net still ran
    expect(result.ok).toBe(false);
    expect(statuses(result)).toEqual({ capture: 'failed', disable: 'ok' });
  });

  it('skips a step whose required step did not pass, and runs the independent ones', async () => {
    const result = await runJob(
      chainJob('c', [
        step('login', { onFail: 'continue' }, 'exit 1'),
        step('activate', { requires: ['login'], onFail: 'continue' }),
        step('pick', { onFail: 'continue' }),
      ]),
      ctx,
      'manual',
    );
    expect(marks()).toEqual(['login', 'pick']);
    expect(statuses(result)).toEqual({ login: 'failed', activate: 'skipped', pick: 'ok' });
    expect(result.error).toContain('activate: skipped: login did not pass');
  });

  it('retries a step on its own and never retries an exit code it marks as final', async () => {
    const attempts = join(dir, 'attempts');
    const flaky = sh('flaky', `echo x >> ${attempts}; [ $(wc -l < ${attempts}) -ge 3 ]`, {
      retries: 2,
      retryDelayMinutes: 5,
    });
    const refused = step('refused', { retries: 3, noRetryExitCodes: [3] }, 'exit 3');
    const r1 = await runJob(chainJob('c1', [flaky]), ctx, 'manual');
    expect(r1.ok).toBe(true);
    expect(r1.steps?.[0]).toMatchObject({ attempts: 3 });
    expect(waits).toEqual([5 * 60_000, 5 * 60_000]);
    const r2 = await runJob(chainJob('c2', [refused]), ctx, 'manual');
    expect(r2.ok).toBe(false);
    expect(marks().filter((m) => m === 'refused')).toHaveLength(1);
  });

  it('a step with no retries runs once even when it fails (a login is never sent twice)', async () => {
    const result = await runJob(
      chainJob('c', [step('login', {}, 'exit 1')], { retries: 0 }),
      ctx,
      'manual',
    );
    expect(result.ok).toBe(false);
    expect(marks()).toEqual(['login']);
  });

  it('waits for a step’s notBefore time, and not when it has passed', async () => {
    const at = (hhmm: string) => () => istAt('2026-11-18', hhmm);
    ctx.now = at('15:50');
    await runJob(chainJob('c', [step('late', { notBefore: '15:55' })]), ctx, 'manual');
    expect(waits).toEqual([5 * 60_000]);
    waits.length = 0;
    await runJob(chainJob('d', [step('past', { notBefore: '15:40' })]), ctx, 'manual');
    expect(waits).toEqual([]);
  });

  it('checks notAfter again after the notBefore wait: a Mac that slept through the wait starts nothing late', async () => {
    let clock = istAt('2026-11-18', '08:00');
    ctx.now = () => clock;
    // the wait takes the clock past the step's latest time (the laptop slept, then woke at 13:00)
    ctx.sleep = async (ms) => {
      waits.push(ms);
      clock = istAt('2026-11-18', '13:00');
    };
    const result = await runJob(
      chainJob('c', [step('login', { notBefore: '08:16', notAfter: '12:40', alertLate: true })]),
      ctx,
      'manual',
    );
    expect(waits).toEqual([16 * 60_000]);
    expect(marks()).toEqual([]); // never started
    expect(result.steps?.[0]).toMatchObject({ id: 'login', status: 'late' });
    expect(result.ok).toBe(false); // alertLate: named in the alert
  });

  it('checks notAfter again after waiting for the group', async () => {
    let clock = istAt('2026-11-18', '12:30');
    ctx.now = () => clock;
    // another job holds `quantiply`; it lets go after the clock has passed the step's latest time
    const other = chainJob('close-out', [step('x')], { group: 'quantiply' });
    const holderRow = ctx.history.start('close-out', 'schedule', null, join(dir, 'o.log'), clock);
    const job = chainJob('c', [step('act', { notAfter: '12:40', group: 'quantiply' })], {
      timeoutMinutes: 60,
    });
    ctx.jobs = [other, job];
    const run = runJob(job, ctx, 'manual');
    await new Promise((r) => setTimeout(r, 60));
    clock = istAt('2026-11-18', '13:00');
    ctx.history.finish(holderRow, 0, 1, clock);
    const result = await run;
    expect(marks()).toEqual([]); // never started: its time passed while it waited
    expect(result.steps?.[0]).toMatchObject({ id: 'act', status: 'late' });
  });

  it('writes a step to its own log file when it names one', async () => {
    const result = await runJob(
      chainJob('c', [sh('s', 'echo only-here', { logFile: 'logs/own.log' }), step('t')]),
      ctx,
      'manual',
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, 'logs/own.log'), 'utf8')).toContain('only-here');
    expect(readFileSync(result.logPath, 'utf8')).not.toContain('only-here');
  });

  it('holds a step by its hold id while the stop button’s hold is on, and the steps that need it', async () => {
    writeFileSync(
      join(dir, 'stop-hold.json'),
      JSON.stringify({ at: '2026-11-18T03:00:00Z', by: 'test' }),
    );
    const result = await runJob(
      chainJob('morning-topup', [
        step('quantiply-topup', { holdId: 'quantiply-topup' }),
        step('quantiply-deploy-topup', {
          holdId: 'quantiply-deploy-topup',
          requires: ['quantiply-topup'],
        }),
        step('read-only'),
      ]),
      ctx,
      'manual',
    );
    expect(marks()).toEqual(['read-only']); // nothing held ran, the read-only step did
    expect(statuses(result)).toEqual({
      'quantiply-topup': 'held',
      'quantiply-deploy-topup': 'held',
      'read-only': 'ok',
    });
    expect(result.ok).toBe(true); // a hold is not a failure
  });
});

describe('resuming a chain', () => {
  const three = (c: string) => [step('a'), step('b', {}, `[ -e ${join(dir, c)} ]`), step('c')];

  it('does not run a step again that passed in the run it resumes', async () => {
    const first = await runJob(chainJob('c', three('fixed')), ctx, 'manual');
    expect(statuses(first)).toEqual({ a: 'ok', b: 'failed', c: 'skipped' });
    writeFileSync(join(dir, 'fixed'), '');
    const second = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      resume: true,
    });
    expect(second.ok).toBe(true);
    expect(statuses(second)).toEqual({ a: 'carried', b: 'ok', c: 'ok' });
    expect(marks()).toEqual(['a', 'b', 'b', 'c']); // `a` ran once, `b` twice
    expect(ctx.history.steps(second.runId)[0]).toMatchObject({
      step: 'a',
      status: 'carried',
      carried_from: first.runId,
    });
  });

  it('runs every step again without --resume, or with --fresh', async () => {
    await runJob(chainJob('c', three('fixed')), ctx, 'manual');
    writeFileSync(join(dir, 'fixed'), '');
    const plain = await runJob(chainJob('c', three('fixed')), ctx, 'manual');
    expect(statuses(plain)).toEqual({ a: 'ok', b: 'ok', c: 'ok' });
    const fresh = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      resume: true,
      fresh: true,
    });
    expect(statuses(fresh)).toEqual({ a: 'ok', b: 'ok', c: 'ok' });
  });

  it('resumes by itself when the loop restarts a slot whose run failed part way', async () => {
    const slot = istAt('2026-11-18', '15:30');
    const first = await runJob(chainJob('c', three('fixed')), ctx, 'schedule', slot);
    expect(statuses(first).b).toBe('failed');
    writeFileSync(join(dir, 'fixed'), '');
    const again = await runJob(chainJob('c', three('fixed')), ctx, 'catch-up', slot);
    expect(statuses(again)).toEqual({ a: 'carried', b: 'ok', c: 'ok' });
    expect(marks().filter((m) => m === 'a')).toHaveLength(1);
  });

  it('only resumes a run of today, and a hand run with no flag never resumes', async () => {
    const yesterday = new Date(Date.now() - 36 * 3_600_000);
    const old = ctx.history.start('c', 'manual', null, join(dir, 'x.log'), yesterday);
    const row = ctx.history.startStep(old, 'a', yesterday);
    ctx.history.finishStep(row, 'ok', 0, 1, yesterday);
    ctx.history.finish(old, 1, 1, yesterday, 'b failed');
    const result = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      resume: true,
    });
    expect(statuses(result).a).toBe('ok'); // not carried from yesterday's run
  });

  it('refuses to repeat a step that was running when the run was cut off', async () => {
    const dead = ctx.history.start('c', 'schedule', null, join(dir, 'x.log'), new Date());
    const done = ctx.history.startStep(dead, 'a', new Date());
    ctx.history.finishStep(done, 'ok', 0, 1, new Date());
    ctx.history.startStep(dead, 'b', new Date()); // started, never ended
    ctx.history.reapDead(
      new Date(),
      () => false,
      () => false,
    );
    expect(ctx.history.steps(dead).map((s) => s.status)).toEqual(['ok', 'unknown']);

    const result = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      resume: true,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(4);
    expect(result.error).toContain('b was running');
    expect(marks()).toEqual([]); // nothing ran, not even the steps after it
  });

  it('--from runs the unknown step on purpose, and counts the steps before it as done', async () => {
    const dead = ctx.history.start('c', 'schedule', null, join(dir, 'x.log'), new Date());
    ctx.history.startStep(dead, 'b', new Date());
    ctx.history.reapDead(
      new Date(),
      () => false,
      () => false,
    );
    writeFileSync(join(dir, 'fixed'), '');
    const result = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      from: 'b',
    });
    expect(result.ok).toBe(true);
    expect(statuses(result)).toEqual({ a: 'carried', b: 'ok', c: 'ok' });
    expect(marks()).toEqual(['b', 'c']);
  });

  it('--from skipping the unknown step moves past it without running it', async () => {
    const dead = ctx.history.start('c', 'schedule', null, join(dir, 'x.log'), new Date());
    ctx.history.startStep(dead, 'b', new Date());
    ctx.history.reapDead(
      new Date(),
      () => false,
      () => false,
    );
    const result = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      from: 'c',
    });
    expect(statuses(result)).toEqual({ a: 'carried', b: 'carried', c: 'ok' });
    expect(marks()).toEqual(['c']);
  });

  it('does not repeat a passed step after a refused resume left a run with no steps', async () => {
    const dead = ctx.history.start('c', 'schedule', null, join(dir, 'x.log'), new Date());
    const done = ctx.history.startStep(dead, 'a', new Date());
    ctx.history.finishStep(done, 'ok', 0, 1, new Date());
    ctx.history.startStep(dead, 'b', new Date()); // started, never ended
    ctx.history.reapDead(
      new Date(),
      () => false,
      () => false,
    );
    // the owner resumes: refused, and that run records no step rows
    const refused = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      resume: true,
    });
    expect(refused.exitCode).toBe(4);
    expect(ctx.history.steps(refused.runId)).toEqual([]);
    // resuming again must still see `a` passed and `b` unknown: it refuses again, running nothing
    const again = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      resume: true,
    });
    expect(again.exitCode).toBe(4);
    expect(marks()).toEqual([]);
    // and once the owner starts at `b`, `a` is still carried, never run
    writeFileSync(join(dir, 'fixed'), '');
    const from = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, { from: 'b' });
    expect(statuses(from)).toEqual({ a: 'carried', b: 'ok', c: 'ok' });
    expect(marks()).toEqual(['b', 'c']);
  });

  it('does not repeat a passed step after an Apply now run of some steps', async () => {
    const chain = chainJob('evening', [step('a'), step('b'), step('c', {}, 'false')]);
    const first = await runJob(chain, ctx, 'manual');
    expect(statuses(first)).toEqual({ a: 'ok', b: 'ok', c: 'failed' });
    await runJob(chain, ctx, 'manual', null, { only: ['a'] }); // Apply now of one step
    const resumed = await runJob(chain, ctx, 'manual', null, { resume: true });
    // `b` passed in the first run and was not touched since: carried, not run again
    expect(statuses(resumed)).toEqual({ a: 'carried', b: 'carried', c: 'failed' });
    expect(marks().filter((m) => m === 'b')).toHaveLength(1);
  });

  it('a step that failed again after passing is run again on resume', async () => {
    const chain = chainJob('c', [step('a'), step('b')]);
    await runJob(chain, ctx, 'manual');
    await runJob(chainJob('c', [step('a', {}, 'false'), step('b')]), ctx, 'manual');
    const resumed = await runJob(chain, ctx, 'manual', null, { resume: true });
    expect(statuses(resumed).a).toBe('ok'); // its latest row was `failed`, so it ran
    expect(marks().filter((m) => m === 'a')).toHaveLength(3);
  });

  it('refuses a step id the chain does not have', async () => {
    const result = await runJob(chainJob('c', three('fixed')), ctx, 'manual', null, {
      from: 'nope',
    });
    expect(result).toMatchObject({ ok: false, exitCode: 2 });
    expect(result.error).toContain("unknown step 'nope'");
    expect(marks()).toEqual([]);
  });
});

describe('a chain’s alert', () => {
  const sent: string[] = [];
  const sink = async (text: string) => {
    sent.push(text);
  };
  beforeEach(() => {
    sent.length = 0;
  });

  it('is one message naming each failed step with its own fix, and what passed', async () => {
    const job = chainJob('close-out', [
      step('capture', { onFail: 'continue' }, 'exit 1'),
      step('disable', { onFail: 'continue' }),
      step('capital', { onFail: 'continue', requires: ['capture'] }),
    ]);
    const result = await runJob(job, ctx, 'manual');
    await alertResult(sink, job, result, ctx.history);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('close-out failed (2 of 3 steps)');
    expect(sent[0]).toContain('• capture: exit 1\n  Fix: fix capture');
    expect(sent[0]).toContain('• capital: skipped: capture did not pass');
    expect(sent[0]).toContain('Passed: disable');
    expect(sent[0]).toContain('jobs run close-out --resume');
  });

  it('says nothing for a step that sends its own alert and really ran', async () => {
    const job = chainJob('friday', [step('rules', { alertsItself: true }, 'exit 1')]);
    const result = await runJob(job, ctx, 'manual');
    await alertResult(sink, job, result, ctx.history);
    expect(sent).toEqual([]);
  });

  it('still says so when a self-alerting step timed out, or a step after it was skipped', async () => {
    const job = chainJob('friday', [
      step('rules', { alertsItself: true }, 'exit 1'),
      step('history'),
    ]);
    const result = await runJob(job, ctx, 'manual');
    await alertResult(sink, job, result, ctx.history);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('• history: not run: rules failed and ends the chain');
    expect(sent[0]).not.toContain('• rules:');
  });

  it('says why a run was refused', async () => {
    const dead = ctx.history.start('c', 'schedule', null, join(dir, 'x.log'), new Date());
    ctx.history.startStep(dead, 'a', new Date());
    ctx.history.reapDead(
      new Date(),
      () => false,
      () => false,
    );
    const job = chainJob('c', [step('a')]);
    const result = await runJob(job, ctx, 'manual', null, { resume: true });
    await alertResult(sink, job, result, ctx.history);
    expect(sent[0]).toContain('a was running when run');
  });
});

describe('maxRunMinutes of a chain', () => {
  it('adds each step’s attempts and delays, and one timeout of group wait', () => {
    const job = chainJob(
      'c',
      [
        step('a', { timeoutMinutes: 8 }),
        step('b', { timeoutMinutes: 6, retries: 2, retryDelayMinutes: 8 }),
        step('c'),
      ],
      { timeoutMinutes: 10, group: 'quantiply' },
    );
    expect(maxRunMinutes(job)).toBe(8 + (6 * 3 + 8 * 2) + 10 + 10);
  });
});

describe('running only some steps of a chain (Apply now)', () => {
  it('runs the picked steps, counts the others as done, and records nothing for them', async () => {
    const job = chainJob('evening', [
      step('collect'),
      step('algotest-export'),
      step('algotest-upload', { requires: ['algotest-export'] }),
      step('quantiply-export'),
    ]);
    const result = await runJob(job, ctx, 'manual', null, {
      only: ['algotest-export', 'algotest-upload'],
    });
    expect(result.ok).toBe(true);
    expect(marks()).toEqual(['algotest-export', 'algotest-upload']);
    expect(statuses(result)).toEqual({ 'algotest-export': 'ok', 'algotest-upload': 'ok' });
    expect(ctx.history.steps(result.runId).map((s) => s.step)).toEqual([
      'algotest-export',
      'algotest-upload',
    ]);
  });

  it('a picked step whose required step is not picked still runs', async () => {
    const job = chainJob('c', [step('a'), step('b', { requires: ['a'] })]);
    const result = await runJob(job, ctx, 'manual', null, { only: ['b'] });
    expect(marks()).toEqual(['b']);
    expect(result.ok).toBe(true);
  });

  it('refuses a step id the chain does not have, and an empty pick', async () => {
    const job = chainJob('c', [step('a')]);
    const bad = await runJob(job, ctx, 'manual', null, { only: ['a', 'nope'] });
    expect(bad).toMatchObject({ ok: false, exitCode: 2 });
    expect(bad.error).toContain("'nope'");
    const none = await runJob(job, ctx, 'manual', null, { only: [] });
    expect(none).toMatchObject({ ok: false, exitCode: 2 });
    expect(marks()).toEqual([]);
  });

  it('never resumes an earlier run', async () => {
    const job = chainJob('c', [step('a'), step('b', {}, 'false')]);
    await runJob(job, ctx, 'manual');
    const again = await runJob(job, ctx, 'manual', null, { only: ['a'] });
    expect(statuses(again)).toEqual({ a: 'ok' });
  });
});

describe('a chain’s groups (BL-234 Phase 3)', () => {
  const holder = (): Job => ({
    ...chainJob('close-out', [step('x')], { group: 'quantiply' }),
  });

  it('are those of the steps that run', () => {
    const job = chainJob('evening', [
      step('collect', { group: 'catalog' }),
      step('up', { group: 'quantiply' }),
      step('plain'),
    ]);
    expect(groupsOf(job)).toEqual(['catalog', 'quantiply']);
    expect(groupsOf(job, ['up'])).toEqual(['quantiply']);
    expect(groupsOf(job, ['plain'])).toEqual([]);
    expect(groupsOf(chainJob('c', [step('a')], { group: 'catalog' }), ['a'])).toEqual(['catalog']);
  });

  it('a step takes its group only when the chain gets to it: earlier steps do not wait', async () => {
    // another job holds `quantiply` and never lets go during this test
    const other = holder();
    ctx.history.start('close-out', 'schedule', null, join(dir, 'o.log'), new Date());
    const job = chainJob(
      'evening',
      [
        step('collect'),
        step('upload', { group: 'quantiply', onFail: 'continue' }),
        step('after', { onFail: 'continue' }),
      ],
      { timeoutMinutes: 0.004 },
    );
    ctx.jobs = [other, job];
    const result = await runJob(job, ctx, 'manual');
    expect(marks()).toEqual(['collect', 'after']); // `upload` never ran
    expect(statuses(result)).toEqual({ collect: 'ok', upload: 'failed', after: 'ok' });
    expect(result.error).toContain("group 'quantiply' still busy with close-out");
  });

  /** A step that does not end until the test says so. */
  const gate = (name: string) => join(dir, name);
  const gated = (id: string, file: string, extra: Partial<ChainStep> = {}) =>
    step(id, extra, `while [ ! -e ${file} ]; do sleep 0.02; done`);
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('holds the group while a later step still needs it, so another job waits', async () => {
    const release = gate('go1');
    const job = chainJob('evening', [
      gated('first', release, { group: 'quantiply' }),
      step('second', { group: 'quantiply' }),
    ]);
    const other = chainJob('close-out', [step('x')], { group: 'quantiply' });
    ctx.jobs = [job, other];
    const first = runJob(job, ctx, 'manual');
    await tick(60); // `first` is running and holds the group
    let otherDone = false;
    const second = runJob(other, ctx, 'manual').then((r) => {
      otherDone = true;
      return r;
    });
    await tick(150);
    expect(otherDone).toBe(false); // `second` of the chain still needs the group
    writeFileSync(release, '');
    await Promise.all([first, second]);
    expect(otherDone).toBe(true);
  });

  it('lets the group go after the last step that needs it, not at the chain’s end', async () => {
    const release = gate('go2');
    const job = chainJob('evening', [
      step('uses', { group: 'catalog' }),
      gated('tail', release), // a long step that needs no group
    ]);
    const other = chainJob('mcx', [step('y')], { group: 'catalog' });
    ctx.jobs = [job, other];
    const running = runJob(job, ctx, 'manual');
    await tick(80); // `uses` has run; the chain is now in `tail`
    const done = await runJob(other, ctx, 'manual'); // starts while the chain is still running
    expect(done.ok).toBe(true);
    expect(ctx.history.last('evening')?.ended_at).toBeNull(); // the chain has not ended
    expect(ctx.history.groupHolders('catalog', [], 0)).toEqual([]); // and holds nothing
    writeFileSync(release, '');
    expect((await running).ok).toBe(true);
  });

  it('takes a group again when a later step needs it after letting it go', async () => {
    const job = chainJob('evening', [
      step('data', { group: 'catalog' }),
      step('mid'),
      step('again', { group: 'catalog' }),
    ]);
    ctx.jobs = [job];
    const result = await runJob(job, ctx, 'manual');
    expect(result.ok).toBe(true);
    expect(marks()).toEqual(['data', 'mid', 'again']);
  });
});
