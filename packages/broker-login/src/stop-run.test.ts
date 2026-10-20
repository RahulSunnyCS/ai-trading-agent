import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { request } from 'playwright';
import { QuantiplyApi } from './quantiply-api.js';
import type { QLedgerRow } from './quantiply-plan.js';
import { QUANTIPLY_SITES } from './quantiply-rules.js';
import {
  type Http,
  type Waits,
  algotestStopApi,
  playwrightHttp,
  stopAlgoTest,
  stopQuantiply,
} from './stop-run.js';

/**
 * The stop button's calls against local stand-ins for Quantiply's and AlgoTest's APIs: what is
 * sent (method, path, headers), that only the tool's algos and deploys are touched, and that the
 * result is confirmed by listing again. No browser login, no network, no real account.
 */

const fast: Waits = {
  waitMs: 200,
  pollMs: 10,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
const noLog = async () => undefined;

interface Seen {
  method: string;
  url: string;
  auth?: string | undefined;
  csrf?: string | undefined;
}

function listen(
  handler: (req: IncomingMessage, body: string) => { status: number; json: unknown },
) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        csrf: req.headers['x-csrf-token-access'] as string | undefined,
      });
      const out = handler(req, body);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  return { server, seen };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const stop = (server: Server) => new Promise<void>((done) => server.close(() => done()));

const created = (id: string, name: string): QLedgerRow => ({
  at: '2026-10-19T11:55:27Z',
  day: '2026-10-20',
  weekday: 'TUE',
  mode: 'evening',
  action: 'create',
  id,
  name,
  sha: 'a',
  ok: true,
});

