import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertMissed, alertResult, telegramSink } from '../alerts.js';
import { History } from '../history.js';
import type { Job } from '../jobs.js';
import { decide, skippedToday, startLoop } from '../loop.js';
import { type RunResult, runJob } from '../runner.js';
import { istAt } from '../schedule.js';
import { formatSummary, jobChecks, morningSummary } from '../summary.js';

const job: Job = {
  id: 'login',
  description: 'Morning login',
  schedule: { at: '08:00', on: () => true, label: '' },
  steps: [['/bin/sh', '-c', 'true']],
  cwd: '.',
  timeoutMinutes: 1,
  retries: 0,
  retryDelayMinutes: 0,
  catchUpHours: 2,
  fixHint: 'log in by hand',
};

let history: History;
const longAgo = new Date('2026-01-01T00:00:00Z');

beforeEach(() => {
  history = new History(':memory:');
});
afterEach(() => history.close());

describe('decide', () => {
  it('runs a slot that is due now', () => {
    const d = decide(job, istAt('2026-10-06', '08:01'), history, longAgo);
    expect(d).toMatchObject({ kind: 'run', trigger: 'schedule' });
  });

  it('catches up after the laptop slept through the slot, within the window', () => {
    const d = decide(job, istAt('2026-10-06', '09:30'), history, longAgo);
    expect(d).toMatchObject({ kind: 'run', trigger: 'catch-up' });
  });

  it('reports a slot as missed once it is too late to catch up', () => {
    const d = decide(job, istAt('2026-10-06', '10:30'), history, longAgo);
    expect(d.kind).toBe('missed');
  });

  /** One tick of the real loop at `at`, returning the alerts it sent. */
  const tickAt = (jobs: Job[], at: Date): string[] => {
    const sent: string[] = [];
    const stop = startLoop({
      ctx: { repoRoot: '.', env: {}, logDir: tmpdir(), history, now: () => at },
      jobs,
      alerts: async (text) => {
        sent.push(text);
      },
    });
    stop();
    return sent;
  };

  it('does not report a slot from before a newly added job existed', () => {
    history.firstStart(longAgo); // the scheduler has been running for months
    const added: Job = { ...job, id: 'new-job' };
    expect(tickAt([added], istAt('2026-10-06', '10:30'))).toEqual([]);
    expect(history.forSlot('new-job', istAt('2026-10-06', '08:00'))).toBeNull();
    // Once seen, a slot it then sleeps through is reported like any other job's.
    const sent = tickAt([added], istAt('2026-10-07', '10:30'));
    expect(sent[0]).toContain('⚠️ new-job was missed');
  });

  it('still reports a missed slot of a job with history, after a restart', () => {
    history.firstStart(longAgo);
    const monday = istAt('2026-10-05', '08:00');
    const run = history.start('login', 'schedule', monday, '', monday);
    history.finish(run, 0, 1, monday);
    // The scheduler was down over Tuesday's 08:00 and restarted at 10:30.
    const sent = tickAt([job], istAt('2026-10-06', '10:30'));
    expect(sent[0]).toContain('⚠️ login was missed');
    expect(history.forSlot('login', istAt('2026-10-06', '08:00'))?.error).toContain('missed');
  });

  it('does nothing for a slot that already has a run, ok or not', () => {
    const slot = istAt('2026-10-06', '08:00');
    history.recordMissed('login', slot, slot, 'missed');
    expect(decide(job, istAt('2026-10-06', '10:30'), history, longAgo).kind).toBe('idle');
  });

  it('ignores slots from before the scheduler was first started', () => {
    const firstStart = istAt('2026-10-06', '10:00');
    expect(decide(job, istAt('2026-10-06', '10:30'), history, firstStart).kind).toBe('idle');
  });
});

describe('alerts', () => {
  const sent: string[] = [];
  const sink = async (text: string) => {
    sent.push(text);
  };
  beforeEach(() => {
    sent.length = 0;
  });

  const result = (over: Partial<RunResult>): RunResult => ({
    runId: 1,
    ok: false,
    exitCode: 1,
    attempts: 1,
    logPath: '/tmp/x.log',
    error: 'exit 1',
    ...over,
  });

  it('alerts at once on a failure, with the fix', async () => {
    await alertResult(sink, job, result({}), history);
    expect(sent[0]).toContain('❌ login failed');
    expect(sent[0]).toContain('Fix: log in by hand');
  });

  it('does not repeat the alert of a job that alerts on its own failures', async () => {
    await alertResult(sink, { ...job, alertsItself: true }, result({}), history);
    expect(sent).toEqual([]);
  });

  it('still alerts for such a job when it timed out and never got to report', async () => {
    await alertResult(sink, { ...job, alertsItself: true }, result({ exitCode: 124 }), history);
    expect(sent).toHaveLength(1);
  });

  it('says when a job recovers, and stays quiet on an ordinary success', async () => {
    const at = new Date();
    const failed = history.start('login', 'schedule', null, '', at);
    history.finish(failed, 1, 1, at, 'exit 1');
    const ok = history.start('login', 'schedule', null, '', at);
    history.finish(ok, 0, 1, at);
    await alertResult(sink, job, result({ runId: ok, ok: true, exitCode: 0 }), history);
    expect(sent[0]).toContain('✅ login recovered');
    const again = history.start('login', 'schedule', null, '', at);
    history.finish(again, 0, 1, at);
    await alertResult(sink, job, result({ runId: again, ok: true, exitCode: 0 }), history);
    expect(sent).toHaveLength(1);
  });

  it('reports a missed slot with the fix', async () => {
    await alertMissed(sink, job, istAt('2026-10-06', '08:00'));
    expect(sent[0]).toContain('⚠️ login was missed');
  });
});

