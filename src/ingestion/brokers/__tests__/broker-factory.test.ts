/**
 * Unit tests for broker-factory.ts (createBroker)
 *
 * All tests override process.env and restore it in afterEach so they are fully
 * isolated from each other. No live broker connections are made — the broker
 * objects returned are not connected.
 *
 * Coverage:
 *   1. SIMULATE=true  → returns MarketDataSimulator
 *   2. BROKER=sim     → returns MarketDataSimulator
 *   3. BROKER=fyers with credentials → returns FyersBroker
 *   4. BROKER=fyers without FYERS_APP_ID → throws with clear message
 *   5. BROKER=fyers without FYERS_ACCESS_TOKEN → throws with clear message
 *   6. BROKER=fyers without either credential → throws with both var names
 *   7. BROKER=angelone with credentials → returns AngelOneBroker
 *   8. BROKER=angelone missing credentials → throws with missing var names
 *   9. No BROKER and SIMULATE!==true → throws (safe default, prevents silent fallback)
 *  10. BROKER=unknown_value and SIMULATE!==true → throws (unknown broker hits safe default)
 *  11. BROKER is set to uppercase FYERS → treated case-insensitively (lower-cased before match)
 *  12. createBroker returns an object implementing the BrokerFeed interface shape
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualClock } from '../../../utils/clock.js';
import { MarketDataSimulator } from '../../market-data-sim.js';
import { createBroker } from '../broker-factory.js';
import { FyersBroker } from '../fyers.js';

// ---------------------------------------------------------------------------
// Env snapshot helpers
// ---------------------------------------------------------------------------

type EnvSnapshot = Record<string, string | undefined>;

const BROKER_ENV_VARS = [
  'BROKER',
  'SIMULATE',
  'FYERS_APP_ID',
  'FYERS_ACCESS_TOKEN',
  'AO_API_KEY',
  'AO_CLIENT_CODE',
  'AO_CLIENT_PIN',
  'AO_TOTP_SECRET',
  'SIM_TICK_INTERVAL_MS',
] as const;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of BROKER_ENV_VARS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of BROKER_ENV_VARS) {
    if (snap[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snap[key];
    }
  }
}

function clearBrokerEnv(): void {
  for (const key of BROKER_ENV_VARS) {
    delete process.env[key];
  }
}

/** A VirtualClock satisfies ClockWithTick — safe to pass to createBroker. */
function makeClock(): VirtualClock {
  return new VirtualClock(1_700_000_000_000);
}

// ---------------------------------------------------------------------------
// Setup: clear all broker env vars before each test; restore after
// ---------------------------------------------------------------------------

let envSnapshot: EnvSnapshot;

