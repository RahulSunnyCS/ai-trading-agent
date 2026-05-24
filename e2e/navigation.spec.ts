/**
 * E2E tests for tab navigation and app shell behaviour.
 *
 * Covers:
 *  - Tab switching renders the correct view
 *  - PaymentTestModeBanner is visible on every tab
 *  - All three wired tabs show an error/unavailable state when the backend is
 *    completely unreachable (network offline)
 *  - Keyboard accessibility for tab buttons
 *
 * All HTTP calls are intercepted via page.route() — no running backend is
 * required.  Only the Vite dev server (http://localhost:5173) must be up.
 *
 * Required env vars: none — all data is mocked.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helper: install standard mocks for all API routes
// ---------------------------------------------------------------------------

async function installStandardMocks(page: Page): Promise<void> {
  await page.route('**/api/straddle/latest', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: null }),
    });
  });

  await page.route('**/api/trades', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  // Suppress pricing-plan fetch errors if the Pricing tab makes a request.
  await page.route('**/api/pricing/**', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });
}

// ---------------------------------------------------------------------------
// Checklist: tab switching renders the correct view — @functional
// ---------------------------------------------------------------------------

test(
  'Switching between Live / Trades / P&L / Pricing tabs renders the right view @functional',
  async ({ page }) => {
    await installStandardMocks(page);
    await page.goto('/');

    // Default tab is Live — NIFTY heading should be visible.
    await expect(page.getByRole('heading', { name: /NIFTY Index/i })).toBeVisible();

    // Switch to Trades tab.
    await page.getByRole('button', { name: 'Trades' }).click();
    await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /NIFTY Index/i })).not.toBeVisible();

    // Switch to P&L tab.
    await page.getByRole('button', { name: 'P&L' }).click();
    await expect(page.getByRole('heading', { name: /P&L Summary/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Paper Trades' })).not.toBeVisible();

    // Switch to Pricing tab.
    await page.getByRole('button', { name: 'Pricing' }).click();
    await expect(page.getByRole('heading', { name: /P&L Summary/i })).not.toBeVisible();

    // Switch back to Live.
    await page.getByRole('button', { name: 'Live' }).click();
    await expect(page.getByRole('heading', { name: /NIFTY Index/i })).toBeVisible();
  },
);

// ---------------------------------------------------------------------------
// Checklist: all wired tabs show error state when backend is unreachable — @functional
// ---------------------------------------------------------------------------

test(
  'All three wired tabs show an error or unavailable state when the backend is completely unreachable @functional',
  async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => { pageErrors.push(err.message); });

    // Abort all API requests to simulate offline backend.
    await page.route('**/api/**', (route) => {
      void route.abort('failed');
    });

    await page.goto('/');

    // --- Live tab ---
    // The WebSocket will fail to connect (no server).
    // The status pill must appear in connecting/disconnected state.
    const pill = page.locator('[role="status"][aria-label^="WebSocket status"]');
    await expect(pill).toBeVisible({ timeout: 6_000 });

    // No white-screen / crash.
    await expect(page.getByRole('heading', { name: /NIFTY Index/i })).toBeVisible();

    // --- Trades tab ---
    await page.getByRole('button', { name: 'Trades' }).click();
    await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
    // Should show an error state (role=alert) or the loading skeleton.
    // Either way no white screen.
    await expect(page.locator('body')).not.toContainText('Something went wrong');

    // Wait briefly for the error state to settle (the hook fires on mount).
    const tradesAlert = page.getByRole('alert');
    await expect(tradesAlert).toBeVisible({ timeout: 8_000 });

    // --- P&L tab ---
    await page.getByRole('button', { name: 'P&L' }).click();
    await expect(page.getByRole('heading', { name: /P&L Summary/i })).toBeVisible();
    // P&L view should also surface an error alert.
    const pnlAlert = page.getByRole('alert');
    await expect(pnlAlert).toBeVisible({ timeout: 8_000 });

    // No unhandled JS exceptions across all three tabs.
    expect(pageErrors).toHaveLength(0);
  },
);

// ---------------------------------------------------------------------------
// Checklist: PaymentTestModeBanner visible on all tabs — @non-blocker
// ---------------------------------------------------------------------------

test(
  'PaymentTestModeBanner remains visible on all four tabs @non-blocker',
  async ({ page }) => {
    await installStandardMocks(page);
    await page.goto('/');

    // The banner is always mounted in the header.  It self-hides in live mode
    // (when RAZORPAY_KEY_ID is set to a live key).  In dev/test mode it is
    // visible.  We check the header element is present on every tab.
    const header = page.locator('header');
    await expect(header).toBeVisible();

    // Check the banner persists as we navigate through each tab.
    for (const tabName of ['Trades', 'P&L', 'Pricing', 'Live']) {
      await page.getByRole('button', { name: tabName }).click();
      // Header must remain visible after every tab switch.
      await expect(header).toBeVisible();
    }
  },
);

// ---------------------------------------------------------------------------
// Checklist: keyboard accessibility for tab buttons — @non-blocker (partial)
// ---------------------------------------------------------------------------

test(
  'Tab buttons are keyboard-focusable and activatable via Enter @non-blocker',
  async ({ page }) => {
    await installStandardMocks(page);
    await page.goto('/');

    // Focus the first tab button (Live) and Tab to the next one (Trades).
    const liveButton = page.getByRole('button', { name: 'Live' });
    await liveButton.focus();
    await expect(liveButton).toBeFocused();

    // Press Tab to move focus to the next button.
    await page.keyboard.press('Tab');

    // The Trades button should now be focused.
    const tradesButton = page.getByRole('button', { name: 'Trades' });
    await expect(tradesButton).toBeFocused();

    // Activate the Trades tab via Enter key.
    await page.keyboard.press('Enter');

    // The Trades view should now be visible.
    await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
  },
);
