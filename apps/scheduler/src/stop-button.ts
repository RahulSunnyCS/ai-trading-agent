import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
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
import {
  type HoldInfo,
  STOP_HELD_JOBS,
  clearMemoryHold,
  holdInMemory,
  readHold,
} from './stop-hold.js';

/**
 * BL-143 Phase 4: the owner's Telegram "stop everything" button. Owner's answer (2026-10-20):
 * switch off AND square off, only after a second confirm tap. The stop itself is
 * `packages/broker-login/src/stop-button.ts --apply`, started from here; this file is the
 * listener and the taps.
 *
 * - Off unless `STOP_BUTTON=on` in the repo-root `.env`; then `jobs serve` long-polls the bot
 *   (`getUpdates`). ONE consumer per bot: nothing else may poll it (a second poller gets 409).
 * - Only the owner's own private chat counts: `TELEGRAM_CHAT_ID`, a user id (positive), which must
 *   be both the chat and the sender, and never the friends' group (`TELEGRAM_ROTATION_CHAT_ID`).
 *   Anything else is ignored and logged.
 * - `/stop`, or the 09:00 morning message, offers a "Stop everything" button (`stop:ask:<day>`,
 *   good for that IST day only; it only shows the plan).
 * - Its tap shows exactly what a stop would do per platform (`stop-button.ts --plan`, the local
 *   ledgers, no login) and a "Yes, stop and square off" button carrying a nonce
 *   (`stop:go:<nonce>`): valid for 2 minutes, once. A second tap on the offer while it is valid
 *   re-sends the same nonce, so the first confirm still works. A restart forgets every nonce.
 * - Only that second tap acts: this process holds at once (in memory, the fallback), the runner
 *   writes the hold files first (if it cannot, it still squares off and says "HOLD NOT SAVED"
 *   first), squares off and switches off, and its per-platform report comes back in Telegram.
 * - The hold lasts until the owner lifts it: `/resume` or the morning message's Resume button,
 *   then a confirm tap (`stop:rgo:<nonce>`, same rules), runs `stop-button.ts --clear-hold`.
 *   While it is on, the 09:00 message says so every day.
 * - Every tap is a line in `TRADING_DATA_ROOT/stop/<day>.jsonl`.
 */

export const CONFIRM_TTL_MS = 2 * 60_000;

/** After a stop that ended badly: what may already be happening on the platforms. */
const IN_FLIGHT =
  'Square-offs may already be in flight: open AlgoTest /live and Quantiply before acting at the broker, then square off by hand only what they show still open.';
const STOP_COMMAND = /^\/stop(@[A-Za-z0-9_]+)?\s*$/;
const RESUME_COMMAND = /^\/resume(@[A-Za-z0-9_]+)?\s*$/;

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
  apply: (by: string) => Promise<{ code: number; logPath: string; refused?: string }>;
  /** the runner's `--clear-hold` */
  resume: (by: string) => Promise<{ code: number }>;
  /** the hold as the files (and this process's memory) show it now */
  hold: () => HoldInfo | null;
  /** this process's own hold: on at the confirm, off at a refused stop or a Resume */
  memory: { hold: (by: string) => boolean; clear: () => void };
  log: (row: Record<string, unknown>) => void;
  /** held jobs running right now (they may still finish what they started) */
  runningHeldJobs: () => string[];
  nonce?: () => string;
}

export function offerButton(day: string): Action {
  return { label: '🛑 Stop everything', data: `stop:ask:${day}` };
}

export function resumeButton(day: string): Action {
  return { label: '▶️ Resume (lift the hold)', data: `stop:resume:${day}` };
}

export const OFFER_TEXT =
  '🛑 Stop everything: tap for what it would do. Nothing happens until you confirm.';

export function holdText(h: HoldInfo): string {
  return `⛔ The stop hold is ON (since ${h.at}): the tool uploads, enables and deploys nothing, on AlgoTest or Quantiply, until you lift it. The 15:40 Quantiply switch-off still runs.`;
}

/** The offer, with the hold line and Resume when the hold is on. */
export function offerMessage(day: string, hold: HoldInfo | null): [string, Action[]] {
  if (!hold) return [OFFER_TEXT, [offerButton(day)]];
  return [`${holdText(hold)}\n\n${OFFER_TEXT}`, [offerButton(day), resumeButton(day)]];
}

type Kind = 'stop' | 'resume';

export class StopButton {
  private pending = new Map<Kind, { nonce: string; issued: number }>();
  private running: Promise<void> | null = null;

  constructor(private readonly d: StopDeps) {}

  /** Resolves when no stop is running (tests). */
  async idle(): Promise<void> {
    await this.running;
  }

  private ownerOnly(chatId: number | undefined, fromId: number | undefined): boolean {
    return chatId === this.d.ownerChatId && fromId === this.d.ownerChatId;
  }

