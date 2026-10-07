/**
 * E2E tests for the Live view (/live).
 *
 * These tests verify:
 *  - The index card's feed-status badge renders in its various states (Connecting…, Not
 *    connected, Simulation) and is never absent
 *  - A simulated feed is labelled as such — the Simulation banner and badge — never as real
 *    or live straddle data
 *  - The ATM straddle card shows a graceful notice, with no numeric value, until the first
 *    straddle snapshot arrives
 *  - Incoming tick frames are parsed and rendered as numbers
 *  - Leaving the Live view (sidebar link to Trades) and coming back neither crashes nor
 *    loses the session's ticks (useLiveTicks keeps them at module level)
 *
 * Every view has its own URL: the tests open /live directly and switch views through the
 * sidebar's Primary navigation links.
 *
 * The live feed is the /ws/ticks WebSocket — the straddle no longer comes from an HTTP poll.
 * It is mocked with page.routeWebSocket(), so no Fastify server is needed: the mock sends
 * tick / straddle frames, closes the socket to simulate an unreachable server, or holds it
 * in the connecting state. /api/meta and /api/auth/fyers/status are intercepted with
 * page.route(); only the Next dev server (http://localhost:5173) must be up.
 *
 * Required env vars: none — all data is mocked via route interception.
 */

import { type Page, type WebSocketRoute, expect, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** /api/meta for a server running its random-walk simulator. */
const SIMULATED_META = { simulate: true, broker: 'sim', authDegraded: false };

/** A NIFTY 50 index tick frame, stamped now so the feed reads as fresh. */
function indexTick(ltp: number, timestamp: number = Date.now()): string {
  return JSON.stringify({ type: 'tick', symbol: 'NSE:NIFTY50-INDEX', ltp, timestamp });
}

/**
 * Mock the backend the Live view talks to, then open /live.
 *
 * `onSocket` runs for every /ws/ticks connection the page opens (one per mount of the view).
 * When it returns without closing the socket, Playwright opens it as a mock server; while it
 * is still pending, the page's socket stays in the connecting state.
 */
async function openLiveView(
  page: Page,
  {
    meta = SIMULATED_META,
    onSocket = () => {},
  }: {
    meta?: unknown;
    onSocket?: (ws: WebSocketRoute) => void | Promise<void>;
  } = {},
) {
  await page.routeWebSocket((url) => url.pathname === '/ws/ticks', onSocket);

  await page.route(
    (url) => url.pathname === '/api/meta',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(meta),
      }),
  );
  await page.route(
    (url) => url.pathname === '/api/auth/fyers/status',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: false }),
      }),
  );

  await page.goto('/live');
}

/** The NIFTY 50 index card. */
function indexCard(page: Page) {
  return page.getByRole('main').locator('div.rounded-xl').filter({ hasText: 'NIFTY 50 index' });
}

/** The ATM straddle card. */
function straddleCard(page: Page) {
  return page
    .getByRole('main')
    .locator('div.rounded-xl')
    .filter({ has: page.getByRole('heading', { name: 'ATM straddle' }) });
}

/** Every label the index card's feed badge can show (lib/live.ts LIVE_FEED_VIEW). */
const FEED_LABELS = [
  'Live',
  'Simulation',
  'Stale',
  'Waiting for ticks',
  'Idle',
  'Connecting…',
  'Not connected',
];

/** Mock /api/trades and switch to the Trades view through the sidebar — unmounts LiveView. */
async function switchToTrades(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/trades',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], message: 'no trades' }),
      }),
  );
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Trades', exact: true })
    .click();
  await expect(page).toHaveURL(/\/trades$/);
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// 1. Synthetic feed label — @critical
// ---------------------------------------------------------------------------

