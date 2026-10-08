import { type Page, expect, test } from '@playwright/test';

/** BL-051 Phase 1: favourite status, the Paper + Invested limit and groups on Saved runs. */

interface Run {
  id: string;
  created_at: string;
  n: number;
  name: string;
  config: Record<string, unknown>;
  kpis: Record<string, number | null>;
  dates: string[];
  strategy: number[];
  overlay: boolean;
  favorite: boolean;
  active: boolean;
  status: 'watching' | 'paper' | 'invested' | null;
  group: string[] | null;
  member_of: string | null;
}

function run(id: string, name: string, patch: Partial<Run> = {}): Run {
  return {
    id,
    created_at: '2026-10-08T10:00:00+0530',
    n: 1,
    name,
    config: { dataset: 'etf', start: '2017-01-01' },
    kpis: { cagr: 0.2, max_drawdown: -0.3, sharpe: 1.1 },
    dates: ['2026-09-25', '2026-10-02'],
    strategy: [100, 103],
    overlay: false,
    favorite: false,
    active: false,
    status: null,
    group: null,
    member_of: null,
    ...patch,
  };
}

async function mockSavedRuns(page: Page): Promise<{ patches: unknown[] }> {
  const runs: Run[] = [
    run('a1', 'Core ETF'),
    run('b2', 'Sleeve one', { favorite: true, status: 'watching' }),
    run('c3', 'Sleeve two', { favorite: true, status: 'watching' }),
  ];
  const patches: unknown[] = [];
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route(/\/api\/momentum\/meta/, (route) =>
    route.fulfill(
      json({ instruments: [], first_week: '2017-01-06', last_week: '2026-10-02', defaults: {} }),
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
  await page.route(/\/api\/momentum\/favorite-strategies/, (route) =>
    route.fulfill(json(runs.filter((r) => r.favorite))),
  );
  await page.route(/\/api\/momentum\/saved-runs(\?.*)?$/, (route) => route.fulfill(json(runs)));
  await page.route(/\/api\/momentum\/saved-runs\/groups$/, async (route) => {
    const body = route.request().postDataJSON() as { name: string; members: string[] };
    const group = run('g9', body.name, {
      favorite: true,
      status: 'watching',
      group: body.members,
      config: { dataset: 'etf', group: body.members },
      kpis: {},
      dates: [],
      strategy: [],
    });
    for (const member of runs) {
      if (body.members.includes(member.id))
        Object.assign(member, { member_of: 'g9', status: null });
    }
    runs.unshift(group);
    await route.fulfill(json(group));
  });
  await page.route(/\/api\/momentum\/saved-runs\/(a1|b2|c3|g9)$/, async (route) => {
    const id = route.request().url().split('/').pop() as string;
    const body = route.request().postDataJSON() as { status?: Run['status'] | 'none' };
    patches.push(body);
    const target = runs.find((r) => r.id === id) as Run;
    if (body.status === 'none') Object.assign(target, { favorite: false, status: null });
    else if (body.status) Object.assign(target, { favorite: true, status: body.status });
    await route.fulfill(json(target));
  });
  return { patches };
}

test('Saved runs sets a favourite status and groups runs as one favourite', async ({ page }) => {
  const { patches } = await mockSavedRuns(page);
  await page.goto('/momentum/saved');

  await expect(page.getByText('Paper + Invested 0 of 8')).toBeVisible();
  await page.getByRole('button', { name: /Favourite status of Core ETF/ }).click();
  await page.getByRole('menuitemradio', { name: 'Paper' }).click();
  await expect.poll(() => patches).toContainEqual({ status: 'paper' });
  await expect(
    page.getByRole('button', { name: /Favourite status of Core ETF: Paper/ }),
  ).toBeVisible();

  await page.getByRole('checkbox', { name: 'Compare Sleeve one' }).check();
  await page.getByRole('checkbox', { name: 'Compare Sleeve two' }).check();
  await page.getByRole('button', { name: 'Group as one favourite' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Pair');
  await page.getByRole('button', { name: 'Make group' }).click();

  await expect(page.getByText('Group · 2 runs')).toBeVisible();
  await expect(page.getByText('Follows Pair')).toHaveCount(2);
  if (process.env.SAVED_RUNS_SHOT) await page.screenshot({ path: process.env.SAVED_RUNS_SHOT });
  await page.getByRole('radio', { name: /^Paper/ }).click();
  await expect(page.getByText('Core ETF', { exact: true })).toBeVisible();
  await expect(page.getByText('Sleeve one', { exact: true })).toHaveCount(0);
});