  /** The kind's nonce while it is still valid, else a fresh one. */
  private nonceFor(kind: Kind): string {
    const now = this.d.now().getTime();
    const p = this.pending.get(kind);
    if (p && now - p.issued <= CONFIRM_TTL_MS) return p.nonce;
    const nonce = (this.d.nonce ?? (() => randomBytes(9).toString('base64url')))();
    this.pending.set(kind, { nonce, issued: now });
    return nonce;
  }

  /** Takes the kind's nonce (once only); why not, when it is not the valid one. */
  private takeNonce(kind: Kind, nonce: string): string | null {
    const p = this.pending.get(kind);
    if (!p || p.nonce !== nonce) return 'Expired or already used: nothing done';
    this.pending.delete(kind); // once only, whatever happens next
    if (this.d.now().getTime() - p.issued > CONFIRM_TTL_MS)
      return 'Expired (2 minutes): nothing done';
    return null;
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
      const text = m.text ?? '';
      if (STOP_COMMAND.test(text)) {
        this.d.log({ event: 'offer', via: '/stop' });
        const [t, b] = offerMessage(today, this.d.hold());
        await this.d.port.send(t, b);
      } else if (RESUME_COMMAND.test(text)) {
        this.d.log({ event: 'resume_offer', via: '/resume' });
        await this.offerResume(today);
      }
      return; // the owner's other messages are not for this
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
    if (step === 'resume') {
      if (arg !== today) {
        await this.d.port.answer(q.id, `That button was for ${arg}: send /resume`);
        return;
      }
      await this.d.port.answer(q.id, 'Asking to confirm…');
      return this.offerResume(today);
    }
    if (step === 'rgo') return this.resume(q.id, arg, q.from.id);
    if (step === 'no') {
      for (const [kind, p] of this.pending) if (p.nonce === arg) this.pending.delete(kind);
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
      plan = `⚠️ The plan could not be read (${redact(String(error))}). Confirming still holds the tool, squares off and switches off its algos and deploys on Quantiply and AlgoTest.`;
    }
    const nonce = this.nonceFor('stop');
    this.d.log({ event: 'confirm_offered' });
    const paused = `Jobs refused while the hold is on: ${STOP_HELD_JOBS.join(', ')}.`;
    await this.d.port.send(
      `🛑 Stop everything?\n\n${plan}\n\n${paused}\n\nThe button below works once, for 2 minutes.`,
      [
        { label: 'Yes, stop and square off', data: `stop:go:${nonce}` },
        { label: 'Cancel', data: `stop:no:${nonce}` },
      ],
    );
  }

  private async go(callbackId: string, nonce: string, fromId: number): Promise<void> {
    const why = this.takeNonce('stop', nonce);
    if (why) {
      this.d.log({ event: 'refused', why });
      await this.d.port.answer(callbackId, `${why}. Send /stop again`);
      return;
    }
    if (this.running) {
      await this.d.port.answer(callbackId, 'A stop is already running');
      return;
    }
    const now = this.d.now();
    // held in this process from now on, whatever the runner manages to write (the fallback)
    const heldNow = this.d.memory.hold(`telegram ${fromId}`);
    this.d.log({ event: 'confirmed', from: fromId });
    await this.d.port.answer(callbackId, 'Stopping now');
    const busy = this.d.runningHeldJobs();
    const warn = busy.length
      ? `\n⚠️ Running right now, may still finish what it started: ${busy.join(', ')}. When it ends, check, and stop again if it deployed or enabled something.`
      : '';
    await this.d.port.send(
      `🛑 Stop confirmed ${formatIst(now)} IST: holding the tool, switching off and squaring off now. The result follows, per platform.${warn}`,
    );
    this.running = (async () => {
      try {
        const r = await this.d.apply(`telegram ${fromId} ${now.toISOString()}`);
        this.d.log({ event: 'runner_exit', code: r.code });
        // 0 and 3: the runner delivered its own report.
        if (r.code === 2) {
          // Another stop is running: keep the hold (the owner asked to stop; that stop may be the
          // one still squaring off). Any other refusal did nothing at all: lift only the hold this
          // tap set, never an earlier stop's (only Resume does that).
          const running = r.refused?.includes('already running') ?? false;
          if (heldNow && !running) this.d.memory.clear();
          await this.d.port.send(
            running
              ? `⚠️ This stop did nothing new: ${r.refused}. The hold stays on.`
              : `⚠️ The stop did NOTHING: ${r.refused ?? 'the runner refused'}. Stop by hand on Quantiply and algotest.in/live, or fix it and send /stop again.`,
          );
        } else if (r.code === 4) {
          await this.d.port.send(
            `⚠️ The stop ran, but its report could not be delivered. ${IN_FLIGHT} Log: ${r.logPath}`,
          );
        } else if (r.code !== 0 && r.code !== 3) {
          await this.d.port.send(
            `⚠️ The stop runner ended with exit ${r.code} (stopped or timed out). ${IN_FLIGHT} Log: ${r.logPath}`,
          );
        }
      } catch (error) {
        this.d.log({ event: 'runner_error', detail: redact(String(error)) });
        await this.d.port.send(
          `⚠️ The stop runner could not run (${redact(String(error))}). ${IN_FLIGHT}`,
        );
      } finally {
        this.running = null;
      }
    })();
  }

