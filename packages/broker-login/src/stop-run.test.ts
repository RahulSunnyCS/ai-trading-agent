import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { request } from 'playwright';
import { QuantiplyApi } from './quantiply-api.js';
import type { QLedgerRow } from './quantiply-plan.js';
import { QUANTIPLY_SITES } from './quantiply-rules.js';
import { priorSquareOffs, settle } from './stop-button.js';
import { toolMatcher } from './stop-plan.js';
import {
  type Http,
  type Waits,
  algotestStopApi,
  playwrightHttp,
  stopAlgoTest,
  stopQuantiply,
} from './stop-run.js';

/**
 * The CLI under test, through tsx's own entry resolved from this package (CI's bun 1.2 hoists
 * tsx to the repo root, so `node_modules/.bin/tsx` here may not exist).
 */
// never the real scheduler state dir (the hold's second copy lives there)
process.env.SCHEDULER_STATE_DIR = join(tmpdir(), `stop-run-test-${process.pid}`);

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const PKG = resolve(dirname(import.meta.filename), '..');
function cli(args: string[], env: Record<string, string>, cwd: string) {
  return spawnSync(process.execPath, [TSX_CLI, join(PKG, 'src/stop-button.ts'), ...args], {
    cwd, // no .env here
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env },
    timeout: 60_000,
  });
}

/**
 * The stop button's calls against local stand-ins for Quantiply's and AlgoTest's APIs: what is
 * sent (method, path, headers), that only the tool's algos and deploys are touched, and that the
 * result is confirmed by listing again. No browser login, no network, no real account.
 */