describe('morning summary', () => {
  it('is all good only when every check is ok', () => {
    expect(formatSummary('2026-10-06', [{ ok: true, label: 'a', detail: 'fine' }]).text).toContain(
      'all good',
    );
    const bad = formatSummary('2026-10-06', [
      { ok: true, label: 'a', detail: 'fine' },
      { ok: false, label: 'b', detail: 'broken' },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('1 problem');
    expect(bad.text).toContain('❌ b: broken');
  });

  it("lists today's slots: ok, failed with its fix, and not run yet", () => {
    const now = istAt('2026-10-06', '09:00');
    const late = { ...job, id: 'late', schedule: { ...job.schedule, at: '08:30' } };
    const jobs = [job, { ...job, id: 'broken' }, late];
    history.firstStart(longAgo); // the scheduler was already running at 08:00
    history.jobFirstSeen('late', longAgo); // and already knew the job that has no runs yet
    const okRun = history.start('login', 'schedule', istAt('2026-10-06', '08:00'), '', now);
    history.finish(okRun, 0, 1, now);
    const badRun = history.start('broken', 'schedule', istAt('2026-10-06', '08:00'), '', now);
    history.finish(badRun, 1, 1, now, 'exit 1');
    const checks = jobChecks({
      repoRoot: '.',
      env: {},
      logDir: '/tmp',
      history,
      jobs,
      now: () => now,
      log: () => undefined,
    });
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['login', true],
      ['broken', false],
      ['late', false],
    ]);
    expect(checks[1]?.detail).toContain('log in by hand');
  });

  it('runs as a builtin job through the runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-'));
    const builtinJob: Job = { ...job, id: 'summary', steps: [], builtin: 'morning-summary' };
    const result = await runJob(
      builtinJob,
      {
        repoRoot: dir,
        env: {},
        logDir: dir,
        history,
        builtins: {
          'morning-summary': async (ctx) => {
            ctx.log('summary text');
            return { code: 0, error: null };
          },
        },
      },
      'manual',
    );
    expect(result.ok).toBe(true);
  });
});

describe('review fixes', () => {
  it("lists a Friday failure on Monday's summary, not only the last 24 h", async () => {
    const monday = istAt('2026-10-12', '09:00');
    const friday = istAt('2026-10-09', '19:30');
    const id = history.start('momentum-final', 'schedule', friday, '', friday);
    history.finish(id, 1, 1, friday, 'exit 1');
    const lines: string[] = [];
    // No system checks: the real ones run `gh`, `uv run mbt` and git, which took ~10 s on CI.
    await morningSummary(
      async () => undefined,
      () => [],
    )({
      repoRoot: '.',
      env: { PATH: '/usr/bin:/bin' },
      logDir: '/tmp',
      history,
      jobs: [],
      now: () => monday,
      log: (text) => lines.push(text),
    });
    expect(lines.join('\n')).toContain('momentum-final');
  });

  it('waits for another process to finish writing instead of failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-db-'));
    const a = new History(join(dir, 's.db'));
    const b = new History(join(dir, 's.db'));
    a.start('x', 'manual', null, '', new Date());
    expect(() => b.start('y', 'manual', null, '', new Date())).not.toThrow();
    a.close();
    b.close();
  });
});

describe('skippedToday', () => {
  it("lists today's slots that already passed with no run, for the install message", () => {
    const now = istAt('2026-10-06', '08:03');
    const jobs = [job, { ...job, id: 'later', schedule: { ...job.schedule, at: '09:00' } }];
    expect(skippedToday(jobs, now, history).map((x) => x.job.id)).toEqual(['login']);
    const run = history.start('login', 'manual', istAt('2026-10-06', '08:00'), '', now);
    history.finish(run, 0, 1, now);
    expect(skippedToday(jobs, now, history)).toEqual([]);
  });
});

describe('telegramSink types', () => {
  it('skips a switched-off type but always sends an untyped alert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-prefs-'));
    const prefs = join(dir, 'notifications.json');
    await Bun.write(prefs, '{"disabled": ["scheduler.morning"]}');
    process.env.NOTIFY_PREFS_FILE = prefs;
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const env = { TELEGRAM_BOT_TOKEN: 'token-1234', TELEGRAM_CHAT_ID: '1' };
    try {
      await telegramSink(env, 'scheduler.morning')('summary');
      expect(calls).toBe(0);
      await telegramSink(env)('a failure alert');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      Reflect.deleteProperty(process.env, 'NOTIFY_PREFS_FILE');
    }
  });
});
