import { type Page, expect, test } from '@playwright/test';

import type { MomentumAlert, MomentumAlertsResponse } from '../src/types/momentum';

/** BL-051 Phase 5: the alert pop-up (at most once a day per alert, on any page) and the bell.
 * Every API response is mocked. */

const SPLIT: MomentumAlert = {
  id: 'split:ABC:2026-10-07',
  kind: 'split',
  severity: 'warning',
  title: 'ABC fell 50% on 2026-10-07: classify it',
  detail: 'No matching split or bonus filing was found.',
  link: '/momentum/week?review=ABC',
  opened_at: '2026-10-08T10:00:00+05:30',
  resolved_at: null,
};

const JOURNAL: MomentumAlert = {
  id: 'journal:missing:2026-10-09',
  kind: 'journal',
  severity: 'error',
  title: 'Journal: 1 of 3 entries missing for the week of 2026-10-09',
  detail: 'Core (final)',
  link: '/momentum/journal',
  opened_at: '2026-10-09T21:05:00+05:30',
  resolved_at: null,
};

/** The alerts the mocked API returns; the test changes it to clear one. */
async function mockAlerts(page: Page, open: () => MomentumAlert[]): Promise<void> {
  await page.route(/\/api\/momentum\/alerts$/, (route) => {
    const body: MomentumAlertsResponse = {
      checked_at: '2026-10-09T21:10:00+05:30',
      alerts: open(),
      resolved: [],
      unchecked: [],
    };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

const popup = (page: Page) => page.getByRole('status', { name: 'Alert' });
const errorPopup = (page: Page) => page.getByRole('alert', { name: 'Alert' });

test('an unclassified split pops up on any page and Review opens its drawer on This week', async ({
  page,
}) => {
  await mockAlerts(page, () => [SPLIT]);

  await page.goto('/overview');
  await expect(popup(page)).toBeVisible();
  await expect(popup(page)).toContainText('ABC fell 50% on 2026-10-07');
  await expect(page.getByRole('button', { name: 'Alerts: 1 needs you' })).toBeVisible();

  await popup(page).getByRole('button', { name: 'Review ›' }).click();
  await expect(popup(page)).toBeHidden();
  await expect(page).toHaveURL(/\/momentum\/week\?review=ABC$/);
});

test('classifying the split clears the bell, and the card does not come back the same day', async ({
  page,
}) => {
  let alerts = [SPLIT];
  await mockAlerts(page, () => alerts);

  await page.goto('/overview');
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole('button', { name: 'Remind me tomorrow' }).click();
  await expect(page.getByTestId('alerts-count')).toHaveText('1');

  // Classified: the next answer has no alert, so the bell is empty and nothing pops up.
  alerts = [];
  await page.reload();
  await expect(page.getByRole('button', { name: 'Alerts: nothing needs you' })).toBeVisible();
  await expect(page.getByTestId('alerts-count')).toHaveCount(0);
  await expect(popup(page)).toBeHidden();
});

test('Remind me tomorrow hides the pop-up for the day but the bell keeps listing the alert', async ({
  page,
}) => {
  await mockAlerts(page, () => [JOURNAL, SPLIT]);
  await page.goto('/pnl');

  // The most severe first: the error is announced as an alert.
  await expect(errorPopup(page)).toContainText('Journal: 1 of 3 entries missing');
  await errorPopup(page).getByRole('button', { name: 'Remind me tomorrow' }).click();
  // The next one due follows at once, then nothing more.
  await expect(popup(page)).toContainText('ABC fell 50%');
  await popup(page).getByRole('button', { name: 'Remind me tomorrow' }).click();
  await expect(popup(page)).toBeHidden();

  await page.reload();
  await expect(page.getByTestId('alerts-count')).toHaveText('2');
  await expect(popup(page)).toBeHidden();
  await expect(errorPopup(page)).toBeHidden();

  await page.getByRole('button', { name: 'Alerts: 2 need you' }).click();
  const rows = page.getByRole('menuitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Journal: 1 of 3 entries missing');
  await expect(rows.first()).toHaveAttribute('href', '/momentum/journal');
  await rows.nth(1).click();
  await expect(page).toHaveURL(/\/momentum\/week\?review=ABC$/);
});

test('an alert remembered from an earlier day pops up again', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ata.momentumAlerts.v1',
      JSON.stringify({ 'split:ABC:2026-10-07': '2020-01-01' }),
    );
  });
  await mockAlerts(page, () => [SPLIT]);
  await page.goto('/overview');
  await expect(popup(page)).toContainText('ABC fell 50%');
});

test('a failing alerts API leaves the page usable and the bell quiet', async ({ page }) => {
  await page.route(/\/api\/momentum\/alerts$/, (route) => route.fulfill({ status: 502, body: '' }));
  await page.goto('/overview');
  await expect(page.getByRole('button', { name: 'Alerts: nothing needs you' })).toBeVisible();
  await page.getByRole('button', { name: 'Alerts: nothing needs you' }).click();
  await expect(page.getByText('Alerts could not be loaded.')).toBeVisible();
  await expect(popup(page)).toBeHidden();
});