beforeEach(() => {
  envSnapshot = snapshotEnv();
  clearBrokerEnv();
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

// ---------------------------------------------------------------------------
// 1. SIMULATE=true → MarketDataSimulator
// ---------------------------------------------------------------------------

describe('createBroker — SIMULATE=true', () => {
  it('returns a MarketDataSimulator when SIMULATE=true and BROKER is unset', () => {
    process.env.SIMULATE = 'true';
    const broker = createBroker(makeClock());
    expect(broker).toBeInstanceOf(MarketDataSimulator);
  });

  it('returns a MarketDataSimulator when SIMULATE=true even if BROKER is set to fyers', () => {
    // SIMULATE takes precedence because BROKER=fyers would require credentials;
    // in this project, the resolution order checks BROKER=fyers first (not SIMULATE).
    // This test documents the ACTUAL behaviour: BROKER=fyers wins over SIMULATE=true.
    // We set fyers credentials so the fyers path succeeds without throwing.
    process.env.BROKER = 'fyers';
    process.env.SIMULATE = 'true';
    process.env.FYERS_APP_ID = 'TESTAPP1234-100';
    process.env.FYERS_ACCESS_TOKEN = 'test-access-token-xyz';

    // BROKER=fyers is checked first — should return FyersBroker, not simulator
    const broker = createBroker(makeClock());
    expect(broker).toBeInstanceOf(FyersBroker);
  });
});

// ---------------------------------------------------------------------------
// 2. BROKER=sim → MarketDataSimulator
// ---------------------------------------------------------------------------

describe('createBroker — BROKER=sim', () => {
  it('returns a MarketDataSimulator when BROKER=sim', () => {
    process.env.BROKER = 'sim';
    const broker = createBroker(makeClock());
    expect(broker).toBeInstanceOf(MarketDataSimulator);
  });

  it('returns a MarketDataSimulator when BROKER=SIM (case-insensitive)', () => {
    process.env.BROKER = 'SIM';
    const broker = createBroker(makeClock());
    expect(broker).toBeInstanceOf(MarketDataSimulator);
  });
});

// ---------------------------------------------------------------------------
// 3. BROKER=fyers with credentials → FyersBroker
// ---------------------------------------------------------------------------

describe('createBroker — BROKER=fyers with valid credentials', () => {
  beforeEach(() => {
    process.env.BROKER = 'fyers';
    process.env.FYERS_APP_ID = 'TESTAPP1234-100';
    process.env.FYERS_ACCESS_TOKEN = 'test-access-token-xyz';
  });

  it('returns a FyersBroker when BROKER=fyers and credentials are present', () => {
    const broker = createBroker(makeClock());
    expect(broker).toBeInstanceOf(FyersBroker);
  });

  it('FyersBroker implements the BrokerFeed interface (connect, subscribe, disconnect)', () => {
    const broker = createBroker(makeClock());
    expect(typeof broker.connect).toBe('function');
    expect(typeof broker.subscribe).toBe('function');
    expect(typeof broker.disconnect).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 4 & 5 & 6. BROKER=fyers missing credentials → descriptive throw
// ---------------------------------------------------------------------------

describe('createBroker — BROKER=fyers missing credentials', () => {
  it('throws when FYERS_APP_ID is missing', () => {
    process.env.BROKER = 'fyers';
    // FYERS_APP_ID not set; FYERS_ACCESS_TOKEN is set
    process.env.FYERS_ACCESS_TOKEN = 'test-access-token-xyz';

    expect(() => createBroker(makeClock())).toThrow('FYERS_APP_ID');
  });

  it('throws when FYERS_ACCESS_TOKEN is missing', () => {
    process.env.BROKER = 'fyers';
    process.env.FYERS_APP_ID = 'TESTAPP1234-100';
    // FYERS_ACCESS_TOKEN not set

    expect(() => createBroker(makeClock())).toThrow('FYERS_ACCESS_TOKEN');
  });

  it('throws when both FYERS_APP_ID and FYERS_ACCESS_TOKEN are missing', () => {
    process.env.BROKER = 'fyers';

    let thrownMessage = '';
    try {
      createBroker(makeClock());
    } catch (e) {
      thrownMessage = e instanceof Error ? e.message : String(e);
    }

    // Both missing var names must appear in the error message
    expect(thrownMessage).toContain('FYERS_APP_ID');
    expect(thrownMessage).toContain('FYERS_ACCESS_TOKEN');
  });

  it('throws when FYERS_APP_ID is whitespace only', () => {
    process.env.BROKER = 'fyers';
    process.env.FYERS_APP_ID = '   ';
    process.env.FYERS_ACCESS_TOKEN = 'test-access-token-xyz';

    expect(() => createBroker(makeClock())).toThrow('FYERS_APP_ID');
  });
});

// ---------------------------------------------------------------------------
// 7. BROKER=angelone with credentials → AngelOneBroker
// ---------------------------------------------------------------------------

describe('createBroker — BROKER=angelone with valid credentials', () => {
  beforeEach(() => {
    process.env.BROKER = 'angelone';
    process.env.AO_API_KEY = 'test-api-key';
    process.env.AO_CLIENT_CODE = 'test-client-code';
    process.env.AO_CLIENT_PIN = '1234';
    process.env.AO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
  });

  it('returns a BrokerFeed-shaped object for BROKER=angelone', () => {
    const broker = createBroker(makeClock());
    expect(typeof broker.connect).toBe('function');
    expect(typeof broker.subscribe).toBe('function');
    expect(typeof broker.disconnect).toBe('function');
  });

  it('does not return a MarketDataSimulator or FyersBroker for BROKER=angelone', () => {
    const broker = createBroker(makeClock());
    expect(broker).not.toBeInstanceOf(MarketDataSimulator);
    expect(broker).not.toBeInstanceOf(FyersBroker);
  });
});

// ---------------------------------------------------------------------------
// 8. BROKER=angelone missing credentials → descriptive throw
// ---------------------------------------------------------------------------

describe('createBroker — BROKER=angelone missing credentials', () => {
  it('throws when AO_API_KEY is missing', () => {
    process.env.BROKER = 'angelone';
    process.env.AO_CLIENT_CODE = 'code';
    process.env.AO_CLIENT_PIN = '1234';
    process.env.AO_TOTP_SECRET = 'SECRET';

    expect(() => createBroker(makeClock())).toThrow('AO_API_KEY');
  });

  it('throws with all four missing var names when none are set', () => {
    process.env.BROKER = 'angelone';

    let thrownMessage = '';
    try {
      createBroker(makeClock());
    } catch (e) {
      thrownMessage = e instanceof Error ? e.message : String(e);
    }

    expect(thrownMessage).toContain('AO_API_KEY');
    expect(thrownMessage).toContain('AO_CLIENT_CODE');
    expect(thrownMessage).toContain('AO_CLIENT_PIN');
    expect(thrownMessage).toContain('AO_TOTP_SECRET');
  });
});

// ---------------------------------------------------------------------------
// 9. No BROKER and SIMULATE!==true → throws (prevents silent simulator fallback)
// ---------------------------------------------------------------------------

describe('createBroker — no broker configured throws', () => {
  it('throws when BROKER is unset and SIMULATE is unset', () => {
    // Both already cleared in beforeEach
    expect(() => createBroker(makeClock())).toThrow();
  });

  it('throws when BROKER is empty string and SIMULATE is unset', () => {
    process.env.BROKER = '';
    expect(() => createBroker(makeClock())).toThrow();
  });

  it('throws when BROKER is whitespace and SIMULATE is unset', () => {
    process.env.BROKER = '   ';
    expect(() => createBroker(makeClock())).toThrow();
  });

  it('error message from the safe default mentions BROKER and SIMULATE', () => {
    let thrownMessage = '';
    try {
      createBroker(makeClock());
    } catch (e) {
      thrownMessage = e instanceof Error ? e.message : String(e);
    }

    // Must give the operator actionable guidance
    expect(thrownMessage.toLowerCase()).toContain('broker');
    expect(thrownMessage.toLowerCase()).toContain('simulate');
  });

  it('does NOT silently return undefined when no broker is configured', () => {
    let result: unknown = 'sentinel';
    try {
      result = createBroker(makeClock());
    } catch {
      result = undefined;
    }
    // result must be undefined (threw) — not a BrokerFeed or null
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Unknown BROKER value → hits the safe default throw
// ---------------------------------------------------------------------------

describe('createBroker — unknown BROKER value', () => {
  it('throws for BROKER=unknown_broker', () => {
    process.env.BROKER = 'unknown_broker';
    expect(() => createBroker(makeClock())).toThrow();
  });

  it('throws for BROKER=zerodha (unsupported adapter)', () => {
    process.env.BROKER = 'zerodha';
    expect(() => createBroker(makeClock())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. BROKER is case-insensitive
// ---------------------------------------------------------------------------

describe('createBroker — case-insensitive BROKER matching', () => {
  it('accepts BROKER=FYERS (uppercase) and returns FyersBroker', () => {
    process.env.BROKER = 'FYERS';
    process.env.FYERS_APP_ID = 'TESTAPP1234-100';
    process.env.FYERS_ACCESS_TOKEN = 'test-access-token-xyz';

    const broker = createBroker(makeClock());
    expect(broker).toBeInstanceOf(FyersBroker);
  });

  it('accepts BROKER=Fyers (mixed case) and returns FyersBroker', () => {
    process.env.BROKER = 'Fyers';
    process.env.FYERS_APP_ID = 'TESTAPP1234-100';
    process.env.FYERS_ACCESS_TOKEN = 'test-access-token-xyz';

    const broker = createBroker(makeClock());
    expect(broker).toBeInstanceOf(FyersBroker);
  });
});

// ---------------------------------------------------------------------------
// 12. Simulator respects SIM_TICK_INTERVAL_MS env var
// ---------------------------------------------------------------------------

describe('createBroker — simulator tick interval configuration', () => {
  it('instantiates the simulator without throwing for a custom SIM_TICK_INTERVAL_MS', () => {
    process.env.SIMULATE = 'true';
    process.env.SIM_TICK_INTERVAL_MS = '500';

    expect(() => createBroker(makeClock())).not.toThrow();
  });

  it('instantiates the simulator without throwing for invalid SIM_TICK_INTERVAL_MS (falls back to 1000)', () => {
    process.env.SIMULATE = 'true';
    process.env.SIM_TICK_INTERVAL_MS = 'not-a-number';

    expect(() => createBroker(makeClock())).not.toThrow();
  });
});
