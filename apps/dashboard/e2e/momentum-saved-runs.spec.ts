import { type Page, expect, test } from '@playwright/test';

import type { SavedStrategy } from '../src/types/momentum';

/** BL-052: Saved runs as one row per strategy, the drawer with why a result moved, favourite
 * status (BL-051) and groups. Every API response is mocked. */

function strategy(id: string, name: string, patch: Partial<SavedStrategy> = {}): SavedStrategy {
  return {
    id,
    version_id: `momentum:etf:${id}`,
    dataset: 'etf',
    fingerprint: id,
    name,
    name_typed: true,
    notes: null,
    config: { dataset: 'etf', start: '2017-01-01', top_n: 5 },
    config_full: { dataset: 'etf', start: '2017-01-01', top_n: 5 },
    favorite: false,
    active: false,
    status: null,
    group: null,
    member_of: null,
    overlay: false,
    runs: 1,
    repeats: 0,
    first_saved: '2026-10-05T10:00:00+0530',
    last_run: '2026-10-08T10:00:00+0530',
    latest: {
      id: `${id}-run`,
      created_at: '2026-10-08T10:00:00+0530',
      kpis: { cagr: 0.2, excess_cagr: 0.08, max_drawdown: -0.3, sharpe: 1.1 },
      dates: ['2026-09-25', '2026-10-02'],
      strategy: [100, 103],
      data_through: '2026-10-02',
      versions: { data: 'd1', tables: {}, lake: 'l', files: 'f', code: 'abc1234' },
      outcome: 'new',
    },
    change: null,
    unreviewed: 0,
    trust: 'in_sample',
    ...patch,
  };
}

const MOVED = {
  change_id: 'c1',
  created_at: '2026-10-08T10:00:00+0530',
  dataset: 'etf',
  version_id: 'momentum:etf:a1',
  anchor_run_id: 'a1',
  prev_run_id: 'a1-old',
  run_id: 'a1-run',
  label: 'check' as const,
  prev_versions: null,
  versions: null,
  changed: [],
  first_difference: '2024-03-15',
  kpis_before: { cagr: 0.204 },
  kpis_after: { cagr: 0.2 },
  detail: null,
  reviewed_at: null,
  reviewed_by: null,
  needs_review: true,
};

