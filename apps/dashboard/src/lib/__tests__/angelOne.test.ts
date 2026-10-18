import { describe, expect, it } from 'vitest';

import {
  type AngelCheck,
  type AngelStatus,
  angelCardState,
  cooldownEndsAt,
  newestCheck,
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
  cooldown_s: 60,
  retry_after_s: 0,
  warning: null,
  ...over,
});

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

describe('testButton', () => {
  const received = 1_000_000;

  it('is enabled when nothing is running and the cool-down is over', () => {
    expect(
      testButton({
        configured: true,
        testing: false,
        running: false,
        endsAtMs: cooldownEndsAt(status(), received),
        nowMs: received,
      }),
    ).toEqual({ disabled: false, label: 'Test connection', secondsLeft: 0 });
  });

  it('counts the cool-down down from when the status arrived', () => {
    const endsAt = cooldownEndsAt(status({ retry_after_s: 42 }), received);
    const base = { configured: true, testing: false, running: false, endsAtMs: endsAt };
    expect(testButton({ ...base, nowMs: received })).toEqual({
      disabled: true,
      label: 'Wait 42 s',
      secondsLeft: 42,
    });
    expect(testButton({ ...base, nowMs: received + 41_500 }).label).toBe('Wait 1 s');
    expect(testButton({ ...base, nowMs: received + 42_000 }).disabled).toBe(false);
  });

  it('is disabled while a test runs here or anywhere else', () => {
    const base = { configured: true, endsAtMs: 0, nowMs: received };
    expect(testButton({ ...base, testing: true, running: false })).toMatchObject({
      disabled: true,
      label: 'Testing…',
    });
    expect(testButton({ ...base, testing: false, running: true }).disabled).toBe(true);
  });

  it('is disabled when the credentials are not configured', () => {
    expect(
      testButton({ configured: false, testing: false, running: false, endsAtMs: 0, nowMs: 0 })
        .disabled,
    ).toBe(true);
  });
});
