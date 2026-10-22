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
    'algotest.finvasia': { login: true, list: 't1', upload: true, multiplier: 1, addon: true },
    'algotest.angelone': { login: false, list: 'none', upload: false, multiplier: 1, addon: true },
    'quantiply.angelone': { login: true, list: 'core', upload: true, multiplier: 1, addon: true },
    'quantiply.finvasia': { login: false, list: 'none', upload: false, multiplier: 1, addon: true },
  },
  pause: { until: null },
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
    });
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

  it('works against a scheduler that does not send the new fields yet', async () => {
    const old = JSON.parse(JSON.stringify(SETTINGS)) as Record<string, unknown>;
    delete old.pause;
    for (const row of Object.values(old.rows as Record<string, Record<string, unknown>>)) {
      row.multiplier = undefined;
      row.addon = undefined;
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(view(old as unknown as AutomationSettings))),
    );
    render(<AutomationSettingsCard />);
    expect(await screen.findAllByRole('spinbutton')).toHaveLength(4);
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
