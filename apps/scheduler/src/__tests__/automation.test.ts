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
  pausedFor,
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
    bad.rows['algotest.zerodha'] = {
      login: true,
      list: 'core',
      upload: true,
      multiplier: 1,
      addon: true,
    };
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
  it("today's live setup: AlgoTest logs Shoonya in, Quantiply logs in through Angel One", () => {
    // gh variable list on 2026-10-19: BROKER_LOGIN_ONLY=finvasia, QUANTIPLY_LOGIN=on.
    expect(githubVariables(DEFAULT_SETTINGS)).toEqual({
      vars: {
        BROKER_LOGIN_ENABLED: 'on',
        ALGOTEST_BROKERS: 'finvasia',
        QUANTIPLY_BROKERS: 'angelone',
        BROKER_LOGIN_ONLY: 'finvasia',
        QUANTIPLY_LOGIN: 'on',
      },
      withheld: [],
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
      multiplier: 1,
      addon: true,
    });
    const { vars, withheld } = githubVariables(s);
    expect(vars).toMatchObject({
      BROKER_LOGIN_ENABLED: 'off',
      ALGOTEST_BROKERS: '',
      QUANTIPLY_LOGIN: 'off',
    });
    // The workflow understands `none` and BROKER_LOGIN_ENABLED (BL-140 Phase 3): nothing held back.
    expect(vars.BROKER_LOGIN_ONLY).toBe('none');
    expect(withheld).toEqual([]);
  });

  it('both AlgoTest brokers leave BROKER_LOGIN_ONLY empty; one names it', () => {
    const s = clone(DEFAULT_SETTINGS);
    s.rows['algotest.angelone'].login = true;
    expect(githubVariables(s).vars.BROKER_LOGIN_ONLY).toBe('');
    s.rows['algotest.finvasia'].login = false;
    expect(githubVariables(s).vars.BROKER_LOGIN_ONLY).toBe('angelone');
  });

  it('QUANTIPLY_LOGIN is the Angel One route only', () => {
    const s = clone(DEFAULT_SETTINGS);
    s.rows['quantiply.angelone'].login = false;
    s.rows['quantiply.finvasia'].login = true;
    expect(githubVariables(s).vars).toMatchObject({
      QUANTIPLY_LOGIN: 'off',
      QUANTIPLY_BROKERS: 'finvasia',
    });
  });

  it('syncGithub sets each variable, deletes empty ones, and reports a failure', async () => {
    const both = clone(DEFAULT_SETTINGS);
    both.rows['algotest.angelone'].login = true;
    const calls: string[][] = [];
    const ok = await syncGithub(both, async (args) => {
      calls.push(args);
    });
    expect(ok).toStartWith('ok: ');
    expect(calls).toContainEqual(['variable', 'delete', 'BROKER_LOGIN_ONLY']);
    expect(calls).toContainEqual(['variable', 'set', 'QUANTIPLY_LOGIN', '--body', 'on']);
    const bad = await syncGithub(both, async (args) => {
      if (args[2] === 'QUANTIPLY_LOGIN') throw new Error('HTTP 403\nmore');
    });
    expect(bad).toBe('FAILED 1/5: QUANTIPLY_LOGIN: HTTP 403');
  });

  it('deleting a missing variable is fine; any other failed delete is reported', async () => {
    const both = clone(DEFAULT_SETTINGS);
    both.rows['algotest.angelone'].login = true;
    const missing = await syncGithub(both, async (args) => {
      if (args[1] === 'delete') throw new Error('HTTP 404: Not Found');
    });
    expect(missing).toStartWith('ok: ');
    const denied = await syncGithub(both, async (args) => {
      if (args[1] === 'delete') throw new Error('HTTP 403: Resource not accessible');
    });
    expect(denied).toBe('FAILED 1/5: BROKER_LOGIN_ONLY: HTTP 403: Resource not accessible');
  });

  it('logins off is carried out in full now that the workflow reads it', async () => {
    const s = clone(DEFAULT_SETTINGS);
    s.masters.logins = false;
    expect(await syncGithub(s, async () => {})).toStartWith('ok: BROKER_LOGIN_ENABLED=off');
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
      multiplier: 1,
      addon: true,
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

describe('multiplier, add-on and pause (BL-140 Phase 4)', () => {
  it('settings saved before Phase 4 mean 1, yes and no pause, and a first Save keeps them', () => {
    const old = clone(DEFAULT_SETTINGS) as unknown as {
      rows: Record<string, Record<string, unknown>>;
      pause?: unknown;
    };
    for (const row of Object.values(old.rows)) {
      row.multiplier = undefined;
      row.addon = undefined;
    }
    old.pause = undefined;
    const checked = validate(JSON.parse(JSON.stringify(old)));
    expect('settings' in checked && checked.settings).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.pause.until).toBeNull();
    expect(Object.values(DEFAULT_SETTINGS.rows).every((r) => r.multiplier === 1 && r.addon)).toBe(
      true,
    );
  });

  it('refuses a multiplier that is not a whole number from 1 to 10, a bad add-on or a bad day', () => {
    for (const bad of [0, 11, 1.5, -1, '3', null, true]) {
      const s = clone(DEFAULT_SETTINGS) as unknown as {
        rows: Record<string, Record<string, unknown>>;
      };
      (s.rows['quantiply.angelone'] as Record<string, unknown>).multiplier = bad;
      const checked = validate(s);
      expect('errors' in checked && checked.errors.join()).toContain(
        'quantiply.angelone.multiplier',
      );
    }
    const s = clone(DEFAULT_SETTINGS) as unknown as {
      rows: Record<string, Record<string, unknown>>;
    };
    (s.rows['algotest.finvasia'] as Record<string, unknown>).addon = 'no';
    expect('errors' in validate(s)).toBe(true);
    for (const until of ['tomorrow', '2026-13-40', '2026-02-30', 20261027, ''] as const) {
      const p = { ...clone(DEFAULT_SETTINGS), pause: { until } } as unknown;
      expect('errors' in validate(p)).toBe(true);
    }
    const extra = { ...clone(DEFAULT_SETTINGS), pause: { until: null, why: 'x' } } as unknown;
    expect('errors' in validate(extra)).toBe(true);
  });

  it('accepts the owner’s choices and gives them to the jobs through effective and pausedFor', () => {
    const s = clone(DEFAULT_SETTINGS);
    s.rows['quantiply.angelone'].multiplier = 3;
    s.rows['quantiply.angelone'].addon = false;
    s.pause = { until: '2026-10-27' };
    const checked = validate(s);
    if (!('settings' in checked)) throw new Error(checked.errors.join());
    expect(effective(checked.settings, 'quantiply.angelone')).toMatchObject({
      multiplier: 3,
      addon: false,
    });
    expect(pausedFor(checked.settings, '2026-10-27')).toBe('2026-10-27');
    expect(pausedFor(checked.settings, '2026-10-28')).toBeNull();
  });

  it('a version saved before Phase 4 comes back from the store with the defaults filled in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automation-v1-'));
    const store = new SettingsStore(
      join(dir, 'scheduler.db'),
      join(dir, 'automation-settings.json'),
    );
    const old = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as {
      rows: Record<string, Record<string, unknown>>;
      pause?: unknown;
    };
    for (const row of Object.values(old.rows)) {
      row.multiplier = undefined;
      row.addon = undefined;
    }
    old.pause = undefined;
    // a row as an older build stored it, straight into the table
    (store as unknown as { db: { query: (q: string) => { run: (...a: unknown[]) => void } } }).db
      .query('INSERT INTO automation_settings (saved_at, settings) VALUES (?, ?)')
      .run('2026-10-20T00:00:00Z', JSON.stringify(old));
    expect(store.current().settings).toEqual(DEFAULT_SETTINGS);
    store.writeSnapshot();
    const snapshot = JSON.parse(readFileSync(join(dir, 'automation-settings.json'), 'utf8'));
    expect(snapshot.pause).toEqual({ until: null });
    expect(snapshot.rows['quantiply.angelone'].multiplier).toBe(1);
    store.close();
  });
});
