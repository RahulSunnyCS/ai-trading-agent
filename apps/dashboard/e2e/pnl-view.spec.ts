/**
 * E2E tests for the PnlView dashboard view (/pnl).
 *
 * Covers every QA-checklist item for PnlView (P&L computation, IST date
 * boundaries, error/empty states, win rate, open/closed counts, chart).
 *
 * Each test opens the view by its own URL (`page.goto('/pnl')`, see
 * src/lib/routes.ts) rather than clicking through the sidebar.
 *
 * Every HTTP call an assertion depends on (/api/trades, /api/personalities) is
 * intercepted via page.route() with a URL predicate — no running backend is
 * required.  Only the Next.js dev server (http://localhost:5173) must be up.
 *
 * The page's range control defaults to "All", so the fixed May-2026 exit times
 * below are always in range whatever the wall clock says; the one test that
 * depends on "today" pins the clock with page.clock.setFixedTime().
 *
 * Required env vars: none — all data is mocked.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared mock data factories
// ---------------------------------------------------------------------------

function makeTrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'trade-1',
    entry_time: '2026-05-23T04:00:00.000Z',
    exit_time: null,
    status: 'open',
    straddle_at_entry: '22000.00',
    entry_ce_price: '100.00',
    entry_pe_price: '100.00',
    gross_pnl: null,
    net_pnl: null,
    exit_reason: null,
    lots: 1,
    lot_size: 50,
    ...overrides,
  };
}

const isTradesUrl = (url: URL): boolean => url.pathname === '/api/trades';

/** Fulfil GET /api/trades (any query string) with `status` and `body`. */
async function mockTrades(page: Page, status: number, body: string): Promise<void> {
  await page.route(isTradesUrl, (route) => {
    void route.fulfill({
      status,
      contentType: status === 200 ? 'application/json' : 'text/plain',
      body,
    });
  });
}

/**
 * Open /pnl and return once the (mocked) /api/trades response has reached the page and the page
 * title is visible. Waiting for the response, not the `load` event, keeps the tests independent
 * of how long a busy dev server takes to serve every chunk.
 */
async function gotoPnl(page: Page): Promise<void> {
  // timeout 0: bounded by the test timeout, not the 10 s action timeout — a cold or busy dev
  // server can take longer than that to hydrate the page and send the first request.
  const tradesServed = page.waitForResponse((response) => isTradesUrl(new URL(response.url())), {
    timeout: 0,
  });
  await page.goto('/pnl', { waitUntil: 'domcontentloaded' });
  await tradesServed;
  // The page title (Topbar), present in every state. Not "P&L Summary": that card only shows
  // while loading or with no closed trades.
  await expect(page.getByRole('heading', { level: 1, name: 'P&L' })).toBeVisible();
}

/**
 * Install the /api/trades and /api/personalities intercepts and open /pnl.
 * Returns once the trades have been served and the page title is visible.  A later call replaces the earlier
 * intercepts (Playwright tries the newest route handler first).
 */
async function openPnlView(page: Page, tradesPayload: unknown = { data: [] }): Promise<void> {
  await mockTrades(page, 200, JSON.stringify(tradesPayload));

  // The per-personality table reads /api/personalities?include_inactive=true. No personalities:
  // every trade lands in the "unassigned" row, which keeps the page deterministic.
  await page.route(
    (url) => url.pathname === '/api/personalities',
    (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    },
  );

  await gotoPnl(page);
}

/**
 * The hero card — "Realized P&L · closed trades · <range>", the total, and an "Across N closed
 * trades · X% win rate" line. It only renders when the range has a closed trade.
 */
function heroCard(page: Page): Locator {
  return page
    .getByText(/^Realized P&L · closed trades/)
    .locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]');
}

/** The hero's big total figure. */
function heroTotal(page: Page): Locator {
  return heroCard(page).locator('p.metric');
}

