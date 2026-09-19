import { describe, expect, it, vi } from 'vitest';
import { FixedClock, RealClock, VirtualClock } from '../clock';

// IST = UTC+5:30.
// All IST epoch values below were computed as:
//   Date.UTC(year, month-1, day, hour, minute, second) where hour:minute is UTC.
//
// The acceptance criteria in the task spec listed epoch literals that were off by ~1 year
// (they resolved to 2025 dates, not 2026). The values below are the correct 2026 epochs
// that match the described UTC/IST times.

describe('FixedClock', () => {
  describe('today() — IST midnight boundary', () => {
    // 2026-05-28 03:00:00 UTC = 2026-05-28 08:30:00 IST → well inside the day
    const IST_MID_DAY_MAY28 = 1779937200000; // Date.UTC(2026, 4, 28, 3, 0, 0)

    // 2026-05-27 18:30:00 UTC = 2026-05-28 00:00:00 IST → exactly midnight
    const IST_MIDNIGHT_MAY28 = 1779906600000; // Date.UTC(2026, 4, 27, 18, 30, 0)

    // 2026-05-27 18:29:59 UTC = 2026-05-27 23:59:59 IST → one second before midnight
    const IST_BEFORE_MIDNIGHT = 1779906599000; // Date.UTC(2026, 4, 27, 18, 29, 59)

    it('returns the correct IST date for a timestamp mid-day (2026-05-28 08:30 IST)', () => {
      const clock = new FixedClock(IST_MID_DAY_MAY28);
      expect(clock.today()).toBe('2026-05-28');
    });

    it('returns 2026-05-28 at exactly IST midnight (00:00:00 IST = 18:30 UTC prior day)', () => {
      const clock = new FixedClock(IST_MIDNIGHT_MAY28);
      expect(clock.today()).toBe('2026-05-28');
    });

    it('returns 2026-05-27 one second before IST midnight (23:59:59 IST)', () => {
      const clock = new FixedClock(IST_BEFORE_MIDNIGHT);
      expect(clock.today()).toBe('2026-05-27');
    });

    it('accepts an ISO string in addition to epoch ms', () => {
      // ISO string interpreted as UTC by the Date constructor.
      const clock = new FixedClock('2026-05-28T03:00:00.000Z');
      expect(clock.today()).toBe('2026-05-28');
    });
  });

  describe('now()', () => {
    it('always returns the fixed epoch ms', () => {
      const clock = new FixedClock(IST_MIDNIGHT_MAY28_EPOCH);
      expect(clock.now()).toBe(IST_MIDNIGHT_MAY28_EPOCH);
      expect(clock.now()).toBe(IST_MIDNIGHT_MAY28_EPOCH); // idempotent
    });
  });

  describe('toISTDate()', () => {
    it('converts an arbitrary epoch ms to IST date', () => {
      const clock = new FixedClock(0); // base epoch doesn't affect toISTDate
      // 2026-05-27 18:30:00 UTC = 2026-05-28 00:00:00 IST
      expect(clock.toISTDate(1779906600000)).toBe('2026-05-28');
      // 2026-05-27 18:29:59 UTC = 2026-05-27 23:59:59 IST
      expect(clock.toISTDate(1779906599000)).toBe('2026-05-27');
    });
  });

  describe('toISTTime()', () => {
    it('returns time as HH:mm:ss in IST', () => {
      const clock = new FixedClock(0);
      // 2026-05-27 18:30:00 UTC = 2026-05-28 00:00:00 IST
      expect(clock.toISTTime(1779906600000)).toBe('00:00:00');
      // 2026-05-27 18:29:59 UTC = 2026-05-27 23:59:59 IST
      expect(clock.toISTTime(1779906599000)).toBe('23:59:59');
    });
  });
});

// Re-export a constant we want to reuse in multiple describe blocks (define it here,
// above the block that first uses it in now() tests, to avoid TDZ issues).
const IST_MIDNIGHT_MAY28_EPOCH = 1779906600000;