const fast: Waits = {
  waitMs: 200,
  pollMs: 10,
  passes: 4,
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
  /** the square-off's answer: 0 = 200; else this HTTP status (a 4xx is a refusal) */
  let sqOffStatus = 0;
  /** ids that enter (go TRADE_ACTIVE) the moment their switch-off lands: the 09:17 race */
  let entersOnDisable = new Set<string>();
  /** lists a squared-off algo stays TRADE_ACTIVE for (Infinity: its exit never fills) */
  let closeAfter = 2;
  /** the next lists answered 503: a blip (or an outage, when large) */
  let failLists = 0;
  /** lists answered normally before the blips start */
  let listsBeforeFail = 0;
  const q = listen((req) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/algos/day-wise') {
      if (listsBeforeFail > 0) listsBeforeFail -= 1;
      else if (failLists > 0) {
        failLists -= 1;
        return { status: 503, json: { message: '503 blip' } };
      }
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
      if (sqOffStatus) return { status: sqOffStatus, json: { message: 'broker down' } };
      const a = algos.find((x) => x._id === sq[1]);
      if (a) a.polls = closeAfter;
      // no `status: "success"`: the web app does not read this answer, nor does the tool
      return { status: 200, json: { message: 'Square off initiated' } };
    }
    const tog = /^\/algos\/([^/]+)\/(enable|disable)$/.exec(url);
    if (req.method === 'PUT' && tog) {
      const a = algos.find((x) => x._id === tog[1]);
      if (a) a.enabled = tog[2] === 'enable';
      if (a && entersOnDisable.has(a._id)) a.status = 'TRADE_ACTIVE';
      // assumed: an algo waiting for its entry stops waiting once off (the tool still checks)
      else if (a && !a.enabled && a.status === 'READY') a.status = 'NOT_RUNNING';
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
    sqOffStatus = 0;
    entersOnDisable = new Set();
    closeAfter = 2;
    failLists = 0;
    listsBeforeFail = 0;
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
      record: async (row, algo) => {
        recorded.push({ ...row, day: algo.day });
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

  it('an algo that enters while it is being switched off is squared off on the next pass', async () => {
    entersOnDisable = new Set(['b']);
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
    });
    const writes = q.seen.filter((s) => s.method !== 'GET').map((s) => `${s.method} ${s.url}`);
    assert.deepEqual(writes, [
      'PUT /algos/a/action/SQ_OFF_TERMINATE',
      'PUT /algos/b/disable',
      'PUT /algos/b/action/SQ_OFF_TERMINATE',
      'PUT /algos/a/disable',
    ]);
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /squared off & terminated: Core · A, Core · B/);
  });

  it('a square-off sent but still open is "still closing: do NOT exit at the broker", never by hand', async () => {
    closeAfter = Number.POSITIVE_INFINITY;
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
    });
    const text = r.lines.join('\n');
    assert.equal(r.ok, false);
    assert.match(
      text,
      /square-off sent, still closing .*Core · A \(sent \d\d:\d\d\).*do NOT exit these at the broker/,
    );
    assert.doesNotMatch(text, /Core · A[^\n]*square off by hand/);
    // sent once only, however many passes waited on it
    assert.equal(q.seen.filter((x) => x.url === '/algos/a/action/SQ_OFF_TERMINATE').length, 1);
  });

  it('rides out a list that fails twice, then finishes the stop', async () => {
    listsBeforeFail = 1; // the first list works; the next two answer 503
    failLists = 2;
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
    });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /squared off & terminated: Core · A/);
  });

  it('a list that stays down after a square-off names it: do NOT exit at the broker', async () => {
    listsBeforeFail = 1;
    failLists = 1000;
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
    });
    const text = r.lines.join('\n');
    assert.equal(r.ok, false);
    assert.match(text, /503 blip/);
    assert.match(
      text,
      /square-off already sent for: Core · A \(sent \d\d:\d\d\)\. Do NOT exit these at the broker/,
    );
  });

  it('a square off refused outright (4xx) is "by hand"; the rest still switched off', async () => {
    sqOffStatus = 400;
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
    });
    assert.equal(r.ok, false);
    const text = r.lines.join('\n');
    assert.match(text, /square off refused: Core · A/);
    assert.match(text, /Core · A .*still TRADE_ACTIVE: square off by hand/);
    assert.match(text, /switched off: Core · B/);
  });

  it('a square off with no answer (5xx) may have been sent: never "by hand", never sent twice', async () => {
    sqOffStatus = 503;
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
    });
    const text = r.lines.join('\n');
    assert.equal(r.ok, false);
    assert.match(
      text,
      /square-off may have been sent \(no answer\): Core · A \(sent \d\d:\d\d\)\. Open Quantiply first; exit at the broker only if it shows no pending exit/,
    );
    assert.doesNotMatch(text, /Core · A[^\n]*square off by hand/);
    assert.equal(q.seen.filter((x) => x.url === '/algos/a/action/SQ_OFF_TERMINATE').length, 1);
  });

  it("an earlier stop's no-answer square-off stays 'may have been sent', never sent again", async () => {
    closeAfter = Number.POSITIVE_INFINITY;
    const prior = new Map([['a', { name: 'Core · A', at: '09:20', earlier: true, maybe: true }]]);
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
      prior,
    });
    const text = r.lines.join('\n');
    assert.equal(q.seen.filter((x) => x.url === '/algos/a/action/SQ_OFF_TERMINATE').length, 0);
    assert.match(
      text,
      /may have been sent \(no answer\): Core · A \(sent 09:20 by an earlier stop\)\. Open Quantiply first; exit at the broker only if it shows no pending exit/,
    );
    assert.doesNotMatch(text, /still closing/);
  });

  it("an earlier stop's square-off is never sent again: waited on, reported as sent then", async () => {
    closeAfter = Number.POSITIVE_INFINITY;
    const prior = new Map([['a', { name: 'Core · A', at: '09:20', earlier: true }]]);
    // that earlier square-off is still working: the algo shows TRADE_ACTIVE
    const r = await stopQuantiply('Quantiply · Angel One', api, ledger, noLog, {
      dryRun: false,
      waits: fast,
      prior,
    });
    assert.equal(q.seen.filter((x) => x.url === '/algos/a/action/SQ_OFF_TERMINATE').length, 0);
    assert.match(
      r.lines.join('\n'),
      /still closing .*Core · A \(sent 09:20 by an earlier stop\).*do NOT exit/,
    );
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
  /** lists a squared-off deploy shows `pending_square_off` for; Infinity = it never finishes */
  let pendingLists = 2;
  /** a deploy that appears once the first square-off went out (a deploy job finishing) */
  let lateDeploy: E | null = null;
  let aListsBeforeFail = 0;
  let aFailLists = 0;
  /** 0 = 200; else this HTTP status; `takenAnyway`: AlgoTest acted though the answer failed */
  let aSqStatus = 0;
  let takenAnyway = false;
  const pending = new Map<string, number>();
  const a = listen((req) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/execution/v2/executions?environment=live') {
      if (aListsBeforeFail > 0) aListsBeforeFail -= 1;
      else if (aFailLists > 0) {
        aFailLists -= 1;
        return { status: 502, json: { msg: '502 blip' } };
      }
      for (const [id, n] of pending) {
        const e = execs.find((x) => x._id === id);
        if (!e) continue;
        if (n <= 0) {
          e.status = 'StrategyStatus.SquaredOff';
          pending.delete(id);
        } else pending.set(id, n - 1);
      }
      return { status: 200, json: execs };
    }
    const sq = /^\/execution\/v2\/square-off\/([0-9a-f]{24})$/.exec(url);
    if (req.method === 'PUT' && sq) {
      const e = execs.find((x) => x._id === sq[1]);
      if (aSqStatus) {
        if (e && takenAnyway) e.status = 'pending_square_off';
        return { status: aSqStatus, json: { msg: 'failed' } };
      }
      if (e) {
        e.status = 'pending_square_off';
        pending.set(e._id, pendingLists);
      }
      if (lateDeploy) {
        execs.push(lateDeploy);
        lateDeploy = null;
      }
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
    pendingLists = 2;
    lateDeploy = null;
    aListsBeforeFail = 0;
    aFailLists = 0;
    aSqStatus = 0;
    takenAnyway = false;
    pending.clear();
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

  const opts = { dryRun: false, waits: fast, isTool: toolMatcher([]), today: '2026-10-20' };

  it("squares off the tool's live deploy only, waits out pending_square_off, confirms it", async () => {
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, opts);
    const writes = a.seen.filter((s) => s.method !== 'GET').map((s) => `${s.method} ${s.url}`);
    assert.deepEqual(writes, ['PUT /execution/v2/square-off/6ad590af06a3aebabc43634d']);
    const text = r.lines.join('\n');
    assert.match(text, /✅ squared off: T1 · A/);
    assert.match(text, /square off by hand.*T1 · B \(paused\)/);
    assert.match(text, /not the tool's, left running: my own/);
    assert.equal(r.ok, false); // T1 · B needs the owner
    assert.doesNotMatch(text, /T1 · A.*by hand/);
  });

  it('a square-off still pending after the wait is never "by hand": do NOT exit at the broker', async () => {
    pendingLists = Number.POSITIVE_INFINITY;
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, opts);
    const text = r.lines.join('\n');
    assert.match(text, /square-off sent, still closing: T1 · A .*Do NOT exit these at the broker/);
    assert.doesNotMatch(text, /T1 · A[^\n]*square off by hand/);
    assert.equal(r.ok, false);
  });

  it('a list that stays down after a square-off names it: do NOT exit at the broker', async () => {
    aListsBeforeFail = 1;
    aFailLists = 1000;
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, opts);
    const text = r.lines.join('\n');
    assert.match(text, /live list answered 502/);
    assert.match(
      text,
      /square-off already sent for: T1 · A \(sent \d\d:\d\d\)\. Do NOT exit these at the broker/,
    );
  });

  it('every square-off refused (4xx): never "nothing running"; still LIVE, by hand', async () => {
    aSqStatus = 403;
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, opts);
    const text = r.lines.join('\n');
    assert.equal(r.ok, false);
    assert.doesNotMatch(text, /nothing of the tool's running/);
    assert.match(text, /❌ still LIVE: square off by hand on AlgoTest \/live: T1 · A/);
  });

  it('a square-off with no answer (5xx) may have been sent; one AlgoTest took anyway is still closing', async () => {
    aSqStatus = 502;
    let r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, opts);
    let text = r.lines.join('\n');
    assert.match(
      text,
      /square-off may have been sent \(no answer\): T1 · A \(sent \d\d:\d\d\)\. Open AlgoTest \/live first/,
    );
    assert.doesNotMatch(text, /T1 · A[^\n]*by hand/);
    assert.equal(a.seen.filter((x) => x.method === 'PUT').length, 1); // never sent twice
    // the call failed but AlgoTest is squaring it off after all
    a.seen.length = 0;
    execs[0] = { ...(execs[0] as E), status: 'StrategyStatus.Live' };
    takenAnyway = true;
    r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, opts);
    text = r.lines.join('\n');
    assert.match(text, /square-off sent, still closing: T1 · A \(sent \d\d:\d\d\)\. Do NOT exit/);
    assert.doesNotMatch(text, /nothing of the tool's running/);
  });

  it("an earlier stop's no-answer square-off stays 'may have been sent' on AlgoTest", async () => {
    const prior = new Map([
      ['6ad590af06a3aebabc43634d', { name: 'T1 · A', at: '09:20', earlier: true, maybe: true }],
    ]);
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, { ...opts, prior });
    const text = r.lines.join('\n');
    assert.equal(a.seen.filter((x) => x.method === 'PUT').length, 0);
    assert.match(
      text,
      /may have been sent \(no answer\): T1 · A \(sent 09:20 by an earlier stop\)\. Open AlgoTest \/live first/,
    );
    assert.doesNotMatch(text, /still closing/);
  });

  it("an earlier stop's deploy gone from /live is said once, then logged gone", async () => {
    const prior = new Map([
      ['6ad590af06a3aebabc436399', { name: 'T1 · Old', at: '09:20', earlier: true }],
    ]);
    const rows: Record<string, unknown>[] = [];
    const r = await stopAlgoTest(
      algotestStopApi(fetchHttp),
      async (row) => {
        rows.push(row);
      },
      { ...opts, prior },
    );
    assert.match(
      r.lines.join('\n'),
      /T1 · Old: squared off by an earlier stop, no longer listed on \/live: check it once/,
    );
    assert.ok(rows.some((x) => x.step === 'gone' && x.id === '6ad590af06a3aebabc436399'));
  });

  it("an earlier stop's square-off is never sent again", async () => {
    const prior = new Map([
      ['6ad590af06a3aebabc43634d', { name: 'T1 · A', at: '09:20', earlier: true }],
    ]);
    pendingLists = Number.POSITIVE_INFINITY;
    execs[0] = { ...(execs[0] as E), status: 'pending_square_off' };
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, { ...opts, prior });
    assert.equal(a.seen.filter((x) => x.method === 'PUT').length, 0);
    assert.match(r.lines.join('\n'), /still closing: T1 · A \(sent 09:20 by an earlier stop\)/);
  });

  it('a deploy that went live during the stop is squared off on the next pass', async () => {
    lateDeploy = {
      _id: '6ad590af06a3aebabc436350',
      name: 'Core · Late',
      status: 'StrategyStatus.Live',
      active_on_server: true,
    };
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, opts);
    const writes = a.seen.filter((s) => s.method !== 'GET').map((s) => s.url);
    assert.deepEqual(writes, [
      '/execution/v2/square-off/6ad590af06a3aebabc43634d',
      '/execution/v2/square-off/6ad590af06a3aebabc436350',
    ]);
    assert.match(r.lines.join('\n'), /✅ squared off: T1 · A, Core · Late/);
  });

  it('a deploy switched to manual is a check (legs may be open), never green', async () => {
    execs = [
      {
        _id: '6ad590af06a3aebabc43634d',
        name: 'T1 · Manual',
        status: 'StrategyStatus.Stopped',
        active_on_server: false,
      },
    ];
    const r = await stopAlgoTest(algotestStopApi(fetchHttp), noLog, opts);
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /switched to manual today, its legs may be open.*T1 · Manual/);
    assert.equal(a.seen.filter((s) => s.method !== 'GET').length, 0);
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

describe('each platform is settled on its own', () => {
  it('one platform throwing (a browser that will not start) never hides the others', async () => {
    const reports = await settle([
      {
        platform: 'Quantiply · Angel One',
        run: async () => ({ platform: 'Q', ok: true, lines: ['done'] }),
      },
      {
        platform: 'AlgoTest',
        run: async () => {
          throw new Error('browserType.launch: Executable does not exist');
        },
      },
    ]);
    assert.equal(reports.length, 2);
    assert.equal(reports[0]?.ok, true);
    assert.equal(reports[1]?.platform, 'AlgoTest');
    assert.equal(reports[1]?.ok, false);
    assert.match(reports[1]?.lines.join('\n') ?? '', /Executable does not exist/);
  });
});

describe('stop-button.ts --apply without STOP_BUTTON=on', () => {
  it('refuses before anything: no hold, no login', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-cli-'));
    try {
      const out = cli(['--apply'], { TRADING_DATA_ROOT: root }, root);
      assert.equal(out.status, 2, out.stderr);
      assert.match(out.stderr, /REFUSED: STOP_BUTTON is not "on"/);
      const files = readdirSync(join(root, 'stop'));
      assert.ok(!files.includes('HOLD.json'), `no hold written: ${files.join(', ')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stop-button.ts --apply while another stop runs', () => {
  it('refuses (exit 2) and touches nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-cli-'));
    try {
      await mkdir(join(root, 'stop'));
      // this test process is alive and is not the child: a running stop as far as the child sees
      await writeFile(
        join(root, 'stop', 'stop-running.json'),
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      );
      const out = cli(
        ['--apply'],
        { TRADING_DATA_ROOT: root, STOP_BUTTON: 'on', SCHEDULER_STATE_DIR: join(root, 'state') },
        root,
      );
      assert.equal(out.status, 2, out.stderr);
      assert.match(
        out.stderr,
        /REFUSED: a stop is already running since \d{4}-\d\d-\d\d \d\d:\d\d IST \(pid \d+\)\. If no report arrives within 15 minutes, delete .*stop-running\.json and send \/stop again/,
      );
      assert.ok(!readdirSync(join(root, 'stop')).includes('HOLD.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the stop log tells a later stop what was already sent', () => {
  it("today's answered and maybe-sent square-offs, per platform", async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-prior-'));
    try {
      await mkdir(join(root, 'stop'));
      const rows = [
        {
          at: '2026-10-20T03:50:00Z',
          who: 'runner',
          platform: 'AlgoTest',
          step: 'square_off',
          id: 'x1',
          name: 'T1 · A',
          ok: true,
        },
        {
          at: '2026-10-20T03:51:00Z',
          who: 'runner',
          platform: 'Quantiply · Angel One',
          step: 'sq_off_terminate',
          id: 'q1',
          name: 'Core · B',
          ok: false,
          maybe: true,
        },
        {
          at: '2026-10-20T03:52:00Z',
          who: 'runner',
          platform: 'AlgoTest',
          step: 'square_off',
          id: 'x2',
          name: 'T1 · C',
          ok: false,
          maybe: false,
        },
        { at: '2026-10-20T03:52:00Z', who: 'listener', event: 'confirmed' },
      ];
      await writeFile(
        join(root, 'stop', '2026-10-20.jsonl'),
        `${rows.map((r) => JSON.stringify(r)).join('\n')}\n{torn`,
      );
      const env = { SCHEDULER_STATE_DIR: join(root, 'state') };
      const prior = await priorSquareOffs(root, '2026-10-20', env);
      assert.deepEqual([...(prior.get('AlgoTest')?.keys() ?? [])], ['x1']);
      assert.deepEqual(prior.get('AlgoTest')?.get('x1'), {
        name: 'T1 · A',
        at: '09:20',
        earlier: true,
        maybe: false,
      });
      // no answer stays "may have been sent", never "sent"
      assert.equal(prior.get('Quantiply · Angel One')?.get('q1')?.maybe, true);
      assert.equal((await priorSquareOffs(undefined, '2026-10-20', env)).size, 0);

      // the laptop's own copy (the data volume gone): an answer there wins over the no-answer;
      // a deploy already reported gone is left out
      await mkdir(join(root, 'state'));
      const more = [
        {
          at: '2026-10-20T03:55:00Z',
          who: 'runner',
          platform: 'Quantiply · Angel One',
          step: 'sq_off_terminate',
          id: 'q1',
          name: 'Core · B',
          ok: true,
        },
        {
          at: '2026-10-20T03:56:00Z',
          who: 'runner',
          platform: 'AlgoTest',
          step: 'gone',
          id: 'x1',
          name: 'T1 · A',
        },
      ];
      await writeFile(
        join(root, 'state', 'stop-squareoffs-2026-10-20.jsonl'),
        `${more.map((r) => JSON.stringify(r)).join('\n')}\n`,
      );
      const both = await priorSquareOffs(root, '2026-10-20', env);
      assert.equal(both.get('Quantiply · Angel One')?.get('q1')?.maybe, false);
      assert.equal(both.get('AlgoTest'), undefined);
      const stateOnly = await priorSquareOffs(undefined, '2026-10-20', env);
      assert.equal(stateOnly.get('Quantiply · Angel One')?.get('q1')?.maybe, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stop-button.ts --apply when the hold cannot be saved', () => {
  it('says HOLD NOT SAVED first and still goes on to the platforms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-cli-'));
    try {
      await writeFile(join(root, 'stop'), 'a file where the stop folder should be');
      await writeFile(join(root, 'state'), 'a file where the state folder should be');
      const out = cli(
        ['--apply'],
        { TRADING_DATA_ROOT: root, STOP_BUTTON: 'on', SCHEDULER_STATE_DIR: join(root, 'state') },
        root,
      );
      // 4: Telegram is not configured in the test, so the report did not go
      assert.equal(out.status, 4, out.stderr);
      assert.match(
        out.stderr,
        /HOLD NOT SAVED \(.*\): the tool may re-enable or upload after a scheduler restart/,
      );
      // it went on: each platform has its section (no logins here: no credentials)
      assert.match(out.stdout, /^❌ HOLD NOT SAVED/m);
      assert.match(out.stdout, /Quantiply · Angel One/);
      assert.match(out.stdout, /AlgoTest\n.*ALGOTEST_PHONE \/ ALGOTEST_PASSWORD missing/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stop-button.ts --plan with a missing ledger', () => {
  it('fails closed for an account with a login but no ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-cli-'));
    try {
      const out = cli(
        ['--plan'],
        {
          TRADING_DATA_ROOT: root,
          ANGELONE_CLIENT_CODE: 'X1',
          ANGELONE_MPIN: '0000',
          ANGELONE_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
        },
        root,
      );
      assert.equal(out.status, 0, out.stderr);
      assert.match(
        out.stdout,
        /Quantiply · Angel One: ⚠️ its ledger is missing .*could not tell what is the tool's/,
      );
      assert.match(out.stdout, /Quantiply · Shoonya: not used by the tool/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('stop-button.ts --dry-run --fixture', () => {
  it('prints the plan and each call it would make, sends nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-cli-'));
    try {
      const qdir = join(root, 'rotation', 'quantiply');
      await mkdir(qdir, { recursive: true });
      await writeFile(
        join(qdir, 'ledger.jsonl'),
        `${[created('q-active-1', 'Core · N_ITM1_SL21_0917'), created('q-ready-1', 'Core · N_wide_1202')].map((r) => JSON.stringify(r)).join('\n')}\n`,
      );
      const out = cli(
        ['--dry-run', '--fixture', join(PKG, 'fixtures/stop-dry-run.json')],
        { TRADING_DATA_ROOT: root, STOP_BUTTON: 'on' },
        root,
      );
      assert.equal(out.status, 0, out.stderr);
      const text = out.stdout;
      assert.match(text, /HOLD until you lift it/);
      assert.match(text, /Quantiply · Shoonya: not used by the tool/);
      assert.match(text, /would square off & terminate: Core · N_ITM1_SL21_0917/);
      assert.match(text, /would switch off: Core · N_wide_1202/);
      assert.match(text, /not the tool's, left alone: my own algo/);
      assert.match(text, /would square off: T1 · N_p150-t1s11_0917/);
      assert.match(text, /square off by hand.*T1 · S_wide_1117/);
      assert.match(text, /Quantiply · Angel One: its login is missing/); // the preview names what the stop lacks
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
