import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History } from '../history.js';
import type { Job } from '../jobs.js';
import { type RunContext, runJob } from '../runner.js';

function job(id: string, script: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    description: id,
    schedule: { at: '08:00', on: () => true, label: '' },
    steps: [['/bin/sh', '-c', script]],
    cwd: '.',
    timeoutMinutes: 1,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 0,
    fixHint: 'fix it',
    ...extra,
  };
}

let ctx: RunContext;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-'));
  ctx = {
    repoRoot: dir,
    env: { PATH: '/usr/bin:/bin' },
    logDir: join(dir, 'logs'),
    history: new History(':memory:'),
    busyPollMs: 10,
  };
});

afterEach(() => ctx.history.close());

describe('runJob', () => {
  it('records a successful run and writes its output to the log', async () => {
    const result = await runJob(job('ok', 'echo hello'), ctx, 'manual');
    expect(result).toMatchObject({ ok: true, exitCode: 0, attempts: 1, error: null });
    expect(readFileSync(result.logPath, 'utf8')).toContain('hello');
    expect(ctx.history.last('ok')).toMatchObject({ exit_code: 0, trigger: 'manual' });
  });

  it('retries a failing job and records the final exit code', async () => {
    const result = await runJob(job('bad', 'exit 3', { retries: 1 }), ctx, 'schedule');
    expect(result).toMatchObject({ ok: false, exitCode: 3, attempts: 2, error: 'exit 3' });
    expect(ctx.history.last('bad')?.attempts).toBe(2);
  });

  it('stops at the first failing step', async () => {
    const steps = [
      ['/bin/sh', '-c', 'exit 1'],
      ['/bin/sh', '-c', 'echo should-not-run'],
    ];
    const result = await runJob({ ...job('steps', ''), steps }, ctx, 'manual');
    expect(result.ok).toBe(false);
    expect(readFileSync(result.logPath, 'utf8')).not.toContain('$ /bin/sh -c echo should-not-run');
  });

  it('writes to a fixed log file when the job names one', async () => {
    const result = await runJob(
      job('fixed', 'echo kept', { logFile: 'data/x.log' }),
      ctx,
      'manual',
    );
    expect(result.logPath).toBe(join(ctx.repoRoot, 'data/x.log'));
    expect(readFileSync(result.logPath, 'utf8')).toContain('kept');
  });

  it('reports a missing executable instead of throwing', async () => {
    const result = await runJob(
      { ...job('missing', ''), steps: [['no-such-binary-xyz']] },
      ctx,
      'manual',
    );
    expect(result).toMatchObject({ ok: false, exitCode: 127 });
  });

  it('never runs two jobs of the same group at once', async () => {
    const stamp = (name: string) =>
      `echo ${name}-start $(date +%s%N) >> ${ctx.repoRoot}/order; sleep 0.2; echo ${name}-end $(date +%s%N) >> ${ctx.repoRoot}/order`;
    const a = job('a', stamp('a'), { group: 'catalog' });
    const b = job('b', stamp('b'), { group: 'catalog' });
    ctx.jobs = [a, b];
    await Promise.all([runJob(a, ctx, 'manual'), runJob(b, ctx, 'manual')]);
    const order = readFileSync(join(ctx.repoRoot, 'order'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' ')[0]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('gives up when another process holds the group past the timeout', async () => {
    const a = job('a', 'true', { group: 'catalog', timeoutMinutes: 0 });
    ctx.jobs = [a, job('other', 'true', { group: 'catalog', timeoutMinutes: 5 })];
    ctx.history.start('other', 'manual', null, '/dev/null', new Date()); // never finished
    const result = await runJob(a, ctx, 'schedule');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("group 'catalog' still busy with other");
  });
});
