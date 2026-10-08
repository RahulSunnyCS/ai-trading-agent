import { type Page, expect, test } from '@playwright/test';

/** BL-051 Phase 2: This week — timeline, needs attention, rules, favourites, the signal table. */

const lookbacks = [1, 2, 4, 8, 13, 26, 52];
const byLookback = (value: number) => Object.fromEntries(lookbacks.map((w) => [String(w), value]));

function stock(symbol: string, score: number) {
  return {
    symbol,
    company_name: `${symbol} Ltd`,
    parent_group: 'Capital Markets',
    subgroup: 'Exchanges',
    tags: [{ parent_group: 'Capital Markets', subgroup: 'Exchanges' }],
    last_price: 100,
    change_1w_pct: 0.01,
    returns: byLookback(0.1),
    scores: byLookback(score),
    composite_rank: 3,
    composite_rank_prev: 5,
    high_52w_gap: -0.02,
    spark: Array.from({ length: 26 }, (_, i) => 100 + i),
  };
}

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function mockThisWeek(page: Page): Promise<void> {
  await page.route(/\/api\/momentum\/weekly\/jobs\/latest/, (route) =>
    route.fulfill(json({ job: null })),
  );
  await page.route(/\/api\/momentum\/weekly\/status/, (route) =>
    route.fulfill(
      json({
        today: '2026-12-04',
        target_week: '2026-12-04',
        datasets: [
          {
            key: 'etf',
            label: 'Index & ETF prices',
            through: '2026-12-04',
            ready: true,
            note: '',
            error: null,
          },
          {
            key: 'stock',
            label: 'NSE bhavcopy stock data',
            through: '2026-12-04',
            ready: true,
            note: '',
            error: null,
          },
        ],
        signals: [],
        schedule: [
          {
            run: 'preview',
            when: 'Fri 14:40 IST',
            last_ran_at: '2026-12-04T14:41:00+05:30',
            last_line: null,
            ran_late_by_minutes: null,
          },
          {
            run: 'final',
            when: 'Fri 16:45 IST',
            last_ran_at: '2026-12-04T16:47:00+05:30',
            last_line: null,
            ran_late_by_minutes: null,
          },
          {
            run: 'stock-ingest',
            when: 'Fri 19:30 IST',
            last_ran_at: '2026-12-04T19:38:00+05:30',
            last_line: null,
            ran_late_by_minutes: null,
          },
          {
            run: 'journal-check',
            when: 'Fri 21:00 IST',
            last_ran_at: null,
            last_line: null,
            ran_late_by_minutes: null,
          },
          {
            run: 'live-rules',
            when: 'Fri 21:30 IST',
            last_ran_at: null,
            last_line: null,
            ran_late_by_minutes: null,
          },
        ],
      }),
    ),
  );
  await page.route(/\/api\/momentum\/stock-actions/, (route) =>
    route.fulfill(
      json({
        manual_review_after: '2026-10-01',
        pending_count: 1,
        counts: {},
        items: [
          {
            symbol: 'KAYNES',
            ex_date: '2026-12-02',
            previous_close: 10478,
            close: 5384.5,
            previous_volume: 1000,
            volume: 2100,
            previous_turnover: 10,
            turnover: 11,
            implied_factor: 1.95,
            suggested_factor: 2,
            confirmed_factor: null,
            cumulative_factor: 1,
            status: 'review',
            event_kind: null,
            subject: null,
          },
        ],
      }),
    ),
  );
  await page.route(/\/api\/momentum\/journal/, (route) =>
    route.fulfill(
      json({ available: true, weeks: [], week: '2026-12-04', entries: [], check: null }),
    ),
  );
  await page.route(/\/api\/momentum\/live-rules$/, (route) =>
    route.fulfill(
      json({
        job: null,
        report: {
          checked_at: '2026-11-27T21:31:00+05:30',
          severity: 'info',
          title: 'Live rules check: no rule breached',
          stage: 'paper',
          week: '2026-11-27',
          weeks: 8,
          breached: false,
          stale: null,
          numbers: {
            drawdown: -0.062,
            worst_drawdown: -0.08,
            cut_half_at: 0.2,
            exit_at: 0.3,
            weeks: 8,
            min_paper_weeks: 13,
            return: 0.048,
            benchmark_return: 0.017,
            must_beat: 'Nifty200 Momentum 30 TRI',
            trailing_window_weeks: 13,
            review_when_behind_pts: 5,
          },
          findings: [
            {
              rule: 'drawdown',
              level: 'ok',
              title: 'Drawdown within limits',
              detail: '-6.2% from the peak.',
              action: null,
              needs_you: false,
            },
            {
              rule: 'trailing',
              level: 'unmeasurable',
              title: 'Trailing rule not measurable yet',
              detail: 'Needs the journal scored week by week.',
              action: null,
              needs_you: false,
            },
            {
              rule: 'money_gate',
              level: 'pending',
              title: 'Money gate: not yet',
              detail: 'weeks 8 of 13',
              action: null,
              needs_you: false,
            },
          ],
        },
      }),
    ),
  );
  await page.route(/\/api\/momentum\/favorite-strategies/, (route) =>
    route.fulfill(
      json([
        {
          id: 'g',
          name: 'Phase 6 ensemble',
          active: true,
          status: 'paper',
          group: ['a', 'b'],
          member_of: null,
          config: { dataset: 'broad' },
          members: [],
        },
      ]),
    ),
  );
  await page.route(/\/api\/momentum\/scores$/, (route) =>
    route.fulfill(
      json({
        as_of: '2026-12-04',
        universe_size: 2,
        lookbacks,
        missing_symbols: [],
        stocks: [stock('BSE', 95), stock('ANGELONE', 88)],
        sectors: [],
      }),
    ),
  );
  await page.route(/\/api\/momentum\/week(\?.*)?$/, (route) =>
    route.fulfill(
      json({
        week: '2026-12-04',
        target_week: '2026-12-04',
        weeks: ['2026-12-04', '2026-11-27'],
        message: {
          week: '2026-12-04',
          run: 'final',
          title: 'Momentum FINAL — Phase 6 ensemble — week of 04 Dec 2026',
          body: 'Phase 6 ensemble · 2 sleeves\nSleeves trading: a (4w, ph1)\n• ANGELONE — BUY → 12.5%\nHolds 2 names after these trades · cash 0.0%',
          sent: true,
          headline: 'Phase 6 ensemble',
          at: '2026-12-04T19:41:00+05:30',
        },
        favourites: [
          {
            id: 'g',
            name: 'Phase 6 ensemble',
            status: 'paper',
            headline: true,
            dataset: 'broad',
            group: true,
            sleeves: [
              {
                id: 'a',
                name: 'Phase 6 ensemble a (4w, ph1)',
                on_cadence: true,
                every: 4,
                next: '2027-01-01',
              },
              {
                id: 'b',
                name: 'Phase 6 ensemble b (4w, ph2)',
                on_cadence: false,
                every: 4,
                next: '2026-12-11',
              },
            ],
            run: 'final',
            recorded_at: '2026-12-04T14:10:00Z',
            blocked: null,
            rows: [
              {
                asset: 'COCHINSHIP',
                action: 'SELL',
                rank: null,
                held: true,
                before: 0.08,
                after: 0,
                sleeves: ['a'],
              },
              {
                asset: 'ANGELONE',
                action: 'BUY',
                rank: 4,
                held: false,
                before: 0,
                after: 0.125,
                sleeves: ['a'],
              },
              {
                asset: 'BSE',
                action: 'HOLD',
                rank: 1,
                held: true,
                before: 0.15,
                after: 0.15,
                sleeves: ['a', 'b'],
              },
            ],
            held: ['ANGELONE', 'BSE'],
            cash: 0,
            exit_rank: null,
            explain: null,
            edge: {
              sleeve: 'Phase 6 ensemble b (4w, ph2)',
              on: '2026-12-11',
              weakest_held: [{ asset: 'EICHERMOT', rank: 19, rank_prev: 14 }],
              strongest_not_held: [{ asset: 'CGPOWER', rank: 2, rank_prev: 9 }],
            },
            since_preview: null,
            trades: 2,
            shared_with_headline: null,
          },
          {
            id: 'w',
            name: 'ETF Weekly Core',
            status: 'watching',
            headline: false,
            dataset: 'etf',
            group: false,
            sleeves: null,
            run: 'final',
            recorded_at: '2026-12-04T11:17:00Z',
            blocked: null,
            rows: [
              { asset: 'Gold', action: 'BUY', rank: 1, rank_prev: 4, held: false, after: 0.33 },
            ],
            held: ['Gold'],
            cash: null,
            exit_rank: 5,
            explain: 'Rebalance week.',
            edge: { sleeve: null, on: null, weakest_held: [], strongest_not_held: [] },
            since_preview: { added: [{ asset: 'Gold', action: 'BUY' }], dropped: [] },
            trades: 1,
            shared_with_headline: 0,
          },
        ],
      }),
    ),
  );
}