async function mockSavedStrategies(
  page: Page,
): Promise<{ patches: unknown[]; reviewed: string[] }> {
  const strategies: SavedStrategy[] = [
    strategy('a1', 'Core ETF', { runs: 3, repeats: 1, change: MOVED, unreviewed: 1 }),
    strategy('b2', 'Sleeve one', { favorite: true, status: 'watching' }),
    strategy('c3', 'Sleeve two', { favorite: true, status: 'watching' }),
  ];
  const patches: unknown[] = [];
  const reviewed: string[] = [];
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route(/\/api\/momentum\/meta/, (route) =>
    route.fulfill(
      json({
        instruments: [],
        first_week: '2017-01-06',
        last_week: '2026-10-02',
        defaults: { start: '2017-01-01', top_n: 5 },
      }),
    ),
  );
  await page.route(/\/api\/momentum\/weekly\/status/, (route) =>
    route.fulfill(
      json({
        today: '2026-10-08',
        target_week: '2026-10-09',
        datasets: [],
        signals: [],
        schedule: [],
      }),
    ),
  );
  await page.route(/\/api\/momentum\/(favorite-strategies|saved-runs)(\?.*)?$/, (route) =>
    route.fulfill(json([])),
  );
  await page.route(/\/api\/momentum\/saved-strategies\/summary$/, (route) =>
    route.fulfill(
      json({
        count: strategies.filter((s) => !s.member_of).length,
        unreviewed: reviewed.length ? 0 : 1,
      }),
    ),
  );
  await page.route(/\/api\/momentum\/saved-strategies\/merge$/, (route) =>
    route.fulfill(json({ merges: [], conflicts: [], runs: 0, strategies: 0 })),
  );
  await page.route(/\/api\/momentum\/saved-strategies(\?.*)?$/, (route) =>
    route.fulfill(
      json({
        strategies: strategies.filter((s) => !s.member_of),
        unreviewed: reviewed.length ? 0 : 1,
        ignored_fields: { etf: ['broad_liquidity_filter'] },
      }),
    ),
  );
  await page.route(/\/api\/momentum\/saved-runs\/groups$/, async (route) => {
    const body = route.request().postDataJSON() as { name: string; members: string[] };
    const members = strategies.filter((s) => body.members.includes(s.id));
    for (const member of members) Object.assign(member, { member_of: 'g9', status: null });
    const group = strategy('g9', body.name, {
      favorite: true,
      status: 'watching',
      group: body.members,
      members,
      trust: null,
    });
    strategies.unshift(group);
    await route.fulfill(json(group));
  });
  await page.route(/\/api\/momentum\/saved-strategies\/(a1|b2|c3|g9)$/, async (route) => {
    const id = route.request().url().split('/').pop() as string;
    const target = strategies.find((s) => s.id === id) as SavedStrategy;
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { status?: SavedStrategy['status'] | 'none' };
      patches.push(body);
      if (body.status === 'none') Object.assign(target, { favorite: false, status: null });
      else if (body.status) Object.assign(target, { favorite: true, status: body.status });
    }
    await route.fulfill(
      json({
        ...target,
        history: [
          {
            id: 'a1-run',
            created_at: '2026-10-08T10:00:00+0530',
            n: 3,
            name: 'Run 3',
            kpis: { cagr: 0.2 },
            data_through: '2026-10-02',
            versions: target.latest.versions,
            outcome: 'new_result',
            change: { ...MOVED, needs_review: reviewed.length === 0 },
          },
        ],
      }),
    );
  });
  await page.route(/\/api\/momentum\/result-changes\/c1\/reviewed$/, async (route) => {
    reviewed.push('c1');
    await route.fulfill(json({ ...MOVED, needs_review: false, reviewed_by: 'owner' }));
  });
  return { patches, reviewed };
}

test('Saved runs shows one row per strategy, its status, and groups strategies', async ({
  page,
}) => {
  const { patches } = await mockSavedStrategies(page);
  await page.goto('/momentum/saved');

  await expect(page.getByText('3 strategies · 5 runs · all datasets')).toBeVisible();
  await expect(page.getByText('Paper + Invested 0 of 8')).toBeVisible();
  await expect(page.getByText('↻ -0.4')).toBeVisible();

  await page.getByRole('button', { name: /Favourite status of Sleeve one/ }).click();
  await page.getByRole('menuitemradio', { name: 'Paper' }).click();
  await expect.poll(() => patches).toContainEqual({ status: 'paper' });

  await page.getByRole('checkbox', { name: 'Compare Sleeve one' }).check();
  await page.getByRole('checkbox', { name: 'Compare Sleeve two' }).check();
  await expect(page.getByText(/they differ in 0 settings/)).toBeVisible();
  await page.getByRole('button', { name: 'Group as one favourite' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Pair');
  await page.getByRole('button', { name: 'Make group' }).click();
  await expect(page.getByText('Group · 2')).toBeVisible();
  if (process.env.SAVED_RUNS_SHOT) await page.screenshot({ path: process.env.SAVED_RUNS_SHOT });
});

test('the drawer says why a result moved and marks it reviewed', async ({ page }) => {
  const { reviewed } = await mockSavedStrategies(page);
  await page.goto('/momentum/saved');

  await page.getByText('Core ETF', { exact: true }).click();
  await expect(page).toHaveURL(/[?&]strategy=a1/);
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Run history')).toBeVisible();
  await expect(drawer.getByText('-0.4 pp · Check', { exact: true })).toBeVisible();
  await expect(
    drawer.getByText(/no accepted golden change of this dataset explains it/),
  ).toBeVisible();
  await drawer.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect.poll(() => reviewed).toEqual(['c1']);
  if (process.env.SAVED_DRAWER_SHOT) await page.screenshot({ path: process.env.SAVED_DRAWER_SHOT });
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/strategy=/);
});
