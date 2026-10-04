import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findRunSince, istClock, shouldDispatch } from './dispatch-rules.js';

const MON = 1;

test('dispatches on a weekday from 07:45 through 15:35', () => {
  assert.equal(shouldDispatch({ weekday: MON, minutes: 8 * 60 }), true);
  assert.equal(shouldDispatch({ weekday: MON, minutes: 7 * 60 + 45 }), true);
  assert.equal(shouldDispatch({ weekday: 5, minutes: 15 * 60 + 35 }), true);
});

test('a wake outside the login window does not dispatch', () => {
  assert.equal(shouldDispatch({ weekday: MON, minutes: 38 }), false);
  assert.equal(shouldDispatch({ weekday: MON, minutes: 7 * 60 + 44 }), false);
  assert.equal(shouldDispatch({ weekday: MON, minutes: 15 * 60 + 36 }), false);
});

test('a weekend wake after a missed Friday does not dispatch', () => {
  assert.equal(shouldDispatch({ weekday: 6, minutes: 10 * 60 }), false);
  assert.equal(shouldDispatch({ weekday: 0, minutes: 10 * 60 }), false);
});

test('istClock converts from UTC regardless of the host timezone', () => {
  // Tue 2026-10-06 02:30 UTC = Tue 08:00 IST.
  assert.deepEqual(istClock(new Date('2026-10-06T02:30:00Z')), { weekday: 2, minutes: 8 * 60 });
  // Mon 2026-10-05 19:00 UTC = Tue 00:30 IST: the IST date has already rolled over.
  assert.deepEqual(istClock(new Date('2026-10-05T19:00:00Z')), { weekday: 2, minutes: 30 });
});

test('findRunSince only accepts a run created after the request', () => {
  const since = Date.parse('2026-10-06T02:30:00Z');
  const stale = { createdAt: '2026-10-05T02:30:05Z', url: 'https://example.test/1' };
  const fresh = { createdAt: '2026-10-06T02:30:04Z', url: 'https://example.test/2' };
  assert.equal(findRunSince([stale], since), null);
  assert.equal(findRunSince([], since), null);
  assert.deepEqual(findRunSince([fresh, stale], since), fresh);
});
