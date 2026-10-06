import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTIFICATION_TYPES } from '@trading/notify';
import { apiPort, createApi } from '../api.js';
import { History } from '../history.js';
import type { Job } from '../jobs.js';
import type { RunContext } from '../runner.js';

function job(id: string, script: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    description: `${id} job`,
    schedule: { at: '08:00', on: () => true, label: 'daily 08:00' },
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

let dir: string;
let ctx: RunContext;
let prefsFile: string;
let jobs: Job[];
let handle: (req: Request) => Promise<Response>;

const get = (path: string) => handle(new Request(`http://x${path}`));
const send = (method: string, path: string, body?: unknown) =>
  handle(
    new Request(`http://x${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-api-'));
  ctx = {
    repoRoot: dir,
    env: { PATH: '/usr/bin:/bin' },
    logDir: join(dir, 'logs'),
    history: new History(':memory:'),
    busyPollMs: 10,
  };
  prefsFile = join(dir, 'cfg', 'notifications.json');
  jobs = [
    job('fast', 'echo hi'),
    job('slow', 'sleep 1', { group: 'catalog' }),
    job('other', 'echo x', { group: 'catalog', needs: ['home'] }),
  ];
  handle = createApi({ ctx, jobs, prefsFile });
});

afterEach(() => ctx.history.close());

describe('GET /jobs and /runs', () => {
  it('lists jobs with schedule, next run, last run, needs and group', async () => {
    const body = (await (await get('/jobs')).json()) as Array<Record<string, unknown>>;
    expect(body.map((j) => j.id)).toEqual(['fast', 'slow', 'other']);
    expect(body[0]).toMatchObject({ schedule: 'daily 08:00', lastRun: null, group: null });
    expect(typeof body[0]?.nextRun).toBe('string');
    expect(body[2]).toMatchObject({ needs: ['home'], group: 'catalog' });
  });

  it('filters runs by job and 404s an unknown job', async () => {
    ctx.history.start('fast', 'manual', null, '', new Date());
    ctx.history.start('slow', 'manual', null, '', new Date());
    const runs = (await (await get('/runs?job=fast&limit=5')).json()) as unknown[];
    expect(runs).toHaveLength(1);
    expect((await get('/runs?job=nope')).status).toBe(404);
  });
});

describe('POST /jobs/:id/run', () => {
  it('returns 404 for an unknown job', async () => {
    expect((await send('POST', '/jobs/nope/run')).status).toBe(404);
  });

  it('starts a manual run, returns 202 and its id, and 409s while in flight', async () => {
    const res = await send('POST', '/jobs/slow/run');
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: number };
    expect(ctx.history.get(runId)).toMatchObject({ job: 'slow', trigger: 'manual' });
    expect((await send('POST', '/jobs/slow/run')).status).toBe(409);
    // another job in the same group is busy too
    expect((await send('POST', '/jobs/other/run')).status).toBe(409);
    // a job outside the group is fine
    expect((await send('POST', '/jobs/fast/run')).status).toBe(202);
    for (let i = 0; i < 300 && ctx.history.get(runId)?.ended_at === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ctx.history.get(runId)?.exit_code).toBe(0);
  });

  it('409s when another process has an unfinished run in the group', async () => {
    ctx.history.start('slow', 'schedule', null, '', new Date());
    expect((await send('POST', '/jobs/other/run')).status).toBe(409);
  });
});

describe('GET /runs/:id/log', () => {
  it('returns the tail of a log inside the log dir', async () => {
    mkdirSync(ctx.logDir, { recursive: true });
    const path = join(ctx.logDir, 'a.log');
    writeFileSync(path, 'one\ntwo\nthree\n');
    const id = ctx.history.start('fast', 'manual', null, path, new Date());
    const body = (await (await get(`/runs/${id}/log?tail=2`)).json()) as { text: string };
    expect(body.text).toBe('two\nthree');
  });

  it('refuses a log outside the allowed folders, including through a symlink', async () => {
    mkdirSync(ctx.logDir, { recursive: true });
    const outside = join(dir, 'secret.txt');
    writeFileSync(outside, 'secret');
    const link = join(ctx.logDir, 'link.log');
    symlinkSync(outside, link);
    const direct = ctx.history.start('fast', 'manual', null, outside, new Date());
    const viaLink = ctx.history.start('fast', 'manual', null, link, new Date());
    expect((await get(`/runs/${direct}/log`)).status).toBe(403);
    expect((await get(`/runs/${viaLink}/log`)).status).toBe(403);
    expect((await get('/runs/9999/log')).status).toBe(404);
  });

  it('allows extra log roots', async () => {
    const data = join(dir, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'w.log'), 'weekly');
    handle = createApi({ ctx, jobs, prefsFile, logRoots: [data] });
    const id = ctx.history.start('fast', 'manual', null, join(data, 'w.log'), new Date());
    expect((await get(`/runs/${id}/log`)).status).toBe(200);
  });
});

describe('notifications', () => {
  it('lists every type enabled when there is no prefs file', async () => {
    const body = (await (await get('/notifications')).json()) as Array<{ enabled: boolean }>;
    expect(body).toHaveLength(Object.keys(NOTIFICATION_TYPES).length);
    expect(body.every((n) => n.enabled)).toBe(true);
  });

  it('writes the prefs file and reflects it', async () => {
    const res = await send('PUT', '/notifications', {
      disabled: ['momentum.preview', 'broker.fyers'],
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(prefsFile, 'utf8'))).toEqual({
      disabled: ['broker.fyers', 'momentum.preview'],
    });
    const body = (await (await get('/notifications')).json()) as Array<{
      type: string;
      enabled: boolean;
    }>;
    expect(body.find((n) => n.type === 'momentum.preview')?.enabled).toBe(false);
    expect(body.find((n) => n.type === 'options.daily')?.enabled).toBe(true);
  });

  it('rejects unknown types and bad bodies without writing', async () => {
    expect((await send('PUT', '/notifications', { disabled: ['nope'] })).status).toBe(400);
    expect((await send('PUT', '/notifications', { disabled: 'x' })).status).toBe(400);
    expect(existsSync(prefsFile)).toBe(false);
  });
});

describe('routing and config', () => {
  it('404s unknown paths and 405s wrong methods', async () => {
    expect((await get('/nope')).status).toBe(404);
    expect((await send('DELETE', '/jobs')).status).toBe(405);
  });

  it('reads the port from SCHEDULER_API_PORT with a safe default', () => {
    expect(apiPort({})).toBe(8790);
    expect(apiPort({ SCHEDULER_API_PORT: '9001' })).toBe(9001);
    expect(apiPort({ SCHEDULER_API_PORT: 'abc' })).toBe(8790);
  });
});
