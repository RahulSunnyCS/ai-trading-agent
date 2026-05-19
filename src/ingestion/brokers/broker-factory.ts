/**
 * Broker Factory
 *
 * Selects and instantiates the correct broker adapter based on environment
 * variables. The resolution order is:
 *
 *   1. BROKER=fyers       → FyersBroker    (requires FYERS_APP_ID + FYERS_ACCESS_TOKEN)
 *   2. BROKER=angelone    → AngelOneBroker (requires AO_API_KEY + AO_CLIENT_CODE + AO_CLIENT_PIN + AO_TOTP_SECRET)
 *   3. BROKER=sim         → MarketDataSimulator
 *   4. SIMULATE=true      → MarketDataSimulator (legacy env-var, kept for backwards compat)
 *   5. (default)          → MarketDataSimulator
 *
 * Throws a descriptive Error immediately if required env vars for the selected
 * broker are missing, so misconfiguration is caught at startup rather than
 * causing a silent failure during market hours.
 *
 * All exports are named exports (no default export) per project conventions.
 */

import type { Clock, ClockWithTick } from "../../utils/clock.js";
import { MarketDataSimulator } from "../market-data-sim.js";
import { AngelOneBroker } from "./angelone.js";
import { FyersBroker } from "./fyers.js";
import type { BrokerFeed } from "./types.js";

// ---------------------------------------------------------------------------
// createBroker
// ---------------------------------------------------------------------------

/**
 * Instantiates the correct broker adapter based on the BROKER / SIMULATE env vars.
 *
 * @param clock - Clock instance to inject into whichever adapter is selected.
 *                The Fyers and AngelOne adapters use it for tick timestamps.
 *                The simulator uses it for deterministic tick scheduling.
 * @returns A BrokerFeed instance ready to call connect() on.
 * @throws Error if the selected broker's required env vars are missing.
 */
export function createBroker(clock: ClockWithTick): BrokerFeed {
  const brokerName = (process.env.BROKER ?? "").toLowerCase().trim();
  const simulate = process.env.SIMULATE?.toLowerCase().trim();

  if (brokerName === "fyers") {
    return _createFyersBroker(clock);
  }

  if (brokerName === "angelone") {
    return _createAngelOneBroker(clock);
  }

  if (brokerName === "sim" || simulate === "true") {
    // Simulator: no broker credentials needed.
    return _createSimulator(clock);
  }

  // Default: simulator. Safe choice — prevents accidental live broker
  // connection when BROKER is unset (e.g. in a fresh dev environment).
  console.log(
    "[BrokerFactory] No BROKER env var set — defaulting to MarketDataSimulator. " +
      "Set BROKER=fyers or BROKER=angelone for live market data.",
  );
  return _createSimulator(clock);
}

// ---------------------------------------------------------------------------
// Internal factory helpers
// ---------------------------------------------------------------------------

/**
 * Creates a FyersBroker after validating required env vars.
 *
 * Required env vars:
 *   FYERS_APP_ID       — format XXXXXXXXXXXX-100
 *   FYERS_ACCESS_TOKEN — daily-expiring JWT from Fyers API v2 auth flow
 *
 * Both are validated as non-empty strings. Format validation of FYERS_APP_ID
 * (the `-100` suffix) is left to the Fyers SDK — we throw on missing, not
 * on format, to keep the factory's responsibility bounded.
 */
function _createFyersBroker(clock: Clock): FyersBroker {
  const appId = process.env.FYERS_APP_ID;
  const accessToken = process.env.FYERS_ACCESS_TOKEN;

  const missing: string[] = [];
  if (!appId || appId.trim() === "") missing.push("FYERS_APP_ID");
  if (!accessToken || accessToken.trim() === "") missing.push("FYERS_ACCESS_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `[BrokerFactory] BROKER=fyers requires the following env vars: ${missing.join(", ")}. Set them in .env or your shell before starting the app.`,
    );
  }

  console.log("[BrokerFactory] Instantiating FyersBroker");

  // Type-cast via `as string` after the non-empty guard above. Biome disallows
  // the non-null assertion operator (!) so we use an explicit cast instead.
  // The guard above guarantees neither value is undefined or empty at this point.
  return new FyersBroker({
    appId: appId as string,
    accessToken: accessToken as string,
    clock,
  });
}

/**
 * Creates an AngelOneBroker after validating required env vars.
 *
 * Required env vars:
 *   AO_API_KEY       — Angel One SmartAPI key
 *   AO_CLIENT_CODE   — Angel One client code (login ID)
 *   AO_CLIENT_PIN    — Numeric PIN / password
 *   AO_TOTP_SECRET   — Base32-encoded TOTP secret (for Google Authenticator)
 *
 * AO_TOTP_SECRET is never logged — we treat it as a high-sensitivity credential
 * equivalent to a private key. The missing-var message lists the var name only,
 * not its value.
 */
function _createAngelOneBroker(clock: Clock): AngelOneBroker {
  const apiKey = process.env.AO_API_KEY;
  const clientCode = process.env.AO_CLIENT_CODE;
  const clientPin = process.env.AO_CLIENT_PIN;
  const totpSecret = process.env.AO_TOTP_SECRET;

  const missing: string[] = [];
  if (!apiKey || apiKey.trim() === "") missing.push("AO_API_KEY");
  if (!clientCode || clientCode.trim() === "") missing.push("AO_CLIENT_CODE");
  if (!clientPin || clientPin.trim() === "") missing.push("AO_CLIENT_PIN");
  if (!totpSecret || totpSecret.trim() === "") missing.push("AO_TOTP_SECRET");

  if (missing.length > 0) {
    throw new Error(
      `[BrokerFactory] BROKER=angelone requires the following env vars: ${missing.join(", ")}. Set them in .env or your shell before starting the app.`,
    );
  }

  console.log("[BrokerFactory] Instantiating AngelOneBroker");

  // Type-cast via `as string` after the non-empty guard above. Biome disallows
  // the non-null assertion operator (!) so we use an explicit cast instead.
  return new AngelOneBroker({
    apiKey: apiKey as string,
    clientCode: clientCode as string,
    clientPin: clientPin as string,
    totpSecret: totpSecret as string,
    clock,
  });
}

/**
 * Creates a MarketDataSimulator.
 *
 * The simulator requires no credentials. Tick interval is read from
 * SIM_TICK_INTERVAL_MS env var (default 1000 ms) so operators can speed up
 * or slow down synthetic data generation without code changes.
 */
function _createSimulator(clock: ClockWithTick): MarketDataSimulator {
  const envInterval = Number.parseInt(process.env.SIM_TICK_INTERVAL_MS ?? "", 10);
  const tickIntervalMs = Number.isFinite(envInterval) && envInterval > 0 ? envInterval : 1_000;

  console.log(
    `[BrokerFactory] Instantiating MarketDataSimulator (tick interval: ${tickIntervalMs} ms)`,
  );

  // SimulatorConfig uses `intervalMs` (not `tickIntervalMs` — that was the old name).
  return new MarketDataSimulator({ clock, intervalMs: tickIntervalMs });
}
