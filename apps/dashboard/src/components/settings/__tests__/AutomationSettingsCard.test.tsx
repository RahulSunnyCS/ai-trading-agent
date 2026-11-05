// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../../hooks/usePolledResource';
import {
  type AutomationSettings,
  type AutomationView,
  applyNowOpen,
  describeChanges,
  githubOutcome,
  heldByMaster,
  splitApplies,
  withDefaults,
  withMaster,
  withPause,
  withRow,
  withViewDefaults,
} from '../../../lib/automation';
import { useToastStore } from '../../ui/Toast';
import { AutomationSettingsCard } from '../AutomationSettingsCard';

const SETTINGS: AutomationSettings = {
  masters: { logins: true, uploads: true, deploy: false },
  rows: {
    'algotest.finvasia': {
      login: true,
      list: 't1',
      upload: true,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: null,
    },
    'algotest.angelone': {
      login: false,
      list: 'none',
      upload: false,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: null,
    },
    'quantiply.angelone': {
      login: true,
      list: 'core',
      upload: true,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: 8000,
    },
    'quantiply.finvasia': {
      login: false,
      list: 'none',
      upload: false,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: null,
    },
  },
  pause: { until: null },
  rules: [],
  capital: { finvasia: 850_000, angelone: 850_000 },
  margin: { bufferPct: 10, days: 6 },
  splitT1: false,
};

const view = (
  settings: AutomationSettings,
  version = 0,
  github: string | null = null,
): AutomationView => ({
  current: { version, saved_at: version ? '2026-10-19T12:00:00Z' : '', settings, github },
  effective: settings.rows,
  github: {},
  history: version ? [{ version, saved_at: '2026-10-19T12:00:00Z', settings, github }] : [],
});

const ok = (body: unknown, status = 200) => Response.json(body, { status });

