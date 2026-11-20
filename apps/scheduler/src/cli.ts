#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { telegramSink } from './alerts.js';
import { startApi } from './api.js';
import { SettingsStore, syncGithub, validate } from './automation.js';
import { allBuiltins } from './builtins.js';
import { planChain, renderPlan } from './chain-plan.js';
import { jobEnv } from './env.js';
import { History, pidAlive } from './history.js';
import { JOBS, findJob } from './jobs.js';
import { skippedToday, startLoop } from './loop.js';
import { type RunContext, type RunOptions, runJob } from './runner.js';
import { formatIst, istAt, istDay, nextDue } from './schedule.js';
import { startStopListener } from './stop-button.js';

/**
 * `bun run jobs status` — every job, its schedule, last run and next run.
 * `bun run jobs run <id>` — run one job now (recorded as a manual run).
 * `bun run jobs serve` — the long-running scheduler (what launchd keeps alive).
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

export function stateDir(): string {
  return (
    process.env.SCHEDULER_STATE_DIR?.trim() ||
    join(homedir(), 'Library', 'Application Support', 'ai-trading-agent')
  );
}

export function logDir(): string {
  return (
    process.env.SCHEDULER_LOG_DIR?.trim() || join(homedir(), 'Library', 'Logs', 'ai-trading-agent')
  );
}

function context(history: History): RunContext {
  return {
    repoRoot: REPO_ROOT,
    env: jobEnv(REPO_ROOT),
    logDir: logDir(),
    history,
    builtins: allBuiltins(),
  };
}

function openHistory(): History {
  mkdirSync(stateDir(), { recursive: true });
  return new History(join(stateDir(), 'scheduler.db'));
}

export function settingsSnapshotPath(): string {
  return join(stateDir(), 'automation-settings.json');
}

function openSettings(): SettingsStore {
  mkdirSync(stateDir(), { recursive: true });
  return new SettingsStore(join(stateDir(), 'scheduler.db'), settingsSnapshotPath());
}

/**
 * `jobs settings [show]` — the current automation settings (BL-140).
 * `jobs settings set <file.json>` — save a new version from a file, then set the GitHub variables.
 */
async function settingsCommand(sub: string | undefined, file: string | undefined): Promise<number> {
  const store = openSettings();
  try {
    if (sub === undefined || sub === 'show') {
      console.log(JSON.stringify(store.current(), null, 2));
      return 0;
    }
    if (sub === 'set' && file) {
      const checked = validate(JSON.parse(readFileSync(file, 'utf8')));
      if ('errors' in checked) {
        console.error(`invalid settings:\n  ${checked.errors.join('\n  ')}`);
        return 1;
      }
      const saved = store.save(checked.settings);
      const outcome = await syncGithub(checked.settings);
      store.noteGithub(saved.version, outcome);
      console.log(`saved version ${saved.version}; GitHub variables ${outcome}`);
      return outcome.startsWith('ok') ? 0 : 1;
    }
    console.error('usage: bun run jobs settings [show | set <file.json>]');
    return 2;
  } finally {
    store.close();
  }
}

function status(): void {
  const history = openHistory();
  const now = new Date();
  const rows = JOBS.map((job) => {
    const last = history.last(job.id);
    const lastText = !last
      ? '—'
      : last.ended_at === null
        ? `running since ${formatIst(new Date(last.started_at))}`
        : `${last.exit_code === 0 ? 'ok' : `FAILED (${last.error ?? `exit ${last.exit_code}`})`} ${formatIst(new Date(last.started_at))}`;
    const next = nextDue(job.schedule, now);
    return [job.id, job.schedule.label, lastText, next ? formatIst(next) : '—'];
  });
  const header = ['job', 'schedule', 'last run', 'next run'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  history.close();
}

/** `--resume`, `--from <step>`, `--fresh` (BL-234, chains only); null when a flag is wrong. */
export function parseRunFlags(args: string[]): RunOptions | string {
  const options: RunOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--resume') options.resume = true;
    else if (arg === '--fresh') options.fresh = true;
    else if (arg === '--only') {
      const list = args[++i];
      if (!list) return '--only needs step ids, comma separated';
      options.only = list.split(',').filter(Boolean);
    } else if (arg === '--from') {
      const step = args[++i];
      if (!step) return '--from needs a step id';
      options.from = step;
    } else return `unknown option '${arg}'`;
  }
  if (options.fresh && (options.resume || options.from))
    return '--fresh cannot go with --resume or --from';
  if (options.only && (options.resume || options.from || options.fresh))
    return '--only cannot go with --resume, --from or --fresh';
  return options;
}

/** `--dry-run` and `--at HH:MM` (BL-234 Phase 4); the rest of the flags are `parseRunFlags`'. */
export function splitDryRun(flags: string[]): {
  dryRun: boolean;
  at: string | null;
  rest: string[];
} {
  const rest: string[] = [];
  let dryRun = false;
  let at: string | null = null;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] as string;
    if (flag === '--dry-run') dryRun = true;
    else if (flag === '--at') at = flags[++i] ?? '';
    else rest.push(flag);
  }
  return { dryRun, at, rest };
}

