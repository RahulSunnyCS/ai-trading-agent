import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Action,
  type TgUpdate,
  type UpdatesResult,
  answerCallbackQuery,
  getUpdates,
  redact,
  registerSecret,
  send,
} from '@trading/notify';
import type { History } from './history.js';
import type { Builtin } from './runner.js';
import { formatIst, istDay } from './schedule.js';
import { STOP_HELD_JOBS, type StopHold } from './stop-hold.js';

/**
 * BL-143 Phase 4: the owner's Telegram "stop everything" button. Owner's answer (2026-10-20):
 * switch off AND square off, only after a second confirm tap. The stop itself is
 * `packages/broker-login/src/stop-button.ts --apply`, started from here; this file is the
 * listener and the two taps.
 *
 * - Off unless `STOP_BUTTON=on` in `.env`; then `jobs serve` long-polls the bot (`getUpdates`).
 *   ONE consumer per bot: nothing else may poll it (Telegram answers 409 to a second poller).
 * - Only the owner's own private chat counts: `TELEGRAM_CHAT_ID`, a user id (positive), which must
 *   be both the chat and the sender, and never the friends' group (`TELEGRAM_ROTATION_CHAT_ID`).
 *   Anything else is ignored and logged.
 * - `/stop`, or the 09:00 morning message, offers a "Stop everything" button (`stop:ask:<day>`,
 *   good for that IST day only; it only shows the plan).
 * - Its tap shows exactly what a stop would do per platform (`stop-button.ts --plan`, the local
 *   ledgers, no login) and a "Yes, stop and square off" button carrying a fresh nonce
 *   (`stop:go:<nonce>`): valid for 2 minutes, once, and only the latest one. A restart forgets
 *   every nonce.
 * - Only that second tap acts: today is held at once (in memory too), the runner starts, and its
 *   per-platform report comes back in Telegram. Every tap is a line in
 *   `TRADING_DATA_ROOT/stop/<day>.jsonl`.
 */

export const CONFIRM_TTL_MS = 2 * 60_000;
const COMMAND = /^\/stop(@[A-Za-z0-9_]+)?\s*$/;

export interface StopPort {
  /** to the owner's chat; `buttons` are callback buttons */
  send(text: string, buttons?: Action[]): Promise<void>;
  answer(callbackId: string, text: string): Promise<void>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<UpdatesResult>;
}

export interface StopDeps {
  port: StopPort;
  ownerChatId: number;
  now: () => Date;
  /** the runner's `--plan` text */
  plan: () => Promise<string>;
  /** the runner's `--apply`; resolves with its exit code */
  apply: (by: string) => Promise<{ code: number; logPath: string }>;
  log: (row: Record<string, unknown>) => void;
  hold: Pick<StopHold, 'mark'>;
  /** held jobs running right now (they may still finish what they started) */
  runningHeldJobs: () => string[];
  nonce?: () => string;
}

export function offerButton(day: string): Action {
  return { label: '🛑 Stop everything', data: `stop:ask:${day}` };
}

export const OFFER_TEXT =
  '🛑 Stop everything: tap for what it would do. Nothing happens until you confirm.';

