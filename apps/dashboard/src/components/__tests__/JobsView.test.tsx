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

  it('shows a chain’s steps and resumes it with the steps that passed left alone (BL-234)', async () => {
    const chain = {
      ...job('close-out', []),
      chain: ['live-capture', 'quantiply-disable'],
      lastRun: {
        id: 41,
        job: 'close-out',
        trigger: 'schedule',
        scheduled_for: null,
        started_at: '2026-11-18T10:00:00Z',
        ended_at: '2026-11-18T10:20:00Z',
        exit_code: 1,
        attempts: 1,
        error: 'live-capture: exit 1',
      },
    };
    const step = (id: number, name: string, status: string, error: string | null) => ({
      id,
      run_id: 41,
      step: name,
      status,
      started_at: '2026-11-18T10:00:00Z',
      ended_at: '2026-11-18T10:05:00Z',
      exit_code: status === 'ok' ? 0 : 1,
      attempts: 1,
      error,
      carried_from: null,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return ok({ runId: 42 }, 202);
      if (String(url).endsWith('/runs/41/steps'))
        return ok([
          step(1, 'live-capture', 'failed', 'exit 1'),
          step(2, 'quantiply-disable', 'ok', null),
        ]);
      if (String(url).includes('/log')) return ok({ run: 41, path: 'x', lines: 200, text: 'log' });
      return ok([chain]);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<JobsView />);
    fireEvent.click(await screen.findByText('close-out'));
    expect(await screen.findByText('Steps: close-out')).toBeTruthy();
    // the job's own last-run badge and the failed step's both say Failed
    expect((await screen.findAllByText('Failed')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Passed')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Resume close-out'));
    expect(await screen.findByText('Resume close-out?')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Resume').at(-1) as HTMLElement);
    await waitFor(() =>
      expect(posted(fetchMock as unknown as ReturnType<typeof stub>)).toHaveLength(1),
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(post?.[0])).toBe('/api/scheduler/jobs/close-out/run');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ resume: true });
  });
});