async function runNow(id: string | undefined, allFlags: string[]): Promise<number> {
  const job = id ? findJob(id) : undefined;
  if (!job) {
    console.error(`unknown job '${id ?? ''}'. Jobs: ${JOBS.map((j) => j.id).join(', ')}`);
    return 2;
  }
  const { dryRun, at, rest: flags } = splitDryRun(allFlags);
  if (dryRun) {
    // BL-234 Phase 4: the order and the waits of a chain, with nothing started and nothing written
    if (!job.chain) {
      console.error(`${job.id} is not a chain: --dry-run is for chains`);
      return 2;
    }
    if (flags.length > 0) {
      console.error('--dry-run takes only --at HH:MM');
      return 2;
    }
    if (at !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
      console.error('--at needs a time like 08:00 (IST, today)');
      return 2;
    }
    const start = at ? istAt(istDay(new Date()), at) : new Date();
    for (const line of renderPlan(job, planChain(job, { start, env: jobEnv(REPO_ROOT) })))
      console.log(line);
    return 0;
  }
  if (at !== null) {
    console.error('--at goes with --dry-run');
    return 2;
  }
  const options = parseRunFlags(flags);
  if (typeof options === 'string') {
    console.error(
      `${options}\nusage: bun run jobs run <job> [--resume | --from <step> | --fresh | --only <step,step> | --dry-run [--at HH:MM]]`,
    );
    return 2;
  }
  if (!job.chain && (options.resume || options.from || options.fresh || options.only)) {
    console.error(`${job.id} is not a chain: --resume, --from, --fresh and --only are for chains`);
    return 2;
  }
  if (options.from && !job.chain?.some((step) => step.id === options.from)) {
    console.error(
      `unknown step '${options.from}'. Steps: ${job.chain?.map((s) => s.id).join(', ')}`,
    );
    return 2;
  }
  const unknownOnly = (options.only ?? []).filter((id) => !job.chain?.some((s) => s.id === id));
  if (unknownOnly.length > 0) {
    console.error(
      `unknown step(s) '${unknownOnly.join("', '")}'. Steps: ${job.chain?.map((s) => s.id).join(', ')}`,
    );
    return 2;
  }
  const history = openHistory();
  console.log(`running ${job.id} — log: ${join(logDir(), job.id)}/`);
  const result = await runJob(job, context(history), 'manual', null, options);
  history.close();
  for (const step of result.steps ?? [])
    console.log(`  ${step.id.padEnd(28)} ${step.status}${step.error ? ` — ${step.error}` : ''}`);
  console.log(result.ok ? 'ok' : `FAILED: ${result.error}\nlog: ${result.logPath}`);
  return result.ok ? 0 : 1;
}

/** One scheduler per machine: a second loop would run every slot twice. */
function claimInstance(): boolean {
  mkdirSync(stateDir(), { recursive: true });
  const lock = join(stateDir(), 'scheduler.pid');
  try {
    const other = Number(readFileSync(lock, 'utf8'));
    if (other && other !== process.pid && pidAlive(other)) {
      console.error(`another scheduler is already running (pid ${other}); exiting`);
      return false;
    }
  } catch {
    // No lock file yet.
  }
  writeFileSync(lock, String(process.pid));
  return true;
}

/** `jobs skipped` — today's slots already past, which a first start will not run. */
function skipped(): void {
  const history = openHistory();
  const list = skippedToday(JOBS, new Date(), history);
  history.close();
  if (list.length === 0) return;
  console.log("Today's slots already past (a fresh scheduler skips them; run by hand if needed):");
  for (const { job, slot } of list) {
    console.log(
      `  ${job.id} was due ${formatIst(slot)} IST → bun run --filter @ata/scheduler jobs run ${job.id}`,
    );
  }
}

function serve(): void {
  if (!claimInstance()) {
    process.exitCode = 1;
    return;
  }
  const ctx = context(openHistory());
  console.log(
    `scheduler started ${formatIst(new Date())} IST — ${JOBS.length} jobs, logs in ${logDir()}`,
  );
  const settings = openSettings();
  settings.writeSnapshot(); // the jobs always find the current version, even before a first Save
  startApi({
    ctx,
    jobs: JOBS,
    logRoots: [join(REPO_ROOT, 'packages/momentum-backtesting/data')],
    settings,
  });
  startLoop({ ctx, jobs: JOBS, alerts: telegramSink(ctx.env) });
  // BL-143 Phase 4, only with STOP_BUTTON=on: then this process is the bot's one getUpdates
  // consumer. (The stop hold itself is checked by runJob, for every way a job starts.)
  startStopListener({
    repoRoot: REPO_ROOT,
    env: () => jobEnv(REPO_ROOT),
    logDir: logDir(),
    history: ctx.history,
  });
}

if (import.meta.main) {
  const [command, arg, arg2, ...more] = process.argv.slice(2);
  if (command === 'status' || command === undefined) status();
  else if (command === 'run')
    process.exitCode = await runNow(arg, [...(arg2 ? [arg2] : []), ...more]);
  else if (command === 'serve') serve();
  else if (command === 'skipped') skipped();
  else if (command === 'settings') process.exitCode = await settingsCommand(arg, arg2);
  else {
    console.error(
      'usage: bun run jobs [status | run <job> [--resume | --from <step> | --fresh | --only <steps>] | serve | skipped | settings [show | set <file>]]',
    );
    process.exitCode = 2;
  }
}