test('A simulated tick feed is labelled Simulation — not live or real straddle data @critical', async ({
  page,
}) => {
  await openLiveView(page, {
    onSocket: (ws) => {
      ws.send(JSON.stringify({ type: 'connected' }));
      // VIX and option-leg ticks share the socket; only the index belongs on the index card.
      ws.send(JSON.stringify({ type: 'tick', symbol: 'NSE:INDIAVIX-INDEX', ltp: 13.42 }));
      ws.send(indexTick(22456.75));
    },
  });

  // The incoming index tick is parsed and rendered as a formatted number.
  const card = indexCard(page);
  await expect(card.getByText('22,456.75')).toBeVisible();
  await expect(card.getByText('13.42')).toHaveCount(0);

  // The simulation banner says plainly that these are not real prices.
  const banner = page.getByRole('status').filter({ hasText: 'Simulation' });
  await expect(banner).toContainText('not real market prices');

  // The feed badge on fresh simulated ticks reads "Simulation" — never "Live".
  await expect(card.getByText('Simulation', { exact: true })).toBeVisible();
  await expect(card.getByText('Live', { exact: true })).toHaveCount(0);

  // The straddle is a separate card, and has no value while no snapshot has arrived.
  await expect(straddleCard(page)).toContainText('Waiting for the first straddle snapshot');

  // Nothing presents the index tick (or anything else) as real or live straddle data.
  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  for (const phrase of ['live straddle', 'real price', 'real straddle']) {
    expect(bodyText).not.toContain(phrase);
  }
});

// ---------------------------------------------------------------------------
// 2. No straddle snapshot → graceful notice — @critical
// ---------------------------------------------------------------------------

test('Before any straddle snapshot arrives the straddle card shows a graceful notice with no numeric value @critical', async ({
  page,
}) => {
  // Connected, index ticks flowing, but the straddle calculator has sent nothing.
  await openLiveView(page, {
    onSocket: (ws) => {
      ws.send(indexTick(22456.75));
    },
  });
  await expect(indexCard(page).getByText('22,456.75')).toBeVisible();

  const card = straddleCard(page);
  await expect(card).toBeVisible();

  // The notice is human-readable.
  await expect(card).toContainText('Waiting for the first straddle snapshot');

  // No feed badge for a straddle that has never arrived.
  for (const label of FEED_LABELS) {
    await expect(card.getByText(label, { exact: true })).toHaveCount(0);
  }

  // No numeric straddle value: a formatted one looks like "245.60" or "1,245.60".
  expect(await card.innerText()).not.toMatch(/\d[\d,]*\.\d{2}/);
});

// ---------------------------------------------------------------------------
// 3. Feed-status badge — Connecting state — @critical
// ---------------------------------------------------------------------------

