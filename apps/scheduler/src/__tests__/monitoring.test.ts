import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fyersTokenCheck } from '../checks/fyers.js';
import { History } from '../history.js';
import { JOBS, findJob } from '../jobs.js';
import { catchUpCheck } from '../summary.js';

describe('BL-143: catch-ups after sleep in the morning summary', () => {
  it("lists the previous day's catch-up runs, due and ran, as one problem line", () => {
    const history = new History(join(mkdtempSync(join(tmpdir(), 'bl143-')), 'scheduler.db'));
    const slot = new Date('2026-10-19T11:10:00Z'); // 16:40 IST
    const late = history.start(
      'algotest-evening',
      'catch-up',
      slot,
      '/x',
      new Date('2026-10-19T14:57:00Z'),
    );
    history.finish(late, 0, 1, new Date('2026-10-19T15:00:00Z'));
    const onTime = history.start(
      'quantiply-evening',
      'schedule',
      slot,
      '/x',
      new Date('2026-10-19T11:15:00Z'),
    );
    history.finish(onTime, 0, 1, new Date('2026-10-19T11:16:00Z'));
    const rows = history.catchUpsBetween(
      new Date('2026-10-18T18:30:00Z'),
      new Date('2026-10-19T18:30:00Z'),
    );
    expect(rows.map((r) => r.job)).toEqual(['algotest-evening']);
    const check = catchUpCheck(rows);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('algotest-evening (due 16:40, ran 20:27)');
    expect(check?.detail).toContain('deploy/launchd/README.md');
    expect(catchUpCheck([])).toBeNull();
    history.close();
  });
});

describe('BL-143: the 09:00 Fyers token reminder', () => {
  const runner = (code: number, output: string) => () => ({ code, output });

  it('is quiet with a valid token', () => {
    const r = fyersTokenCheck(
      runner(0, 'ok: token from dashboard, expires 2026-10-21 06:00 IST'),
      '/m',
    );
    expect(r.ok).toBe(true);
  });

  it('alerts when the token is missing or expired, with the reason', () => {
    const r = fyersTokenCheck(runner(1, 'not ready: no Fyers token found'), '/m');
    expect(r).toEqual({
      ok: false,
      detail: 'No valid Fyers token for today: no Fyers token found',
    });
    const crash = fyersTokenCheck(runner(127, 'spawnSync uv ENOENT'), '/m');
    expect(crash.ok).toBe(false);
    expect(crash.detail).toContain('ENOENT');
  });

  it('runs at 09:00 on trading days, on by default', () => {
    const job = findJob('fyers-token-reminder');
    expect(job?.schedule.at).toBe('09:00');
    expect(job?.builtin).toBe('fyers-token-reminder');
  });
});

describe('BL-143: the trade monitor job', () => {
  it('starts 09:04, outside the quantiply group, and never retries a held login', () => {
    const job = findJob('trade-monitor');
    expect(job?.schedule.at).toBe('09:04');
    expect(job?.group).toBeUndefined();
    expect(job?.noRetryExitCodes).toEqual([3]);
    expect(job?.steps).toEqual([
      ['/usr/bin/caffeinate', '-i', 'node_modules/.bin/tsx', 'src/trade-monitor.ts'],
    ]);
    // 09:04 + the timeout covers the session's end (15:30)
    expect((job?.timeoutMinutes ?? 0) >= 15 * 60 + 30 - (9 * 60 + 4)).toBe(true);
    expect(JOBS.filter((j) => j.id === 'trade-monitor')).toHaveLength(1);
  });
});