function stub(put: (body: AutomationSettings) => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'PUT' ? put(JSON.parse(String(init.body))) : ok(view(SETTINGS)),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearPolledResourceCache();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('automation helpers', () => {
  it('describes each change in plain words', () => {
    const after = withRow(withMaster(SETTINGS, 'logins', false), 'quantiply.angelone', {
      list: 't1',
    });
    expect(describeChanges(SETTINGS, after)).toEqual([
      'Automated logins: on → off',
      'Quantiply · Angel One list: Adaptive Classic → Adaptive Tuned',
    ]);
    expect(describeChanges(SETTINGS, SETTINGS)).toEqual([]);
  });

  it('choosing no list turns that row’s upload off', () => {
    const after = withRow(SETTINGS, 'algotest.finvasia', { list: 'none' });
    expect(after.rows['algotest.finvasia']).toEqual({
      login: true,
      list: 'none',
      upload: false,
      multiplier: 1,
      addon: true,
      dirBoost: false,
      mtmSl: null,
    });
  });

  it('the T1 split applies only with both AlgoTest rows uploading T1 (BL-209)', () => {
    const both = withRow({ ...SETTINGS, splitT1: true }, 'algotest.angelone', {
      list: 't1',
      upload: true,
    });
    expect(splitApplies(both)).toBe(true);
    expect(splitApplies({ ...both, splitT1: false })).toBe(false);
    expect(splitApplies({ ...SETTINGS, splitT1: true })).toBe(false);
    expect(splitApplies(withMaster(both, 'uploads', false))).toBe(false);
    const old = { ...SETTINGS } as Partial<AutomationSettings>;
    delete old.splitT1;
    expect(withDefaults(old as AutomationSettings).splitT1).toBe(false);
  });

  it('says when a master switch holds a row back', () => {
    expect(heldByMaster(SETTINGS, 'algotest.finvasia')).toBeNull();
    const off = withMaster(withMaster(SETTINGS, 'logins', false), 'uploads', false);
    expect(heldByMaster(off, 'algotest.finvasia')).toBe(
      'login and upload held off by the master switch',
    );
  });

  it('reads the GitHub sync outcome', () => {
    expect(githubOutcome(null)).toBeNull();
    expect(githubOutcome('ok: X=on')).toEqual({ text: 'GitHub backstop updated', failed: false });
    expect(githubOutcome('FAILED 1/5: QUANTIPLY_LOGIN: HTTP 403')?.failed).toBe(true);
    expect(githubOutcome('PARTIAL: logins off: not yet')).toEqual({
      text: 'GitHub backstop partly updated: logins off: not yet',
      failed: true,
    });
  });
});

describe('MTM SL (BL-172)', () => {
  it('describes a change in rupees, and off as not managed', () => {
    const after = withRow(
      withRow(SETTINGS, 'quantiply.angelone', { mtmSl: 7500 }),
      'quantiply.finvasia',
      { mtmSl: 9000 },
    );
    expect(describeChanges(SETTINGS, after)).toEqual([
      'Quantiply · Angel One MTM SL: ₹8,000 → ₹7,500',
      'Quantiply · Shoonya MTM SL: not managed → ₹9,000',
    ]);
  });

  it('settings from an older scheduler read as the list stop on Quantiply rows only', () => {
    const old = structuredClone(SETTINGS) as unknown as {
      rows: Record<string, Record<string, unknown>>;
    };
    for (const row of Object.values(old.rows)) row.mtmSl = undefined;
    (old.rows['quantiply.finvasia'] as Record<string, unknown>).list = 't1';
    const read = withDefaults(old as unknown as AutomationSettings);
    expect(read.rows['quantiply.angelone'].mtmSl).toBe(8000);
    expect(read.rows['quantiply.finvasia'].mtmSl).toBe(9000);
    expect(read.rows['algotest.finvasia'].mtmSl).toBeNull();
  });
});

describe('multiplier, add-on and pause', () => {
  it('describes each change in plain words', () => {
    const after = withPause(
      withRow(SETTINGS, 'quantiply.angelone', { multiplier: 3, addon: false }),
      '2026-10-27',
    );
    expect(describeChanges(SETTINGS, after)).toEqual([
      'Quantiply · Angel One multiplier: 1 → 3',
      'Quantiply · Angel One Buy add-on: on → off',
      'Pause: none → until 2026-10-27',
    ]);
    expect(describeChanges(after, SETTINGS).at(-1)).toBe('Pause: until 2026-10-27 → none');
  });

  it('settings from a scheduler that predates them mean 1, yes and no pause', () => {
    const old = JSON.parse(JSON.stringify(SETTINGS)) as Record<string, unknown>;
    delete old.pause;
    delete old.capital;
    delete old.margin;
    for (const row of Object.values(old.rows as Record<string, Record<string, unknown>>)) {
      row.multiplier = undefined;
      row.addon = undefined;
    }
    expect(withDefaults(old as unknown as AutomationSettings)).toEqual(SETTINGS);
    const v = withViewDefaults({
      ...view(old as unknown as AutomationSettings, 3),
    });
    expect(v.current.settings).toEqual(SETTINGS);
    expect(v.history[0]?.settings).toEqual(SETTINGS);
  });
});

describe('AutomationSettingsCard', () => {
  it('saves a multiplier, the add-on and a pause with Save, and lists them first', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? ok({ ...view(JSON.parse(String(init.body)), 1), next_session: '2026-10-23' })
        : ok({ ...view(SETTINGS), next_session: '2026-10-23' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AutomationSettingsCard />);
    const field = await screen.findAllByRole('spinbutton');
    fireEvent.change(field[2] as HTMLElement, { target: { value: '3' } }); // Quantiply · Angel One
    fireEvent.click(screen.getAllByLabelText('Include the Buy add-on')[2] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /Skip next session/ }));
    expect(await screen.findByText('Quantiply · Angel One multiplier: 1 → 3')).toBeTruthy();
    expect(screen.getByText('Quantiply · Angel One Buy add-on: on → off')).toBeTruthy();
    expect(screen.getByText('Pause: none → until 2026-10-23')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const body = JSON.parse(String(put?.[1]?.body)) as AutomationSettings;
    expect(body.rows['quantiply.angelone']).toMatchObject({ multiplier: 3, addon: false });
    expect(body.pause).toEqual({ until: '2026-10-23' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear pause' }));
    expect(await screen.findByText('Pause: until 2026-10-23 → none')).toBeTruthy();
  });

  it('saves Dir ×2 on non-expiry days (BL-183) per row', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? ok({ ...view(JSON.parse(String(init.body)), 1), next_session: '2026-10-29' })
        : ok({ ...view(SETTINGS), next_session: '2026-10-29' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AutomationSettingsCard />);
    const toggles = await screen.findAllByLabelText('Dir ×2 on non-expiry days');
    fireEvent.click(toggles[2] as HTMLElement); // Quantiply · Angel One
    expect(await screen.findByText('Quantiply · Angel One Dir ×2: off → on')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const body = JSON.parse(String(put?.[1]?.body)) as AutomationSettings;
    expect(body.rows['quantiply.angelone'].dirBoost).toBe(true);
    expect(body.rows['algotest.finvasia'].dirBoost).toBe(false);
  });

  it('saves each account’s capital and shows the total', async () => {
    const fetchMock = stub((body) => ok(view(body, 1)));
    render(<AutomationSettingsCard />);
    expect(await screen.findByText(/now ₹17,00,000/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Angel One/), { target: { value: '1000000' } });
    expect(await screen.findByText('Angel One capital: ₹8,50,000 → ₹10,00,000')).toBeTruthy();
    expect(screen.getByText(/now ₹18,50,000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).capital).toEqual({
      finvasia: 850_000,
      angelone: 1_000_000,
    });
  });

  it('saves the margin check’s buffer and look-back', async () => {
    const fetchMock = stub((body) => ok(view(body, 1)));
    render(<AutomationSettingsCard />);
    fireEvent.change(await screen.findByLabelText(/^Buffer/), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/^Days of each type/), { target: { value: '10' } });
    expect(await screen.findByText('Margin buffer: 10% → 5%')).toBeTruthy();
    expect(screen.getByText('Margin look-back: 6 → 10 days of a type')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).margin).toEqual({ bufferPct: 5, days: 10 });
  });

  it('saves the T1 split switch (BL-209) and says when it changes nothing', async () => {
    const fetchMock = stub((body) => ok(view(body, 1)));
    render(<AutomationSettingsCard />);
    const toggle = await screen.findByLabelText('Split T1 across the AlgoTest accounts');
    expect(screen.getByText('Off: each AlgoTest account trades every T1 pick.')).toBeTruthy();
    fireEvent.click(toggle);
    expect(await screen.findByText('T1 split across the AlgoTest accounts: off → on')).toBeTruthy();
    // Angel One's AlgoTest row does not upload T1 in the fixture
    expect(
      screen.getByText('On, but it changes nothing until both AlgoTest rows upload T1.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).splitT1).toBe(true);
  });

  it('works against a scheduler that does not send the new fields yet', async () => {
    const old = JSON.parse(JSON.stringify(SETTINGS)) as Record<string, unknown>;
    delete old.pause;
    delete old.capital;
    delete old.margin;
    for (const row of Object.values(old.rows as Record<string, Record<string, unknown>>)) {
      row.multiplier = undefined;
      row.addon = undefined;
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(view(old as unknown as AutomationSettings))),
    );
    render(<AutomationSettingsCard />);
    // four multipliers, the MTM SL of the one Quantiply row with a list (BL-172 default), the
    // two accounts' capital (₹8.5 lakh each by default) and the margin check's two (10%, 6 days)
    expect(await screen.findAllByRole('spinbutton')).toHaveLength(9);
    expect((screen.getByLabelText(/^Shoonya/) as HTMLInputElement).value).toBe('850000');
    expect((screen.getByLabelText(/^Buffer/) as HTMLInputElement).value).toBe('10');
    expect(screen.queryByRole('button', { name: /Skip next session/ })).toBeNull();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it('saves the draft only on Save, with the change listed first', async () => {
    const fetchMock = stub((body) => ok(view(body, 1, 'ok: BROKER_LOGIN_ENABLED=off')));
    render(<AutomationSettingsCard />);
    const logins = await screen.findByLabelText('Automated logins');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    fireEvent.click(logins);
    expect(await screen.findByText('Automated logins: on → off')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).masters.logins).toBe(false);
    expect(useToastStore.getState().toasts[0]?.message).toBe(
      'Saved as version 1. GitHub backstop updated.',
    );
    expect(screen.queryByText('Automated logins: on → off')).toBeNull();
  });

  it('keeps the draft and toasts when the scheduler refuses', async () => {
    stub(() => ok({ error: 'invalid settings' }, 400));
    render(<AutomationSettingsCard />);
    fireEvent.click(await screen.findByLabelText('Automated uploads'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]?.tone).toBe('error');
    expect(screen.getByText('Automated uploads: on → off')).toBeTruthy();
  });

  it('Discard puts the saved settings back', async () => {
    stub(() => ok(view(SETTINGS)));
    render(<AutomationSettingsCard />);
    fireEvent.click(await screen.findByLabelText('Automated deployment'));
    expect(screen.getByText('Automated deployment: off → on')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByText('Automated deployment: off → on')).toBeNull();
  });

  it('Apply now opens only after 15:30 IST', () => {
    expect(applyNowOpen(new Date('2026-10-19T09:59:00Z'))).toBe(false); // 15:29 IST
    expect(applyNowOpen(new Date('2026-10-19T10:00:00Z'))).toBe(true);
  });

  it("Apply now starts that platform's evening upload", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-19T11:00:00Z') }); // 16:30 IST
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? ok({ runId: 7, job: 'quantiply-evening' }, 202)
        : ok(view(SETTINGS)),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AutomationSettingsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply now: Quantiply' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/scheduler/jobs/quantiply-evening/run');
    vi.useRealTimers();
  });

  it('says so when the scheduler is not reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ error: 'down' }, 502)),
    );
    render(<AutomationSettingsCard />);
    expect(await screen.findByText('Scheduler not reachable')).toBeTruthy();
  });
});

