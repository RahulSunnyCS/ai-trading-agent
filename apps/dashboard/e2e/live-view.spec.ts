/**
 * E2E tests for the Live page (/live, BL-117 Phase 3).
 *
 * Until live capture exists the page replays a day the evening run collected, read from
 * `/api/backtest/legwise/live/days` and `/live/session` (live/session.py). These tests verify:
 *  - The page loads a replay: the Replay badge and banner, the controls (index, day, playback)
 *    and the charts, with the headline figures from the session
 *  - Switching the index never shows the previous index's figures while the next one loads
 *    (the fetch hook keeps the last response; the page shows only one that matches its controls)
 *  - Picking a day keeps the day control on the chosen day while that day loads
 *  - A session that cannot be loaded shows an error, not a blank page
 *
 * Both routes are mocked with page.route(), so no research API is needed; only the Next dev
 * server (http://localhost:5173) must be up.
 *
 * Required env vars: none — all data is mocked via route interception.
 */

import { type Page, type Route, expect, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Epoch seconds of 09:15 IST on a YYYY-MM-DD day, then one minute apart. */
function minutes(day: string, n: number): number[] {
  const open = Date.parse(`${day}T03:45:00Z`) / 1000;
  return Array.from({ length: n }, (_, i) => open + i * 60);
}

/** A four-minute session; `spot` is the index level it starts from. */
function session(underlying: 'NIFTY' | 'SENSEX', day: string, spot: number) {
  const closes = [spot, spot + 20, spot + 60, spot + 80];
  const step = underlying === 'NIFTY' ? 50 : 100;
  return {
    underlying,
    day,
    source: { kind: 'replay', note: 'A collected session, played back from the lake.' },
    live: {
      available: false,
      reason: 'No live feed is running, so the page replays a session the evening run collected.',
    },
    expiry: '2026-10-20',
    dte_weekdays: 2,
    strike_step: step,
    last_minute: 3,
    minutes: minutes(day, 4),
    spot: {
      open: spot,
      close: closes,
      high: closes.map((c) => c + 2),
      low: closes.map((c) => c - 2),
    },
    vix: [14, 14.1, 14.2, 14.3],
    atm: closes.map((c) => Math.round(c / step) * step),
    rolling: { ce: [100, 101, null, 98], pe: [90, 89, null, 95], straddle: [190, 190, null, 193] },
    fixed: {
      strike: Math.round(spot / step) * step,
      ce: [100, 101, 102, 103],
      pe: [90, 89, 88, 87],
      straddle: [190, 190, 190, 190],
      open_value: 190,
    },
    range: { median_sessions: 20, median_full_session: 200, full_session: 84 },
    notes: [],
  };
}

const DAYS = ['2026-10-16', '2026-10-15'];
const SPOT = { NIFTY: 25000, SENSEX: 82000 } as const;

/**
 * Mock the two Live routes and open /live. `hold(url)` may return a promise to delay one
 * session response (to look at the page while it loads); `failSession` answers every session
 * request with an error.
 */
async function openLive(
  page: Page,
  {
    hold = () => null,
    failSession = false,
  }: { hold?: (url: URL) => Promise<void> | null; failSession?: boolean } = {},
) {
  await page.route(
    (url) => url.pathname === '/api/backtest/legwise/live/days',
    (route) => {
      const underlying = new URL(route.request().url()).searchParams.get('underlying');
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ underlying, days: DAYS }),
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/backtest/legwise/live/session',
    async (route: Route) => {
      const url = new URL(route.request().url());
      if (failSession) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'no collected NIFTY days' }),
        });
        return;
      }
      await hold(url);
      const underlying = url.searchParams.get('underlying') === 'SENSEX' ? 'SENSEX' : 'NIFTY';
      const day = url.searchParams.get('day') ?? DAYS[0];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session(underlying, day, SPOT[underlying])),
      });
    },
  );
  await page.goto('/live');
}

function main(page: Page) {
  return page.getByRole('main');
}

// ---------------------------------------------------------------------------
// 1. The replay loads with its controls and charts — @critical
// ---------------------------------------------------------------------------

test('The Live page replays a collected day with its controls and charts @critical', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await openLive(page);

  // It says plainly that this is a replay, not a live feed.
  await expect(main(page).getByText('Replay', { exact: true })).toBeVisible();
  await expect(main(page).getByText('Replay of Fri 16 Oct 2026.')).toBeVisible();
  await expect(main(page)).toContainText('No live feed is running');

  // Controls: index, day, playback.
  const index = page.getByRole('radiogroup', { name: 'Index' });
  await expect(index.getByRole('radio', { name: 'NIFTY' })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Day to replay' })).toHaveValue('2026-10-16');
  await expect(page.getByRole('button', { name: 'Play the day from here' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Minute of the day shown' })).toBeVisible();

  // Headline figures come from the session (the day opens at its end: minute 3).
  await expect(main(page).getByText('NIFTY spot')).toBeVisible();
  await expect(main(page).getByText('25,080.00')).toBeVisible();

  // The three charts render.
  await expect(page.getByRole('img', { name: /NIFTY spot minute by minute/ })).toBeVisible();
  await expect(
    page.getByRole('img', { name: /Call plus put premium minute by minute/ }),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: /India VIX minute by minute/ })).toBeVisible();

  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 2. A new index never shows the previous index's figures — @critical
// ---------------------------------------------------------------------------

test('Switching the index shows no figures of the previous index while the next one loads @critical', async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openLive(page, {
    hold: (url) => (url.searchParams.get('underlying') === 'SENSEX' ? held : null),
  });
  await expect(main(page).getByText('25,080.00')).toBeVisible();

  await page
    .getByRole('radiogroup', { name: 'Index' })
    .getByRole('radio', { name: 'SENSEX' })
    .click();
  await expect(page).toHaveURL(/ix=SENSEX/);
  // SENSEX has not answered yet: NIFTY's figures are gone, not shown under the SENSEX control.
  await expect(main(page).getByText('25,080.00')).toHaveCount(0);
  await expect(main(page).getByText('NIFTY spot')).toHaveCount(0);

  release();
  await expect(main(page).getByText('SENSEX spot')).toBeVisible();
  await expect(main(page).getByText('82,080.00')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. The day control keeps the chosen day while it loads — @non-blocker
// ---------------------------------------------------------------------------

test('Picking a day keeps the day control on that day while it loads @non-blocker', async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openLive(page, {
    hold: (url) => (url.searchParams.get('day') === '2026-10-15' ? held : null),
  });
  const day = page.getByRole('combobox', { name: 'Day to replay' });
  await expect(day).toHaveValue('2026-10-16');

  await day.selectOption('2026-10-15');
  await expect(page).toHaveURL(/d=2026-10-15/);
  // Still loading: the control stays on the chosen day, and the old day's banner is gone.
  await expect(day).toHaveValue('2026-10-15');
  await expect(main(page).getByText('Replay of Fri 16 Oct 2026.')).toHaveCount(0);

  release();
  await expect(main(page).getByText('Replay of Thu 15 Oct 2026.')).toBeVisible();
  await expect(day).toHaveValue('2026-10-15');
});

// ---------------------------------------------------------------------------
// 4. A session that cannot be loaded is an error, not a blank page — @critical
// ---------------------------------------------------------------------------

test('A session that cannot be loaded shows an error @critical', async ({ page }) => {
  await openLive(page, { failSession: true });
  const alert = main(page).getByRole('alert');
  await expect(alert).toContainText('The session could not be loaded');
  await expect(page.getByRole('radiogroup', { name: 'Index' })).toBeVisible();
});