  private async offerResume(today: string): Promise<void> {
    const hold = this.d.hold();
    if (!hold) {
      await this.d.port.send('▶️ No stop hold is on: nothing to lift.');
      return;
    }
    const nonce = this.nonceFor('resume');
    this.d.log({ event: 'resume_confirm_offered', day: today });
    await this.d.port.send(
      `▶️ Lift the stop hold (on since ${hold.at})?\n\nUploads, enables and deploys resume from each job's next run. A slot the hold refused does not run by itself: run any you need by hand. Nothing is switched back on that the stop switched off.\n\nThe button below works once, for 2 minutes.`,
      [
        { label: 'Yes, lift the hold', data: `stop:rgo:${nonce}` },
        { label: 'Cancel', data: `stop:no:${nonce}` },
      ],
    );
  }

  private async resume(callbackId: string, nonce: string, fromId: number): Promise<void> {
    const why = this.takeNonce('resume', nonce);
    if (why) {
      this.d.log({ event: 'resume_refused', why });
      await this.d.port.answer(callbackId, `${why}. Send /resume again`);
      return;
    }
    if (this.running) {
      await this.d.port.answer(callbackId, 'A stop is running: lift the hold after it reports');
      return;
    }
    this.d.log({ event: 'resume_confirmed', from: fromId });
    await this.d.port.answer(callbackId, 'Lifting the hold');
    try {
      const r = await this.d.resume(`telegram ${fromId} ${this.d.now().toISOString()}`);
      if (r.code === 0) this.d.memory.clear();
      const still = this.d.hold();
      this.d.log({ event: 'resume_exit', code: r.code, held: still !== null });
      await this.d.port.send(
        r.code === 0 && !still
          ? "▶️ The stop hold is lifted: uploads, enables and deploys run again from each job's next run."
          : `⚠️ The hold could NOT be lifted (exit ${r.code}): on the laptop run: cd packages/broker-login && node_modules/.bin/tsx src/stop-button.ts --clear-hold`,
      );
    } catch (error) {
      this.d.log({ event: 'resume_error', detail: redact(String(error)) });
      await this.d.port.send(`⚠️ The hold could NOT be lifted (${redact(String(error))})`);
    }
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

/** The runner's `REFUSED: <why>` line, read back from its log. */
function refusalIn(logPath: string): { refused?: string } {
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const m = /^REFUSED: (.*)$/.exec(lines[i] ?? '');
      if (m?.[1]) return { refused: redact(m[1]) };
    }
  } catch {
    // no log: no reason to give
  }
  return {};
}

/** tsx for broker-login: its own copy, else the hoisted one at the repo root (bun 1.2). */
function tsxPath(repoRoot: string): string {
  const own = join(repoRoot, BROKER_LOGIN, 'node_modules/.bin/tsx');
  return existsSync(own) ? own : join(repoRoot, 'node_modules/.bin/tsx');
}

/** Runs the broker-login runner; without `logPath` it returns stdout (the plan). */
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
    const child = spawn(tsxPath(repoRoot), ['src/stop-button.ts', ...args], {
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
        `⚠️ Stop button NOT started: ${problem}. Fix the repo-root .env, then restart the scheduler.`,
      );
    return null;
  }
  const log = stopLog(env);
  const button = new StopButton({
    port,
    ownerChatId: Number(env.TELEGRAM_CHAT_ID),
    now: () => new Date(),
    log,
    hold: () => readHold(o.env()),
    memory: { hold: (by) => holdInMemory(by), clear: clearMemoryHold },
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
      return { code: r.code, logPath, ...refusalIn(logPath) };
    },
    resume: async (by) => {
      const r = await runner(o.repoRoot, o.env, ['--clear-hold', '--by', by], 60_000);
      return { code: r.code };
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

/**
 * The 09:00 morning summary, then: while the stop hold is on, a line saying so (every day, with
 * Resume when the button is on); with the button on, its offer.
 */
export function withStopOffer(
  summary: Builtin,
  port?: (env: Record<string, string>) => StopPort,
): Builtin {
  return async (ctx) => {
    const result = await summary(ctx);
    const hold = readHold(ctx.env);
    const usable = stopButtonOn(ctx.env) && !stopButtonProblem(ctx.env);
    const day = istDay(ctx.now());
    const configured = Boolean(
      ctx.env.TELEGRAM_BOT_TOKEN?.trim() && ctx.env.TELEGRAM_CHAT_ID?.trim(),
    );
    if (usable) {
      const [text, buttons] = offerMessage(day, hold);
      await (port ?? telegramPort)(ctx.env).send(text, buttons);
    } else if (hold && (configured || port)) {
      await (port ?? telegramPort)(ctx.env).send(
        `${holdText(hold)}\n\nLift it on the laptop: cd packages/broker-login && node_modules/.bin/tsx src/stop-button.ts --clear-hold`,
      );
    }
    if (hold) ctx.log(holdText(hold));
    return result;
  };
}