export class StopButton {
  private pending: { nonce: string; issued: number } | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly d: StopDeps) {}

  /** Resolves when no stop is running (tests). */
  async idle(): Promise<void> {
    await this.running;
  }

  private ownerOnly(chatId: number | undefined, fromId: number | undefined): boolean {
    return chatId === this.d.ownerChatId && fromId === this.d.ownerChatId;
  }

  async handle(u: TgUpdate): Promise<void> {
    const today = istDay(this.d.now());
    if (u.message) {
      const m = u.message;
      if (!this.ownerOnly(m.chat.id, m.from?.id)) {
        this.d.log({
          event: 'ignored',
          kind: 'message',
          chat: m.chat.id,
          from: m.from?.id ?? null,
        });
        return;
      }
      if (!COMMAND.test(m.text ?? '')) return; // the owner's other messages are not for this
      this.d.log({ event: 'offer', via: '/stop' });
      await this.d.port.send(OFFER_TEXT, [offerButton(today)]);
      return;
    }
    const q = u.callback_query;
    if (!q) return;
    const data = q.data ?? '';
    if (!this.ownerOnly(q.message?.chat.id, q.from.id)) {
      this.d.log({
        event: 'ignored',
        kind: 'button',
        chat: q.message?.chat.id ?? null,
        from: q.from.id,
        data: data.slice(0, 64),
      });
      return;
    }
    const [tag, step, arg = ''] = data.split(':');
    if (tag !== 'stop') {
      this.d.log({ event: 'ignored', kind: 'button', data: data.slice(0, 64) });
      return;
    }
    if (step === 'ask') return this.ask(q.id, arg, today);
    if (step === 'go') return this.go(q.id, arg, q.from.id);
    if (step === 'no') {
      if (this.pending?.nonce === arg) this.pending = null;
      this.d.log({ event: 'cancelled' });
      await this.d.port.answer(q.id, 'Cancelled: nothing done');
      return;
    }
    this.d.log({ event: 'ignored', kind: 'button', data: data.slice(0, 64) });
  }

  private async ask(callbackId: string, day: string, today: string): Promise<void> {
    if (day !== today) {
      this.d.log({ event: 'stale_offer', day });
      await this.d.port.answer(callbackId, `That button was for ${day}: send /stop for today's`);
      return;
    }
    if (this.running) {
      await this.d.port.answer(callbackId, 'A stop is already running: its report follows');
      return;
    }
    await this.d.port.answer(callbackId, 'Reading what a stop would do…');
    let plan: string;
    try {
      plan = await this.d.plan();
    } catch (error) {
      // the stop matters more than its preview: still offer it, saying the preview failed
      plan = `⚠️ The plan could not be read (${redact(String(error))}). Confirming still holds today, squares off and switches off the tool's algos and deploys on Quantiply and AlgoTest.`;
    }
    const nonce = (this.d.nonce ?? (() => randomBytes(9).toString('base64url')))();
    this.pending = { nonce, issued: this.d.now().getTime() };
    this.d.log({ event: 'confirm_offered' });
    const paused = `Jobs paused for the rest of today: ${STOP_HELD_JOBS.join(', ')}.`;
    await this.d.port.send(
      `🛑 Stop everything?\n\n${plan}\n\n${paused}\n\nThe button below works once, for 2 minutes.`,
      [
        { label: 'Yes, stop and square off', data: `stop:go:${nonce}` },
        { label: 'Cancel', data: `stop:no:${nonce}` },
      ],
    );
  }

  private async go(callbackId: string, nonce: string, fromId: number): Promise<void> {
    const p = this.pending;
    const now = this.d.now();
    if (!p || p.nonce !== nonce) {
      this.d.log({ event: 'refused', why: 'unknown or used nonce' });
      await this.d.port.answer(
        callbackId,
        'Expired or already used: nothing done. Send /stop again',
      );
      return;
    }
    this.pending = null; // once only, whatever happens next
    if (now.getTime() - p.issued > CONFIRM_TTL_MS) {
      this.d.log({ event: 'refused', why: 'nonce expired' });
      await this.d.port.answer(callbackId, 'Expired (2 minutes): nothing done. Send /stop again');
      return;
    }
    if (this.running) {
      await this.d.port.answer(callbackId, 'A stop is already running');
      return;
    }
    const day = istDay(now);
    this.d.hold.mark(day);
    this.d.log({ event: 'confirmed', from: fromId });
    await this.d.port.answer(callbackId, 'Stopping now');
    const busy = this.d.runningHeldJobs();
    const warn = busy.length
      ? `\n⚠️ Running right now, may still finish what it started: ${busy.join(', ')}. When it ends, check, and stop again if it deployed or enabled something.`
      : '';
    await this.d.port.send(
      `🛑 Stop confirmed ${formatIst(now)} IST: holding today, switching off and squaring off now. The result follows, per platform.${warn}`,
    );
    this.running = (async () => {
      try {
        const r = await this.d.apply(`telegram ${fromId} ${now.toISOString()}`);
        this.d.log({ event: 'runner_exit', code: r.code });
        // 0 and 3: the runner sent its own report. Anything else: it may not have.
        if (r.code !== 0 && r.code !== 3) {
          await this.d.port.send(
            `⚠️ The stop runner ended with exit ${r.code}: check Quantiply and algotest.in/live BY HAND now. Log: ${r.logPath}`,
          );
        }
      } catch (error) {
        this.d.log({ event: 'runner_error', detail: redact(String(error)) });
        await this.d.port.send(
          `⚠️ The stop runner could not run (${redact(String(error))}): square off and switch off BY HAND on Quantiply and algotest.in/live`,
        );
      } finally {
        this.running = null;
      }
    })();
  }
}