/** The value element of the StatCard whose label is exactly `label`. */
function statValue(page: Page, label: string): Locator {
  return page
    .getByText(label, { exact: true })
    .locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]')
    .locator('div.metric');
}

const cumulativeChart = (page: Page): Locator =>
  page.getByRole('img', { name: /^Cumulative realized P&L chart/ });

// ---------------------------------------------------------------------------
// Checklist: total net P&L is a numeric sum, not string concatenation — @critical
// ---------------------------------------------------------------------------

test('Total net P&L is the correct arithmetic sum — not string concatenation @critical', async ({
  page,
}) => {
  const trades = [
    makeTrade({
      id: 'trade-1',
      status: 'closed',
      exit_time: '2026-05-23T06:00:00.000Z',
      net_pnl: '100.00',
      gross_pnl: '110.00',
    }),
    makeTrade({
      id: 'trade-2',
      status: 'closed',
      exit_time: '2026-05-23T07:00:00.000Z',
      net_pnl: '200.50',
      gross_pnl: '210.50',
    }),
    makeTrade({
      id: 'trade-3',
      status: 'closed',
      exit_time: '2026-05-23T08:00:00.000Z',
      net_pnl: '-50.25',
      gross_pnl: '-45.25',
    }),
  ];

  await openPnlView(page, { data: trades });

  // Expected total: 100.00 + 200.50 + (-50.25) = 250.25, shown as "+₹250.25".
  // It must NOT show "100.00200.50-50.25" (string concatenation) or NaN.
  await expect(heroTotal(page)).toHaveText('+₹250.25');

  const heroText = await heroCard(page).innerText();
  expect(heroText).not.toContain('100.00200.50');
  expect(heroText).not.toContain('NaN');

  // With closed trades the cumulative chart is drawn (the open-only test relies on this label).
  await expect(cumulativeChart(page)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Checklist: open trades (null net_pnl) excluded from total — @critical
// ---------------------------------------------------------------------------

test('Open trades with null net_pnl are excluded from the total P&L sum @critical', async ({
  page,
}) => {
  const trades = [
    makeTrade({
      id: 'trade-closed',
      status: 'closed',
      exit_time: '2026-05-23T07:00:00.000Z',
      net_pnl: '300.00',
      gross_pnl: '310.00',
    }),
    makeTrade({
      id: 'trade-open',
      status: 'open',
      exit_time: null,
      net_pnl: null,
      gross_pnl: null,
    }),
  ];

  await openPnlView(page, { data: trades });

  // Expected total: 300.00 (open trade contributes nothing) and must not be NaN (which would
  // happen if null were passed to parseFloat unchecked).
  await expect(heroTotal(page)).toHaveText('+₹300.00');
  await expect(heroCard(page)).toContainText('Across 1 closed trade ·');
  // The open trade is counted separately, never folded into the total.
  await expect(statValue(page, 'Open positions')).toHaveText('1');
});

// ---------------------------------------------------------------------------
// Checklist: error state must NOT render as flat 0.00 / 0% — @critical
// ---------------------------------------------------------------------------

test('When /api/trades returns HTTP 500 PnlView shows an error notice, not a zeroed-out P&L dashboard @critical', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await mockTrades(page, 500, 'Internal Server Error');
  await gotoPnl(page);

  // An error alert must appear within a reasonable time.
  const alert = page.getByRole('alert').filter({ hasText: /P&L/ });
  await expect(alert).toBeVisible({ timeout: 8_000 });

  const alertText = await alert.innerText();
  expect(alertText.toLowerCase()).toMatch(/couldn|load|error|fail/);

  // In error state, there must be NO P&L figures at all (a zeroed-out dashboard looks like a
  // calm no-activity day — very misleading). The hero and the metric grid render only when the
  // range has a closed trade; after a 500 with no prior data there is none.
  await expect(page.getByText(/^Realized P&L · closed trades/)).toHaveCount(0);
  await expect(page.getByText("Today's P&L (IST)", { exact: true })).toHaveCount(0);
  // Nor the "no closed trades" empty state, which would also read as a quiet day.
  await expect(page.getByText(/No closed trades/i)).toHaveCount(0);

  // No unhandled JS errors.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Checklist: "Today's P&L" uses IST date boundaries — @critical
// ---------------------------------------------------------------------------

test.describe('IST day boundaries', () => {
  // Run the browser in UTC so a "today" computed in the browser's local zone (or from a UTC
  // date) disagrees with IST and fails this test.
  test.use({ timezoneId: 'UTC' });

  test("Today's P&L uses IST date boundaries — a trade at 23:59 IST is counted in the correct IST day @critical", async ({
    page,
  }) => {
    // Now: 2026-05-24T06:00:00Z = 11:30 IST on May 24 ("today" in IST, and in UTC).
    await page.clock.setFixedTime(new Date('2026-05-24T06:00:00.000Z'));

    const trades = [
      makeTrade({
        id: 'trade-yesterday-ist',
        status: 'closed',
        // 2026-05-23T18:29:00.000Z = 23:59 IST on May 23 — yesterday in IST.
        exit_time: '2026-05-23T18:29:00.000Z',
        net_pnl: '700.00',
        gross_pnl: '710.00',
      }),
      makeTrade({
        id: 'trade-today-ist',
        status: 'closed',
        // 2026-05-23T19:00:00.000Z = 00:30 IST on May 24 — today in IST, but still May 23 in UTC.
        exit_time: '2026-05-23T19:00:00.000Z',
        net_pnl: '500.00',
        gross_pnl: '510.00',
      }),
    ];

    await openPnlView(page, { data: trades });

    await expect(heroTotal(page)).toHaveText('+₹1,200.00');
    // Only the 00:30 IST trade is today's. A UTC day would give ₹0.00 (both trades are May 23
    // in UTC); counting both would give +₹1,200.00.
    await expect(statValue(page, "Today's P&L (IST)")).toHaveText('+₹500.00');
    // The two trades fall on different IST days: best day is May 23's 700, worst May 24's 500.
    await expect(statValue(page, 'Best day')).toHaveText('+₹700.00');
    await expect(statValue(page, 'Worst day')).toHaveText('+₹500.00');

    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain('NaN');
  });
});

// ---------------------------------------------------------------------------
// Checklist: win rate denominator excludes open trades — @functional
// ---------------------------------------------------------------------------

test('Win rate is computed as closed-wins / total-closed — open trades excluded from denominator @functional', async ({
  page,
}) => {
  // 3 closed trades (2 profitable, 1 loss) + 2 open trades.
  // Expected win rate: 2/3 = 66.7%.  NOT 2/5 = 40%.
  const trades = [
    makeTrade({
      id: 'closed-win-1',
      status: 'closed',
      exit_time: '2026-05-23T06:00:00.000Z',
      net_pnl: '100.00',
      gross_pnl: '110.00',
    }),
    makeTrade({
      id: 'closed-win-2',
      status: 'closed',
      exit_time: '2026-05-23T07:00:00.000Z',
      net_pnl: '200.00',
      gross_pnl: '210.00',
    }),
    makeTrade({
      id: 'closed-loss',
      status: 'closed',
      exit_time: '2026-05-23T08:00:00.000Z',
      net_pnl: '-50.00',
      gross_pnl: '-40.00',
    }),
    makeTrade({ id: 'open-1', status: 'open', exit_time: null, net_pnl: null }),
    makeTrade({ id: 'open-2', status: 'open', exit_time: null, net_pnl: null }),
  ];

  await openPnlView(page, { data: trades });

  // The win rate lives in the hero's "Across N closed trades · X% win rate" line.
  const hero = heroCard(page);
  // 66.7% — correct (2/3).
  await expect(hero).toContainText('66.7% win rate');
  // Must not show 40.0% (2/5 — wrong: open trades in denominator).
  await expect(hero).not.toContainText('40.0%');
});

// ---------------------------------------------------------------------------
// Checklist: cumulative chart renders without error when no closed trades — @functional
// ---------------------------------------------------------------------------

test('Cumulative P&L chart renders without crash when there are only open trades @functional', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  const trades = [makeTrade({ id: 'open-only', status: 'open', exit_time: null, net_pnl: null })];

  await openPnlView(page, { data: trades });

  // The "no closed trades" empty state should appear, naming the running position.
  await expect(page.getByText(/No closed trades yet/i)).toBeVisible();
  await expect(page.getByText(/1 open position currently running/)).toBeVisible();

  // The cumulative chart should NOT be rendered (no closed trades to plot).
  await expect(cumulativeChart(page)).toHaveCount(0);

  // No JS errors.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Checklist: empty array → "no closed trades" state renders — @functional
// ---------------------------------------------------------------------------

test('When /api/trades returns an empty array PnlView shows a no-closed-trades empty state @functional', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await openPnlView(page, { data: [] });

  // Must show the empty-state message.
  await expect(page.getByText(/No closed trades yet/i)).toBeVisible();

  // Must NOT show metric cards with zero values (misleading).
  await expect(page.getByText(/^Realized P&L · closed trades/)).toHaveCount(0);
  await expect(page.getByText("Today's P&L (IST)", { exact: true })).toHaveCount(0);

  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Checklist: open count and closed count displayed separately — @functional
// ---------------------------------------------------------------------------

test('Open and closed position counts are displayed separately and accurately @functional', async ({
  page,
}) => {
  // 3 open + 5 closed trades.
  const trades = [
    ...Array.from({ length: 3 }, (_, i) =>
      makeTrade({ id: `open-${i}`, status: 'open', exit_time: null, net_pnl: null }),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      makeTrade({
        id: `closed-${i}`,
        status: 'closed',
        exit_time: `2026-05-2${i + 1}T06:0${i}:00.000Z`,
        net_pnl: `${(i + 1) * 50}.00`,
        gross_pnl: `${(i + 1) * 55}.00`,
      }),
    ),
  ];

  await openPnlView(page, { data: trades });

  // The closed count lives in the hero ("Across 5 closed trades"); it must be 5, not 8.
  await expect(heroCard(page)).toContainText('Across 5 closed trades ·');

  // Open positions card must show exactly "3".
  await expect(statValue(page, 'Open positions')).toHaveText('3');
});

// ---------------------------------------------------------------------------
// Checklist: total P&L colored green for positive, red for negative — @non-blocker
// ---------------------------------------------------------------------------

test('Total net P&L is colored green for positive values and red for negative @non-blocker', async ({
  page,
}) => {
  // Positive total first.
  const positiveTrades = [
    makeTrade({
      id: 'trade-pos',
      status: 'closed',
      exit_time: '2026-05-23T06:00:00.000Z',
      net_pnl: '500.00',
      gross_pnl: '510.00',
    }),
  ];

  await openPnlView(page, { data: positiveTrades });

  // The hero total takes the `text-positive` (green) token for a gain…
  await expect(heroTotal(page)).toHaveText('+₹500.00');
  await expect(heroTotal(page)).toHaveClass(/\btext-positive\b/);

  // …and `text-negative` (red) for a loss.
  const negativeTrades = [
    makeTrade({
      id: 'trade-neg',
      status: 'closed',
      exit_time: '2026-05-23T06:00:00.000Z',
      net_pnl: '-125.00',
      gross_pnl: '-115.00',
    }),
  ];

  await openPnlView(page, { data: negativeTrades });

  await expect(heroTotal(page)).toHaveText('-₹125.00');
  await expect(heroTotal(page)).toHaveClass(/\btext-negative\b/);
});
