import { describe, expect, it } from 'vitest';

import {
  type AngelCheck,
  type AngelStatus,
  angelCardState,
  newestCheck,
  resultOf,
  testButton,
} from '../angelOne';

const check = (over: Partial<AngelCheck> = {}): AngelCheck => ({
  checked_at: '2026-10-18T08:00:03+05:30',
  source: 'scheduled',
  ok: true,
  reason: 'ok',
  message: 'Logged in to Angel One SmartAPI.',
  client: 'R1•••56',
  duration_ms: 1200,
  attempted: true,
  ...over,
});

const status = (over: Partial<AngelStatus> = {}): AngelStatus => ({
  configured: true,
  credentials: [],
  client: 'R1•••56',
  last_check: null,
  last_collection: null,
  running: false,
  running_source: null,
  cooldown_s: 60,
  retry_after_s: 0,
  cooldown_until: null,
  hold: null,
  warning: null,
  ...over,
});

const NOW = Date.parse('2026-10-18T10:00:00+05:30');

describe('angelCardState', () => {
  it('reads unknown, not configured, untested, working and failed', () => {
    expect(angelCardState(null, null)).toBe('unknown');
    expect(angelCardState(status({ configured: false }), check())).toBe('not_configured');
    expect(angelCardState(status(), null)).toBe('untested');
    expect(angelCardState(status(), check())).toBe('working');
    expect(angelCardState(status(), check({ ok: false, reason: 'rejected' }))).toBe('failed');
  });
});

describe('newestCheck', () => {
  it('prefers the later check, either way round', () => {
    const early = check({ checked_at: '2026-10-18T08:00:03+05:30' });
    const late = check({ checked_at: '2026-10-18T09:30:00+05:30', source: 'manual' });
    expect(newestCheck(early, late)).toBe(late);
    expect(newestCheck(late, early)).toBe(late);
    expect(newestCheck(null, early)).toBe(early);
    expect(newestCheck(early, null)).toBe(early);
    expect(newestCheck(null, null)).toBeNull();
  });
});

describe('resultOf', () => {
  const started = '2026-10-18T10:00:00+05:30';

  it('waits while the check runs or the status still has an older one', () => {
    expect(resultOf(null, started)).toBeNull();
    expect(resultOf(status({ running: true, last_check: check() }), started)).toBeNull();
    expect(resultOf(status({ last_check: check() }), started)).toBeNull(); // 08:00's
  });

  it('returns the check that started at or after the click', () => {
    const mine = check({ checked_at: started, source: 'manual' });
    expect(resultOf(status({ last_check: mine }), started)).toBe(mine);
  });
});

describe('testButton', () => {
  it('is ready when nothing is running, cooling down or held', () => {
    expect(testButton({ status: status(), testing: false, nowMs: NOW })).toEqual({
      kind: 'ready',
      disabled: false,
      secondsLeft: 0,
    });
  });

  it('counts the cool-down down to an absolute time, so a cached status is not stale', () => {
    const cooling = status({ cooldown_until: '2026-10-18T10:00:42+05:30' });
    expect(testButton({ status: cooling, testing: false, nowMs: NOW })).toEqual({
      kind: 'cooldown',
      disabled: true,
      secondsLeft: 42,
    });
    expect(testButton({ status: cooling, testing: false, nowMs: NOW + 41_500 }).secondsLeft).toBe(
      1,
    );
    expect(testButton({ status: cooling, testing: false, nowMs: NOW + 42_000 }).kind).toBe('ready');
    // an old cached answer whose cool-down is long over
    expect(testButton({ status: cooling, testing: false, nowMs: NOW + 600_000 }).disabled).toBe(
      false,
    );
  });

  it('never counts more than the cool-down, whatever the clocks say', () => {
    const skewed = status({ cooldown_until: '2026-10-18T11:00:00+05:30' });
    expect(testButton({ status: skewed, testing: false, nowMs: NOW }).secondsLeft).toBe(60);
  });

  it('is disabled while a test or a collection holds the login', () => {
    expect(testButton({ status: status(), testing: true, nowMs: NOW }).kind).toBe('testing');
    expect(
      testButton({
        status: status({ running: true, running_source: 'scheduled' }),
        testing: false,
        nowMs: NOW,
      }).kind,
    ).toBe('testing');
    expect(
      testButton({
        status: status({ running: true, running_source: 'collector' }),
        testing: false,
        nowMs: NOW,
      }).kind,
    ).toBe('collecting');
  });

  it('is held after a refused login until the hold ends', () => {
    const held = status({
      hold: { until: '2026-10-18T10:10:00+05:30', message: 'Angel One refused the login …' },
    });
    expect(testButton({ status: held, testing: false, nowMs: NOW })).toMatchObject({
      kind: 'held',
      disabled: true,
    });
    expect(testButton({ status: held, testing: false, nowMs: NOW + 600_000 }).kind).toBe('ready');
  });

  it('is disabled when the credentials are not configured', () => {
    expect(
      testButton({ status: status({ configured: false }), testing: false, nowMs: NOW }).disabled,
    ).toBe(true);
  });
});
