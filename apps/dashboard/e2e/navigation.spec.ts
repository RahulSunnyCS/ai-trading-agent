/**
 * E2E tests for in-app navigation and app shell behaviour.
 *
 * Every view has its own URL (/overview, /live, /trades, /pnl, /billing, …; "/" redirects to
 * /overview) and the sidebar ("Primary" navigation) is a list of real links. These tests click
 * those links rather than typing URLs, because in-app navigation is what they cover.
 *
 * Covers:
 *  - Clicking a sidebar link renders the right view, changes the URL and marks the link
 *    as the current page
 *  - The header stays mounted on every view, and the payment test-mode banner renders only
 *    on Billing
 *  - Every wired view shows an error/unavailable state when the backend is completely
 *    unreachable (network offline)
 *  - Keyboard accessibility for the sidebar links
 *
 * All HTTP calls the assertions depend on are intercepted via page.route() — no running
 * backend is required. Only the Next.js dev server (http://localhost:5173) must be up.
 *
 * Required env vars: none — all data is mocked.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A link in the desktop sidebar. Scoped to the "Primary" navigation so the mobile bottom bar
 * ("Sections") and the drawer never make the locator ambiguous.
 */
function sidebarLink(page: Page, name: string): Locator {
  return page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name, exact: true });
}

/** The current view's title in the sticky top bar. */
function viewTitle(page: Page): Locator {
  return page.getByRole('banner').getByRole('heading', { level: 1 });
}

/** Install standard mocks for every API route the assertions depend on. */
async function installStandardMocks(
  page: Page,
  { paymentTestMode = false }: { paymentTestMode?: boolean } = {},
): Promise<void> {
  await page.route('**/api/trades', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  // Billing (and the top bar's credits) read the payment status; the banner follows its
  // `testMode` flag.
  await page.route(
    (url) => url.pathname === '/api/payment/status',
    (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          testMode: paymentTestMode,
          region: 'IN',
          confidence: 'high',
        }),
      });
    },
  );

  await page.route(
    (url) => url.pathname === '/api/payment/plans',
    (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ plans: [] }),
      });
    },
  );

  await page.route(
    (url) => url.pathname === '/api/payment/balance',
    (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ credits: 0 }),
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Checklist: sidebar navigation renders the correct view — @functional
// ---------------------------------------------------------------------------

