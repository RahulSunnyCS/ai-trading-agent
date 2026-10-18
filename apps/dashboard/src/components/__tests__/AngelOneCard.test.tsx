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
  running_source: null,
  cooldown_s: 60,
  retry_after_s: 0,
  cooldown_until: null,
  hold: null,
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

/** A cool-down that ends a minute from now, as the server would send it. */
const inAMinute = () => new Date(Date.now() + 60_000).toISOString();

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
    expect(screen.getByText('ANGELONE_MPIN')).toBeTruthy();
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

  it('starts a test, then shows the refused login the status reports and the hold', async () => {
    const started = new Date().toISOString();
    let after = status();
    const fetchMock = stub((_url, init) => {
      if (init?.method === 'POST') {
        after = status({
          last_check: check({
            source: 'manual',
            ok: false,
            reason: 'rejected',
            message: 'Angel One login failed: AB1050 Invalid totp',
            checked_at: started,
          }),
          cooldown_until: inAMinute(),
          hold: {
            until: new Date(Date.now() + 900_000).toISOString(),
            message:
              'Angel One refused the login. Fix the ANGELONE_* settings in .env to test sooner.',
          },
        });
        return json({ status: 'started', started_at: started }, 202);
      }
      return json(after);
    });
    render(<AngelOneCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Test connection/ }));
    expect(await screen.findByText('Angel One login failed: AB1050 Invalid totp')).toBeTruthy();
    expect(screen.getByText(/Fix the ANGELONE_\* settings/)).toBeTruthy();
    expect(posts(fetchMock)).toHaveLength(1);
    expect(String(posts(fetchMock)[0]?.[0])).toBe('/api/backtest/legwise/angel/test');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /Wait \d+ s/ }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it('keeps asking for the status until the background check lands', async () => {
    const started = new Date().toISOString();
    let posted = false;
    let reads = 0;
    stub((_url, init) => {
      if (init?.method === 'POST') {
        posted = true;
        return json({ status: 'started', started_at: started }, 202);
      }
      if (!posted) return json(status());
      reads += 1;
      // the first read after the click finds the check still running
      return reads < 2
        ? json(status({ running: true, running_source: 'manual' }))
        : json(status({ last_check: check({ source: 'manual', checked_at: started }) }));
    });
    render(<AngelOneCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Test connection/ }));
    expect(await screen.findByRole('button', { name: /Testing/ })).toBeTruthy();
    expect(await screen.findByText('Login works', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(/Test connection ·/)).toBeTruthy();
    expect(reads).toBeGreaterThanOrEqual(2);
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

  it('disables the button while the evening collection holds the login', async () => {
    stub(() => json(status({ running: true, running_source: 'collector' })));
    render(<AngelOneCard />);
    const button = await screen.findByRole('button', { name: /Collection running/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('holds the button after a refused login', async () => {
    stub(() =>
      json(
        status({
          last_check: check({ ok: false, reason: 'rejected', message: 'refused' }),
          hold: {
            until: new Date(Date.now() + 600_000).toISOString(),
            message: 'Angel One refused the login at 08:00 IST.',
          },
        }),
      ),
    );
    render(<AngelOneCard />);
    const button = await screen.findByRole('button', { name: /Held until/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Angel One refused the login at 08:00 IST.')).toBeTruthy();
  });
});