describe('Quantiply stop against a stand-in API', () => {
  type A = {
    _id: string;
    name: string;
    day: string;
    enabled: boolean;
    status: string;
    polls?: number;
  };
  let algos: A[] = [];
  let failSqOff = false;
  const q = listen((req) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/algos/day-wise') {
      // a squared-off algo shows closed only after a couple of lists, like a real exit
      for (const a of algos) {
        if (a.polls === undefined) continue;
        a.polls -= 1;
        if (a.polls <= 0) {
          a.status = 'TRADE_CLOSED';
          delete a.polls;
        }
      }
      return {
        status: 200,
        json: {
          status: 'success',
          data: [{ day: 'TUE', algos: algos.map(({ polls, ...a }) => a) }],
        },
      };
    }
    const sq = /^\/algos\/([^/]+)\/action\/SQ_OFF_TERMINATE$/.exec(url);
    if (req.method === 'PUT' && sq) {
      if (failSqOff) return { status: 500, json: { message: 'broker down' } };
      const a = algos.find((x) => x._id === sq[1]);
      if (a) a.polls = 2;
      // no `status: "success"`: the web app does not read this answer, nor does the tool
      return { status: 200, json: { message: 'Square off initiated' } };
    }
    const tog = /^\/algos\/([^/]+)\/(enable|disable)$/.exec(url);
    if (req.method === 'PUT' && tog) {
      const a = algos.find((x) => x._id === tog[1]);
      if (a) a.enabled = tog[2] === 'enable';
      // assumed: an algo waiting for its entry stops waiting once off (the tool still checks)
      if (a && !a.enabled && a.status === 'READY') a.status = 'NOT_RUNNING';
      return { status: 200, json: { status: 'success' } };
    }
    return { status: 404, json: { message: 'no such route' } };
  });
  let api: QuantiplyApi;
  before(async () => {
    const base = await start(q.server);
    api = new QuantiplyApi('jwt-test', fetch, { ...QUANTIPLY_SITES.angelone, apiOrigin: base });
  });
  after(() => stop(q.server));
  beforeEach(() => {
    q.seen.length = 0;
    failSqOff = false;
    algos = [
      { _id: 'a', name: 'Core · A', day: 'TUE', enabled: true, status: 'TRADE_ACTIVE' },
      { _id: 'b', name: 'Core · B', day: 'TUE', enabled: true, status: 'READY' },
      { _id: 'c', name: 'Core · C', day: 'WED', enabled: false, status: 'NOT_RUNNING' },
      { _id: 'own', name: 'my own', day: 'TUE', enabled: true, status: 'TRADE_ACTIVE' },
    ];
  });
  const ledger = [created('a', 'Core · A'), created('b', 'Core · B'), created('c', 'Core · C')];

  it('squares off the open algo, switches off the rest, confirms, leaves the owner alone', async () => {
    const recorded: Record<string, unknown>[] = [];
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
      record: async (row) => {
        recorded.push(row);
      },
    });
    assert.equal(r.ok, true, r.lines.join('\n'));
    const writes = q.seen.filter((s) => s.method !== 'GET').map((s) => `${s.method} ${s.url}`);
    assert.deepEqual(writes, [
      'PUT /algos/a/action/SQ_OFF_TERMINATE',
      'PUT /algos/b/disable',
      'PUT /algos/a/disable',
    ]);
    assert.ok(q.seen.every((s) => s.auth === 'Bearer jwt-test'));
    assert.ok(!q.seen.some((s) => s.url.includes('/own')), 'never the owner algo');
    assert.ok(!q.seen.some((s) => s.url.endsWith('/enable')), 'never an enable');
    assert.match(r.lines.join('\n'), /squared off & terminated: Core · A/);
    assert.match(r.lines.join('\n'), /not the tool's, left alone: my own/);
    assert.deepEqual(
      recorded.map((x) => `${x.action} ${x.id}`),
      ['sqoff a', 'disable b', 'disable a'],
    );
  });

  it('a failed square off is reported for the owner, the rest still switched off', async () => {
    failSqOff = true;
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
    });
    assert.equal(r.ok, false);
    const text = r.lines.join('\n');
    assert.match(text, /square off failed: Core · A/);
    assert.match(text, /Core · A .*still TRADE_ACTIVE: square off by hand/);
    assert.match(text, /switched off: Core · B/);
  });

  it('a dry run sends nothing', async () => {
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, { dryRun: true });
    assert.deepEqual(
      q.seen.map((s) => s.method),
      ['GET'],
    );
    assert.match(r.lines.join('\n'), /would square off & terminate: Core · A/);
  });
});

describe('AlgoTest stop against a stand-in API', () => {
  type E = { _id: string; name: string; status: string; active_on_server: boolean };
  let execs: E[] = [];
  const a = listen((req) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/execution/v2/executions?environment=live')
      return { status: 200, json: execs };
    const sq = /^\/execution\/v2\/square-off\/([0-9a-f]{24})$/.exec(url);
    if (req.method === 'PUT' && sq) {
      const e = execs.find((x) => x._id === sq[1]);
      if (e) e.status = 'StrategyStatus.SquaredOff';
      return { status: 200, json: { msg: 'Square off initiated' } };
    }
    return { status: 404, json: { msg: 'no such route' } };
  });
  let base = '';
  const fetchHttp: Http = async (method, path) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'X-CSRF-TOKEN-ACCESS': 'c1' } });
    return { status: r.status, body: await r.json() };
  };
  before(async () => {
    base = await start(a.server);
  });
  after(() => stop(a.server));
  beforeEach(() => {
    a.seen.length = 0;
    execs = [
      {
        _id: '6ad590af06a3aebabc43634d',
        name: 'T1 · A',
        status: 'StrategyStatus.Live',
        active_on_server: true,
      },
      { _id: '6ad590af06a3aebabc43634e', name: 'T1 · B', status: 'paused', active_on_server: true },
      {
        _id: '6ad590af06a3aebabc43634f',
        name: 'my own',
        status: 'StrategyStatus.Live',
        active_on_server: true,
      },
    ];
  });

  it("squares off the tool's live deploy only, confirms it, names what needs a hand", async () => {
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, { dryRun: false, waits: fast });
    const writes = a.seen.filter((s) => s.method !== 'GET').map((s) => `${s.method} ${s.url}`);
    assert.deepEqual(writes, ['PUT /execution/v2/square-off/6ad590af06a3aebabc43634d']);
    const text = r.lines.join('\n');
    assert.match(text, /✅ squared off: T1 · A/);
    assert.match(text, /square off by hand.*T1 · B \(paused\)/);
    assert.match(text, /not the tool's, left running: my own/);
    assert.equal(r.ok, false); // T1 · B needs the owner
  });

  it('over Playwright: the session cookies plus the CSRF header the web app sends', async () => {
    const ctx = await request.newContext();
    try {
      const api = algotestStopApi(playwrightHttp(ctx, 'csrf-9', base));
      await api.squareOff('6ad590af06a3aebabc43634d');
      assert.deepEqual(a.seen.at(-1), {
        method: 'PUT',
        url: '/execution/v2/square-off/6ad590af06a3aebabc43634d',
        auth: undefined,
        csrf: 'csrf-9',
      });
      await assert.rejects(api.squareOff('../x'), /not an execution id/);
    } finally {
      await ctx.dispose();
    }
  });
});