test('Switching between Live / Trades / P&L / Billing via the sidebar renders the right view @functional', async ({
  page,
}) => {
  await installStandardMocks(page);
  await page.goto('/');

  // "/" lands on Overview.
  await expect(page).toHaveURL(/\/overview$/);
  await expect(viewTitle(page)).toHaveText('Overview');
  await expect(sidebarLink(page, 'Overview')).toHaveAttribute('aria-current', 'page');

  // Switch to Live.
  await sidebarLink(page, 'Live').click();
  await expect(page).toHaveURL(/\/live$/);
  await expect(viewTitle(page)).toHaveText('Live');
  await expect(page.getByRole('heading', { name: 'ATM straddle' })).toBeVisible();
  await expect(sidebarLink(page, 'Live')).toHaveAttribute('aria-current', 'page');
  await expect(sidebarLink(page, 'Overview')).not.toHaveAttribute('aria-current', 'page');

  // Switch to Trades.
  await sidebarLink(page, 'Trades').click();
  await expect(page).toHaveURL(/\/trades$/);
  await expect(viewTitle(page)).toHaveText('Trades');
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ATM straddle' })).not.toBeVisible();
  await expect(sidebarLink(page, 'Trades')).toHaveAttribute('aria-current', 'page');

  // Switch to P&L.
  await sidebarLink(page, 'P&L').click();
  await expect(page).toHaveURL(/\/pnl$/);
  await expect(viewTitle(page)).toHaveText('P&L');
  await expect(page.getByRole('heading', { name: /P&L Summary/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).not.toBeVisible();
  await expect(sidebarLink(page, 'P&L')).toHaveAttribute('aria-current', 'page');

  // Switch to Billing (formerly Pricing).
  await sidebarLink(page, 'Billing').click();
  await expect(page).toHaveURL(/\/billing$/);
  await expect(viewTitle(page)).toHaveText('Billing');
  await expect(page.getByRole('main').getByRole('heading', { name: 'Billing' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /P&L Summary/i })).not.toBeVisible();
  await expect(sidebarLink(page, 'Billing')).toHaveAttribute('aria-current', 'page');

  // Switch back to Live.
  await sidebarLink(page, 'Live').click();
  await expect(page).toHaveURL(/\/live$/);
  await expect(page.getByRole('heading', { name: 'ATM straddle' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Checklist: all wired views show error state when backend is unreachable — @functional
// ---------------------------------------------------------------------------

test('All three wired views show an error or unavailable state when the backend is completely unreachable @functional', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Abort all API requests to simulate offline backend.
  await page.route('**/api/**', (route) => {
    void route.abort('failed');
  });
  // And refuse the tick socket, whichever host NEXT_PUBLIC_WS_URL points it at.
  await page.routeWebSocket(/\/ws\/ticks$/, (ws) => {
    void ws.close();
  });

  await page.goto('/');

  // --- Live view ---
  await sidebarLink(page, 'Live').click();
  await expect(page).toHaveURL(/\/live$/);
  // No white-screen / crash.
  await expect(page.getByRole('heading', { name: 'ATM straddle' })).toBeVisible();
  // The WebSocket cannot connect, and the feed badge says so.
  await expect(page.getByText('Tick feed unreachable · retrying')).toBeVisible({
    timeout: 6_000,
  });
  await expect(page.getByRole('main').getByText('Not connected', { exact: true })).toBeVisible();

  // --- Trades view ---
  await sidebarLink(page, 'Trades').click();
  await expect(page).toHaveURL(/\/trades$/);
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  // Wait briefly for the error state to settle (the hook fires on mount).
  const tradesAlert = page.getByRole('main').getByRole('alert');
  await expect(tradesAlert).toBeVisible({ timeout: 8_000 });
  await expect(tradesAlert).toContainText("Couldn't load trades");

  // --- P&L view ---
  await sidebarLink(page, 'P&L').click();
  await expect(page).toHaveURL(/\/pnl$/);
  await expect(viewTitle(page)).toHaveText('P&L');
  // P&L view should also surface an error alert (in place of the summary card).
  const pnlAlert = page.getByRole('main').getByRole('alert');
  await expect(pnlAlert).toBeVisible({ timeout: 8_000 });
  await expect(pnlAlert).toContainText("Couldn't load P&L data");

  // No unhandled JS exceptions across all three views.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Checklist: PaymentTestModeBanner — @non-blocker
// ---------------------------------------------------------------------------

test('Header persists on every view and the payment test-mode banner shows only on Billing @non-blocker', async ({
  page,
}) => {
  // The banner used to sit in the header on every tab; it now renders only on Billing, and
  // only while GET /api/payment/status reports a Razorpay test key.
  await installStandardMocks(page, { paymentTestMode: true });
  await page.goto('/');

  const header = page.getByRole('banner');
  const banner = page.getByText(/Payment test mode: checkouts use Razorpay test keys/);
  await expect(header).toBeVisible();

  for (const view of ['Trades', 'P&L', 'Billing', 'Live']) {
    await sidebarLink(page, view).click();
    // Header must remain visible after every switch, titled for the view.
    await expect(header).toBeVisible();
    await expect(viewTitle(page)).toHaveText(view);
    if (view === 'Billing') {
      await expect(banner).toBeVisible();
    } else {
      await expect(banner).toHaveCount(0);
    }
  }
});

// ---------------------------------------------------------------------------
// Checklist: keyboard accessibility for sidebar links — @non-blocker (partial)
// ---------------------------------------------------------------------------

test('Sidebar links are keyboard-focusable and activatable via Enter @non-blocker', async ({
  page,
}) => {
  await installStandardMocks(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/overview$/);

  // Focus the Live link and Tab to the next one (Trades).
  const liveLink = sidebarLink(page, 'Live');
  await liveLink.focus();
  await expect(liveLink).toBeFocused();

  // Press Tab to move focus to the next link.
  await page.keyboard.press('Tab');

  // The Trades link should now be focused.
  const tradesLink = sidebarLink(page, 'Trades');
  await expect(tradesLink).toBeFocused();

  // Activate the Trades link via Enter key.
  await page.keyboard.press('Enter');

  // The Trades view should now be visible, at its own URL.
  await expect(page).toHaveURL(/\/trades$/);
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
  await expect(tradesLink).toHaveAttribute('aria-current', 'page');
});