describe('VirtualClock', () => {
  describe('now() and advance()', () => {
    it('starts at the given epoch', () => {
      const clock = new VirtualClock(1000);
      expect(clock.now()).toBe(1000);
    });

    it('advances by the given ms', () => {
      const clock = new VirtualClock(1000);
      clock.advance(500);
      expect(clock.now()).toBe(1500);
      clock.advance(200);
      expect(clock.now()).toBe(1700);
    });
  });

  describe('tick() — callback fires exactly when interval boundary is crossed', () => {
    it('does not fire before the first boundary', () => {
      const clock = new VirtualClock(0);
      let count = 0;
      clock.tick(1000, () => {
        count++;
      });

      clock.advance(999); // still within the first interval [0, 999]
      expect(count).toBe(0);
    });

    it('fires exactly once when the first boundary is crossed', () => {
      const clock = new VirtualClock(0);
      let count = 0;
      clock.tick(1000, () => {
        count++;
      });

      clock.advance(1000); // crosses boundary at t=1000
      expect(count).toBe(1);
    });

    it('fires again on each subsequent boundary crossing', () => {
      const clock = new VirtualClock(0);
      let count = 0;
      clock.tick(1000, () => {
        count++;
      });

      clock.advance(1000); // t=1000 → 1 crossing
      clock.advance(1000); // t=2000 → 1 crossing
      clock.advance(999); // t=2999 → 0 crossings (still inside [2000,2999])
      expect(count).toBe(2);
    });

    it('fires multiple times if a single advance skips multiple boundaries', () => {
      const clock = new VirtualClock(0);
      let count = 0;
      clock.tick(1000, () => {
        count++;
      });

      // Jumps from 0 to 5000 — crosses boundaries at 1000, 2000, 3000, 4000, 5000
      clock.advance(5000);
      expect(count).toBe(5);
    });

    it('supports multiple callbacks at different intervals', () => {
      const clock = new VirtualClock(0);
      let fastCount = 0;
      let slowCount = 0;
      clock.tick(1000, () => {
        fastCount++;
      });
      clock.tick(3000, () => {
        slowCount++;
      });

      clock.advance(3000); // fast: 3 crossings; slow: 1 crossing
      expect(fastCount).toBe(3);
      expect(slowCount).toBe(1);

      clock.advance(3000); // t=6000; fast: +3; slow: +1
      expect(fastCount).toBe(6);
      expect(slowCount).toBe(2);
    });

    it('fires callback registered at a later tick count with correct independence', () => {
      // Verify that each callback tracks its own interval independently.
      const clock = new VirtualClock(0);
      let a = 0;
      let b = 0;
      clock.tick(2000, () => {
        a++;
      });
      clock.tick(5000, () => {
        b++;
      });

      clock.advance(10000); // a: floors at 0,2,4,6,8,10 → 5 crossings; b: floors at 0,5,10 → 2 crossings
      expect(a).toBe(5);
      expect(b).toBe(2);
    });
  });

  describe('today() reflects the virtual clock time in IST', () => {
    it('returns the correct IST date for the virtual clock timestamp', () => {
      // 2026-05-27 18:30:00 UTC = 2026-05-28 00:00:00 IST
      const clock = new VirtualClock(1779906600000);
      expect(clock.today()).toBe('2026-05-28');
    });

    it('updates today() after advance()', () => {
      // Start just before midnight IST on 2026-05-28
      const clock = new VirtualClock(1779906599000); // 23:59:59 IST = 2026-05-27
      expect(clock.today()).toBe('2026-05-27');

      clock.advance(1000); // crosses IST midnight → now 2026-05-28 00:00:00 IST
      expect(clock.today()).toBe('2026-05-28');
    });
  });
});

describe('RealClock', () => {
  it('now() returns a positive number close to the current wall-clock time', () => {
    const before = Date.now();
    const clock = new RealClock();
    const ts = clock.now();
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('today() returns a string matching YYYY-MM-DD format', () => {
    const clock = new RealClock();
    expect(clock.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('toISTDate() returns a string matching YYYY-MM-DD format', () => {
    const clock = new RealClock();
    expect(clock.toISTDate(Date.now())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('toISTTime() returns a string matching HH:mm:ss format', () => {
    const clock = new RealClock();
    expect(clock.toISTTime(Date.now())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
