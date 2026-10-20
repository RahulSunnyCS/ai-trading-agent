import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action, TgUpdate, UpdatesResult } from '@trading/notify';
import { History } from '../history.js';
import { JOBS, type Job } from '../jobs.js';
import { startLoop } from '../loop.js';
import type { BuiltinContext } from '../runner.js';
import { istAt } from '../schedule.js';
import {
  CONFIRM_TTL_MS,
  StopButton,
  type StopPort,
  stopButtonProblem,
  withStopOffer,
} from '../stop-button.js';
import { STOP_HELD_JOBS, StopHold, holdFile } from '../stop-hold.js';

/**
 * The stop button's two taps against a stand-in Telegram port: never the real API, never the
 * real runner (its plan and apply are stubs that only count their calls).
 */

const OWNER = 111;
const STRANGER = 222;
const GROUP = -1003;
const at = istAt('2026-10-20', '10:00');

interface Sent {
  text: string;
  buttons?: Action[] | undefined;
}

function harness(opts: { applyCode?: number } = {}) {
  let now = at;
  const sent: Sent[] = [];
  const answers: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const marked: string[] = [];
  let plans = 0;
  const applies: string[] = [];
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
      return { code: opts.applyCode ?? 0, logPath: '/tmp/x.log' };
    },
    log: (row) => {
      logs.push(row);
    },
    hold: { mark: (d) => marked.push(d) },
    runningHeldJobs: () => [],
    nonce: () => 'n1',
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
    marked,
    applies,
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
    expect(h.sent).toEqual([]);
    expect(h.answers).toEqual([]);
    expect(h.plans()).toBe(0);
    expect(h.logs.filter((l) => l.event === 'ignored')).toHaveLength(5);
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
    expect(h.marked).toEqual(['2026-10-20']);
    // the same nonce again: refused
    await h.button.handle(h.tap('stop:go:n1'));
    await h.button.idle();
    expect(h.applies).toHaveLength(1);
    expect(h.answers.at(-1)).toContain('nothing done');
  });

  it('a confirm older than 2 minutes does nothing', async () => {
    const h = harness();
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    h.advance(CONFIRM_TTL_MS + 1000);
    await h.button.handle(h.tap('stop:go:n1'));
    expect(h.applies).toEqual([]);
    expect(h.marked).toEqual([]);
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

  it('a runner that ends badly is reported for the owner to act by hand', async () => {
    const h = harness({ applyCode: 1 });
    await h.button.handle(h.tap('stop:ask:2026-10-20'));
    await h.button.handle(h.tap('stop:go:n1'));
    await h.button.idle();
    expect(h.sent.at(-1)?.text).toContain('BY HAND');
  });
});

describe('stop button: configuration', () => {
  const ok = {
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_CHAT_ID: '111',
    TELEGRAM_ROTATION_CHAT_ID: '-1003',
    TRADING_DATA_ROOT: '/x',
  };
  it('needs the owner’s private chat, never a group or the friends group', () => {
    expect(stopButtonProblem(ok)).toBeNull();
    expect(stopButtonProblem({ ...ok, TELEGRAM_CHAT_ID: '-1003' })).toContain('private chat');
    expect(stopButtonProblem({ ...ok, TELEGRAM_ROTATION_CHAT_ID: '111' })).toContain('friends');
    expect(stopButtonProblem({ ...ok, TELEGRAM_BOT_TOKEN: '' })).toContain('TELEGRAM_BOT_TOKEN');
    expect(stopButtonProblem({ ...ok, TRADING_DATA_ROOT: '' })).toContain('TRADING_DATA_ROOT');
  });

  it('the morning summary carries the offer only with STOP_BUTTON=on', async () => {
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
      ({ env, now: () => at }) as unknown as BuiltinContext;
    await withStopOffer(summary, port)(ctx(ok));
    expect(sent).toEqual([]);
    await withStopOffer(summary, port)(ctx({ ...ok, STOP_BUTTON: 'on' }));
    expect(sent[0]?.buttons?.[0]?.data).toBe('stop:ask:2026-10-20');
  });
});

describe('stop hold: pauses the jobs that could deploy or enable', () => {
  let root: string;
  let history: History;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stop-hold-'));
    history = new History(':memory:');
  });
  afterEach(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('every paused job exists, and the disable safety net is never paused', () => {
    for (const id of STOP_HELD_JOBS) expect(JOBS.some((j) => j.id === id)).toBe(true);
    expect(STOP_HELD_JOBS).not.toContain('quantiply-disable');
  });

  it('reads the same file broker-login writes, for today only', () => {
    expect(holdFile(root, '2026-10-20')).toBe(join(root, 'stop', 'hold-2026-10-20.json'));
    const hold = new StopHold({ TRADING_DATA_ROOT: root });
    const deploy = JOBS.find((j) => j.id === 'algotest-deploy') as Job;
    const disable = JOBS.find((j) => j.id === 'quantiply-disable') as Job;
    expect(hold.pauses(deploy, at)).toBe(false);
    mkdirSync(join(root, 'stop'), { recursive: true });
    writeFileSync(holdFile(root, '2026-10-20'), '{}');
    expect(hold.pauses(deploy, at)).toBe(true);
    expect(hold.pauses(disable, at)).toBe(false);
    expect(hold.pauses(deploy, istAt('2026-10-21', '09:16'))).toBe(false);
    // a stop confirmed in this process holds even without the file
    const memory = new StopHold({});
    memory.mark('2026-10-21');
    expect(memory.pauses(deploy, istAt('2026-10-21', '09:16'))).toBe(true);
  });

  it('the loop records a paused slot as held and never runs it', () => {
    history.firstStart(new Date('2026-01-01T00:00:00Z'));
    const job: Job = {
      id: 'algotest-deploy',
      description: 'x',
      schedule: { at: '09:16', on: () => true, label: '' },
      steps: [['/bin/sh', '-c', 'exit 9']],
      cwd: '.',
      timeoutMinutes: 1,
      retries: 0,
      retryDelayMinutes: 0,
      catchUpHours: 0,
      fixHint: '',
    };
    const now = istAt('2026-10-20', '09:16');
    history.jobFirstSeen(job.id, istAt('2026-10-19', '00:00'));
    const sent: string[] = [];
    const stop = startLoop({
      ctx: { repoRoot: '.', env: {}, logDir: tmpdir(), history, now: () => now },
      jobs: [job],
      alerts: async (t) => {
        sent.push(t);
      },
      paused: () => true,
    });
    stop();
    const row = history.forSlot(job.id, istAt('2026-10-20', '09:16'));
    expect(row?.exit_code).toBe(0);
    expect(row?.attempts).toBe(0);
    expect(row?.error).toContain('stop button');
    expect(sent).toEqual([]);
  });
});
