import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action, TgUpdate, UpdatesResult } from '@trading/notify';
import { History } from '../history.js';
import { JOBS, type Job } from '../jobs.js';
import { type BuiltinContext, runJob } from '../runner.js';
import { istAt } from '../schedule.js';
import {
  CONFIRM_TTL_MS,
  StopButton,
  type StopPort,
  stopButtonProblem,
  withStopOffer,
} from '../stop-button.js';
import {
  type HoldInfo,
  STOP_HELD_JOBS,
  clearMemoryHold,
  heldReason,
  holdFile,
  holdInMemory,
  readHold,
  stateHoldFile,
} from '../stop-hold.js';

/** Never the real scheduler state dir: the hold's second copy lives there. */
const SAFE_STATE = join(tmpdir(), `stop-button-test-${process.pid}`);

/**
 * The stop button's taps against a stand-in Telegram port: never the real API, never the real
 * runner (its plan, apply and resume are stubs that only count their calls).
 */

const OWNER = 111;
const STRANGER = 222;
const GROUP = -1003;
const at = istAt('2026-10-20', '10:00');

interface Sent {
  text: string;
  buttons?: Action[] | undefined;
}

function harness(
  opts: { applyCode?: number; held?: HoldInfo | null; refused?: string; memoryOn?: boolean } = {},
) {
  let now = at;
  let hold: HoldInfo | null = opts.held ?? null;
  const sent: Sent[] = [];
  const answers: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let plans = 0;
  let n = 0;
  const applies: string[] = [];
  const resumes: string[] = [];
  const memory = { held: opts.memoryOn ?? false, holds: 0 };
  const port: StopPort = {
    send: async (text, buttons) => {
      sent.push({ text, buttons });
    },
    answer: async (_id, text) => {
      answers.push(text);
    },
    getUpdates: async (): Promise<UpdatesResult> => ({ ok: true, updates: [] }),
  };
  const button = new StopButton({
    port,
    ownerChatId: OWNER,
    now: () => now,
    plan: async () => {
      plans += 1;
      return 'PLAN: square off Core · A';
    },
    apply: async (by) => {
      applies.push(by);
      hold = { at: now.toISOString(), by };
      return {
        code: opts.applyCode ?? 0,
        logPath: '/tmp/x.log',
        ...(opts.refused ? { refused: opts.refused } : {}),
      };
    },
    resume: async (by) => {
      resumes.push(by);
      hold = null;
      return { code: 0 };
    },
    hold: () => hold,
    memory: {
      hold: () => {
        memory.holds += 1;
        if (memory.held) return false;
        memory.held = true;
        return true;
      },
      clear: () => {
        memory.held = false;
      },
    },
    log: (row) => {
      logs.push(row);
    },
    runningHeldJobs: () => [],
    nonce: () => {
      n += 1;
      return `n${n}`;
    },
  });
  let id = 0;
  const next = () => {
    id += 1;
    return id;
  };
  const tap = (data: string, chat = OWNER, from = OWNER): TgUpdate => ({
    update_id: next(),
    callback_query: {
      id: `cb${id}`,
      from: { id: from },
      data,
      message: { message_id: 1, chat: { id: chat } },
    },
  });
  const msg = (text: string, chat = OWNER, from = OWNER): TgUpdate => ({
    update_id: next(),
    message: { message_id: id, chat: { id: chat }, from: { id: from }, text },
  });
  return {
    button,
    sent,
    answers,
    logs,
    applies,
    resumes,
    memory,
    plans: () => plans,
    tap,
    msg,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('stop button: who may press it', () => {
  it('/stop from the owner offers the button for today; it only shows the plan', async () => {
    const h = harness();
    await h.button.handle(h.msg('/stop'));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.buttons).toEqual([
      { label: '🛑 Stop everything', data: 'stop:ask:2026-10-20' },
    ]);
    expect(h.applies).toEqual([]);
  });

  it('ignores and logs anyone else: another user, the friends group, a stranger in a group', async () => {
    const h = harness();
    await h.button.handle(h.msg('/stop', STRANGER, STRANGER));
    await h.button.handle(h.msg('/stop', GROUP, OWNER));
    await h.button.handle(h.tap('stop:ask:2026-10-20', GROUP, OWNER));
    await h.button.handle(h.tap('stop:ask:2026-10-20', OWNER, STRANGER));
    await h.button.handle(h.tap('stop:go:n1', STRANGER, STRANGER));
    await h.button.handle(h.tap('stop:rgo:n1', STRANGER, STRANGER));
    expect(h.sent).toEqual([]);
    expect(h.answers).toEqual([]);
    expect(h.plans()).toBe(0);
    expect(h.logs.filter((l) => l.event === 'ignored')).toHaveLength(6);
  });

  it('ignores the owner’s other messages', async () => {
    const h = harness();
    await h.button.handle(h.msg('hello'));
    await h.button.handle(h.msg('/stopnow'));
    expect(h.sent).toEqual([]);
  });
});

describe('stop button: two taps', () => {
  it('first tap shows the plan and a confirm button; only the second tap acts, once', async () => {
    const h = harness();
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    expect(h.plans()).toBe(1);
    expect(h.applies).toEqual([]);
    const confirm = h.sent.at(-1);
    expect(confirm?.text).toContain('PLAN: square off Core · A');
    expect(confirm?.text).toContain('algotest-deploy');
    expect(confirm?.buttons).toEqual([
      { label: 'Yes, stop and square off', data: 'stop:go:n1' },
      { label: 'Cancel', data: 'stop:no:n1' },
    ]);
    await h.button.handle(h.tap('stop:go:n1'));
    await h.button.idle();
    expect(h.applies).toHaveLength(1);
    // the same nonce again: refused
    await h.button.handle(h.tap('stop:go:n1'));
    await h.button.idle();
    expect(h.applies).toHaveLength(1);
    expect(h.answers.at(-1)).toContain('nothing done');
  });

  it('a double tap on the offer re-sends the same confirm: the first Yes still works', async () => {
    const h = harness();
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    const data = h.sent.map((s) => s.buttons?.[0]?.data);
    expect(data).toEqual(['stop:go:n1', 'stop:go:n1']);
    await h.button.handle(h.tap('stop:go:n1'));
    await h.button.idle();
    expect(h.applies).toHaveLength(1);
  });

  it('a confirm older than 2 minutes does nothing', async () => {
    const h = harness();
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    h.advance(CONFIRM_TTL_MS + 1000);
    await h.button.handle(h.tap('stop:go:n1'));
    expect(h.applies).toEqual([]);
    expect(h.answers.at(-1)).toContain('Expired');
  });

  it('a made-up nonce, or one after Cancel, does nothing', async () => {
    const h = harness();
    await h.button.handle(h.tap('stop:go:guess'));
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    await h.button.handle(h.tap('stop:no:n1'));
    await h.button.handle(h.tap('stop:go:n1'));
    expect(h.applies).toEqual([]);
  });

  it("yesterday's offer button only says to send /stop", async () => {
    const h = harness();
    await h.button.handle(h.tap('stop:ask:2026-10-19'));
    expect(h.plans()).toBe(0);
    expect(h.answers.at(-1)).toContain('send /stop');
  });

  it("a refused stop never lifts an earlier stop's memory hold; it says why", async () => {
    const h = harness({
      applyCode: 2,
      memoryOn: true,
      refused: 'a stop is already running since 09:30 (pid 7)',
    });
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    await h.button.handle(h.tap('stop:go:n1'));
    await h.button.idle();
    expect(h.memory.held).toBe(true);
    expect(h.sent.at(-1)?.text).toContain('did NOTHING: a stop is already running since 09:30');
  });

  it('holds in memory at the confirm; a refused runner (exit 2) lifts it again', async () => {
    const h = harness({ applyCode: 2 });
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    expect(h.memory.held).toBe(false);
    await h.button.handle(h.tap('stop:go:n1'));
    await h.button.idle();
    expect(h.memory.holds).toBe(1); // held at the confirm
    expect(h.memory.held).toBe(false); // and lifted: the runner refused
    const ok = harness({ applyCode: 3 });
    await ok.button.handle(ok.tap('stop:ask:2026-10-20'));
    await ok.button.handle(ok.tap('stop:go:n1'));
    await ok.button.idle();
    expect(ok.memory.held).toBe(true);
  });

  it('says what each runner exit means for the owner', async () => {
    const cases: Array<[number, RegExp | null]> = [
      [0, null],
      [3, null], // the runner sent its own report
      [2, /did NOTHING: the runner refused/],
      [4, /report could not be delivered\. Square-offs may already be in flight: open AlgoTest/],
      [1, /exit 1 \(stopped or timed out\)\. Square-offs may already be in flight/],
    ];
    for (const [code, want] of cases) {
      const h = harness({ applyCode: code });
      await h.button.handle(h.tap('stop:ask:2026-10-20'));
      await h.button.handle(h.tap('stop:go:n1'));
      await h.button.idle();
      const last = h.sent.at(-1)?.text ?? '';
      if (want) expect(last).toMatch(want);
      else expect(last).toContain('Stop confirmed');
    }
  });
});

describe('stop button: the hold until the owner lifts it', () => {
  const held: HoldInfo = { at: '2026-10-19T04:00:00Z', by: 'telegram' };

  it('while held, /stop says so and offers Resume as well', async () => {
    const h = harness({ held });
    await h.button.handle(h.msg('/stop'));
    expect(h.sent[0]?.text).toContain('stop hold is ON');
    expect(h.sent[0]?.buttons?.map((b) => b.data)).toEqual([
      'stop:ask:2026-10-20',
      'stop:resume:2026-10-20',
    ]);
  });

  it('Resume needs its own confirm tap, then lifts the hold', async () => {
    const h = harness({ held });
    await h.button.handle(h.tap('stop:resume:2026-10-20'));
    expect(h.resumes).toEqual([]);
    expect(h.sent.at(-1)?.buttons?.[0]).toEqual({
      label: 'Yes, lift the hold',
      data: 'stop:rgo:n1',
    });
    // a stop nonce never lifts the hold, nor a resume nonce stop anything
    await h.button.handle(h.tap('stop:go:n1'));
    expect(h.applies).toEqual([]);
    await h.button.handle(h.tap('stop:rgo:n1'));
    expect(h.resumes).toHaveLength(1);
    expect(h.sent.at(-1)?.text).toContain('hold is lifted');
    // used once
    await h.button.handle(h.tap('stop:rgo:n1'));
    expect(h.resumes).toHaveLength(1);
  });

  it('/resume with no hold says there is nothing to lift', async () => {
    const h = harness();
    await h.button.handle(h.msg('/resume'));
    expect(h.sent.at(-1)?.text).toContain('No stop hold is on');
  });

  it('an expired Resume confirm does nothing', async () => {
    const h = harness({ held });
    await h.button.handle(h.msg('/resume'));
    h.advance(CONFIRM_TTL_MS + 1000);
    await h.button.handle(h.tap('stop:rgo:n1'));
    expect(h.resumes).toEqual([]);
  });
});

describe('stop button: configuration and the morning message', () => {
  const ok = {
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_CHAT_ID: '111',
    TELEGRAM_ROTATION_CHAT_ID: '-1003',
    TRADING_DATA_ROOT: '/x',
    SCHEDULER_STATE_DIR: SAFE_STATE,
  };
  it('needs the owner’s private chat, never a group or the friends group', () => {
    expect(stopButtonProblem(ok)).toBeNull();
    expect(stopButtonProblem({ ...ok, TELEGRAM_CHAT_ID: '-1003' })).toContain('private chat');
    expect(stopButtonProblem({ ...ok, TELEGRAM_ROTATION_CHAT_ID: '111' })).toContain('friends');
    expect(stopButtonProblem({ ...ok, TELEGRAM_BOT_TOKEN: '' })).toContain('TELEGRAM_BOT_TOKEN');
    expect(stopButtonProblem({ ...ok, TRADING_DATA_ROOT: '' })).toContain('TRADING_DATA_ROOT');
  });

  it('the morning message: the offer with STOP_BUTTON=on, the hold line every day it is on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stop-am-'));
    try {
      const sent: Sent[] = [];
      const port = () => ({
        send: async (text: string, buttons?: Action[]) => {
          sent.push({ text, buttons });
        },
        answer: async () => undefined,
        getUpdates: async (): Promise<UpdatesResult> => ({ ok: true, updates: [] }),
      });
      const summary = async () => ({ code: 0, error: null });
      const ctx = (env: Record<string, string>) =>
        ({ env, now: () => at, log: () => undefined }) as unknown as BuiltinContext;
      const env = { ...ok, TRADING_DATA_ROOT: root };
      await withStopOffer(summary, port)(ctx(env));
      expect(sent).toEqual([]);
      await withStopOffer(summary, port)(ctx({ ...env, STOP_BUTTON: 'on' }));
      expect(sent[0]?.buttons?.map((b) => b.data)).toEqual(['stop:ask:2026-10-20']);
      mkdirSync(join(root, 'stop'));
      writeFileSync(holdFile(root), JSON.stringify({ at: '2026-10-19T04:00:00Z', by: 'x' }));
      await withStopOffer(summary, port)(ctx({ ...env, STOP_BUTTON: 'on' }));
      expect(sent[1]?.text).toContain('stop hold is ON');
      expect(sent[1]?.buttons?.map((b) => b.data)).toContain('stop:resume:2026-10-20');
      // the button off: still says the hold is on
      await withStopOffer(summary, port)(ctx(env));
      expect(sent[2]?.text).toContain('stop hold is ON');
      expect(sent[2]?.buttons).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stop hold: no job that could upload, deploy or enable runs while it is on', () => {
  let root: string;
  let history: History;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stop-hold-'));
    history = new History(':memory:');
  });
  afterEach(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
    clearMemoryHold();
  });

  it('every held job exists, and the disable safety net is never held', () => {
    for (const id of STOP_HELD_JOBS) expect(JOBS.some((j) => j.id === id)).toBe(true);
    expect(STOP_HELD_JOBS).not.toContain('quantiply-disable');
  });

  it('reads the same files broker-login writes, until it is lifted, any day', () => {
    expect(holdFile(root)).toBe(join(root, 'stop', 'HOLD.json'));
    const env = { TRADING_DATA_ROOT: root, SCHEDULER_STATE_DIR: join(root, 'state') };
    expect(stateHoldFile(env)).toBe(join(root, 'state', 'stop-hold.json'));
    expect(heldReason('algotest-deploy', env)).toBeNull();
    mkdirSync(join(root, 'stop'));
    writeFileSync(holdFile(root), 'not json');
    expect(readHold(env)?.by).toBe('unreadable hold file'); // still holds
    expect(heldReason('algotest-deploy', env)).toContain('held');
    expect(heldReason('quantiply-disable', env)).toBeNull();
  });

  it('either file holds, and so does this process’s memory when no file could be written', () => {
    const env = { TRADING_DATA_ROOT: join(root, 'gone'), SCHEDULER_STATE_DIR: join(root, 'state') };
    expect(heldReason('quantiply-deploy', env)).toBeNull();
    mkdirSync(join(root, 'state'));
    writeFileSync(stateHoldFile(env), JSON.stringify({ at: 'x', by: 'y' }));
    expect(heldReason('quantiply-deploy', env)).toContain('held');
    rmSync(stateHoldFile(env));
    expect(holdInMemory('telegram 111')).toBe(true);
    expect(holdInMemory('telegram 111 again')).toBe(false); // the first one stands
    expect(heldReason('quantiply-deploy', env)).toContain('held');
    expect(heldReason('quantiply-disable', env)).toBeNull();
    clearMemoryHold();
    expect(heldReason('quantiply-deploy', env)).toBeNull();
  });

  it('runJob records a held job as held, whoever started it, and runs nothing', async () => {
    mkdirSync(join(root, 'stop'));
    writeFileSync(holdFile(root), JSON.stringify({ at: '2026-10-19T04:00:00Z', by: 'x' }));
    const marker = join(root, 'ran');
    const job: Job = {
      id: 'quantiply-evening',
      description: 'x',
      schedule: { at: '16:45', on: () => true, label: '' },
      steps: [['/bin/sh', '-c', `touch ${marker}`]],
      cwd: '.',
      timeoutMinutes: 1,
      retries: 0,
      retryDelayMinutes: 0,
      catchUpHours: 0,
      fixHint: '',
    };
    const ctx = {
      repoRoot: '/',
      env: {
        TRADING_DATA_ROOT: root,
        SCHEDULER_STATE_DIR: SAFE_STATE,
        PATH: process.env.PATH ?? '',
      },
      logDir: root,
      history,
      jobs: [job],
    };
    for (const trigger of ['schedule', 'manual'] as const) {
      const r = await runJob(job, ctx, trigger);
      expect(r.ok).toBe(true);
      expect(r.attempts).toBe(0);
      expect(r.error).toContain('stop button');
    }
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it('a hold that starts before a retry keeps the earlier attempt’s failure as the result', async () => {
    const env = {
      TRADING_DATA_ROOT: root,
      SCHEDULER_STATE_DIR: SAFE_STATE,
      PATH: process.env.PATH ?? '',
    };
    // the first attempt fails, and the stop's hold lands before the retry
    const job: Job = {
      id: 'quantiply-evening',
      description: 'x',
      schedule: { at: '16:45', on: () => true, label: '' },
      steps: [
        [
          '/bin/sh',
          '-c',
          `mkdir -p ${join(root, 'stop')} && echo '{}' > ${holdFile(root)}; exit 1`,
        ],
      ],
      cwd: '.',
      timeoutMinutes: 1,
      retries: 2,
      retryDelayMinutes: 0,
      catchUpHours: 0,
      fixHint: '',
    };
    const r = await runJob(
      job,
      { repoRoot: '/', env, logDir: root, history, jobs: [job] },
      'schedule',
    );
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.attempts).toBe(1);
    expect(r.error).toContain('exit 1; retry held');
  });
});
