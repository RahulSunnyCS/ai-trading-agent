// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../../hooks/usePolledResource';
import {
  type AutomationSettings,
  type AutomationView,
  describeChanges,
  githubOutcome,
  heldByMaster,
  withMaster,
  withRow,
} from '../../../lib/automation';
import { useToastStore } from '../../ui/Toast';
import { AutomationSettingsCard } from '../AutomationSettingsCard';

const SETTINGS: AutomationSettings = {
  masters: { logins: true, uploads: true, deploy: false },
  rows: {
    'algotest.finvasia': { login: true, list: 't1', upload: true },
    'algotest.angelone': { login: true, list: 'none', upload: false },
    'quantiply.angelone': { login: true, list: 'core', upload: true },
    'quantiply.finvasia': { login: false, list: 'none', upload: false },
  },
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
    expect(after.rows['algotest.finvasia']).toEqual({ login: true, list: 'none', upload: false });
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
  });
});

describe('AutomationSettingsCard', () => {
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

  it("Apply now starts that platform's evening upload", async () => {
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
