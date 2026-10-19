import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../api.js';
import {
  type AutomationSettings,
  DEFAULT_SETTINGS,
  SettingsStore,
  effective,
  githubVariables,
  syncGithub,
  validate,
} from '../automation.js';
import { History } from '../history.js';
import type { RunContext } from '../runner.js';

const clone = (s: AutomationSettings): AutomationSettings => JSON.parse(JSON.stringify(s));

describe('validate', () => {
  it('accepts the defaults and rebuilds them in a fixed order', () => {
    const checked = validate(clone(DEFAULT_SETTINGS));
    expect('settings' in checked && checked.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('refuses unknown keys, wrong types, a missing row and upload with no list', () => {
    type Loose = Record<string, unknown>;
    const bad = clone(DEFAULT_SETTINGS) as unknown as {
      extra?: number;
      masters: Loose;
      rows: Record<string, Loose>;
    };
    bad.extra = 1;
    bad.masters.logins = 'yes';
    bad.rows['algotest.zerodha'] = { login: true, list: 'core', upload: true };
    (bad.rows['quantiply.finvasia'] as Loose).list = 'classic';
    (bad.rows['algotest.angelone'] as Loose).upload = true; // list is 'none'
    bad.rows['quantiply.angelone'] = undefined as unknown as Loose;
    const checked = validate(bad);
    expect('errors' in checked).toBe(true);
    const errors = 'errors' in checked ? checked.errors.join('\n') : '';
    expect(errors).toContain('unknown keys: extra');
    expect(errors).toContain('masters.logins must be true or false');
    expect(errors).toContain('unknown row: algotest.zerodha');
    expect(errors).toContain('quantiply.finvasia.list must be one of');
    expect(errors).toContain('algotest.angelone: upload is on but no list is chosen');
    expect(errors).toContain('quantiply.angelone: missing');
  });

  it('refuses a non-object', () => {
    expect(validate([])).toEqual({ errors: ['settings must be an object'] });
  });
});

describe('effective and the GitHub variables', () => {
  it("today's setup logs both brokers into AlgoTest and Angel One into Quantiply", () => {
    expect(githubVariables(DEFAULT_SETTINGS)).toEqual({
      BROKER_LOGIN_ENABLED: 'on',
      ALGOTEST_BROKERS: 'finvasia,angelone',
      QUANTIPLY_BROKERS: 'angelone',
      BROKER_LOGIN_ONLY: '',
      QUANTIPLY_LOGIN: 'on',
    });
  });

  it('a master switch off turns its kind of automation off for every row', () => {
    const s = clone(DEFAULT_SETTINGS);
    s.masters.logins = false;
    s.masters.uploads = false;
    expect(effective(s, 'quantiply.angelone')).toEqual({
      login: false,
      list: 'core',
      upload: false,
    });
    const vars = githubVariables(s);
    expect(vars).toMatchObject({
      BROKER_LOGIN_ENABLED: 'off',
      ALGOTEST_BROKERS: '',
      QUANTIPLY_LOGIN: 'off',
    });
    // The workflow understands `none` (config.ts, BL-140 Phase 3): no AlgoTest login.
    expect(vars.BROKER_LOGIN_ONLY).toBe('none');
  });

  it('one AlgoTest broker becomes BROKER_LOGIN_ONLY', () => {
    const s = clone(DEFAULT_SETTINGS);
    s.rows['algotest.angelone'].login = false;
    expect(githubVariables(s).BROKER_LOGIN_ONLY).toBe('finvasia');
  });

  it('syncGithub sets each variable, deletes empty ones, and reports a failure', async () => {
    const calls: string[][] = [];
    const ok = await syncGithub(DEFAULT_SETTINGS, async (args) => {
      calls.push(args);
    });
    expect(ok).toStartWith('ok: ');
    expect(calls).toContainEqual(['variable', 'delete', 'BROKER_LOGIN_ONLY']);
    expect(calls).toContainEqual(['variable', 'set', 'QUANTIPLY_LOGIN', '--body', 'on']);
    const bad = await syncGithub(DEFAULT_SETTINGS, async (args) => {
      if (args[2] === 'QUANTIPLY_LOGIN') throw new Error('HTTP 403\nmore');
    });
    expect(bad).toBe('FAILED 1/5: QUANTIPLY_LOGIN: HTTP 403');
  });
});

let dir: string;
let store: SettingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduler-automation-'));
  store = new SettingsStore(join(dir, 'scheduler.db'), join(dir, 'automation-settings.json'));
});
afterEach(() => store.close());

describe('SettingsStore', () => {
  it('starts from the defaults as version 0, then appends versions', () => {
    expect(store.current()).toMatchObject({ version: 0, settings: DEFAULT_SETTINGS });
    const s = clone(DEFAULT_SETTINGS);
    s.rows['quantiply.angelone'].list = 't1';
    const v1 = store.save(DEFAULT_SETTINGS, new Date('2026-10-19T12:00:00Z'));
    const v2 = store.save(s, new Date('2026-10-19T12:05:00Z'));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(store.current().settings.rows['quantiply.angelone'].list).toBe('t1');
    expect(store.history().map((v) => v.version)).toEqual([2, 1]);
  });

  it('writes the current version for the jobs on every save', () => {
    store.save(DEFAULT_SETTINGS, new Date('2026-10-19T12:00:00Z'));
    const snap = JSON.parse(readFileSync(join(dir, 'automation-settings.json'), 'utf8'));
    expect(snap).toMatchObject({
      version: 1,
      saved_at: '2026-10-19T12:00:00.000Z',
      ...DEFAULT_SETTINGS,
    });
  });

  it('records the GitHub outcome on its version', () => {
    const v = store.save(DEFAULT_SETTINGS);
    store.noteGithub(v.version, 'ok: x');
    expect(store.current().github).toBe('ok: x');
  });
});

interface View {
  current: { version: number; github: string | null };
  effective: Record<string, unknown>;
  github: Record<string, string>;
}

describe('API /settings/automation', () => {
  const ctx = (): RunContext => ({
    repoRoot: dir,
    env: {},
    logDir: dir,
    history: new History(join(dir, 'runs.db')),
    builtins: {},
  });

  it('GET shows the current version, the effective rows and the variables', async () => {
    const handle = createApi({ ctx: ctx(), jobs: [], settings: store, gh: async () => {} });
    const res = await handle(new Request('http://x/settings/automation'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as View;
    expect(body.current.version).toBe(0);
    expect(body.effective['quantiply.angelone']).toEqual({
      login: true,
      list: 'core',
      upload: true,
    });
    expect(body.github.QUANTIPLY_LOGIN).toBe('on');
  });

  it('PUT validates, saves a version and syncs GitHub', async () => {
    const calls: string[][] = [];
    const handle = createApi({
      ctx: ctx(),
      jobs: [],
      settings: store,
      gh: async (args) => {
        calls.push(args);
      },
    });
    const s = clone(DEFAULT_SETTINGS);
    s.masters.logins = false;
    const res = await handle(
      new Request('http://x/settings/automation', { method: 'PUT', body: JSON.stringify(s) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as View;
    expect(body.current.version).toBe(1);
    expect(body.current.github).toStartWith('ok: BROKER_LOGIN_ENABLED=off');
    expect(calls).toContainEqual(['variable', 'set', 'BROKER_LOGIN_ENABLED', '--body', 'off']);

    const bad = await handle(
      new Request('http://x/settings/automation', { method: 'PUT', body: '{"masters":{}}' }),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: string[] }).errors.length).toBeGreaterThan(0);
    expect(store.current().version).toBe(1); // nothing saved
  });

  it('answers 503 without a store', async () => {
    const handle = createApi({ ctx: ctx(), jobs: [] });
    expect((await handle(new Request('http://x/settings/automation'))).status).toBe(503);
  });
});