describe('stop-button.ts --apply without STOP_BUTTON=on', () => {
  it('refuses before anything: no hold, no login', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-cli-'));
    const pkg = resolve(dirname(import.meta.filename), '..');
    try {
      const out = spawnSync(
        join(pkg, 'node_modules/.bin/tsx'),
        [join(pkg, 'src/stop-button.ts'), '--apply'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: root, TRADING_DATA_ROOT: root },
          timeout: 60_000,
        },
      );
      assert.equal(out.status, 2, out.stderr);
      assert.match(out.stderr, /STOP_BUTTON is not "on": nothing done/);
      const { readdirSync, existsSync } = await import('node:fs');
      const files = existsSync(join(root, 'stop')) ? readdirSync(join(root, 'stop')) : [];
      assert.ok(!files.some((f) => f.startsWith('hold-')), `no hold written: ${files.join(', ')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stop-button.ts --dry-run --fixture', () => {
  it('prints the plan and each call it would make, sends nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-cli-'));
    const pkg = resolve(dirname(import.meta.filename), '..');
    try {
      const qdir = join(root, 'rotation', 'quantiply');
      await mkdir(qdir, { recursive: true });
      await writeFile(
        join(qdir, 'ledger.jsonl'),
        `${[created('q-active-1', 'Core · N_ITM1_SL21_0917'), created('q-ready-1', 'Core · N_wide_1202')].map((r) => JSON.stringify(r)).join('\n')}\n`,
      );
      const out = spawnSync(
        join(pkg, 'node_modules/.bin/tsx'),
        [
          join(pkg, 'src/stop-button.ts'),
          '--dry-run',
          '--fixture',
          join(pkg, 'fixtures/stop-dry-run.json'),
        ],
        {
          cwd: root, // no .env here
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            HOME: root,
            TRADING_DATA_ROOT: root,
            STOP_BUTTON: 'on',
          },
          timeout: 60_000,
        },
      );
      assert.equal(out.status, 0, out.stderr);
      const text = out.stdout;
      assert.match(text, /HOLD for the rest of today/);
      assert.match(text, /Quantiply · Shoonya: nothing of the tool's in its ledger: not logged in/);
      assert.match(text, /would square off & terminate: Core · N_ITM1_SL21_0917/);
      assert.match(text, /would switch off: Core · N_wide_1202/);
      assert.match(text, /not the tool's, left alone: my own algo/);
      assert.match(text, /would square off: T1 · N_p150-t1s11_0917/);
      assert.match(text, /square off by hand.*T1 · S_wide_1117/);
      assert.match(text, /ANGELONE_CLIENT_CODE .* missing/); // the preview names what the stop lacks
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
