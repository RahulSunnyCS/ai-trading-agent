// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../../hooks/usePolledResource';
import {
  type NotificationRow,
  isProblemType,
  levelOfRow,
  levelsBody,
  withLevel,
} from '../../../lib/scheduler';
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
  it('reads a level from an older scheduler, sets one and builds the PUT body (BL-173)', () => {
    expect(levelOfRow(rows[0] as NotificationRow)).toBe('all');
    expect(levelOfRow({ ...rows[0], enabled: false } as NotificationRow)).toBe('off');
    const next = withLevel(rows, 'options.daily', 'failures');
    expect(levelsBody(next)).toEqual({
      levels: { 'options.daily': 'failures', 'options.problem': 'all' },
    });
    expect(isProblemType('momentum.problem')).toBe(true);
    expect(isProblemType('options.daily')).toBe(false);
  });
});

/** The level buttons of one type's row. */
function levelButton(row: string, label: string) {
  const group = screen.getByRole('radiogroup', { name: `${row}: level` });
  return within(group).getByRole('radio', { name: label });
}

describe('SchedulerNotificationsCard', () => {
  it('saves a level and keeps it', async () => {
    const fetchMock = stub(() => ok(withLevel(rows, 'options.daily', 'failures')));
    render(<SchedulerNotificationsCard />);
    await screen.findByRole('radiogroup', { name: 'Options evening summary: level' });
    fireEvent.click(levelButton('Options evening summary', 'Failures only'));
    await waitFor(() =>
      expect(
        levelButton('Options evening summary', 'Failures only').getAttribute('aria-checked'),
      ).toBe('true'),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      levels: { 'options.daily': 'failures', 'options.problem': 'all' },
    });
  });

  it('rolls back and toasts when the save fails', async () => {
    stub(() => ok({ error: 'unknown notification types: x' }, 400));
    render(<SchedulerNotificationsCard />);
    await screen.findByRole('radiogroup', { name: 'Options evening summary: level' });
    fireEvent.click(levelButton('Options evening summary', 'Off'));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(levelButton('Options evening summary', 'On').getAttribute('aria-checked')).toBe('true');
    expect(useToastStore.getState().toasts[0]?.tone).toBe('error');
  });

  it('warns when a failure alert is switched off', async () => {
    stub(() => ok(withLevel(rows, 'options.problem', 'off')));
    render(<SchedulerNotificationsCard />);
    await screen.findByRole('radiogroup', { name: 'Options evening could not run: level' });
    fireEvent.click(levelButton('Options evening could not run', 'Off'));
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
