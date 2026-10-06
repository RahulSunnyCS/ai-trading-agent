// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../hooks/usePolledResource';
import { JobsView } from '../JobsView';

const job = (id: string, needs: string[]) => ({
  id,
  description: `${id} job`,
  schedule: 'Daily 17:00 IST',
  nextRun: '2026-10-08T11:30:00.000Z',
  lastRun: null,
  needs,
  group: null,
});

const ok = (body: unknown, status = 200) => Response.json(body, { status });

function stub(handler: (init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => handler(init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posted = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(clearPolledResourceCache);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('JobsView', () => {
  it('says the scheduler is not reachable when the API is down', async () => {
    stub(() => ok({ error: 'not found' }, 404));
    render(<JobsView />);
    expect(await screen.findByText('Scheduler not reachable')).toBeTruthy();
  });

  it('runs a plain job at once', async () => {
    const fetchMock = stub((init) =>
      init?.method === 'POST' ? ok({ runId: 9 }, 202) : ok([job('backup', ['postgres'])]),
    );
    render(<JobsView />);
    fireEvent.click(await screen.findByLabelText('Run backup now'));
    await waitFor(() => expect(posted(fetchMock)).toHaveLength(1));
    expect(String(posted(fetchMock)[0]?.[0])).toBe('/api/scheduler/jobs/backup/run');
  });

  it('asks first for a job that needs home', async () => {
    const fetchMock = stub((init) =>
      init?.method === 'POST' ? ok({ runId: 3 }, 202) : ok([job('fetch', ['home'])]),
    );
    render(<JobsView />);
    fireEvent.click(await screen.findByLabelText('Run fetch now'));
    expect(await screen.findByText('Run fetch now?')).toBeTruthy();
    expect(posted(fetchMock)).toHaveLength(0);
    fireEvent.click(screen.getAllByText('Run now').at(-1) as HTMLElement);
    await waitFor(() => expect(posted(fetchMock)).toHaveLength(1));
  });
});
