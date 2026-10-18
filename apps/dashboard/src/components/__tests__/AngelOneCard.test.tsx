// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../hooks/usePolledResource';
import type { AngelCheck, AngelStatus } from '../../lib/angelOne';
import { AngelOneCard } from '../AngelOneCard';

const credentials = [
  { name: 'ANGELONE_API_KEY', set: true, required: true },
  { name: 'ANGELONE_CLIENT_CODE', set: true, required: true },
  { name: 'ANGELONE_MPIN', set: true, required: true },
  { name: 'ANGELONE_TOTP_SECRET', set: true, required: true },
  { name: 'ANGELONE_PUBLIC_IP', set: false, required: false },
];

const status = (over: Partial<AngelStatus> = {}): AngelStatus => ({
  configured: true,
  credentials,
  client: 'R1•••56',
  last_check: null,
  last_collection: null,
  running: false,
  cooldown_s: 60,
  retry_after_s: 0,
  warning: null,
  ...over,
});

const check = (over: Partial<AngelCheck> = {}): AngelCheck => ({
  checked_at: '2026-10-18T08:00:03+05:30',
  source: 'scheduled',
  ok: true,
  reason: 'ok',
  message: 'Logged in to Angel One SmartAPI.',
  client: 'R1•••56',
  duration_ms: 1200,
  attempted: true,
  ...over,
});

const json = (body: unknown, code = 200) => Response.json(body, { status: code });

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(clearPolledResourceCache);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AngelOneCard', () => {
  it('names the missing settings and offers no test when not configured', async () => {
    stub(() =>
      json(
        status({
          configured: false,
          client: null,
          credentials: credentials.map((c) =>
            c.name === 'ANGELONE_MPIN' ? { ...c, set: false } : c,
          ),
        }),
      ),
    );
    render(<AngelOneCard />);
    expect(await screen.findByText('Not configured')).toBeTruthy();
    expect(screen.getAllByText('ANGELONE_MPIN').length).toBeGreaterThan(0);
    expect(screen.getByText('missing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Test connection/ })).toBeNull();
  });

  it('shows the last check, the masked client and the last Angel One collection', async () => {
    stub(() =>
      json(
        status({
          last_check: check(),
          last_collection: {
            trading_day: '2026-10-16',
            started_at: '2026-10-16T15:50:00+05:30',
            status: 'ok',
          },
        }),
      ),
    );
    render(<AngelOneCard />);
    expect(await screen.findByText('Login works')).toBeTruthy();
    expect(screen.getByText('R1•••56')).toBeTruthy();
    expect(screen.getByText(/08:00 check/)).toBeTruthy();
    expect(screen.getByText(/16 Oct 2026/)).toBeTruthy();
  });

  it('runs one test and shows a refused login inline', async () => {
    let after = status();
    const fetchMock = stub((_url, init) => {
      if (init?.method === 'POST') {
        const result = check({
          source: 'manual',
          ok: false,
          reason: 'rejected',
          message: 'Angel One login failed: AB1050 Invalid totp',
          checked_at: '2026-10-18T10:00:00+05:30',
        });
        after = status({ last_check: result, retry_after_s: 60 });
        return json({ result });
      }
      return json(after);
    });
    render(<AngelOneCard />);
    const button = await screen.findByRole('button', { name: /Test connection/ });
    fireEvent.click(button);
    expect(await screen.findByText('Angel One login failed: AB1050 Invalid totp')).toBeTruthy();
    expect(posts(fetchMock)).toHaveLength(1);
    expect(String(posts(fetchMock)[0]?.[0])).toBe('/api/backtest/legwise/angel/test');
    // the cool-down from the refreshed status disables the button
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /Wait \d+ s/ }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it('shows the server refusal when a test is already running', async () => {
    stub((_url, init) =>
      init?.method === 'POST'
        ? json({ error: 'An Angel One connection test is already running.' }, 409)
        : json(status()),
    );
    render(<AngelOneCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Test connection/ }));
    expect(
      await screen.findByText('An Angel One connection test is already running.'),
    ).toBeTruthy();
  });

  it('disables the button while a check runs elsewhere', async () => {
    stub(() => json(status({ running: true })));
    render(<AngelOneCard />);
    const button = await screen.findByRole('button', { name: /Testing/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