/** Why the button cannot be switched on with this environment, or null. */
export function stopButtonProblem(env: Record<string, string>): string | null {
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) return 'TELEGRAM_BOT_TOKEN is not set';
  const chat = env.TELEGRAM_CHAT_ID?.trim() ?? '';
  if (!/^[1-9]\d*$/.test(chat))
    return 'TELEGRAM_CHAT_ID must be your own private chat (a positive user id), not a group';
  if (chat === env.TELEGRAM_ROTATION_CHAT_ID?.trim())
    return 'TELEGRAM_CHAT_ID is the friends group (TELEGRAM_ROTATION_CHAT_ID)';
  if (!env.TRADING_DATA_ROOT?.trim()) return 'TRADING_DATA_ROOT is not set';
  return null;
}

export const stopButtonOn = (env: Record<string, string>): boolean =>
  env.STOP_BUTTON?.trim().toLowerCase() === 'on';

export function telegramPort(env: Record<string, string>): StopPort {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const chatId = env.TELEGRAM_CHAT_ID?.trim() ?? '';
  registerSecret(botToken);
  return {
    send: (text, buttons) => {
      const [title = '', ...rest] = text.split('\n');
      const body = rest.join('\n').trim();
      return send(
        { botToken, chatId },
        {
          source: 'Stop button',
          severity: 'action_required',
          title,
          ...(body ? { body } : {}),
          ...(buttons ? { actions: buttons } : {}),
        },
      );
    },
    answer: (id, text) => answerCallbackQuery(botToken, id, text),
    getUpdates: (offset, timeout) => getUpdates(botToken, offset, timeout),
  };
}

function stopLog(env: Record<string, string>) {
  const root = env.TRADING_DATA_ROOT?.trim() ?? '';
  return (row: Record<string, unknown>) => {
    const at = new Date();
    try {
      const dir = join(root, 'stop');
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, `${istDay(at)}.jsonl`),
        `${redact(JSON.stringify({ at: at.toISOString(), who: 'listener', ...row }))}\n`,
      );
    } catch (error) {
      console.error(`stop log not written: ${String(error)}`);
    }
    console.log(`stop button: ${redact(JSON.stringify(row))}`);
  };
}

const BROKER_LOGIN = 'packages/broker-login';

/** Runs the broker-login runner; `capture` returns stdout (the plan), else logs to a file. */
function runner(
  repoRoot: string,
  env: () => Record<string, string>,
  args: string[],
  timeoutMs: number,
  logPath?: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const cwd = join(repoRoot, BROKER_LOGIN);
    let fd: number | null = null;
    if (logPath) {
      mkdirSync(join(logPath, '..'), { recursive: true });
      fd = openSync(logPath, 'a');
    }
    const child = spawn(join(cwd, 'node_modules/.bin/tsx'), ['src/stop-button.ts', ...args], {
      cwd,
      env: env(),
      stdio: ['ignore', fd ?? 'pipe', fd ?? 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (c) => {
      stdout += String(c);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      if (fd !== null) closeSync(fd);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (fd !== null) closeSync(fd);
      resolve({ code: code ?? 1, stdout });
    });
  });
}

