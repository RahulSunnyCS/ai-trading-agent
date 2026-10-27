import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { istTimestamp, sendText } from '@trading/notify';
import { describeSource, readAutomation, settingsPath } from './automation-settings.js';
import { readTelegramConfig } from './config.js';
import { describe } from './diagnose.js';
import {
  type LoginEnv,
  type LoginResult,
  allLoggedIn,
  fallback,
  loginEnv,
} from './local-login-plan.js';
import { istToday } from './strategy-plan.js';

/**
 * BL-172 Phases 1-2: the 08:00 broker login runs on the Mac (the scheduler's `broker-login` job),
 * GitHub's "Daily broker login" only as the backup.
 *
 * 1. Reads Settings › Automation (the scheduler's snapshot) for what to log in: the same rule as
 *    the GitHub variables (`loginEnv`). Unreadable settings: hand the whole login to GitHub, as the
 *    08:00 dispatch did, with a warning.
 * 2. Runs `main.ts` here, credentials from the repo `.env` (the scheduler's job env; `main.ts`'s own
 *    `.env` read never overrides a set variable), and reads its outcome (`LOGIN_RESULT_FILE`).
 *    `main.ts` sends the usual Telegram report.
 * 3. Any part that failed for a reason another machine could fix is dispatched to GitHub, those
 *    parts only (`fallback`); a refused password, PIN or code never is.
 * 4. Sets the repository variable `LOCAL_LOGIN_DONE` to today (UTC, as the workflow reads dates) so
 *    the workflow's cron backstops skip: the Mac ran, and anything left is the backup run's.
 * 5. Writes `<scheduler state>/broker-login/<IST day>.json`, which the 09:00 summary reads.
 *
 *   tsx src/local-login.ts [--dry-run]
 */

const execFileP = promisify(execFile);
const WORKFLOW = 'daily-broker-login.yml';
const RUN_LIMIT_MS = 40 * 60_000;

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileP('gh', args, { timeout: 60_000 });
  return stdout;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

async function runMain(env: LoginEnv, resultFile: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('node_modules/.bin/tsx', ['src/main.ts'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env,
        LOGIN_RESULT_FILE: resultFile,
        // never the Actions outputs: Quantiply's result then counts in the exit code
        GITHUB_OUTPUT: '',
        GITHUB_RUN_ID: '',
      },
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_LIMIT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
}

async function dispatch(inputs: Record<string, string>): Promise<string> {
  const since = Date.now();
  const args = ['workflow', 'run', WORKFLOW, '--ref', 'main'];
  for (const [k, v] of Object.entries(inputs)) args.push('-f', `${k}=${v}`);
  await gh(args);
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 3_000));
    const runs = JSON.parse(
      await gh([
        'run',
        'list',
        '--workflow',
        WORKFLOW,
        '--event',
        'workflow_dispatch',
        '--limit',
        '5',
        '--json',
        'url,createdAt',
      ]),
    ) as { url: string; createdAt: string }[];
    const run = runs.find((r) => Date.parse(r.createdAt) >= since - 5_000);
    if (run) return run.url;
  }
  return '(dispatched; the run did not appear within 30 s)';
}

async function markDone(): Promise<string> {
  try {
    await gh(['variable', 'set', 'LOCAL_LOGIN_DONE', '--body', utcDay()]);
    return '';
  } catch (error) {
    return `could not set LOCAL_LOGIN_DONE (${describe(error)}): GitHub's 08:15 backstop may log in again`;
  }
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const telegram = readTelegramConfig();
  const day = istToday();
  const statusFile = join(dirname(settingsPath()), 'broker-login', `${day}.json`);
  const status = async (body: Record<string, unknown>) => {
    if (dryRun) return;
    await mkdir(dirname(statusFile), { recursive: true });
    await writeFile(
      statusFile,
      `${JSON.stringify({ day, at: new Date().toISOString(), ...body })}\n`,
    );
  };

  let env: LoginEnv | null;
  let source: string;
  try {
    const automation = readAutomation();
    env = loginEnv(automation);
    source = describeSource(automation);
  } catch (error) {
    // the settings decide nothing: GitHub's run follows the variables of the last save
    const text = `⚠️ Automation settings unreadable (${describe(error)}): the broker login goes to GitHub. Re-save Settings › Automation.`;
    console.warn(text);
    if (dryRun) return 0;
    try {
      const url = await dispatch({});
      await sendText(telegram, `${text}\n🔗 ${url}`, 'broker.algotest').catch(() => undefined);
      await status({ ok: false, fallback: { parts: ['all'], url } });
      return 1;
    } catch (dispatchError) {
      await sendText(
        telegram,
        `🚨 Broker login was not run: ${text} and GitHub could not be started (${describe(dispatchError)}). Start "Daily broker login" by hand.`,
        'broker.algotest',
      ).catch(() => undefined);
      return 1;
    }
  }
  if (env === null) {
    console.log(`no broker login in the settings (${source}): nothing to do`);
    if (!dryRun) {
      await markDone();
      await status({ ok: true, nothing: true });
    }
    return 0;
  }
  console.log(
    `[${istTimestamp()} IST] broker login on the Mac (${source}): ONLY=${env.ONLY || 'both'} QUANTIPLY_LOGIN=${env.QUANTIPLY_LOGIN} QUANTIPLY_BROKERS=${env.QUANTIPLY_BROKERS || '(none)'}`,
  );
  if (dryRun) return 0;

  const resultFile = join(tmpdir(), `broker-login-${process.pid}.json`);
  const code = await runMain(env, resultFile);
  let result: LoginResult | null = null;
  if (existsSync(resultFile)) {
    try {
      result = JSON.parse(await readFile(resultFile, 'utf8')) as LoginResult;
    } catch {
      result = null;
    }
    await rm(resultFile, { force: true });
  }

  if (result && allLoggedIn(result)) {
    const note = await markDone();
    if (note) {
      console.warn(note);
      await sendText(telegram, `⚠️ ${note}`, 'broker.algotest').catch(() => undefined);
    }
    await status({ ok: true, result });
    return 0;
  }

  const fb = fallback(env, result);
  // the Mac ran: from here on the cron backstops never repeat it (a refusal must not be resent)
  const note = await markDone();
  if (!fb) {
    console.log('every failure is a refusal of the credentials: nothing handed to GitHub');
    await status({ ok: false, result, fallback: null, note: note || undefined });
    return code === 0 ? 1 : code;
  }
  try {
    const url = await dispatch({
      only: fb.only || 'both',
      quantiply: fb.quantiply,
      quantiply_shoonya: fb.quantiplyShoonya,
    });
    await sendText(
      telegram,
      `🔁 Mac broker login failed for ${fb.parts.join(', ')}: trying again on GitHub\n🔗 ${url}${note ? `\n⚠️ ${note}` : ''}`,
      'broker.algotest',
    ).catch(() => undefined);
    await status({ ok: false, result, fallback: { parts: fb.parts, url } });
  } catch (error) {
    await sendText(
      telegram,
      `🚨 Mac broker login failed for ${fb.parts.join(', ')} and GitHub could not be started (${describe(error)}). Start "Daily broker login" by hand.`,
      'broker.algotest',
    ).catch(() => undefined);
    await status({ ok: false, result, fallback: { parts: fb.parts, url: null } });
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error('local login crashed:', describe(error));
    await sendText(
      readTelegramConfig(),
      `💥 Mac broker login crashed: ${describe(error)}. Start "Daily broker login" by hand if no login report came.`,
      'broker.algotest',
    ).catch(() => undefined);
    process.exit(1);
  });