test('This week shows the day, what needs you, the rules and every favourite', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-04T14:20:00Z')); // 19:50 IST
  await mockThisWeek(page);
  await page.goto('/momentum/week');

  await expect(page.getByText('Friday 04 Dec 2026')).toBeVisible();
  await expect(page.getByText('Stock data + final')).toBeVisible();
  await expect(page.getByText('KAYNES fell 48.6% on 2026-12-02')).toBeVisible();
  await expect(page.getByText('8 / 13 weeks')).toBeVisible();
  await expect(page.getByRole('button', { name: /Phase 6 ensemble/ }).first()).toBeVisible();
  await expect(page.getByText('Names at the edge')).toBeVisible();
  await expect(page.getByText('Holds 2 names after these trades', { exact: false })).toBeVisible();
  if (process.env.THIS_WEEK_SHOT)
    await page.screenshot({ path: process.env.THIS_WEEK_SHOT, fullPage: true });

  // Another favourite's table, and what the final changed against the preview.
  await page.getByRole('button', { name: /ETF Weekly Core/ }).click();
  await expect(page).toHaveURL(/fav=w/);
  await expect(page.getByText('Since the 14:40 preview')).toBeVisible();
  await expect(
    page.getByText('1 to go', { exact: false }).or(page.getByText('4 to go')),
  ).toBeVisible();

  // Needs attention opens the split drawer; the old Weekly signal link lands here.
  await page.getByRole('button', { name: 'Classify…' }).click();
  await expect(page.getByRole('dialog', { name: 'Classify a possible split' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/momentum/weekly');
  await expect(page).toHaveURL(/\/momentum\/week$/);
});