export interface ListenerOptions {
  repoRoot: string;
  /** a fresh environment per run (re-reads `.env`) */
  env: () => Record<string, string>;
  logDir: string;
  history: History;
  hold: StopHold;
  port?: StopPort;
}

/**
 * Starts the listener when `STOP_BUTTON=on`; returns a stop function, or null when off or
 * misconfigured (said once, on the console and, if it can, in Telegram).
 */
export function startStopListener(o: ListenerOptions): (() => void) | null {
  const env = o.env();
  if (!stopButtonOn(env)) {
    console.log('stop button: off (STOP_BUTTON is not "on")');
    return null;
  }
  const problem = stopButtonProblem(env);
  const port = o.port ?? telegramPort(env);
  if (problem) {
    console.error(`stop button: NOT started: ${problem}`);
    if (env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim())
      void port.send(
        `⚠️ Stop button NOT started: ${problem}. Fix .env, then restart the scheduler.`,
      );
    return null;
  }
  const log = stopLog(env);
  const button = new StopButton({
    port,
    ownerChatId: Number(env.TELEGRAM_CHAT_ID),
    now: () => new Date(),
    log,
    hold: o.hold,
    runningHeldJobs: () =>
      STOP_HELD_JOBS.filter((id) => {
        const last = o.history.last(id);
        return last !== null && last.ended_at === null;
      }),
    plan: async () => {
      const r = await runner(o.repoRoot, o.env, ['--plan'], 60_000);
      if (r.code !== 0) throw new Error(`the plan exited ${r.code}`);
      return r.stdout.trim();
    },
    apply: async (by) => {
      const now = new Date();
      const clock = new Date(now.getTime() + 330 * 60_000).toISOString().slice(11, 19);
      const logPath = join(
        o.logDir,
        'stop-button',
        `${istDay(now)}-${clock.replace(/:/g, '')}.log`,
      );
      const r = await runner(o.repoRoot, o.env, ['--apply', '--by', by], 15 * 60_000, logPath);
      return { code: r.code, logPath };
    },
  });
  let stopped = false;
  let warned409 = false;
  let lastFailure: number | null = null;
  void (async () => {
    let offset = 0;
    console.log('stop button: listening (the only getUpdates consumer of this bot)');
    log({ event: 'listening' });
    while (!stopped) {
      const r = await port.getUpdates(offset, 50);
      if (!r.ok) {
        // each new kind of failure once in the log (a revoked token would otherwise loop silently)
        if (r.status !== lastFailure)
          log({ event: 'poll_failed', status: r.status, detail: r.description });
        lastFailure = r.status;
        if (r.status === 409 && !warned409) {
          warned409 = true;
          log({ event: 'conflict', detail: r.description });
          await port.send(
            '⚠️ Stop button: another program polls this bot (Telegram 409). The button will not answer until it stops; nothing else may poll this bot.',
          );
        }
        await Bun.sleep(r.status === 409 ? 30_000 : 5_000);
        continue;
      }
      warned409 = false;
      lastFailure = null;
      for (const u of r.updates) {
        offset = Math.max(offset, u.update_id + 1);
        try {
          await button.handle(u);
        } catch (error) {
          log({ event: 'handler_error', detail: redact(String(error)) });
        }
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

/** The 09:00 morning summary, followed by the stop button's offer when it is on. */
export function withStopOffer(
  summary: Builtin,
  port?: (env: Record<string, string>) => StopPort,
): Builtin {
  return async (ctx) => {
    const result = await summary(ctx);
    if (stopButtonOn(ctx.env) && !stopButtonProblem(ctx.env)) {
      await (port ?? telegramPort)(ctx.env).send(OFFER_TEXT, [offerButton(istDay(ctx.now()))]);
    }
    return result;
  };
}
