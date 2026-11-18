import { describe, expect, it } from 'bun:test';
import { CHECK_BUILTINS, CHECK_JOBS } from '../checks/index.js';
import { type SuiteMember, checkSuite } from '../checks/types.js';
import { JOBS } from '../jobs.js';
import type { Builtin, BuiltinContext } from '../runner.js';

const ok: Builtin = async () => ({ code: 0, error: null });
const fails =
  (error: string): Builtin =>
  async () => ({ code: 1, error });

function context(lines: string[] = []): BuiltinContext {
  return {
    log: (text: string) => void lines.push(text),
    now: () => new Date(),
  } as unknown as BuiltinContext;
}

const member = (id: string, extra: Partial<SuiteMember> = {}): SuiteMember => ({
  id,
  builtin: id,
  fixHint: `fix ${id}`,
  ...extra,
});

describe('checkSuite (BL-234)', () => {
  it('passes when every member passes, running each once', async () => {
    const calls: string[] = [];
    const record =
      (id: string): Builtin =>
      async () => {
        calls.push(id);
        return { code: 0, error: null };
      };
    const run = checkSuite([member('a'), member('b')], () => ({ a: record('a'), b: record('b') }));
    expect(await run(context())).toEqual({ code: 0, error: null });
    expect(calls).toEqual(['a', 'b']);
  });

  it('runs every member even after one fails, and names each problem with its own fix', async () => {
    const lines: string[] = [];
    const run = checkSuite([member('a'), member('b'), member('c')], () => ({
      a: fails('lot sizes differ'),
      b: ok,
      c: fails('gh is logged out'),
    }));
    const result = await run(context(lines));
    expect(result.code).toBe(1);
    expect(result.error).toContain('2 of 3 checks found a problem');
    expect(result.error).toContain('• a: lot sizes differ\n  Fix: fix a');
    expect(result.error).toContain('• c: gh is logged out\n  Fix: fix c');
    expect(result.error).not.toContain('• b');
  });

  it('prefixes each member’s log lines with its id', async () => {
    const lines: string[] = [];
    const speaks: Builtin = async (ctx) => {
      ctx.log('ok: fine');
      return { code: 0, error: null };
    };
    await checkSuite([member('a')], () => ({ a: speaks }))(context(lines));
    expect(lines).toContain('[a] ok: fine');
  });

  it('counts a member that throws, or is not registered, as a problem', async () => {
    const run = checkSuite([member('a'), member('missing')], () => ({
      a: async () => {
        throw new Error('network down');
      },
    }));
    const result = await run(context());
    expect(result.error).toContain('• a: network down');
    expect(result.error).toContain("• missing: builtin 'missing' is not registered");
  });

  it('retries only a failed member that has retries, after its delay, and not the others', async () => {
    const calls: string[] = [];
    let attempts = 0;
    const flaky: Builtin = async () => {
      calls.push('flaky');
      attempts += 1;
      return attempts < 3 ? { code: 1, error: 'blip' } : { code: 0, error: null };
    };
    const steady: Builtin = async () => {
      calls.push('steady');
      return { code: 0, error: null };
    };
    const waits: number[] = [];
    const run = checkSuite(
      [member('flaky', { retries: 2, retryDelayMinutes: 30 }), member('steady')],
      () => ({ flaky, steady }),
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(await run(context())).toEqual({ code: 0, error: null });
    expect(calls).toEqual(['flaky', 'steady', 'flaky', 'flaky']);
    expect(waits).toEqual([30 * 60_000, 30 * 60_000]);
  });

  it('gives up after the retries and reports the last error; a member without retries is not retried', async () => {
    const waits: number[] = [];
    const run = checkSuite(
      [member('net', { retries: 1, retryDelayMinutes: 5 }), member('local')],
      () => ({ net: fails('still down'), local: fails('local problem') }),
      async (ms) => {
        waits.push(ms);
      },
    );
    const result = await run(context());
    expect(waits).toEqual([5 * 60_000]);
    expect(result.error).toContain('• net: still down');
    expect(result.error).toContain('• local: local problem');
  });
});

describe('the registered check suites (BL-234)', () => {
  const morning = [
    'check-nifty50-membership',
    'calendar-upkeep',
    'check-blocked-dates',
    'gh-auth-check',
    'universe-refresh-reminder',
    'check-stock-ca-baseline-age',
    'check-stock-review-queue',
  ];
  const evening = ['check-lot-sizes', 'check-expiry-calendar'];

  it('replaces nine check jobs by two', () => {
    const ids = JOBS.map((j) => j.id);
    for (const id of [...morning, ...evening]) expect(ids, id).not.toContain(id);
    expect(ids).toContain('morning-checks');
    expect(ids).toContain('evening-checks');
  });

  it('keeps the checks that fire on their own day, and the digest, as jobs of their own', () => {
    const ids = CHECK_JOBS.map((j) => j.id);
    expect(ids).toContain('margin-reminder');
    expect(ids).toContain('credential-rotation-reminder');
    expect(ids).toContain('weekly-digest');
  });

  it('runs on trading days at 08:30 and 17:00, with a builtin registered for each', () => {
    for (const [id, at] of [
      ['morning-checks', '08:30'],
      ['evening-checks', '17:00'],
    ] as const) {
      const job = JOBS.find((j) => j.id === id);
      expect(job?.schedule.at).toBe(at);
      expect(job?.schedule.on('2026-10-17')).toBe(false); // a Saturday
      expect(job?.schedule.on('2026-10-19')).toBe(true); // a Monday
      expect(CHECK_BUILTINS[job?.builtin ?? '']).toBeDefined();
    }
  });

  it('keeps the NSE check’s home-connection need, and leaves room for its two 30-minute retries', () => {
    const job = JOBS.find((j) => j.id === 'morning-checks');
    expect(job?.needs).toContain('home');
    expect(job?.timeoutMinutes ?? 0).toBeGreaterThanOrEqual(5 * 3 + 30 * 2);
  });
});