test('The index card shows a Connecting… badge while the WebSocket has not opened @critical', async ({
  page,
}) => {
  // Hold the mock socket in the connecting state until the test releases it.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openLiveView(page, {
    onSocket: async (ws) => {
      await held;
      ws.send(indexTick(22456.75));
    },
  });

  const card = indexCard(page);
  await expect(card.getByText('Connecting…', { exact: true })).toBeVisible();
  await expect(card).toContainText('Connecting to the tick feed…');
  // No value is invented while connecting.
  await expect(card).toContainText('––');

  // Once the socket opens and a tick arrives, the badge moves on from Connecting….
  release();
  await expect(card.getByText('22,456.75')).toBeVisible();
  await expect(card.getByText('Connecting…', { exact: true })).toHaveCount(0);
  await expect(card.getByText('Simulation', { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4. Feed-status badge — Not connected when the socket closes — @critical
// ---------------------------------------------------------------------------

test('The feed badge turns to Not connected when the WebSocket cannot connect @critical', async ({
  page,
}) => {
  // The server refuses every connection: close the socket as soon as it is routed.
  await openLiveView(page, {
    onSocket: (ws) => {
      void ws.close({ code: 1011, reason: 'unreachable' });
    },
  });

  const card = indexCard(page);
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible();
  await expect(card).toContainText('Tick feed unreachable · retrying');

  // The straddle card says why it is empty rather than waiting forever.
  await expect(straddleCard(page)).toContainText('Tick feed not connected');
});

// ---------------------------------------------------------------------------
// 5. Unmounting LiveView closes the WebSocket — @critical (partial E2E component)
// ---------------------------------------------------------------------------

test('Switching away from LiveView to another view closes its socket and leaves no stale console errors @critical', async ({
  page,
}) => {
  // Collect any console errors during the test.
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Collect any unhandled page errors.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Track which sockets the page still holds open (dev StrictMode opens and closes one extra).
  const openSockets = new Set<WebSocketRoute>();
  let connections = 0;
  await openLiveView(page, {
    onSocket: (ws) => {
      connections += 1;
      openSockets.add(ws);
      ws.onClose(() => {
        openSockets.delete(ws);
      });
      ws.send(indexTick(22456.75));
    },
  });
  await expect(indexCard(page).getByText('22,456.75')).toBeVisible();
  await expect.poll(() => openSockets.size).toBe(1);

  // Switch to Trades through the sidebar — this unmounts LiveView.
  await switchToTrades(page);

  // Unmounting closes the socket...
  await expect.poll(() => openSockets.size).toBe(0);
  const connectionsAtUnmount = connections;

  // Wait out the first reconnect backoff (3 s + up to 20% jitter, hooks/useLiveTicks.ts) so
  // any post-unmount effect — a reconnect included — would have fired.
  await page.waitForTimeout(4_000);

  // ...and does not arm a reconnect: no new socket after the view is gone.
  expect(connections).toBe(connectionsAtUnmount);

  // No unhandled page errors should have occurred.
  expect(pageErrors).toHaveLength(0);

  // No React "state update on unmounted component" warnings.
  const reactUnmountWarnings = consoleErrors.filter(
    (e) => e.includes('unmounted component') || e.includes("Can't perform a React state update"),
  );
  expect(reactUnmountWarnings).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 6. Ticks are retained across a view switch and return — @non-blocker
// ---------------------------------------------------------------------------

test('Switching away from LiveView and back keeps the session ticks and does not crash @non-blocker', async ({
  page,
}) => {
  // Collect unhandled errors.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Ticks are sent only before the switch: anything shown after the return must have been
  // kept from before it, not re-sent.
  let sendTicks = true;
  let connections = 0;
  await openLiveView(page, {
    onSocket: (ws) => {
      connections += 1;
      if (!sendTicks) return;
      const now = Date.now();
      ws.send(indexTick(22450.5, now - 2_000));
      ws.send(indexTick(22456.75, now - 1_000));
    },
  });
  const chart = page.getByRole('img', { name: /NIFTY 50 index over the last 2 ticks/ });
  await expect(indexCard(page).getByText('22,456.75')).toBeVisible();
  await expect(chart).toBeVisible();

  sendTicks = false;
  const connectionsBeforeSwitch = connections;
  await switchToTrades(page);

  // Switch back to Live through the sidebar.
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Live', exact: true })
    .click();
  await expect(page).toHaveURL(/\/live$/);

  // LiveView remounts cleanly with a fresh socket, showing the ticks from before the switch.
  await expect.poll(() => connections).toBeGreaterThan(connectionsBeforeSwitch);
  await expect(indexCard(page).getByText('22,456.75')).toBeVisible();
  await expect(chart).toBeVisible();

  // The straddle card still shows its notice.
  await expect(straddleCard(page)).toContainText('Waiting for the first straddle snapshot');

  // No JS errors during the round-trip.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 7. Feed badge is visible and readable — @non-blocker (visual)
// ---------------------------------------------------------------------------

test('The index feed badge is visible and names the current status in text @non-blocker', async ({
  page,
}) => {
  await openLiveView(page, {
    onSocket: (ws) => {
      ws.send(indexTick(22456.75));
    },
  });

  // The badge's status dot is decorative (aria-hidden); the status is the badge's own text,
  // so it reaches screen readers without an aria-label.
  const badge = indexCard(page).getByText('Simulation', { exact: true });
  await expect(badge).toBeVisible();
  await expect(badge.locator('[aria-hidden="true"]')).toHaveCount(1);
});
