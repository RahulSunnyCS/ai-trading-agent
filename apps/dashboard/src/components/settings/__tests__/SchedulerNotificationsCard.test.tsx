// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../../hooks/usePolledResource';
import { disabledTypes, isProblemType, withEnabled } from '../../../lib/scheduler';
import { useToastStore } from '../../ui/Toast';
import { SchedulerNotificationsCard } from '../SchedulerNotificationsCard';

const rows = [
  { type: 'options.daily', description: 'Options evening summary', enabled: true },
  { type: 'options.problem', description: 'Options evening could not run', enabled: true },
];

const ok = (body: unknown, status = 200) => Response.json(body, { status });

function stub(put: () => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'PUT' ? put() : ok(rows),
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

describe('notification helpers', () => {
  it('lists the switched-off types and finds failure alerts', () => {
    const off = withEnabled(rows, 'options.problem', false);
    expect(disabledTypes(off)).toEqual(['options.problem']);
    expect(disabledTypes(rows)).toEqual([]);
    expect(isProblemType('momentum.problem')).toBe(true);
    expect(isProblemType('options.daily')).toBe(false);
  });
});

describe('SchedulerNotificationsCard', () => {
  it('saves the disabled list and keeps the switch off', async () => {
    const fetchMock = stub(() => ok(withEnabled(rows, 'options.daily', false)));
    render(<SchedulerNotificationsCard />);
    const toggle = await screen.findByLabelText('Options evening summary');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ disabled: ['options.daily'] });
  });

  it('rolls back and toasts when the save fails', async () => {
    stub(() => ok({ error: 'unknown notification types: x' }, 400));
    render(<SchedulerNotificationsCard />);
    const toggle = await screen.findByLabelText('Options evening summary');
    fireEvent.click(toggle);
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(useToastStore.getState().toasts[0]?.tone).toBe('error');
  });

  it('warns when a failure alert is switched off', async () => {
    stub(() => ok(withEnabled(rows, 'options.problem', false)));
    render(<SchedulerNotificationsCard />);
    fireEvent.click(await screen.findByLabelText('Options evening could not run'));
    expect(await screen.findByText(/you will not hear about it/)).toBeTruthy();
  });

  it('says so when the scheduler is not reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ error: 'not found' }, 404)),
    );
    render(<SchedulerNotificationsCard />);
    expect(await screen.findByText('Scheduler not reachable')).toBeTruthy();
  });
});