describe('Advanced rules (BL-211)', () => {
  const DAY_TYPES = {
    today: {
      day: '2026-11-05',
      weekday: 'Thu',
      dte: { NIFTY: '2', SENSEX: '0' },
      source: 'master',
    },
    tomorrow: {
      day: '2026-11-06',
      weekday: 'Fri',
      dte: { NIFTY: '1', SENSEX: '4' },
      source: 'master',
    },
    errors: [],
  };
  function stubWithDays(put?: (body: AutomationSettings) => Response) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/rotation/day-type')) return ok(DAY_TYPES);
      if (init?.method === 'PUT')
        return put ? put(JSON.parse(String(init.body))) : ok(view(SETTINGS, 1));
      return ok({ ...view(SETTINGS), next_session: '2026-11-06' });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('starts closed with no rules, adds one, and previews today and tomorrow', async () => {
    stubWithDays();
    render(<AutomationSettingsCard />);
    expect(await screen.findByText('0 rules')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Advanced rules/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add a rule/ }));
    expect(
      await screen.findByText('Rule added: AlgoTest · Shoonya on SENSEX 0 DTE → Adaptive Classic'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'On a day SENSEX has 0 weekdays to expiry, AlgoTest · Shoonya trades Adaptive Classic instead of its own list (Adaptive Tuned).',
      ),
    ).toBeTruthy();
    // SENSEX expires today (Thu) and not tomorrow: the rule decides today's AlgoTest · Shoonya
    const today = await screen.findByText(/Today · Thu/);
    const list = today.closest('div') as HTMLElement;
    expect(list.textContent).toContain('Adaptive Classic');
    expect(list.textContent).toContain('rule 1');
    const tomorrow = screen.getByText(/Tomorrow · Fri/).closest('div') as HTMLElement;
    expect(tomorrow.textContent).not.toContain('rule 1');
  });

  it('saves the rules with the settings', async () => {
    const fetchMock = stubWithDays((body) => ok(view(body, 1)));
    render(<AutomationSettingsCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Advanced rules/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add a rule/ }));
    fireEvent.change(screen.getByLabelText('Rule 1 account'), {
      target: { value: 'quantiply.angelone' },
    });
    fireEvent.change(screen.getByLabelText('Rule 1 condition'), { target: { value: 'weekday' } });
    fireEvent.change(screen.getByLabelText('Rule 1 weekday'), { target: { value: 'Thu' } });
    fireEvent.change(screen.getByLabelText('Rule 1 list'), { target: { value: 'none' } });
    fireEvent.change(screen.getByLabelText('Rule 1 note'), {
      target: { value: 'no Quantiply on Thursdays' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).rules).toEqual([
      {
        row: 'quantiply.angelone',
        when: { kind: 'weekday', weekday: 'Thu' },
        list: 'none',
        note: 'no Quantiply on Thursdays',
      },
    ]);
  });

  it('says a rule can never apply and does not allow the save', async () => {
    const fetchMock = stubWithDays();
    render(<AutomationSettingsCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Advanced rules/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add a rule/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add a rule/ }));
    expect(
      await screen.findByText(
        'Rule 2 can never apply: rule 1 tests the same thing on the same row and is tried first.',
      ),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 2' }));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('opens with the rules showing when there are some', async () => {
    const rule = {
      row: 'algotest.finvasia',
      when: { kind: 'dte', index: 'SENSEX', dte: '0' },
      list: 'core',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/rotation/day-type')
          ? ok(DAY_TYPES)
          : ok(view({ ...SETTINGS, rules: [rule] } as AutomationSettings, 4)),
      ),
    );
    render(<AutomationSettingsCard />);
    expect(await screen.findByText('1 rule')).toBeTruthy();
    expect(await screen.findByLabelText('Rule 1 account')).toBeTruthy();
  });
});
