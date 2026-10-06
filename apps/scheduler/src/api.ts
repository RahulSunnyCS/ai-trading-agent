import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { NOTIFICATION_TYPES, disabledTypes, prefsPath } from '@trading/notify';
import { JOBS, type Job } from './jobs.js';
import { type RunContext, runJob } from './runner.js';
import { nextDue } from './schedule.js';

/**
 * Loopback HTTP API over the scheduler (BL-012 PR 6): what the dashboard's Jobs and
 * Notifications pages read. Started by `serve` in the same process as the loop, so a
 * manual run shares its in-process group chain and the pid-file guard already
 * prevents a second server. It binds 127.0.0.1 only — never expose it directly;
 * reach it through the dashboard's `/api/scheduler` rewrite.
 */
export const DEFAULT_API_PORT = 8790;

export function apiPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.SCHEDULER_API_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_API_PORT;
}

export interface ApiOptions {
  ctx: RunContext;
  jobs?: Job[];
  /** Notification preferences file; defaults to `prefsPath()`. */
  prefsFile?: string;
  /** Extra directories a run log may live in, besides `ctx.logDir`. */
  logRoots?: string[];
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const fail = (status: number, error: string): Response => json({ error }, status);

function intParam(value: string | null, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** True when `path` resolves inside one of `roots` (symlinks followed). */
export function insideRoots(path: string, roots: string[]): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  return roots.some((root) => {
    try {
      const base = realpathSync(root);
      return real === base || real.startsWith(base + sep);
    } catch {
      return false;
    }
  });
}

function tail(path: string, lines: number): string {
  const all = readFileSync(path, 'utf8').split('\n');
  if (all.at(-1) === '') all.pop();
  return all.slice(-lines).join('\n');
}

function writePrefs(path: string, disabled: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ disabled }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function createApi({ ctx, jobs = JOBS, prefsFile, logRoots = [] }: ApiOptions) {
  const now = () => (ctx.now ?? (() => new Date()))();
  const roots = [ctx.logDir, ...logRoots];
  const inFlight = new Set<string>();
  const prefs = () => prefsFile ?? prefsPath();

  function listJobs(): Response {
    const at = now();
    return json(
      jobs.map((job) => ({
        id: job.id,
        description: job.description,
        schedule: job.schedule.label,
        nextRun: nextDue(job.schedule, at)?.toISOString() ?? null,
        lastRun: ctx.history.last(job.id),
        needs: job.needs ?? [],
        group: job.group ?? null,
      })),
    );
  }

  function listRuns(url: URL): Response {
    const job = url.searchParams.get('job') ?? undefined;
    if (job && !jobs.some((j) => j.id === job)) return fail(404, `unknown job '${job}'`);
    return json(ctx.history.recent(intParam(url.searchParams.get('limit'), 50, 500), job));
  }

  function runLog(id: number, url: URL): Response {
    const run = ctx.history.get(id);
    if (!run) return fail(404, `no run ${id}`);
    if (!run.log_path) return fail(404, 'this run has no log');
    if (!insideRoots(run.log_path, roots)) return fail(403, 'log is outside the allowed folders');
    const lines = intParam(url.searchParams.get('tail'), 200, 5000);
    return json({ run: run.id, path: run.log_path, lines, text: tail(run.log_path, lines) });
  }

  /** Why this job cannot start now, or null. */
  function busyReason(job: Job): string | null {
    const members = job.group ? jobs.filter((j) => j.group === job.group).map((j) => j.id) : [];
    const ids = [job.id, ...members];
    if (ids.some((id) => inFlight.has(id))) {
      return `${job.id} or its group '${job.group ?? '-'}' is already running`;
    }
    ctx.history.reapDead(now());
    const running = ctx.history.runningBefore(ids, Number.MAX_SAFE_INTEGER);
    return running.length > 0 ? `${running.map((r) => r.job).join(', ')} still running` : null;
  }

  async function startRun(id: string): Promise<Response> {
    const job = jobs.find((j) => j.id === id);
    if (!job) return fail(404, `unknown job '${id}'`);
    const busy = busyReason(job);
    if (busy) return fail(409, busy);
    const before = ctx.history.last(job.id)?.id ?? 0;
    inFlight.add(job.id);
    void runJob(job, { ...ctx, jobs }, 'manual').finally(() => inFlight.delete(job.id));
    // runJob records its row within a few ticks; wait for it so the id can be returned.
    for (let i = 0; i < 100; i++) {
      const row = ctx.history.last(job.id);
      if (row && row.id > before) return json({ runId: row.id, job: job.id }, 202);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return json({ runId: null, job: job.id }, 202);
  }

  function listNotifications(): Response {
    const off = disabledTypes(prefs());
    return json(
      Object.entries(NOTIFICATION_TYPES).map(([type, description]) => ({
        type,
        description,
        enabled: !off.has(type),
      })),
    );
  }

  async function putNotifications(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail(400, 'body must be JSON');
    }
    const disabled = (body as { disabled?: unknown } | null)?.disabled;
    if (!Array.isArray(disabled) || !disabled.every((t) => typeof t === 'string')) {
      return fail(400, 'body must be {"disabled": string[]}');
    }
    const unknown = disabled.filter((t) => !(t in NOTIFICATION_TYPES));
    if (unknown.length > 0) return fail(400, `unknown notification types: ${unknown.join(', ')}`);
    writePrefs(prefs(), [...new Set(disabled)].sort());
    return listNotifications();
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const { method } = req;
    try {
      if (path === '/jobs' && method === 'GET') return listJobs();
      if (path === '/runs' && method === 'GET') return listRuns(url);
      const log = path.match(/^\/runs\/(\d+)\/log$/);
      if (log && method === 'GET') return runLog(Number(log[1]), url);
      const run = path.match(/^\/jobs\/([^/]+)\/run$/);
      if (run && method === 'POST') return await startRun(decodeURIComponent(run[1] ?? ''));
      if (path === '/notifications' && method === 'GET') return listNotifications();
      if (path === '/notifications' && method === 'PUT') return await putNotifications(req);
      const known = ['/jobs', '/runs', '/notifications'].includes(path) || log || run;
      return known ? fail(405, 'method not allowed') : fail(404, 'not found');
    } catch (error) {
      return fail(500, error instanceof Error ? error.message : String(error));
    }
  };
}

/** Bind the API to loopback only. */
export function startApi(options: ApiOptions, port: number = apiPort()) {
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: createApi(options) });
  console.log(`scheduler API on http://127.0.0.1:${server.port}`);
  return server;
}
